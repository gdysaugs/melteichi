FROM nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y \
    python3 \
    python3-venv \
    python3-pip \
    build-essential \
    cmake \
    pkg-config \
    git \
    ffmpeg \
    libsndfile1 \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && python -m venv /opt/venv \
    && /opt/venv/bin/pip install --upgrade pip setuptools wheel \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/opt/venv/bin:${PATH}" \
    HF_HOME=/app/.cache/huggingface

WORKDIR /app
RUN git clone --depth 1 https://github.com/Aratako/Irodori-TTS /app/Irodori-TTS

WORKDIR /app/Irodori-TTS
RUN pip install --index-url https://download.pytorch.org/whl/cu128 \
    torch==2.10.0+cu128 torchaudio==2.10.0+cu128
RUN pip install -r requirements.txt
RUN pip install runpod

WORKDIR /app
ARG APP_REV=0
LABEL org.opencontainers.image.revision=$APP_REV
ENV PYTHONPATH=/app/Irodori-TTS
RUN mkdir -p /app/models
COPY models/model_voicedesign.safetensors /app/models/model.safetensors
COPY handler.py /app/handler.py
COPY start.sh /start.sh
RUN chmod +x /start.sh

ENV IRODORI_CHECKPOINT=/app/models/model.safetensors \
    IRODORI_MODEL_DEVICE=cuda \
    IRODORI_CODEC_DEVICE=cuda \
    IRODORI_MODEL_PRECISION=bf16 \
    IRODORI_CODEC_PRECISION=bf16 \
    IRODORI_CODEC_REPO=Aratako/Semantic-DACVAE-Japanese-32dim \
    IRODORI_DEFAULT_SECONDS=20 \
    IRODORI_DEFAULT_NUM_STEPS=40 \
    IRODORI_MAX_SECONDS=45 \
    IRODORI_MAX_NUM_STEPS=80 \
    IRODORI_MAX_TEXT_LENGTH=100 \
    IRODORI_MAX_REFERENCE_TEXT_LENGTH=300

CMD ["/start.sh"]
