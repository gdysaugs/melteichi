FROM nvidia/cuda:12.6.3-cudnn-runtime-ubuntu24.04

ARG COMFYUI_VERSION=latest

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_PREFER_BINARY=1 \
    PYTHONUNBUFFERED=1 \
    CMAKE_BUILD_PARALLEL_LEVEL=8

RUN apt-get update && apt-get install -y \
    python3.12 \
    python3.12-venv \
    git \
    wget \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender1 \
    ffmpeg \
    && ln -sf /usr/bin/python3.12 /usr/bin/python \
    && ln -sf /usr/bin/pip3 /usr/bin/pip \
    && apt-get autoremove -y \
    && apt-get clean -y \
    && rm -rf /var/lib/apt/lists/*

RUN wget -qO- https://astral.sh/uv/install.sh | sh \
    && ln -s /root/.local/bin/uv /usr/local/bin/uv \
    && ln -s /root/.local/bin/uvx /usr/local/bin/uvx \
    && uv venv /opt/venv

ENV PATH="/opt/venv/bin:${PATH}"

RUN uv pip install comfy-cli pip setuptools wheel

RUN /usr/bin/yes | comfy --workspace /comfyui install --version "${COMFYUI_VERSION}" --nvidia
RUN if [ -f /comfyui/requirements.txt ]; then \
      uv pip install -r /comfyui/requirements.txt; \
    fi \
    && uv pip install alembic

WORKDIR /comfyui

RUN git clone https://github.com/city96/ComfyUI-GGUF /comfyui/custom_nodes/ComfyUI-GGUF \
    && uv pip install -r /comfyui/custom_nodes/ComfyUI-GGUF/requirements.txt

RUN git clone https://github.com/kijai/ComfyUI-WanVideoWrapper /comfyui/custom_nodes/ComfyUI-WanVideoWrapper \
    && if [ -f /comfyui/custom_nodes/ComfyUI-WanVideoWrapper/requirements.txt ]; then \
         uv pip install -r /comfyui/custom_nodes/ComfyUI-WanVideoWrapper/requirements.txt; \
       fi

RUN git clone https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite /comfyui/custom_nodes/ComfyUI-VideoHelperSuite \
    && uv pip install -r /comfyui/custom_nodes/ComfyUI-VideoHelperSuite/requirements.txt

# Required by wan-workflow-animate.json (easy seed / easy forLoopStart / easy ifElse)
RUN git clone https://github.com/yolain/ComfyUI-Easy-Use /comfyui/custom_nodes/ComfyUI-Easy-Use \
    && if [ -f /comfyui/custom_nodes/ComfyUI-Easy-Use/requirements.txt ]; then \
         uv pip install -r /comfyui/custom_nodes/ComfyUI-Easy-Use/requirements.txt; \
       fi

# Required by wan-workflow-animate.json (GetLatentSizeAndCount / BlockifyMask / DrawMaskOnImage)
RUN git clone https://github.com/kijai/ComfyUI-KJNodes /comfyui/custom_nodes/ComfyUI-KJNodes \
    && if [ -f /comfyui/custom_nodes/ComfyUI-KJNodes/requirements.txt ]; then \
         uv pip install -r /comfyui/custom_nodes/ComfyUI-KJNodes/requirements.txt; \
       fi

# Required by wan-workflow-animate.json (SimpleMath+)
RUN git clone https://github.com/cubiq/ComfyUI_essentials /comfyui/custom_nodes/ComfyUI_essentials \
    && if [ -f /comfyui/custom_nodes/ComfyUI_essentials/requirements.txt ]; then \
         uv pip install -r /comfyui/custom_nodes/ComfyUI_essentials/requirements.txt; \
       fi

# Required by wan-workflow-animate.json (ImpactConditionalBranchSelMode)
RUN git clone https://github.com/ltdrdata/ComfyUI-Impact-Pack /comfyui/custom_nodes/ComfyUI-Impact-Pack \
    && if [ -f /comfyui/custom_nodes/ComfyUI-Impact-Pack/requirements.txt ]; then \
         uv pip install -r /comfyui/custom_nodes/ComfyUI-Impact-Pack/requirements.txt; \
       fi

# Some Impact nodes are provided via subpack in certain versions
RUN git clone https://github.com/ltdrdata/ComfyUI-Impact-Subpack /comfyui/custom_nodes/ComfyUI-Impact-Subpack \
    && if [ -f /comfyui/custom_nodes/ComfyUI-Impact-Subpack/requirements.txt ]; then \
         uv pip install -r /comfyui/custom_nodes/ComfyUI-Impact-Subpack/requirements.txt; \
       fi

# Required by wan-workflow-animate.json (DWPreprocessor / PixelPerfectResolution)
RUN git clone https://github.com/Fannovel16/comfyui_controlnet_aux /comfyui/custom_nodes/comfyui_controlnet_aux \
    && if [ -f /comfyui/custom_nodes/comfyui_controlnet_aux/requirements.txt ]; then \
         uv pip install -r /comfyui/custom_nodes/comfyui_controlnet_aux/requirements.txt; \
       fi

# Required by wan-workflow-animate.json (PlaySound|pysssss)
RUN git clone https://github.com/pythongosssss/ComfyUI-Custom-Scripts /comfyui/custom_nodes/ComfyUI-Custom-Scripts \
    && if [ -f /comfyui/custom_nodes/ComfyUI-Custom-Scripts/requirements.txt ]; then \
         uv pip install -r /comfyui/custom_nodes/ComfyUI-Custom-Scripts/requirements.txt; \
       fi

# Required by wan-workflow-animate.json (RMBG)
RUN git clone https://github.com/1038lab/ComfyUI-RMBG /comfyui/custom_nodes/ComfyUI-RMBG \
    && if [ -f /comfyui/custom_nodes/ComfyUI-RMBG/requirements.txt ]; then \
         uv pip install -r /comfyui/custom_nodes/ComfyUI-RMBG/requirements.txt; \
       fi

RUN mkdir -p /comfyui/models/diffusion_models /comfyui/models/text_encoders /comfyui/models/vae

COPY models/unet/DasiwaWAN22I2V14BLightspeed_synthseductionHighV9.safetensors /comfyui/models/diffusion_models/wan22EnhancedNSFWSVICamera_nsfwFASTMOVEV2FP8H.safetensors
COPY models/unet/DasiwaWAN22I2V14BLightspeed_synthseductionLowV9.safetensors /comfyui/models/diffusion_models/wan22EnhancedNSFWSVICamera_nsfwFASTMOVEV2FP8L.safetensors
COPY models/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors /comfyui/models/text_encoders/
COPY models/vae/wan_2.1_vae.safetensors /comfyui/models/vae/

WORKDIR /

RUN uv pip install runpod requests websocket-client pillow

COPY handler.py /handler.py
COPY start.sh /start.sh
RUN chmod +x /start.sh

RUN rm -rf /comfyui/custom_nodes/ComfyUI-Manager

CMD ["/start.sh"]


