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
RUN rm -rf /comfyui/custom_nodes/ComfyUI-Manager

WORKDIR /comfyui

RUN git clone https://github.com/city96/ComfyUI-GGUF /comfyui/custom_nodes/ComfyUI-GGUF \
    && uv pip install -r /comfyui/custom_nodes/ComfyUI-GGUF/requirements.txt

RUN mkdir -p /comfyui/models/unet /comfyui/models/loras /comfyui/models/text_encoders /comfyui/models/vae

COPY models/unet/qwen-image-edit-2511-Q4_K_M.gguf /comfyui/models/unet/
COPY models/loras/Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors /comfyui/models/loras/
COPY models/loras/Qwen_Snofs_1_3.safetensors /comfyui/models/loras/
COPY models/loras/qwen-edit-skin_1.1_000002750.safetensors /comfyui/models/loras/
COPY models/loras/qwen-image-edit-2511-multiple-angles-lora.safetensors /comfyui/models/loras/
COPY ["models/loras/NSFW Female Enhancer Qwen V0.3.safetensors", "/comfyui/models/loras/"]
COPY models/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors /comfyui/models/text_encoders/
COPY models/vae/qwen_image_vae.safetensors /comfyui/models/vae/

WORKDIR /

RUN uv pip install runpod requests websocket-client

COPY handler.py /handler.py
COPY start.sh /start.sh
RUN chmod +x /start.sh

CMD ["/start.sh"]
