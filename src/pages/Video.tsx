import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
} from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import type { Session } from '@supabase/supabase-js'
import { isAuthConfigured, supabase } from '../lib/supabaseClient'
import { saveGeneratedAsset } from '../lib/downloadMedia'
import { TopNav } from '../components/TopNav'
import './camera.css'
import './video-studio.css'

type VideoModel = 'akuma'
type VideoModelConfig = {
  id: VideoModel
  label: 'Akuma'
  endpoint: string
}

type VideoLengthSeconds = (typeof VIDEO_LENGTH_OPTIONS)[number]['seconds']

type SubmitVideoResult =
  | { videos: string[]; jobId?: never }
  | { videos?: never; jobId: string }

type PollVideoResult = {
  status: 'done' | 'cancelled'
  videos: string[]
}

type CapturableVideoElement = HTMLVideoElement & {
  captureStream?: (frameRate?: number) => MediaStream
}

const VIDEO_MODELS: Record<VideoModel, VideoModelConfig> = {
  akuma: {
    id: 'akuma',
    label: 'Akuma',
    endpoint: '/api/wan-lora-pack',
  },
}
const DEFAULT_VIDEO_MODEL: VideoModel = 'akuma'
const parseVideoModel = (value: string | null): VideoModel => {
  const normalized = (value ?? '').trim().toLowerCase()
  if (normalized === 'v6' || normalized === 'akuma') return 'akuma'
  return DEFAULT_VIDEO_MODEL
}


const FIXED_STEPS = 4
const FIXED_CFG = 1
const FIXED_FPS = 10
const MAX_SPEECH_TEXT_LENGTH = 100
const MAX_VOICE_DESIGN_LENGTH = 300
const MAX_SFX_PROMPT_LENGTH = 500
const CHAT_AVATAR_ICON = '/apple-touch-icon.png'
const MIX_EXPORT_MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
] as const
const VIDEO_LENGTH_OPTIONS = [
  { seconds: 5, frames: 53, ticketCost: 1, label: '5秒 (1ポイント)' },
  { seconds: 7, frames: 73, ticketCost: 2, label: '7秒 (2ポイント)' },
  { seconds: 10, frames: 101, ticketCost: 3, label: '10秒 (3ポイント)' },
] as const
const EMOJI_MANUAL_GROUPS = [
  {
    title: '音声演出',
    items: [
      ['🤫', '囁き、耳元の音'],
      ['😮‍💨', '吐息、溜息、寝息'],
      ['⏸️', '間、沈黙'],
      ['😂', '笑い（くすくす、含み笑い）'],
      ['😮', '息をのむ'],
      ['😋', '舐める音、哀嚎音、水音'],
      ['👄', 'リップノイズ'],
      ['📞', '電話越し・スピーカー越し風'],
    ],
  },
  {
    title: '感情表現',
    items: [
      ['😢', '嗚咽、泣き声、悲しみ'],
      ['😱', '悲鳴、叫び、絶叫'],
      ['😡', '怒り、不満げ'],
      ['😯', '驚き、感嘆'],
      ['🥺', '懇願するように'],
      ['😳', '恥ずかしそうに、照れながら'],
      ['🙄', '呆れたように'],
      ['😌', '安堵、満足げに'],
    ],
  },
  {
    title: '話し方・トーン',
    items: [
      ['😏', 'からかうように、甘えるように'],
      ['😊', '優しく'],
      ['😴', '眠そうに、気だるげに'],
      ['💫', '声を震わせながら、自信なさげに'],
      ['😮‍💨', '息切れ、荒い息遣い'],
      ['😮‍💧', '慌てて、動揺、緊張、どもり'],
      ['🤯', '酔っ払って'],
      ['🤔', '疑問の声'],
    ],
  },
  {
    title: '速度・リズム',
    items: [
      ['⏩', '早口、一気にまくしたてる'],
      ['🐢', 'ゆっくりと'],
      ['👍', '相槌、頷く音'],
      ['🎵', '鼻歌'],
      ['🤐', '口を塞がれているような声'],
      ['🤧', '咳込み、鼻をすする、くしゃみ'],
      ['🥱', 'あくび'],
      ['😞', '苦しげに'],
    ],
  },
] as const
const DEFAULT_VIDEO_LENGTH_SECONDS = VIDEO_LENGTH_OPTIONS[0].seconds
const resolveVideoLengthOption = (seconds: number) =>
  VIDEO_LENGTH_OPTIONS.find((option) => option.seconds === seconds) ?? VIDEO_LENGTH_OPTIONS[0]
const AKUMA_LOADING_IMAGE = '/media/loading/akuma-loading.jpg'
const OAUTH_REDIRECT_URL =
  import.meta.env.VITE_SUPABASE_REDIRECT_URL ?? (typeof window !== 'undefined' ? window.location.origin : undefined)

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const makePipelineUsageId = () => {
  const timestamp = Date.now()
  const randomPart =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
  const normalized = randomPart.replace(/[^A-Za-z0-9-]/g, '')
  return `media:${timestamp}:${normalized}`
}

const toBase64 = (dataUrl: string) => {
  const parts = dataUrl.split(',')
  return parts.length > 1 ? parts[1] : dataUrl
}

const blobToDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(new Error('データ変換に失敗しました。'))
    reader.readAsDataURL(blob)
  })

const sourceToDataUrl = async (source: string) => {
  if (source.startsWith('data:')) return source
  const response = await fetch(source)
  if (!response.ok) {
    throw new Error('生成動画の取得に失敗しました。')
  }
  const blob = await response.blob()
  return blobToDataUrl(blob)
}

const sourceToBase64 = async (source: string) => {
  const dataUrl = await sourceToDataUrl(source)
  return toBase64(dataUrl)
}

const inferVideoExt = (source: string) => {
  if (source.startsWith('data:video/webm')) return '.webm'
  if (source.startsWith('data:video/quicktime')) return '.mov'
  if (source.startsWith('data:video/x-matroska')) return '.mkv'
  if (source.startsWith('data:video/x-msvideo')) return '.avi'

  try {
    const url = new URL(source)
    const path = url.pathname.toLowerCase()
    if (path.endsWith('.webm')) return '.webm'
    if (path.endsWith('.mov')) return '.mov'
    if (path.endsWith('.mkv')) return '.mkv'
    if (path.endsWith('.avi')) return '.avi'
  } catch {
    // no-op
  }
  return '.mp4'
}

const normalizeVideo = (value: unknown, filename?: string) => {
  if (typeof value !== 'string' || !value) return null
  if (value.startsWith('data:') || value.startsWith('http')) return value
  const ext = filename?.split('.').pop()?.toLowerCase()
  const mime =
    ext === 'webm' ? 'video/webm' : ext === 'gif' ? 'image/gif' : ext === 'mp4' ? 'video/mp4' : 'video/mp4'
  return `data:${mime};base64,${value}`
}

const isVideoLike = (value: unknown, filename?: string) => {
  const ext = filename?.split('.').pop()?.toLowerCase()
  if (ext && ['mp4', 'webm', 'gif'].includes(ext)) return true
  if (typeof value !== 'string') return false
  return value.startsWith('data:video/') || value.startsWith('data:image/gif')
}

const extractVideoList = (payload: any) => {
  const output = payload?.output ?? payload?.result ?? payload
  const nested = output?.output ?? output?.result ?? output?.data ?? payload?.output?.output ?? payload?.result?.output
  const listCandidates = [
    output?.videos,
    output?.outputs,
    output?.output_videos,
    output?.gifs,
    output?.images,
    payload?.videos,
    payload?.gifs,
    payload?.images,
    nested?.videos,
    nested?.outputs,
    nested?.output_videos,
    nested?.gifs,
    nested?.images,
    nested?.data,
  ]

  for (const candidate of listCandidates) {
    if (!Array.isArray(candidate)) continue
    const normalized = candidate
      .map((item: any) => {
        const raw = item?.video ?? item?.data ?? item?.url ?? item
        const name = item?.filename
        if (!isVideoLike(raw, name)) return null
        return normalizeVideo(raw, name)
      })
      .filter(Boolean) as string[]
    if (normalized.length) return normalized
  }

  return []
}

const extractVideo = (payload: any) => {
  if (!payload || typeof payload !== 'object') return null

  if (typeof payload.video === 'string' && payload.video) {
    if (payload.video.startsWith('data:video/')) return payload.video
    return `data:video/mp4;base64,${payload.video}`
  }

  const roots = [
    payload,
    payload?.output,
    payload?.result,
    payload?.output?.output,
    payload?.result?.output,
    payload?.upstream,
    payload?.upstream?.output,
  ]

  for (const root of roots) {
    if (!root || typeof root !== 'object') continue
    const direct =
      root.output_base64 ||
      root.video_base64 ||
      root.output?.output_base64 ||
      root.output?.video_base64
    if (typeof direct === 'string' && direct) {
      return direct.startsWith('data:video/') ? direct : `data:video/mp4;base64,${direct}`
    }
  }

  return null
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

    if (typeof root.audio_base64 === 'string' && root.audio_base64) {
      const mime = typeof root.audio_mime === 'string' && root.audio_mime ? root.audio_mime : 'audio/wav'
      return `data:${mime};base64,${root.audio_base64}`
    }

    const audioObj = root.audio
    if (typeof audioObj === 'string' && audioObj) {
      if (audioObj.startsWith('data:audio/')) return audioObj
      return `data:audio/wav;base64,${audioObj}`
    }

    if (audioObj && typeof audioObj === 'object') {
      const base64 = audioObj.base64 ?? audioObj.data ?? audioObj.audio_base64
      if (typeof base64 === 'string' && base64) {
        const mime = typeof audioObj.mime === 'string' && audioObj.mime ? audioObj.mime : 'audio/wav'
        return `data:${mime};base64,${base64}`
      }
      const url = audioObj.url ?? audioObj.audio_url
      if (typeof url === 'string' && url.startsWith('data:audio/')) return url
    }
  }

  return null
}

const extractErrorMessage = (payload: any) =>
  payload?.error ||
  payload?.message ||
  payload?.output?.error ||
  payload?.result?.error ||
  payload?.output?.output?.error ||
  payload?.result?.output?.error

const normalizeErrorMessage = (value: unknown) => {
  if (!value) return 'リクエストに失敗しました。'

  if (typeof value === 'object') {
    const maybe = value as { error?: unknown; message?: unknown; detail?: unknown }
    const picked = maybe?.error ?? maybe?.message ?? maybe?.detail
    if (typeof picked === 'string' && picked) return picked
    if (value instanceof Error && value.message) return value.message
  }

  const raw = typeof value === 'string' ? value : value instanceof Error ? value.message : String(value)
  const lowered = raw.toLowerCase()
  if (
    lowered.includes('out of memory') ||
    lowered.includes('would exceed allowed memory') ||
    lowered.includes('allocation on device') ||
    lowered.includes('cuda') ||
    lowered.includes('oom')
  ) {
    return 'GPUメモリ不足です。画像サイズを小さくして再試行してください。'
  }

  const trimmed = raw.trim()
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      const parsed = JSON.parse(trimmed)
      const message = parsed?.error || parsed?.message || parsed?.detail
      if (typeof message === 'string' && message) return message
    } catch {
      // ignore parse errors
    }
  }

  return raw
}

const isTicketShortage = (status: number, message: string) => {
  if (status === 402) return true
  const lowered = message.toLowerCase()
  return (
    lowered.includes('no ticket') ||
    lowered.includes('no tickets') ||
    lowered.includes('insufficient_tickets') ||
    lowered.includes('insufficient tickets') ||
    lowered.includes('token') ||
    lowered.includes('credit')
  )
}

const isFailureStatus = (status: string) => {
  const normalized = status.toLowerCase()
  return normalized.includes('fail') || normalized.includes('error') || normalized.includes('cancel')
}

const extractJobId = (payload: any) => payload?.id || payload?.jobId || payload?.job_id || payload?.output?.id

const alignTo16 = (value: number) => Math.max(16, Math.round(value / 16) * 16)
const PORTRAIT_MAX = { width: 576, height: 832 }
const LANDSCAPE_MAX = { width: 832, height: 576 }

const fitWithinBounds = (width: number, height: number, maxWidth: number, maxHeight: number) => {
  const scale = Math.min(1, maxWidth / width, maxHeight / height)
  const scaledWidth = width * scale
  const scaledHeight = height * scale
  const aspect = width / height

  if (aspect >= 1) {
    const targetWidth = Math.min(maxWidth, alignTo16(scaledWidth))
    const targetHeight = Math.min(maxHeight, alignTo16(targetWidth / aspect))
    return { width: targetWidth, height: targetHeight }
  }

  const targetHeight = Math.min(maxHeight, alignTo16(scaledHeight))
  const targetWidth = Math.min(maxWidth, alignTo16(targetHeight * aspect))
  return { width: targetWidth, height: targetHeight }
}

const getTargetSize = (width: number, height: number) => {
  const isPortrait = height >= width
  const bounds = isPortrait ? PORTRAIT_MAX : LANDSCAPE_MAX
  return fitWithinBounds(width, height, bounds.width, bounds.height)
}

const buildPaddedDataUrl = (img: HTMLImageElement, targetWidth: number, targetHeight: number) => {
  const canvas = document.createElement('canvas')
  canvas.width = targetWidth
  canvas.height = targetHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  // Keep full source frame by fitting with letterbox instead of stretching/cropping.
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, targetWidth, targetHeight)
  const scale = Math.min(targetWidth / img.naturalWidth, targetHeight / img.naturalHeight)
  const drawWidth = Math.max(1, Math.round(img.naturalWidth * scale))
  const drawHeight = Math.max(1, Math.round(img.naturalHeight * scale))
  const offsetX = Math.floor((targetWidth - drawWidth) / 2)
  const offsetY = Math.floor((targetHeight - drawHeight) / 2)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, offsetX, offsetY, drawWidth, drawHeight)
  return canvas.toDataURL('image/png')
}

export function Video() {
  const [sourcePreview, setSourcePreview] = useState<string | null>(null)
  const [sourcePayload, setSourcePayload] = useState<string | null>(null)
  const [sourceName, setSourceName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [speechText, setSpeechText] = useState('')
  const [voiceDesign, setVoiceDesign] = useState('')
  const [sfxPrompt, setSfxPrompt] = useState('')
  const [negativePrompt, setNegativePrompt] = useState('')
  const [videoLengthSeconds, setVideoLengthSeconds] = useState<VideoLengthSeconds>(DEFAULT_VIDEO_LENGTH_SECONDS as VideoLengthSeconds)
  const [width, setWidth] = useState(832)
  const [height, setHeight] = useState(576)
  const [displayVideo, setDisplayVideo] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const [session, setSession] = useState<Session | null>(null)
  const [authReady, setAuthReady] = useState(!supabase)
  const [ticketCount, setTicketCount] = useState<number | null>(null)
  const [ticketStatus, setTicketStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [ticketMessage, setTicketMessage] = useState('')
  const [showTicketModal, setShowTicketModal] = useState(false)
  const [errorModalMessage, setErrorModalMessage] = useState<string | null>(null)
  const [isSavingResult, setIsSavingResult] = useState(false)
  const [chatStep, setChatStep] = useState(1)
  const [isPreviewMode, setIsPreviewMode] = useState(false)
  const runIdRef = useRef(0)
  const navigate = useNavigate()
  const location = useLocation()
  const [videoModel, setVideoModel] = useState<VideoModel>(DEFAULT_VIDEO_MODEL)

  const accessToken = session?.access_token ?? ''
  const selectedVideoModel = VIDEO_MODELS[videoModel] ?? VIDEO_MODELS[DEFAULT_VIDEO_MODEL]
  const selectedVideoLength = useMemo(() => resolveVideoLengthOption(videoLengthSeconds), [videoLengthSeconds])
  const speechMixSupported = useMemo(() => {
    if (typeof window === 'undefined') return false
    const hasMediaRecorder = typeof window.MediaRecorder !== 'undefined'
    const hasCaptureStream =
      typeof HTMLVideoElement !== 'undefined' &&
      typeof (HTMLVideoElement.prototype as CapturableVideoElement).captureStream === 'function'
    return hasMediaRecorder && hasCaptureStream
  }, [])
  const hasSpeechText = speechText.trim().length > 0
  const hasSfxPrompt = sfxPrompt.trim().length > 0
  const shouldRunSpeechPipeline = hasSpeechText && speechMixSupported
  const audioPipelineCost = shouldRunSpeechPipeline || hasSfxPrompt ? 1 : 0
  const requiredPoints = selectedVideoLength.ticketCost + audioPipelineCost
  const requiredPointsForRun = requiredPoints
  const canGenerate = Boolean(sourcePayload && prompt.trim() && !isRunning && session)
  const isGif = displayVideo?.startsWith('data:image/gif')
  const loadingSubtitle = useMemo(() => {
    if (shouldRunSpeechPipeline && hasSfxPrompt) {
      return '動画生成 → 効果音生成 → セリフ音声生成 → 合成を順番に実行中です。'
    }
    if (shouldRunSpeechPipeline) {
      return '動画生成 → セリフ音声生成 → 合成を実行中です。'
    }
    if (hasSfxPrompt) {
      return '動画生成 → 効果音生成を実行中です。'
    }
    return '動画生成を実行中です。'
  }, [hasSfxPrompt, shouldRunSpeechPipeline])

  const viewerStyle = useMemo(
    () =>
      ({
        '--studio-aspect': `${Math.max(1, width)} / ${Math.max(1, height)}`,
      }) as CSSProperties,
    [height, width],
  )

  useEffect(() => {
    if (!supabase) {
      setAuthReady(true)
      return
    }

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null)
      setAuthReady(true)
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      setAuthReady(true)
    })

    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!supabase) return
    const hasCode = typeof window !== 'undefined' && window.location.search.includes('code=')
    const hasState = typeof window !== 'undefined' && window.location.search.includes('state=')
    if (!hasCode || !hasState) return

    supabase.auth.exchangeCodeForSession(window.location.href).then(({ error }) => {
      if (error) {
        window.alert(error.message)
        return
      }
      const url = new URL(window.location.href)
      url.searchParams.delete('code')
      url.searchParams.delete('state')
      window.history.replaceState({}, document.title, url.toString())
    })
  }, [])

  const fetchTickets = useCallback(async (token: string) => {
    if (!token) return null

    setTicketStatus('loading')
    setTicketMessage('')

    const res = await fetch('/api/tickets', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = await res.json().catch(() => ({}))

    if (!res.ok) {
      setTicketStatus('error')
      setTicketMessage(data?.error || 'ポイント情報の取得に失敗しました。')
      setTicketCount(null)
      return null
    }

    const nextCount = Number(data?.tickets ?? 0)
    setTicketStatus('idle')
    setTicketMessage('')
    setTicketCount(nextCount)
    return nextCount
  }, [])

  useEffect(() => {
    if (!session || !accessToken) {
      setTicketCount(null)
      setTicketStatus('idle')
      setTicketMessage('')
      return
    }
    void fetchTickets(accessToken)
  }, [accessToken, fetchTickets, session])

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    setVideoModel(parseVideoModel(params.get('model')))
  }, [location.search])

  const canProceedStep = useCallback(
    (step: number) => {
      if (step === 1) return Boolean(sourcePayload)
      if (step === 2) return Boolean(prompt.trim())
      return true
    },
    [prompt, sourcePayload],
  )

  const goToNextStep = useCallback(() => {
    setChatStep((prev) => {
      if (!canProceedStep(prev)) return prev
      return Math.min(prev + 1, 6)
    })
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches) {
      const active = (typeof document !== 'undefined' ? document.activeElement : null) as HTMLElement | null
      window.setTimeout(() => {
        if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
          active.blur()
        }
      }, 0)
      window.requestAnimationFrame(() => {
        window.scrollTo(0, 0)
      })
      window.setTimeout(() => window.scrollTo(0, 0), 80)
    }
  }, [canProceedStep])

  const goToPrevStep = useCallback(() => {
    setChatStep((prev) => Math.max(prev - 1, 1))
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches) {
      const active = (typeof document !== 'undefined' ? document.activeElement : null) as HTMLElement | null
      window.setTimeout(() => {
        if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
          active.blur()
        }
      }, 0)
      window.requestAnimationFrame(() => {
        window.scrollTo(0, 0)
      })
      window.setTimeout(() => window.scrollTo(0, 0), 80)
    }
  }, [])

  const handleGoogleSignIn = useCallback(async () => {
    if (isRunning) return
    if (!supabase || !isAuthConfigured) {
      setStatusMessage('認証設定が未完了です。')
      return
    }

    setStatusMessage('Googleログインへ移動します…')
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: OAUTH_REDIRECT_URL, skipBrowserRedirect: true },
    })
    if (error) {
      setStatusMessage(error.message)
      return
    }
    if (data?.url) {
      window.location.assign(data.url)
      return
    }
    setStatusMessage('認証URLの取得に失敗しました。')
  }, [isRunning])

  const submitVideo = useCallback(
    async (imagePayload: string, token: string): Promise<SubmitVideoResult> => {
      if (!imagePayload) throw new Error('画像が必要です。')

      const input: Record<string, unknown> = {
        mode: 'i2v',
        prompt,
        negative_prompt: negativePrompt,
        width,
        height,
        fps: FIXED_FPS,
        seconds: selectedVideoLength.seconds,
        num_frames: selectedVideoLength.frames,
        steps: FIXED_STEPS,
        cfg: FIXED_CFG,
        seed: 0,
        randomize_seed: true,
        worker_mode: 'comfyui',
        image_name: sourceName || 'input.png',
      }
      input.image_base64 = imagePayload

      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (token) {
        headers.Authorization = `Bearer ${token}`
      }

      const res = await fetch(selectedVideoModel.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ input }),
      })
      const data = await res.json().catch(() => ({}))

      if (!res.ok) {
        const rawMessage = data?.error || data?.message || data?.detail || '生成に失敗しました。'
        const message = normalizeErrorMessage(rawMessage)
        if (isTicketShortage(res.status, message)) {
          setShowTicketModal(true)
          setStatusMessage('ポイントが不足しています。')
          throw new Error('TICKET_SHORTAGE')
        }
        setErrorModalMessage(message)
        throw new Error(message)
      }

      const nextTickets = Number(data?.ticketsLeft ?? data?.tickets_left)
      if (Number.isFinite(nextTickets)) {
        setTicketCount(nextTickets)
      }

      const videos = extractVideoList(data)
      if (videos.length) {
        return { videos }
      }

      const jobId = extractJobId(data)
      if (!jobId) throw new Error('ジョブIDを取得できませんでした。')
      return { jobId }
    },
    [
      height,
      negativePrompt,
      prompt,
      requiredPointsForRun,
      selectedVideoLength,
      selectedVideoModel,
      sourceName,
      width,
    ],
  )

  const pollJob = useCallback(async (jobId: string, runId: number, token?: string): Promise<PollVideoResult> => {
    for (let i = 0; i < 180; i += 1) {
      if (runIdRef.current !== runId) return { status: 'cancelled' as const, videos: [] }

      const headers: Record<string, string> = {}
      if (token) {
        headers.Authorization = `Bearer ${token}`
      }

      const params = new URLSearchParams({
        id: jobId,
        mode: 'i2v',
        seconds: String(selectedVideoLength.seconds),
      })
      const res = await fetch(`${selectedVideoModel.endpoint}?${params.toString()}`, { headers })
      const data = await res.json().catch(() => ({}))

      if (!res.ok) {
        const rawMessage = data?.error || data?.message || data?.detail || 'ステータス確認に失敗しました。'
        const message = normalizeErrorMessage(rawMessage)
        if (isTicketShortage(res.status, message)) {
          setShowTicketModal(true)
          setStatusMessage('ポイントが不足しています。')
          throw new Error('TICKET_SHORTAGE')
        }
        setErrorModalMessage(message)
        throw new Error(message)
      }

      const nextTickets = Number(data?.ticketsLeft ?? data?.tickets_left)
      if (Number.isFinite(nextTickets)) {
        setTicketCount(nextTickets)
      }

      const status = String(data?.status || data?.state || '').toLowerCase()
      const statusError = extractErrorMessage(data)
      if (statusError || isFailureStatus(status)) {
        throw new Error(normalizeErrorMessage(statusError || '生成に失敗しました。'))
      }

      const videos = extractVideoList(data)
      if (videos.length) {
        return { status: 'done' as const, videos }
      }

      await wait(2000 + i * 50)
    }

    throw new Error('生成がタイムアウトしました。')
  }, [selectedVideoLength.seconds, selectedVideoModel])

  const runMMAudioPipeline = useCallback(async (videoSource: string, fxPrompt: string, runId: number, pipelineUsageId?: string) => {
    const videoBase64 = await sourceToBase64(videoSource)
    const videoExt = inferVideoExt(videoSource)
    const authHeaders: Record<string, string> = { 'Content-Type': 'application/json' }
    if (accessToken) {
      authHeaders.Authorization = `Bearer ${accessToken}`
    }
    const res = await fetch('/api/mmaudio', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        input: {
          text: fxPrompt,
          video_base64: videoBase64,
          video_ext: videoExt,
          pipeline_usage_id: pipelineUsageId || undefined,
        },
      }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      const message = normalizeErrorMessage(extractErrorMessage(data) || '効果音付き動画の生成開始に失敗しました。')
      if (isTicketShortage(res.status, message)) {
        setShowTicketModal(true)
        setStatusMessage('ポイントが不足しています。')
        throw new Error('TICKET_SHORTAGE')
      }
      throw new Error(message)
    }

    const immediateVideo = extractVideo(data)
    if (immediateVideo) return immediateVideo

    const jobId = extractJobId(data)
    if (!jobId) {
      throw new Error('効果音付き動画のジョブIDを取得できませんでした。')
    }

    for (let i = 0; i < 180; i += 1) {
      if (runIdRef.current !== runId) return null
      const pollRes = await fetch(`/api/mmaudio?id=${encodeURIComponent(String(jobId))}${pipelineUsageId ? `&pipeline_usage_id=${encodeURIComponent(pipelineUsageId)}` : ``}`, {
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
      })
      const pollData = await pollRes.json().catch(() => ({}))
      if (!pollRes.ok) {
        const message = normalizeErrorMessage(extractErrorMessage(pollData) || '効果音付き動画の状態確認に失敗しました。')
        if (isTicketShortage(pollRes.status, message)) {
          setShowTicketModal(true)
          setStatusMessage('ポイントが不足しています。')
          throw new Error('TICKET_SHORTAGE')
        }
        throw new Error(message)
      }

      const maybeVideo = extractVideo(pollData)
      if (maybeVideo) return maybeVideo

      const status = String(pollData?.status || pollData?.state || '').toUpperCase()
      if (isFailureStatus(status)) {
        throw new Error(normalizeErrorMessage(extractErrorMessage(pollData) || `効果音付き動画の生成に失敗しました: ${status}`))
      }
      await wait(2500)
    }

    throw new Error('効果音付き動画の生成がタイムアウトしました。')
  }, [accessToken])

  const runSpeechPipeline = useCallback(async (text: string, voiceDesignText: string, runId: number, pipelineUsageId?: string) => {
    const speechInput: Record<string, unknown> = {
      text,
      model_variant: 'voicedesign',
      seconds: 20,
      num_steps: 40,
    }
    if (voiceDesignText.trim()) {
      speechInput.reference_text = voiceDesignText.trim()
    }
    if (pipelineUsageId) {
      speechInput.pipeline_usage_id = pipelineUsageId
    }

    const authHeaders: Record<string, string> = { 'Content-Type': 'application/json' }
    if (accessToken) {
      authHeaders.Authorization = `Bearer ${accessToken}`
    }

    const res = await fetch('/api/irodori', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        input: speechInput,
      }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      const message = normalizeErrorMessage(extractErrorMessage(data) || '音声生成の開始に失敗しました。')
      if (isTicketShortage(res.status, message)) {
        setShowTicketModal(true)
        setStatusMessage('ポイントが不足しています。')
        throw new Error('TICKET_SHORTAGE')
      }
      throw new Error(message)
    }

    const immediateAudio = extractAudio(data)
    if (immediateAudio) return immediateAudio

    const jobId = extractJobId(data)
    if (!jobId) {
      throw new Error('音声生成のジョブIDを取得できませんでした。')
    }

    for (let i = 0; i < 180; i += 1) {
      if (runIdRef.current !== runId) return null
      const pollRes = await fetch(`/api/irodori?id=${encodeURIComponent(String(jobId))}${pipelineUsageId ? `&pipeline_usage_id=${encodeURIComponent(pipelineUsageId)}` : ``}`, {
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
      })
      const pollData = await pollRes.json().catch(() => ({}))
      if (!pollRes.ok) {
        const message = normalizeErrorMessage(extractErrorMessage(pollData) || '音声生成の状態確認に失敗しました。')
        if (isTicketShortage(pollRes.status, message)) {
          setShowTicketModal(true)
          setStatusMessage('ポイントが不足しています。')
          throw new Error('TICKET_SHORTAGE')
        }
        throw new Error(message)
      }

      const maybeAudio = extractAudio(pollData)
      if (maybeAudio) return maybeAudio

      const status = String(pollData?.status || pollData?.state || '').toLowerCase()
      if (isFailureStatus(status)) {
        throw new Error(normalizeErrorMessage(extractErrorMessage(pollData) || `音声生成に失敗しました: ${status}`))
      }
      await wait(2500)
    }

    throw new Error('音声生成がタイムアウトしました。')
  }, [accessToken])

  const mixVideoAndSpeech = useCallback(
    async (
      videoSource: string,
      speechAudioDataUrl: string,
      runId: number,
      fxAudioVideoSource?: string | null,
      targetSeconds?: number,
    ) => {
      const videoDataUrl = await sourceToDataUrl(videoSource)
      const fxAudioVideoDataUrl =
        fxAudioVideoSource && fxAudioVideoSource !== videoSource ? await sourceToDataUrl(fxAudioVideoSource) : null
    if (runIdRef.current !== runId) return null

    const videoEl = document.createElement('video')
    videoEl.src = videoDataUrl
    videoEl.preload = 'auto'
    videoEl.muted = true
    videoEl.playsInline = true

    const fxAudioEl = fxAudioVideoDataUrl ? document.createElement('video') : null
    if (fxAudioEl && fxAudioVideoDataUrl) {
      fxAudioEl.src = fxAudioVideoDataUrl
      fxAudioEl.preload = 'auto'
      fxAudioEl.muted = false
      fxAudioEl.playsInline = true
    }

    const speechEl = document.createElement('audio')
    speechEl.src = speechAudioDataUrl
    speechEl.preload = 'auto'

    const metadataTasks: Promise<void>[] = [
      new Promise<void>((resolve, reject) => {
        videoEl.onloadedmetadata = () => resolve()
        videoEl.onerror = () => reject(new Error('動画メタデータの読み込みに失敗しました。'))
      }),
      new Promise<void>((resolve, reject) => {
        speechEl.onloadedmetadata = () => resolve()
        speechEl.onerror = () => reject(new Error('音声メタデータの読み込みに失敗しました。'))
      }),
    ]
    if (fxAudioEl) {
      metadataTasks.push(
        new Promise<void>((resolve, reject) => {
          fxAudioEl.onloadedmetadata = () => resolve()
          fxAudioEl.onerror = () => reject(new Error('効果音動画メタデータの読み込みに失敗しました。'))
        }),
      )
    }
    await Promise.all(metadataTasks)

    const sourceWidth = Math.max(2, Math.floor(videoEl.videoWidth || 0))
    const sourceHeight = Math.max(2, Math.floor(videoEl.videoHeight || 0))
    if (!sourceWidth || !sourceHeight) {
      throw new Error('動画サイズを取得できませんでした。')
    }

    const capturableVideoEl = videoEl as CapturableVideoElement
    if (typeof capturableVideoEl.captureStream !== 'function') {
      throw new Error('このブラウザは最終合成に対応していません。')
    }

    // Force element display size to intrinsic size before capture to avoid accidental downscale/crop.
    videoEl.width = sourceWidth
    videoEl.height = sourceHeight
    videoEl.style.width = `${sourceWidth}px`
    videoEl.style.height = `${sourceHeight}px`

    const sourceStream = capturableVideoEl.captureStream(FIXED_FPS)
    const videoTrack = sourceStream.getVideoTracks()[0]
    if (!videoTrack) {
      throw new Error('動画トラックを取得できませんでした。')
    }

    const audioContext = new AudioContext()
    const destination = audioContext.createMediaStreamDestination()
    const videoSourceNode = audioContext.createMediaElementSource(videoEl)
    const speechSourceNode = audioContext.createMediaElementSource(speechEl)
    const videoGain = audioContext.createGain()
    const speechGain = audioContext.createGain()
    videoGain.gain.value = 1
    speechGain.gain.value = 1
    speechSourceNode.connect(speechGain).connect(destination)
    if (fxAudioEl) {
      const fxSourceNode = audioContext.createMediaElementSource(fxAudioEl)
      const fxGain = audioContext.createGain()
      fxGain.gain.value = 1
      fxSourceNode.connect(fxGain).connect(destination)
    } else {
      videoSourceNode.connect(videoGain).connect(destination)
    }

    const mixedStream = new MediaStream()
    mixedStream.addTrack(videoTrack)
    const mixedAudioTrack = destination.stream.getAudioTracks()[0]
    if (mixedAudioTrack) {
      mixedStream.addTrack(mixedAudioTrack)
    }

    const mimeType = MIX_EXPORT_MIME_CANDIDATES.find((item) => MediaRecorder.isTypeSupported(item)) ?? 'video/webm'
    const recorder = new MediaRecorder(mixedStream, { mimeType, videoBitsPerSecond: 8_000_000 })
    const chunks: BlobPart[] = []

    const stopPromise = new Promise<void>((resolve, reject) => {
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data)
      }
      recorder.onstop = () => resolve()
      recorder.onerror = () => reject(new Error('最終動画の録画に失敗しました。'))
    })

    recorder.start(1000)
    await audioContext.resume()
    videoEl.currentTime = 0
    speechEl.currentTime = 0
    if (fxAudioEl) fxAudioEl.currentTime = 0
    await Promise.allSettled([videoEl.play(), speechEl.play(), fxAudioEl?.play()])

    await new Promise<void>((resolve) => {
      const requestedDurationMs =
        typeof targetSeconds === 'number' && Number.isFinite(targetSeconds) && targetSeconds > 0
          ? Math.floor(targetSeconds * 1000)
          : null
      const naturalDurationMs = Number.isFinite(videoEl.duration) ? Math.floor(videoEl.duration * 1000) : null
      const stopAfterMs = Math.max(1000, requestedDurationMs ?? naturalDurationMs ?? 15000)
      const timer = window.setTimeout(resolve, stopAfterMs)
      videoEl.onended = () => {
        window.clearTimeout(timer)
        resolve()
      }
    })

    speechEl.pause()
    videoEl.pause()
    if (fxAudioEl) fxAudioEl.pause()
    if (recorder.state !== 'inactive') recorder.stop()
    await stopPromise

    sourceStream.getTracks().forEach((track: MediaStreamTrack) => track.stop())
    mixedStream.getTracks().forEach((track: MediaStreamTrack) => track.stop())
    await audioContext.close().catch(() => undefined)

    const mixedBlob = new Blob(chunks, { type: mimeType })
    return URL.createObjectURL(mixedBlob)
    },
    [],
  )

  const startGeneration = useCallback(
    async (imagePayload: string) => {
      if (!imagePayload) return
      if (!session) {
        setStatusMessage('先にGoogleログインしてください。')
        return
      }

      const runId = runIdRef.current + 1
      runIdRef.current = runId
      setIsRunning(true)
      setStatusMessage('動画を生成中です…')
      setDisplayVideo(null)
      let fallbackVideo: string | null = null

      try {
        const trimmedSpeech = speechText.trim()
        const trimmedSfx = sfxPrompt.trim()
        const hasSpeechInput = trimmedSpeech.length > 0
        const shouldRunSpeech = hasSpeechInput && speechMixSupported
        const shouldRunSfx = trimmedSfx.length > 0
        if (hasSpeechInput && !shouldRunSpeech) {
          setStatusMessage('このブラウザでは音声合成に対応していないため、セリフをスキップして続行します。')
        }
        const pipelineUsageId = shouldRunSpeech || shouldRunSfx ? makePipelineUsageId() : ""
        let baseVideo: string | null = null
        const submitted = await submitVideo(imagePayload, accessToken)
        if (runIdRef.current !== runId) return

        if ('videos' in submitted && Array.isArray(submitted.videos) && submitted.videos.length) {
          baseVideo = submitted.videos[0]
        } else if ('jobId' in submitted && typeof submitted.jobId === 'string' && submitted.jobId) {
          const polled = await pollJob(submitted.jobId, runId, accessToken)
          if (runIdRef.current !== runId) return
          if (polled.status === 'done' && polled.videos.length) {
            baseVideo = polled.videos[0]
          }
        }

        if (!baseVideo) {
          throw new Error('動画生成結果を取得できませんでした。')
        }
        fallbackVideo = baseVideo

        if (!shouldRunSpeech && !shouldRunSfx) {
          setDisplayVideo(baseVideo)
          setStatusMessage('動画生成が完了しました。')
          if (accessToken) {
            await fetchTickets(accessToken)
          }
          return
        }

        let pipelineVideo = baseVideo
        if (shouldRunSfx) {
          setStatusMessage('効果音付き動画を生成中です…')
          const fxVideo = await runMMAudioPipeline(baseVideo, trimmedSfx, runId, pipelineUsageId)
          if (!fxVideo || runIdRef.current !== runId) return
          pipelineVideo = fxVideo
          fallbackVideo = pipelineVideo
        }

        if (shouldRunSpeech) {
          setStatusMessage('セリフ音声を生成中です…')
          const speechAudio = await runSpeechPipeline(trimmedSpeech, voiceDesign.trim(), runId, pipelineUsageId)
          if (!speechAudio || runIdRef.current !== runId) return

          setStatusMessage('動画と音声を合成中です…')
          const mixedVideo = await mixVideoAndSpeech(
            baseVideo,
            speechAudio,
            runId,
            shouldRunSfx ? pipelineVideo : null,
            selectedVideoLength.seconds,
          )
          if (!mixedVideo || runIdRef.current !== runId) return
          pipelineVideo = mixedVideo
          fallbackVideo = pipelineVideo
        }

        setDisplayVideo(pipelineVideo)
        setStatusMessage('動画生成が完了しました。')

        if (accessToken) {
          await fetchTickets(accessToken)
        }
      } catch (error) {
        if (runIdRef.current !== runId) return
        const message = normalizeErrorMessage(error instanceof Error ? error.message : error)
        if (message !== 'TICKET_SHORTAGE') {
          if (fallbackVideo) {
            setDisplayVideo(fallbackVideo)
            setStatusMessage(`一部処理でエラーが発生したため、途中結果を表示しています。${message}`)
          } else {
            setStatusMessage(message)
          }
        }
      } finally {
        if (runIdRef.current === runId) {
          setIsRunning(false)
        }
      }
    },
    [
      accessToken,
      fetchTickets,
      mixVideoAndSpeech,
      pollJob,
      runMMAudioPipeline,
      runSpeechPipeline,
      session,
      sfxPrompt,
      speechMixSupported,
      speechText,
      voiceDesign,
      submitVideo,
    ],
  )

  const clearImage = useCallback(() => {
    setSourcePreview(null)
    setSourcePayload(null)
    setSourceName('')
    setDisplayVideo(null)
    setStatusMessage('')
    setIsPreviewMode(false)
  }, [])

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result || '')
      const img = new Image()
      img.onload = () => {
        const { width: targetWidth, height: targetHeight } = getTargetSize(img.naturalWidth, img.naturalHeight)
        const paddedDataUrl = buildPaddedDataUrl(img, targetWidth, targetHeight) ?? dataUrl
        setWidth(targetWidth)
        setHeight(targetHeight)
        setSourcePreview(paddedDataUrl)
        setSourcePayload(toBase64(paddedDataUrl))
        setSourceName(file.name)
        setStatusMessage(session ? '画像を読み込みました。プロンプトを入力して生成できます。' : '先にGoogleログインしてください。')
      }
      img.src = dataUrl
    }
    reader.readAsDataURL(file)
  }

  const handleGenerate = async () => {
    if (!sourcePayload || isRunning) return
    if (!session) {
      setStatusMessage('先にGoogleログインしてください。')
      return
    }
    if (!prompt.trim()) {
      setStatusMessage('プロンプトを入力してください。')
      return
    }

    if (ticketStatus === 'loading') {
      setStatusMessage('ポイントを確認中...')
      return
    }

    if (accessToken) {
      setStatusMessage('ポイントを確認中...')
      const latestCount = await fetchTickets(accessToken)
      if (latestCount !== null && latestCount < requiredPointsForRun) {
        setShowTicketModal(true)
        return
      }
    } else if (ticketCount === null) {
      setStatusMessage('ポイントを確認中...')
      return
    } else if (ticketCount < requiredPointsForRun) {
      setShowTicketModal(true)
      return
    }
    setIsPreviewMode(true)
    await startGeneration(sourcePayload)
  }

  const handleSaveResult = useCallback(async () => {
    if (!displayVideo || isSavingResult) return
    setIsSavingResult(true)
    try {
      await saveGeneratedAsset({
        source: displayVideo,
        filenamePrefix: 'akumaai-video',
        fallbackExtension: isGif ? 'gif' : 'mp4',
      })
    } finally {
      setIsSavingResult(false)
    }
  }, [displayVideo, isGif, isSavingResult])

  if (!authReady) {
    return (
      <div className="studio-page">
        <TopNav />
        <div className="studio-loader">読み込み中...</div>
      </div>
    )
  }

  return (
    <div className="studio-page">
      <TopNav />
      <main className="studio-wrap studio-wrap--single">
        {!isPreviewMode ? (
          <section className="studio-panel studio-panel--controls studio-panel--chat-only">
          <header className="studio-heading">
            <h1>動画生成チャット</h1>
            <p>手順に沿って入力するだけで、動画生成を完了できます。</p>
          </header>

          <p className="studio-token-line">
            ポイント:
            <strong className="studio-token-value">
              {session ? ticketCount ?? 0 : '--'}
              <span className="studio-token-icon" aria-hidden="true">
                ♦
              </span>
            </strong>
          </p>
          <div className="studio-ticket-row">
            <span className="studio-ticket-label">必要ポイント</span>
            <strong className="studio-ticket-value">{requiredPoints}</strong>
            <span className="studio-ticket-cost">
              {selectedVideoLength.seconds + '秒 / ' + (audioPipelineCost > 0 ? '音声パイプライン(+' + audioPipelineCost + ')' : '動画のみ')}
            </span>
          </div>

          {ticketStatus === 'error' && ticketMessage && <p className="studio-inline-error">{ticketMessage}</p>}

          <section className="studio-chat-flow" aria-label="生成チャット">
            {chatStep === 1 && (
              <article className="studio-chat-step">
                <div className="studio-chat-row studio-chat-row--assistant">
                  <img className="studio-chat-avatar" src={CHAT_AVATAR_ICON} alt="" aria-hidden="true" />
                  <div className="studio-chat-bubble">
                    <strong>{session ? '1. 素材画像アップロード' : '無料登録してお試し生成'}</strong>
                    <p>{session ? 'まず素材画像を1枚選択してください。' : 'Googleアカウントによる登録で３回無料生成できます。'}</p>
                  </div>
                </div>
                <div className="studio-chat-row studio-chat-row--user">
                  <div className="studio-chat-bubble studio-chat-bubble--user">
                    {session ? (
                      <>
                        <label className="studio-upload">
                          <input type="file" accept="image/*" onChange={handleFileChange} />
                          <div className="studio-upload-inner">
                            <strong>{sourceName || '元画像をアップロード'}</strong>
                            <span>推奨: 縦832x576以内、横576x832以内</span>
                          </div>
                        </label>
                        {sourcePreview && (
                          <div className="studio-thumb-wrap">
                            <img src={sourcePreview} alt="元画像プレビュー" className="studio-thumb" />
                            <button type="button" className="studio-thumb-remove" onClick={clearImage} aria-label="画像を削除">
                              削除
                            </button>
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="studio-login-cta">
                        <button type="button" className="studio-btn studio-btn--primary" onClick={handleGoogleSignIn}>
                          Googleで登録 / ログイン
                        </button>
                        {!isAuthConfigured && <p className="studio-field-note">認証設定が未完了です。</p>}
                      </div>
                    )}
                  </div>
                </div>
              </article>
            )}

            {chatStep === 2 && (
              <article className="studio-chat-step">
                <div className="studio-chat-row studio-chat-row--assistant">
                  <img className="studio-chat-avatar" src={CHAT_AVATAR_ICON} alt="" aria-hidden="true" />
                  <div className="studio-chat-bubble">
                    <strong>2. モーション指示とネガティブ</strong>
                    <p>プロンプトは必須です。除外要素は任意です。</p>
                  </div>
                </div>
                <div className="studio-chat-row studio-chat-row--user">
                  <div className="studio-chat-bubble studio-chat-bubble--user">
                    <label className="studio-field">
                      <span>プロンプト</span>
                      <textarea
                        rows={4}
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        placeholder="例:女性のアップ。場面転換。男性が現れて握手"
                      />
                    </label>
                    <label className="studio-field">
                      <span>除外要素 (任意)</span>
                      <textarea
                        rows={3}
                        value={negativePrompt}
                        onChange={(e) => setNegativePrompt(e.target.value)}
                        placeholder="bad quality,low quality"
                      />
                    </label>
                  </div>
                </div>
              </article>
            )}

            {chatStep === 3 && (
              <article className="studio-chat-step">
                <div className="studio-chat-row studio-chat-row--assistant">
                  <img className="studio-chat-avatar" src={CHAT_AVATAR_ICON} alt="" aria-hidden="true" />
                  <div className="studio-chat-bubble">
                    <strong>3. セリフとボイスデザイン</strong>
                    <p>任意です。空欄ならセリフ生成をスキップします。</p>
                  </div>
                </div>
                <div className="studio-chat-row studio-chat-row--user">
                  <div className="studio-chat-bubble studio-chat-bubble--user">
                    <label className="studio-field">
                      <span>セリフ ({speechText.trim().length}/{MAX_SPEECH_TEXT_LENGTH})</span>
                      <textarea
                        rows={3}
                        maxLength={MAX_SPEECH_TEXT_LENGTH}
                        value={speechText}
                        onChange={(e) => setSpeechText(e.target.value)}
                        placeholder="例:はっ💋はあっ💋疲れるわね"
                      />
                    </label>
                    <label className="studio-field">
                      <span>ボイスデザイン (任意) ({voiceDesign.trim().length}/{MAX_VOICE_DESIGN_LENGTH})</span>
                      <textarea
                        rows={3}
                        maxLength={MAX_VOICE_DESIGN_LENGTH}
                        value={voiceDesign}
                        onChange={(e) => setVoiceDesign(e.target.value)}
                        placeholder="例:低い声の女の子。からかうようなしゃべり方。"
                      />
                    </label>

                    <section className="studio-emoji-manual" aria-label="ボイスデザイン入力マニュアル">
                      <h4>ボイスデザイン入力マニュアル</h4>
                      <p>セリフ内の絵文字で感情や話し方、音の演出を調整できます。</p>
                      <div className="studio-emoji-manual__groups">
                        {EMOJI_MANUAL_GROUPS.map((group) => (
                          <div key={group.title} className="studio-emoji-manual__group">
                            <h5>{group.title}</h5>
                            <ul>
                              {group.items.map(([emoji, meaning]) => (
                                <li key={`${group.title}-${emoji}`}>
                                  <span className="studio-emoji-manual__emoji" aria-hidden="true">
                                    {emoji}
                                  </span>
                                  <span>{meaning}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    </section>
                  </div>
                </div>
              </article>
            )}

            {chatStep === 4 && (
              <article className="studio-chat-step">
                <div className="studio-chat-row studio-chat-row--assistant">
                  <img className="studio-chat-avatar" src={CHAT_AVATAR_ICON} alt="" aria-hidden="true" />
                  <div className="studio-chat-bubble">
                    <strong>4. 効果音</strong>
                    <p>任意です。空欄なら効果音生成をスキップします。</p>
                  </div>
                </div>
                <div className="studio-chat-row studio-chat-row--user">
                  <div className="studio-chat-bubble studio-chat-bubble--user">
                    <label className="studio-field">
                      <span>効果音プロンプト ({sfxPrompt.trim().length}/{MAX_SFX_PROMPT_LENGTH})</span>
                      <textarea
                        rows={3}
                        maxLength={MAX_SFX_PROMPT_LENGTH}
                        value={sfxPrompt}
                        onChange={(e) => setSfxPrompt(e.target.value)}
                        placeholder="例: footsteps on wet street, distant thunder, soft city ambience"
                      />
                    </label>
                  </div>
                </div>
              </article>
            )}

            {chatStep === 5 && (
              <article className="studio-chat-step">
                <div className="studio-chat-row studio-chat-row--assistant">
                  <img className="studio-chat-avatar" src={CHAT_AVATAR_ICON} alt="" aria-hidden="true" />
                  <div className="studio-chat-bubble">
                    <strong>5. 秒数選択</strong>
                    <p>5秒 / 7秒 / 10秒を選択してください。</p>
                  </div>
                </div>
                <div className="studio-chat-row studio-chat-row--user">
                  <div className="studio-chat-bubble studio-chat-bubble--user">
                    <div className="studio-duration-row">
                      <span>動画の長さ</span>
                      <div className="studio-duration-options" role="radiogroup" aria-label="動画の長さ">
                        {VIDEO_LENGTH_OPTIONS.map((option) => (
                          <button
                            key={option.seconds}
                            type="button"
                            role="radio"
                            aria-checked={videoLengthSeconds === option.seconds}
                            className={`studio-duration-option${videoLengthSeconds === option.seconds ? ' is-active' : ''}`}
                            onClick={() => setVideoLengthSeconds(option.seconds)}
                            disabled={isRunning}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </article>
            )}

            {chatStep === 6 && (
              <article className="studio-chat-step">
                <div className="studio-chat-row studio-chat-row--assistant">
                  <img className="studio-chat-avatar" src={CHAT_AVATAR_ICON} alt="" aria-hidden="true" />
                  <div className="studio-chat-bubble">
                    <strong>6. 設定確認</strong>
                    <p>内容を確認して生成を実行してください。</p>
                  </div>
                </div>
                <div className="studio-chat-row studio-chat-row--user">
                  <div className="studio-chat-bubble studio-chat-bubble--user">
                    <ul className="studio-confirm-list">
                      <li>{`素材画像: ${sourceName || '未設定'}`}</li>
                      <li>{`プロンプト: ${prompt.trim() || '未設定'}`}</li>
                      <li>{`セリフ: ${hasSpeechText ? 'あり' : 'なし'}`}</li>
                      <li>{`効果音: ${hasSfxPrompt ? 'あり' : 'なし'}`}</li>
                      <li>{`動画秒数: ${selectedVideoLength.seconds}秒 (${selectedVideoLength.ticketCost}ポイント)`}</li>
                      <li>{`追加ポイント: ${audioPipelineCost}`}</li>
                      <li>{`合計必要ポイント: ${requiredPoints}`}</li>
                    </ul>
                    <p className="studio-field-note">
                      {hasSpeechText || hasSfxPrompt
                        ? 'セリフ/効果音のどちらかがあるため +1 ポイント加算されます。'
                        : 'セリフ/効果音が空欄なので、動画生成のみ実行します。'}
                    </p>
                    {!session && <p className="studio-field-note">生成にはGoogleログインが必要です。</p>}
                  </div>
                </div>
              </article>
            )}
          </section>

          <div className="studio-generate-dock">
            <div className="studio-chat-nav">
              <span className="studio-chat-progress">{`${chatStep} / 6`}</span>
              <div className="studio-actions">
                <button type="button" className="studio-btn studio-btn--ghost" onClick={goToPrevStep} disabled={chatStep === 1 || isRunning}>
                  戻る
                </button>
                {chatStep < 6 ? (
                  <button
                    type="button"
                    className="studio-btn studio-btn--primary"
                    onClick={goToNextStep}
                    disabled={!canProceedStep(chatStep) || isRunning}
                  >
                    次へ
                  </button>
                ) : (
                  <button type="button" className="studio-btn studio-btn--primary" onClick={handleGenerate} disabled={!canGenerate}>
                    {isRunning ? '生成中...' : '生成'}
                  </button>
                )}
              </div>
            </div>
            {statusMessage && <p className="studio-status">{statusMessage}</p>}
          </div>
          </section>
        ) : (
          <section className="studio-panel studio-panel--preview studio-panel--preview-only">
            <div className="studio-preview-head">
              <h2>プレビュー</h2>
              {!isRunning && (
                <button
                  type="button"
                  className="studio-btn studio-btn--ghost"
                  onClick={() => setIsPreviewMode(false)}
                >
                  入力に戻る
                </button>
              )}
            </div>

            <div className="studio-canvas" style={viewerStyle}>
              {isRunning ? (
                <div className="studio-loading studio-loading--video" role="status" aria-live="polite">
                  <div className="studio-loading-media" aria-hidden="true">
                    <img src={AKUMA_LOADING_IMAGE} alt="" loading="eager" />
                  </div>
                  <p className="studio-loading__title">生成中です</p>
                  <p className="studio-loading__subtitle">{loadingSubtitle}</p>
                  <div className="studio-loading-meter" aria-hidden="true">
                    <div className="studio-loading-meter__track">
                      <div className="studio-loading-meter__bar" />
                    </div>
                  </div>
                </div>
              ) : displayVideo ? (
                <div className="studio-result-media">
                  <button
                    type="button"
                    className="studio-save-btn"
                    onClick={handleSaveResult}
                    disabled={isSavingResult}
                  >
                    {isSavingResult ? 'Saving...' : 'Save'}
                  </button>
                  {isGif ? <img src={displayVideo} alt="Generated video" /> : <video controls src={displayVideo} />}
                </div>
              ) : (
                <div className="studio-preview-idle">
                  <p>{statusMessage || '結果を取得できませんでした。入力に戻って再試行してください。'}</p>
                  <button
                    type="button"
                    className="studio-btn studio-btn--ghost"
                    onClick={() => setIsPreviewMode(false)}
                  >
                    入力に戻る
                  </button>
                </div>
              )}
            </div>
            {statusMessage && <p className="studio-status studio-status--preview">{statusMessage}</p>}
          </section>
        )}

        <nav className="studio-legal-links" aria-label="リーガルリンク">
          <Link className="studio-legal-links__item" to="/terms">
            利用規約
          </Link>
          <Link className="studio-legal-links__item" to="/tokushoho">
            特商法
          </Link>
        </nav>
      </main>

      {showTicketModal && (
        <div className="studio-modal-overlay" role="dialog" aria-modal="true">
          <div className="studio-modal-card">
            <h3>ポイント不足</h3>
            <p>{`この設定では${requiredPointsForRun}ポイントが必要です。購入ページで追加してください。`}</p>
            <div className="studio-modal-actions">
              <button type="button" className="studio-btn studio-btn--ghost" onClick={() => setShowTicketModal(false)}>
                閉じる
              </button>
              <button type="button" className="studio-btn studio-btn--primary" onClick={() => navigate('/purchase')}>
                購入ページへ
              </button>
            </div>
          </div>
        </div>
      )}

      {errorModalMessage && (
        <div className="studio-modal-overlay" role="dialog" aria-modal="true">
          <div className="studio-modal-card">
            <h3>エラー</h3>
            <p>{errorModalMessage}</p>
            <div className="studio-modal-actions">
              <button type="button" className="studio-btn studio-btn--primary" onClick={() => setErrorModalMessage(null)}>
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}





