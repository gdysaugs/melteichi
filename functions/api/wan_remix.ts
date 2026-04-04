import workflowI2VTemplate from './wan-remix-workflow-i2v.json'
import workflowT2VTemplate from './wan-remix-workflow-t2v.json'
import nodeMapI2VTemplate from './wan-remix-node-map-i2v.json'
import nodeMapT2VTemplate from './wan-remix-node-map-t2v.json'
import workflowRapidI2VTemplate from './wan-rapid-workflow-i2v.json'
import workflowRapidFastmoveI2VTemplate from './wan-rapid-fastmove-workflow-i2v.json'
import workflowSmoothmixI2VTemplate from './wan-smoothmix-workflow-i2v.json'
import nodeMapRapidI2VTemplate from './wan-rapid-node-map-i2v.json'
import nodeMapSmoothmixI2VTemplate from './wan-smoothmix-node-map-i2v.json'
import { createClient, type User } from '@supabase/supabase-js'
import { buildCorsHeaders, isCorsBlocked } from '../_shared/cors'
import { isUnderageImage } from '../_shared/rekognition'

type Env = {
  RUNPOD_API_KEY: string
  RUNPOD_API_KEY_I2V4?: string
  RUNPOD_ENDPOINT_URL?: string
  RUNPOD_WAN_ENDPOINT_URL?: string
  RUNPOD_WAN_REMIX_ENDPOINT_URL?: string
  COMFY_ORG_API_KEY?: string
  AWS_ACCESS_KEY_ID?: string
  AWS_SECRET_ACCESS_KEY?: string
  AWS_REGION?: string
  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
}

const corsMethods = 'POST, GET, OPTIONS'

const jsonResponse = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  })

const INTERNAL_ERROR_MESSAGE = 'エラーです。やり直してください。'
const internalErrorResponse = (corsHeaders: HeadersInit) =>
  jsonResponse({ error: INTERNAL_ERROR_MESSAGE }, 500, corsHeaders)

const resolveEndpoint = (env: Env) =>
  (env.RUNPOD_WAN_REMIX_ENDPOINT_URL ?? env.RUNPOD_WAN_ENDPOINT_URL ?? env.RUNPOD_ENDPOINT_URL)?.replace(/\/$/, '')

const resolveRunpodApiKey = (env: Env) =>
  (env.RUNPOD_API_KEY_I2V4 ?? env.RUNPOD_API_KEY ?? '').trim()

const ENDPOINT_MISSING_MESSAGE = 'サーバー設定エラーです。しばらくして再度お試しください。'

const getEndpointMissingMessage = (request: Request) => {
  try {
    const path = new URL(request.url).pathname.toLowerCase()
    if (path.includes('/api/wan-smoothmix')) {
      return ENDPOINT_MISSING_MESSAGE
    }
    if (path.includes('/api/wan-rapid-fastmove')) {
      return ENDPOINT_MISSING_MESSAGE
    }
    if (path.includes('/api/wan-rapid')) {
      return ENDPOINT_MISSING_MESSAGE
    }
  } catch {
    // fall through
  }
  return ENDPOINT_MISSING_MESSAGE
}

type NodeMapEntry = {
  id: string
  input: string
}

type NodeMapValue = NodeMapEntry | NodeMapEntry[]

type NodeMap = Partial<{
  image: NodeMapValue
  prompt: NodeMapValue
  negative_prompt: NodeMapValue
  seed: NodeMapValue
  steps: NodeMapValue
  cfg: NodeMapValue
  width: NodeMapValue
  height: NodeMapValue
  num_frames: NodeMapValue
  fps: NodeMapValue
  start_step: NodeMapValue
  end_step: NodeMapValue
}>

const SIGNUP_TICKET_GRANT = 3
const LOW_QUALITY_TICKET_COST = 0
const MEDIUM_QUALITY_TICKET_COST = 1
const HIGH_QUALITY_TICKET_COST = 2
const SHORT_DURATION_TICKET_COST = 1
const MEDIUM_DURATION_TICKET_COST = 2
const LONG_DURATION_TICKET_COST = 3
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_PROMPT_LENGTH = 1000
const MAX_NEGATIVE_PROMPT_LENGTH = 1000
const FIXED_STEPS = 4
const RAPID_I2V_FIXED_STEPS = 4
const SMOOTHMIX_I2V_FIXED_STEPS = 6
const RAPID_FASTMOVE_I2V_FIXED_STEPS = 4
const MIN_DIMENSION = 256
const MAX_DIMENSION = 3000
const MIN_CFG = 0
const MAX_CFG = 10
const LOW_QUALITY_FPS = 8
const MEDIUM_QUALITY_FPS = 10
const HIGH_QUALITY_FPS = 12
const ALLOWED_FPS = [LOW_QUALITY_FPS, MEDIUM_QUALITY_FPS, HIGH_QUALITY_FPS] as const
const DEFAULT_FPS = MEDIUM_QUALITY_FPS
const DEFAULT_SECONDS = 6
const ALLOWED_SECONDS = [6, 8, 10] as const
const FIXED_SIZE_MULTIPLE = 64
const FIXED_MAX_LONG_SIDE = 768
const DEFAULT_WIDTH = 768
const DEFAULT_HEIGHT = 448
const UNDERAGE_BLOCK_MESSAGE =
  'この画像には暴力的な表現、低年齢、または規約違反の可能性があります。別の画像でお試しください。'

type WorkflowFlavor = 'rapid' | 'rapid_fastmove' | 'smoothmix' | 'remix'

const resolveWorkflowFlavor = (request: Request): WorkflowFlavor => {
  try {
    const path = new URL(request.url).pathname.toLowerCase()
    if (path.includes('/api/wan-smoothmix')) return 'smoothmix'
    if (path.includes('/api/wan-rapid-fastmove')) return 'rapid_fastmove'
    if (path.includes('/api/wan-rapid')) return 'rapid'
  } catch {
    // fall through
  }
  return 'remix'
}

const getWorkflowTemplate = async (mode: 'i2v' | 't2v', flavor: WorkflowFlavor) => {
  if (mode === 't2v') return workflowT2VTemplate as Record<string, unknown>
  if (flavor === 'smoothmix') return workflowSmoothmixI2VTemplate as Record<string, unknown>
  if (flavor === 'rapid') return workflowRapidI2VTemplate as Record<string, unknown>
  if (flavor === 'rapid_fastmove') return workflowRapidFastmoveI2VTemplate as Record<string, unknown>
  return workflowI2VTemplate as Record<string, unknown>
}

const getNodeMap = async (mode: 'i2v' | 't2v', flavor: WorkflowFlavor) => {
  if (mode === 't2v') return nodeMapT2VTemplate as NodeMap
  if (flavor === 'smoothmix') return nodeMapSmoothmixI2VTemplate as NodeMap
  if (flavor === 'rapid') return nodeMapRapidI2VTemplate as NodeMap
  if (flavor === 'rapid_fastmove') return nodeMapI2VTemplate as NodeMap
  return nodeMapI2VTemplate as NodeMap
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

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
  if (!token) {
    return { response: jsonResponse({ error: 'ログインが必要です。' }, 401, corsHeaders) }
  }
  const admin = getSupabaseAdmin(env)
  if (!admin) {
    return {
      response: jsonResponse(
        { error: 'SUPABASE_URL または SUPABASE_SERVICE_ROLE_KEY が設定されていません。' },
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

const makeUsageId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

const fetchTicketRow = async (
  admin: ReturnType<typeof createClient>,
  user: User,
) => {
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

const ensureTicketRow = async (
  admin: ReturnType<typeof createClient>,
  user: User,
) => {
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

  const grantUsageId = makeUsageId()
  await admin.from('ticket_events').insert({
    usage_id: grantUsageId,
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
  requiredTickets = 1,
  corsHeaders: HeadersInit = {},
) => {
  const email = user.email
  if (!email) {
    return { response: jsonResponse({ error: 'Email not available.' }, 400, corsHeaders) }
  }

  const { data: existing, error } = await ensureTicketRow(admin, user)

  if (error) {
    return { response: internalErrorResponse(corsHeaders) }
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
  usageId?: string,
  ticketCost = 1,
  corsHeaders: HeadersInit = {},
) => {
  const cost = Math.max(1, Math.floor(ticketCost))
  const email = user.email
  if (!email) {
    return { response: jsonResponse({ error: 'Email not available.' }, 400, corsHeaders) }
  }

  const { data: existing, error } = await fetchTicketRow(admin, user)

  if (error) {
    return { response: internalErrorResponse(corsHeaders) }
  }

  if (!existing) {
    return { response: jsonResponse({ error: 'No tickets available.' }, 402, corsHeaders) }
  }

  if (!existing.user_id) {
    await admin.from('user_tickets').update({ user_id: user.id }).eq('id', existing.id)
  }

  const resolvedUsageId = usageId ?? makeUsageId()
  const { data: rpcData, error: rpcError } = await admin.rpc('consume_tickets', {
    p_ticket_id: existing.id,
    p_usage_id: resolvedUsageId,
    p_cost: cost,
    p_reason: 'generate_video',
    p_metadata: metadata,
  })

  if (rpcError) {
    const message = rpcError.message ?? 'Failed to update tickets.'
    if (message.includes('INSUFFICIENT_TICKETS')) {
      return { response: jsonResponse({ error: 'No tickets remaining.' }, 402, corsHeaders) }
    }
    if (message.includes('INVALID')) {
      return { response: jsonResponse({ error: 'Invalid ticket request.' }, 400, corsHeaders) }
    }
    return { response: internalErrorResponse(corsHeaders) }
  }

  const result = Array.isArray(rpcData) ? rpcData[0] : rpcData
  const ticketsLeft = Number(result?.tickets_left)
  const alreadyConsumed = Boolean(result?.already_consumed)
  return {
    ticketsLeft: Number.isFinite(ticketsLeft) ? ticketsLeft : undefined,
    alreadyConsumed,
  }
}

const refundTicket = async (
  admin: ReturnType<typeof createClient>,
  user: User,
  metadata: Record<string, unknown>,
  usageId?: string,
  ticketCost = 1,
  corsHeaders: HeadersInit = {},
) => {
  const refundAmount = Math.max(1, Math.floor(ticketCost))
  const email = user.email
  if (!email || !usageId) {
    return { skipped: true }
  }

  const { data: chargeEvent, error: chargeError } = await admin
    .from('ticket_events')
    .select('usage_id, user_id, email')
    .eq('usage_id', usageId)
    .maybeSingle()

  if (chargeError) {
    return { response: internalErrorResponse(corsHeaders) }
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
    return { response: internalErrorResponse(corsHeaders) }
  }

  if (existingRefund) {
    return { alreadyRefunded: true }
  }

  const { data: existing, error } = await ensureTicketRow(admin, user)

  if (error) {
    return { response: internalErrorResponse(corsHeaders) }
  }

  if (!existing) {
    return { response: jsonResponse({ error: 'No tickets available.' }, 402, corsHeaders) }
  }

  if (!existing.user_id) {
    await admin.from('user_tickets').update({ user_id: user.id }).eq('id', existing.id)
  }

  const { data: rpcData, error: rpcError } = await admin.rpc('refund_tickets', {
    p_ticket_id: existing.id,
    p_usage_id: refundUsageId,
    p_amount: refundAmount,
    p_reason: 'refund',
    p_metadata: metadata,
  })

  if (rpcError) {
    const message = rpcError.message ?? 'Failed to refund tickets.'
    if (message.includes('INVALID')) {
      return { response: jsonResponse({ error: 'Invalid ticket request.' }, 400, corsHeaders) }
    }
    return { response: internalErrorResponse(corsHeaders) }
  }

  const result = Array.isArray(rpcData) ? rpcData[0] : rpcData
  const ticketsLeft = Number(result?.tickets_left)
  const alreadyRefunded = Boolean(result?.already_refunded)
  return {
    ticketsLeft: Number.isFinite(ticketsLeft) ? ticketsLeft : undefined,
    alreadyRefunded,
  }
}

const resolveTicketCostForUsage = async (
  admin: ReturnType<typeof createClient>,
  usageId: string,
  payload: any,
) => {
  const { data, error } = await admin
    .from('ticket_events')
    .select('delta')
    .eq('usage_id', usageId)
    .maybeSingle()

  if (!error && data) {
    const delta = Number((data as { delta?: unknown }).delta)
    if (Number.isFinite(delta) && delta < 0) {
      return Math.max(1, Math.abs(Math.floor(delta)))
    }
  }

  const fps = extractFpsFromPayload(payload)
  const seconds = extractSecondsFromPayload(payload)
  return ticketCostForFps(fps) + ticketCostForSeconds(seconds)
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
    return { response: internalErrorResponse(corsHeaders) }
  }
  if (!chargeEvent) {
    return { response: jsonResponse({ error: 'Job not found.' }, 404, corsHeaders) }
  }

  const email = user.email ?? ''
  const chargeUserId = chargeEvent.user_id ? String(chargeEvent.user_id) : ''
  const chargeEmail = chargeEvent.email ? String(chargeEvent.email) : ''
  const matchesUser = Boolean(chargeUserId && chargeUserId === user.id)
  const matchesEmail = Boolean(email && chargeEmail && chargeEmail.toLowerCase() === email.toLowerCase())
  if (!matchesUser && !matchesEmail) {
    return { response: jsonResponse({ error: 'Job not found.' }, 404, corsHeaders) }
  }

  return { ok: true as const }
}

const hasOutputList = (value: unknown) => Array.isArray(value) && value.length > 0

const hasOutputString = (value: unknown) => typeof value === 'string' && value.trim() !== ''

const hasAssets = (payload: any) => {
  if (!payload || typeof payload !== 'object') return false
  const data = payload as Record<string, unknown>
  const listCandidates = [
    data.images,
    data.videos,
    data.gifs,
    data.outputs,
    data.output_images,
    data.output_videos,
    data.data,
  ]
  if (listCandidates.some(hasOutputList)) return true
  const singleCandidates = [
    data.image,
    data.video,
    data.gif,
    data.output_image,
    data.output_video,
    data.output_image_base64,
  ]
  return singleCandidates.some(hasOutputString)
}

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

const shouldConsumeTicket = (payload: any) => {
  const status = String(payload?.status ?? payload?.state ?? '').toLowerCase()
  const isFailure = status.includes('fail') || status.includes('error') || status.includes('cancel')
  const isSuccess =
    status.includes('complete') ||
    status.includes('success') ||
    status.includes('succeed') ||
    status.includes('finished')
  const hasAnyAssets =
    hasAssets(payload) ||
    hasAssets(payload?.output) ||
    hasAssets(payload?.result) ||
    hasAssets(payload?.output?.output) ||
    hasAssets(payload?.result?.output)
  if (isFailure) return false
  if (hasOutputError(payload)) return false
  return isSuccess || hasAnyAssets
}

const extractJobId = (payload: any) =>
  payload?.id || payload?.jobId || payload?.job_id || payload?.output?.id

const stripDataUrl = (value: string) => {
  const comma = value.indexOf(',')
  if (value.startsWith('data:') && comma !== -1) {
    return value.slice(comma + 1)
  }
  return value
}

const isHttpUrl = (value: string) => /^https?:\/\//i.test(value.trim())

const estimateBase64Bytes = (value: string) => {
  const trimmed = value.trim()
  const padding = trimmed.endsWith('==') ? 2 : trimmed.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding)
}

const normalizeSeconds = (value: unknown) => {
  const requested = Math.floor(Number(value))
  return ALLOWED_SECONDS.find((item) => item === requested) ?? DEFAULT_SECONDS
}

const normalizeFps = (value: unknown): (typeof ALLOWED_FPS)[number] => {
  const requested = Math.floor(Number(value))
  return ALLOWED_FPS.find((item) => item === requested) ?? DEFAULT_FPS
}

const ticketCostForFps = (fps: number) => {
  if (fps >= HIGH_QUALITY_FPS) return HIGH_QUALITY_TICKET_COST
  if (fps <= LOW_QUALITY_FPS) return LOW_QUALITY_TICKET_COST
  return MEDIUM_QUALITY_TICKET_COST
}

const ticketCostForSeconds = (seconds: number) => {
  if (seconds >= 10) return LONG_DURATION_TICKET_COST
  if (seconds >= 8) return MEDIUM_DURATION_TICKET_COST
  return SHORT_DURATION_TICKET_COST
}

const extractFpsFromPayload = (payload: any) => {
  const candidates = [
    payload?.input?.fps,
    payload?.fps,
    payload?.output?.input?.fps,
    payload?.output?.fps,
    payload?.result?.input?.fps,
    payload?.result?.fps,
    payload?.metadata?.fps,
    payload?.output?.metadata?.fps,
    payload?.result?.metadata?.fps,
  ]
  for (const value of candidates) {
    if (value === undefined || value === null) continue
    return normalizeFps(value)
  }
  return DEFAULT_FPS
}

const extractSecondsFromPayload = (payload: any) => {
  const candidates = [
    payload?.input?.seconds,
    payload?.seconds,
    payload?.output?.input?.seconds,
    payload?.output?.seconds,
    payload?.result?.input?.seconds,
    payload?.result?.seconds,
    payload?.metadata?.seconds,
    payload?.output?.metadata?.seconds,
    payload?.result?.metadata?.seconds,
  ]
  for (const value of candidates) {
    if (value === undefined || value === null) continue
    return normalizeSeconds(value)
  }
  return DEFAULT_SECONDS
}

const clampDimension = (value: number, maxLongSide: number) => {
  const rounded = Math.round(value / FIXED_SIZE_MULTIPLE) * FIXED_SIZE_MULTIPLE
  return Math.max(MIN_DIMENSION, Math.min(maxLongSide, rounded))
}

const toSafeDimensions = (width: number, height: number, maxLongSide: number) => {
  const longest = Math.max(width, height)
  const scale = longest > maxLongSide ? maxLongSide / longest : 1
  return {
    width: clampDimension(width * scale, maxLongSide),
    height: clampDimension(height * scale, maxLongSide),
  }
}

const ensureBase64Input = (label: string, value: unknown) => {
  if (typeof value !== 'string' || !value.trim()) return ''
  const trimmed = value.trim()
  if (isHttpUrl(trimmed)) {
    throw new Error(`${label} must be base64 (image_url is not allowed).`)
  }
  const base64 = stripDataUrl(trimmed)
  if (!base64) return ''
  const bytes = estimateBase64Bytes(base64)
  if (bytes > MAX_IMAGE_BYTES) {
    throw new Error(`${label} is too large.`)
  }
  return base64
}

const setInputValue = (
  workflow: Record<string, any>,
  entry: NodeMapEntry,
  value: unknown,
) => {
  const node = workflow[entry.id]
  if (!node?.inputs) {
    throw new Error(`Node ${entry.id} not found in workflow.`)
  }
  node.inputs[entry.input] = value
}

const applyNodeMap = (
  workflow: Record<string, any>,
  nodeMap: NodeMap,
  values: Record<string, unknown>,
) => {
  for (const [key, value] of Object.entries(values)) {
    const entry = nodeMap[key as keyof NodeMap]
    if (!entry || value === undefined || value === null) continue
    const entries = Array.isArray(entry) ? entry : [entry]
    for (const item of entries) {
      setInputValue(workflow, item, value)
    }
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

  const auth = await requireAuthenticatedUser(request, env, corsHeaders)
  if ('response' in auth) {
    return auth.response
  }

  const url = new URL(request.url)
  const id = url.searchParams.get('id')
  if (!id) {
    return jsonResponse({ error: 'idが必要です。' }, 400, corsHeaders)
  }
  const runpodApiKey = resolveRunpodApiKey(env)
  if (!runpodApiKey) {
    return jsonResponse({ error: 'RUNPOD API key is not set.' }, 500, corsHeaders)
  }

  const endpoint = resolveEndpoint(env)
  if (!endpoint) {
    return jsonResponse({ error: getEndpointMissingMessage(request) }, 500, corsHeaders)
  }
  const ownershipUsageId = `wan_remix:${id}`
  const ownership = await ensureUsageOwnership(auth.admin, auth.user, ownershipUsageId, corsHeaders)
  if ('response' in ownership) {
    return ownership.response
  }

  let upstream: Response
  try {
    upstream = await fetch(endpoint + '/status/' + encodeURIComponent(id), {
      headers: { Authorization: 'Bearer ' + runpodApiKey },
    })
  } catch {
    return jsonResponse({ error: 'RunPod status check failed.' }, 502, corsHeaders)
  }
  const raw = await upstream.text()
  let payload: any = null
  let ticketsLeft: number | null = null
  try {
    payload = JSON.parse(raw)
  } catch {
    payload = null
  }

  if (payload && shouldConsumeTicket(payload)) {
    const usageId = `wan_remix:${id}`
    const ticketCost = await resolveTicketCostForUsage(auth.admin, usageId, payload)
    const ticketMeta = {
      job_id: id,
      status: payload?.status ?? payload?.state ?? null,
      source: 'status',
      ticket_cost: ticketCost,
    }
    const result = await consumeTicket(auth.admin, auth.user, ticketMeta, usageId, ticketCost, corsHeaders)
    if ('response' in result) {
      return result.response
    }
    const nextTickets = Number((result as { ticketsLeft?: unknown }).ticketsLeft)
    if (Number.isFinite(nextTickets)) {
      ticketsLeft = nextTickets
    }
  }

  if (payload && (isFailureStatus(payload) || hasOutputError(payload))) {
    const usageId = `wan_remix:${id}`
    const ticketCost = await resolveTicketCostForUsage(auth.admin, usageId, payload)
    const refundMeta = {
      job_id: id,
      status: payload?.status ?? payload?.state ?? null,
      source: 'status',
      reason: 'failure',
      ticket_cost: ticketCost,
    }
    const refundResult = await refundTicket(auth.admin, auth.user, refundMeta, usageId, ticketCost, corsHeaders)
    if ('response' in refundResult) {
      return refundResult.response
    }
    const nextTickets = Number((refundResult as { ticketsLeft?: unknown }).ticketsLeft)
    if (Number.isFinite(nextTickets)) {
      ticketsLeft = nextTickets
    }
  }

  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    if (isFailureStatus(payload) || hasOutputError(payload) || !upstream.ok) {
      const status = payload?.status ?? payload?.state ?? null
      const body: Record<string, unknown> = {
        id: extractJobId(payload) ?? id,
        status,
        state: status,
        error: INTERNAL_ERROR_MESSAGE,
      }
      if (ticketsLeft !== null) {
        body.ticketsLeft = ticketsLeft
      }
      return jsonResponse(body, upstream.status, corsHeaders)
    }
    if (ticketsLeft !== null) {
      payload.ticketsLeft = ticketsLeft
    }
    return jsonResponse(payload, upstream.status, corsHeaders)
  }

  return jsonResponse({ error: INTERNAL_ERROR_MESSAGE, id }, 502, corsHeaders)
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const corsHeaders = buildCorsHeaders(request, env, corsMethods)
  if (isCorsBlocked(request, env)) {
    return new Response(null, { status: 403, headers: corsHeaders })
  }

  const auth = await requireAuthenticatedUser(request, env, corsHeaders)
  if ('response' in auth) {
    return auth.response
  }

  const runpodApiKey = resolveRunpodApiKey(env)
  if (!runpodApiKey) {
    return jsonResponse({ error: 'RUNPOD API key is not set.' }, 500, corsHeaders)
  }

  const endpoint = resolveEndpoint(env)
  if (!endpoint) {
    return jsonResponse({ error: getEndpointMissingMessage(request) }, 500, corsHeaders)
  }

  const payload = await request.json().catch(() => null)
  if (!payload) {
    return jsonResponse({ error: 'Invalid request body.' }, 400, corsHeaders)
  }

  const input = payload.input ?? payload
  if (input?.workflow) {
    return jsonResponse({ error: 'workflow overrides are not allowed.' }, 400, corsHeaders)
  }
  const mode = String(input?.mode ?? 'i2v').toLowerCase()
  if (mode !== 'i2v' && mode !== 't2v') {
    return jsonResponse({ error: 'mode must be "i2v" or "t2v".' }, 400, corsHeaders)
  }
  const isT2V = mode === 't2v'
  const workflowFlavor = resolveWorkflowFlavor(request)
  if ((workflowFlavor === 'rapid' || workflowFlavor === 'rapid_fastmove' || workflowFlavor === 'smoothmix') && isT2V) {
    return jsonResponse({ error: 'このモードは画像からの生成のみに対応しています。' }, 400, corsHeaders)
  }
  const imageValue = input?.image_base64 ?? input?.image ?? input?.image_url
  if (!isT2V && !imageValue) {
    return jsonResponse({ error: 'i2vには画像が必要です。' }, 400, corsHeaders)
  }

  let imageBase64 = ''
  try {
    if (imageValue) {
      if (typeof input?.image_url === 'string' && input.image_url) {
        throw new Error('image_url is not allowed. Use base64.')
      }
      imageBase64 = ensureBase64Input('image', imageValue)
    }
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : '画像の読み取りに失敗しました。' },
      400,
      corsHeaders,
    )
  }

  if (!isT2V && !imageBase64) {
    return jsonResponse({ error: 'image is empty.' }, 400, corsHeaders)
  }

  if (!isT2V) {
    try {
      if (await isUnderageImage(imageBase64, env)) {
        return jsonResponse({ error: UNDERAGE_BLOCK_MESSAGE }, 400, corsHeaders)
      }
    } catch (error) {
      return jsonResponse(
        { error: 'Age verification failed.' },
        500,
        corsHeaders,
      )
    }
  }

  const prompt = String(input?.prompt ?? input?.text ?? '')
  const negativePrompt = String(input?.negative_prompt ?? input?.negative ?? '')
  const steps =
    !isT2V && workflowFlavor === 'smoothmix'
      ? SMOOTHMIX_I2V_FIXED_STEPS
      : !isT2V && workflowFlavor === 'rapid'
        ? RAPID_I2V_FIXED_STEPS
      : !isT2V && workflowFlavor === 'rapid_fastmove'
        ? RAPID_FASTMOVE_I2V_FIXED_STEPS
        : FIXED_STEPS
  const cfg = 1
  const requestedWidth = Math.floor(Number(input?.width ?? DEFAULT_WIDTH))
  const requestedHeight = Math.floor(Number(input?.height ?? DEFAULT_HEIGHT))
  const seconds = normalizeSeconds(input?.seconds ?? DEFAULT_SECONDS)
  const fps = normalizeFps(input?.fps)
  const ticketCost = ticketCostForFps(fps) + ticketCostForSeconds(seconds)
  const numFrames =
    !isT2V && (workflowFlavor === 'rapid' || workflowFlavor === 'rapid_fastmove' || workflowFlavor === 'smoothmix')
      ? fps * seconds + 1
      : fps * seconds
  const seed = input?.randomize_seed
    ? Math.floor(Math.random() * 2147483647)
    : Number(input?.seed ?? 0)

  if (prompt.length > MAX_PROMPT_LENGTH) {
    return jsonResponse({ error: 'Prompt is too long.' }, 400, corsHeaders)
  }
  if (negativePrompt.length > MAX_NEGATIVE_PROMPT_LENGTH) {
    return jsonResponse({ error: 'Negative prompt is too long.' }, 400, corsHeaders)
  }
  if (!Number.isFinite(cfg) || cfg < MIN_CFG || cfg > MAX_CFG) {
    return jsonResponse({ error: `cfg must be between ${MIN_CFG} and ${MAX_CFG}.` }, 400, corsHeaders)
  }
  if (!Number.isFinite(requestedWidth) || requestedWidth < MIN_DIMENSION || requestedWidth > MAX_DIMENSION) {
    return jsonResponse(
      { error: `width must be between ${MIN_DIMENSION} and ${MAX_DIMENSION}.` },
      400,
      corsHeaders,
    )
  }
  if (!Number.isFinite(requestedHeight) || requestedHeight < MIN_DIMENSION || requestedHeight > MAX_DIMENSION) {
    return jsonResponse(
      { error: `height must be between ${MIN_DIMENSION} and ${MAX_DIMENSION}.` },
      400,
      corsHeaders,
    )
  }
  const { width, height } = toSafeDimensions(requestedWidth, requestedHeight, FIXED_MAX_LONG_SIDE)
  const totalSteps = Math.max(1, Math.floor(steps))
  const splitStep =
    !isT2V && (workflowFlavor === 'rapid' || workflowFlavor === 'smoothmix')
      ? Math.max(1, Math.floor(totalSteps / 3))
      : !isT2V && workflowFlavor === 'rapid_fastmove'
        ? Math.max(1, Math.floor(totalSteps / 2))
        : Math.max(1, Math.floor(totalSteps / 2))

  const ticketMeta = {
    prompt_length: prompt.length,
    width,
    height,
    seconds,
    frames: numFrames,
    fps,
    steps: totalSteps,
    mode,
    ticket_cost: ticketCost,
  }
  const ticketCheck = await ensureTicketAvailable(auth.admin, auth.user, ticketCost, corsHeaders)
  if ('response' in ticketCheck) {
    return ticketCheck.response
  }

  const imageName = String(input?.image_name ?? 'input.png')
  const workflow = clone(await getWorkflowTemplate(isT2V ? 't2v' : 'i2v', workflowFlavor))
  if (!workflow || Object.keys(workflow).length === 0) {
    return jsonResponse({ error: 'wan workflow is empty. Export a ComfyUI API workflow.' }, 500, corsHeaders)
  }

  const nodeMap = await getNodeMap(isT2V ? 't2v' : 'i2v', workflowFlavor).catch(() => null)
  const hasNodeMap = nodeMap && Object.keys(nodeMap).length > 0
  if (!hasNodeMap) {
    return jsonResponse({ error: 'wan node map is empty.' }, 500, corsHeaders)
  }

  const nodeValues: Record<string, unknown> = {
    image: imageBase64 ? imageName : undefined,
    prompt,
    negative_prompt: negativePrompt,
    seed,
    steps: totalSteps,
    cfg,
    width,
    height,
    num_frames: numFrames,
    fps,
    end_step: splitStep,
    start_step: splitStep,
  }
  applyNodeMap(workflow as Record<string, any>, nodeMap as NodeMap, nodeValues)

  const comfyKey = String(env.COMFY_ORG_API_KEY ?? '')
  const images = imageBase64 ? [{ name: imageName, image: imageBase64 }] : []
  const runpodInput: Record<string, unknown> = {
    workflow,
    images,
    seconds,
    ticket_cost: ticketCost,
  }
  if (comfyKey) {
    runpodInput.comfy_org_api_key = comfyKey
  }

  const upstream = await fetch(`${endpoint}/run`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${runpodApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input: runpodInput }),
  })
  const raw = await upstream.text()
  let upstreamPayload: any = null
  let ticketsLeft: number | null = null
  try {
    upstreamPayload = JSON.parse(raw)
  } catch {
    upstreamPayload = null
  }

  const jobId = extractJobId(upstreamPayload)
  const shouldCharge =
    upstream.ok && Boolean(jobId) && !isFailureStatus(upstreamPayload) && !hasOutputError(upstreamPayload)

  if (shouldCharge && jobId) {
    const usageId = `wan_remix:${jobId}`
    const ticketMetaWithJob = {
      ...ticketMeta,
      job_id: jobId,
      status: upstreamPayload?.status ?? upstreamPayload?.state ?? null,
      source: 'run',
    }
    const result = await consumeTicket(auth.admin, auth.user, ticketMetaWithJob, usageId, ticketCost, corsHeaders)
    if ('response' in result) {
      return result.response
    }
    const nextTickets = Number((result as { ticketsLeft?: unknown }).ticketsLeft)
    if (Number.isFinite(nextTickets)) {
      ticketsLeft = nextTickets
    }
  } else if (upstreamPayload && shouldConsumeTicket(upstreamPayload)) {
    const jobId = extractJobId(upstreamPayload)
    const usageId = jobId ? `wan_remix:${jobId}` : undefined
    const ticketMetaWithJob = {
      ...ticketMeta,
      job_id: jobId ?? undefined,
      status: upstreamPayload?.status ?? upstreamPayload?.state ?? null,
      source: 'run',
    }
    const result = await consumeTicket(auth.admin, auth.user, ticketMetaWithJob, usageId, ticketCost, corsHeaders)
    if ('response' in result) {
      return result.response
    }
    const nextTickets = Number((result as { ticketsLeft?: unknown }).ticketsLeft)
    if (Number.isFinite(nextTickets)) {
      ticketsLeft = nextTickets
    }
  }

  if (upstreamPayload && typeof upstreamPayload === 'object' && !Array.isArray(upstreamPayload)) {
    if (isFailureStatus(upstreamPayload) || hasOutputError(upstreamPayload) || !upstream.ok) {
      const status = upstreamPayload?.status ?? upstreamPayload?.state ?? null
      const body: Record<string, unknown> = {
        id: extractJobId(upstreamPayload) ?? jobId ?? null,
        status,
        state: status,
        error: INTERNAL_ERROR_MESSAGE,
      }
      if (ticketsLeft !== null) {
        body.ticketsLeft = ticketsLeft
      }
      return jsonResponse(body, upstream.status, corsHeaders)
    }
    if (ticketsLeft !== null) {
      upstreamPayload.ticketsLeft = ticketsLeft
    }
    return jsonResponse(upstreamPayload, upstream.status, corsHeaders)
  }

  return jsonResponse({ error: INTERNAL_ERROR_MESSAGE }, 502, corsHeaders)
}
