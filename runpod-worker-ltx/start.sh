#!/usr/bin/env bash
set -euo pipefail

COMFYUI_HOST=${COMFYUI_HOST:-0.0.0.0}
COMFYUI_PORT=${COMFYUI_PORT:-8188}

echo "worker-comfyui: Build ${WORKER_BUILD:-unknown}"

echo "worker-comfyui: Starting ComfyUI"
python -u /comfyui/main.py --listen "${COMFYUI_HOST}" --port "${COMFYUI_PORT}" --disable-auto-launch --disable-metadata --log-stdout &

echo "worker-comfyui: Starting RunPod handler"
python -u /handler.py
