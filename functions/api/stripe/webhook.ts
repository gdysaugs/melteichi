import { createClient } from '@supabase/supabase-js'

type Env = {
  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  STRIPE_WEBHOOK_SIGNING_SECRET?: string
  STRIPE_SIGNING_SECRET?: string
}

const PLAN_MAP = new Map([
  ['light', { amountJpy: 599, tickets: 30 }],
  ['standard', { amountJpy: 1799, tickets: 100 }],
  ['expert', { amountJpy: 3999, tickets: 250 }],
])

const LEGACY_PRICE_MAP = new Map([
  ['price_1TKX8BA1siHjiLk36mgjovm4', { amountJpy: 599, tickets: 30 }],
  ['price_1TKX9tA1siHjiLk3DpAMqVKG', { amountJpy: 1799, tickets: 100 }],
  ['price_1TKXA7A1siHjiLk30rK61AHP', { amountJpy: 3999, tickets: 250 }],
  ['price_1TIA1SAHjIANZ9z3a3U015UN', { amountJpy: 470, tickets: 25 }],
  ['price_1TIA1jAHjIANZ9z3ReE5aAsV', { amountJpy: 1980, tickets: 115 }],
  ['price_1TIA2LAHjIANZ9z3uNOI1ZQr', { amountJpy: 9980, tickets: 600 }],
])

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Stripe-Signature',
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

const getSupabaseAdmin = (env: Env) => {
  const url = env.SUPABASE_URL
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return null
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

const resolveStripeWebhookSecret = (env: Env) => {
  const candidates = [env.STRIPE_WEBHOOK_SECRET, env.STRIPE_WEBHOOK_SIGNING_SECRET, env.STRIPE_SIGNING_SECRET]
  for (const value of candidates) {
    const normalized = String(value ?? '').trim()
    if (normalized) return normalized
  }
  return ''
}

const textEncoder = new TextEncoder()

const toHex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')

const timingSafeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

const verifyStripeSignature = async (payload: string, signature: string, secret: string) => {
  const parts = signature.split(',').map((item) => item.trim())
  const timestampPart = parts.find((item) => item.startsWith('t='))
  const v1Parts = parts.filter((item) => item.startsWith('v1='))
  if (!timestampPart || v1Parts.length === 0) return false
  const timestamp = timestampPart.slice(2)
  const signedPayload = `${timestamp}.${payload}`
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, textEncoder.encode(signedPayload))
  const expected = toHex(signatureBuffer)
  return v1Parts.some((part) => timingSafeEqual(part.slice(3), expected))
}

export const onRequestOptions: PagesFunction = async () => new Response(null, { headers: corsHeaders })

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const secret = resolveStripeWebhookSecret(env)
  if (!secret) {
    return jsonResponse({ error: 'STRIPE_WEBHOOK_SECRET is not set.' }, 500)
  }

  const signature = request.headers.get('stripe-signature') || ''
  const body = await request.text()
  const isValid = await verifyStripeSignature(body, signature, secret)
  if (!isValid) {
    return jsonResponse({ error: 'Invalid signature.' }, 401)
  }

  const event = body ? JSON.parse(body) : null
  if (!event?.type) {
    return jsonResponse({ error: 'Invalid event payload.' }, 400)
  }

  if (event.type !== 'checkout.session.completed') {
    return jsonResponse({ received: true })
  }

  const session = event.data?.object ?? {}
  if (session.payment_status && session.payment_status !== 'paid') {
    return jsonResponse({ received: true })
  }

  const appTag = String(session.metadata?.app ?? '')
  if (appTag !== 'melteichi') {
    return jsonResponse({ received: true })
  }

  const planId = String(session.metadata?.plan_id ?? '')
  const priceId = String(session.metadata?.price_id ?? '')
  const plan = PLAN_MAP.get(planId) ?? LEGACY_PRICE_MAP.get(priceId)
  if (!plan) {
    return jsonResponse({ received: true })
  }

  const tickets = plan.tickets
  const email = String(session.metadata?.email ?? session.customer_details?.email ?? '')
  const userId = String(session.metadata?.user_id ?? session.client_reference_id ?? '')
  const usageId = String(event.id ?? session.id ?? '')
  const stripeCustomerId = session.customer ? String(session.customer) : null

  if (!tickets || !email || !userId || !usageId) {
    return jsonResponse({ error: 'Missing metadata.' }, 400)
  }

  const admin = getSupabaseAdmin(env)
  if (!admin) {
    return jsonResponse({ error: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set.' }, 500)
  }

  const { data: userCheck, error: userCheckError } = await admin.auth.admin.getUserById(userId)
  if (userCheckError || !userCheck?.user) {
    return jsonResponse({ received: true })
  }

  const { data: rpcData, error: rpcError } = await admin.rpc('grant_tickets', {
    p_usage_id: usageId,
    p_user_id: userId,
    p_email: email,
    p_amount: tickets,
    p_reason: 'stripe_purchase',
    p_metadata: {
      plan_id: planId || null,
      price_id: priceId,
      amount_jpy: plan.amountJpy,
      metadata_tickets: session.metadata?.tickets ?? null,
      session_id: session.id ?? null,
    },
    p_stripe_customer_id: stripeCustomerId,
  })

  if (rpcError) {
    const message = rpcError.message ?? 'Failed to grant tickets.'
    if (message.includes('INVALID')) {
      return jsonResponse({ error: message }, 400)
    }
    return jsonResponse({ error: message }, 500)
  }

  const result = Array.isArray(rpcData) ? rpcData[0] : rpcData
  if (result?.already_processed) {
    return jsonResponse({ received: true, duplicate: true })
  }

  return jsonResponse({ received: true })
}
