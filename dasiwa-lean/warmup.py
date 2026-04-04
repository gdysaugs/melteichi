import base64
import json
import os
import time
import urllib.parse
import uuid

import requests
import websocket

COMFY_HOST = os.environ.get("COMFY_HOST", "127.0.0.1:8188")
COMFY_HTTP = f"http://{COMFY_HOST}"

CHECK_RETRIES = int(os.environ.get("COMFY_API_AVAILABLE_MAX_RETRIES", "1200"))
CHECK_INTERVAL_MS = int(os.environ.get("COMFY_API_AVAILABLE_INTERVAL_MS", "100"))
WS_CONNECT_TIMEOUT = float(os.environ.get("COMFY_WS_CONNECT_TIMEOUT", "30"))
WS_RECV_TIMEOUT = float(os.environ.get("COMFY_WS_RECV_TIMEOUT", "60"))
WARMUP_TIMEOUT_SEC = int(os.environ.get("COMFY_WARMUP_TIMEOUT_SEC", "900"))

WARMUP_WORKFLOW_PATH = os.environ.get("COMFY_WARMUP_WORKFLOW", "/warmup-workflow-i2v.json")
WARMUP_WIDTH = int(os.environ.get("COMFY_WARMUP_WIDTH", "512"))
WARMUP_HEIGHT = int(os.environ.get("COMFY_WARMUP_HEIGHT", "320"))
WARMUP_FRAMES = int(os.environ.get("COMFY_WARMUP_FRAMES", "9"))
WARMUP_STEPS = max(1, int(os.environ.get("COMFY_WARMUP_STEPS", "2")))
WARMUP_FPS = int(os.environ.get("COMFY_WARMUP_FPS", "8"))
WARMUP_CFG = float(os.environ.get("COMFY_WARMUP_CFG", "1"))

WARMUP_IMAGE_NAME = "warmup.png"
# 1x1 transparent PNG
WARMUP_IMAGE_BASE64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8"
    "/w8AAn8B9p8uNQAAAABJRU5ErkJggg=="
)


def check_server() -> bool:
    for _ in range(CHECK_RETRIES):
        try:
            response = requests.get(f"{COMFY_HTTP}/", timeout=5)
            if response.status_code == 200:
                return True
        except requests.RequestException:
            pass
        time.sleep(CHECK_INTERVAL_MS / 1000)
    return False


def upload_warmup_image() -> None:
    blob = base64.b64decode(WARMUP_IMAGE_BASE64)
    files = {
        "image": (WARMUP_IMAGE_NAME, blob, "image/png"),
        "overwrite": (None, "true"),
    }
    response = requests.post(f"{COMFY_HTTP}/upload/image", files=files, timeout=30)
    response.raise_for_status()


def load_workflow() -> dict:
    with open(WARMUP_WORKFLOW_PATH, "r", encoding="utf-8-sig") as f:
        return json.load(f)


def patch_workflow(workflow: dict) -> dict:
    # Same graph as production i2v, but shortened for fast warmup.
    workflow["106"]["inputs"]["image"] = WARMUP_IMAGE_NAME

    workflow["6"]["inputs"]["text"] = "warmup"
    workflow["7"]["inputs"]["text"] = ""

    workflow["107"]["inputs"]["width"] = WARMUP_WIDTH
    workflow["107"]["inputs"]["height"] = WARMUP_HEIGHT
    workflow["107"]["inputs"]["length"] = WARMUP_FRAMES

    split_step = max(1, WARMUP_STEPS // 2)

    workflow["57"]["inputs"]["steps"] = WARMUP_STEPS
    workflow["57"]["inputs"]["cfg"] = WARMUP_CFG
    workflow["57"]["inputs"]["noise_seed"] = 1
    workflow["57"]["inputs"]["start_at_step"] = 0
    workflow["57"]["inputs"]["end_at_step"] = split_step

    workflow["58"]["inputs"]["steps"] = WARMUP_STEPS
    workflow["58"]["inputs"]["cfg"] = WARMUP_CFG
    workflow["58"]["inputs"]["noise_seed"] = 1
    workflow["58"]["inputs"]["start_at_step"] = split_step
    workflow["58"]["inputs"]["end_at_step"] = 10000

    workflow["99"]["inputs"]["frame_rate"] = WARMUP_FPS
    workflow["99"]["inputs"]["filename_prefix"] = "video/warmup"
    workflow["99"]["inputs"]["format"] = "video/nvenc_h264-mp4"
    workflow["99"]["inputs"]["save_output"] = False

    return workflow


def queue_workflow(workflow: dict, client_id: str) -> str:
    payload = {"prompt": workflow, "client_id": client_id}
    response = requests.post(f"{COMFY_HTTP}/prompt", json=payload, timeout=60)
    if response.status_code == 400:
        raise RuntimeError(f"Warmup workflow validation failed: {response.text}")
    response.raise_for_status()
    data = response.json()
    prompt_id = data.get("prompt_id")
    if not prompt_id:
        raise RuntimeError(f"Warmup queue response missing prompt_id: {data}")
    return prompt_id


def wait_for_completion(prompt_id: str, client_id: str) -> None:
    ws_url = f"ws://{COMFY_HOST}/ws?clientId={client_id}"
    ws = websocket.WebSocket()
    ws.connect(ws_url, timeout=WS_CONNECT_TIMEOUT)
    ws.settimeout(WS_RECV_TIMEOUT)
    deadline = time.time() + WARMUP_TIMEOUT_SEC
    try:
        while True:
            if time.time() > deadline:
                raise TimeoutError("Warmup timeout exceeded")

            try:
                message = ws.recv()
            except websocket.WebSocketTimeoutException:
                continue

            if not isinstance(message, str):
                continue

            data = json.loads(message)
            event_type = data.get("type")
            payload = data.get("data", {})

            if event_type == "executing":
                if payload.get("node") is None and payload.get("prompt_id") == prompt_id:
                    return
            if event_type == "execution_error" and payload.get("prompt_id") == prompt_id:
                raise RuntimeError(payload.get("exception_message") or "ComfyUI warmup execution error")
    finally:
        ws.close()


def main() -> int:
    start = time.time()
    print("warmup: waiting for ComfyUI")
    if not check_server():
        print("warmup: ComfyUI is not reachable")
        return 1

    print("warmup: uploading image")
    upload_warmup_image()

    print("warmup: queueing workflow")
    workflow = patch_workflow(load_workflow())
    client_id = str(uuid.uuid4())
    prompt_id = queue_workflow(workflow, client_id)

    print(f"warmup: waiting completion prompt_id={prompt_id}")
    wait_for_completion(prompt_id, client_id)

    elapsed = time.time() - start
    print(f"warmup: completed in {elapsed:.1f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())