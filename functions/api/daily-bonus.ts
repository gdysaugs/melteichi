import { createClient, type User } from '@supabase/supabase-js'
import { buildCorsHeaders, isCorsBlocked } from '../_shared/cors'

type Env = {
  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
}

type DailyBonusStatusRow = {
  can_claim?: unknown
  next_eligible_at?: unknown
  remaining_seconds?: unknown
  bonus_slot?: unknown
  amount?: unknown
  cooldown_hours?: unknown
}

type DailyBonusClaimRow = DailyBonusStatusRow & {
  granted?: unknown
  tickets_left?: unknown
}

type TicketEventRow = {
  created_at?: unknown
}

const corsMethods = 'POST, GET, OPTIONS'
const BONUS_COOLDOWN_HOURS = 24
const BONUS_AMOUNT = 3
const BONUS_COOLDOWN_SECONDS = BONUS_COOLDOWN_HOURS * 60 * 60
const BONUS_COOLDOWN_MS = BONUS_COOLDOWN_SECONDS * 1000
const DAILY_BONUS_REASONS = ['daily_bonus', 'daily_bonus_claim', 'daily_bonus_fallback'] as const

const INTERNAL_SERVER_ERROR_MESSAGE = 'サーバー内部エラーが発生しました。時間をおいて再度お試しください。'
const ERROR_LOGIN_REQUIRED = 'ログインが必要です。'
const ERROR_AUTH_FAILED = '認証に失敗しました。'
const ERROR_GOOGLE_ONLY = 'Googleログインのみ対応しています。'
const ERROR_SUPABASE_NOT_SET = 'SUPABASE_URL または SUPABASE_SERVICE_ROLE_KEY が設定されていません。'

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

const pickFirstRow = <T>(value: T | T[] | null | undefined) => {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

const asInteger = (value: unknown, fallback = 0) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback
}

const asIsoString = (value: unknown) => (typeof value === 'string' && value ? value : null)

const hasCooldownElapsed = (nextEligibleAt: string | null, remainingSeconds: number) => {
  if (remainingSeconds > 0) return false
  if (!nextEligibleAt) return true
  const nextEligibleTime = new Date(nextEligibleAt).getTime()
  return Number.isFinite(nextEligibleTime) && nextEligibleTime <= Date.now()
}

const toRemainingSeconds = (nextEligibleAt: string | null) => {
  if (!nextEligibleAt) return 0
  const next = new Date(nextEligibleAt).getTime()
  if (!Number.isFinite(next)) return 0
  return Math.max(0, Math.ceil((next - Date.now()) / 1000))
}

const computeClaimCooldown = async (admin: ReturnType<typeof createClient>, userId: string) => {
  const { data, error } = await admin
    .from('ticket_events')
    .select('created_at')
    .eq('user_id', userId)
    .in('reason', [...DAILY_BONUS_REASONS])
    .gt('delta', 0)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    return null
  }

  const row = data as TicketEventRow | null
  const lastClaimAtRaw = typeof row?.created_at === 'string' ? row.created_at : ''
  if (!lastClaimAtRaw) {
    return { active: false, nextEligibleAt: null, remainingSeconds: 0 }
  }

  const lastClaimAt = new Date(lastClaimAtRaw).getTime()
  if (!Number.isFinite(lastClaimAt)) {
    return { active: false, nextEligibleAt: null, remainingSeconds: 0 }
  }

  const nextEligibleAt = new Date(lastClaimAt + BONUS_COOLDOWN_MS).toISOString()
  const remainingSeconds = toRemainingSeconds(nextEligibleAt)
  return {
    active: remainingSeconds > 0,
    nextEligibleAt,
    remainingSeconds,
  }
}

const normalizeStatusRow = (row: DailyBonusStatusRow) => {
  const nextEligibleAt = asIsoString(row.next_eligible_at)
  const remainingSeconds = asInteger(row.remaining_seconds, 0)
  return {
    canClaim: Boolean(row.can_claim) || hasCooldownElapsed(nextEligibleAt, remainingSeconds),
    nextEligibleAt,
    remainingSeconds,
    bonusSlot: asInteger(row.bonus_slot, 0),
    amount: asInteger(row.amount, BONUS_AMOUNT),
    cooldownHours: asInteger(row.cooldown_hours, BONUS_COOLDOWN_HOURS),
  }
}

const normalizeClaimRow = (row: DailyBonusClaimRow) => ({
  ...normalizeStatusRow(row),
  granted: Boolean(row.granted),
  ticketsLeft: row.tickets_left == null ? null : asInteger(row.tickets_left, 0),
})

type FallbackStatus = {
  canClaim: boolean
  nextEligibleAt: string | null
  remainingSeconds: number
  bonusSlot: number
  amount: number
  cooldownHours: number
}

const computeFallbackStatus = async (
  admin: ReturnType<typeof createClient>,
  user: User,
): Promise<FallbackStatus | null> => {
  const createdAtRaw = (user as User & { created_at?: string }).created_at
  const createdAtTime = createdAtRaw ? new Date(createdAtRaw).getTime() : NaN
  if (!Number.isFinite(createdAtTime)) {
    return null
  }

  const now = Date.now()
  const firstEligibleAtTime = createdAtTime + BONUS_COOLDOWN_MS

  if (now < firstEligibleAtTime) {
    const nextEligibleAt = new Date(firstEligibleAtTime).toISOString()
    return {
      canClaim: false,
      nextEligibleAt,
      remainingSeconds: toRemainingSeconds(nextEligibleAt),
      bonusSlot: 0,
      amount: BONUS_AMOUNT,
      cooldownHours: BONUS_COOLDOWN_HOURS,
    }
  }

  const bonusSlot = Math.floor((now - createdAtTime) / BONUS_COOLDOWN_MS)
  const currentUsageIds = [
    `daily_bonus:${user.id}:${bonusSlot}`,
    `daily_bonus_fallback:${user.id}:${bonusSlot}`,
  ]

  const { data: existingEvent, error } = await admin
    .from('ticket_events')
    .select('id')
    .eq('user_id', user.id)
    .in('usage_id', currentUsageIds)
    .limit(1)
    .maybeSingle()

  if (error) {
    return null
  }

  if (existingEvent) {
    const nextEligibleAt = new Date(createdAtTime + (bonusSlot + 1) * BONUS_COOLDOWN_MS).toISOString()
    return {
      canClaim: false,
      nextEligibleAt,
      remainingSeconds: toRemainingSeconds(nextEligibleAt),
      bonusSlot,
      amount: BONUS_AMOUNT,
      cooldownHours: BONUS_COOLDOWN_HOURS,
    }
  }

  return {
    canClaim: true,
    nextEligibleAt: null,
    remainingSeconds: 0,
    bonusSlot,
    amount: BONUS_AMOUNT,
    cooldownHours: BONUS_COOLDOWN_HOURS,
  }
}

const claimFallbackBonus = async (
  admin: ReturnType<typeof createClient>,
  user: User,
  status: FallbackStatus,
) => {
  if (!status.canClaim || status.bonusSlot <= 0) {
    const nextEligibleAt =
      status.nextEligibleAt ??
      new Date(Date.now() + BONUS_COOLDOWN_MS).toISOString()
    return {
      granted: false,
      ticketsLeft: null,
      nextEligibleAt,
      remainingSeconds: toRemainingSeconds(nextEligibleAt),
      bonusSlot: status.bonusSlot,
      amount: BONUS_AMOUNT,
      cooldownHours: BONUS_COOLDOWN_HOURS,
    }
  }

  const email = user.email
  if (!email) return null

  const usageId = `daily_bonus_fallback:${user.id}:${status.bonusSlot}`
  const { data, error } = await admin.rpc('grant_tickets', {
    p_usage_id: usageId,
    p_user_id: user.id,
    p_email: email,
    p_amount: BONUS_AMOUNT,
    p_reason: 'daily_bonus_fallback',
    p_metadata: {
      source: 'daily_bonus_fallback',
      bonus_slot: status.bonusSlot,
      cooldown_hours: BONUS_COOLDOWN_HOURS,
    },
    p_stripe_customer_id: null,
  })

  if (error) {
    return null
  }

  const row = pickFirstRow<{ tickets_left?: unknown; already_processed?: unknown }>(data)
  const nextEligibleAt = new Date(Date.now() + BONUS_COOLDOWN_MS).toISOString()
  return {
    granted: !Boolean(row?.already_processed),
    ticketsLeft: row?.tickets_left == null ? null : asInteger(row.tickets_left, 0),
    nextEligibleAt,
    remainingSeconds: toRemainingSeconds(nextEligibleAt),
    bonusSlot: status.bonusSlot,
    amount: BONUS_AMOUNT,
    cooldownHours: BONUS_COOLDOWN_HOURS,
  }
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

  const { data, error } = await auth.admin.rpc('get_daily_bonus_status', {
    p_user_id: auth.user.id,
  })
  let status: FallbackStatus
  if (error) {
    console.error('daily-bonus:get rpc get_daily_bonus_status failed', error)
    const fallback = await computeFallbackStatus(auth.admin, auth.user)
    if (!fallback) {
      return jsonResponse({ error: INTERNAL_SERVER_ERROR_MESSAGE }, 500, corsHeaders)
    }
    status = fallback
  } else {
    const statusRow = pickFirstRow<DailyBonusStatusRow>(data)
    if (!statusRow) {
      const fallback = await computeFallbackStatus(auth.admin, auth.user)
      if (!fallback) {
        return jsonResponse({ error: INTERNAL_SERVER_ERROR_MESSAGE }, 500, corsHeaders)
      }
      status = fallback
    } else {
      status = normalizeStatusRow(statusRow)
    }
  }

  const claimCooldown = await computeClaimCooldown(auth.admin, auth.user.id)
  if (claimCooldown?.active) {
    status = {
      ...status,
      canClaim: false,
      nextEligibleAt: claimCooldown.nextEligibleAt,
      remainingSeconds: claimCooldown.remainingSeconds,
      cooldownHours: BONUS_COOLDOWN_HOURS,
    }
  }

  return jsonResponse(
    {
      can_claim: status.canClaim,
      next_eligible_at: status.nextEligibleAt,
      remaining_seconds: status.remainingSeconds,
      cooldown_hours: status.cooldownHours,
      amount: status.amount,
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

  const claimCooldown = await computeClaimCooldown(auth.admin, auth.user.id)
  if (claimCooldown?.active) {
    return jsonResponse(
      {
        granted: false,
        can_claim: false,
        next_eligible_at: claimCooldown.nextEligibleAt,
        remaining_seconds: claimCooldown.remainingSeconds,
        reason: 'cooldown',
        cooldown_hours: BONUS_COOLDOWN_HOURS,
        amount: BONUS_AMOUNT,
        tickets_left: null,
      },
      200,
      corsHeaders,
    )
  }

  const { data, error } = await auth.admin.rpc('claim_daily_bonus', {
    p_user_id: auth.user.id,
  })
  let result:
    | ReturnType<typeof normalizeClaimRow>
    | {
        granted: boolean
        canClaim: boolean
        nextEligibleAt: string | null
        remainingSeconds: number
        bonusSlot: number
        amount: number
        cooldownHours: number
        ticketsLeft: number | null
      }

  if (error) {
    console.error('daily-bonus:post rpc claim_daily_bonus failed', error)
    const fallbackStatus = await computeFallbackStatus(auth.admin, auth.user)
    if (!fallbackStatus) {
      return jsonResponse({ error: INTERNAL_SERVER_ERROR_MESSAGE }, 500, corsHeaders)
    }
    const fallbackClaim = await claimFallbackBonus(auth.admin, auth.user, fallbackStatus)
    if (!fallbackClaim) {
      return jsonResponse({ error: INTERNAL_SERVER_ERROR_MESSAGE }, 500, corsHeaders)
    }
    result = {
      ...fallbackClaim,
      canClaim: false,
    }
  } else {
    const claimRow = pickFirstRow<DailyBonusClaimRow>(data)
    if (!claimRow) {
      return jsonResponse({ error: INTERNAL_SERVER_ERROR_MESSAGE }, 500, corsHeaders)
    }
    result = normalizeClaimRow(claimRow)
  }

  if (result.granted) {
    const nextEligibleAt = new Date(Date.now() + BONUS_COOLDOWN_MS).toISOString()
    result = {
      ...result,
      canClaim: false,
      nextEligibleAt,
      remainingSeconds: BONUS_COOLDOWN_SECONDS,
      cooldownHours: BONUS_COOLDOWN_HOURS,
    }
  }

  const reason = result.granted ? 'granted' : result.bonusSlot <= 0 ? 'not_eligible_yet' : 'cooldown'

  return jsonResponse(
    {
      granted: result.granted,
      can_claim: false,
      next_eligible_at: result.nextEligibleAt,
      remaining_seconds: result.remainingSeconds,
      reason,
      cooldown_hours: result.cooldownHours,
      amount: result.amount,
      tickets_left: result.ticketsLeft,
    },
    200,
    corsHeaders,
  )
}
