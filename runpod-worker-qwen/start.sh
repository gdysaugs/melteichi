#!/usr/bin/env bash
set -euo pipefail

echo "worker-comfyui: Starting ComfyUI"
python -u /comfyui/main.py --disable-auto-launch --disable-metadata --log-stdout &

echo "worker-comfyui: Starting RunPod handler"
python -u /handler.py
