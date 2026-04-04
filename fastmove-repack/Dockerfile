FROM suarez123/wan22-i2v:v2026.03.17-190559-18899

# Keep workflow-compatible aliases stable even if the base image layout changes.
RUN set -eux; \
    mkdir -p /comfyui/models/diffusion_models; \
    for suffix in H L; do \
      src="/comfyui/models/diffusion_models/wan22EnhancedNSFWSVICamera_nsfwV2FP8${suffix}.safetensors"; \
      dst="/comfyui/models/diffusion_models/wan22EnhancedNSFWSVICamera_nsfwFASTMOVEV2FP8${suffix}.safetensors"; \
      test -f "${src}"; \
      ln -sf "${src}" "${dst}"; \
    done

COPY handler.py /handler.py
COPY warmup.py /warmup.py
COPY warmup-workflow-i2v.json /warmup-workflow-i2v.json
COPY start.sh /start.sh
RUN chmod +x /start.sh

ENV COMFY_WARMUP=1 \
    COMFY_POD_MODE=1 \
    COMFY_WARMUP_WORKFLOW=/warmup-workflow-i2v.json \
    COMFY_API_AVAILABLE_MAX_RETRIES=1200 \
    COMFY_API_AVAILABLE_INTERVAL_MS=100 \
    COMFY_WARMUP_WIDTH=512 \
    COMFY_WARMUP_HEIGHT=320 \
    COMFY_WARMUP_FRAMES=9 \
    COMFY_WARMUP_STEPS=2 \
    COMFY_WARMUP_FPS=8 \
    COMFY_WARMUP_CFG=1 \
    COMFY_WARMUP_TIMEOUT_SEC=900 \
    COMFYUI_ARGS="--listen 0.0.0.0 --port 8188 --disable-auto-launch --disable-metadata --log-stdout --highvram --disable-smart-memory --reserve-vram 3 --preview-method none"

CMD ["/start.sh"]

