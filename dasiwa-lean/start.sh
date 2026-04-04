#!/usr/bin/env bash
set -euo pipefail

COMFYUI_HOST=${COMFYUI_HOST:-0.0.0.0}
COMFYUI_PORT=${COMFYUI_PORT:-8188}
DEFAULT_ARGS=(--listen "${COMFYUI_HOST}" --port "${COMFYUI_PORT}" --disable-auto-launch --disable-metadata --log-stdout --highvram --disable-smart-memory --reserve-vram 3 --preview-method none)
if [ -n "${COMFYUI_ARGS:-}" ]; then
  # shellcheck disable=SC2206
  COMFY_ARGS=(${COMFYUI_ARGS})
else
  COMFY_ARGS=("${DEFAULT_ARGS[@]}")
fi

echo "worker-comfyui: Starting ComfyUI"
python -u /comfyui/main.py "${COMFY_ARGS[@]}" &
COMFY_PID=$!

cleanup() {
  if kill -0 "${COMFY_PID}" >/dev/null 2>&1; then
    kill "${COMFY_PID}" >/dev/null 2>&1 || true
    wait "${COMFY_PID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

if [ "${COMFY_WARMUP:-1}" = "1" ]; then
  echo "worker-comfyui: Running warmup"
  if ! python -u /warmup.py; then
    echo "worker-comfyui: Warmup failed, continuing."
  fi
fi

if [ "${COMFY_POD_MODE:-1}" = "1" ]; then
  echo "worker-comfyui: Pod mode enabled (handler disabled)."
  wait "${COMFY_PID}"
else
  echo "worker-comfyui: Starting RunPod handler"
  python -u /handler.py
fi

