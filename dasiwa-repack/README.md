# DaSiWa repack (from suarez123/wan22-i2v:v2026.03.17-190559-18899)

1. Put model files in `dasiwa-repack/models/` with exact names:
   - `DasiwaWAN22I2V14BLightspeed_synthseductionHighV9.safetensors`
   - `DasiwaWAN22I2V14BLightspeed_synthseductionLowV9.safetensors`

2. Build image:
   `docker build -t suarez123/wan22-i2v:dasiwa-v9-20260328 /home/adama/melteichi/dasiwa-repack`

3. Push image:
   `docker push suarez123/wan22-i2v:dasiwa-v9-20260328`
