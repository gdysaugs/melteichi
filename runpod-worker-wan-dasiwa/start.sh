#!/usr/bin/env bash
set -euo pipefail

COMFYUI_HOST=${COMFYUI_HOST:-0.0.0.0}
COMFYUI_PORT=${COMFYUI_PORT:-8188}
COMFYUI_EXTRA_ARGS=${COMFYUI_EXTRA_ARGS:---highvram --disable-smart-memory}

# Repair stale comfy_aimdo patch remnants that may break ComfyUI startup.
if [ -f /comfyui/main.py ]; then
  python - <<'PY'
from pathlib import Path
import re

p = Path("/comfyui/main.py")
s = p.read_text(encoding="utf-8", errors="ignore")
orig = s

s = s.lstrip("\ufeff")
s = re.sub(r'(?m)^\s*import\s+comfy_aimdo\.control\s*$\n?', '', s)
s = re.sub(r'(?m)^\s*comfy_aimdo\.control\.init\(\)\s*$\n?', '', s)
s = re.sub(r'(?m)^\s*if enables_dynamic_vram\(\):\s*$\n?', '', s)
# Ensure "__main__" block always has at least one statement.
s = re.sub(
    r'(?m)^(\s*if __name__ == [\'"]__main__[\'"]:\s*)\n(?!\s+pass\b)',
    r'\1\n    pass\n',
    s,
    count=1,
)

if s != orig:
    p.write_text(s, encoding="utf-8")
    print("worker-comfyui: Repaired /comfyui/main.py stale comfy_aimdo patch")
PY
fi

echo "worker-comfyui: Starting ComfyUI"
python -u /comfyui/main.py --listen "${COMFYUI_HOST}" --port "${COMFYUI_PORT}" --disable-auto-launch --disable-metadata --log-stdout ${COMFYUI_EXTRA_ARGS} &

echo "worker-comfyui: Starting RunPod handler"
python -u /handler.py
