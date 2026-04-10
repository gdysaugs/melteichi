import { createClient, type User } from '@supabase/supabase-js'
import { buildCorsHeaders, isCorsBlocked } from '../_shared/cors'

type Env = {
  RUNPOD_API_KEY?: string
  RUNPOD_MMAUDIO_ENDPOINT_URL?: string
  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
}

const corsMethods = 'POST, GET, OPTIONS'
const DEFAULT_MMAUDIO_ENDPOINT = 'https://api.runpod.ai/v2/tf90vnnefy2q5m'
const MMAUDIO_TARGET_FPS = 25
const MAX_PROMPT_LENGTH = 500
const MAX_VIDEO_BYTES = 30 * 1024 * 1024
const PIPELINE_USAGE_ID_MAX_LENGTH = 128
const PIPELINE_USAGE_ID_MAX_AGE_MS = 15 * 60 * 1000
const PIPELINE_USAGE_ID_PATTERN = /^media:(\d{13}):([A-Za-z0-9-]{16,96})$/
const SIGNUP_TICKET_GRANT = 5
const MMAUDIO_TICKET_COST = 1

const ERR_SERVER_CONFIG = 'サーバー設定が不足しています。'
const ERR_INVALID_BODY = 'リクエスト形式が不正です。'
const ERR_PROMPT_REQUIRED = 'テキストを入力してください。'
const ERR_PROMPT_TOO_LONG = `text is too long (max ${MAX_PROMPT_LENGTH}).`
const ERR_VIDEO_REQUIRED = '動画データを入力してください。'
const ERR_VIDEO_TOO_LARGE = `video is too large (max ${MAX_VIDEO_BYTES / (1024 * 1024)}MB).`
const ERR_REQUEST_FAILED = '音声演出のリクエストに失敗しました。'
const ERR_STATUS_FAILED = '音声演出の状態確認に失敗しました。'

const jsonResponse = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

const normalizeEndpoint = (value: string | undefined) => value?.trim().replace(/\/+$/, '') ?? ''
const resolveEndpoint = (env: Env) => normalizeEndpoint(env.RUNPOD_MMAUDIO_ENDPOINT_URL) || DEFAULT_MMAUDIO_ENDPOINT

const parseJsonSafe = async (request: Request) => {
  try {
    return await request.json()
  } catch {
    return null
  }
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
    p_reason: 'generate_audio_video',
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

const normalizeBase64 = (value: unknown) => {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  const commaIndex = trimmed.indexOf(',')
  if (trimmed.startsWith('data:') && commaIndex >= 0) {
    return trimmed.slice(commaIndex + 1).trim()
  }
  return trimmed
}

const estimateBase64Bytes = (value: string) => {
  const normalized = value.replace(/\s+/g, '')
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding)
}

const normalizeVideoExt = (value: unknown) => {
  if (typeof value !== 'string') return '.mp4'
  const trimmed = value.trim().toLowerCase()
  const ext = trimmed.startsWith('.') ? trimmed : `.${trimmed}`
  if (!/^\.[a-z0-9]{1,5}$/i.test(ext)) return '.mp4'
  return ext
}

const extensionToMime = (ext: string) => {
  switch (ext.toLowerCase()) {
    case '.mov':
      return 'video/quicktime'
    case '.webm':
      return 'video/webm'
    case '.mkv':
      return 'video/x-matroska'
    case '.avi':
      return 'video/x-msvideo'
    case '.mp4':
    default:
      return 'video/mp4'
  }
}

const parseOptionalNumber = (raw: unknown) => {
  if (raw === undefined || raw === null || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isFinite(n)) return undefined
  return n
}

const parseOptionalBoolean = (raw: unknown) => {
  if (raw === undefined || raw === null || raw === '') return undefined
  if (typeof raw === 'boolean') return raw
  const normalized = String(raw).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return undefined
}

const buildDefaultWorkflow = (
  uploadFilename: string,
  prompt: string,
  options?: {
    negativePrompt?: string
    seed?: number
    steps?: number
    cfg?: number
    duration?: number
    maskAwayClip?: boolean
    forceOffload?: boolean
  },
) => {
  const seed =
    typeof options?.seed === 'number' && Number.isFinite(options.seed)
      ? Math.max(0, Math.floor(options.seed))
      : Math.floor(Math.random() * 2147483647)
  const steps =
    typeof options?.steps === 'number' && Number.isFinite(options.steps)
      ? Math.max(1, Math.floor(options.steps))
      : 25
  const cfg =
    typeof options?.cfg === 'number' && Number.isFinite(options.cfg)
      ? Math.max(0, options.cfg)
      : 4.5
  const negativePrompt = options?.negativePrompt ?? ''
  const maskAwayClip = options?.maskAwayClip ?? false
  const forceOffload = options?.forceOffload ?? true
  const useFixedDuration = typeof options?.duration === 'number' && Number.isFinite(options.duration)
  const fixedDuration = useFixedDuration ? Math.max(0.5, options!.duration as number) : null

  return {
    '85': {
      class_type: 'MMAudioModelLoader',
      inputs: {
        mmaudio_model: 'mmaudio_large_44k_nsfw_gold_8.5k_final_fp16.safetensors',
        base_precision: 'fp16',
      },
      _meta: { title: 'MMAudioModelLoader' },
    },
    '102': {
      class_type: 'MMAudioFeatureUtilsLoader',
      inputs: {
        vae_model: 'mmaudio_vae_44k_fp16.safetensors',
        synchformer_model: 'mmaudio_synchformer_fp16.safetensors',
        clip_model: 'apple_DFN5B-CLIP-ViT-H-14-384_fp16.safetensors',
        mode: '44k',
        precision: 'fp16',
      },
      _meta: { title: 'MMAudioFeatureUtilsLoader' },
    },
    '91': {
      class_type: 'VHS_LoadVideo',
      inputs: {
        video: uploadFilename,
        force_rate: MMAUDIO_TARGET_FPS,
        force_size: 'Disabled',
        custom_width: 512,
        custom_height: 512,
        frame_load_cap: 0,
        skip_first_frames: 0,
        select_every_nth: 1,
      },
      _meta: { title: 'VHS_LoadVideo' },
    },
    '105': {
      class_type: 'VHS_VideoInfo',
      inputs: {
        video_info: ['91', 3],
      },
      _meta: { title: 'VHS_VideoInfo' },
    },
    '92': {
      class_type: 'MMAudioSampler',
      inputs: {
        mmaudio_model: ['85', 0],
        feature_utils: ['102', 0],
        images: ['91', 0],
        duration: useFixedDuration ? fixedDuration : ['105', 7],
        steps,
        cfg,
        seed,
        prompt,
        negative_prompt: negativePrompt,
        mask_away_clip: maskAwayClip,
        force_offload: forceOffload,
      },
      _meta: { title: 'MMAudioSampler' },
    },
    '97': {
      class_type: 'VHS_VideoCombine',
      inputs: {
        images: ['91', 0],
        audio: ['92', 0],
        frame_rate: ['105', 5],
        loop_count: 0,
        filename_prefix: 'MMAudio',
        format: 'video/h264-mp4',
        pingpong: false,
        save_output: false,
        pix_fmt: 'yuv420p',
        crf: 19,
        save_metadata: true,
      },
      _meta: { title: 'VHS_VideoCombine' },
    },
  }
}

const extractRunpodStatus = (payload: any) => {
  const raw = payload?.status ?? payload?.state ?? payload?.output?.status ?? payload?.result?.status
  return raw ? String(raw).toUpperCase() : 'UNKNOWN'
}

const isFailureStatus = (status: string) => ['FAILED', 'CANCELLED', 'TIMED_OUT', 'ERROR'].includes(String(status || '').toUpperCase())

const extractRunpodJobId = (payload: any) => {
  const raw = payload?.id ?? payload?.job_id ?? payload?.jobId ?? payload?.output?.id ?? payload?.output?.job_id
  return raw ? String(raw) : ''
}

const extractError = (payload: any) =>
  payload?.error ||
  payload?.message ||
  payload?.detail ||
  payload?.output?.error ||
  payload?.output?.message ||
  payload?.result?.error ||
  payload?.result?.message

const extractVideoOutput = (payload: any) => {
  const roots = [
    payload,
    payload?.output,
    payload?.result,
    payload?.output?.output,
    payload?.result?.output,
    payload?.output?.result,
    payload?.result?.result,
  ]

  let outputBase64 = ''
  let outputFilename: string | null = null
  let outputSizeBytes: number | null = null
  let runtime: unknown = null

  const listKeys = ['videos', 'outputs', 'output_videos', 'gifs', 'images']

  for (const root of roots) {
    if (!root || typeof root !== 'object') continue

    const direct =
      normalizeBase64(root?.output_base64) ||
      normalizeBase64(root?.video_base64) ||
      normalizeBase64(root?.video) ||
      normalizeBase64(root?.data)
    if (!outputBase64 && direct) {
      outputBase64 = direct
      outputFilename = outputFilename ?? (root?.output_filename ? String(root.output_filename) : null)
      outputSizeBytes = Number.isFinite(Number(root?.output_size_bytes)) ? Number(root.output_size_bytes) : outputSizeBytes
      runtime = root?.runtime ?? runtime
    }

    for (const key of listKeys) {
      const candidate = root?.[key]
      if (!Array.isArray(candidate)) continue
      for (const item of candidate) {
        if (!item || typeof item !== 'object') continue
        const nested = normalizeBase64(item?.video ?? item?.data ?? item?.url ?? item?.output_base64 ?? item?.video_base64)
        if (!nested) continue
        outputBase64 = nested
        outputFilename = item?.filename ? String(item.filename) : outputFilename
        outputSizeBytes = Number.isFinite(Number(item?.size_bytes)) ? Number(item.size_bytes) : outputSizeBytes
        break
      }
      if (outputBase64) break
    }

    outputFilename = outputFilename ?? (root?.output_filename ? String(root.output_filename) : null)
    outputSizeBytes = Number.isFinite(Number(root?.output_size_bytes)) ? Number(root.output_size_bytes) : outputSizeBytes
    runtime = root?.runtime ?? runtime
    if (outputBase64) break
  }

  return {
    outputBase64,
    outputFilename,
    outputSizeBytes,
    runtime,
  }
}

const requestRunpod = async (
  endpoint: string,
  path: string,
  apiKey: string,
  init: RequestInit = {},
) => {
  const response = await fetch(`${endpoint}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })

  const text = await response.text()
  let payload: any = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = { raw: text }
    }
  }
  return { ok: response.ok, status: response.status, payload }
}

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
  if ('response' in auth) return auth.response

  const runpodApiKey = env.RUNPOD_API_KEY?.trim()
  const endpoint = resolveEndpoint(env)
  if (!runpodApiKey || !endpoint) {
    return jsonResponse({ error: ERR_SERVER_CONFIG }, 500, corsHeaders)
  }

  const payload = await parseJsonSafe(request)
  if (!payload || typeof payload !== 'object') {
    return jsonResponse({ error: ERR_INVALID_BODY }, 400, corsHeaders)
  }

  const input = (payload as any).input ?? payload
  const rawPipelineUsageId = input?.pipeline_usage_id ?? (payload as any)?.pipeline_usage_id
  const pipelineUsageId = normalizePipelineUsageId(rawPipelineUsageId, true)
  if ((typeof rawPipelineUsageId === 'string' && rawPipelineUsageId.trim()) && !pipelineUsageId) {
    return jsonResponse({ error: 'pipeline_usage_id is invalid or expired.' }, 400, corsHeaders)
  }

  if (input?.workflow) {
    return jsonResponse({ error: 'workflow overrides are not allowed.' }, 400, corsHeaders)
  }

  const ticketCheck = await ensureTicketAvailable(auth.admin, auth.user, MMAUDIO_TICKET_COST, corsHeaders)
  if ('response' in ticketCheck) return ticketCheck.response

  let runpodInput: Record<string, unknown> = {}
  {
    const text = String(input?.text ?? input?.prompt ?? '').trim()
    if (!text) {
      return jsonResponse({ error: ERR_PROMPT_REQUIRED }, 400, corsHeaders)
    }
    if (text.length > MAX_PROMPT_LENGTH) {
      return jsonResponse({ error: ERR_PROMPT_TOO_LONG }, 400, corsHeaders)
    }

    const videoBase64 = normalizeBase64(input?.video_base64 ?? input?.videoBase64 ?? input?.video)
    if (!videoBase64) {
      return jsonResponse({ error: ERR_VIDEO_REQUIRED }, 400, corsHeaders)
    }
    if (estimateBase64Bytes(videoBase64) > MAX_VIDEO_BYTES) {
      return jsonResponse({ error: ERR_VIDEO_TOO_LARGE }, 413, corsHeaders)
    }

    const negativePrompt = String(input?.negative_prompt ?? input?.negativePrompt ?? '').trim()
    const videoExt = normalizeVideoExt(input?.video_ext ?? input?.videoExt)
    const videoName = String(input?.video_name ?? input?.videoName ?? `source${videoExt}`).trim() || `source${videoExt}`
    const seed = parseOptionalNumber(input?.seed)
    const steps = parseOptionalNumber(input?.steps)
    const cfg = parseOptionalNumber(input?.cfg)
    const duration = parseOptionalNumber(input?.duration)
    const maskAwayClip = parseOptionalBoolean(input?.mask_away_clip)
    const forceOffload = parseOptionalBoolean(input?.force_offload)

    runpodInput = {
      workflow: buildDefaultWorkflow(videoName, text, {
        negativePrompt,
        seed,
        steps,
        cfg,
        duration,
        maskAwayClip,
        forceOffload,
      }),
      uploads: [
        {
          name: videoName,
          data: videoBase64,
          mime: extensionToMime(videoExt),
        },
      ],
    }
  }

  let runResult
  try {
    runResult = await requestRunpod(endpoint, '/run', runpodApiKey, {
      method: 'POST',
      body: JSON.stringify({ input: runpodInput }),
    })
  } catch {
    return jsonResponse({ error: ERR_REQUEST_FAILED }, 502, corsHeaders)
  }

  if (!runResult.ok) {
    return jsonResponse(
      {
        error: ERR_REQUEST_FAILED,
        upstream_status: runResult.status,
      },
      502,
      corsHeaders,
    )
  }

  const status = extractRunpodStatus(runResult.payload)
  const id = extractRunpodJobId(runResult.payload)
  const usageId = pipelineUsageId || (id ? `mmaudio:${id}` : `mmaudio:adhoc:${makeUsageId()}`)
  const chargeMeta = {
    source: 'run',
    job_id: id || null,
    status,
    pipeline_usage_id: pipelineUsageId || null,
    ticket_cost: MMAUDIO_TICKET_COST,
  }
  const charge = await consumeTicket(auth.admin, auth.user, chargeMeta, usageId, MMAUDIO_TICKET_COST, corsHeaders)
  if ('response' in charge) return charge.response
  let ticketsLeft: number | null = Number.isFinite(Number(charge.ticketsLeft)) ? Number(charge.ticketsLeft) : null

  if (isFailureStatus(status) || extractError(runResult.payload)) {
    const refundMeta = {
      source: 'run',
      job_id: id || null,
      status,
      ticket_cost: MMAUDIO_TICKET_COST,
      reason: 'failure',
    }
    const refund = await refundTicket(auth.admin, auth.user, refundMeta, usageId, MMAUDIO_TICKET_COST, corsHeaders)
    if ('response' in refund) return refund.response
    const nextTickets = Number((refund as { ticketsLeft?: unknown }).ticketsLeft)
    if (Number.isFinite(nextTickets)) ticketsLeft = nextTickets
  }

  const output = extractVideoOutput(runResult.payload)
  const videoMime = output.outputFilename?.toLowerCase().endsWith('.webm') ? 'video/webm' : 'video/mp4'
  const video = output.outputBase64 ? `data:${videoMime};base64,${output.outputBase64}` : null

  return jsonResponse(
    {
      id: id || null,
      status,
      output_filename: output.outputFilename,
      output_size_bytes: output.outputSizeBytes,
      runtime: output.runtime,
      video,
      ticketsLeft,
      message: id ? 'job accepted' : 'completed',
    },
    200,
    corsHeaders,
  )
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const corsHeaders = buildCorsHeaders(request, env, corsMethods)
  if (isCorsBlocked(request, env)) {
    return new Response(null, { status: 403, headers: corsHeaders })
  }

  const auth = await requireGoogleUser(request, env, corsHeaders)
  if ('response' in auth) return auth.response

  const runpodApiKey = env.RUNPOD_API_KEY?.trim()
  const endpoint = resolveEndpoint(env)
  if (!runpodApiKey || !endpoint) {
    return jsonResponse({ error: ERR_SERVER_CONFIG }, 500, corsHeaders)
  }

  const params = new URL(request.url).searchParams
  const id = params.get('id')?.trim()
  if (!id) {
    return jsonResponse({ error: 'id is required.' }, 400, corsHeaders)
  }

  const pipelineUsageId = normalizePipelineUsageId(params.get('pipeline_usage_id'))
  const usageId = pipelineUsageId || `mmaudio:${id}`
  const ownership = await ensureUsageOwnership(auth.admin, auth.user, usageId, corsHeaders)
  if ('response' in ownership) return ownership.response

  let statusResult
  try {
    statusResult = await requestRunpod(endpoint, `/status/${encodeURIComponent(id)}`, runpodApiKey, {
      method: 'GET',
    })
  } catch {
    return jsonResponse({ error: ERR_STATUS_FAILED }, 502, corsHeaders)
  }

  if (!statusResult.ok) {
    return jsonResponse(
      {
        error: ERR_STATUS_FAILED,
        upstream_status: statusResult.status,
      },
      502,
      corsHeaders,
    )
  }

  const payload = statusResult.payload ?? {}
  const status = extractRunpodStatus(payload)
  let ticketsLeft: number | null = null

  if (isFailureStatus(status) || extractError(payload)) {
    const refundMeta = {
      source: 'status',
      job_id: id,
      status,
      ticket_cost: MMAUDIO_TICKET_COST,
      reason: 'failure',
    }
    const refund = await refundTicket(auth.admin, auth.user, refundMeta, usageId, MMAUDIO_TICKET_COST, corsHeaders)
    if ('response' in refund) return refund.response
    const nextTickets = Number((refund as { ticketsLeft?: unknown }).ticketsLeft)
    if (Number.isFinite(nextTickets)) ticketsLeft = nextTickets
  }

  const output = extractVideoOutput(payload)
  const videoMime = output.outputFilename?.toLowerCase().endsWith('.webm') ? 'video/webm' : 'video/mp4'
  const video = output.outputBase64 ? `data:${videoMime};base64,${output.outputBase64}` : null

  return jsonResponse(
    {
      id,
      status,
      output_filename: output.outputFilename,
      output_size_bytes: output.outputSizeBytes,
      runtime: output.runtime,
      video,
      ticketsLeft,
      delayTime: payload?.delayTime ?? null,
      executionTime: payload?.executionTime ?? null,
      error: isFailureStatus(status) ? ERR_REQUEST_FAILED : null,
    },
    200,
    corsHeaders,
  )
}

