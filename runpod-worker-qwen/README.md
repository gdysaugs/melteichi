# RunPod worker: Qwen Image Edit 2511 (GGUF + edit LoRAs)

This worker runs ComfyUI with ComfyUI-GGUF. The GGUF, CLIP, VAE, and LoRAs
are baked into the image, so there are no runtime downloads.

## Included models

- `models/unet/qwen-image-edit-2511-Q4_K_M.gguf`
- `models/loras/Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors`
- `models/loras/Qwen_Snofs_1_3.safetensors`
- `models/loras/qwen-edit-skin_1.1_000002750.safetensors`
- `models/loras/NSFW Female Enhancer Qwen V0.3.safetensors`
- `models/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors`
- `models/vae/qwen_image_vae.safetensors`

## Build

Place the model files before building:

```
models/unet/qwen-image-edit-2511-Q4_K_M.gguf
models/loras/Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors
models/loras/Qwen_Snofs_1_3.safetensors
models/loras/qwen-edit-skin_1.1_000002750.safetensors
models/loras/NSFW Female Enhancer Qwen V0.3.safetensors
models/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors
models/vae/qwen_image_vae.safetensors
```

```
docker build -t qwen-multiangle-gguf .
```

## Run (local)

```
docker run --gpus all -p 8188:8188 qwen-multiangle-gguf
```

## Example input

Use the ComfyUI API workflow (API JSON format). The main app uses
`functions/api/qwen-workflow.json` plus the node map in
`functions/api/qwen-node-map.json`.

```
{
  "input": {
    "workflow": { "1": { "class_type": "LoadImage", "inputs": { "image": "input.png" } } },
    "images": [
      { "name": "input.png", "image": "<base64>" }
    ]
  }
}
```
