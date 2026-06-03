import { createClient, type User } from '@supabase/supabase-js'
import { buildCorsHeaders, isCorsBlocked } from '../_shared/cors'
import { isUnderageImage } from '../_shared/rekognition'

type Env = {
  RUNPOD_API_KEY: string
  RUNPOD_FLUX_I2I_API_KEY?: string
  RUNPOD_FLUX_I2I_ENDPOINT_URL?: string
  RUNPOD_FLUX_I2I_STEP8_COST_ENABLED?: string
  RUNPOD_LTX_API_KEY?: string
  COMFY_ORG_API_KEY?: string
  AWS_ACCESS_KEY_ID?: string
  AWS_SECRET_ACCESS_KEY?: string
  AWS_REGION?: string
  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
}

type TicketRow = {
  id: string
  email: string
  user_id: string | null
  tickets: number
}

const corsMethods = 'POST, GET, OPTIONS'
const SIGNUP_TICKET_GRANT = 5
const TICKET_COST = 1
const MAX_IMAGE_BYTES = 15 * 1024 * 1024
const MAX_PROMPT_LENGTH = 1600
const MIN_DIMENSION = 256
const MAX_DIMENSION = 1536
const MAX_REFERENCE_IMAGES = 1
const INTERNAL_ERROR_MESSAGE = 'エラーです。やり直してください。'
const UNDERAGE_BLOCK_MESSAGE =
  'この画像には暴力的な表現、低年齢、または規約違反の可能性があります。別の画像でお試しください。'

const jsonResponse = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

const resolveEndpoint = (env: Env) => env.RUNPOD_FLUX_I2I_ENDPOINT_URL?.replace(/\/$/, '')

const resolveRunpodApiKey = (env: Env) =>
  String(env.RUNPOD_FLUX_I2I_API_KEY ?? env.RUNPOD_LTX_API_KEY ?? env.RUNPOD_API_KEY ?? '').trim()

const isEnabled = (value: unknown) => String(value ?? '').toLowerCase() === 'true' || String(value ?? '') === '1'

const normalizeTicketCost = (value: unknown, fallback = TICKET_COST) => {
  const parsed = Math.floor(Number(value))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const resolveTicketCost = (env: Env, steps: number) =>
  isEnabled(env.RUNPOD_FLUX_I2I_STEP8_COST_ENABLED) && steps >= 8 ? 2 : TICKET_COST

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

const requireAuthenticatedUser = async (request: Request, env: Env, corsHeaders: HeadersInit) => {
  const token = extractBearerToken(request)
  if (!token) return { response: jsonResponse({ error: 'ログインが必要です。' }, 401, corsHeaders) }

  const admin = getSupabaseAdmin(env)
  if (!admin) {
    return { response: jsonResponse({ error: 'SUPABASE設定が不足しています。' }, 500, corsHeaders) }
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

const makeUsageId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

const isDuplicateError = (error: unknown) => {
  const supabaseError = error as { code?: string; message?: string; details?: string } | null
  const text = `${supabaseError?.message ?? ''} ${supabaseError?.details ?? ''}`.toLowerCase()
  return supabaseError?.code === '23505' || text.includes('duplicate')
}

const shouldFallbackTicketRpc = (error: unknown, functionName: string) => {
  const supabaseError = error as { code?: string; message?: string; details?: string } | null
  const text = `${supabaseError?.message ?? ''} ${supabaseError?.details ?? ''}`.toLowerCase()
  return (
    supabaseError?.code === 'PGRST202' ||
    supabaseError?.code === '42501' ||
    text.includes('permission denied') ||
    (text.includes(functionName) && text.includes('could not find'))
  )
}

const internalErrorResponse = (corsHeaders: HeadersInit, code = 'internal_error') =>
  jsonResponse({ error: INTERNAL_ERROR_MESSAGE, code }, 500, corsHeaders)

const logServerError = (label: string, error: unknown) => {
  console.error(`[flux-i2i] ${label}`, error)
}

const fetchTicketRow = async (admin: ReturnType<typeof createClient>, user: User) => {
  const email = user.email
  const { data: byUser, error: userError } = await admin
    .from('user_tickets')
    .select('id, email, user_id, tickets')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()
  if (userError) return { error: userError }
  if (byUser) return { data: byUser as TicketRow, error: null }
  if (!email) return { data: null, error: null }

  const { data: byEmail, error: emailError } = await admin
    .from('user_tickets')
    .select('id, email, user_id, tickets')
    .ilike('email', email)
    .limit(1)
    .maybeSingle()
  if (emailError) return { error: emailError }
  return { data: byEmail as TicketRow | null, error: null }
}

const attachTicketRowToUser = async (
  admin: ReturnType<typeof createClient>,
  user: User,
  row: TicketRow,
) => {
  if (row.user_id === user.id) return { data: row, error: null }

  const { data, error } = await admin
    .from('user_tickets')
    .update({ user_id: user.id, email: user.email ?? row.email })
    .eq('id', row.id)
    .select('id, email, user_id, tickets')
    .maybeSingle()

  if (!error && data) return { data: data as TicketRow, error: null }

  const retry = await fetchTicketRow(admin, user)
  if (retry.data) return { data: retry.data, error: null }
  return { data: null, error }
}

const ensureTicketRow = async (admin: ReturnType<typeof createClient>, user: User) => {
  const email = user.email
  if (!email) return { data: null, error: null }

  const { data: existing, error } = await fetchTicketRow(admin, user)
  if (error) return { data: null, error }
  if (existing) return attachTicketRowToUser(admin, user, existing)

  const { data: inserted, error: insertError } = await admin
    .from('user_tickets')
    .insert({ email, user_id: user.id, tickets: SIGNUP_TICKET_GRANT })
    .select('id, email, user_id, tickets')
    .maybeSingle()
  if (insertError || !inserted) {
    const retry = await fetchTicketRow(admin, user)
    return { data: retry.data, error: retry.error }
  }

  await admin.from('ticket_events').insert({
    usage_id: makeUsageId(),
    email,
    user_id: user.id,
    delta: SIGNUP_TICKET_GRANT,
    reason: 'signup_bonus',
    metadata: { source: 'auto_grant' },
  })

  return { data: inserted as TicketRow, error: null }
}

const updateTicketsWithCompareAndSwap = async (
  admin: ReturnType<typeof createClient>,
  user: User,
  row: TicketRow,
  nextTickets: number,
) => {
  const { data, error } = await admin
    .from('user_tickets')
    .update({ email: user.email ?? row.email, user_id: user.id, tickets: nextTickets })
    .eq('id', row.id)
    .eq('tickets', row.tickets)
    .select('id, email, user_id, tickets')
    .maybeSingle()

  if (error) return { data: null, error }
  return { data: data as TicketRow | null, error: null }
}

const consumeTicketDirectly = async (
  admin: ReturnType<typeof createClient>,
  user: User,
  startingRow: TicketRow,
  metadata: Record<string, unknown>,
  usageId: string,
  ticketCost: number,
  corsHeaders: HeadersInit,
) => {
  const email = user.email
  if (!email) return { response: jsonResponse({ error: 'メールアドレスを取得できません。' }, 400, corsHeaders) }

  const existingEvent = await admin
    .from('ticket_events')
    .select('usage_id')
    .eq('usage_id', usageId)
    .maybeSingle()
  if (existingEvent.error) return { response: internalErrorResponse(corsHeaders, 'consume_event_lookup_failed') }
  if (existingEvent.data) return { ticketsLeft: startingRow.tickets }

  let row: TicketRow | null = startingRow
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!row || row.tickets < ticketCost) {
      return { response: jsonResponse({ error: 'トークンが不足しています。' }, 402, corsHeaders) }
    }

    const nextTickets = row.tickets - ticketCost
    const updated = await updateTicketsWithCompareAndSwap(admin, user, row, nextTickets)
    if (updated.error) return { response: internalErrorResponse(corsHeaders, 'consume_ticket_update_failed') }
    if (updated.data) {
      const event = await admin.from('ticket_events').insert({
        usage_id: usageId,
        email,
        user_id: user.id,
        delta: -ticketCost,
        reason: 'generate_flux_i2i',
        metadata,
      })
      if (event.error) {
        await admin
          .from('user_tickets')
          .update({ tickets: row.tickets })
          .eq('id', row.id)
          .eq('tickets', nextTickets)
        if (isDuplicateError(event.error)) return { ticketsLeft: row.tickets }
        return { response: internalErrorResponse(corsHeaders, 'consume_event_insert_failed') }
      }
      return { ticketsLeft: nextTickets }
    }

    const refetched = await fetchTicketRow(admin, user)
    if (refetched.error) return { response: internalErrorResponse(corsHeaders, 'consume_ticket_refetch_failed') }
    row = refetched.data
  }

  return { response: internalErrorResponse(corsHeaders, 'consume_ticket_conflict') }
}

const refundTicketDirectly = async (
  admin: ReturnType<typeof createClient>,
  user: User,
  row: TicketRow,
  metadata: Record<string, unknown>,
  refundUsageId: string,
  ticketCost: number,
  corsHeaders: HeadersInit,
) => {
  const email = user.email
  if (!email) return { skipped: true }

  const event = await admin.from('ticket_events').insert({
    usage_id: refundUsageId,
    email,
    user_id: user.id,
    delta: ticketCost,
    reason: 'refund',
    metadata: { ...metadata, refund_amount: ticketCost },
  })
  if (event.error) {
    if (isDuplicateError(event.error)) return { alreadyRefunded: true }
    return { response: internalErrorResponse(corsHeaders, 'refund_event_insert_failed') }
  }

  let current: TicketRow | null = row
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!current) {
      await admin.from('ticket_events').delete().eq('usage_id', refundUsageId)
      return { skipped: true }
    }

    const nextTickets = current.tickets + ticketCost
    const updated = await updateTicketsWithCompareAndSwap(admin, user, current, nextTickets)
    if (updated.error) {
      await admin.from('ticket_events').delete().eq('usage_id', refundUsageId)
      return { response: internalErrorResponse(corsHeaders, 'refund_ticket_update_failed') }
    }
    if (updated.data) return { ticketsLeft: nextTickets }

    const refetched = await fetchTicketRow(admin, user)
    if (refetched.error) {
      await admin.from('ticket_events').delete().eq('usage_id', refundUsageId)
      return { response: internalErrorResponse(corsHeaders, 'refund_ticket_refetch_failed') }
    }
    current = refetched.data
  }

  await admin.from('ticket_events').delete().eq('usage_id', refundUsageId)
  return { response: internalErrorResponse(corsHeaders, 'refund_ticket_conflict') }
}

const ensureTicketAvailable = async (
  admin: ReturnType<typeof createClient>,
  user: User,
  ticketCost: number,
  corsHeaders: HeadersInit,
) => {
  const { data, error } = await ensureTicketRow(admin, user)
  if (error) {
    logServerError('ensure ticket row failed', error)
    return { response: internalErrorResponse(corsHeaders, 'ticket_row_failed') }
  }
  if (!data || data.tickets < ticketCost) {
    return { response: jsonResponse({ error: 'トークンが不足しています。' }, 402, corsHeaders) }
  }
  return { row: data }
}

const consumeTicket = async (
  admin: ReturnType<typeof createClient>,
  user: User,
  metadata: Record<string, unknown>,
  usageId: string,
  ticketCost: number,
  corsHeaders: HeadersInit,
) => {
  const email = user.email
  if (!email) return { response: jsonResponse({ error: 'メールアドレスを取得できません。' }, 400, corsHeaders) }

  const { data: row, error } = await ensureTicketRow(admin, user)
  if (error || !row) {
    logServerError('fetch ticket row before consume failed', error)
    return { response: internalErrorResponse(corsHeaders, 'ticket_fetch_failed') }
  }

  const { data: rpcData, error: rpcError } = await admin.rpc('consume_tickets', {
    p_ticket_id: row.id,
    p_usage_id: usageId,
    p_cost: ticketCost,
    p_reason: 'generate_flux_i2i',
    p_metadata: metadata,
  })
  if (rpcError) {
    const message = rpcError.message ?? ''
    if (message.includes('INSUFFICIENT_TICKETS')) {
      return { response: jsonResponse({ error: 'トークンが不足しています。' }, 402, corsHeaders) }
    }
    if (shouldFallbackTicketRpc(rpcError, 'consume_tickets')) {
      return consumeTicketDirectly(admin, user, row, metadata, usageId, ticketCost, corsHeaders)
    }
    logServerError('consume_tickets rpc failed', rpcError)
    return { response: internalErrorResponse(corsHeaders, 'consume_tickets_rpc_failed') }
  }

  const result = Array.isArray(rpcData) ? rpcData[0] : rpcData
  const ticketsLeft = Number(result?.tickets_left)
  return { ticketsLeft: Number.isFinite(ticketsLeft) ? ticketsLeft : undefined }
}

const refundTicket = async (
  admin: ReturnType<typeof createClient>,
  user: User,
  metadata: Record<string, unknown>,
  usageId: string,
  ticketCost: number,
  corsHeaders: HeadersInit,
) => {
  const email = user.email
  if (!email) return { skipped: true }

  const refundUsageId = `${usageId}:refund`
  const { data: existingRefund, error: refundCheckError } = await admin
    .from('ticket_events')
    .select('usage_id')
    .eq('usage_id', refundUsageId)
    .maybeSingle()
  if (refundCheckError) return { response: internalErrorResponse(corsHeaders, 'refund_lookup_failed') }
  if (existingRefund) return { alreadyRefunded: true }

  const { data: row, error } = await ensureTicketRow(admin, user)
  if (error || !row) return { response: internalErrorResponse(corsHeaders, 'refund_ticket_fetch_failed') }

  const { data: rpcData, error: rpcError } = await admin.rpc('refund_tickets', {
    p_ticket_id: row.id,
    p_usage_id: refundUsageId,
    p_amount: ticketCost,
    p_reason: 'refund',
    p_metadata: metadata,
  })
  if (rpcError) {
    if (isDuplicateError(rpcError)) return { alreadyRefunded: true }
    if (shouldFallbackTicketRpc(rpcError, 'refund_tickets')) {
      return refundTicketDirectly(admin, user, row, metadata, refundUsageId, ticketCost, corsHeaders)
    }
    logServerError('refund_tickets rpc failed', rpcError)
    return { response: internalErrorResponse(corsHeaders, 'refund_rpc_failed') }
  }

  const result = Array.isArray(rpcData) ? rpcData[0] : rpcData
  const ticketsLeft = Number(result?.tickets_left)
  return { ticketsLeft: Number.isFinite(ticketsLeft) ? ticketsLeft : undefined }
}

const ensureUsageOwnership = async (
  admin: ReturnType<typeof createClient>,
  user: User,
  usageId: string,
  corsHeaders: HeadersInit,
) => {
  const { data, error } = await admin
    .from('ticket_events')
    .select('user_id, email, metadata')
    .eq('usage_id', usageId)
    .maybeSingle()
  if (error) return { response: internalErrorResponse(corsHeaders, 'usage_lookup_failed') }
  if (!data) return { response: jsonResponse({ error: 'Job not found.' }, 404, corsHeaders) }

  const email = user.email ?? ''
  const matchesUser = data.user_id && String(data.user_id) === user.id
  const matchesEmail = email && data.email && String(data.email).toLowerCase() === email.toLowerCase()
  if (!matchesUser && !matchesEmail) {
    return { response: jsonResponse({ error: 'Job not found.' }, 404, corsHeaders) }
  }
  const metadata = (data as { metadata?: Record<string, unknown> } | null)?.metadata
  return { ok: true as const, ticketCost: normalizeTicketCost(metadata?.ticket_cost) }
}

const stripDataUrl = (value: string) => {
  const comma = value.indexOf(',')
  if (value.startsWith('data:') && comma !== -1) return value.slice(comma + 1)
  return value
}

const estimateBase64Bytes = (value: string) => {
  const trimmed = value.trim()
  const padding = trimmed.endsWith('==') ? 2 : trimmed.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding)
}

const ensureBase64Input = (value: unknown, label: string) => {
  if (typeof value !== 'string' || !value.trim()) return ''
  const trimmed = value.trim()
  if (/^https?:\/\//i.test(trimmed)) throw new Error(`${label} must be base64.`)
  const base64 = stripDataUrl(trimmed)
  if (estimateBase64Bytes(base64) > MAX_IMAGE_BYTES) throw new Error(`${label} is too large.`)
  return base64
}

const clampInt = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = Math.floor(Number(value))
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

const clampFloat = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

const extractJobId = (payload: any) =>
  payload?.id || payload?.jobId || payload?.job_id || payload?.output?.id

const hasOutputError = (payload: any) =>
  Boolean(
    payload?.error ||
      payload?.output?.error ||
      payload?.result?.error ||
      payload?.output?.output?.error ||
      payload?.result?.output?.error,
  )

const isFailureStatus = (payload: any) => {
  const status = String(payload?.status ?? payload?.state ?? '').toLowerCase()
  return status.includes('fail') || status.includes('error') || status.includes('cancel')
}

const parseReferenceImages = (input: Record<string, unknown>) => {
  const references: Array<{ name: string; image: string }> = []
  const addReference = (rawImage: unknown, rawName: unknown, fallbackName: string) => {
    const image = ensureBase64Input(rawImage, fallbackName)
    if (!image || references.length >= MAX_REFERENCE_IMAGES) return
    references.push({ name: String(rawName || `${fallbackName}.png`), image })
  }

  addReference(input.reference_image_base64 ?? input.reference_image, input.reference_image_name, 'reference')

  const list = input.reference_images
  if (Array.isArray(list)) {
    list.forEach((item, index) => {
      if (typeof item === 'string') {
        addReference(item, `reference_${index + 1}.png`, `reference_${index + 1}`)
        return
      }
      if (!item || typeof item !== 'object') return
      const record = item as Record<string, unknown>
      addReference(
        record.image_base64 ?? record.image ?? record.data,
        record.name ?? record.image_name ?? `reference_${index + 1}.png`,
        `reference_${index + 1}`,
      )
    })
  }

  return references
}

const extractImages = (payload: any) => {
  const output = payload?.output ?? payload?.result ?? payload
  const nested = output?.output ?? output?.result ?? output?.data
  const candidates = [
    output?.images,
    output?.output_images,
    output?.outputs,
    output?.data,
    payload?.images,
    nested?.images,
    nested?.output_images,
    nested?.outputs,
    nested?.data,
  ]
  return candidates.some((item) => Array.isArray(item) && item.length > 0)
}

export const onRequestOptions: PagesFunction<Env> = async ({ request, env }) => {
  const corsHeaders = buildCorsHeaders(request, env, corsMethods)
  if (isCorsBlocked(request, env)) return new Response(null, { status: 403, headers: corsHeaders })
  return new Response(null, { headers: corsHeaders })
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const corsHeaders = buildCorsHeaders(request, env, corsMethods)
  if (isCorsBlocked(request, env)) return new Response(null, { status: 403, headers: corsHeaders })

  const auth = await requireAuthenticatedUser(request, env, corsHeaders)
  if ('response' in auth) return auth.response

  const url = new URL(request.url)
  const id = url.searchParams.get('id')?.trim()
  const usageId = url.searchParams.get('usage_id')?.trim() || (id ? `flux_i2i:${id}` : '')
  if (!id) return jsonResponse({ error: 'idが必要です。' }, 400, corsHeaders)

  const ownership = await ensureUsageOwnership(auth.admin, auth.user, usageId, corsHeaders)
  if ('response' in ownership) return ownership.response
  const ticketCost = normalizeTicketCost(ownership.ticketCost)

  const runpodApiKey = resolveRunpodApiKey(env)
  const endpoint = resolveEndpoint(env)
  if (!runpodApiKey || !endpoint) return jsonResponse({ error: '生成サーバー設定が不足しています。' }, 500, corsHeaders)

  let upstream: Response
  try {
    upstream = await fetch(`${endpoint}/status/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${runpodApiKey}` },
    })
  } catch {
    return jsonResponse({ error: 'ステータス確認に失敗しました。' }, 502, corsHeaders)
  }

  const raw = await upstream.text()
  let payload: any = null
  let ticketsLeft: number | null = null
  try {
    payload = raw ? JSON.parse(raw) : null
  } catch {
    payload = null
  }

  if (payload && (isFailureStatus(payload) || hasOutputError(payload))) {
    const refund = await refundTicket(
      auth.admin,
      auth.user,
      { source: 'status', job_id: id, reason: 'failure', ticket_cost: ticketCost },
      usageId,
      ticketCost,
      corsHeaders,
    )
    if ('response' in refund) return refund.response
    const nextTickets = Number((refund as { ticketsLeft?: unknown }).ticketsLeft)
    if (Number.isFinite(nextTickets)) ticketsLeft = nextTickets
  }

  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    if (ticketsLeft !== null) payload.ticketsLeft = ticketsLeft
    payload.usage_id = usageId
    return jsonResponse(payload, upstream.status, corsHeaders)
  }

  return jsonResponse({ error: INTERNAL_ERROR_MESSAGE, id }, 502, corsHeaders)
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const corsHeaders = buildCorsHeaders(request, env, corsMethods)
  if (isCorsBlocked(request, env)) return new Response(null, { status: 403, headers: corsHeaders })

  const auth = await requireAuthenticatedUser(request, env, corsHeaders)
  if ('response' in auth) return auth.response

  const runpodApiKey = resolveRunpodApiKey(env)
  const endpoint = resolveEndpoint(env)
  if (!runpodApiKey || !endpoint) return jsonResponse({ error: '生成サーバー設定が不足しています。' }, 500, corsHeaders)

  const payload = await request.json().catch(() => null)
  if (!payload) return jsonResponse({ error: 'Invalid request body.' }, 400, corsHeaders)

  const input = (payload.input ?? payload) as Record<string, unknown>
  const prompt = String(input.prompt ?? input.text ?? '').trim()
  if (!prompt) return jsonResponse({ error: 'プロンプトが必要です。' }, 400, corsHeaders)
  if (prompt.length > MAX_PROMPT_LENGTH) return jsonResponse({ error: 'プロンプトが長すぎます。' }, 400, corsHeaders)

  let sourceImageBase64 = ''
  let referenceImages: Array<{ name: string; image: string }> = []
  try {
    sourceImageBase64 = ensureBase64Input(input.image_base64 ?? input.image, 'image')
    referenceImages = parseReferenceImages(input)
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : '画像の読み込みに失敗しました。' }, 400, corsHeaders)
  }
  if (!sourceImageBase64) return jsonResponse({ error: '元画像が必要です。' }, 400, corsHeaders)

  try {
    if (await isUnderageImage(sourceImageBase64, env)) {
      return jsonResponse({ error: UNDERAGE_BLOCK_MESSAGE }, 400, corsHeaders)
    }
    for (const reference of referenceImages) {
      if (await isUnderageImage(reference.image, env)) {
        return jsonResponse({ error: UNDERAGE_BLOCK_MESSAGE }, 400, corsHeaders)
      }
    }
  } catch {
    return jsonResponse({ error: '画像確認に失敗しました。' }, 500, corsHeaders)
  }

  const width = clampInt(input.width, 1024, MIN_DIMENSION, MAX_DIMENSION)
  const height = clampInt(input.height, 1024, MIN_DIMENSION, MAX_DIMENSION)
  const steps = clampInt(input.steps, 4, 1, 40)
  const cfg = clampFloat(input.cfg, 1, 0, 20)
  const megapixels = clampFloat(input.megapixels, 1, 0.05, 4)
  const ticketCost = resolveTicketCost(env, steps)
  const loraName = String(input.lora_name ?? 'klein_slider_anatomy.safetensors').trim()
  const loraStrength = clampFloat(input.strength_model ?? input.lora_strength, 1, -4, 4)
  const usageId = `flux_i2i:pending:${makeUsageId()}`
  const ticketMeta = {
    prompt_length: prompt.length,
    width,
    height,
    steps,
    cfg,
    megapixels,
    lora_name: loraName,
    lora_strength: loraStrength,
    reference_count: referenceImages.length,
    source: 'run',
    mode: 'flux_i2i',
    ticket_cost: ticketCost,
  }

  const ticketCheck = await ensureTicketAvailable(auth.admin, auth.user, ticketCost, corsHeaders)
  if ('response' in ticketCheck) return ticketCheck.response

  const ticketCharge = await consumeTicket(auth.admin, auth.user, ticketMeta, usageId, ticketCost, corsHeaders)
  if ('response' in ticketCharge) return ticketCharge.response
  let ticketsLeft: number | null = null
  const chargedTickets = Number((ticketCharge as { ticketsLeft?: unknown }).ticketsLeft)
  if (Number.isFinite(chargedTickets)) ticketsLeft = chargedTickets

  const runpodInput: Record<string, unknown> = {
    prompt,
    image_base64: sourceImageBase64,
    image_name: String(input.image_name ?? 'source.png'),
    model: String(input.model ?? 'distilled'),
    clip_name: String(input.clip_name ?? 'qwen_3_8b_fp8mixed.safetensors'),
    vae_name: String(input.vae_name ?? 'flux2-vae.safetensors'),
    steps,
    cfg,
    megapixels,
    sampler_name: String(input.sampler_name ?? input.sampler ?? 'euler'),
    lora_name: loraName,
    strength_model: loraStrength,
    strength_clip: clampFloat(input.strength_clip ?? input.lora_clip_strength, 0, -4, 4),
    seed:
      input.randomize_seed === false ? clampInt(input.seed, 0, 0, 2147483647) : Math.floor(Math.random() * 2147483647),
    filename_prefix: String(input.filename_prefix ?? 'melteichi-flux-i2i'),
  }
  if (referenceImages.length) {
    runpodInput.reference_image_base64 = referenceImages[0].image
    runpodInput.reference_image_name = referenceImages[0].name
    runpodInput.reference_images = referenceImages.map((reference) => ({
      image_base64: reference.image,
      image_name: reference.name,
      name: reference.name,
    }))
  }
  if (env.COMFY_ORG_API_KEY) runpodInput.comfy_org_api_key = env.COMFY_ORG_API_KEY

  let upstream: Response
  try {
    upstream = await fetch(`${endpoint}/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${runpodApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: runpodInput }),
    })
  } catch {
    const refund = await refundTicket(
      auth.admin,
      auth.user,
      { ...ticketMeta, reason: 'runpod_request_failed' },
      usageId,
      ticketCost,
      corsHeaders,
    )
    if ('response' in refund) return refund.response
    const nextTickets = Number((refund as { ticketsLeft?: unknown }).ticketsLeft)
    return jsonResponse(
      { error: '生成リクエストに失敗しました。', ticketsLeft: Number.isFinite(nextTickets) ? nextTickets : ticketsLeft },
      502,
      corsHeaders,
    )
  }

  const raw = await upstream.text()
  let upstreamPayload: any = null
  try {
    upstreamPayload = raw ? JSON.parse(raw) : null
  } catch {
    upstreamPayload = null
  }
  const jobId = extractJobId(upstreamPayload)
  let finalUsageId = usageId
  if (jobId) {
    finalUsageId = `flux_i2i:${jobId}`
    const { error } = await auth.admin
      .from('ticket_events')
      .update({ usage_id: finalUsageId, metadata: { ...ticketMeta, job_id: String(jobId) } })
      .eq('usage_id', usageId)
    if (error) {
      const refund = await refundTicket(
        auth.admin,
        auth.user,
        { ...ticketMeta, reason: 'usage_rewrite_failed' },
        usageId,
        ticketCost,
        corsHeaders,
      )
      if ('response' in refund) return refund.response
      return jsonResponse({ error: INTERNAL_ERROR_MESSAGE }, 500, corsHeaders)
    }
  }

  if (upstreamPayload && typeof upstreamPayload === 'object' && !Array.isArray(upstreamPayload)) {
    if (isFailureStatus(upstreamPayload) || hasOutputError(upstreamPayload) || !upstream.ok) {
      const refund = await refundTicket(
        auth.admin,
        auth.user,
        { ...ticketMeta, job_id: jobId ? String(jobId) : null, reason: 'runpod_failure' },
        finalUsageId,
        ticketCost,
        corsHeaders,
      )
      if ('response' in refund) return refund.response
      const nextTickets = Number((refund as { ticketsLeft?: unknown }).ticketsLeft)
      if (Number.isFinite(nextTickets)) ticketsLeft = nextTickets
      return jsonResponse({ error: INTERNAL_ERROR_MESSAGE, ticketsLeft }, upstream.ok ? upstream.status : 502, corsHeaders)
    }
    if (ticketsLeft !== null) upstreamPayload.ticketsLeft = ticketsLeft
    upstreamPayload.usage_id = finalUsageId
    return jsonResponse(upstreamPayload, upstream.status, corsHeaders)
  }

  const refund = await refundTicket(
    auth.admin,
    auth.user,
    { ...ticketMeta, reason: 'invalid_runpod_response', has_assets: extractImages(upstreamPayload) },
    finalUsageId,
    ticketCost,
    corsHeaders,
  )
  if ('response' in refund) return refund.response
  const nextTickets = Number((refund as { ticketsLeft?: unknown }).ticketsLeft)
  return jsonResponse(
    { error: INTERNAL_ERROR_MESSAGE, ticketsLeft: Number.isFinite(nextTickets) ? nextTickets : ticketsLeft },
    502,
    corsHeaders,
  )
}
