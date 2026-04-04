# RunPod worker: Wan 2.2 I2V (GGUF)

This worker runs ComfyUI with ComfyUI-GGUF and ComfyUI-WanVideoWrapper.
The GGUFs, CLIP, VAE, and LoRAs are baked into the image.

## Included models

- `models/unet/wan2.2_i2v_high_noise_14B_Q4_K_M.gguf`
- `models/unet/wan2.2_i2v_low_noise_14B_Q4_K_M.gguf`
- `models/loras/Wan2.2-Lightning_I2V-A14B-4steps-lora_HIGH_fp16.safetensors`
- `models/loras/Wan2.2-Lightning_I2V-A14B-4steps-lora_LOW_fp16.safetensors`
- `models/loras/NSFW-22-H-e8 (1).safetensors`
- `models/loras/WAN-2.2-I2V-BreastPlay-HIGH-v2.safetensors`
- `models/loras/reverse_suspended_congress_I2V_high.safetensors`
- `models/loras/wan22_i2v_anal_v1_high_noise.safetensors`
- `models/loras/wan22.r3v3rs3_c0wg1rl-14b-High-i2v_e70.safetensors`
- `models/loras/wan22-ultimatedeepthroat-i2v-102epoc-high-k3nk.safetensors`
- `models/loras/wan2.2_i2v_highnoise_pov_missionary_v1.0.safetensors`
- `models/loras/st0m4chBulg3_FUSED_HN (1).safetensors`
- `models/loras/wan2.2-i2v-high-pov-insertion-v1.0.safetensors`
- `models/loras/wan2.2-i2v-low-pov-insertion-v1.0.safetensors`
- `models/loras/Sensual_fingering_v1_low_noise.safetensors`
- `models/text_encoders/umt5-xxl-enc-bf16.safetensors`
- `models/vae/wan_2.1_vae.safetensors`

## Build

Place the model files before building:

```
models/unet/wan2.2_i2v_high_noise_14B_Q4_K_M.gguf
models/unet/wan2.2_i2v_low_noise_14B_Q4_K_M.gguf
models/loras/Wan2.2-Lightning_I2V-A14B-4steps-lora_HIGH_fp16.safetensors
models/loras/Wan2.2-Lightning_I2V-A14B-4steps-lora_LOW_fp16.safetensors
models/loras/NSFW-22-H-e8 (1).safetensors
models/loras/WAN-2.2-I2V-BreastPlay-HIGH-v2.safetensors
models/loras/reverse_suspended_congress_I2V_high.safetensors
models/loras/wan22_i2v_anal_v1_high_noise.safetensors
models/loras/wan22.r3v3rs3_c0wg1rl-14b-High-i2v_e70.safetensors
models/loras/wan22-ultimatedeepthroat-i2v-102epoc-high-k3nk.safetensors
models/loras/wan2.2_i2v_highnoise_pov_missionary_v1.0.safetensors
models/loras/st0m4chBulg3_FUSED_HN (1).safetensors
models/loras/wan2.2-i2v-high-pov-insertion-v1.0.safetensors
models/loras/wan2.2-i2v-low-pov-insertion-v1.0.safetensors
models/loras/Sensual_fingering_v1_low_noise.safetensors
models/text_encoders/umt5-xxl-enc-bf16.safetensors
models/vae/wan_2.1_vae.safetensors
```

```
docker build -t wan2.2-i2v-gguf .
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
