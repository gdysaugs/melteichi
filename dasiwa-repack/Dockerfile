FROM suarez123/wan22-i2v:v2026.03.17-190559-18899

# Put DaSiWa pair into diffusion_models with original filenames.
COPY models/DasiwaWAN22I2V14BLightspeed_synthseductionHighV9.safetensors /comfyui/models/diffusion_models/
COPY models/DasiwaWAN22I2V14BLightspeed_synthseductionLowV9.safetensors /comfyui/models/diffusion_models/

# Point existing workflow filenames to DaSiWa pair.
RUN set -eux; \
    mkdir -p /comfyui/models/diffusion_models; \
    ln -sf /comfyui/models/diffusion_models/DasiwaWAN22I2V14BLightspeed_synthseductionHighV9.safetensors \
      /comfyui/models/diffusion_models/wan22EnhancedNSFWSVICamera_nsfwV2FP8H.safetensors; \
    ln -sf /comfyui/models/diffusion_models/DasiwaWAN22I2V14BLightspeed_synthseductionLowV9.safetensors \
      /comfyui/models/diffusion_models/wan22EnhancedNSFWSVICamera_nsfwV2FP8L.safetensors; \
    ln -sf /comfyui/models/diffusion_models/wan22EnhancedNSFWSVICamera_nsfwV2FP8H.safetensors \
      /comfyui/models/diffusion_models/wan22EnhancedNSFWSVICamera_nsfwFASTMOVEV2FP8H.safetensors; \
    ln -sf /comfyui/models/diffusion_models/wan22EnhancedNSFWSVICamera_nsfwV2FP8L.safetensors \
      /comfyui/models/diffusion_models/wan22EnhancedNSFWSVICamera_nsfwFASTMOVEV2FP8L.safetensors

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
