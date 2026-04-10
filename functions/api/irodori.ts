import { createClient, type User } from '@supabase/supabase-js'
import { buildCorsHeaders, isCorsBlocked } from '../_shared/cors'

type Env = {
  RUNPOD_API_KEY?: string
  RUNPOD_IRODORI_ENDPOINT_URL?: string
  RUNPOD_ENDPOINT_URL?: string
  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
}

const corsMethods = 'POST, GET, OPTIONS'
const MAX_TEXT_LENGTH = 100
const MAX_REFERENCE_TEXT_LENGTH = 300
const PIPELINE_USAGE_ID_MAX_LENGTH = 128
const PIPELINE_USAGE_ID_MAX_AGE_MS = 15 * 60 * 1000
const PIPELINE_USAGE_ID_PATTERN = /^media:(\d{13}):([A-Za-z0-9-]{16,96})$/
const DEFAULT_IRODORI_ENDPOINT = 'https://api.runpod.ai/v2/qzj27jy7fkzpk7'
const SIGNUP_TICKET_GRANT = 5
const TTS_TICKET_COST = 1
const HIDDEN_MODEL_NAME_PATTERN =
  /Irodori-TTS-500M-v2-VoiceDesign|Irodori-TTS-500M-v2|Irodori-TTS|Irodori|VoiceDesign|MMAudio|Wav2Lip|WAV2LIP/gi
const HIDDEN_MODEL_FILE_PATTERN =
  /[A-Za-z0-9_./%\-]+?\.(safetensors|gguf|onnx|pt|pth|ckpt|bin)/gi
const GENERIC_MODEL_LABEL = 'speech model'

const jsonResponse = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  })

const resolveEndpoint = (env: Env) =>
  (env.RUNPOD_IRODORI_ENDPOINT_URL ?? env.RUNPOD_ENDPOINT_URL ?? DEFAULT_IRODORI_ENDPOINT).replace(/\/$/, '')

const parseOptionalNumber = (raw: unknown) => {
  if (raw === undefined || raw === null || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  return n
}

const normalizePipelineUsageId = (raw: unknown, enforceAge = false) => {
  if (typeof raw !== 'string') return ''
  const value = raw.trim()
  if (!value) return ''
  if (value.length > PIPELINE_USAGE_ID_MAX_LENGTH) return ''
  const match = value.match(PIPELINE_USAGE_ID_PATTERN)
  if (!match) return ''
  if (enforceAge) {
    const createdAtMs = Number(match[1])
    if (!Number.isFinite(createdAtMs)) return ''
    const ageMs = Math.abs(Date.now() - createdAtMs)
    if (ageMs > PIPELINE_USAGE_ID_MAX_AGE_MS) return ''
  }
  return value
}

const isPipelineUsageId = (value: string) => PIPELINE_USAGE_ID_PATTERN.test(value)

const sanitizeUserText = (value: string) =>
  value
    .replace(HIDDEN_MODEL_NAME_PATTERN, GENERIC_MODEL_LABEL)
    .replace(HIDDEN_MODEL_FILE_PATTERN, `${GENERIC_MODEL_LABEL}.bin`)

const sanitizeJsonPayload = (value: unknown): unknown => {
  if (typeof value === 'string') return sanitizeUserText(value)
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonPayload(item))
  if (value && typeof value === 'object') {
    const next: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      next[key] = sanitizeJsonPayload(entry)
    }
    return next
  }
  return value
}

const sanitizeUpstreamBody = (raw: string, contentType: string | null) => {
  if (!raw) return raw
  if (contentType?.toLowerCase().includes('application/json')) {
    try {
      const parsed = JSON.parse(raw)
      return JSON.stringify(sanitizeJsonPayload(parsed))
    } catch {
      // fallback to plain text sanitize
    }
  }
  return sanitizeUserText(raw)
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

const normalizeEmail = (value: string | null | undefined) => (value ?? '').trim().toLowerCase()

const makeUsageId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

const requireGoogleUser = async (request: Request, env: Env, corsHeaders: HeadersInit) => {
  const token = extractBearerToken(request)
  if (!token) {
    return { response: jsonResponse({ error: 'ログインが必要です。' }, 401, corsHeaders) }
  }

  const admin = getSupabaseAdmin(env)
  if (!admin) {
    return {
      response: jsonResponse(
        { error: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set.' },
        500,
        corsHeaders,
      ),
    }
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

const fetchTicketRow = async (admin: ReturnType<typeof createClient>, user: User) => {
  const email = user.email
  const { data: byUser, error: userError } = await admin
    .from('user_tickets')
    .select('id, email, user_id, tickets')
    .eq('user_id', user.id)
    .maybeSingle()

  if (userError) {
    return { error: userError }
  }
  if (byUser) {
    return { data: byUser, error: null }
  }
  if (!email) {
    return { data: null, error: null }
  }

  const { data: byEmail, error: emailError } = await admin
    .from('user_tickets')
    .select('id, email, user_id, tickets')
    .ilike('email', email)
    .maybeSingle()

  if (emailError) {
    return { error: emailError }
  }
  return { data: byEmail, error: null }
}

const ensureTicketRow = async (admin: ReturnType<typeof createClient>, user: User) => {
  const email = user.email
  if (!email) {
    return { data: null, error: null }
  }

  const { data: existing, error } = await fetchTicketRow(admin, user)
  if (error) {
    return { data: null, error }
  }
  if (existing) {
    return { data: existing, error: null, created: false }
  }

  const { data: inserted, error: insertError } = await admin
    .from('user_tickets')
    .insert({ email, user_id: user.id, tickets: SIGNUP_TICKET_GRANT })
    .select('id, email, user_id, tickets')
    .maybeSingle()

  if (insertError || !inserted) {
    const { data: retry, error: retryError } = await fetchTicketRow(admin, user)
    if (retryError) {
      return { data: null, error: retryError }
    }
    return { data: retry, error: null, created: false }
  }

  await admin.from('ticket_events').insert({
    usage_id: makeUsageId(),
    email,
    user_id: user.id,
    delta: SIGNUP_TICKET_GRANT,
    reason: 'signup_bonus',
    metadata: { source: 'auto_grant' },
  })

  return { data: inserted, error: null, created: true }
}

const ensureTicketAvailable = async (
  admin: ReturnType<typeof createClient>,
  user: User,
  requiredTickets: number,
  corsHeaders: HeadersInit,
) => {
  const email = user.email
  if (!email) {
    return { response: jsonResponse({ error: 'Email not available.' }, 400, corsHeaders) }
  }

  const { data: existing, error } = await ensureTicketRow(admin, user)
  if (error) {
    return { response: jsonResponse({ error: 'サーバー内部エラーが発生しました。' }, 500, corsHeaders) }
  }
  if (!existing) {
    return { response: jsonResponse({ error: 'No tickets available.' }, 402, corsHeaders) }
  }

  if (!existing.user_id) {
    await admin.from('user_tickets').update({ user_id: user.id }).eq('id', existing.id)
  }

  if (existing.tickets < requiredTickets) {
    return { response: jsonResponse({ error: 'No tickets remaining.' }, 402, corsHeaders) }
  }

  return { existing }
}

const consumeTicket = async (
  admin: ReturnType<typeof createClient>,
  user: User,
  metadata: Record<string, unknown>,
  usageId: string,
  ticketCost: number,
  corsHeaders: HeadersInit,
) => {
  const cost = Math.max(1, Math.floor(ticketCost))
  const email = user.email
  if (!email) {
    return { response: jsonResponse({ error: 'Email not available.' }, 400, corsHeaders) }
  }

  const { data: existing, error } = await fetchTicketRow(admin, user)
  if (error) {
    return { response: jsonResponse({ error: 'サーバー内部エラーが発生しました。' }, 500, corsHeaders) }
  }
  if (!existing) {
    return { response: jsonResponse({ error: 'No tickets available.' }, 402, corsHeaders) }
  }

  const { data: rpcData, error: rpcError } = await admin.rpc('consume_tickets', {
    p_ticket_id: existing.id,
    p_usage_id: usageId,
    p_cost: cost,
    p_reason: 'generate_audio',
    p_metadata: metadata,
  })

  if (rpcError) {
    const message = rpcError.message ?? 'Failed to update tickets.'
    if (message.includes('INSUFFICIENT_TICKETS')) {
      return { response: jsonResponse({ error: 'No tickets remaining.' }, 402, corsHeaders) }
    }
    return { response: jsonResponse({ error: 'サーバー内部エラーが発生しました。' }, 500, corsHeaders) }
  }

  const result = Array.isArray(rpcData) ? rpcData[0] : rpcData
  const alreadyConsumed = Boolean(result?.already_consumed)
  if (alreadyConsumed && isPipelineUsageId(usageId)) {
    const { data: consumedEvent, error: consumedEventError } = await admin
      .from('ticket_events')
      .select('user_id, email, created_at')
      .eq('usage_id', usageId)
      .maybeSingle()

    if (consumedEventError) {
      return { response: jsonResponse({ error: 'サーバー内部エラーが発生しました。' }, 500, corsHeaders) }
    }

    if (!consumedEvent) {
      return { response: jsonResponse({ error: 'パイプライン識別子が無効です。再生成してください。' }, 409, corsHeaders) }
    }

    const eventUserId = consumedEvent.user_id ? String(consumedEvent.user_id) : ''
    const eventEmail = normalizeEmail(consumedEvent.email ? String(consumedEvent.email) : '')
    const userEmail = normalizeEmail(user.email)
    const ownedByUser = Boolean((eventUserId && eventUserId === user.id) || (eventEmail && userEmail && eventEmail === userEmail))
    if (!ownedByUser) {
      return { response: jsonResponse({ error: 'Job not found.' }, 404, corsHeaders) }
    }

    const createdAtMs = consumedEvent.created_at ? new Date(String(consumedEvent.created_at)).getTime() : NaN
    if (!Number.isFinite(createdAtMs) || Math.abs(Date.now() - createdAtMs) > PIPELINE_USAGE_ID_MAX_AGE_MS) {
      return { response: jsonResponse({ error: 'パイプライン識別子の期限が切れています。再生成してください。' }, 409, corsHeaders) }
    }
  }

  const ticketsLeft = Number(result?.tickets_left)
  return {
    ticketsLeft: Number.isFinite(ticketsLeft) ? ticketsLeft : undefined,
    alreadyConsumed,
  }
}

const refundTicket = async (
  admin: ReturnType<typeof createClient>,
  user: User,
  metadata: Record<string, unknown>,
  usageId: string,
  ticketCost: number,
  corsHeaders: HeadersInit,
) => {
  const refundAmount = Math.max(1, Math.floor(ticketCost))
  const email = user.email
  if (!email) {
    return { skipped: true }
  }

  const { data: chargeEvent, error: chargeError } = await admin
    .from('ticket_events')
    .select('usage_id, user_id, email')
    .eq('usage_id', usageId)
    .maybeSingle()

  if (chargeError) {
    return { response: jsonResponse({ error: 'サーバー内部エラーが発生しました。' }, 500, corsHeaders) }
  }

  const chargeUserId = chargeEvent?.user_id ? String(chargeEvent.user_id) : ''
  const chargeEmail = chargeEvent?.email ? String(chargeEvent.email) : ''
  const matchesUser = Boolean(chargeUserId && chargeUserId === user.id)
  const matchesEmail = Boolean(chargeEmail && chargeEmail.toLowerCase() === email.toLowerCase())
  if (!chargeEvent || (!matchesUser && !matchesEmail)) {
    return { skipped: true }
  }

  const refundUsageId = `${usageId}:refund`
  const { data: existingRefund, error: refundCheckError } = await admin
    .from('ticket_events')
    .select('usage_id')
    .eq('usage_id', refundUsageId)
    .maybeSingle()

  if (refundCheckError) {
    return { response: jsonResponse({ error: 'サーバー内部エラーが発生しました。' }, 500, corsHeaders) }
  }
  if (existingRefund) {
    return { alreadyRefunded: true }
  }

  const { data: existing, error } = await ensureTicketRow(admin, user)
  if (error) {
    return { response: jsonResponse({ error: 'サーバー内部エラーが発生しました。' }, 500, corsHeaders) }
  }
  if (!existing) {
    return { response: jsonResponse({ error: 'No tickets available.' }, 402, corsHeaders) }
  }

  const { data: rpcData, error: rpcError } = await admin.rpc('refund_tickets', {
    p_ticket_id: existing.id,
    p_usage_id: refundUsageId,
    p_amount: refundAmount,
    p_reason: 'refund',
    p_metadata: metadata,
  })

  if (rpcError) {
    return { response: jsonResponse({ error: 'サーバー内部エラーが発生しました。' }, 500, corsHeaders) }
  }

  const result = Array.isArray(rpcData) ? rpcData[0] : rpcData
  const ticketsLeft = Number(result?.tickets_left)
  return {
    ticketsLeft: Number.isFinite(ticketsLeft) ? ticketsLeft : undefined,
    alreadyRefunded: Boolean(result?.already_refunded),
  }
}

const ensureUsageOwnership = async (
  admin: ReturnType<typeof createClient>,
  user: User,
  usageId: string,
  corsHeaders: HeadersInit,
) => {
  const { data: chargeEvent, error: chargeError } = await admin
    .from('ticket_events')
    .select('user_id, email')
    .eq('usage_id', usageId)
    .maybeSingle()

  if (chargeError) {
    return { response: jsonResponse({ error: 'サーバー内部エラーが発生しました。' }, 500, corsHeaders) }
  }
  if (!chargeEvent) {
    return { response: jsonResponse({ error: 'Job not found.' }, 404, corsHeaders) }
  }

  const userEmail = normalizeEmail(user.email)
  const chargeUserId = chargeEvent.user_id ? String(chargeEvent.user_id) : ''
  const chargeEmail = normalizeEmail(chargeEvent.email ? String(chargeEvent.email) : '')
  const matchesUser = Boolean(chargeUserId && chargeUserId === user.id)
  const matchesEmail = Boolean(userEmail && chargeEmail && chargeEmail === userEmail)
  if (!matchesUser && !matchesEmail) {
    return { response: jsonResponse({ error: 'Job not found.' }, 404, corsHeaders) }
  }

  return { ok: true as const }
}

const extractRunpodStatus = (payload: any) => {
  const raw = payload?.status ?? payload?.state ?? payload?.output?.status ?? payload?.result?.status
  return raw ? String(raw).toUpperCase() : ''
}

const isFailureStatus = (status: string) => {
  const normalized = String(status || '').toUpperCase()
  return ['FAILED', 'CANCELLED', 'TIMED_OUT', 'ERROR'].includes(normalized)
}

const hasOutputError = (payload: any) => {
  if (!payload || typeof payload !== 'object') return false
  const candidates = [
    payload?.error,
    payload?.message,
    payload?.detail,
    payload?.output?.error,
    payload?.output?.message,
    payload?.result?.error,
    payload?.result?.message,
  ]
  return candidates.some((v) => typeof v === 'string' && v.trim().length > 0)
}

const extractRunpodJobId = (payload: any) => {
  const raw = payload?.id ?? payload?.job_id ?? payload?.jobId ?? payload?.output?.id ?? payload?.output?.job_id
  return raw ? String(raw) : ''
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
  if ('response' in auth) return auth.response

  if (!env.RUNPOD_API_KEY) {
    return jsonResponse({ error: 'RUNPOD_API_KEY is not set.' }, 500, corsHeaders)
  }

  const endpoint = resolveEndpoint(env)
  if (!endpoint) {
    return jsonResponse({ error: 'RunPod endpoint is not set.' }, 500, corsHeaders)
  }

  const params = new URL(request.url).searchParams
  const id = params.get('id')?.trim()
  if (!id) {
    return jsonResponse({ error: 'id is required.' }, 400, corsHeaders)
  }

  const pipelineUsageId = normalizePipelineUsageId(params.get('pipeline_usage_id'))
  const usageId = pipelineUsageId || `irodori:${id}`
  const ownership = await ensureUsageOwnership(auth.admin, auth.user, usageId, corsHeaders)
  if ('response' in ownership) return ownership.response

  const upstream = await fetch(`${endpoint}/status/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${env.RUNPOD_API_KEY}` },
  })
  const contentType = upstream.headers.get('Content-Type') ?? 'application/json'
  const raw = await upstream.text()

  let payload: any = null
  try {
    payload = raw ? JSON.parse(raw) : null
  } catch {
    payload = null
  }

  let ticketsLeft: number | null = null
  if (payload && (isFailureStatus(extractRunpodStatus(payload)) || hasOutputError(payload))) {
    const refundMeta = {
      source: 'status',
      job_id: id,
      status: extractRunpodStatus(payload) || null,
      ticket_cost: TTS_TICKET_COST,
      reason: 'failure',
    }
    const refund = await refundTicket(auth.admin, auth.user, refundMeta, usageId, TTS_TICKET_COST, corsHeaders)
    if ('response' in refund) return refund.response
    const nextTickets = Number((refund as { ticketsLeft?: unknown }).ticketsLeft)
    if (Number.isFinite(nextTickets)) ticketsLeft = nextTickets
  }

  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    if (ticketsLeft !== null) {
      payload.ticketsLeft = ticketsLeft
    }
    return jsonResponse(sanitizeJsonPayload(payload), upstream.status, corsHeaders)
  }

  const sanitized = sanitizeUpstreamBody(raw, contentType)
  return new Response(sanitized, {
    status: upstream.status,
    headers: { ...corsHeaders, 'Content-Type': contentType },
  })
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const corsHeaders = buildCorsHeaders(request, env, corsMethods)
  if (isCorsBlocked(request, env)) {
    return new Response(null, { status: 403, headers: corsHeaders })
  }

  const auth = await requireGoogleUser(request, env, corsHeaders)
  if ('response' in auth) return auth.response

  if (!env.RUNPOD_API_KEY) {
    return jsonResponse({ error: 'RUNPOD_API_KEY is not set.' }, 500, corsHeaders)
  }

  const endpoint = resolveEndpoint(env)
  if (!endpoint) {
    return jsonResponse({ error: 'RunPod endpoint is not set.' }, 500, corsHeaders)
  }

  const payload = await request.json().catch(() => null)
  if (!payload) {
    return jsonResponse({ error: 'Invalid request body.' }, 400, corsHeaders)
  }

  const input = payload.input ?? payload
  const rawPipelineUsageId = input?.pipeline_usage_id ?? payload?.pipeline_usage_id
  const pipelineUsageId = normalizePipelineUsageId(rawPipelineUsageId, true)
  if ((typeof rawPipelineUsageId === 'string' && rawPipelineUsageId.trim()) && !pipelineUsageId) {
    return jsonResponse({ error: 'pipeline_usage_id is invalid or expired.' }, 400, corsHeaders)
  }
  const text = String(input?.text ?? '').trim()
  if (!text) {
    return jsonResponse({ error: 'text is required.' }, 400, corsHeaders)
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return jsonResponse({ error: `text is too long (max ${MAX_TEXT_LENGTH}).` }, 400, corsHeaders)
  }

  const referenceText = String(input?.reference_text ?? '').trim()
  if (referenceText.length > MAX_REFERENCE_TEXT_LENGTH) {
    return jsonResponse({ error: `reference_text is too long (max ${MAX_REFERENCE_TEXT_LENGTH}).` }, 400, corsHeaders)
  }

  const secondsRaw = parseOptionalNumber(input?.seconds)
  if (secondsRaw === null) {
    return jsonResponse({ error: 'seconds must be a number.' }, 400, corsHeaders)
  }

  const numStepsRaw = parseOptionalNumber(input?.num_steps)
  if (numStepsRaw === null) {
    return jsonResponse({ error: 'num_steps must be a number.' }, 400, corsHeaders)
  }

  const seedRaw = parseOptionalNumber(input?.seed)
  if (seedRaw === null) {
    return jsonResponse({ error: 'seed must be a number.' }, 400, corsHeaders)
  }

  const ticketCheck = await ensureTicketAvailable(auth.admin, auth.user, TTS_TICKET_COST, corsHeaders)
  if ('response' in ticketCheck) {
    return ticketCheck.response
  }

  const runpodInput: Record<string, unknown> = {
    text,
    model_variant: 'voicedesign',
  }
  if (referenceText) runpodInput.reference_text = referenceText
  if (secondsRaw !== undefined) runpodInput.seconds = secondsRaw
  if (numStepsRaw !== undefined) runpodInput.num_steps = Math.floor(numStepsRaw)
  if (seedRaw !== undefined) runpodInput.seed = Math.floor(seedRaw)

  const upstream = await fetch(`${endpoint}/run`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RUNPOD_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input: runpodInput }),
  })

  const contentType = upstream.headers.get('Content-Type') ?? 'application/json'
  const raw = await upstream.text()

  let upstreamPayload: any = null
  try {
    upstreamPayload = raw ? JSON.parse(raw) : null
  } catch {
    upstreamPayload = null
  }

  if (!upstream.ok) {
    if (upstreamPayload && typeof upstreamPayload === 'object' && !Array.isArray(upstreamPayload)) {
      return jsonResponse(sanitizeJsonPayload(upstreamPayload), upstream.status, corsHeaders)
    }
    const sanitized = sanitizeUpstreamBody(raw, contentType)
    return new Response(sanitized, {
      status: upstream.status,
      headers: { ...corsHeaders, 'Content-Type': contentType },
    })
  }

  const jobId = extractRunpodJobId(upstreamPayload)
  const usageId = pipelineUsageId || (jobId ? `irodori:${jobId}` : `irodori:adhoc:${makeUsageId()}`)

  const chargeMeta = {
    source: 'run',
    job_id: jobId || null,
    status: extractRunpodStatus(upstreamPayload) || null,
    pipeline_usage_id: pipelineUsageId || null,
    ticket_cost: TTS_TICKET_COST,
  }
  const charge = await consumeTicket(auth.admin, auth.user, chargeMeta, usageId, TTS_TICKET_COST, corsHeaders)
  if ('response' in charge) return charge.response
  let ticketsLeft: number | null = Number.isFinite(Number(charge.ticketsLeft)) ? Number(charge.ticketsLeft) : null

  if (upstreamPayload && (isFailureStatus(extractRunpodStatus(upstreamPayload)) || hasOutputError(upstreamPayload))) {
    const refundMeta = {
      source: 'run',
      job_id: jobId || null,
      status: extractRunpodStatus(upstreamPayload) || null,
      ticket_cost: TTS_TICKET_COST,
      reason: 'failure',
    }
    const refund = await refundTicket(auth.admin, auth.user, refundMeta, usageId, TTS_TICKET_COST, corsHeaders)
    if ('response' in refund) return refund.response
    const nextTickets = Number((refund as { ticketsLeft?: unknown }).ticketsLeft)
    if (Number.isFinite(nextTickets)) ticketsLeft = nextTickets
  }

  if (upstreamPayload && typeof upstreamPayload === 'object' && !Array.isArray(upstreamPayload)) {
    if (ticketsLeft !== null) {
      upstreamPayload.ticketsLeft = ticketsLeft
    }
    return jsonResponse(sanitizeJsonPayload(upstreamPayload), upstream.status, corsHeaders)
  }

  const sanitized = sanitizeUpstreamBody(raw, contentType)
  return new Response(sanitized, {
    status: upstream.status,
    headers: { ...corsHeaders, 'Content-Type': contentType },
  })
}

