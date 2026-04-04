import { createClient, type User } from '@supabase/supabase-js'
import { buildCorsHeaders, isCorsBlocked } from '../_shared/cors'

type Env = {
  RUNPOD_API_KEY?: string
  RUNPOD_IRODORI_ENDPOINT_URL?: string
  RUNPOD_WAV2LIP_ENDPOINT_URL?: string
  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
}

const corsMethods = 'POST, GET, OPTIONS'
const LIPSYNC_DISABLED = true
const DEFAULT_SPEECH_ENDPOINT = 'https://api.runpod.ai/v2/qzj27jy7fkzpk7'
const MAX_TEXT_LENGTH = 100
const MAX_VOICE_DESIGN_LENGTH = 300
const MAX_VIDEO_BYTES = 20 * 1024 * 1024
const FIXED_SECONDS = 20
const FIXED_NUM_STEPS = 40
const SPEECH_MAX_POLL = 90

const ALLOWED_ENHANCERS = new Set(['none', 'gpen', 'gfpgan', 'codeformer', 'restoreformer'])

const ERR_SERVER_CONFIG = '\u30b5\u30fc\u30d0\u30fc\u8a2d\u5b9a\u304c\u4e0d\u8db3\u3057\u3066\u3044\u307e\u3059\u3002\u7ba1\u7406\u8005\u306b\u304a\u554f\u3044\u5408\u308f\u305b\u304f\u3060\u3055\u3044\u3002'
const ERR_INVALID_BODY = '\u30ea\u30af\u30a8\u30b9\u30c8\u5f62\u5f0f\u304c\u4e0d\u6b63\u3067\u3059\u3002'
const ERR_TEXT_REQUIRED = '\u30bb\u30ea\u30d5\u3092\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044\u3002'
const ERR_TEXT_TOO_LONG = `\u30bb\u30ea\u30d5\u306f${MAX_TEXT_LENGTH}\u6587\u5b57\u4ee5\u5185\u3067\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044\u3002`
const ERR_VOICE_DESIGN_TOO_LONG = `\u30dc\u30a4\u30b9\u30c7\u30b6\u30a4\u30f3\u306f${MAX_VOICE_DESIGN_LENGTH}\u6587\u5b57\u4ee5\u5185\u3067\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044\u3002`
const ERR_VIDEO_REQUIRED = '\u52d5\u753b\u30c7\u30fc\u30bf\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093\u3002'
const ERR_VIDEO_TOO_LARGE = `\u52d5\u753b\u30b5\u30a4\u30ba\u304c\u5927\u304d\u3059\u304e\u307e\u3059\uff08\u4e0a\u9650${MAX_VIDEO_BYTES / (1024 * 1024)}MB\uff09\u3002`
const ERR_SPEECH_REQUEST = '\u97f3\u58f0\u751f\u6210\u306e\u30ea\u30af\u30a8\u30b9\u30c8\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002'
const ERR_SPEECH_FAILED = '\u97f3\u58f0\u751f\u6210\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002'
const ERR_SPEECH_OUTPUT = '\u97f3\u58f0\u751f\u6210\u7d50\u679c\u3092\u53d6\u5f97\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f\u3002'
const ERR_SPEECH_STATUS = '\u97f3\u58f0\u751f\u6210\u306e\u72b6\u614b\u78ba\u8a8d\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002'
const ERR_SPEECH_TIMEOUT = '\u97f3\u58f0\u751f\u6210\u304c\u30bf\u30a4\u30e0\u30a2\u30a6\u30c8\u3057\u307e\u3057\u305f\u3002'
const ERR_VIDEO_REQUEST = '\u52d5\u753b\u751f\u6210\u306e\u30ea\u30af\u30a8\u30b9\u30c8\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002'
const ERR_VIDEO_FAILED = '\u52d5\u753b\u751f\u6210\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002'
const ERR_VIDEO_JOB_CREATE = '\u52d5\u753b\u751f\u6210\u30b8\u30e7\u30d6\u306e\u4f5c\u6210\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002'
const ERR_VIDEO_STATUS = '\u52d5\u753b\u751f\u6210\u30b8\u30e7\u30d6\u306e\u72b6\u614b\u78ba\u8a8d\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002'

const jsonResponse = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const normalizeEndpoint = (value: string | undefined) => value?.trim().replace(/\/+$/, '') ?? ''

const resolveSpeechEndpoint = (env: Env) => normalizeEndpoint(env.RUNPOD_IRODORI_ENDPOINT_URL) || DEFAULT_SPEECH_ENDPOINT
const resolveVideoEndpoint = (env: Env) => normalizeEndpoint(env.RUNPOD_WAV2LIP_ENDPOINT_URL)

const parseJsonSafe = async (request: Request) => {
  try {
    return await request.json()
  } catch {
    return null
  }
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

const clampFloat = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

const clampInt = (value: unknown, fallback: number, min: number, max: number) =>
  Math.floor(clampFloat(value, fallback, min, max))

const parseBoolean = (value: unknown, fallback: boolean) => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on', 'y'].includes(normalized)) return true
    if (['0', 'false', 'no', 'off', 'n'].includes(normalized)) return false
  }
  return fallback
}

const normalizeVideoExt = (value: unknown) => {
  if (typeof value !== 'string') return '.mp4'
  const trimmed = value.trim().toLowerCase()
  const ext = trimmed.startsWith('.') ? trimmed : `.${trimmed}`
  if (!/^\.[a-z0-9]{1,5}$/i.test(ext)) return '.mp4'
  return ext
}

const normalizeEnhancer = (value: unknown) => {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return ALLOWED_ENHANCERS.has(raw) ? raw : 'gfpgan'
}

const extractRunpodStatus = (payload: any) => {
  const raw = payload?.status ?? payload?.state ?? payload?.output?.status ?? payload?.result?.status
  return raw ? String(raw).toUpperCase() : 'UNKNOWN'
}

const isFailureStatus = (status: string) => {
  const normalized = status.toUpperCase()
  return normalized.includes('FAIL') || normalized.includes('ERROR') || normalized.includes('CANCEL') || normalized.includes('TIMEOUT')
}

const extractRunpodJobId = (payload: any) => {
  const raw = payload?.id ?? payload?.job_id ?? payload?.jobId ?? payload?.output?.id ?? payload?.output?.job_id
  return raw ? String(raw) : ''
}

const extractAudio = (payload: any) => {
  const roots = [
    payload,
    payload?.output,
    payload?.result,
    payload?.output?.output,
    payload?.result?.output,
    payload?.output?.result,
    payload?.result?.result,
  ]

  for (const root of roots) {
    if (!root || typeof root !== 'object') continue

    const direct = normalizeBase64(root.audio_base64)
    if (direct) return direct

    const audio = root.audio
    if (typeof audio === 'string') {
      const normalized = normalizeBase64(audio)
      if (normalized) return normalized
    }
    if (audio && typeof audio === 'object') {
      const normalized = normalizeBase64(audio.base64 ?? audio.data ?? audio.audio_base64 ?? audio.url ?? audio.audio_url)
      if (normalized) return normalized
    }
  }

  return ''
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

const extractVideoOutput = (payload: any) => {
  const output = payload?.output ?? payload?.result?.output ?? payload?.result ?? {}
  const outputBase64 = normalizeBase64(output?.output_base64 ?? output?.video_base64 ?? payload?.output_base64)
  const outputFilename = output?.output_filename ?? output?.filename ?? payload?.output_filename ?? null
  const outputSizeBytes = output?.output_size_bytes ?? payload?.output_size_bytes ?? null
  const runtime = output?.runtime ?? payload?.runtime ?? null

  return {
    outputBase64,
    outputFilename: outputFilename ? String(outputFilename) : null,
    outputSizeBytes: Number.isFinite(Number(outputSizeBytes)) ? Number(outputSizeBytes) : null,
    runtime,
  }
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
  if (LIPSYNC_DISABLED) return jsonResponse({ error: 'この機能は現在停止中です。' }, 410, corsHeaders)

  const runpodApiKey = env.RUNPOD_API_KEY?.trim()
  const speechEndpoint = resolveSpeechEndpoint(env)
  const videoEndpoint = resolveVideoEndpoint(env)
  if (!runpodApiKey || !speechEndpoint || !videoEndpoint) {
    return jsonResponse({ error: ERR_SERVER_CONFIG }, 500, corsHeaders)
  }

  const payload = await parseJsonSafe(request)
  if (!payload || typeof payload !== 'object') {
    return jsonResponse({ error: ERR_INVALID_BODY }, 400, corsHeaders)
  }

  const input = (payload as any).input ?? payload
  const text = String(input?.text ?? '').trim()
  if (!text) {
    return jsonResponse({ error: ERR_TEXT_REQUIRED }, 400, corsHeaders)
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return jsonResponse({ error: ERR_TEXT_TOO_LONG }, 400, corsHeaders)
  }

  const voiceDesign = String(input?.reference_text ?? input?.voice_design ?? '').trim()
  if (voiceDesign.length > MAX_VOICE_DESIGN_LENGTH) {
    return jsonResponse({ error: ERR_VOICE_DESIGN_TOO_LONG }, 400, corsHeaders)
  }

  const videoBase64 = normalizeBase64(input?.video_base64 ?? input?.videoBase64)
  if (!videoBase64) {
    return jsonResponse({ error: ERR_VIDEO_REQUIRED }, 400, corsHeaders)
  }

  if (estimateBase64Bytes(videoBase64) > MAX_VIDEO_BYTES) {
    return jsonResponse({ error: ERR_VIDEO_TOO_LARGE }, 413, corsHeaders)
  }

  const videoExt = normalizeVideoExt(input?.video_ext ?? input?.videoExt)

  const speechInput: Record<string, unknown> = {
    text,
    model_variant: 'voicedesign',
    seconds: FIXED_SECONDS,
    num_steps: FIXED_NUM_STEPS,
  }
  if (voiceDesign) {
    speechInput.reference_text = voiceDesign
  }

  let speechRun
  try {
    speechRun = await requestRunpod(speechEndpoint, '/runsync', runpodApiKey, {
      method: 'POST',
      body: JSON.stringify({ input: speechInput }),
    })
  } catch {
    return jsonResponse({ error: ERR_SPEECH_REQUEST }, 502, corsHeaders)
  }

  if (!speechRun.ok) {
    return jsonResponse({ error: ERR_SPEECH_FAILED }, 502, corsHeaders)
  }

  let audioBase64 = extractAudio(speechRun.payload)
  if (!audioBase64) {
    const speechJobId = extractRunpodJobId(speechRun.payload)
    if (!speechJobId) {
      return jsonResponse({ error: ERR_SPEECH_OUTPUT }, 502, corsHeaders)
    }

    for (let i = 0; i < SPEECH_MAX_POLL; i += 1) {
      const statusResult = await requestRunpod(
        speechEndpoint,
        `/status/${encodeURIComponent(speechJobId)}`,
        runpodApiKey,
        { method: 'GET' },
      )
      if (!statusResult.ok) {
        return jsonResponse({ error: ERR_SPEECH_STATUS }, 502, corsHeaders)
      }

      const status = extractRunpodStatus(statusResult.payload)
      audioBase64 = extractAudio(statusResult.payload)
      if (audioBase64) break
      if (isFailureStatus(status)) {
        return jsonResponse({ error: ERR_SPEECH_FAILED }, 502, corsHeaders)
      }

      await wait(2000)
    }
  }

  if (!audioBase64) {
    return jsonResponse({ error: ERR_SPEECH_TIMEOUT }, 504, corsHeaders)
  }

  const videoInput: Record<string, unknown> = {
    video_base64: videoBase64,
    video_ext: videoExt,
    audio_base64: audioBase64,
    audio_ext: '.wav',
    checkpoint_path: String(input?.checkpoint_path ?? 'checkpoints/wav2lip_gan.onnx').trim() || 'checkpoints/wav2lip_gan.onnx',
    denoise: parseBoolean(input?.denoise, false),
    enhancer: normalizeEnhancer(input?.enhancer),
    blending: Number(clampFloat(input?.blending, 6, 0, 10).toFixed(2)),
    face_occluder: parseBoolean(input?.face_occluder, true),
    face_mask: parseBoolean(input?.face_mask, true),
    pads: clampInt(input?.pads, 4, 0, 64),
    face_mode: clampInt(input?.face_mode, 0, 0, 4),
    resize_factor: clampInt(input?.resize_factor, 1, 1, 8),
    target_face_index: clampInt(input?.target_face_index, 0, 0, 32),
    face_id_threshold: Number(clampFloat(input?.face_id_threshold, 0.45, 0, 1).toFixed(3)),
    keep_original_audio: parseBoolean(input?.keep_original_audio, true),
    generated_audio_mix_volume: Number(clampFloat(input?.generated_audio_mix_volume, 1, 0, 2).toFixed(2)),
    original_audio_mix_volume: Number(clampFloat(input?.original_audio_mix_volume, 0.9, 0, 2).toFixed(2)),
  }

  let videoRun
  try {
    videoRun = await requestRunpod(videoEndpoint, '/run', runpodApiKey, {
      method: 'POST',
      body: JSON.stringify({ input: videoInput }),
    })
  } catch {
    return jsonResponse({ error: ERR_VIDEO_REQUEST }, 502, corsHeaders)
  }

  if (!videoRun.ok) {
    return jsonResponse({ error: ERR_VIDEO_FAILED }, 502, corsHeaders)
  }

  const videoJobId = extractRunpodJobId(videoRun.payload)
  if (!videoJobId) {
    return jsonResponse({ error: ERR_VIDEO_JOB_CREATE }, 502, corsHeaders)
  }

  return jsonResponse(
    {
      id: videoJobId,
      status: extractRunpodStatus(videoRun.payload),
      message: '\u30b8\u30e7\u30d6\u3092\u53d7\u3051\u4ed8\u3051\u307e\u3057\u305f\u3002',
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
  if (LIPSYNC_DISABLED) return jsonResponse({ error: 'この機能は現在停止中です。' }, 410, corsHeaders)

  const runpodApiKey = env.RUNPOD_API_KEY?.trim()
  const videoEndpoint = resolveVideoEndpoint(env)
  if (!runpodApiKey || !videoEndpoint) {
    return jsonResponse({ error: ERR_SERVER_CONFIG }, 500, corsHeaders)
  }

  const id = new URL(request.url).searchParams.get('id')?.trim()
  if (!id) {
    return jsonResponse({ error: '\u0069\u0064\u304c\u5fc5\u8981\u3067\u3059\u3002' }, 400, corsHeaders)
  }

  let statusResult
  try {
    statusResult = await requestRunpod(
      videoEndpoint,
      `/status/${encodeURIComponent(id)}`,
      runpodApiKey,
      { method: 'GET' },
    )
  } catch {
    return jsonResponse({ error: ERR_VIDEO_STATUS }, 502, corsHeaders)
  }

  if (!statusResult.ok) {
    return jsonResponse({ error: ERR_VIDEO_STATUS }, 502, corsHeaders)
  }

  const payload = statusResult.payload ?? {}
  const status = extractRunpodStatus(payload)
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
      error: isFailureStatus(status) ? ERR_VIDEO_FAILED : null,
      delayTime: payload?.delayTime ?? null,
      executionTime: payload?.executionTime ?? null,
    },
    200,
    corsHeaders,
  )
}

