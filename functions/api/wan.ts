import workflowI2VTemplate from './wan-workflow-i2v.json'
import workflowDasiwaI2VTemplate from './wan-dasiwa-workflow-i2v.json'
import workflowAnimateTemplate from './wan-workflow-animate.json'
import nodeMapI2VTemplate from './wan-node-map-i2v.json'
import nodeMapAnimateTemplate from './wan-node-map-animate.json'
import { createClient, type User } from '@supabase/supabase-js'
import { buildCorsHeaders, isCorsBlocked } from '../_shared/cors'
import { isUnderageImage } from '../_shared/rekognition'

type Env = {
  RUNPOD_API_KEY: string
  RUNPOD_WAN_RAPID_FASTMOVE_ENDPOINT_URL?: string
  RUNPOD_WAN_DASIWA_ENDPOINT_URL?: string
  RUNPOD_WAN_LORA_PACK_ENDPOINT_URL?: string
  RUNPOD_ENDPOINT_URL?: string
  RUNPOD_WAN_ENDPOINT_URL?: string
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

const DEFAULT_LORA_PACK_ENDPOINT = 'https://api.runpod.ai/v2/rywgsws0odibjj'
const LORA_PACK_STRENGTH_HIGH = 0.1
const LORA_PACK_STRENGTH_LOW = 0.1

const LORA_PACK_HIGH_LORAS = [
  'iGoon - Blink_Back_Doggystyle_HIGH.safetensors',
  'iGoon%20-%20Blink_Facial_I2V_HIGH.safetensors',
  'iGoon%20-%20Blink_Front_Doggystyle_I2V_HIGH.safetensors',
  'iGoon%20-%20Blink_Handjob_I2V_HIGH.safetensors',
  'iGOON_Blink_Blowjob_I2V_HIGH%281%29.safetensors',
  'iGoon_Blink_Missionary_I2V_HIGH%20v2.safetensors',
  'Blink_Squatting_Cowgirl_Position_I2V_HIGH.safetensors',
] as const

const LORA_PACK_LOW_LORAS = [
  'iGoon - Blink_Back_Doggystyle_LOW.safetensors',
  'iGoon%20-%20Blink_Facial_I2V_LOW.safetensors',
  'iGoon%20-%20Blink_Front_Doggystyle_I2V_LOW.safetensors',
  'iGoon%20-%20Blink_Handjob_I2V_LOW.safetensors',
  'iGOON_Blink_Blowjob_I2V_LOW%281%29.safetensors',
  'iGoon%20-%20Blink_Missionary_I2V_LOW%20v2.safetensors',
  'iGoon%20-%20Blink_Squatting_Cowgirl_Position_I2V_LOW.safetensors',
] as const

const isLoraPackRoute = (request: Request) => new URL(request.url).pathname.toLowerCase().includes('/api/wan-lora-pack')

const resolveEndpoint = (
  env: Env,
  request: Request,
  mode: GenerationMode = 'i2v',
  i2vVariant: I2VVariant = 'default',
) => {
  if (mode === 'i2v') {
    if (isLoraPackRoute(request)) {
      return (env.RUNPOD_WAN_LORA_PACK_ENDPOINT_URL ?? DEFAULT_LORA_PACK_ENDPOINT).replace(/\/$/, '')
    }
    const i2vEndpoint =
      i2vVariant === 'dasiwa'
        ? (
            env.RUNPOD_WAN_DASIWA_ENDPOINT_URL ??
            env.RUNPOD_WAN_RAPID_FASTMOVE_ENDPOINT_URL ??
            env.RUNPOD_WAN_ENDPOINT_URL ??
            env.RUNPOD_ENDPOINT_URL
          )
        : (
            env.RUNPOD_WAN_RAPID_FASTMOVE_ENDPOINT_URL ??
            env.RUNPOD_WAN_ENDPOINT_URL ??
            env.RUNPOD_ENDPOINT_URL
          )
    return i2vEndpoint?.replace(/\/$/, '')
  }
  return (env.RUNPOD_WAN_ENDPOINT_URL ?? env.RUNPOD_ENDPOINT_URL)?.replace(/\/$/, '')
}

type NodeMapEntry = {
  id: string
  input: string
}

type NodeMapValue = NodeMapEntry | NodeMapEntry[]

type NodeMap = Partial<{
  image: NodeMapValue
  video: NodeMapValue
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

type GenerationMode = 'i2v' | 'animate'
type I2VVariant = 'default' | 'dasiwa'

const resolveI2VVariant = (request: Request): I2VVariant => {
  const path = new URL(request.url).pathname.toLowerCase()
  return path.includes('/api/wan-dasiwa') ? 'dasiwa' : 'default'
}

const SIGNUP_TICKET_GRANT = 5
const DEFAULT_VIDEO_TICKET_COST = 1
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_VIDEO_BYTES = 150 * 1024 * 1024
const MAX_PROMPT_LENGTH = 500
const MAX_NEGATIVE_PROMPT_LENGTH = 500
const FIXED_STEPS = 4
const FIXED_STEPS_ANIMATE = 6
const LORA_PACK_STEPS = 4
const LORA_PACK_SPLIT_STEP = 1
const LORA_PACK_SHIFT = 2
const MIN_DIMENSION = 256
const MAX_DIMENSION = 3000
const MIN_CFG = 0
const MAX_CFG = 10
const FIXED_FPS_DEFAULT = 10
const FIXED_FPS_DASIWA = 16
const LORA_PACK_FPS = 10
// Wan i2v length is most stable with 4n+1 frames.
const VIDEO_DURATION_OPTIONS_DEFAULT = [
  { seconds: 5, frames: 53, ticketCost: 1 },
  { seconds: 7, frames: 73, ticketCost: 3 },
  { seconds: 10, frames: 101, ticketCost: 6 },
] as const
const VIDEO_DURATION_OPTIONS_DASIWA = [
  { seconds: 5, frames: 81, ticketCost: 1 },
  { seconds: 7, frames: 113, ticketCost: 3 },
  { seconds: 9, frames: 145, ticketCost: 5 },
] as const
const VIDEO_DURATION_OPTIONS_LORA_PACK = [
  { seconds: 5, frames: 53, ticketCost: 1 },
  { seconds: 8, frames: 81, ticketCost: 3 },
] as const
const FIXED_ANIMATE_FRAMES = 77
const INTERNAL_SERVER_ERROR_MESSAGE = '\u30b5\u30fc\u30d0\u30fc\u5185\u90e8\u30a8\u30e9\u30fc\u304c\u767a\u751f\u3057\u307e\u3057\u305f\u3002\u6642\u9593\u3092\u304a\u3044\u3066\u518d\u5ea6\u304a\u8a66\u3057\u304f\u3060\u3055\u3044\u3002'
const INTERNAL_ERROR_DETAIL = 'internal_error'
const ERROR_LOGIN_REQUIRED = '\u30ed\u30b0\u30a4\u30f3\u304c\u5fc5\u8981\u3067\u3059\u3002'
const ERROR_AUTH_FAILED = '\u8a8d\u8a3c\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002'
const ERROR_GOOGLE_ONLY = 'Google\u30ed\u30b0\u30a4\u30f3\u306e\u307f\u5bfe\u5fdc\u3057\u3066\u3044\u307e\u3059\u3002'
const ERROR_SUPABASE_NOT_SET =
  'SUPABASE_URL \u307e\u305f\u306f SUPABASE_SERVICE_ROLE_KEY \u304c\u8a2d\u5b9a\u3055\u308c\u3066\u3044\u307e\u305b\u3093\u3002'
const ERROR_ID_REQUIRED = 'id\u304c\u5fc5\u8981\u3067\u3059\u3002'
const ERROR_JOB_NOT_FOUND = 'Job not found.'
const ERROR_I2V_IMAGE_REQUIRED = 'i2v\u306b\u306f\u753b\u50cf\u304c\u5fc5\u8981\u3067\u3059\u3002'
const ERROR_ANIMATE_VIDEO_REQUIRED = 'animate\u306b\u306f\u53c2\u7167\u52d5\u753b\u304c\u5fc5\u8981\u3067\u3059\u3002'
const ERROR_IMAGE_READ_FAILED =
  '\u753b\u50cf\u306e\u8aad\u307f\u53d6\u308a\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002\u753b\u50cf\u3092\u78ba\u8a8d\u3057\u3066\u518d\u5ea6\u304a\u8a66\u3057\u304f\u3060\u3055\u3044\u3002'
const ERROR_VIDEO_READ_FAILED =
  '\u52d5\u753b\u306e\u8aad\u307f\u53d6\u308a\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002\u52d5\u753b\u3092\u78ba\u8a8d\u3057\u3066\u518d\u5ea6\u304a\u8a66\u3057\u304f\u3060\u3055\u3044\u3002'
const UNDERAGE_BLOCK_MESSAGE =
  '\u3053\u306e\u753b\u50cf\u306b\u306f\u66b4\u529b\u7684\u306a\u8868\u73fe\u3001\u4f4e\u5e74\u9f62\u3001\u307e\u305f\u306f\u898f\u7d04\u9055\u53cd\u306e\u53ef\u80fd\u6027\u304c\u3042\u308a\u307e\u3059\u3002\u5225\u306e\u753b\u50cf\u3067\u304a\u8a66\u3057\u304f\u3060\u3055\u3044\u3002'

const HIDDEN_MODEL_NAME_PATTERN =
  /Irodori-TTS-500M-v2-VoiceDesign|Irodori-TTS-500M-v2|Irodori-TTS|Irodori|VoiceDesign|MMAudio|Wav2Lip|WAV2LIP/gi
const HIDDEN_MODEL_FILE_PATTERN =
  /[A-Za-z0-9_./%\-]+?\.(safetensors|gguf|onnx|pt|pth|ckpt|bin)/gi
const GENERIC_MODEL_LABEL = 'model'
type VideoDurationOption = (typeof VIDEO_DURATION_OPTIONS_DEFAULT)[number]

const getVideoDurationOptions = (i2vVariant: I2VVariant, isLoraPack = false) => {
  if (isLoraPack) return VIDEO_DURATION_OPTIONS_LORA_PACK
  return i2vVariant === 'dasiwa' ? VIDEO_DURATION_OPTIONS_DASIWA : VIDEO_DURATION_OPTIONS_DEFAULT
}

const getDefaultVideoDurationOption = (i2vVariant: I2VVariant, isLoraPack = false): VideoDurationOption =>
  getVideoDurationOptions(i2vVariant, isLoraPack)[0] as VideoDurationOption

const resolveVideoDurationOption = (seconds: number, i2vVariant: I2VVariant, isLoraPack = false) =>
  getVideoDurationOptions(i2vVariant, isLoraPack).find((option) => option.seconds === seconds) ?? null

const resolveVideoDurationFromInput = (secondsRaw: unknown, i2vVariant: I2VVariant, isLoraPack = false) => {
  if (secondsRaw === undefined || secondsRaw === null || secondsRaw === '') {
    return { option: getDefaultVideoDurationOption(i2vVariant, isLoraPack), error: null as string | null }
  }

  const parsedSeconds = Math.floor(Number(secondsRaw))
  if (!Number.isFinite(parsedSeconds)) {
    return { option: null as null | VideoDurationOption, error: 'seconds must be a number.' }
  }

  const option = resolveVideoDurationOption(parsedSeconds, i2vVariant, isLoraPack)
  if (!option) {
    return { option: getDefaultVideoDurationOption(i2vVariant, isLoraPack), error: null as string | null }
  }

  return { option, error: null as string | null }
}

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
const getWorkflowTemplate = async (
  mode: GenerationMode,
  i2vVariant: I2VVariant = 'default',
) =>
  (mode === 'animate'
    ? workflowAnimateTemplate
    : i2vVariant === 'dasiwa'
      ? workflowDasiwaI2VTemplate
      : workflowI2VTemplate) as Record<string, unknown>

const getNodeMap = async (mode: GenerationMode) =>
  (mode === 'animate'
    ? nodeMapAnimateTemplate
    : nodeMapI2VTemplate) as NodeMap

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
  requiredTickets = 1,
  corsHeaders: HeadersInit = {},
) => {
  const email = user.email
  if (!email) {
    return { response: jsonResponse({ error: 'Email not available.' }, 400, corsHeaders) }
  }

  const { data: existing, error } = await ensureTicketRow(admin, user)

  if (error) {
    return { response: jsonResponse({ error: INTERNAL_SERVER_ERROR_MESSAGE }, 500, corsHeaders) }
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
    return { response: jsonResponse({ error: INTERNAL_SERVER_ERROR_MESSAGE }, 500, corsHeaders) }
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

const resolveUsageTicketMeta = (event: TicketEventRow | null) => {
  if (!event) {
    return { ticketCost: null as null | number, seconds: null as null | number }
  }

  let ticketCost: null | number = null
  const delta = Number(event.delta)
  if (Number.isFinite(delta) && delta < 0) {
    ticketCost = Math.max(1, Math.floor(Math.abs(delta)))
  }

  const metadata = event.metadata
  const metaCost = Number(metadata?.ticket_cost)
  if (Number.isFinite(metaCost) && metaCost > 0) {
    ticketCost = Math.max(1, Math.floor(metaCost))
  }

  const metaSeconds = Number(metadata?.seconds)
  const seconds = Number.isFinite(metaSeconds) && metaSeconds > 0 ? Math.floor(metaSeconds) : null
  return { ticketCost, seconds }
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

const sanitizeText = (value: string) => {
  if (!value) return value
  if (value.startsWith('data:')) return value
  return value
    .replace(HIDDEN_MODEL_NAME_PATTERN, GENERIC_MODEL_LABEL)
    .replace(HIDDEN_MODEL_FILE_PATTERN, `${GENERIC_MODEL_LABEL}.bin`)
}

const sanitizePayload = (value: unknown): unknown => {
  if (typeof value === 'string') {
    if (value.length > 2000 && value.startsWith('data:')) return value
    return sanitizeText(value)
  }
  if (Array.isArray(value)) return value.map((item) => sanitizePayload(item))
  if (value && typeof value === 'object') {
    const next: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      next[key] = sanitizePayload(entry)
    }
    return next
  }
  return value
}

const isHttpUrl = (value: string) => /^https?:\/\//i.test(value.trim())

const estimateBase64Bytes = (value: string) => {
  const trimmed = value.trim()
  const padding = trimmed.endsWith('==') ? 2 : trimmed.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding)
}

const ensureBase64Input = (label: string, value: unknown, maxBytes = MAX_IMAGE_BYTES) => {
  if (typeof value !== 'string' || !value.trim()) return ''
  const trimmed = value.trim()
  if (isHttpUrl(trimmed)) {
    throw new Error(`${label} must be base64.`)
  }
  const base64 = stripDataUrl(trimmed)
  if (!base64) return ''
  const bytes = estimateBase64Bytes(base64)
  if (bytes > maxBytes) {
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

const applyLoraPackStack = (workflow: Record<string, any>) => {
  const highUnetNodeIds: string[] = []
  const lowUnetNodeIds: string[] = []

  for (const [nodeId, node] of Object.entries(workflow)) {
    if (node?.class_type !== 'UNETLoader') continue
    const unetName = String(node?.inputs?.unet_name ?? '').toLowerCase()
    if (!unetName) continue

    if (unetName.includes('fp8h') || unetName.includes('_high') || unetName.includes('high')) {
      highUnetNodeIds.push(String(nodeId))
      continue
    }
    if (unetName.includes('fp8l') || unetName.includes('_low') || unetName.includes('low')) {
      lowUnetNodeIds.push(String(nodeId))
    }
  }

  const highBaseNodeId = highUnetNodeIds[0]
  const lowBaseNodeId = lowUnetNodeIds[0]
  if (!highBaseNodeId || !lowBaseNodeId) return

  const existingLoraNodeIds = Object.entries(workflow)
    .filter(([, node]) => (node as any)?.class_type === 'LoraLoaderModelOnly')
    .map(([id]) => id)
  for (const id of existingLoraNodeIds) {
    delete workflow[id]
  }

  let nextId =
    Math.max(
      ...Object.keys(workflow)
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id)),
    ) + 1
  if (!Number.isFinite(nextId)) nextId = 1000

  const createChain = (baseNodeId: string, loras: readonly string[], strength: number) => {
    let currentNodeId = baseNodeId
    for (const loraName of loras) {
      const nodeId = String(nextId++)
      workflow[nodeId] = {
        class_type: 'LoraLoaderModelOnly',
        inputs: {
          model: [currentNodeId, 0],
          lora_name: loraName,
          strength_model: strength,
        },
      }
      currentNodeId = nodeId
    }
    return currentNodeId
  }

  const highFinalNodeId = createChain(highBaseNodeId, LORA_PACK_HIGH_LORAS, LORA_PACK_STRENGTH_HIGH)
  const lowFinalNodeId = createChain(lowBaseNodeId, LORA_PACK_LOW_LORAS, LORA_PACK_STRENGTH_LOW)

  for (const node of Object.values(workflow)) {
    if ((node as any)?.class_type !== 'ModelSamplingSD3') continue
    if (!(node as any)?.inputs) continue

    const modelRef = (node as any).inputs.model
    if (Array.isArray(modelRef) && modelRef.length > 0) {
      const sourceNodeId = String(modelRef[0])
      if (sourceNodeId === highBaseNodeId) {
        ;(node as any).inputs.model = [highFinalNodeId, 0]
      } else if (sourceNodeId === lowBaseNodeId) {
        ;(node as any).inputs.model = [lowFinalNodeId, 0]
      }
    }

    ;(node as any).inputs.shift = LORA_PACK_SHIFT
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

  const i2vVariant = resolveI2VVariant(request)
  const isLoraPack = isLoraPackRoute(request)
  const isFreeGuestMode = false
  let authContext: { admin: ReturnType<typeof createClient>; user: User } | null = null
  if (!isFreeGuestMode) {
    const auth = await requireGoogleUser(request, env, corsHeaders)
    if ('response' in auth) {
      return auth.response
    }
    authContext = auth
  }

  const url = new URL(request.url)
  const id = url.searchParams.get('id')
  if (!id) {
    return jsonResponse({ error: ERROR_ID_REQUIRED }, 400, corsHeaders)
  }
  const modeParam = String(url.searchParams.get('mode') ?? '').toLowerCase()
  if (modeParam === 't2v') {
    return jsonResponse({ error: 'mode "t2v" is no longer supported.' }, 400, corsHeaders)
  }
  const statusMode: GenerationMode = modeParam === 'animate' ? 'animate' : 'i2v'
  if (i2vVariant === 'dasiwa' && statusMode !== 'i2v') {
    return jsonResponse({ error: 'wan-dasiwa supports mode "i2v" only.' }, 400, corsHeaders)
  }
  if (isLoraPack && statusMode !== 'i2v') {
    return jsonResponse({ error: 'wan-lora-pack supports mode "i2v" only.' }, 400, corsHeaders)
  }
  if (!env.RUNPOD_API_KEY) {
    return jsonResponse({ error: 'RUNPOD_API_KEY is not set.' }, 500, corsHeaders)
  }

  const endpoint = resolveEndpoint(env, request, statusMode, i2vVariant)
  if (!endpoint) {
    return jsonResponse(
      {
        error:
          'WAN endpoint is not set. Configure RUNPOD_WAN_DASIWA_ENDPOINT_URL or RUNPOD_WAN_RAPID_FASTMOVE_ENDPOINT_URL for i2v and RUNPOD_WAN_ENDPOINT_URL for animate.',
      },
      500,
      corsHeaders,
    )
  }
  const usageId = `wan:${id}`
  let usageTicketMeta: ReturnType<typeof resolveUsageTicketMeta> | null = null
  if (!isFreeGuestMode && authContext) {
    const usageEventResult = await requireOwnedUsageChargeEvent(authContext.admin, authContext.user, usageId, corsHeaders)
    if ('response' in usageEventResult) {
      return usageEventResult.response
    }
    usageTicketMeta = resolveUsageTicketMeta(usageEventResult.event)
  }
  const requestedSecondsRaw = url.searchParams.get('seconds')
  const requestedSeconds = requestedSecondsRaw === null ? null : Math.floor(Number(requestedSecondsRaw))
  const requestedDurationOption =
    requestedSeconds !== null && Number.isFinite(requestedSeconds)
      ? resolveVideoDurationOption(requestedSeconds, i2vVariant, isLoraPack) ?? getDefaultVideoDurationOption(i2vVariant, isLoraPack)
      : getDefaultVideoDurationOption(i2vVariant, isLoraPack)
  const statusDurationOption =
    statusMode === 'animate'
      ? null
      : resolveVideoDurationOption(usageTicketMeta?.seconds ?? requestedDurationOption.seconds, i2vVariant, isLoraPack) ?? requestedDurationOption
  const ticketCost =
    statusMode === 'animate'
      ? DEFAULT_VIDEO_TICKET_COST
      : usageTicketMeta?.ticketCost ?? statusDurationOption.ticketCost

  const upstream = await fetch(`${endpoint}/status/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${env.RUNPOD_API_KEY}` },
  })
  const raw = await upstream.text()
  let payload: any = null
  let ticketsLeft: number | null = null
  try {
    payload = JSON.parse(raw)
  } catch {
    payload = null
  }

  if (!isFreeGuestMode && authContext && payload && shouldConsumeTicket(payload)) {
    const ticketMeta = {
      job_id: id,
      status: payload?.status ?? payload?.state ?? null,
      source: 'status',
      ticket_cost: ticketCost,
      seconds: statusDurationOption?.seconds ?? null,
    }
    const result = await consumeTicket(authContext.admin, authContext.user, ticketMeta, usageId, ticketCost, corsHeaders)
    if ('response' in result) {
      return result.response
    }
    const nextTickets = Number((result as { ticketsLeft?: unknown }).ticketsLeft)
    if (Number.isFinite(nextTickets)) {
      ticketsLeft = nextTickets
    }
  }

  if (!isFreeGuestMode && authContext && payload && (isFailureStatus(payload) || hasOutputError(payload))) {
    const refundMeta = {
      job_id: id,
      status: payload?.status ?? payload?.state ?? null,
      source: 'status',
      reason: 'failure',
      ticket_cost: ticketCost,
      seconds: statusDurationOption?.seconds ?? null,
    }
    const refundResult = await refundTicket(authContext.admin, authContext.user, refundMeta, usageId, ticketCost, corsHeaders)
    if ('response' in refundResult) {
      return refundResult.response
    }
    const nextTickets = Number((refundResult as { ticketsLeft?: unknown }).ticketsLeft)
    if (Number.isFinite(nextTickets)) {
      ticketsLeft = nextTickets
    }
  }

  if (ticketsLeft !== null && payload && typeof payload === 'object' && !Array.isArray(payload)) {
    payload.ticketsLeft = ticketsLeft
    return jsonResponse(sanitizePayload(payload), upstream.status, corsHeaders)
  }

  if (payload && typeof payload === 'object') {
    return jsonResponse(sanitizePayload(payload), upstream.status, corsHeaders)
  }
  if (!upstream.ok) {
    return jsonResponse({ error: INTERNAL_SERVER_ERROR_MESSAGE }, upstream.status, corsHeaders)
  }

  return new Response(sanitizeText(raw), {
    status: upstream.status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const corsHeaders = buildCorsHeaders(request, env, corsMethods)
  if (isCorsBlocked(request, env)) {
    return new Response(null, { status: 403, headers: corsHeaders })
  }

  const i2vVariant = resolveI2VVariant(request)
  const isLoraPack = isLoraPackRoute(request)
  const isFreeGuestMode = false
  let authContext: { admin: ReturnType<typeof createClient>; user: User } | null = null
  if (!isFreeGuestMode) {
    const auth = await requireGoogleUser(request, env, corsHeaders)
    if ('response' in auth) {
      return auth.response
    }
    authContext = auth
  }

  if (!env.RUNPOD_API_KEY) {
    return jsonResponse({ error: 'RUNPOD_API_KEY is not set.' }, 500, corsHeaders)
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
  if (mode === 't2v') {
    return jsonResponse({ error: 'mode "t2v" is no longer supported.' }, 400, corsHeaders)
  }
  if (mode !== 'i2v' && mode !== 'animate') {
    return jsonResponse({ error: 'mode must be "i2v" or "animate".' }, 400, corsHeaders)
  }
  const generationMode = mode as GenerationMode
  if (i2vVariant === 'dasiwa' && generationMode !== 'i2v') {
    return jsonResponse({ error: 'wan-dasiwa supports mode "i2v" only.' }, 400, corsHeaders)
  }
  if (isLoraPack && generationMode !== 'i2v') {
    return jsonResponse({ error: 'wan-lora-pack supports mode "i2v" only.' }, 400, corsHeaders)
  }

  const endpoint = resolveEndpoint(env, request, generationMode, i2vVariant)
  if (!endpoint) {
    return jsonResponse(
      {
        error:
          'WAN endpoint is not set. Configure RUNPOD_WAN_DASIWA_ENDPOINT_URL or RUNPOD_WAN_RAPID_FASTMOVE_ENDPOINT_URL for i2v and RUNPOD_WAN_ENDPOINT_URL for animate.',
      },
      500,
      corsHeaders,
    )
  }
  const isAnimate = mode === 'animate'
  const durationResult = isAnimate
    ? { option: null as null | VideoDurationOption, error: null as string | null }
    : resolveVideoDurationFromInput(input?.seconds, i2vVariant, isLoraPack)
  if (!isAnimate && (durationResult.error || !durationResult.option)) {
    return jsonResponse({ error: durationResult.error ?? 'Invalid seconds value.' }, 400, corsHeaders)
  }
  const videoDurationOption = durationResult.option ?? getDefaultVideoDurationOption(i2vVariant, isLoraPack)
  const imageValue = input?.image_base64 ?? input?.image ?? input?.image_url
  if (!isAnimate && !imageValue) {
    return jsonResponse({ error: ERROR_I2V_IMAGE_REQUIRED }, 400, corsHeaders)
  }
  const videoValue = input?.video_base64 ?? input?.video ?? input?.video_url
  if (isAnimate && !videoValue) {
    return jsonResponse({ error: ERROR_ANIMATE_VIDEO_REQUIRED }, 400, corsHeaders)
  }

  let imageBase64 = ''
  let videoBase64 = ''
  try {
    if (imageValue) {
      if (typeof input?.image_url === 'string' && input.image_url) {
        throw new Error('image_url is not allowed. Use base64.')
      }
      imageBase64 = ensureBase64Input('image', imageValue)
    }
  } catch {
    return jsonResponse(
      { error: ERROR_IMAGE_READ_FAILED },
      400,
      corsHeaders,
    )
  }
  try {
    if (videoValue) {
      if (typeof input?.video_url === 'string' && input.video_url) {
        throw new Error('video_url is not allowed. Use base64.')
      }
      videoBase64 = ensureBase64Input('video', videoValue, MAX_VIDEO_BYTES)
    }
  } catch {
    return jsonResponse(
      { error: ERROR_VIDEO_READ_FAILED },
      400,
      corsHeaders,
    )
  }

  if (!isAnimate && !imageBase64) {
    return jsonResponse({ error: 'image is empty.' }, 400, corsHeaders)
  }
  if (isAnimate && !videoBase64) {
    return jsonResponse({ error: 'video is empty.' }, 400, corsHeaders)
  }

  if (!isAnimate) {
    try {
      if (await isUnderageImage(imageBase64, env)) {
        return jsonResponse({ error: UNDERAGE_BLOCK_MESSAGE }, 400, corsHeaders)
      }
    } catch (error) {
      return jsonResponse(
        { error: INTERNAL_SERVER_ERROR_MESSAGE },
        500,
        corsHeaders,
      )
    }
  }

  const prompt = String(input?.prompt ?? input?.text ?? '')
  const negativePrompt = String(input?.negative_prompt ?? input?.negative ?? '')
  const steps = isAnimate ? FIXED_STEPS_ANIMATE : isLoraPack ? LORA_PACK_STEPS : FIXED_STEPS
  const cfg = 1
  const width = Math.floor(Number(input?.width ?? 832))
  const height = Math.floor(Number(input?.height ?? 576))
  const fps = isAnimate ? FIXED_FPS_DEFAULT : isLoraPack ? LORA_PACK_FPS : i2vVariant === 'dasiwa' ? FIXED_FPS_DASIWA : FIXED_FPS_DEFAULT
  const numFrames = isAnimate
    ? Math.max(1, Math.floor(Number(input?.num_frames ?? FIXED_ANIMATE_FRAMES)))
    : videoDurationOption.frames
  const seconds = isAnimate ? null : videoDurationOption.seconds
  const ticketCost = isAnimate
    ? DEFAULT_VIDEO_TICKET_COST
    : videoDurationOption.ticketCost
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
  const totalSteps = Math.max(1, Math.floor(steps))
  const splitStep = isLoraPack ? LORA_PACK_SPLIT_STEP : Math.max(1, Math.floor(totalSteps / 2))

  const ticketMeta = {
    prompt_length: prompt.length,
    width,
    height,
    frames: numFrames,
    fps,
    steps: totalSteps,
    mode,
    seconds,
    ticket_cost: ticketCost,
  }
  if (!isFreeGuestMode && authContext) {
    const ticketCheck = await ensureTicketAvailable(authContext.admin, authContext.user, ticketCost, corsHeaders)
    if ('response' in ticketCheck) {
      return ticketCheck.response
    }
  }

  const imageName = String(input?.image_name ?? 'input.png')
  const videoName = String(input?.video_name ?? 'source.mp4')
  const workflow = clone(await getWorkflowTemplate(generationMode, i2vVariant))
  if (!workflow || Object.keys(workflow).length === 0) {
    return jsonResponse({ error: 'wan workflow is empty. Export a ComfyUI API workflow.' }, 500, corsHeaders)
  }

  if (isLoraPackRoute(request)) {
    applyLoraPackStack(workflow as Record<string, any>)
  }

  const nodeMap = await getNodeMap(generationMode).catch(() => null)
  const hasNodeMap = nodeMap && Object.keys(nodeMap).length > 0
  if (!hasNodeMap) {
    return jsonResponse({ error: 'wan node map is empty.' }, 500, corsHeaders)
  }

  const nodeValues: Record<string, unknown> = {
    image: imageBase64 ? imageName : undefined,
    video: videoBase64 ? videoName : undefined,
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
  const images = [
    ...(imageBase64 ? [{ name: imageName, image: imageBase64 }] : []),
    ...(videoBase64 ? [{ name: videoName, image: videoBase64 }] : []),
  ]
  const runpodInput: Record<string, unknown> = {
    workflow,
    images,
  }
  if (comfyKey) {
    runpodInput.comfy_org_api_key = comfyKey
  }

  const upstream = await fetch(`${endpoint}/run`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RUNPOD_API_KEY}`,
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

  if (!isFreeGuestMode && authContext && shouldCharge && jobId) {
    const usageId = `wan:${jobId}`
    const ticketMetaWithJob = {
      ...ticketMeta,
      job_id: jobId,
      status: upstreamPayload?.status ?? upstreamPayload?.state ?? null,
      source: 'run',
    }
    const result = await consumeTicket(authContext.admin, authContext.user, ticketMetaWithJob, usageId, ticketCost, corsHeaders)
    if ('response' in result) {
      return result.response
    }
    const nextTickets = Number((result as { ticketsLeft?: unknown }).ticketsLeft)
    if (Number.isFinite(nextTickets)) {
      ticketsLeft = nextTickets
    }
  } else if (!isFreeGuestMode && authContext && upstreamPayload && shouldConsumeTicket(upstreamPayload)) {
    const jobId = extractJobId(upstreamPayload)
    const usageId = jobId ? `wan:${jobId}` : undefined
    const ticketMetaWithJob = {
      ...ticketMeta,
      job_id: jobId ?? undefined,
      status: upstreamPayload?.status ?? upstreamPayload?.state ?? null,
      source: 'run',
    }
    const result = await consumeTicket(authContext.admin, authContext.user, ticketMetaWithJob, usageId, ticketCost, corsHeaders)
    if ('response' in result) {
      return result.response
    }
    const nextTickets = Number((result as { ticketsLeft?: unknown }).ticketsLeft)
    if (Number.isFinite(nextTickets)) {
      ticketsLeft = nextTickets
    }
  }

  if (ticketsLeft !== null && upstreamPayload && typeof upstreamPayload === 'object' && !Array.isArray(upstreamPayload)) {
    upstreamPayload.ticketsLeft = ticketsLeft
    return jsonResponse(sanitizePayload(upstreamPayload), upstream.status, corsHeaders)
  }

  if (upstreamPayload && typeof upstreamPayload === 'object') {
    return jsonResponse(sanitizePayload(upstreamPayload), upstream.status, corsHeaders)
  }
  if (!upstream.ok) {
    return jsonResponse({ error: INTERNAL_SERVER_ERROR_MESSAGE }, upstream.status, corsHeaders)
  }

  return new Response(sanitizeText(raw), {
    status: upstream.status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
