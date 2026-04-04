# runpod-worker-irodori

RunPod Serverless worker for Irodori-TTS VoiceDesign v2 only.

## Included checkpoint

- `models/model_voicedesign.safetensors` copied to `/app/models/model.safetensors`

## Build

```bash
cd /home/adama/akumaai
docker build -t suarez123/wan22-i2v:irodori-tts-voicedesign-v2-20260401 ./runpod-worker-irodori
docker push suarez123/wan22-i2v:irodori-tts-voicedesign-v2-20260401
```

## Runtime input

- `text` (required)
- `reference_text` (optional)
- `seconds` (optional)
- `num_steps` (optional)
- `seed` (optional)

`reference_audio_*` is ignored in this VoiceDesign-only worker.

## Required Endpoint Env Vars (Cloudflare Pages)

- `RUNPOD_IRODORI_ENDPOINT_URL`
- `RUNPOD_API_KEY`
