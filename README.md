# melteichi

AI video app (I2V / Animate) running on **Cloudflare Pages + Pages Functions**.

Official URL: https://melteichi.uk

## Architecture

- Frontend: Vite (`dist`)
- Backend API: `functions/api/*.ts` (Cloudflare Pages Functions)
- Video generation: Runpod Serverless (called from Pages Functions)
- Cloudflare Worker deploy: **not used**

## Local Setup

1. Install dependencies
```bash
nvm use
npm install
```

2. Create local vars (`.dev.vars`)
```env
RUNPOD_API_KEY=...
RUNPOD_WAN_ENDPOINT_URL=https://api.runpod.ai/v2/<endpoint-id>
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
```

3. Run app
```bash
npm run dev
```

Build requires Node 24.x. The repository version is pinned in `.nvmrc`.

## Cloudflare Pages

Build command:
```bash
npm run build
```

Output directory:
```bash
dist
```

Deploy example:
```bash
npx wrangler pages deploy dist --project-name melteichi --branch main
```

## Required Pages Environment Variables

- `RUNPOD_API_KEY`
- `RUNPOD_WAN_ENDPOINT_URL`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Optional:
- `CORS_ALLOWED_ORIGINS`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_SUCCESS_URL`
- `STRIPE_CANCEL_URL`
