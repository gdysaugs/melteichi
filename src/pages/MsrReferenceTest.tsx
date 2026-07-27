import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
} from 'react'
import type { Session } from '@supabase/supabase-js'
import { VideoEngineCards } from '../components/VideoEngineCards'
import { useNavigate } from 'react-router-dom'
import { TopNav } from '../components/TopNav'
import { StudioAccountPanel } from '../components/StudioAccountPanel'
import { useDailyBonus } from '../hooks/useDailyBonus'
import {
  prepareGeneratedAsset,
  saveGeneratedAsset,
  type PreparedGeneratedAsset,
} from '../lib/downloadMedia'
import { supabase } from '../lib/supabaseClient'
import './camera.css'
import './video-studio.css'
import './msr-reference-test.css'

const API_ENDPOINT = '/api/msr-i2v'
const VIDEO_LENGTH_OPTIONS = [
  { seconds: 5, frames: 121, ticketCost: 1, label: '5秒（1Gem）' },
  { seconds: 8, frames: 193, ticketCost: 2, label: '8秒（2Gem）' },
] as const
type VideoLengthSeconds = (typeof VIDEO_LENGTH_OPTIONS)[number]['seconds']
const DEFAULT_VIDEO_LENGTH_SECONDS = VIDEO_LENGTH_OPTIONS[0].seconds
const resolveVideoLengthOption = (seconds: number) =>
  VIDEO_LENGTH_OPTIONS.find((option) => option.seconds === seconds) ??
  VIDEO_LENGTH_OPTIONS[0]
const MAX_PROMPT_LENGTH = 3000
const MAX_OBJECT_DESCRIPTION_LENGTH = 300
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_PAYLOAD_LONG_EDGE = 1600

type ImageSlot = {
  dataUrl: string
  payload: string
  name: string
  width: number
  height: number
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const toBase64Payload = (dataUrl: string) => {
  const commaIndex = dataUrl.indexOf(',')
  return commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl
}

const readImage = (file: File) =>
  new Promise<ImageSlot>((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('画像ファイルを選択してください。'))
      return
    }
    if (file.size > MAX_IMAGE_BYTES) {
      reject(new Error('画像は1枚5MB以内にしてください。'))
      return
    }

    const reader = new FileReader()
    reader.onerror = () => reject(new Error('画像の読み込みに失敗しました。'))
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : ''
      if (!dataUrl) {
        reject(new Error('画像の読み込みに失敗しました。'))
        return
      }

      const image = new Image()
      image.onerror = () => reject(new Error('画像の内容を確認できませんでした。'))
      image.onload = () => {
        const originalWidth = image.naturalWidth
        const originalHeight = image.naturalHeight
        const scale = Math.min(1, MAX_PAYLOAD_LONG_EDGE / Math.max(originalWidth, originalHeight))
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(originalWidth * scale))
        canvas.height = Math.max(1, Math.round(originalHeight * scale))
        const context = canvas.getContext('2d')
        if (!context) {
          reject(new Error('画像の読み込みに失敗しました。'))
          return
        }
        context.imageSmoothingEnabled = true
        context.imageSmoothingQuality = 'high'
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
        const optimizedDataUrl = canvas.toDataURL('image/webp', 0.9)

        resolve({
          dataUrl: optimizedDataUrl,
          payload: toBase64Payload(optimizedDataUrl),
          name: file.name,
          width: originalWidth,
          height: originalHeight,
        })
      }
      image.src = dataUrl
    }
    reader.readAsDataURL(file)
  })

const normalizeVideo = (value: unknown, filename?: string) => {
  if (typeof value !== 'string' || !value) return null
  if (
    value.startsWith('data:video/') ||
    value.startsWith('http://') ||
    value.startsWith('https://') ||
    value.startsWith('blob:')
  ) {
    return value
  }
  const extension = filename?.split('.').pop()?.toLowerCase()
  const mime = extension === 'webm' ? 'video/webm' : 'video/mp4'
  return 'data:' + mime + ';base64,' + value
}

const extractVideos = (payload: any) => {
  const roots = [
    payload,
    payload?.output,
    payload?.result,
    payload?.output?.output,
    payload?.result?.output,
    payload?.output?.result,
  ]

  for (const root of roots) {
    if (!root || typeof root !== 'object') continue
    const arrays = [root.videos, root.outputs, root.output_videos, root.gifs]
    for (const candidate of arrays) {
      if (!Array.isArray(candidate)) continue
      const videos = candidate
        .map((item: any) =>
          normalizeVideo(item?.video ?? item?.data ?? item?.url ?? item, item?.filename),
        )
        .filter(Boolean) as string[]
      if (videos.length) return videos
    }

    const direct =
      root.video ??
      root.output_base64 ??
      root.video_base64 ??
      root.output?.output_base64 ??
      root.output?.video_base64
    const video = normalizeVideo(direct, root.filename)
    if (video) return [video]
  }

  return [] as string[]
}

const extractJobId = (payload: any) =>
  payload?.id ?? payload?.jobId ?? payload?.job_id ?? payload?.output?.id ?? payload?.output?.job_id

const extractUsageId = (payload: any) =>
  payload?.usage_id ?? payload?.usageId ?? payload?.output?.usage_id ?? payload?.output?.usageId

const isFailureStatus = (status: string) => {
  const normalized = status.toLowerCase()
  return (
    normalized.includes('fail') ||
    normalized.includes('error') ||
    normalized.includes('cancel') ||
    normalized.includes('timeout') ||
    normalized.includes('timed_out')
  )
}

const responseMessage = (status: number) => {
  if (status === 401 || status === 403) return '認証に失敗しました。ログインし直してください。'
  if (status === 402) return 'Gemが不足しています。'
  if (status === 413) return '画像の容量が大きすぎます。各5MB以内にしてください。'
  if (status === 429) return '現在混み合っています。少し待ってからお試しください。'
  return '動画生成に失敗しました。もう一度お試しください。'
}

const safeErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    const allowed = [
      '画像ファイルを選択してください。',
      '画像は1枚5MB以内にしてください。',
      '画像の読み込みに失敗しました。',
      '画像の内容を確認できませんでした。',
      'Gemが不足しています。',
      '生成がタイムアウトしました。',
    ]
    if (allowed.includes(error.message)) return error.message
  }
  return '動画生成に失敗しました。もう一度お試しください。'
}

export function MsrReferenceTest() {
  const [session, setSession] = useState<Session | null>(null)
  const [authReady, setAuthReady] = useState(!supabase)
  const [subjectImage, setSubjectImage] = useState<ImageSlot | null>(null)
  const [subjectImage2, setSubjectImage2] = useState<ImageSlot | null>(null)
  const [objectDescription, setObjectDescription] = useState('')
  const [prompt, setPrompt] = useState('')
  const [videoLengthSeconds, setVideoLengthSeconds] =
    useState<VideoLengthSeconds>(DEFAULT_VIDEO_LENGTH_SECONDS)
  const [ticketCount, setTicketCount] = useState<number | null>(null)
  const [ticketStatus, setTicketStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [ticketMessage, setTicketMessage] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [result, setResult] = useState<PreparedGeneratedAsset | null>(null)
  const resultRef = useRef<PreparedGeneratedAsset | null>(null)
  const runIdRef = useRef(0)
  const navigate = useNavigate()

  const accessToken = session?.access_token ?? ''
  const selectedVideoLength = useMemo(
    () => resolveVideoLengthOption(videoLengthSeconds),
    [videoLengthSeconds],
  )
  const requiredGems = selectedVideoLength.ticketCost
  const canGenerate = Boolean(
    session &&
      subjectImage?.payload &&
      subjectImage2?.payload &&
      objectDescription.trim() &&
      prompt.trim() &&
      !isRunning,
  )
  const viewerStyle = useMemo(
    () =>
      ({
        '--studio-aspect': subjectImage
          ? String(subjectImage.width) + ' / ' + String(subjectImage.height)
          : '16 / 9',
      }) as CSSProperties,
    [subjectImage],
  )

  const replaceResult = useCallback((next: PreparedGeneratedAsset | null) => {
    const previous = resultRef.current
    if (previous && previous !== next) previous.release()
    resultRef.current = next
    setResult(next)
  }, [])

  useEffect(
    () => () => {
      resultRef.current?.release()
      resultRef.current = null
    },
    [],
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

  const fetchTickets = useCallback(async (token: string) => {
    if (!token) return null

    setTicketStatus('loading')
    setTicketMessage('')

    const response = await fetch('/api/tickets', {
      headers: { Authorization: 'Bearer ' + token },
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      const message =
        typeof data?.error === 'string' && data.error
          ? data.error
          : 'Gem情報の取得に失敗しました。'
      setTicketStatus('error')
      setTicketMessage(message)
      setTicketCount(null)
      throw new Error(message)
    }

    const tickets = Number(data?.tickets ?? 0)
    const normalized = Number.isFinite(tickets) ? tickets : 0
    setTicketStatus('idle')
    setTicketMessage('')
    setTicketCount(normalized)
    return normalized
  }, [])

  const dailyBonus = useDailyBonus({
    accessToken,
    isAuthenticated: Boolean(session),
    refreshGemBalance: fetchTickets,
  })

  useEffect(() => {
    if (!session || !accessToken) {
      setTicketCount(null)
      setTicketStatus('idle')
      setTicketMessage('')
      return
    }
    void fetchTickets(accessToken).catch(() => undefined)
  }, [accessToken, fetchTickets, session])

  const handleImageChange = async (
    event: ChangeEvent<HTMLInputElement>,
    setter: (value: ImageSlot | null) => void,
  ) => {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      setter(await readImage(file))
      replaceResult(null)
      setStatusMessage('画像を読み込みました。')
    } catch (error) {
      event.target.value = ''
      setStatusMessage(safeErrorMessage(error))
    }
  }

  const pollJob = useCallback(
    async (jobId: string, usageId: string | undefined, runId: number) => {
      for (let attempt = 0; attempt < 600; attempt += 1) {
        if (runIdRef.current !== runId) return null

        const params = new URLSearchParams({ id: jobId })
        if (usageId) params.set('usage_id', usageId)
        const response = await fetch(API_ENDPOINT + '?' + params.toString(), {
          headers: { Authorization: 'Bearer ' + accessToken },
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(responseMessage(response.status))

        const nextTickets = Number(data?.ticketsLeft ?? data?.tickets_left)
        if (Number.isFinite(nextTickets)) setTicketCount(nextTickets)

        const status = String(data?.status ?? data?.state ?? '').toLowerCase()
        if (isFailureStatus(status) || data?.error || data?.output?.error) {
          throw new Error('動画生成に失敗しました。')
        }

        const videos = extractVideos(data)
        if (videos.length) return videos[0]
        await wait(2000)
      }
      throw new Error('生成がタイムアウトしました。')
    },
    [accessToken],
  )

  const handleGenerate = async () => {
    if (!canGenerate || !subjectImage || !subjectImage2) return

    const runId = runIdRef.current + 1
    runIdRef.current = runId
    setIsRunning(true)
    setStatusMessage('Gemを確認しています...')
    replaceResult(null)

    try {
      const latestTickets = await fetchTickets(accessToken)
      if (latestTickets !== null && latestTickets < requiredGems) {
        throw new Error('Gemが不足しています。')
      }

      setStatusMessage('人物とオブジェクト画像をもとに動画を生成しています...')
      const response = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + accessToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          subject_image: subjectImage.payload,
          object_image: subjectImage2.payload,
          object_description: objectDescription.trim(),
          prompt: prompt.trim(),
          duration_seconds: videoLengthSeconds,
          width: subjectImage.width,
          height: subjectImage.height,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(responseMessage(response.status))

      const nextTickets = Number(data?.ticketsLeft ?? data?.tickets_left)
      if (Number.isFinite(nextTickets)) setTicketCount(nextTickets)

      let videoSource: string | null = extractVideos(data)[0] ?? null
      if (!videoSource) {
        const jobId = extractJobId(data)
        if (!jobId) throw new Error('動画生成に失敗しました。')
        videoSource = await pollJob(String(jobId), extractUsageId(data), runId)
      }
      if (!videoSource || runIdRef.current !== runId) return

      const prepared = await prepareGeneratedAsset({
        source: videoSource,
        fallbackExtension: 'mp4',
      })
      if (runIdRef.current !== runId) {
        prepared.release()
        return
      }

      replaceResult(prepared)
      setStatusMessage('動画が完成しました。')
      await fetchTickets(accessToken)
    } catch (error) {
      if (runIdRef.current === runId) setStatusMessage(safeErrorMessage(error))
    } finally {
      if (runIdRef.current === runId) setIsRunning(false)
    }
  }

  const handleSave = useCallback(async () => {
    if (!result || isSaving) return
    setIsSaving(true)
    try {
      await saveGeneratedAsset({
        source: result.url,
        filenamePrefix: 'multi-reference-video',
        fallbackExtension: result.extension || 'mp4',
      })
    } finally {
      setIsSaving(false)
    }
  }, [isSaving, result])

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
      <main className="studio-wrap msr-studio-wrap">
        <VideoEngineCards activeEngine="c" disabled={isRunning} />
        <section className="studio-panel studio-panel--controls">
          <header className="studio-heading">
            <h1>複数素材動画生成</h1>
            <p>人物画像とオブジェクト画像を組み合わせて、指定した道具や商品が登場する短い動画を生成します。</p>
          </header>

          {session && (
            <StudioAccountPanel
              email={session.user.email}
              ticketCount={ticketCount}
              ticketStatus={ticketStatus}
              ticketMessage={ticketMessage}
              dailyBonus={dailyBonus}
            />
          )}


          <div className="studio-ticket-row">
            <span className="studio-ticket-label">今回の設定</span>
            <strong className="studio-ticket-value">
              {selectedVideoLength.seconds}秒
            </strong>
            <span className="studio-ticket-cost">
              消費 {selectedVideoLength.ticketCost}Gem
            </span>
          </div>

          <div className="studio-duration-row">
            <span>動画の長さ</span>
            <div
              className="studio-duration-options"
              role="radiogroup"
              aria-label="動画の長さ"
            >
              {VIDEO_LENGTH_OPTIONS.map((option) => (
                <button
                  key={option.seconds}
                  type="button"
                  role="radio"
                  aria-checked={videoLengthSeconds === option.seconds}
                  className={`studio-duration-option${
                    videoLengthSeconds === option.seconds ? ' is-active' : ''
                  }`}
                  onClick={() => setVideoLengthSeconds(option.seconds)}
                  disabled={isRunning}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <section className="studio-section">
            <h2 className="studio-section-title">参照画像</h2>
            <div className="msr-upload-grid">
              <div className="msr-upload-card">
                <label className="studio-upload">
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={(event) => void handleImageChange(event, setSubjectImage)}
                    disabled={isRunning}
                  />
                  <div className="studio-upload-inner">
                    <strong>{subjectImage?.name || '人物画像を選択'}</strong>
                    <span>動画に登場する人物・キャラクター</span>
                  </div>
                </label>
                {subjectImage && (
                  <div className="studio-thumb-wrap">
                    <img className="studio-thumb" src={subjectImage.dataUrl} alt="人物画像のプレビュー" />
                    <button
                      type="button"
                      className="studio-thumb-remove"
                      onClick={() => setSubjectImage(null)}
                      disabled={isRunning}
                    >
                      削除
                    </button>
                  </div>
                )}
              </div>

              <div className="msr-upload-card">
                <label className="studio-upload">
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={(event) => void handleImageChange(event, setSubjectImage2)}
                    disabled={isRunning}
                  />
                  <div className="studio-upload-inner">
                    <strong>{subjectImage2?.name || 'オブジェクト画像を選択'}</strong>
                    <span>追加する道具・商品・乗り物など</span>
                  </div>
                </label>
                {subjectImage2 && (
                  <div className="studio-thumb-wrap">
                    <img className="studio-thumb" src={subjectImage2.dataUrl} alt="オブジェクト画像のプレビュー" />
                    <button
                      type="button"
                      className="studio-thumb-remove"
                      onClick={() => setSubjectImage2(null)}
                      disabled={isRunning}
                    >
                      削除
                    </button>
                  </div>
                )}
              </div>
            </div>
            <p className="studio-field-note">
              PNG・JPEG・WebP、各5MB以内。人物画像は1人だけ、オブジェクト画像は対象物が大きく写ったものほど安定します。
            </p>
            <label className="studio-field">
              <span>オブジェクト名・特徴</span>
              <input
                type="text"
                value={objectDescription}
                maxLength={MAX_OBJECT_DESCRIPTION_LENGTH}
                onChange={(event) =>
                  setObjectDescription(
                    event.target.value.slice(0, MAX_OBJECT_DESCRIPTION_LENGTH),
                  )
                }
                placeholder={'例:赤いバイブレーター'}
                disabled={isRunning}
              />
            </label>
            <p className="studio-field-note">
              画像2に写っている対象物を短く入力してください。人物の画像をオブジェクト画像に指定しても、うまく反映されません。
            </p>
          </section>

          <section className="studio-section">
            <h2 className="studio-section-title">動画の指示</h2>
            <label className="studio-field">
              <span>プロンプト</span>
              <textarea
                rows={5}
                value={prompt}
                maxLength={MAX_PROMPT_LENGTH}
                onChange={(event) => setPrompt(event.target.value.slice(0, MAX_PROMPT_LENGTH))}
                placeholder={'例:女が参考画像の赤いバイブレーターを右手に持って踊る。バイブレーターの激しく振動する音'}
                disabled={isRunning}
              />
            </label>
            <p className="msr-character-count">
              {prompt.length.toLocaleString()} / {MAX_PROMPT_LENGTH.toLocaleString()}
            </p>
            <p className="studio-field-note">
              プロンプトでは、必ず「参考画像の〇〇」という書き方で使用するオブジェクトを指定してください。セリフが必要な場合だけ「」またはダブルクォートで囲みます。セリフはローマ字で書くのがおすすめです。
            </p>
          </section>

          <div className="studio-generate-dock">
            <div className="studio-actions">
              <button
                type="button"
                className="studio-btn studio-btn--primary"
                onClick={() => void handleGenerate()}
                disabled={!canGenerate}
              >
                {isRunning ? '生成中...' : '人物とオブジェクトから動画を生成'}
              </button>
            </div>
            {statusMessage && (
              <p className="studio-status" role="status" aria-live="polite">
                {statusMessage}
              </p>
            )}
            {!session && (
              <button type="button" className="studio-btn studio-btn--ghost" onClick={() => navigate('/')}>
                ログイン画面へ
              </button>
            )}
          </div>
        </section>

        <section className="studio-panel studio-panel--preview">
          <div className="studio-preview-head">
            <h2>生成結果</h2>
          </div>
          <div className="studio-canvas" style={viewerStyle}>
            {isRunning ? (
              <div className="studio-loading" role="status" aria-live="polite">
                <div className="studio-loading__halo" aria-hidden="true">
                  <div className="studio-loading__core" />
                  <div className="studio-spinner" />
                </div>
                <p className="studio-loading__title">動画を生成しています</p>
                <p className="studio-loading__subtitle">
                  人物画像とオブジェクト画像を解析しています。しばらくお待ちください。
                </p>
                <div className="studio-loading__steps" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            ) : result ? (
              <div className="studio-result-media">
                <button
                  type="button"
                  className="studio-save-btn"
                  onClick={() => void handleSave()}
                  disabled={isSaving}
                >
                  {isSaving ? '保存中...' : '保存'}
                </button>
                <video controls playsInline src={result.url} />
              </div>
            ) : (
              <div className="studio-empty">生成結果はここに表示されます。</div>
            )}
          </div>
        </section>
      </main>
    </div>
  )
}
