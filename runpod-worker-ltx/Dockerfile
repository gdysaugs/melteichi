FROM nvidia/cuda:12.6.3-cudnn-runtime-ubuntu24.04

ARG COMFYUI_VERSION=latest
ARG WORKER_BUILD=dev

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_PREFER_BINARY=1 \
    PYTHONUNBUFFERED=1 \
    CMAKE_BUILD_PARALLEL_LEVEL=8 \
    WORKER_BUILD=${WORKER_BUILD}

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
    libsndfile1 \
    && ln -sf /usr/bin/python3.12 /usr/bin/python \
    && ln -sf /usr/bin/pip3 /usr/bin/pip \
    && apt-get autoremove -y \
    && apt-get clean -y \
    && rm -rf /var/lib/apt/lists/*

RUN wget -qO- https://astral.sh/uv/install.sh | sh \
    && ln -s /root/.local/bin/uv /usr/local/bin/uv \
    && ln -s /root/.local/bin/uvx /usr/local/bin/uvx \
    && uv venv /opt/venv

ENV VIRTUAL_ENV=/opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

RUN uv pip install comfy-cli pip setuptools wheel pillow

RUN /usr/bin/yes | comfy --workspace /comfyui install --version "${COMFYUI_VERSION}" --nvidia
RUN if [ -f /comfyui/requirements.txt ]; then \
      uv pip install -r /comfyui/requirements.txt; \
    fi \
    && uv pip install alembic

WORKDIR /comfyui

RUN git clone https://github.com/city96/ComfyUI-GGUF /comfyui/custom_nodes/ComfyUI-GGUF \
    && if [ -f /comfyui/custom_nodes/ComfyUI-GGUF/requirements.txt ]; then \
         uv pip install -r /comfyui/custom_nodes/ComfyUI-GGUF/requirements.txt; \
       fi

RUN git clone https://github.com/kijai/ComfyUI-WanVideoWrapper /comfyui/custom_nodes/ComfyUI-WanVideoWrapper \
    && if [ -f /comfyui/custom_nodes/ComfyUI-WanVideoWrapper/requirements.txt ]; then \
         uv pip install -r /comfyui/custom_nodes/ComfyUI-WanVideoWrapper/requirements.txt; \
       fi

RUN git clone https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite /comfyui/custom_nodes/ComfyUI-VideoHelperSuite \
    && if [ -f /comfyui/custom_nodes/ComfyUI-VideoHelperSuite/requirements.txt ]; then \
         uv pip install -r /comfyui/custom_nodes/ComfyUI-VideoHelperSuite/requirements.txt; \
       fi

RUN git clone https://github.com/kijai/ComfyUI-KJNodes /comfyui/custom_nodes/ComfyUI-KJNodes \
    && if [ -f /comfyui/custom_nodes/ComfyUI-KJNodes/requirements.txt ]; then \
         uv pip install -r /comfyui/custom_nodes/ComfyUI-KJNodes/requirements.txt; \
       fi

RUN git clone https://github.com/rgthree/rgthree-comfy /comfyui/custom_nodes/rgthree-comfy \
    && if [ -f /comfyui/custom_nodes/rgthree-comfy/requirements.txt ]; then \
         uv pip install -r /comfyui/custom_nodes/rgthree-comfy/requirements.txt; \
       fi

RUN git clone https://github.com/Smirnov75/ComfyUI-mxToolkit /comfyui/custom_nodes/ComfyUI-mxToolkit \
    && if [ -f /comfyui/custom_nodes/ComfyUI-mxToolkit/requirements.txt ]; then \
         uv pip install -r /comfyui/custom_nodes/ComfyUI-mxToolkit/requirements.txt; \
       fi

RUN git clone https://github.com/jamesWalker55/comfyui-various /comfyui/custom_nodes/comfyui-various \
    && if [ -f /comfyui/custom_nodes/comfyui-various/requirements.txt ]; then \
         uv pip install -r /comfyui/custom_nodes/comfyui-various/requirements.txt; \
       fi

RUN git clone https://github.com/tritant/ComfyUI_Custom_Switch /comfyui/custom_nodes/ComfyUI_Custom_Switch \
    && if [ -f /comfyui/custom_nodes/ComfyUI_Custom_Switch/requirements.txt ]; then \
         uv pip install -r /comfyui/custom_nodes/ComfyUI_Custom_Switch/requirements.txt; \
       fi

RUN git clone https://github.com/chrisgoringe/cg-use-everywhere /comfyui/custom_nodes/cg-use-everywhere \
    && if [ -f /comfyui/custom_nodes/cg-use-everywhere/requirements.txt ]; then \
         uv pip install -r /comfyui/custom_nodes/cg-use-everywhere/requirements.txt; \
       fi

RUN git clone https://github.com/alexopus/ComfyUI-Image-Saver /comfyui/custom_nodes/ComfyUI-Image-Saver \
    && if [ -f /comfyui/custom_nodes/ComfyUI-Image-Saver/requirements.txt ]; then \
         uv pip install -r /comfyui/custom_nodes/ComfyUI-Image-Saver/requirements.txt; \
       fi

# Some custom node dependencies are not consistently declared in each repo.
# Install them explicitly to avoid import failures at runtime.
RUN python -m pip install --no-cache-dir \
    piexif \
    soundfile \
    opencv-python-headless \
    imageio-ffmpeg \
    accelerate \
    gguf

RUN python - <<'PY'
import piexif, soundfile, cv2, imageio_ffmpeg, accelerate, gguf
print("Dependency check OK:", piexif.__name__, soundfile.__name__, cv2.__name__, imageio_ffmpeg.__name__, accelerate.__name__, gguf.__name__)
PY

# RunPod Serverless hosts can lag behind newest PyTorch CUDA builds.
# Prefer CUDA 12.4 wheels; if unavailable in this environment, fall back to CUDA 12.1 wheels.
RUN python -m pip uninstall -y torch torchvision torchaudio || true \
    && (python -m pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cu124 \
         "torch==2.6.0+cu124" "torchvision==0.21.0+cu124" "torchaudio==2.6.0+cu124" \
        || python -m pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cu121 \
         "torch==2.5.1+cu121" "torchvision==0.20.1+cu121" "torchaudio==2.5.1+cu121")

RUN python - <<'PY'
import torch
print("Pinned torch:", torch.__version__, "CUDA:", torch.version.cuda)
cuda_version = str(torch.version.cuda or "")
assert cuda_version.startswith("12.4") or cuda_version.startswith("12.1"), f"unexpected torch CUDA build: {torch.version.cuda}"
PY

RUN mkdir -p \
    /comfyui/models/diffusion_models \
    /comfyui/models/loras \
    /comfyui/models/text_encoders \
    /comfyui/models/vae \
    /comfyui/models/upscale_models \
    /comfyui/models/llm \
    /workflow

COPY models/unet/ltx-2.3-22b-dev-Q4_K_M.gguf /comfyui/models/diffusion_models/ltx-2-3-22b-dev-Q4_K_M.gguf
COPY models/loras/ltx-2.3-22b-distilled-lora-dynamic_fro09_avg_rank_105_bf16.safetensors /comfyui/models/loras/
COPY models/text_encoders/ltx-2.3_text_projection_bf16.safetensors /comfyui/models/text_encoders/
COPY models/vae/LTX23_video_vae_bf16.safetensors /comfyui/models/vae/
COPY models/vae/LTX23_audio_vae_bf16.safetensors /comfyui/models/vae/
COPY models/vae/taeltx2_3.safetensors /comfyui/models/vae/
COPY models/upscale_models/ltx-2.3-spatial-upscaler-x2-1.1.safetensors /comfyui/models/upscale_models/
COPY models/llm/gemma_3_12B_it_fp4_mixed.safetensors /comfyui/models/llm/

WORKDIR /

RUN uv pip install runpod requests websocket-client

COPY workflow-ltx-combi-3.0.json /workflow/ltx-2.3-combi-3.0.json
COPY handler.py /handler.py
COPY start.sh /start.sh
RUN chmod +x /start.sh

RUN rm -rf /comfyui/custom_nodes/ComfyUI-Manager

CMD ["/start.sh"]
