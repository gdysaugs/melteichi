import base64
import json
import os
import time
import uuid
import urllib.parse

import requests
import runpod
import websocket

COMFY_HOST = os.environ.get("COMFY_HOST", "127.0.0.1:8188")
COMFY_HTTP = f"http://{COMFY_HOST}"

CHECK_RETRIES = int(os.environ.get("COMFY_API_AVAILABLE_MAX_RETRIES", "500"))
CHECK_INTERVAL_MS = int(os.environ.get("COMFY_API_AVAILABLE_INTERVAL_MS", "50"))
WS_CONNECT_TIMEOUT = float(os.environ.get("COMFY_WS_CONNECT_TIMEOUT", "30"))
WS_RECV_TIMEOUT = float(os.environ.get("COMFY_WS_RECV_TIMEOUT", "60"))


def validate_input(job_input):
  if job_input is None:
    return None, "Please provide input"

  if isinstance(job_input, str):
    try:
      job_input = json.loads(job_input)
    except json.JSONDecodeError:
      return None, "Invalid JSON format in input"

  workflow = job_input.get("workflow")
  if workflow is None:
    return None, "Missing 'workflow' parameter"

  images = job_input.get("images")
  if images is not None:
    if not isinstance(images, list) or not all(
      isinstance(image, dict) and "name" in image and "image" in image for image in images
    ):
      return None, "'images' must be a list of objects with 'name' and 'image' keys"

  return {
    "workflow": workflow,
    "images": images,
    "comfy_org_api_key": job_input.get("comfy_org_api_key"),
  }, None


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


def strip_data_uri(data):
  if "," in data:
    return data.split(",", 1)[1]
  return data


def upload_images(images):
  if not images:
    return None

  for image in images:
    name = image["name"]
    raw_data = strip_data_uri(str(image["image"]))
    try:
      blob = base64.b64decode(raw_data)
    except Exception as exc:
      return f"Failed to decode base64 for {name}: {exc}"

    files = {
      "image": (name, blob, "image/png"),
      "overwrite": (None, "true"),
    }
    try:
      response = requests.post(f"{COMFY_HTTP}/upload/image", files=files, timeout=30)
      response.raise_for_status()
    except requests.RequestException as exc:
      return f"Failed to upload {name}: {exc}"
  return None


def queue_workflow(workflow, client_id, comfy_org_api_key=None):
  payload = {"prompt": workflow, "client_id": client_id}
  key = comfy_org_api_key or os.environ.get("COMFY_ORG_API_KEY")
  if key:
    payload["extra_data"] = {"api_key_comfy_org": key}

  response = requests.post(f"{COMFY_HTTP}/prompt", json=payload, timeout=30)
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
      data = json.loads(message)
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
  response = requests.get(f"{COMFY_HTTP}/history/{prompt_id}", timeout=30)
  response.raise_for_status()
  return response.json()


def fetch_output_bytes(filename, subfolder, output_type):
  params = urllib.parse.urlencode({"filename": filename, "subfolder": subfolder, "type": output_type})
  response = requests.get(f"{COMFY_HTTP}/view?{params}", timeout=60)
  response.raise_for_status()
  return response.content


def handler(job):
  job_input = job.get("input")
  validated, error = validate_input(job_input)
  if error:
    return {"error": error}

  if not check_server():
    return {"error": f"ComfyUI server ({COMFY_HOST}) not reachable."}

  upload_error = upload_images(validated.get("images"))
  if upload_error:
    return {"error": upload_error}

  client_id = str(uuid.uuid4())
  try:
    queued = queue_workflow(
      validated["workflow"],
      client_id,
      comfy_org_api_key=validated.get("comfy_org_api_key"),
    )
    prompt_id = queued.get("prompt_id")
    if not prompt_id:
      return {"error": f"Missing prompt_id in queue response: {queued}"}

    wait_for_completion(prompt_id, client_id)
    history = fetch_history(prompt_id)
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
        image_bytes = fetch_output_bytes(
          filename,
          image_info.get("subfolder", ""),
          image_info.get("type"),
        )
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
        video_bytes = fetch_output_bytes(
          filename,
          video_info.get("subfolder", ""),
          video_info.get("type"),
        )
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
        gif_bytes = fetch_output_bytes(
          filename,
          gif_info.get("subfolder", ""),
          gif_info.get("type"),
        )
        gifs.append(
          {
            "filename": filename,
            "type": "base64",
            "data": base64.b64encode(gif_bytes).decode("utf-8"),
          }
        )

    if not images and not videos and not gifs:
      return {"status": "success_no_outputs", "images": [], "videos": [], "gifs": []}
    response = {}
    if images:
      response["images"] = images
    if videos:
      response["videos"] = videos
    if gifs:
      response["gifs"] = gifs
    return response
  except Exception as exc:
    return {"error": str(exc)}


runpod.serverless.start({"handler": handler})
