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

type VideoModel = 'meltaih'
type VideoModelConfig = {
  id: VideoModel
  label: string
  endpoint: string
}

type VideoLengthSeconds = (typeof VIDEO_LENGTH_OPTIONS)[number]['seconds']
type EnhancementStrengthMode = 'low' | 'high'

type SubmitVideoResult =
  | { videos: string[]; jobId?: never }
  | { videos?: never; jobId: string }

type PollVideoResult = {
  status: 'done' | 'cancelled'
  videos: string[]
}

const VIDEO_MODELS: Record<VideoModel, VideoModelConfig> = {
  meltaih: {
    id: 'meltaih',
    label: 'MeltAI-H',
    endpoint: '/api/wan-lora-pack',
  },
}
const DEFAULT_VIDEO_MODEL: VideoModel = 'meltaih'
const parseVideoModel = (value: string | null): VideoModel => {
  const normalized = (value ?? '').trim().toLowerCase()
  if (normalized === 'v6' || normalized === 'meltaih') return 'meltaih'
  return DEFAULT_VIDEO_MODEL
}


const FIXED_STEPS = 4
const FIXED_CFG = 1
const FIXED_FPS = 10
const VIDEO_LENGTH_OPTIONS = [
  { seconds: 5, frames: 53, ticketCost: 1, label: '5秒 / 1 Gem' },
  { seconds: 8, frames: 81, ticketCost: 3, label: '8秒 / 3 Gem' },
] as const
const DEFAULT_VIDEO_LENGTH_SECONDS = VIDEO_LENGTH_OPTIONS[0].seconds
const EXTENDED_VIDEO_LENGTH_SECONDS = VIDEO_LENGTH_OPTIONS[1].seconds
const resolveVideoLengthOption = (seconds: number) =>
  VIDEO_LENGTH_OPTIONS.find((option) => option.seconds === seconds) ?? VIDEO_LENGTH_OPTIONS[0]
const OAUTH_REDIRECT_URL =
  import.meta.env.VITE_SUPABASE_REDIRECT_URL ?? (typeof window !== 'undefined' ? window.location.origin : undefined)
const DAILY_BONUS_AMOUNT = 3

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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
  if (status === 401 || status === 403) return false
  const lowered = message.toLowerCase()
  return (
    lowered.includes('no ticket') ||
    lowered.includes('no tickets') ||
    lowered.includes('insufficient_tickets') ||
    lowered.includes('insufficient tickets')
  )
}

const isFailureStatus = (status: string) => {
  const normalized = status.toLowerCase()
  return normalized.includes('fail') || normalized.includes('error') || normalized.includes('cancel')
}

const formatRemaining = (targetIso: string | null) => {
  if (!targetIso) return ''
  const target = new Date(targetIso).getTime()
  if (!Number.isFinite(target)) return ''
  const diff = target - Date.now()
  if (diff <= 0) return ''
  const hours = Math.floor(diff / 3_600_000)
  const minutes = Math.floor((diff % 3_600_000) / 60_000)
  return `${hours}時間${minutes.toString().padStart(2, '0')}分`
}

const formatRemainingSeconds = (value: unknown) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return ''
  const seconds = Math.max(0, Math.floor(parsed))
  if (seconds <= 0) return ''
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  return `${hours}時間${minutes.toString().padStart(2, '0')}分`
}

const isDailyClaimAvailable = (canClaim: boolean, targetIso: string | null, remainingSeconds?: unknown) => {
  if (canClaim) return true
  const parsed = Number(remainingSeconds)
  if (Number.isFinite(parsed) && parsed <= 0) return true
  if (!targetIso) return false
  const target = new Date(targetIso).getTime()
  return Number.isFinite(target) && target <= Date.now()
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
  const [negativePrompt, setNegativePrompt] = useState('')
  const [enhancementStrengthMode, setEnhancementStrengthMode] = useState<EnhancementStrengthMode>('low')
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
  const [dailyClaimStatus, setDailyClaimStatus] = useState<string | null>(null)
  const [dailyNextEligibleAt, setDailyNextEligibleAt] = useState<string | null>(null)
  const [dailyRemainingSeconds, setDailyRemainingSeconds] = useState<number | null>(null)
  const [dailyCanClaim, setDailyCanClaim] = useState(false)
  const [dailyCountdown, setDailyCountdown] = useState('')
  const [isLoadingDailyStatus, setIsLoadingDailyStatus] = useState(false)
  const [isClaimingDaily, setIsClaimingDaily] = useState(false)
  const [showTicketModal, setShowTicketModal] = useState(false)
  const [errorModalMessage, setErrorModalMessage] = useState<string | null>(null)
  const [isSavingResult, setIsSavingResult] = useState(false)
  const runIdRef = useRef(0)
  const navigate = useNavigate()
  const location = useLocation()
  const [videoModel, setVideoModel] = useState<VideoModel>(DEFAULT_VIDEO_MODEL)

  const accessToken = session?.access_token ?? ''
  const selectedVideoModel = VIDEO_MODELS[videoModel] ?? VIDEO_MODELS[DEFAULT_VIDEO_MODEL]
  const selectedVideoLength = useMemo(() => resolveVideoLengthOption(videoLengthSeconds), [videoLengthSeconds])
  const isExtendedVideoLength = videoLengthSeconds === EXTENDED_VIDEO_LENGTH_SECONDS
  const requiredPoints = selectedVideoLength.ticketCost
  const requiredPointsForRun = requiredPoints
  const canGenerate = Boolean(sourcePayload && prompt.trim() && !isRunning && session)
  const isGif = displayVideo?.startsWith('data:image/gif')
  const loadingSubtitle = '動画生成を実行中です。'
  const effectiveDailyCanClaim = isDailyClaimAvailable(dailyCanClaim, dailyNextEligibleAt, dailyRemainingSeconds)
  const dailyBonusButtonLabel = isClaimingDaily
    ? '受取中...'
    : isLoadingDailyStatus
      ? '確認中...'
      : effectiveDailyCanClaim
        ? 'デイリーを受け取る'
        : 'ボーナス待機中'

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
      setTicketMessage(data?.error || 'Gem情報の取得に失敗しました。')
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
      setDailyCanClaim(false)
      setDailyNextEligibleAt(null)
      setDailyRemainingSeconds(null)
      setDailyCountdown('')
      setDailyClaimStatus(null)
      return
    }
    void fetchTickets(accessToken)
  }, [accessToken, fetchTickets, session])

  const fetchDailyBonusStatus = useCallback(async (token: string) => {
    if (!token) return
    setIsLoadingDailyStatus(true)
    try {
      const res = await fetch('/api/daily-bonus', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setDailyCanClaim(false)
        setDailyNextEligibleAt(null)
        setDailyRemainingSeconds(null)
        setDailyCountdown('')
        return
      }
      const nextEligibleAt = data?.next_eligible_at ? String(data.next_eligible_at) : null
      const remainingSecondsValue = Number(data?.remaining_seconds)
      const remainingSeconds = Number.isFinite(remainingSecondsValue)
        ? Math.max(0, Math.floor(remainingSecondsValue))
        : null
      const canClaim = isDailyClaimAvailable(Boolean(data?.can_claim), nextEligibleAt, remainingSeconds)
      setDailyCanClaim(canClaim)
      setDailyNextEligibleAt(nextEligibleAt)
      setDailyRemainingSeconds(remainingSeconds)
      if (!canClaim && nextEligibleAt) {
        const remainingText = formatRemainingSeconds(remainingSeconds)
        setDailyCountdown(remainingText || formatRemaining(nextEligibleAt))
      } else {
        setDailyCountdown('')
      }
    } finally {
      setIsLoadingDailyStatus(false)
    }
  }, [])

  useEffect(() => {
    if (!session || !accessToken) return
    void fetchDailyBonusStatus(accessToken)
  }, [accessToken, fetchDailyBonusStatus, session])

  useEffect(() => {
    if (!session || !accessToken) return
    const timer = window.setInterval(() => {
      void fetchDailyBonusStatus(accessToken)
    }, 60_000)
    return () => window.clearInterval(timer)
  }, [accessToken, fetchDailyBonusStatus, session])

  useEffect(() => {
    if (!dailyNextEligibleAt || dailyCanClaim) {
      setDailyCountdown('')
      return
    }
    let didRefresh = false
    const update = () => {
      const remain = formatRemaining(dailyNextEligibleAt)
      setDailyCountdown(remain)
      if (!remain && !didRefresh && accessToken) {
        didRefresh = true
        setDailyCanClaim(true)
        void fetchDailyBonusStatus(accessToken)
      }
    }
    update()
    const timer = window.setInterval(update, 15_000)
    return () => window.clearInterval(timer)
  }, [accessToken, dailyCanClaim, dailyNextEligibleAt, fetchDailyBonusStatus])

  useEffect(() => {
    if (!session || !accessToken) return

    const refreshIfVisible = () => {
      if (document.visibilityState === 'visible') {
        void fetchDailyBonusStatus(accessToken)
      }
    }

    window.addEventListener('focus', refreshIfVisible)
    document.addEventListener('visibilitychange', refreshIfVisible)
    return () => {
      window.removeEventListener('focus', refreshIfVisible)
      document.removeEventListener('visibilitychange', refreshIfVisible)
    }
  }, [accessToken, fetchDailyBonusStatus, session])

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    setVideoModel(parseVideoModel(params.get('model')))
  }, [location.search])

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

  const handleClaimDaily = useCallback(async () => {
    if (!accessToken || !session) {
      setDailyClaimStatus('ログインしてください。')
      return
    }
    if (isClaimingDaily) return
    setIsClaimingDaily(true)
    setDailyClaimStatus(null)
    try {
      const res = await fetch('/api/daily-bonus', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setDailyClaimStatus(normalizeErrorMessage(data?.error ?? data?.message ?? data?.detail))
        return
      }
      if (data?.granted) {
        setDailyClaimStatus(`無料${DAILY_BONUS_AMOUNT} Gemを付与しました。`)
        void fetchTickets(accessToken)
        setDailyCanClaim(false)
        setDailyNextEligibleAt(data?.next_eligible_at ? String(data.next_eligible_at) : null)
        const remainingSecondsValue = Number(data?.remaining_seconds)
        setDailyRemainingSeconds(
          Number.isFinite(remainingSecondsValue) ? Math.max(0, Math.floor(remainingSecondsValue)) : null,
        )
      } else {
        const remainingSecondsValue = Number(data?.remaining_seconds)
        const remainingSeconds = Number.isFinite(remainingSecondsValue)
          ? Math.max(0, Math.floor(remainingSecondsValue))
          : null
        const remain = formatRemainingSeconds(remainingSeconds) || formatRemaining(data?.next_eligible_at ?? null)
        setDailyClaimStatus(remain ? `次の受け取りまで ${remain}` : 'まだ受け取れません。')
        setDailyCanClaim(false)
        setDailyNextEligibleAt(data?.next_eligible_at ? String(data.next_eligible_at) : null)
        setDailyRemainingSeconds(remainingSeconds)
      }
    } catch (error) {
      setDailyClaimStatus(normalizeErrorMessage(error instanceof Error ? error.message : error))
    } finally {
      setIsClaimingDaily(false)
      void fetchDailyBonusStatus(accessToken)
    }
  }, [accessToken, fetchDailyBonusStatus, fetchTickets, isClaimingDaily, session])

  const submitVideo = useCallback(
    async (imagePayload: string, token: string): Promise<SubmitVideoResult> => {
      if (!imagePayload) throw new Error('画像が必要です。')

      const input: Record<string, unknown> = {
        mode: 'i2v',
        prompt,
        negative_prompt: negativePrompt,
        enhancement_strength: enhancementStrengthMode,
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
          setStatusMessage('Gemが不足しています。')
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
      enhancementStrengthMode,
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
          setStatusMessage('Gemが不足しています。')
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
        setDisplayVideo(baseVideo)
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
      pollJob,
      session,
      submitVideo,
    ],
  )

  const clearImage = useCallback(() => {
    setSourcePreview(null)
    setSourcePayload(null)
    setSourceName('')
    setDisplayVideo(null)
    setStatusMessage('')
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
      setStatusMessage('Gemを確認中...')
      return
    }

    if (accessToken) {
      setStatusMessage('Gemを確認中...')
      const latestCount = await fetchTickets(accessToken)
      if (latestCount !== null && latestCount < requiredPointsForRun) {
        setShowTicketModal(true)
        return
      }
    } else if (ticketCount === null) {
      setStatusMessage('Gemを確認中...')
      return
    } else if (ticketCount < requiredPointsForRun) {
      setShowTicketModal(true)
      return
    }
    await startGeneration(sourcePayload)
  }

  const handleSaveResult = useCallback(async () => {
    if (!displayVideo || isSavingResult) return
    setIsSavingResult(true)
    try {
      await saveGeneratedAsset({
        source: displayVideo,
        filenamePrefix: 'meltai-h-video',
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
      <main className="studio-wrap">
        <section className="studio-panel studio-panel--controls">
          <header className="studio-heading">
            <h1>動画生成エリア</h1>
          </header>

          {session && (
            <section className="studio-account-panel">
              <div className="studio-account-summary">
                <div className="studio-account-meta">
                  <span className="studio-account-label">ログイン中</span>
                  <strong className="studio-account-email">{session.user.email ?? 'Google Account'}</strong>
                </div>
                <div className="studio-account-meta studio-account-meta--gems">
                  <span className="studio-account-label">保有Gem</span>
                  <strong className="studio-account-gem">{ticketStatus === 'loading' ? '確認中...' : `${ticketCount ?? 0} Gem`}</strong>
                </div>
              </div>
              <div className="studio-account-actions">
                <div className="studio-account-action-stack">
                  {!effectiveDailyCanClaim && dailyCountdown && !isLoadingDailyStatus && !isClaimingDaily && (
                    <span className="studio-account-caption">{`残り ${dailyCountdown}`}</span>
                  )}
                  <button
                    type="button"
                    className={`studio-btn ${effectiveDailyCanClaim ? 'studio-btn--primary' : 'studio-btn--ghost'}`}
                    onClick={handleClaimDaily}
                    disabled={isClaimingDaily || isLoadingDailyStatus || !effectiveDailyCanClaim}
                  >
                    {dailyBonusButtonLabel}
                  </button>
                </div>
                <Link className="studio-btn studio-btn--ghost" to="/purchase">
                  Gem購入
                </Link>
              </div>
              {ticketStatus === 'error' && ticketMessage && <p className="studio-inline-error">{ticketMessage}</p>}
              {dailyClaimStatus && <p className="studio-status studio-status--account">{dailyClaimStatus}</p>}
            </section>
          )}

          <div className="studio-ticket-row">
            <span className="studio-ticket-label">必要Gem</span>
            <strong className="studio-ticket-value">{requiredPoints}</strong>
          </div>

          <div className="studio-stack">
            <section className="studio-section">
              <h2 className="studio-section-title">{session ? '素材画像' : 'Google Login'}</h2>
              {session ? (
                <>
                  <label className="studio-upload">
                    <input type="file" accept="image/*" onChange={handleFileChange} />
                    <div className="studio-upload-inner">
                      <strong>{sourceName || '元画像をアップロード'}</strong>
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
                  <p className="studio-field-note">生成にはGoogleログインが必要です。登録後、このまま同じ画面で入力を続けられます。</p>
                  <button type="button" className="studio-btn studio-btn--primary studio-btn--wide" onClick={handleGoogleSignIn}>
                    Googleで登録 / ログイン
                  </button>
                  {!isAuthConfigured && <p className="studio-field-note">認証設定が未完了です。</p>}
                </div>
              )}
            </section>

            <section className="studio-section">
              <h2 className="studio-section-title">動きの内容</h2>
              <label className="studio-field">
                <span>プロンプト</span>
                <textarea
                  rows={4}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                />
              </label>
              <label className="studio-field">
                <span>ネガティブプロンプト (任意)</span>
                <textarea
                  rows={3}
                  value={negativePrompt}
                  onChange={(e) => setNegativePrompt(e.target.value)}
                />
              </label>
            </section>

            <section className="studio-section">
              <h2 className="studio-section-title">Duration</h2>
              <div className="studio-duration-row">
                <span>動画の長さ</span>
                <div className="studio-duration-toggle" aria-label="動画の長さ切り替え">
                  <span className={`studio-duration-chip${!isExtendedVideoLength ? ' is-active' : ''}`}>
                    {VIDEO_LENGTH_OPTIONS[0].label}
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={isExtendedVideoLength}
                    aria-label="8秒オプションに切り替え"
                    className={`studio-switch${isExtendedVideoLength ? ' is-on' : ''}`}
                    onClick={() =>
                      setVideoLengthSeconds(isExtendedVideoLength ? DEFAULT_VIDEO_LENGTH_SECONDS : EXTENDED_VIDEO_LENGTH_SECONDS)
                    }
                    disabled={isRunning}
                  >
                    <span className="studio-switch-thumb" />
                  </button>
                  <span className={`studio-duration-chip${isExtendedVideoLength ? ' is-active' : ''}`}>
                    {VIDEO_LENGTH_OPTIONS[1].label}
                  </span>
                </div>
                <p className="studio-field-note">標準は5秒です。必要なときだけ8秒オプションへ切り替えます。</p>
              </div>
            </section>

            <section className="studio-section">
              <h2 className="studio-section-title">強化学習の強さ</h2>
              <div className="studio-duration-row">
                <span>強さを選択</span>
                <div className="studio-duration-options studio-duration-options--two" aria-label="強化学習の強さ">
                  <button
                    type="button"
                    className={`studio-duration-option${enhancementStrengthMode === 'low' ? ' is-active' : ''}`}
                    onClick={() => setEnhancementStrengthMode('low')}
                    disabled={isRunning}
                  >
                    LOW
                  </button>
                  <button
                    type="button"
                    className={`studio-duration-option${enhancementStrengthMode === 'high' ? ' is-active' : ''}`}
                    onClick={() => setEnhancementStrengthMode('high')}
                    disabled={isRunning}
                  >
                    HIGH
                  </button>
                </div>
                <p className="studio-field-note">既定はLOWです。HIGHでは low/high の強度を 0.2 に上げます。</p>
              </div>
            </section>

          </div>

          <div className="studio-generate-dock">
            <div className="studio-actions studio-actions--spread">
              <button
                type="button"
                className="studio-btn studio-btn--ghost"
                onClick={clearImage}
                disabled={(!sourcePreview && !displayVideo && !statusMessage) || isRunning}
              >
                クリア
              </button>
              {session ? (
                <button type="button" className="studio-btn studio-btn--primary studio-btn--wide" onClick={handleGenerate} disabled={!canGenerate}>
                  {isRunning ? '生成中...' : '生成'}
                </button>
              ) : (
                <button type="button" className="studio-btn studio-btn--primary studio-btn--wide" onClick={handleGoogleSignIn} disabled={isRunning}>
                  Googleで登録 / ログイン
                </button>
              )}
            </div>
            {statusMessage && <p className="studio-status">{statusMessage}</p>}
          </div>
        </section>

        <section className="studio-panel studio-panel--preview">
          <div className="studio-preview-head">
            <div className="studio-preview-head-copy">
              <h2>生成結果</h2>
              <span>{displayVideo ? '完成した動画' : sourcePreview ? '入力画像' : 'ここに生成結果が表示されます'}</span>
            </div>
            {sourcePreview && !isRunning && (
              <button type="button" className="studio-btn studio-btn--ghost" onClick={clearImage}>
                画像を差し替え
              </button>
            )}
          </div>

          <div className="studio-canvas" style={viewerStyle}>
            {isRunning ? (
              <div className="studio-loading studio-loading--video" role="status" aria-live="polite">
                <div className="studio-loading-orb" aria-hidden="true">
                  <span className="studio-loading-orb__ring studio-loading-orb__ring--outer" />
                  <span className="studio-loading-orb__ring studio-loading-orb__ring--mid" />
                  <span className="studio-loading-orb__ring studio-loading-orb__ring--inner" />
                  <span className="studio-loading-orb__glow" />
                  <span className="studio-loading-orb__core" />
                  <span className="studio-loading-orb__spark studio-loading-orb__spark--a" />
                  <span className="studio-loading-orb__spark studio-loading-orb__spark--b" />
                  <span className="studio-loading-orb__spark studio-loading-orb__spark--c" />
                </div>
                <p className="studio-loading__title">生成中です</p>
                <p className="studio-loading__subtitle">{loadingSubtitle}</p>
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
            ) : sourcePreview ? (
              <img src={sourcePreview} alt="入力画像" />
            ) : (
              <div className="studio-preview-idle">
                <p>左側で素材画像とプロンプトを設定すると、ここに入力画像と生成結果が表示されます。</p>
              </div>
            )}
          </div>

          {statusMessage && <p className="studio-status studio-status--preview">{statusMessage}</p>}
        </section>

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
            <h3>Gem不足</h3>
            <p>{`この設定では${requiredPointsForRun} Gemが必要です。購入ページでGemを追加してください。`}</p>
            <div className="studio-modal-actions">
              <button type="button" className="studio-btn studio-btn--ghost" onClick={() => setShowTicketModal(false)}>
                閉じる
              </button>
              <button type="button" className="studio-btn studio-btn--primary" onClick={() => navigate('/purchase')}>
                Gem購入へ
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





