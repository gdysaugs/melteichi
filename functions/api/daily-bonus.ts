import { createClient, type User } from '@supabase/supabase-js'
import { buildCorsHeaders, isCorsBlocked } from '../_shared/cors'

type Env = {
  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
}

const corsMethods = 'POST, GET, OPTIONS'
const BONUS_COOLDOWN_HOURS = 24
const BONUS_COOLDOWN_MS = BONUS_COOLDOWN_HOURS * 60 * 60 * 1000
const BONUS_AMOUNT = 3
const DAILY_BONUS_REASONS = ['daily_bonus', 'daily_bonus_claim']

const INTERNAL_SERVER_ERROR_MESSAGE = '\u30b5\u30fc\u30d0\u30fc\u5185\u90e8\u30a8\u30e9\u30fc\u304c\u767a\u751f\u3057\u307e\u3057\u305f\u3002\u6642\u9593\u3092\u304a\u3044\u3066\u518d\u5ea6\u304a\u8a66\u3057\u304f\u3060\u3055\u3044\u3002'
const ERROR_LOGIN_REQUIRED = '\u30ed\u30b0\u30a4\u30f3\u304c\u5fc5\u8981\u3067\u3059\u3002'
const ERROR_AUTH_FAILED = '\u8a8d\u8a3c\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002'
const ERROR_GOOGLE_ONLY = 'Google\u30ed\u30b0\u30a4\u30f3\u306e\u307f\u5bfe\u5fdc\u3057\u3066\u3044\u307e\u3059\u3002'
const ERROR_SUPABASE_NOT_SET =
  'SUPABASE_URL \u307e\u305f\u306f SUPABASE_SERVICE_ROLE_KEY \u304c\u8a2d\u5b9a\u3055\u308c\u3066\u3044\u307e\u305b\u3093\u3002'

const jsonResponse = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  })

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
    return { response: jsonResponse({ error: ERROR_LOGIN_REQUIRED }, 401, corsHeaders) }
  }
  const admin = getSupabaseAdmin(env)
  if (!admin) {
    return { response: jsonResponse({ error: ERROR_SUPABASE_NOT_SET }, 500, corsHeaders) }
  }
  const { data, error } = await admin.auth.getUser(token)
  if (error || !data?.user) {
    return { response: jsonResponse({ error: ERROR_AUTH_FAILED }, 401, corsHeaders) }
  }
  if (!isGoogleUser(data.user)) {
    return { response: jsonResponse({ error: ERROR_GOOGLE_ONLY }, 403, corsHeaders) }
  }
  return { admin, user: data.user }
}

const fetchLatestClaimAt = async (
  admin: ReturnType<typeof createClient>,
  userId: string,
  email: string,
) => {
  const byUser = await admin
    .from('ticket_events')
    .select('created_at')
    .eq('user_id', userId)
    .in('reason', DAILY_BONUS_REASONS)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (byUser.error) return { error: byUser.error, createdAt: null as string | null }
  if (byUser.data?.created_at) return { error: null, createdAt: String(byUser.data.created_at) }
  if (!email) return { error: null, createdAt: null as string | null }

  const byEmail = await admin
    .from('ticket_events')
    .select('created_at')
    .eq('email', email)
    .in('reason', DAILY_BONUS_REASONS)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (byEmail.error) return { error: byEmail.error, createdAt: null as string | null }
  return { error: null, createdAt: byEmail.data?.created_at ? String(byEmail.data.created_at) : null }
}

const parseTimeMs = (value: string | null | undefined) => {
  if (!value) return null
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}

const buildBonusStatus = (latestClaimAt: string | null, userCreatedAt: string | null) => {
  const now = Date.now()
  const createdMs = parseTimeMs(userCreatedAt)
  const lastClaimMs = parseTimeMs(latestClaimAt)
  const initialEligibleMs = createdMs !== null ? createdMs + BONUS_COOLDOWN_MS : null
  const claimEligibleMs = lastClaimMs !== null ? lastClaimMs + BONUS_COOLDOWN_MS : null

  let nextMs: number | null = null
  if (initialEligibleMs !== null) {
    nextMs = initialEligibleMs
  }
  if (claimEligibleMs !== null) {
    nextMs = nextMs === null ? claimEligibleMs : Math.max(nextMs, claimEligibleMs)
  }

  if (nextMs === null) {
    return {
      canClaim: true,
      nextEligibleAt: null as string | null,
      remainingSeconds: 0,
    }
  }

  const diff = nextMs - now
  if (diff <= 0) {
    return {
      canClaim: true,
      nextEligibleAt: null as string | null,
      remainingSeconds: 0,
    }
  }

  return {
    canClaim: false,
    nextEligibleAt: new Date(nextMs).toISOString(),
    remainingSeconds: Math.ceil(diff / 1000),
  }
}

const getDailyBonusStatus = async (
  admin: ReturnType<typeof createClient>,
  user: User,
) => {
  const email = user.email ?? ''
  const userCreatedAt = typeof user.created_at === 'string' ? user.created_at : null
  const latest = await fetchLatestClaimAt(admin, user.id, email)
  if (latest.error) {
    return { error: latest.error, status: null as null | ReturnType<typeof buildBonusStatus> }
  }
  return { error: null, status: buildBonusStatus(latest.createdAt, userCreatedAt) }
}

const buildDailyBonusUsageId = (userId: string) => {
  const slot = Math.floor(Date.now() / BONUS_COOLDOWN_MS)
  return `daily_bonus:${userId}:${slot}`
}

export const onRequestOptions: PagesFunction<Env> = async ({ request, env }) => {
  const corsHeaders = buildCorsHeaders(request, env, corsMethods)
  if (isCorsBlocked(request, env)) {
    return new Response(null, { status: 403, headers: corsHeaders })
  }
  return new Response(null, { headers: corsHeaders })
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const corsHeaders = buildCorsHeaders(request, env, corsMethods)
  if (isCorsBlocked(request, env)) {
    return new Response(null, { status: 403, headers: corsHeaders })
  }

  const auth = await requireGoogleUser(request, env, corsHeaders)
  if ('response' in auth) {
    return auth.response
  }

  const statusResult = await getDailyBonusStatus(auth.admin, auth.user)
  if (statusResult.error || !statusResult.status) {
    return jsonResponse({ error: INTERNAL_SERVER_ERROR_MESSAGE }, 500, corsHeaders)
  }

  return jsonResponse(
    {
      can_claim: statusResult.status.canClaim,
      next_eligible_at: statusResult.status.nextEligibleAt,
      remaining_seconds: statusResult.status.remainingSeconds,
      cooldown_hours: BONUS_COOLDOWN_HOURS,
      amount: BONUS_AMOUNT,
    },
    200,
    corsHeaders,
  )
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

  const statusResult = await getDailyBonusStatus(auth.admin, auth.user)
  if (statusResult.error || !statusResult.status) {
    return jsonResponse({ error: INTERNAL_SERVER_ERROR_MESSAGE }, 500, corsHeaders)
  }

  if (!statusResult.status.canClaim) {
    return jsonResponse(
      {
        granted: false,
        can_claim: false,
        next_eligible_at: statusResult.status.nextEligibleAt,
        remaining_seconds: statusResult.status.remainingSeconds,
        reason: 'cooldown',
        cooldown_hours: BONUS_COOLDOWN_HOURS,
        amount: BONUS_AMOUNT,
      },
      200,
      corsHeaders,
    )
  }

  const email = auth.user.email ?? ''
  const usageId = buildDailyBonusUsageId(auth.user.id)
  const { data, error } = await auth.admin.rpc('grant_tickets', {
    p_usage_id: usageId,
    p_user_id: auth.user.id,
    p_email: email,
    p_amount: BONUS_AMOUNT,
    p_reason: 'daily_bonus',
    p_metadata: {
      source: 'daily_bonus',
      cooldown_hours: BONUS_COOLDOWN_HOURS,
    },
  })

  if (error) {
    return jsonResponse({ error: INTERNAL_SERVER_ERROR_MESSAGE }, 500, corsHeaders)
  }

  const result = Array.isArray(data) ? data[0] : data
  const alreadyProcessed = Boolean(result?.already_processed)
  const ticketsLeftRaw = Number(result?.tickets_left)
  const nextEligibleAt = new Date(Date.now() + BONUS_COOLDOWN_MS).toISOString()
  return jsonResponse(
    {
      granted: !alreadyProcessed,
      can_claim: false,
      next_eligible_at: nextEligibleAt,
      remaining_seconds: Math.ceil(BONUS_COOLDOWN_MS / 1000),
      reason: alreadyProcessed ? 'cooldown' : 'granted',
      cooldown_hours: BONUS_COOLDOWN_HOURS,
      amount: BONUS_AMOUNT,
      tickets_left: Number.isFinite(ticketsLeftRaw) ? ticketsLeftRaw : null,
    },
    200,
    corsHeaders,
  )
}



