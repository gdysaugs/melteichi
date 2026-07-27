import workflowTemplate from './msr-i2v-workflow.json'
import { createClient, type User } from '@supabase/supabase-js'
import { buildCorsHeaders, isCorsBlocked } from '../_shared/cors'

type Env = {
  RUNPOD_AUDIO_I2V_API_KEY?: string
  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
}

const corsMethods = 'POST, GET, OPTIONS'
const RUNPOD_MSR_ENDPOINT = 'https://api.runpod.ai/v2/nk5f686wu3645s'
const MSR_USAGE_MODE = 'msr_i2v'
const LEGACY_MSR_USAGE_MODE = 'msr_i2v_test'
const SUBJECT_IMAGE_NAME = 'msr-subject.png'
const SUBJECT_IMAGE_2_NAME = 'msr-subject-2.png'
const SIGNUP_TICKET_GRANT = 5
const FIXED_FPS = 24
const VIDEO_DURATION_OPTIONS = [
  { seconds: 5, frames: 121, guideFrames: 41, ticketCost: 1 },
  { seconds: 8, frames: 193, guideFrames: 33, ticketCost: 2 },
] as const
const DEFAULT_DURATION_SECONDS = VIDEO_DURATION_OPTIONS[0].seconds
const MAX_LONG_EDGE = 720
const MODEL_SIZE_MULTIPLE = 64
const MODEL_LONG_EDGE =
  Math.floor(MAX_LONG_EDGE / MODEL_SIZE_MULTIPLE) * MODEL_SIZE_MULTIPLE
const DEFAULT_SOURCE_WIDTH = 720
const DEFAULT_SOURCE_HEIGHT = 512
const MIN_SHORT_EDGE = 256
const MAX_REFERENCE_BYTES = 5 * 1024 * 1024
const MAX_OBJECT_DESCRIPTION_LENGTH = 300
const MAX_PROMPT_LENGTH = 3000
const DEFAULT_NEGATIVE_PROMPT =
  'subtitles, watermark, text, logo, worst quality, low quality, blurry, jittery, flicker, distorted, inconsistent appearance, identity drift, duplicate person, extra person, deformed object, wrong object, missing object, malformed anatomy, narration, narrator, voice-over, spoken scene description, reading the prompt aloud'
const hasQuotedDialogue = (value: string) =>
  /"[^"\r\n]+"/.test(value) ||
  /“[^”\r\n]+”/.test(value) ||
  /「[^」\r\n]+」/.test(value) ||
  /『[^』\r\n]+』/.test(value)
const buildAudioDirection = (prompt: string) =>
  hasQuotedDialogue(prompt)
    ? 'Only the exact quoted words are spoken; all other text remains silent visual direction with no narration or voice-over.'
    : 'No human speech, narration, or voice-over is heard; only natural synchronized action, object, and environmental sound effects are heard.'
const buildPersonObjectPrompt = (
  prompt: string,
  objectDescription: string,
) =>
  [
    buildAudioDirection(prompt),
    `A single person matching Image 1 uses ${objectDescription}, matching the object shown in Image 2.`,
    prompt,
  ].join(' ')
const INTERNAL_SERVER_ERROR_MESSAGE =
  'サーバー内部エラーが発生しました。時間をおいて再度お試しください。'

const jsonResponse = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  })

const resolveRunpodApiKey = (env: Env) =>
  (env.RUNPOD_AUDIO_I2V_API_KEY ?? '').trim()

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

const requireGoogleUser = async (
  request: Request,
  env: Env,
  corsHeaders: HeadersInit,
) => {
  const token = extractBearerToken(request)
  if (!token) {
    return {
      response: jsonResponse({ error: 'ログインが必要です。' }, 401, corsHeaders),
    }
  }

  const admin = getSupabaseAdmin(env)
  if (!admin) {
    return {
      response: jsonResponse(
        {
          error:
            'SUPABASE_URL または SUPABASE_SERVICE_ROLE_KEY が設定されていません。',
        },
        500,
        corsHeaders,
      ),
    }
  }

  const { data, error } = await admin.auth.getUser(token)
  if (error || !data?.user) {
    return {
      response: jsonResponse({ error: '認証に失敗しました。' }, 401, corsHeaders),
    }
  }
  if (!isGoogleUser(data.user)) {
    return {
      response: jsonResponse(
        { error: 'Googleログインのみ対応しています。' },
        403,
        corsHeaders,
      ),
    }
  }

  return { admin, user: data.user }
}

const makeUsageId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

const durationOptionForSeconds = (value: unknown) => {
  const seconds = Math.floor(Number(value))
  return (
    VIDEO_DURATION_OPTIONS.find((option) => option.seconds === seconds) ?? null
  )
}

const usageVideoDetails = (metadata: Record<string, unknown>) => {
  const option = durationOptionForSeconds(metadata.duration_seconds)
  if (option) return option

  // Keep already-started legacy 2-second jobs pollable/refundable after deploy.
  if (Math.floor(Number(metadata.duration_seconds)) === 2) {
    return { seconds: 2, frames: 49, ticketCost: 1 } as const
  }
  return VIDEO_DURATION_OPTIONS[0]
}

const fetchTicketRow = async (
  admin: ReturnType<typeof createClient>,
  user: User,
) => {
  const { data: byUser, error: userError } = await admin
    .from('user_tickets')
    .select('id, email, user_id, tickets')
    .eq('user_id', user.id)
    .maybeSingle()
  if (userError) return { error: userError }
  if (byUser) return { data: byUser, error: null }
  if (!user.email) return { data: null, error: null }

  const { data: byEmail, error: emailError } = await admin
    .from('user_tickets')
    .select('id, email, user_id, tickets')
    .eq('email', user.email)
    .maybeSingle()
  if (emailError) return { error: emailError }
  return { data: byEmail, error: null }
}

const ensureTicketRow = async (
  admin: ReturnType<typeof createClient>,
  user: User,
) => {
  if (!user.email) return { data: null, error: null }

  const { data: existing, error } = await fetchTicketRow(admin, user)
  if (error) return { data: null, error }
  if (existing) return { data: existing, error: null }

  const { data: inserted, error: insertError } = await admin
    .from('user_tickets')
    .insert({
      email: user.email,
      user_id: user.id,
      tickets: SIGNUP_TICKET_GRANT,
    })
    .select('id, email, user_id, tickets')
    .maybeSingle()

  if (insertError || !inserted) {
    const { data: retry, error: retryError } = await fetchTicketRow(admin, user)
    if (retryError) return { data: null, error: retryError }
    return { data: retry, error: null }
  }

  await admin.from('ticket_events').insert({
    usage_id: makeUsageId(),
    email: user.email,
    user_id: user.id,
    delta: SIGNUP_TICKET_GRANT,
    reason: 'signup_bonus',
    metadata: { source: 'auto_grant' },
  })

  return { data: inserted, error: null }
}

const ensureTicketAvailable = async (
  admin: ReturnType<typeof createClient>,
  user: User,
  ticketCost: number,
  corsHeaders: HeadersInit,
) => {
  if (!user.email) {
    return {
      response: jsonResponse({ error: 'Email not available.' }, 400, corsHeaders),
    }
  }

  const { data: existing, error } = await ensureTicketRow(admin, user)
  if (error) {
    return {
      response: jsonResponse(
        { error: INTERNAL_SERVER_ERROR_MESSAGE },
        500,
        corsHeaders,
      ),
    }
  }
  if (!existing || existing.tickets < ticketCost) {
    return {
      response: jsonResponse(
        { error: 'No tickets remaining.' },
        402,
        corsHeaders,
      ),
    }
  }
  if (!existing.user_id) {
    await admin
      .from('user_tickets')
      .update({ user_id: user.id })
      .eq('id', existing.id)
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
  if (!user.email) {
    return {
      response: jsonResponse({ error: 'Email not available.' }, 400, corsHeaders),
    }
  }

  const { data: existing, error } = await fetchTicketRow(admin, user)
  if (error) {
    return {
      response: jsonResponse(
        { error: INTERNAL_SERVER_ERROR_MESSAGE },
        500,
        corsHeaders,
      ),
    }
  }
  if (!existing) {
    return {
      response: jsonResponse(
        { error: 'No tickets available.' },
        402,
        corsHeaders,
      ),
    }
  }
  if (!existing.user_id) {
    await admin
      .from('user_tickets')
      .update({ user_id: user.id })
      .eq('id', existing.id)
  }

  const { data: rpcData, error: rpcError } = await admin.rpc(
    'consume_tickets',
    {
      p_ticket_id: existing.id,
      p_usage_id: usageId,
      p_cost: ticketCost,
      p_reason: 'generate_video',
      p_metadata: metadata,
    },
  )

  if (rpcError) {
    const message = rpcError.message ?? 'Failed to update tickets.'
    if (message.includes('INSUFFICIENT_TICKETS')) {
      return {
        response: jsonResponse(
          { error: 'No tickets remaining.' },
          402,
          corsHeaders,
        ),
      }
    }
    if (message.includes('INVALID')) {
      return {
        response: jsonResponse(
          { error: 'Invalid ticket request.' },
          400,
          corsHeaders,
        ),
      }
    }
    return {
      response: jsonResponse(
        { error: INTERNAL_SERVER_ERROR_MESSAGE },
        500,
        corsHeaders,
      ),
    }
  }

  const result = Array.isArray(rpcData) ? rpcData[0] : rpcData
  const ticketsLeft = Number(result?.tickets_left)
  return {
    ticketsLeft: Number.isFinite(ticketsLeft) ? ticketsLeft : undefined,
  }
}

const isOwnedUsageEvent = (event: any, user: User) => {
  if (!event) return false
  if (event.user_id && event.user_id === user.id) return true
  const eventEmail =
    typeof event.email === 'string' ? event.email.toLowerCase() : ''
  const userEmail =
    typeof user.email === 'string' ? user.email.toLowerCase() : ''
  return Boolean(eventEmail && userEmail && eventEmail === userEmail)
}

const requireOwnedUsage = async (
  admin: ReturnType<typeof createClient>,
  user: User,
  usageId: string,
  corsHeaders: HeadersInit,
) => {
  const { data, error } = await admin
    .from('ticket_events')
    .select('usage_id, email, user_id, delta, metadata')
    .eq('usage_id', usageId)
    .maybeSingle()
  if (error) {
    return {
      response: jsonResponse(
        { error: INTERNAL_SERVER_ERROR_MESSAGE },
        500,
        corsHeaders,
      ),
    }
  }
  if (!data || !isOwnedUsageEvent(data, user)) {
    return {
      response: jsonResponse({ error: 'Usage not found.' }, 403, corsHeaders),
    }
  }

  const metadata =
    (data as { metadata?: Record<string, unknown> }).metadata ?? {}
  if (
    metadata.mode !== MSR_USAGE_MODE &&
    metadata.mode !== LEGACY_MSR_USAGE_MODE
  ) {
    return {
      response: jsonResponse({ error: 'Usage not found.' }, 403, corsHeaders),
    }
  }
  return { usageEvent: data }
}

const refundTicket = async (
  admin: ReturnType<typeof createClient>,
  user: User,
  metadata: Record<string, unknown>,
  usageId: string,
  ticketCost: number,
  corsHeaders: HeadersInit,
) => {
  if (!user.email || !usageId) return { skipped: true }

  const { data: chargeEvent, error: chargeError } = await admin
    .from('ticket_events')
    .select('usage_id, email, user_id, delta, metadata')
    .eq('usage_id', usageId)
    .maybeSingle()
  if (chargeError) {
    return {
      response: jsonResponse(
        { error: INTERNAL_SERVER_ERROR_MESSAGE },
        500,
        corsHeaders,
      ),
    }
  }
  if (!chargeEvent || !isOwnedUsageEvent(chargeEvent, user)) {
    return { skipped: true }
  }

  const refundUsageId = `${usageId}:refund`
  const { data: existingRefund, error: refundCheckError } = await admin
    .from('ticket_events')
    .select('usage_id')
    .eq('usage_id', refundUsageId)
    .maybeSingle()
  if (refundCheckError) {
    return {
      response: jsonResponse(
        { error: INTERNAL_SERVER_ERROR_MESSAGE },
        500,
        corsHeaders,
      ),
    }
  }
  if (existingRefund) return { alreadyRefunded: true }

  const { data: existing, error } = await ensureTicketRow(admin, user)
  if (error || !existing) {
    return {
      response: jsonResponse(
        { error: INTERNAL_SERVER_ERROR_MESSAGE },
        500,
        corsHeaders,
      ),
    }
  }
  if (!existing.user_id) {
    await admin
      .from('user_tickets')
      .update({ user_id: user.id })
      .eq('id', existing.id)
  }

  const { data: rpcData, error: rpcError } = await admin.rpc(
    'refund_tickets',
    {
      p_ticket_id: existing.id,
      p_usage_id: refundUsageId,
      p_amount: ticketCost,
      p_reason: 'refund',
      p_metadata: metadata,
    },
  )
  if (rpcError) {
    return {
      response: jsonResponse(
        { error: INTERNAL_SERVER_ERROR_MESSAGE },
        500,
        corsHeaders,
      ),
    }
  }

  const result = Array.isArray(rpcData) ? rpcData[0] : rpcData
  const ticketsLeft = Number(result?.tickets_left)
  return {
    ticketsLeft: Number.isFinite(ticketsLeft) ? ticketsLeft : undefined,
  }
}

const hasOutputList = (value: unknown) =>
  Array.isArray(value) && value.length > 0

const hasOutputString = (value: unknown) =>
  typeof value === 'string' && value.trim() !== ''

const hasAssets = (payload: any): boolean => {
  if (!payload || typeof payload !== 'object') return false
  const data = payload as Record<string, unknown>
  if (
    [
      data.images,
      data.videos,
      data.gifs,
      data.outputs,
      data.output_images,
      data.output_videos,
      data.data,
    ].some(hasOutputList)
  ) {
    return true
  }
  return [
    data.image,
    data.video,
    data.gif,
    data.output_image,
    data.output_video,
    data.output_image_base64,
    data.output_video_base64,
  ].some(hasOutputString)
}

const hasAnyAssets = (payload: any) =>
  hasAssets(payload) ||
  hasAssets(payload?.output) ||
  hasAssets(payload?.result) ||
  hasAssets(payload?.output?.output) ||
  hasAssets(payload?.result?.output)

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
  return (
    status.includes('fail') ||
    status.includes('error') ||
    status.includes('cancel') ||
    status.includes('timeout') ||
    status.includes('timed_out')
  )
}

const extractJobId = (payload: any) =>
  payload?.id || payload?.jobId || payload?.job_id || payload?.output?.id

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value))

const normalizeDimension = (value: unknown, fallback: number) => {
  const parsed = Math.floor(Number(value))
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return Math.max(1, Math.min(16384, parsed))
}

const roundToModelSize = (value: number) =>
  Math.max(
    MIN_SHORT_EDGE,
    Math.min(
      MODEL_LONG_EDGE,
      Math.round(value / MODEL_SIZE_MULTIPLE) * MODEL_SIZE_MULTIPLE,
    ),
  )

const resolveOutputDimensions = (widthValue: unknown, heightValue: unknown) => {
  const sourceWidth = normalizeDimension(widthValue, DEFAULT_SOURCE_WIDTH)
  const sourceHeight = normalizeDimension(heightValue, DEFAULT_SOURCE_HEIGHT)
  const landscape = sourceWidth >= sourceHeight
  const sourceLong = Math.max(sourceWidth, sourceHeight)
  const sourceShort = Math.min(sourceWidth, sourceHeight)
  const shortEdge = roundToModelSize(
    (MODEL_LONG_EDGE * sourceShort) / sourceLong,
  )
  return {
    width: landscape ? MODEL_LONG_EDGE : shortEdge,
    height: landscape ? shortEdge : MODEL_LONG_EDGE,
  }
}

const normalizeAndValidateBase64 = (label: string, value: unknown) => {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required.`)
  }

  let encoded = value.trim()
  if (/^https?:\/\//i.test(encoded)) {
    throw new Error(`${label} must be base64.`)
  }
  if (encoded.startsWith('data:')) {
    const comma = encoded.indexOf(',')
    const header = comma >= 0 ? encoded.slice(0, comma) : ''
    if (
      comma < 0 ||
      !/^data:image\/(?:png|jpe?g|webp);base64$/i.test(header)
    ) {
      throw new Error(`${label} must be a PNG, JPEG, or WebP image.`)
    }
    encoded = encoded.slice(comma + 1)
  }

  encoded = encoded.replace(/\s+/g, '')
  if (
    !encoded ||
    encoded.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
  ) {
    throw new Error(`${label} is invalid base64.`)
  }

  const padded = encoded + '='.repeat((4 - (encoded.length % 4)) % 4)
  let decodedLength = 0
  try {
    decodedLength = atob(padded).length
  } catch {
    throw new Error(`${label} is invalid base64.`)
  }
  if (decodedLength < 1) {
    throw new Error(`${label} is empty.`)
  }
  if (decodedLength > MAX_REFERENCE_BYTES) {
    throw new Error(`${label} exceeds 5 MB.`)
  }

  return encoded
}

const buildRunpodInput = (
  prompt: string,
  objectDescription: string,
  subjectImage: string,
  subjectImage2: string,
  width: number,
  height: number,
  frameCount: number,
  guideFrameCount: number,
) => {
  const workflow = clone(workflowTemplate) as Record<string, any>
  workflow['5'].inputs.text = buildPersonObjectPrompt(
    prompt,
    objectDescription,
  )
  workflow['6'].inputs.text = DEFAULT_NEGATIVE_PROMPT
  workflow['8'].inputs.width = width
  workflow['8'].inputs.height = height
  workflow['8'].inputs.length = frameCount
  workflow['9'].inputs.image = SUBJECT_IMAGE_NAME
  workflow['26'].inputs.image = SUBJECT_IMAGE_2_NAME
  workflow['10'].inputs.width = width
  workflow['10'].inputs.height = height
  workflow['11'].inputs.width = width
  workflow['11'].inputs.height = height
  workflow['11'].inputs.frame_count = String(guideFrameCount)
  workflow['14'].inputs.frames_number = frameCount
  workflow['14'].inputs.frame_rate = FIXED_FPS
  workflow['16'].inputs.noise_seed = Math.floor(
    Math.random() * 1125899906842624,
  )
  workflow['25'].inputs.frame_rate = FIXED_FPS

  return {
    workflow,
    images: [
      { name: SUBJECT_IMAGE_NAME, data: subjectImage },
      { name: SUBJECT_IMAGE_2_NAME, data: subjectImage2 },
    ],
  }
}

const appendRequestMetadata = (
  payload: Record<string, any>,
  usageId: string,
  width: number,
  height: number,
  durationSeconds: number,
  frameCount: number,
  ticketCost: number,
) => {
  payload.usage_id = usageId
  payload.ticket_cost = ticketCost
  payload.duration_seconds = durationSeconds
  payload.fps = FIXED_FPS
  payload.frames = frameCount
  payload.width = width
  payload.height = height
  return payload
}

export const onRequestOptions: PagesFunction<Env> = async ({
  request,
  env,
}) => {
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

  const url = new URL(request.url)
  const id = url.searchParams.get('id')
  const usageId = url.searchParams.get('usage_id')
  if (!id) {
    return jsonResponse({ error: 'idが必要です。' }, 400, corsHeaders)
  }
  if (!usageId) {
    return jsonResponse(
      { error: 'usage_id is required.' },
      400,
      corsHeaders,
    )
  }

  const usage = await requireOwnedUsage(
    auth.admin,
    auth.user,
    usageId,
    corsHeaders,
  )
  if ('response' in usage) return usage.response

  const usageMetadata =
    (
      usage.usageEvent as {
        metadata?: Record<string, unknown>
      }
    ).metadata ?? {}
  const videoDetails = usageVideoDetails(usageMetadata)
  const expectedJobId = String(usageMetadata.job_id ?? '')
  if (!expectedJobId || expectedJobId !== id) {
    return jsonResponse(
      { error: 'Job does not match usage.' },
      403,
      corsHeaders,
    )
  }

  const runpodApiKey = resolveRunpodApiKey(env)
  if (!runpodApiKey) {
    return jsonResponse(
      { error: 'RUNPOD_AUDIO_I2V_API_KEY is not set.' },
      500,
      corsHeaders,
    )
  }

  const upstream = await fetch(
    `${RUNPOD_MSR_ENDPOINT}/status/${encodeURIComponent(id)}`,
    { headers: { Authorization: `Bearer ${runpodApiKey}` } },
  )
  const raw = await upstream.text()
  let payload: any = null
  let ticketsLeft: number | undefined
  try {
    payload = JSON.parse(raw)
  } catch {
    payload = null
  }

  if (payload && (isFailureStatus(payload) || hasOutputError(payload))) {
    const refundResult = await refundTicket(
      auth.admin,
      auth.user,
      {
        job_id: id,
        status: payload?.status ?? payload?.state ?? null,
        source: 'status',
        reason: 'failure',
        usage_id: usageId,
        mode: MSR_USAGE_MODE,
      },
      usageId,
      videoDetails.ticketCost,
      corsHeaders,
    )
    if ('response' in refundResult) return refundResult.response
    const refundedBalance = Number(
      (refundResult as { ticketsLeft?: unknown }).ticketsLeft,
    )
    if (Number.isFinite(refundedBalance)) ticketsLeft = refundedBalance
  }

  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    appendRequestMetadata(
      payload,
      usageId,
      Number(usageMetadata.width) || MODEL_LONG_EDGE,
      Number(usageMetadata.height) || DEFAULT_SOURCE_HEIGHT,
      videoDetails.seconds,
      videoDetails.frames,
      videoDetails.ticketCost,
    )
    if (typeof ticketsLeft === 'number') payload.ticketsLeft = ticketsLeft
    return jsonResponse(payload, upstream.status, corsHeaders)
  }

  return new Response(raw, {
    status: upstream.status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const corsHeaders = buildCorsHeaders(request, env, corsMethods)
  if (isCorsBlocked(request, env)) {
    return new Response(null, { status: 403, headers: corsHeaders })
  }

  const auth = await requireGoogleUser(request, env, corsHeaders)
  if ('response' in auth) return auth.response

  const runpodApiKey = resolveRunpodApiKey(env)
  if (!runpodApiKey) {
    return jsonResponse(
      { error: 'RUNPOD_AUDIO_I2V_API_KEY is not set.' },
      500,
      corsHeaders,
    )
  }

  const payload = await request.json().catch(() => null)
  if (!payload || typeof payload !== 'object') {
    return jsonResponse(
      { error: 'Invalid request body.' },
      400,
      corsHeaders,
    )
  }
  const input = (payload as any).input ?? payload
  if (input?.workflow) {
    return jsonResponse(
      { error: 'workflow overrides are not allowed.' },
      400,
      corsHeaders,
    )
  }

  const durationOption = durationOptionForSeconds(
    input?.duration_seconds ?? DEFAULT_DURATION_SECONDS,
  )
  if (!durationOption) {
    return jsonResponse(
      { error: 'duration_seconds must be 5 or 8.' },
      400,
      corsHeaders,
    )
  }
  const {
    seconds: durationSeconds,
    frames: frameCount,
    guideFrames: guideFrameCount,
    ticketCost,
  } = durationOption

  const prompt = String(input?.prompt ?? '').trim()
  if (!prompt) {
    return jsonResponse(
      { error: 'プロンプトを入力してください。' },
      400,
      corsHeaders,
    )
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return jsonResponse(
      { error: 'Prompt is too long.' },
      400,
      corsHeaders,
    )
  }

  const objectDescription = String(input?.object_description ?? '').trim()
  if (!objectDescription) {
    return jsonResponse(
      { error: 'オブジェクト名・特徴を入力してください。' },
      400,
      corsHeaders,
    )
  }
  if (objectDescription.length > MAX_OBJECT_DESCRIPTION_LENGTH) {
    return jsonResponse(
      { error: 'オブジェクト名・特徴は300文字以内で入力してください。' },
      400,
      corsHeaders,
    )
  }

  let subjectImage = ''
  let subjectImage2 = ''
  try {
    subjectImage = normalizeAndValidateBase64(
      'subject_image',
      input?.subject_image,
    )
    subjectImage2 = normalizeAndValidateBase64(
      'object_image',
      input?.object_image ?? input?.subject_image_2,
    )
  } catch (error) {
    return jsonResponse(
      {
        error:
          error instanceof Error
            ? error.message
            : '画像の読み取りに失敗しました。',
      },
      400,
      corsHeaders,
    )
  }

  const { width, height } = resolveOutputDimensions(
    input?.width,
    input?.height,
  )
  const ticketCheck = await ensureTicketAvailable(
    auth.admin,
    auth.user,
    ticketCost,
    corsHeaders,
  )
  if ('response' in ticketCheck) return ticketCheck.response

  const usageId = `msr_i2v:${makeUsageId()}`
  const ticketMeta = {
    mode: MSR_USAGE_MODE,
    prompt_length: prompt.length,
    object_description_length: objectDescription.length,
    reference_count: 2,
    reference_roles: ['person', 'object'],
    background_mode: 'internal_neutral',
    duration_seconds: durationSeconds,
    seconds: durationSeconds,
    fps: FIXED_FPS,
    frames: frameCount,
    guide_frames: guideFrameCount,
    width,
    height,
    ticket_cost: ticketCost,
    endpoint: RUNPOD_MSR_ENDPOINT,
    source: 'reserve',
  }
  const chargeResult = await consumeTicket(
    auth.admin,
    auth.user,
    ticketMeta,
    usageId,
    ticketCost,
    corsHeaders,
  )
  if ('response' in chargeResult) return chargeResult.response
  const chargedTicketsLeft = Number(
    (chargeResult as { ticketsLeft?: unknown }).ticketsLeft,
  )

  const runpodInput = buildRunpodInput(
    prompt,
    objectDescription,
    subjectImage,
    subjectImage2,
    width,
    height,
    frameCount,
    guideFrameCount,
  )

  let upstream: Response
  try {
    upstream = await fetch(`${RUNPOD_MSR_ENDPOINT}/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${runpodApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: runpodInput }),
    })
  } catch (error) {
    const refundResult = await refundTicket(
      auth.admin,
      auth.user,
      {
        ...ticketMeta,
        source: 'run',
        reason: 'request_failed',
        detail: error instanceof Error ? error.message : String(error),
      },
      usageId,
      ticketCost,
      corsHeaders,
    )
    if ('response' in refundResult) return refundResult.response
    const ticketsLeft = Number(
      (refundResult as { ticketsLeft?: unknown }).ticketsLeft,
    )
    return jsonResponse(
      {
        error: 'RunPod request failed.',
        usage_id: usageId,
        ticketsLeft: Number.isFinite(ticketsLeft) ? ticketsLeft : undefined,
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

  if (
    !upstream.ok ||
    (upstreamPayload &&
      (isFailureStatus(upstreamPayload) || hasOutputError(upstreamPayload)))
  ) {
    const jobId = extractJobId(upstreamPayload)
    const refundResult = await refundTicket(
      auth.admin,
      auth.user,
      {
        ...ticketMeta,
        job_id: jobId ?? undefined,
        status:
          upstreamPayload?.status ?? upstreamPayload?.state ?? upstream.status,
        source: 'run',
        reason: 'upstream_rejected',
      },
      usageId,
      ticketCost,
      corsHeaders,
    )
    if ('response' in refundResult) return refundResult.response
    const ticketsLeft = Number(
      (refundResult as { ticketsLeft?: unknown }).ticketsLeft,
    )
    const body =
      upstreamPayload && typeof upstreamPayload === 'object'
        ? upstreamPayload
        : { error: raw || 'RunPod request failed.' }
    appendRequestMetadata(
      body,
      usageId,
      width,
      height,
      durationSeconds,
      frameCount,
      ticketCost,
    )
    if (Number.isFinite(ticketsLeft)) body.ticketsLeft = ticketsLeft
    return jsonResponse(body, upstream.status || 500, corsHeaders)
  }

  if (
    upstreamPayload &&
    typeof upstreamPayload === 'object' &&
    !Array.isArray(upstreamPayload)
  ) {
    const jobId = extractJobId(upstreamPayload)
    await auth.admin
      .from('ticket_events')
      .update({
        metadata: {
          ...ticketMeta,
          job_id: jobId ?? undefined,
          status:
            upstreamPayload?.status ?? upstreamPayload?.state ?? null,
          source: 'run',
        },
      })
      .eq('usage_id', usageId)

    appendRequestMetadata(
      upstreamPayload,
      usageId,
      width,
      height,
      durationSeconds,
      frameCount,
      ticketCost,
    )
    if (jobId) upstreamPayload.job_id = jobId
    if (Number.isFinite(chargedTicketsLeft)) {
      upstreamPayload.ticketsLeft = chargedTicketsLeft
    }
    if (hasAnyAssets(upstreamPayload)) {
      upstreamPayload.status = upstreamPayload.status ?? 'COMPLETED'
    }
    return jsonResponse(upstreamPayload, upstream.status, corsHeaders)
  }

  return new Response(raw, {
    status: upstream.status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
