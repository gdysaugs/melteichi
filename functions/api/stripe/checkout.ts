import { createClient, type User } from '@supabase/supabase-js'
import { buildCorsHeaders, isCorsBlocked } from '../../_shared/cors'

type Env = {
  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
  STRIPE_SECRET_KEY?: string
  STRIPE_API_KEY?: string
  STRIPE_LIVE_SECRET_KEY?: string
  STRIPE_KEY?: string
  STRIPE_SUCCESS_URL?: string
  STRIPE_CANCEL_URL?: string
}

const corsMethods = 'POST, OPTIONS'

const jsonResponse = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  })

const parseJsonSafely = (text: string) => {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const resolveStripeSecretKey = (env: Env) => {
  const candidates = [env.STRIPE_SECRET_KEY, env.STRIPE_API_KEY, env.STRIPE_LIVE_SECRET_KEY, env.STRIPE_KEY]
  for (const value of candidates) {
    const normalized = String(value ?? '').trim()
    if (normalized) return normalized
  }
  return ''
}

const extractBearerToken = (request: Request) => {
  const header = request.headers.get('Authorization') || ''
  const match = header.match(/Bearer\s+(.+)/i)
  return match ? match[1] : ''
}

const getSupabaseAdmin = (env: Env) => {
  const url = env.SUPABASE_URL
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return null
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

const isGoogleUser = (user: User) => {
  if (user.app_metadata?.provider === 'google') return true
  if (Array.isArray(user.identities)) {
    return user.identities.some((identity) => identity.provider === 'google')
  }
  return false
}

const requireGoogleUser = async (request: Request, env: Env, corsHeaders: HeadersInit) => {
  const token = extractBearerToken(request)
  if (!token) {
    return { response: jsonResponse({ error: 'ログインが必要です。' }, 401, corsHeaders) }
  }
  const admin = getSupabaseAdmin(env)
  if (!admin) {
    return { response: jsonResponse({ error: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set.' }, 500, corsHeaders) }
  }
  const { data, error } = await admin.auth.getUser(token)
  if (error || !data?.user) {
    return { response: jsonResponse({ error: '認証に失敗しました。' }, 401, corsHeaders) }
  }
  if (!isGoogleUser(data.user)) {
    return { response: jsonResponse({ error: 'Googleログインのみ利用できます。' }, 403, corsHeaders) }
  }
  return { admin, user: data.user }
}

const PRICE_MAP = new Map([
  ['price_1TIA1SAHjIANZ9z3a3U015UN', { label: 'お試しパック', tickets: 25 }],
  ['price_1TIA1jAHjIANZ9z3ReE5aAsV', { label: 'お得パック', tickets: 115 }],
  ['price_1TIA2LAHjIANZ9z3uNOI1ZQr', { label: '大容量パック', tickets: 600 }],
])

const getRedirectUrl = (env: Env, request: Request, key: 'STRIPE_SUCCESS_URL' | 'STRIPE_CANCEL_URL', fallback: string) =>
  env[key] ?? new URL(fallback, request.url).toString()

export const onRequestOptions: PagesFunction<Env> = async ({ request, env }) => {
  const corsHeaders = buildCorsHeaders(request, env, corsMethods)
  if (isCorsBlocked(request, env)) {
    return new Response(null, { status: 403, headers: corsHeaders })
  }
  return new Response(null, { headers: corsHeaders })
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const corsHeaders = buildCorsHeaders(request, env, corsMethods)
  if (isCorsBlocked(request, env)) {
    return new Response(null, { status: 403, headers: corsHeaders })
  }

  const auth = await requireGoogleUser(request, env, corsHeaders)
  if ('response' in auth) {
    return auth.response
  }

  const stripeKey = resolveStripeSecretKey(env)
  if (!stripeKey) {
    return jsonResponse(
      { error: 'Stripe秘密鍵が未設定です。STRIPE_SECRET_KEY（または STRIPE_API_KEY）を設定してください。' },
      500,
      corsHeaders,
    )
  }

  const payload = await request.json().catch(() => null)
  if (!payload) {
    return jsonResponse({ error: 'Invalid request body.' }, 400, corsHeaders)
  }

  const priceId = String(payload.price_id ?? payload.priceId ?? '')
  const plan = PRICE_MAP.get(priceId)
  if (!plan) {
    return jsonResponse({ error: '不正なプランです。' }, 400, corsHeaders)
  }

  const email = auth.user.email ?? ''
  const successUrl = getRedirectUrl(env, request, 'STRIPE_SUCCESS_URL', '/?checkout=success')
  const cancelUrl = getRedirectUrl(env, request, 'STRIPE_CANCEL_URL', '/?checkout=cancel')

  const params = new URLSearchParams()
  params.set('mode', 'payment')
  params.set('success_url', successUrl)
  params.set('cancel_url', cancelUrl)
  params.set('line_items[0][price]', priceId)
  params.set('line_items[0][quantity]', '1')
  params.set('client_reference_id', auth.user.id)
  if (email) {
    params.set('customer_email', email)
  }
  params.set('metadata[user_id]', auth.user.id)
  params.set('metadata[email]', email)
  params.set('metadata[tickets]', String(plan.tickets))
  params.set('metadata[price_id]', priceId)
  params.set('metadata[plan_label]', plan.label)
  params.set('metadata[app]', 'akumaai')
  params.set('payment_intent_data[statement_descriptor]', 'AKUMAAI')

  let stripeRes: Response
  try {
    stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    })
  } catch {
    return jsonResponse({ error: 'Stripe APIへの接続に失敗しました。' }, 502, corsHeaders)
  }

  const stripeText = await stripeRes.text()
  const stripeData = parseJsonSafely(stripeText)
  if (!stripeRes.ok) {
    const stripeMessage =
      (stripeData as any)?.error?.message ||
      (typeof stripeText === 'string' && stripeText.trim() ? stripeText.trim().slice(0, 300) : '')
    return jsonResponse({ error: stripeMessage || 'Stripeのセッション作成に失敗しました。' }, 500, corsHeaders)
  }
  const checkoutUrl = typeof (stripeData as any)?.url === 'string' ? (stripeData as any).url : ''
  if (!checkoutUrl) {
    return jsonResponse({ error: 'StripeセッションURLの取得に失敗しました。' }, 500, corsHeaders)
  }

  return jsonResponse({ url: checkoutUrl }, 200, corsHeaders)
}
