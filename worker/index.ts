import { onRequestGet as qwenGet, onRequestPost as qwenPost, onRequestOptions as qwenOptions } from '../functions/api/qwen'
import { onRequestGet as wanGet, onRequestPost as wanPost, onRequestOptions as wanOptions } from '../functions/api/wan'
import { onRequestGet as wanRemixGet, onRequestPost as wanRemixPost, onRequestOptions as wanRemixOptions } from '../functions/api/wan_remix'
import { onRequestGet as wanRapidGet, onRequestPost as wanRapidPost, onRequestOptions as wanRapidOptions } from '../functions/api/wan-rapid'
import {
  onRequestGet as wanRapidFastmoveGet,
  onRequestPost as wanRapidFastmovePost,
  onRequestOptions as wanRapidFastmoveOptions,
} from '../functions/api/wan-rapid-fastmove'
import {
  onRequestGet as wanSmoothmixGet,
  onRequestPost as wanSmoothmixPost,
  onRequestOptions as wanSmoothmixOptions,
} from '../functions/api/wan-smoothmix'
import { onRequestGet as ticketsGet, onRequestOptions as ticketsOptions } from '../functions/api/tickets'
import { onRequestPost as stripeCheckoutPost, onRequestOptions as stripeCheckoutOptions } from '../functions/api/stripe/checkout'
import { onRequestPost as stripeWebhookPost, onRequestOptions as stripeWebhookOptions } from '../functions/api/stripe/webhook'

type Env = {
  RUNPOD_API_KEY: string
  RUNPOD_API_KEY_I2V4?: string
  RUNPOD_ENDPOINT_URL?: string
  RUNPOD_WAN_ENDPOINT_URL?: string
  RUNPOD_WAN_REMIX_ENDPOINT_URL?: string
  RUNPOD_WAN_RAPID_ENDPOINT_URL?: string
  RUNPOD_WAN_SMOOTHMIX_ENDPOINT_URL?: string
  RUNPOD_WAN_RAPID_FASTMOVE_ENDPOINT_URL?: string
  RUNPOD_WAN_DASIWA_ENDPOINT_URL?: string
  COMFY_ORG_API_KEY?: string
  RUNPOD_WORKER_MODE?: string
  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  STRIPE_SUCCESS_URL?: string
  STRIPE_CANCEL_URL?: string
  CORS_ALLOWED_ORIGINS?: string
}

type PagesArgs = {
  request: Request
  env: Env
}

const notFound = () => new Response('Not Found', { status: 404 })
const methodNotAllowed = () => new Response('Method Not Allowed', { status: 405 })

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url)
    const path = url.pathname
    const method = request.method.toUpperCase()
    const args: PagesArgs = { request, env }

    if (path.startsWith('/api/qwen')) {
      if (method === 'OPTIONS') return qwenOptions(args as any)
      if (method === 'GET') return qwenGet(args as any)
      if (method === 'POST') return qwenPost(args as any)
      return methodNotAllowed()
    }

    if (path.startsWith('/api/wan-remix')) {
      if (method === 'OPTIONS') return wanRemixOptions(args as any)
      if (method === 'GET') return wanRemixGet(args as any)
      if (method === 'POST') return wanRemixPost(args as any)
      return methodNotAllowed()
    }

    if (path.startsWith('/api/wan-rapid-fastmove')) {
      if (method === 'OPTIONS') return wanRapidFastmoveOptions(args as any)
      if (method === 'GET') return wanRapidFastmoveGet(args as any)
      if (method === 'POST') return wanRapidFastmovePost(args as any)
      return methodNotAllowed()
    }

    if (path.startsWith('/api/wan-smoothmix')) {
      if (method === 'OPTIONS') return wanSmoothmixOptions(args as any)
      if (method === 'GET') return wanSmoothmixGet(args as any)
      if (method === 'POST') return wanSmoothmixPost(args as any)
      return methodNotAllowed()
    }

    if (path.startsWith('/api/wan-rapid')) {
      if (method === 'OPTIONS') return wanRapidOptions(args as any)
      if (method === 'GET') return wanRapidGet(args as any)
      if (method === 'POST') return wanRapidPost(args as any)
      return methodNotAllowed()
    }

    if (path.startsWith('/api/wan-dasiwa')) {
      if (method === 'OPTIONS') return wanOptions(args as any)
      if (method === 'GET') return wanGet(args as any)
      if (method === 'POST') return wanPost(args as any)
      return methodNotAllowed()
    }

    if (path.startsWith('/api/wan')) {
      if (method === 'OPTIONS') return wanOptions(args as any)
      if (method === 'GET') return wanGet(args as any)
      if (method === 'POST') return wanPost(args as any)
      return methodNotAllowed()
    }

    if (path.startsWith('/api/tickets')) {
      if (method === 'OPTIONS') return ticketsOptions(args as any)
      if (method === 'GET') return ticketsGet(args as any)
      return methodNotAllowed()
    }

    if (path.startsWith('/api/stripe/checkout')) {
      if (method === 'OPTIONS') return stripeCheckoutOptions(args as any)
      if (method === 'POST') return stripeCheckoutPost(args as any)
      return methodNotAllowed()
    }

    if (path.startsWith('/api/stripe/webhook')) {
      if (method === 'OPTIONS') return stripeWebhookOptions(args as any)
      if (method === 'POST') return stripeWebhookPost(args as any)
      return methodNotAllowed()
    }

    return notFound()
  },
}
