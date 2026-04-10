import workflowTemplate from './qwen-workflow.json'
import nodeMapTemplate from './qwen-node-map.json'
import { createClient, type User } from '@supabase/supabase-js'
import { buildCorsHeaders, isCorsBlocked } from '../_shared/cors'
import { isUnderageImage } from '../_shared/rekognition'

type Env = {
  RUNPOD_API_KEY: string
  RUNPOD_I2I_ENDPOINT_URL?: string
  RUNPOD_QWEN_ENDPOINT_URL?: string
  RUNPOD_ENDPOINT_URL?: string
  COMFY_ORG_API_KEY?: string
  RUNPOD_WORKER_MODE?: string
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

const normalizeEndpoint = (value?: string) => {
  if (!value) return ''
  const trimmed = value.trim().replace(/^['"]|['"]$/g, '')
  if (!trimmed) return ''
  const normalized = trimmed.replace(/\/+$/, '')
  try {
    const parsed = new URL(normalized)
    if (!/^https?:$/.test(parsed.protocol)) return ''
    return normalized
  } catch {
    return ''
  }
}

const resolveEndpoint = (env: Env) =>
  normalizeEndpoint(env.RUNPOD_I2I_ENDPOINT_URL) ||
  normalizeEndpoint(env.RUNPOD_QWEN_ENDPOINT_URL) ||
  normalizeEndpoint(env.RUNPOD_ENDPOINT_URL)

type NodeMapEntry = {
  id: string
  input: string
}

type NodeMapValue = NodeMapEntry | NodeMapEntry[]

type NodeMap = Partial<{
  image: NodeMapValue
  image2: NodeMapValue
  prompt: NodeMapValue
  negative_prompt: NodeMapValue
  seed: NodeMapValue
  steps: NodeMapValue
  cfg: NodeMapValue
  width: NodeMapValue
  height: NodeMapValue
  angle_strength: NodeMapValue
}>

const SIGNUP_TICKET_GRANT = 5
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_PROMPT_LENGTH = 500
const MAX_NEGATIVE_PROMPT_LENGTH = 500
const FIXED_STEPS = 4
const MIN_DIMENSION = 256
const MAX_DIMENSION = 3000
const MIN_GUIDANCE = 0
const MAX_GUIDANCE = 10
const MIN_ANGLE_STRENGTH = 0
const MAX_ANGLE_STRENGTH = 1
const INTERNAL_SERVER_ERROR_MESSAGE = '\u30b5\u30fc\u30d0\u30fc\u5185\u90e8\u30a8\u30e9\u30fc\u304c\u767a\u751f\u3057\u307e\u3057\u305f\u3002\u6642\u9593\u3092\u304a\u3044\u3066\u518d\u5ea6\u304a\u8a66\u3057\u304f\u3060\u3055\u3044\u3002'
const INTERNAL_ERROR_DETAIL = 'internal_error'
const ERROR_LOGIN_REQUIRED = '\u30ed\u30b0\u30a4\u30f3\u304c\u5fc5\u8981\u3067\u3059\u3002'
const ERROR_AUTH_FAILED = '\u8a8d\u8a3c\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002'
const ERROR_GOOGLE_ONLY = 'Google\u30ed\u30b0\u30a4\u30f3\u306e\u307f\u5bfe\u5fdc\u3057\u3066\u3044\u307e\u3059\u3002'
const ERROR_SUPABASE_NOT_SET =
  'SUPABASE_URL \u307e\u305f\u306f SUPABASE_SERVICE_ROLE_KEY \u304c\u8a2d\u5b9a\u3055\u308c\u3066\u3044\u307e\u305b\u3093\u3002'
const ERROR_EMAIL_MISSING = '\u30e1\u30fc\u30eb\u30a2\u30c9\u30ec\u30b9\u304c\u53d6\u5f97\u3067\u304d\u307e\u305b\u3093\u3002'
const ERROR_NO_TICKETS = '\u30c8\u30fc\u30af\u30f3\u304c\u4e0d\u8db3\u3057\u3066\u3044\u307e\u3059\u3002'
const ERROR_INVALID_TICKET_REQUEST = '\u4e0d\u6b63\u306a\u30c8\u30fc\u30af\u30f3\u64cd\u4f5c\u3067\u3059\u3002'
const ERROR_ID_REQUIRED = 'id\u304c\u5fc5\u8981\u3067\u3059\u3002'
const ERROR_USAGE_ID_REQUIRED = 'usage_id\u304c\u5fc5\u8981\u3067\u3059\u3002'
const ERROR_JOB_NOT_FOUND = 'Job not found.'
const ERROR_IMAGE_READ_FAILED =
  '\u753b\u50cf\u306e\u8aad\u307f\u53d6\u308a\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002\u753b\u50cf\u3092\u78ba\u8a8d\u3057\u3066\u518d\u5ea6\u304a\u8a66\u3057\u304f\u3060\u3055\u3044\u3002'
const ERROR_IMAGE_REQUIRED = '\u753b\u50cf\u304c\u5fc5\u8981\u3067\u3059\u3002'
const UNDERAGE_BLOCK_MESSAGE =
  '\u3053\u306e\u753b\u50cf\u306b\u306f\u66b4\u529b\u7684\u306a\u8868\u73fe\u3001\u4f4e\u5e74\u9f62\u3001\u307e\u305f\u306f\u898f\u7d04\u9055\u53cd\u306e\u53ef\u80fd\u6027\u304c\u3042\u308a\u307e\u3059\u3002\u5225\u306e\u753b\u50cf\u3067\u304a\u8a66\u3057\u304f\u3060\u3055\u3044\u3002'
const getWorkflowTemplate = async () => workflowTemplate as Record<string, unknown>

const getNodeMap = async () => nodeMapTemplate as NodeMap

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const parseTicketMetadata = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

type TicketEventRow = {
  usage_id: string
  user_id: string | null
  email: string | null
  delta: number | null
  metadata: Record<string, unknown> | null
}

const normalizeEmail = (value: string | null | undefined) => (value ?? '').trim().toLowerCase()

const isUsageOwnedByUser = (
  event: Pick<TicketEventRow, 'user_id' | 'email'>,
  user: User,
) => {
  if (event.user_id && event.user_id === user.id) return true
  const userEmail = normalizeEmail(user.email ?? '')
  return Boolean(userEmail && normalizeEmail(event.email) === userEmail)
}

const fetchUsageEvent = async (
  admin: ReturnType<typeof createClient>,
  usageId: string,
) => {
  const { data, error } = await admin
    .from('ticket_events')
    .select('usage_id, user_id, email, delta, metadata')
    .eq('usage_id', usageId)
    .maybeSingle()

  if (error || !data) {
    return { event: null as TicketEventRow | null, error }
  }

  return {
    event: {
      usage_id: String(data.usage_id),
      user_id: data.user_id ? String(data.user_id) : null,
      email: data.email ? String(data.email) : null,
      delta: Number.isFinite(Number(data.delta)) ? Number(data.delta) : null,
      metadata: parseTicketMetadata(data.metadata),
    } satisfies TicketEventRow,
    error: null,
  }
}

const requireOwnedUsageChargeEvent = async (
  admin: ReturnType<typeof createClient>,
  user: User,
  usageId: string,
  corsHeaders: HeadersInit,
) => {
  const { event, error } = await fetchUsageEvent(admin, usageId)
  if (error) {
    return { response: jsonResponse({ error: INTERNAL_SERVER_ERROR_MESSAGE }, 500, corsHeaders) }
  }
  if (!event || !isUsageOwnedByUser(event, user) || Number(event.delta) >= 0) {
    return { response: jsonResponse({ error: ERROR_JOB_NOT_FOUND }, 404, corsHeaders) }
  }
  return { event }
}

const bindUsageToJob = async (
  admin: ReturnType<typeof createClient>,
  user: User,
  usageId: string,
  jobId: string | null,
) => {
  if (!jobId) return
  const usageEvent = await fetchUsageEvent(admin, usageId)
  if (usageEvent.error || !usageEvent.event || !isUsageOwnedByUser(usageEvent.event, user)) {
    return
  }
  const metadata = usageEvent.event.metadata ?? {}
  if (String(metadata.job_id ?? '') === jobId) return
  await admin
    .from('ticket_events')
    .update({ metadata: { ...metadata, job_id: jobId } })
    .eq('usage_id', usageId)
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
  corsHeaders: HeadersInit,
) => {
  const email = user.email
  if (!email) {
    return { response: jsonResponse({ error: ERROR_EMAIL_MISSING }, 400, corsHeaders) }
  }

  const { data: existing, error } = await ensureTicketRow(admin, user)

  if (error) {
    return { response: jsonResponse({ error: INTERNAL_SERVER_ERROR_MESSAGE }, 500, corsHeaders) }
  }

  if (!existing) {
    return { response: jsonResponse({ error: ERROR_NO_TICKETS }, 402, corsHeaders) }
  }

  if (!existing.user_id) {
    await admin.from('user_tickets').update({ user_id: user.id }).eq('id', existing.id)
  }

  if (existing.tickets < 1) {
    return { response: jsonResponse({ error: ERROR_NO_TICKETS }, 402, corsHeaders) }
  }

  return { existing }
}

const consumeTicket = async (
  admin: ReturnType<typeof createClient>,
  user: User,
  metadata: Record<string, unknown>,
  usageId: string | undefined,
  corsHeaders: HeadersInit,
) => {
  const email = user.email
  if (!email) {
    return { response: jsonResponse({ error: ERROR_EMAIL_MISSING }, 400, corsHeaders) }
  }

  const { data: existing, error } = await ensureTicketRow(admin, user)

  if (error) {
    return { response: jsonResponse({ error: INTERNAL_SERVER_ERROR_MESSAGE }, 500, corsHeaders) }
  }

  if (!existing) {
    return { response: jsonResponse({ error: ERROR_NO_TICKETS }, 402, corsHeaders) }
  }

  if (!existing.user_id) {
    await admin.from('user_tickets').update({ user_id: user.id }).eq('id', existing.id)
  }

  if (existing.tickets < 1) {
    return { response: jsonResponse({ error: ERROR_NO_TICKETS }, 402, corsHeaders) }
  }

  const resolvedUsageId = usageId ?? makeUsageId()
  const { data: rpcData, error: rpcError } = await admin.rpc('consume_tickets', {
    p_ticket_id: existing.id,
    p_usage_id: resolvedUsageId,
    p_cost: 1,
    p_reason: 'generate',
    p_metadata: metadata,
  })

  if (rpcError) {
    const message = rpcError.message ?? INTERNAL_SERVER_ERROR_MESSAGE
    if (message.includes('INSUFFICIENT_TICKETS')) {
      return { response: jsonResponse({ error: ERROR_NO_TICKETS }, 402, corsHeaders) }
    }
    if (message.includes('INVALID')) {
      return { response: jsonResponse({ error: ERROR_INVALID_TICKET_REQUEST }, 400, corsHeaders) }
    }
    return { response: jsonResponse({ error: INTERNAL_SERVER_ERROR_MESSAGE }, 500, corsHeaders) }
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
  usageId: string | undefined,
  corsHeaders: HeadersInit,
) => {
  const email = user.email
  if (!email || !usageId) {
    return { skipped: true }
  }

  const { data: chargeEvent, error: chargeError } = await admin
    .from('ticket_events')
    .select('usage_id, user_id, email, delta')
    .eq('usage_id', usageId)
    .maybeSingle()

  if (chargeError) {
    return { response: jsonResponse({ error: INTERNAL_SERVER_ERROR_MESSAGE }, 500, corsHeaders) }
  }

  if (!chargeEvent) {
    return { skipped: true }
  }

  const chargeDelta = Number((chargeEvent as { delta?: unknown }).delta)
  const chargeOwner = {
    user_id: (chargeEvent as { user_id?: unknown }).user_id ? String((chargeEvent as { user_id?: unknown }).user_id) : null,
    email: (chargeEvent as { email?: unknown }).email ? String((chargeEvent as { email?: unknown }).email) : null,
  }
  if (!Number.isFinite(chargeDelta) || chargeDelta >= 0 || !isUsageOwnedByUser(chargeOwner, user)) {
    return { skipped: true }
  }

  const refundUsageId = `${usageId}:refund`
  const { data: existingRefund, error: refundCheckError } = await admin
    .from('ticket_events')
    .select('usage_id')
    .eq('usage_id', refundUsageId)
    .maybeSingle()

  if (refundCheckError) {
    return { response: jsonResponse({ error: INTERNAL_SERVER_ERROR_MESSAGE }, 500, corsHeaders) }
  }

  if (existingRefund) {
    return { alreadyRefunded: true }
  }

  const { data: existing, error } = await ensureTicketRow(admin, user)

  if (error) {
    return { response: jsonResponse({ error: INTERNAL_SERVER_ERROR_MESSAGE }, 500, corsHeaders) }
  }

  if (!existing) {
    return { response: jsonResponse({ error: ERROR_NO_TICKETS }, 402, corsHeaders) }
  }

  if (!existing.user_id) {
    await admin.from('user_tickets').update({ user_id: user.id }).eq('id', existing.id)
  }

  const { data: rpcData, error: rpcError } = await admin.rpc('refund_tickets', {
    p_ticket_id: existing.id,
    p_usage_id: refundUsageId,
    p_amount: 1,
    p_reason: 'refund',
    p_metadata: metadata,
  })

  if (rpcError) {
    const message = rpcError.message ?? INTERNAL_SERVER_ERROR_MESSAGE
    if (message.includes('INVALID')) {
      return { response: jsonResponse({ error: ERROR_INVALID_TICKET_REQUEST }, 400, corsHeaders) }
    }
    return { response: jsonResponse({ error: INTERNAL_SERVER_ERROR_MESSAGE }, 500, corsHeaders) }
  }

  const result = Array.isArray(rpcData) ? rpcData[0] : rpcData
  const ticketsLeft = Number(result?.tickets_left)
  const alreadyRefunded = Boolean(result?.already_refunded)
  return {
    ticketsLeft: Number.isFinite(ticketsLeft) ? ticketsLeft : undefined,
    alreadyRefunded,
  }
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

const pickInputValue = (input: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = input[key]
    if (value !== undefined && value !== null && value !== '') {
      return value
    }
  }
  return undefined
}

const resolveImageBase64 = async (
  input: Record<string, unknown>,
  valueKeys: string[],
  urlKeys: string[],
  label: string,
) => {
  const urlValue = pickInputValue(input, urlKeys)
  if (typeof urlValue === 'string' && urlValue) {
    throw new Error(`${label} must be base64 (image_url is not allowed).`)
  }
  const value = pickInputValue(input, valueKeys)
  if (!value) return ''
  return ensureBase64Input(label, value)
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
  try {

  const auth = await requireGoogleUser(request, env, corsHeaders)
  if ('response' in auth) {
    return auth.response
  }

  const url = new URL(request.url)
  const id = url.searchParams.get('id')
  const usageId = url.searchParams.get('usage_id') ?? url.searchParams.get('usageId') ?? ''
  if (!id) {
    return jsonResponse({ error: ERROR_ID_REQUIRED }, 400, corsHeaders)
  }
  if (!usageId) {
    return jsonResponse({ error: ERROR_USAGE_ID_REQUIRED }, 400, corsHeaders)
  }
  const usageEventResult = await requireOwnedUsageChargeEvent(auth.admin, auth.user, usageId, corsHeaders)
  if ('response' in usageEventResult) {
    return usageEventResult.response
  }
  const usageJobId = String(usageEventResult.event.metadata?.job_id ?? '')
  if (!usageJobId || usageJobId !== id) {
    return jsonResponse({ error: ERROR_JOB_NOT_FOUND }, 404, corsHeaders)
  }
  if (!env.RUNPOD_API_KEY) {
    return jsonResponse({ error: 'RUNPOD_API_KEY is not set.' }, 500, corsHeaders)
  }

  const endpoint = resolveEndpoint(env)
  if (!endpoint) {
    return jsonResponse(
      { error: 'RUNPOD_I2I_ENDPOINT_URL, RUNPOD_QWEN_ENDPOINT_URL, or RUNPOD_ENDPOINT_URL is invalid or missing.' },
      500,
      corsHeaders,
    )
  }
  let upstream: Response
  try {
    upstream = await fetch(`${endpoint}/status/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${env.RUNPOD_API_KEY}` },
    })
  } catch (error) {
    return jsonResponse(
      {
        error: 'RunPod status request failed.',
        detail: INTERNAL_ERROR_DETAIL,
      },
      502,
      corsHeaders,
    )
  }
  const raw = await upstream.text()
  let payload: any = null
  let ticketsLeft: number | null = null
  try {
    payload = JSON.parse(raw)
  } catch {
    payload = null
  }

  if (payload && (isFailureStatus(payload) || hasOutputError(payload))) {
    const ticketMeta = {
      job_id: id,
      status: payload?.status ?? payload?.state ?? null,
      source: 'status',
      reason: 'failure',
    }
    const refundResult = await refundTicket(auth.admin, auth.user, ticketMeta, usageId, corsHeaders)
    const nextTickets = Number((refundResult as { ticketsLeft?: unknown }).ticketsLeft)
    if (Number.isFinite(nextTickets)) {
      ticketsLeft = nextTickets
    }
  }

  if (ticketsLeft !== null && payload && typeof payload === 'object' && !Array.isArray(payload)) {
    payload.ticketsLeft = ticketsLeft
    payload.usage_id = usageId
    return jsonResponse(payload, upstream.status, corsHeaders)
  }

  return new Response(raw, {
    status: upstream.status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
  } catch (error) {
    return jsonResponse(
      {
        error: 'Unexpected error in qwen status.',
        detail: INTERNAL_ERROR_DETAIL,
      },
      500,
      corsHeaders,
    )
  }
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const corsHeaders = buildCorsHeaders(request, env, corsMethods)
  if (isCorsBlocked(request, env)) {
    return new Response(null, { status: 403, headers: corsHeaders })
  }
  try {

  const auth = await requireGoogleUser(request, env, corsHeaders)
  if ('response' in auth) {
    return auth.response
  }

  if (!env.RUNPOD_API_KEY) {
    return jsonResponse({ error: 'RUNPOD_API_KEY is not set.' }, 500, corsHeaders)
  }

  const endpoint = resolveEndpoint(env)
  if (!endpoint) {
    return jsonResponse(
      { error: 'RUNPOD_I2I_ENDPOINT_URL, RUNPOD_QWEN_ENDPOINT_URL, or RUNPOD_ENDPOINT_URL is invalid or missing.' },
      500,
      corsHeaders,
    )
  }

  const payload = await request.json().catch(() => null)
  if (!payload) {
    return jsonResponse({ error: 'Invalid request body.' }, 400, corsHeaders)
  }

  const input = payload.input ?? payload
  const safeInput = typeof input === 'object' && input ? (input as Record<string, unknown>) : {}
  let imageBase64 = ''
  let subImageBase64Raw = ''
  try {
    imageBase64 = await resolveImageBase64(
      safeInput,
      ['image_base64', 'image', 'image_base64_1', 'image1'],
      ['image_url'],
      'image',
    )
    subImageBase64Raw = await resolveImageBase64(
      safeInput,
      ['sub_image_base64', 'sub_image', 'image2', 'image2_base64', 'image_base64_2'],
      ['sub_image_url', 'image2_url', 'image_url_2'],
      'sub_image',
    )
  } catch (error) {
    return jsonResponse({ error: ERROR_IMAGE_READ_FAILED }, 400, corsHeaders)
  }

  if (!imageBase64) {
    return jsonResponse({ error: ERROR_IMAGE_REQUIRED }, 400, corsHeaders)
  }

  const subImageBase64 = subImageBase64Raw || imageBase64

  try {
    if (await isUnderageImage(imageBase64, env)) {
      return jsonResponse({ error: UNDERAGE_BLOCK_MESSAGE }, 400, corsHeaders)
    }
    if (
      subImageBase64Raw &&
      subImageBase64 &&
      subImageBase64 !== imageBase64 &&
      (await isUnderageImage(subImageBase64, env))
    ) {
      return jsonResponse({ error: UNDERAGE_BLOCK_MESSAGE }, 400, corsHeaders)
    }
  } catch (error) {
    return jsonResponse(
      { error: INTERNAL_SERVER_ERROR_MESSAGE },
      500,
      corsHeaders,
    )
  }

  const prompt = String(input?.prompt ?? input?.text ?? '')
  const negativePrompt = String(input?.negative_prompt ?? input?.negative ?? '')
  const steps = FIXED_STEPS
  const guidanceScale = Number(input?.guidance_scale ?? input?.cfg ?? 1)
  const width = Math.floor(Number(input?.width ?? 768))
  const height = Math.floor(Number(input?.height ?? 768))
  const angleStrengthInput = input?.angle_strength ?? input?.multiangle_strength ?? undefined
  const angleStrength =
    angleStrengthInput === undefined || angleStrengthInput === null ? 0 : Number(angleStrengthInput)
  const workerMode = String(input?.worker_mode ?? input?.mode ?? env.RUNPOD_WORKER_MODE ?? '').toLowerCase()
  const useComfyUi = workerMode === 'comfyui'

  if (prompt.length > MAX_PROMPT_LENGTH) {
    return jsonResponse({ error: 'Prompt is too long.' }, 400, corsHeaders)
  }
  if (negativePrompt.length > MAX_NEGATIVE_PROMPT_LENGTH) {
    return jsonResponse({ error: 'Negative prompt is too long.' }, 400, corsHeaders)
  }
  if (!Number.isFinite(guidanceScale) || guidanceScale < MIN_GUIDANCE || guidanceScale > MAX_GUIDANCE) {
    return jsonResponse(
      { error: `guidance_scale must be between ${MIN_GUIDANCE} and ${MAX_GUIDANCE}.` },
      400,
      corsHeaders,
    )
  }
  if (!Number.isFinite(width) || width < MIN_DIMENSION || width > MAX_DIMENSION) {
    return jsonResponse(
      { error: `width must be between ${MIN_DIMENSION} and ${MAX_DIMENSION}.` },
      400,
      corsHeaders,
    )
  }
  if (!Number.isFinite(height) || height < MIN_DIMENSION || height > MAX_DIMENSION) {
    return jsonResponse(
      { error: `height must be between ${MIN_DIMENSION} and ${MAX_DIMENSION}.` },
      400,
      corsHeaders,
    )
  }
  if (!Number.isFinite(angleStrength) || angleStrength < MIN_ANGLE_STRENGTH || angleStrength > MAX_ANGLE_STRENGTH) {
    return jsonResponse(
      { error: `angle_strength must be between ${MIN_ANGLE_STRENGTH} and ${MAX_ANGLE_STRENGTH}.` },
      400,
      corsHeaders,
    )
  }

  if (safeInput?.workflow) {
    return jsonResponse({ error: 'workflow overrides are not allowed.' }, 400, corsHeaders)
  }

  const ticketMeta = {
    prompt_length: prompt.length,
    width,
    height,
    steps,
    mode: useComfyUi ? 'comfyui' : 'runpod',
  }
  const ticketCheck = await ensureTicketAvailable(auth.admin, auth.user, corsHeaders)
  if ('response' in ticketCheck) {
    return ticketCheck.response
  }

  let workflow: Record<string, unknown> | null = null
  let nodeMap: NodeMap | null = null
  if (useComfyUi) {
    workflow = clone(await getWorkflowTemplate())
    if (!workflow || Object.keys(workflow).length === 0) {
      return jsonResponse({ error: 'workflow.json is empty. Export a ComfyUI API workflow.' }, 500, corsHeaders)
    }
    nodeMap = await getNodeMap().catch(() => null)
    const hasNodeMap = nodeMap && Object.keys(nodeMap).length > 0
    if (!hasNodeMap) {
      return jsonResponse({ error: 'node_map.json is empty.' }, 500, corsHeaders)
    }
  }

  const usageId = `qwen:${makeUsageId()}`
  let ticketsLeft: number | null = null
  const ticketMetaWithUsage = {
    ...ticketMeta,
    usage_id: usageId,
    source: 'run',
  }
  const ticketCharge = await consumeTicket(auth.admin, auth.user, ticketMetaWithUsage, usageId, corsHeaders)
  if ('response' in ticketCharge) {
    return ticketCharge.response
  }
  const consumedTickets = Number((ticketCharge as { ticketsLeft?: unknown }).ticketsLeft)
  if (Number.isFinite(consumedTickets)) {
    ticketsLeft = consumedTickets
  }

  if (useComfyUi) {
    const seed = input?.randomize_seed
      ? Math.floor(Math.random() * 2147483647)
      : Number(input?.seed ?? 0)
    const imageName = String(safeInput?.image_name ?? 'input.png')
    let subImageName = String(safeInput?.sub_image_name ?? safeInput?.image2_name ?? 'sub.png')
    if (!subImageBase64Raw) {
      subImageName = imageName
    } else if (subImageName === imageName) {
      subImageName = 'sub.png'
    }

    const nodeValues: Record<string, unknown> = {
      image: imageName,
      image2: subImageName,
      prompt,
      negative_prompt: negativePrompt,
      seed,
      steps,
      cfg: guidanceScale,
      width,
      height,
      angle_strength: angleStrength,
    }
    try {
      applyNodeMap(workflow as Record<string, any>, nodeMap as NodeMap, nodeValues)
    } catch (error) {
      const refundResult = await refundTicket(
        auth.admin,
        auth.user,
        { ...ticketMetaWithUsage, reason: 'workflow_apply_failed' },
        usageId,
        corsHeaders,
      )
      const nextTickets = Number((refundResult as { ticketsLeft?: unknown }).ticketsLeft)
      if (Number.isFinite(nextTickets)) {
        ticketsLeft = nextTickets
      }
      return jsonResponse(
        {
          error: 'Workflow node mapping failed.',
          detail: INTERNAL_ERROR_DETAIL,
          usage_id: usageId,
          ticketsLeft,
        },
        400,
        corsHeaders,
      )
    }

    const comfyKey = String(env.COMFY_ORG_API_KEY ?? '')
    const images = [{ name: imageName, image: imageBase64 }]
    if (subImageName !== imageName) {
      images.push({ name: subImageName, image: subImageBase64 })
    }
    const runpodInput: Record<string, unknown> = {
      workflow,
      images,
    }
    if (comfyKey) {
      runpodInput.comfy_org_api_key = comfyKey
    }

    let upstream: Response
    try {
      upstream = await fetch(`${endpoint}/run`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RUNPOD_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ input: runpodInput }),
      })
    } catch (error) {
      const refundResult = await refundTicket(
        auth.admin,
        auth.user,
        { ...ticketMetaWithUsage, reason: 'network_error' },
        usageId,
        corsHeaders,
      )
      const nextTickets = Number((refundResult as { ticketsLeft?: unknown }).ticketsLeft)
      if (Number.isFinite(nextTickets)) {
        ticketsLeft = nextTickets
      }
      return jsonResponse(
        {
          error: 'RunPod request failed.',
          detail: INTERNAL_ERROR_DETAIL,
          usage_id: usageId,
          ticketsLeft,
        },
        502,
        corsHeaders,
      )
    }
    const raw = await upstream.text()
    let upstreamPayload: any = null
    try {
      upstreamPayload = JSON.parse(raw)
    } catch {
      upstreamPayload = null
    }

    if (!upstreamPayload || typeof upstreamPayload !== 'object' || Array.isArray(upstreamPayload)) {
      const refundResult = await refundTicket(
        auth.admin,
        auth.user,
        { ...ticketMetaWithUsage, reason: 'parse_error' },
        usageId,
        corsHeaders,
      )
      const nextTickets = Number((refundResult as { ticketsLeft?: unknown }).ticketsLeft)
      if (Number.isFinite(nextTickets)) {
        ticketsLeft = nextTickets
      }
      return jsonResponse({ error: 'Upstream response is invalid.', usage_id: usageId, ticketsLeft }, 502, corsHeaders)
    }

    const comfyJobId = extractJobId(upstreamPayload)
    if (comfyJobId) {
      await bindUsageToJob(auth.admin, auth.user, usageId, String(comfyJobId))
    }

    const isFailure = !upstream.ok || isFailureStatus(upstreamPayload) || hasOutputError(upstreamPayload)
    if (isFailure) {
      const refundResult = await refundTicket(
        auth.admin,
        auth.user,
        { ...ticketMetaWithUsage, reason: 'failure', status: upstreamPayload?.status ?? upstreamPayload?.state ?? null },
        usageId,
        corsHeaders,
      )
      const nextTickets = Number((refundResult as { ticketsLeft?: unknown }).ticketsLeft)
      if (Number.isFinite(nextTickets)) {
        ticketsLeft = nextTickets
      }
    }

    upstreamPayload.usage_id = usageId
    if (ticketsLeft !== null) {
      upstreamPayload.ticketsLeft = ticketsLeft
    }
    return jsonResponse(upstreamPayload, upstream.status, corsHeaders)
  }

  const runpodInput = {
    image_base64: imageBase64,
    prompt,
    guidance_scale: guidanceScale,
    num_inference_steps: steps,
    width,
    height,
    seed: Number(input?.seed ?? 0),
    randomize_seed: Boolean(input?.randomize_seed ?? false),
  } as Record<string, unknown>

  if (subImageBase64Raw) {
    runpodInput.sub_image_base64 = subImageBase64Raw
  }

  const views = Array.isArray(input?.views) ? input.views : Array.isArray(input?.angles) ? input.angles : null
  if (views) {
    runpodInput.views = views
    runpodInput.angles = views
  } else {
    runpodInput.azimuth = input?.azimuth
    runpodInput.elevation = input?.elevation
    runpodInput.distance = input?.distance
  }

  let upstream: Response
  try {
    upstream = await fetch(`${endpoint}/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RUNPOD_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: runpodInput }),
    })
  } catch (error) {
    const refundResult = await refundTicket(
      auth.admin,
      auth.user,
      { ...ticketMetaWithUsage, reason: 'network_error' },
      usageId,
      corsHeaders,
    )
    const nextTickets = Number((refundResult as { ticketsLeft?: unknown }).ticketsLeft)
    if (Number.isFinite(nextTickets)) {
      ticketsLeft = nextTickets
    }
    return jsonResponse(
      {
        error: 'RunPod request failed.',
        detail: INTERNAL_ERROR_DETAIL,
        usage_id: usageId,
        ticketsLeft,
      },
      502,
      corsHeaders,
    )
  }
  const raw = await upstream.text()
  let upstreamPayload: any = null
  try {
    upstreamPayload = JSON.parse(raw)
  } catch {
    upstreamPayload = null
  }

  if (!upstreamPayload || typeof upstreamPayload !== 'object' || Array.isArray(upstreamPayload)) {
    const refundResult = await refundTicket(
      auth.admin,
      auth.user,
      { ...ticketMetaWithUsage, reason: 'parse_error' },
      usageId,
      corsHeaders,
    )
    const nextTickets = Number((refundResult as { ticketsLeft?: unknown }).ticketsLeft)
    if (Number.isFinite(nextTickets)) {
      ticketsLeft = nextTickets
    }
    return jsonResponse({ error: 'Upstream response is invalid.', usage_id: usageId, ticketsLeft }, 502, corsHeaders)
  }

  const runpodJobId = extractJobId(upstreamPayload)
  if (runpodJobId) {
    await bindUsageToJob(auth.admin, auth.user, usageId, String(runpodJobId))
  }

  const isFailure = !upstream.ok || isFailureStatus(upstreamPayload) || hasOutputError(upstreamPayload)
  if (isFailure) {
    const refundResult = await refundTicket(
      auth.admin,
      auth.user,
      { ...ticketMetaWithUsage, reason: 'failure', status: upstreamPayload?.status ?? upstreamPayload?.state ?? null },
      usageId,
      corsHeaders,
    )
    const nextTickets = Number((refundResult as { ticketsLeft?: unknown }).ticketsLeft)
    if (Number.isFinite(nextTickets)) {
      ticketsLeft = nextTickets
    }
  }

  upstreamPayload.usage_id = usageId
  if (ticketsLeft !== null) {
    upstreamPayload.ticketsLeft = ticketsLeft
  }
  return jsonResponse(upstreamPayload, upstream.status, corsHeaders)
  } catch (error) {
    return jsonResponse(
      {
        error: 'Unexpected error in qwen run.',
        detail: INTERNAL_ERROR_DETAIL,
      },
      500,
      corsHeaders,
    )
  }
}

