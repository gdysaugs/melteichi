import base64
import copy
import json
import os
import random
import re
import time
import urllib.parse
import uuid
from pathlib import Path
from typing import Any

import requests
import runpod
import websocket

COMFY_HOST = os.environ.get("COMFY_HOST", "127.0.0.1:8188")
COMFY_HTTP = f"http://{COMFY_HOST}"
COMFY_INPUT_DIR = Path(os.environ.get("COMFY_INPUT_DIR", "/comfyui/input"))
WORKFLOW_TEMPLATE_PATH = Path(os.environ.get("LTX_WORKFLOW_PATH", "/workflow/ltx-2.3-combi-3.0.json"))

CHECK_RETRIES = int(os.environ.get("COMFY_API_AVAILABLE_MAX_RETRIES", "500"))
CHECK_INTERVAL_MS = int(os.environ.get("COMFY_API_AVAILABLE_INTERVAL_MS", "50"))
WS_CONNECT_TIMEOUT = float(os.environ.get("COMFY_WS_CONNECT_TIMEOUT", "30"))
WS_RECV_TIMEOUT = float(os.environ.get("COMFY_WS_RECV_TIMEOUT", "60"))

MAX_PROMPT_LENGTH = 2000
MAX_NEGATIVE_PROMPT_LENGTH = 2000

# IDs in ltx-2.3 combi 3.0 workflow.
NODE_ID_PROMPT = 121
NODE_ID_NEGATIVE = 593
NODE_ID_SEED = 115
NODE_ID_SECONDS = 196
NODE_ID_FPS = 869
NODE_ID_LONGER_EDGE_T2V = 864
NODE_ID_LONGER_EDGE_I2V = 199
NODE_ID_LONGER_EDGE_V2V = 971
NODE_ID_PORTRAIT = 1577
NODE_ID_MUTER = 1353
NODE_ID_IMAGE = 149
NODE_ID_LAST_FRAME = 786
NODE_ID_VIDEO = 787
NODE_ID_AUDIO = 412
NODE_ID_VIDEO_OUTPUT = 188
NODE_ID_LORA_LOADER = 211

PRIMARY_LORA_FILENAME = "ltx-2.3-22b-distilled-lora-dynamic_fro09_avg_rank_105_bf16.safetensors"

MUTER_BOOL_INDEXES = [0, 2, 4, 5, 6, 7, 8]
MUTER_PRESETS = {
  "t2v": [True, False, False, False, False, False, False],
  "t2v_audio": [False, True, False, False, False, False, False],
  "i2v": [False, False, True, False, False, False, False],
  "i2v_audio": [False, False, False, True, False, False, False],
  "v2v": [False, False, False, False, False, False, True],
}

_WORKFLOW_TEMPLATE: dict[str, Any] | None = None
_OBJECT_INFO: dict[str, Any] | None = None


def json_loads_safe(value: str):
  return json.loads(value)


def deep_clone(value):
  return copy.deepcopy(value)


def validate_input(job_input):
  if job_input is None:
    return None, "Please provide input."

  if isinstance(job_input, str):
    try:
      job_input = json_loads_safe(job_input)
    except json.JSONDecodeError:
      return None, "Invalid JSON format in input."

  if not isinstance(job_input, dict):
    return None, "Input must be a JSON object."

  mode = str(job_input.get("mode", "t2v")).strip().lower()
  if mode not in {"t2v", "i2v", "v2v"}:
    return None, 'mode must be "t2v", "i2v", or "v2v".'

  prompt = str(job_input.get("prompt", job_input.get("text", ""))).strip()
  if not prompt:
    return None, "prompt is required."
  if len(prompt) > MAX_PROMPT_LENGTH:
    return None, "prompt is too long."

  negative_prompt = str(job_input.get("negative_prompt", job_input.get("negative", "")))
  if len(negative_prompt) > MAX_NEGATIVE_PROMPT_LENGTH:
    return None, "negative_prompt is too long."

  use_audio_input = bool(job_input.get("use_audio_input", job_input.get("load_audio", False)))
  image_b64 = as_nonempty_string(job_input.get("image_base64", job_input.get("image", "")))
  video_b64 = as_nonempty_string(job_input.get("video_base64", job_input.get("video", "")))
  audio_b64 = as_nonempty_string(job_input.get("audio_base64", job_input.get("audio", "")))

  if mode == "i2v" and not image_b64:
    return None, "i2v requires image_base64."
  if mode == "v2v" and not video_b64:
    return None, "v2v requires video_base64."
  if use_audio_input and not audio_b64:
    return None, "use_audio_input=true requires audio_base64."

  width = clamp_int(job_input.get("width"), 768, 256, 1536)
  height = clamp_int(job_input.get("height"), 432, 256, 1536)
  fps = clamp_int(job_input.get("fps"), 24, 1, 60)
  seconds = clamp_int(job_input.get("seconds"), 5, 3, 30)
  seed = int(job_input.get("seed", 0) or 0)
  randomize_seed = bool(job_input.get("randomize_seed", True))

  return {
    "mode": mode,
    "prompt": prompt,
    "negative_prompt": negative_prompt,
    "use_audio_input": use_audio_input,
    "width": width,
    "height": height,
    "fps": fps,
    "seconds": seconds,
    "seed": seed,
    "randomize_seed": randomize_seed,
    "image_base64": image_b64,
    "video_base64": video_b64,
    "audio_base64": audio_b64,
    "image_name": as_nonempty_string(job_input.get("image_name")) or "input.png",
    "video_name": as_nonempty_string(job_input.get("video_name")) or "input.mp4",
    "audio_name": as_nonempty_string(job_input.get("audio_name")) or "input.wav",
    "comfy_org_api_key": job_input.get("comfy_org_api_key"),
  }, None


def as_nonempty_string(value: Any) -> str:
  if isinstance(value, str):
    value = value.strip()
    return value if value else ""
  return ""


def clamp_int(value: Any, default: int, minimum: int, maximum: int) -> int:
  try:
    parsed = int(float(value))
  except Exception:
    parsed = default
  return max(minimum, min(maximum, parsed))


def strip_data_uri(data: str) -> str:
  if data.startswith("data:") and "," in data:
    return data.split(",", 1)[1]
  return data


def sanitize_filename(name: str, fallback: str) -> str:
  candidate = (name or "").strip() or fallback
  candidate = candidate.replace("\\", "/").split("/")[-1]
  candidate = re.sub(r"[^A-Za-z0-9._-]+", "_", candidate).strip("._")
  if not candidate:
    candidate = fallback
  return candidate


def decode_base64(value: str, label: str) -> bytes:
  raw = strip_data_uri(value)
  try:
    return base64.b64decode(raw, validate=False)
  except Exception as exc:
    raise ValueError(f"Failed to decode {label}: {exc}") from exc


def write_input_file(filename: str, payload: bytes) -> str:
  COMFY_INPUT_DIR.mkdir(parents=True, exist_ok=True)
  safe_name = sanitize_filename(filename, f"input-{uuid.uuid4().hex}")
  target = COMFY_INPUT_DIR / safe_name
  target.write_bytes(payload)
  return safe_name


def prepare_media_files(validated):
  result = {"image": None, "video": None, "audio": None}

  if validated["image_base64"]:
    blob = decode_base64(validated["image_base64"], "image_base64")
    result["image"] = write_input_file(validated["image_name"], blob)

  if validated["video_base64"]:
    blob = decode_base64(validated["video_base64"], "video_base64")
    result["video"] = write_input_file(validated["video_name"], blob)

  if validated["audio_base64"]:
    blob = decode_base64(validated["audio_base64"], "audio_base64")
    result["audio"] = write_input_file(validated["audio_name"], blob)

  return result


def get_workflow_template():
  global _WORKFLOW_TEMPLATE
  if _WORKFLOW_TEMPLATE is None:
    if not WORKFLOW_TEMPLATE_PATH.exists():
      raise FileNotFoundError(f"Workflow file not found: {WORKFLOW_TEMPLATE_PATH}")
    _WORKFLOW_TEMPLATE = json_loads_safe(WORKFLOW_TEMPLATE_PATH.read_text(encoding="utf-8"))
  return deep_clone(_WORKFLOW_TEMPLATE)


def get_object_info():
  global _OBJECT_INFO
  if _OBJECT_INFO is None:
    response = requests.get(f"{COMFY_HTTP}/object_info", timeout=30)
    response.raise_for_status()
    _OBJECT_INFO = response.json()
  return _OBJECT_INFO


def patch_widget_list(node: dict[str, Any], index: int, value: Any):
  values = node.get("widgets_values")
  if isinstance(values, list) and len(values) > index:
    values[index] = value


def patch_slider(node: dict[str, Any], value: int):
  values = node.get("widgets_values")
  if isinstance(values, list) and values:
    values[0] = value
    if len(values) > 1 and isinstance(values[1], (int, float)):
      values[1] = value


def patch_mode_muter(node: dict[str, Any], mode: str, use_audio_input: bool):
  values = node.get("widgets_values")
  if not isinstance(values, list):
    return

  for idx in MUTER_BOOL_INDEXES:
    if idx < len(values):
      values[idx] = False

  if mode == "t2v":
    preset = MUTER_PRESETS["t2v_audio" if use_audio_input else "t2v"]
  elif mode == "i2v":
    preset = MUTER_PRESETS["i2v_audio" if use_audio_input else "i2v"]
  else:
    preset = MUTER_PRESETS["v2v"]

  for idx, flag in zip(MUTER_BOOL_INDEXES, preset):
    if idx < len(values):
      values[idx] = flag


def apply_generation_inputs(workflow_ui: dict[str, Any], validated, media_files):
  nodes = {int(node["id"]): node for node in workflow_ui.get("nodes", []) if "id" in node}

  if NODE_ID_PROMPT in nodes:
    patch_widget_list(nodes[NODE_ID_PROMPT], 0, validated["prompt"])
  if NODE_ID_NEGATIVE in nodes:
    patch_widget_list(nodes[NODE_ID_NEGATIVE], 0, validated["negative_prompt"])
  if NODE_ID_SEED in nodes:
    seed = random.randint(1, 2**63 - 1) if validated["randomize_seed"] else validated["seed"]
    patch_widget_list(nodes[NODE_ID_SEED], 0, seed)
  if NODE_ID_SECONDS in nodes:
    patch_slider(nodes[NODE_ID_SECONDS], validated["seconds"])
  if NODE_ID_FPS in nodes:
    patch_widget_list(nodes[NODE_ID_FPS], 0, validated["fps"])
  if NODE_ID_LONGER_EDGE_T2V in nodes:
    patch_slider(nodes[NODE_ID_LONGER_EDGE_T2V], max(validated["width"], validated["height"]))
  if NODE_ID_LONGER_EDGE_I2V in nodes:
    patch_slider(nodes[NODE_ID_LONGER_EDGE_I2V], max(validated["width"], validated["height"]))
  if NODE_ID_LONGER_EDGE_V2V in nodes:
    patch_slider(nodes[NODE_ID_LONGER_EDGE_V2V], max(validated["width"], validated["height"]))
  if NODE_ID_PORTRAIT in nodes:
    patch_widget_list(nodes[NODE_ID_PORTRAIT], 0, validated["height"] > validated["width"])
  if NODE_ID_MUTER in nodes:
    patch_mode_muter(nodes[NODE_ID_MUTER], validated["mode"], validated["use_audio_input"])

  if NODE_ID_LORA_LOADER in nodes:
    values = nodes[NODE_ID_LORA_LOADER].get("widgets_values")
    if isinstance(values, list) and len(values) > 2 and isinstance(values[2], dict):
      values[2]["lora"] = PRIMARY_LORA_FILENAME

  if media_files.get("image") and NODE_ID_IMAGE in nodes:
    patch_widget_list(nodes[NODE_ID_IMAGE], 0, media_files["image"])
  if media_files.get("image") and NODE_ID_LAST_FRAME in nodes:
    patch_widget_list(nodes[NODE_ID_LAST_FRAME], 0, media_files["image"])

  if media_files.get("video") and NODE_ID_VIDEO in nodes:
    values = nodes[NODE_ID_VIDEO].get("widgets_values")
    if isinstance(values, dict):
      values["video"] = media_files["video"]
    elif isinstance(values, list) and values:
      values[0] = media_files["video"]

  if media_files.get("audio") and NODE_ID_AUDIO in nodes:
    patch_widget_list(nodes[NODE_ID_AUDIO], 0, media_files["audio"])

  if NODE_ID_VIDEO_OUTPUT in nodes:
    values = nodes[NODE_ID_VIDEO_OUTPUT].get("widgets_values")
    if isinstance(values, dict):
      values["frame_rate"] = validated["fps"]

  return workflow_ui


def build_link_lookup(workflow_ui):
  lookup = {}
  for link in workflow_ui.get("links", []):
    if not isinstance(link, list) or len(link) < 5:
      continue
    link_id = int(link[0])
    lookup[link_id] = {
      "src_node": str(link[1]),
      "src_slot": int(link[2]),
      "dst_node": str(link[3]),
      "dst_slot": int(link[4]),
    }
  return lookup


def resolve_set_get_links(workflow_ui, link_lookup):
  nodes = workflow_ui.get("nodes", [])
  set_source_by_name = {}

  for node in nodes:
    if node.get("type") != "SetNode":
      continue
    values = node.get("widgets_values")
    if not isinstance(values, list) or not values:
      continue
    key = str(values[0]).strip()
    if not key:
      continue
    input_links = node.get("inputs") or []
    source_link_id = None
    for input_desc in input_links:
      if isinstance(input_desc, dict) and input_desc.get("link") is not None:
        source_link_id = int(input_desc.get("link"))
        break
    if source_link_id is None or source_link_id not in link_lookup:
      continue
    src = link_lookup[source_link_id]
    set_source_by_name[key] = (src["src_node"], src["src_slot"])

  if not set_source_by_name:
    return

  for node in nodes:
    if node.get("type") != "GetNode":
      continue
    values = node.get("widgets_values")
    if not isinstance(values, list) or not values:
      continue
    key = str(values[0]).strip()
    source = set_source_by_name.get(key)
    if source is None:
      continue

    outputs = node.get("outputs") or []
    for output_desc in outputs:
      links = output_desc.get("links") if isinstance(output_desc, dict) else None
      if not isinstance(links, list):
        continue
      for out_link_id in links:
        try:
          lid = int(out_link_id)
        except Exception:
          continue
        if lid not in link_lookup:
          continue
        link_lookup[lid]["src_node"] = source[0]
        link_lookup[lid]["src_slot"] = source[1]


def get_input_order(node_info):
  names = []
  input_info = node_info.get("input", {})
  for group in ("required", "optional"):
    fields = input_info.get(group, {})
    if isinstance(fields, dict):
      names.extend(list(fields.keys()))
  return names


def convert_ui_workflow_to_prompt(workflow_ui, object_info):
  link_lookup = build_link_lookup(workflow_ui)
  resolve_set_get_links(workflow_ui, link_lookup)
  prompt = {}
  unknown_types = set()

  for node in workflow_ui.get("nodes", []):
    class_type = node.get("type")
    node_id = str(node.get("id"))
    if not class_type:
      continue

    # UI-only annotation nodes must never be sent to /prompt.
    if class_type in {"Note", "MarkdownNote", "SetNode", "GetNode"}:
      continue

    has_linked_inputs = any(
      isinstance(input_desc, dict) and input_desc.get("link") is not None
      for input_desc in (node.get("inputs") or [])
    )
    has_linked_outputs = any(
      isinstance(output_desc, dict) and output_desc.get("links")
      for output_desc in (node.get("outputs") or [])
    )

    node_info = object_info.get(class_type)
    if node_info is None:
      # Keep unknown nodes only when they are part of the executable graph.
      if not has_linked_inputs and not has_linked_outputs:
        continue
      unknown_types.add(class_type)
      expected_inputs = []
    else:
      expected_inputs = get_input_order(node_info)
    ui_inputs = node.get("inputs") or []
    widget_values = node.get("widgets_values")

    inputs = {}

    for input_desc in ui_inputs:
      if not isinstance(input_desc, dict):
        continue
      input_name = input_desc.get("name")
      link_id = input_desc.get("link")
      if not input_name or link_id is None:
        continue
      if int(link_id) not in link_lookup:
        continue
      src = link_lookup[int(link_id)]
      inputs[input_name] = [src["src_node"], src["src_slot"]]

    if isinstance(widget_values, dict):
      if node_info is None:
        for key, value in widget_values.items():
          if key not in inputs:
            inputs[key] = deep_clone(value)
      for name in expected_inputs:
        if name in inputs:
          continue
        if name in widget_values:
          inputs[name] = deep_clone(widget_values[name])

    if isinstance(widget_values, list) and node_info is not None:
      index = 0
      for name in expected_inputs:
        if name in inputs:
          continue
        if index >= len(widget_values):
          break
        inputs[name] = deep_clone(widget_values[index])
        index += 1

    for input_desc in ui_inputs:
      if not isinstance(input_desc, dict):
        continue
      input_name = input_desc.get("name")
      if not input_name or input_name in inputs:
        continue
      widget_info = input_desc.get("widget")
      widget_name = widget_info.get("name") if isinstance(widget_info, dict) else None
      if not widget_name:
        continue
      if isinstance(widget_values, dict) and widget_name in widget_values:
        inputs[input_name] = deep_clone(widget_values[widget_name])

    if not isinstance(inputs, dict):
      inputs = {}

    prompt[node_id] = {"class_type": class_type, "inputs": inputs}
    title = node.get("title")
    if isinstance(title, str) and title:
      prompt[node_id]["_meta"] = {"title": title}

  missing_sources = []
  for node_id, node_data in prompt.items():
    node_inputs = node_data.get("inputs", {})
    if not isinstance(node_inputs, dict):
      continue
    for key, value in list(node_inputs.items()):
      if isinstance(value, list) and len(value) == 2:
        src_node = str(value[0])
        if src_node not in prompt:
          missing_sources.append((node_id, key, src_node))
          node_inputs.pop(key, None)

  if missing_sources:
    details = ", ".join([f"{node}:{name}->{src}" for node, name, src in missing_sources[:10]])
    raise RuntimeError(f"Workflow conversion missing source nodes: {details}")

  if unknown_types:
    print("worker-comfyui: Unknown node types kept in prompt:", ", ".join(sorted(unknown_types)))

  return prompt


def check_server():
  for _ in range(CHECK_RETRIES):
    try:
      response = requests.get(f"{COMFY_HTTP}/", timeout=5)
      if response.status_code == 200:
        return True
    except requests.RequestException:
      pass
    time.sleep(CHECK_INTERVAL_MS / 1000)
  return False


def queue_workflow(workflow, client_id, comfy_org_api_key=None):
  payload = {"prompt": workflow, "client_id": client_id}
  key = comfy_org_api_key or os.environ.get("COMFY_ORG_API_KEY")
  if key:
    payload["extra_data"] = {"api_key_comfy_org": key}

  response = requests.post(f"{COMFY_HTTP}/prompt", json=payload, timeout=60)
  if response.status_code == 400:
    raise ValueError(f"Workflow validation failed: {response.text}")
  response.raise_for_status()
  return response.json()


def wait_for_completion(prompt_id, client_id):
  ws_url = f"ws://{COMFY_HOST}/ws?clientId={client_id}"
  ws = websocket.WebSocket()
  ws.connect(ws_url, timeout=WS_CONNECT_TIMEOUT)
  ws.settimeout(WS_RECV_TIMEOUT)
  try:
    while True:
      try:
        message = ws.recv()
      except websocket.WebSocketTimeoutException:
        continue

      if not isinstance(message, str):
        continue

      data = json_loads_safe(message)
      event_type = data.get("type")

      if event_type == "executing":
        payload = data.get("data", {})
        if payload.get("node") is None and payload.get("prompt_id") == prompt_id:
          return

      if event_type == "execution_error":
        payload = data.get("data", {})
        if payload.get("prompt_id") == prompt_id:
          raise RuntimeError(payload.get("exception_message") or "ComfyUI execution error")
  finally:
    ws.close()


def fetch_history(prompt_id):
  response = requests.get(f"{COMFY_HTTP}/history/{prompt_id}", timeout=60)
  response.raise_for_status()
  return response.json()


def fetch_output_bytes(filename, subfolder, output_type):
  params = urllib.parse.urlencode({"filename": filename, "subfolder": subfolder, "type": output_type})
  response = requests.get(f"{COMFY_HTTP}/view?{params}", timeout=120)
  response.raise_for_status()
  return response.content


def collect_outputs(history, prompt_id):
  prompt_history = history.get(prompt_id, {})
  outputs = prompt_history.get("outputs", {})

  images = []
  videos = []
  gifs = []

  for node_output in outputs.values():
    for image_info in node_output.get("images", []):
      if image_info.get("type") == "temp":
        continue
      filename = image_info.get("filename")
      if not filename:
        continue
      image_bytes = fetch_output_bytes(filename, image_info.get("subfolder", ""), image_info.get("type"))
      images.append(
        {
          "filename": filename,
          "type": "base64",
          "data": base64.b64encode(image_bytes).decode("utf-8"),
        }
      )

    for video_info in node_output.get("videos", []):
      filename = video_info.get("filename")
      if not filename:
        continue
      video_bytes = fetch_output_bytes(filename, video_info.get("subfolder", ""), video_info.get("type"))
      videos.append(
        {
          "filename": filename,
          "type": "base64",
          "data": base64.b64encode(video_bytes).decode("utf-8"),
        }
      )

    for gif_info in node_output.get("gifs", []):
      filename = gif_info.get("filename")
      if not filename:
        continue
      gif_bytes = fetch_output_bytes(filename, gif_info.get("subfolder", ""), gif_info.get("type"))
      gifs.append(
        {
          "filename": filename,
          "type": "base64",
          "data": base64.b64encode(gif_bytes).decode("utf-8"),
        }
      )

  result = {}
  if images:
    result["images"] = images
  if videos:
    result["videos"] = videos
  if gifs:
    result["gifs"] = gifs
  if not result:
    result["status"] = "success_no_outputs"
    result["images"] = []
    result["videos"] = []
    result["gifs"] = []
  return result


def handler(job):
  job_input = job.get("input")
  validated, error = validate_input(job_input)
  if error:
    return {"error": error}

  if not check_server():
    return {"error": f"ComfyUI server ({COMFY_HOST}) not reachable."}

  try:
    media_files = prepare_media_files(validated)
    workflow_ui = get_workflow_template()
    workflow_ui = apply_generation_inputs(workflow_ui, validated, media_files)
    object_info = get_object_info()
    workflow_prompt = convert_ui_workflow_to_prompt(workflow_ui, object_info)
  except Exception as exc:
    return {"error": f"Workflow preparation failed: {exc}"}

  debug_prompt_path = os.environ.get("LTX_DEBUG_PROMPT_PATH")
  if debug_prompt_path:
    try:
      Path(debug_prompt_path).write_text(json.dumps(workflow_prompt, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
      pass

  client_id = str(uuid.uuid4())
  try:
    queued = queue_workflow(
      workflow_prompt,
      client_id,
      comfy_org_api_key=validated.get("comfy_org_api_key"),
    )
    prompt_id = queued.get("prompt_id")
    if not prompt_id:
      return {"error": f"Missing prompt_id in queue response: {queued}"}

    wait_for_completion(prompt_id, client_id)
    history = fetch_history(prompt_id)
    result = collect_outputs(history, prompt_id)
    return result
  except Exception as exc:
    return {"error": str(exc)}


runpod.serverless.start({"handler": handler})
