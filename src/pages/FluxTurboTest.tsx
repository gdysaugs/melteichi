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
import { Link } from 'react-router-dom'
import { TopNav } from '../components/TopNav'
import { saveGeneratedAsset } from '../lib/downloadMedia'
import { isAuthConfigured, supabase } from '../lib/supabaseClient'
import './video-studio.css'

type PreparedImage = {
  dataUrl: string
  payload: string
  width: number
  height: number
  name: string
}

type SubmitResult =
  | { images: string[]; jobId?: never; usageId?: string }
  | { images?: never; jobId: string; usageId?: string }

const ENDPOINT = '/api/i2i'
const OAUTH_REDIRECT_URL =
  import.meta.env.VITE_SUPABASE_REDIRECT_URL ?? (typeof window !== 'undefined' ? window.location.origin : undefined)
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024
const MAX_WORK_IMAGE_SIDE = 1024
const MIN_WORK_IMAGE_SIDE = 256
const DEFAULT_STEPS = 4
const DEFAULT_CFG = 1
const FIXED_MEGAPIXELS = 1
const ANATOMY_LORA_NAME = 'klein_slider_anatomy.safetensors'
const ANATOMY_LORA_STRENGTH = 1

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const toBase64 = (dataUrl: string) => {
  const parts = dataUrl.split(',')
  return parts.length > 1 ? parts[1] : dataUrl
}

const normalizeImage = (value: unknown, filename?: string) => {
  if (typeof value !== 'string' || !value) return null
  if (value.startsWith('data:image/') || value.startsWith('http')) return value
  const ext = filename?.split('.').pop()?.toLowerCase()
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png'
  return `data:${mime};base64,${value}`
}

const extractImages = (payload: any) => {
  const output = payload?.output ?? payload?.result ?? payload
  const nested = output?.output ?? output?.result ?? output?.data
  const lists = [
    output?.images,
    output?.outputs,
    output?.output_images,
    output?.data,
    payload?.images,
    nested?.images,
    nested?.outputs,
    nested?.output_images,
    nested?.data,
  ]

  for (const list of lists) {
    if (!Array.isArray(list)) continue
    const images = list
      .map((item: any) => normalizeImage(item?.image ?? item?.data ?? item?.url ?? item?.base64 ?? item, item?.filename ?? item?.name))
      .filter(Boolean) as string[]
    if (images.length) return images
  }

  const direct = [
    output?.image,
    output?.image_base64,
    output?.output_base64,
    payload?.image,
    payload?.image_base64,
    nested?.image,
    nested?.image_base64,
    nested?.output_base64,
  ]
  for (const item of direct) {
    const image = normalizeImage(item)
    if (image) return [image]
  }
  return []
}

const extractJobId = (payload: any) => payload?.id || payload?.jobId || payload?.job_id || payload?.output?.id

const extractError = (payload: any) =>
  payload?.error ||
  payload?.message ||
  payload?.detail ||
  payload?.output?.error ||
  payload?.result?.error ||
  payload?.output?.output?.error ||
  payload?.result?.output?.error

const normalizeError = (value: unknown) => {
  if (!value) return 'エラーが発生しました。'
  if (value instanceof Error) return value.message
  if (typeof value === 'object') {
    const maybe = value as { error?: unknown; message?: unknown; detail?: unknown }
    const picked = maybe.error ?? maybe.message ?? maybe.detail
    return typeof picked === 'string' && picked ? picked : 'エラーが発生しました。'
  }
  const raw = String(value)
  if (!raw || raw === '[object Object]') return 'エラーが発生しました。'
  if (raw.toLowerCase().includes('no ticket') || raw.toLowerCase().includes('insufficient')) return '枚数が不足しています。'
  return raw
}

const isFailureStatus = (status: string) => {
  const normalized = status.toLowerCase()
  return normalized.includes('fail') || normalized.includes('error') || normalized.includes('cancel')
}

const readFileAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('画像の読み込みに失敗しました。'))
    reader.readAsDataURL(file)
  })

const loadImageElement = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('画像の読み込みに失敗しました。'))
    image.src = src
  })

const fitDimension = (width: number, height: number) => {
  const scaleDown = Math.min(1, MAX_WORK_IMAGE_SIDE / width, MAX_WORK_IMAGE_SIDE / height)
  const scaledWidth = width * scaleDown
  const scaledHeight = height * scaleDown
  const scaleUp =
    Math.min(scaledWidth, scaledHeight) < MIN_WORK_IMAGE_SIDE
      ? Math.min(MAX_WORK_IMAGE_SIDE / width, MAX_WORK_IMAGE_SIDE / height, MIN_WORK_IMAGE_SIDE / Math.min(width, height))
      : scaleDown
  const scale = Math.max(scaleDown, scaleUp)
  return {
    width: Math.max(16, Math.min(MAX_WORK_IMAGE_SIDE, Math.round((width * scale) / 16) * 16)),
    height: Math.max(16, Math.min(MAX_WORK_IMAGE_SIDE, Math.round((height * scale) / 16) * 16)),
  }
}

const prepareImageFile = async (file: File): Promise<PreparedImage> => {
  if (!file.type.startsWith('image/')) throw new Error('画像ファイルを選択してください。')
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('画像サイズが大きすぎます。15MB以下にしてください。')

  const originalDataUrl = await readFileAsDataUrl(file)
  const image = await loadImageElement(originalDataUrl)
  const { width, height } = fitDimension(image.naturalWidth || image.width, image.naturalHeight || image.height)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('画像の処理に失敗しました。')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(image, 0, 0, width, height)
  const dataUrl = canvas.toDataURL('image/png')
  return { dataUrl, payload: toBase64(dataUrl), width, height, name: file.name }
}

export function FluxTurboTest() {
  const [session, setSession] = useState<Session | null>(null)
  const [authReady, setAuthReady] = useState(!supabase)
  const [source, setSource] = useState<PreparedImage | null>(null)
  const [reference, setReference] = useState<PreparedImage | null>(null)
  const [prompt, setPrompt] = useState('')
  const [generationSteps, setGenerationSteps] = useState<4 | 8>(DEFAULT_STEPS)
  const [cfgScale, setCfgScale] = useState(DEFAULT_CFG)
  const [resultImage, setResultImage] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState('')
  const [ticketCount, setTicketCount] = useState<number | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const runIdRef = useRef(0)

  const accessToken = session?.access_token ?? ''
  const ticketCost = generationSteps >= 8 ? 2 : 1
  const canGenerate = Boolean(session && source?.payload && prompt.trim() && !isRunning)
  const viewerStyle = useMemo(
    () =>
      ({
        '--studio-aspect': `${Math.max(1, source?.width ?? 1024)} / ${Math.max(1, source?.height ?? 1024)}`,
      }) as CSSProperties,
    [source?.height, source?.width],
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
        setStatusMessage('認証に失敗しました。')
        return
      }
      const url = new URL(window.location.href)
      url.searchParams.delete('code')
      url.searchParams.delete('state')
      window.history.replaceState({}, document.title, url.toString())
    })
  }, [])

  const getFreshAccessToken = useCallback(async () => {
    if (!supabase) return ''
    const { data } = await supabase.auth.getSession()
    let nextSession = data.session
    const expiresAt = Number(nextSession?.expires_at ?? 0)
    if (!nextSession?.access_token || (expiresAt > 0 && expiresAt * 1000 < Date.now() + 60_000)) {
      const refreshed = await supabase.auth.refreshSession().catch(() => null)
      nextSession = refreshed?.data.session ?? nextSession
    }
    setSession(nextSession ?? null)
    return nextSession?.access_token ?? ''
  }, [])

  const fetchWithAuth = useCallback(
    async (url: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers)
      headers.delete('Authorization')
      const token = await getFreshAccessToken()
      if (!token) throw new Error('ログインが必要です。')
      headers.set('Authorization', `Bearer ${token}`)
      return fetch(url, { ...init, headers })
    },
    [getFreshAccessToken],
  )

  const refreshTickets = useCallback(async () => {
    try {
      const res = await fetchWithAuth('/api/tickets')
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(normalizeError(data))
      setTicketCount(Number(data?.tickets ?? 0))
    } catch {
      setTicketCount(null)
    }
  }, [fetchWithAuth])

  useEffect(() => {
    if (accessToken) void refreshTickets()
    else setTicketCount(null)
  }, [accessToken, refreshTickets])

  const handleGoogleSignIn = useCallback(async () => {
    if (!supabase || !isAuthConfigured) {
      setStatusMessage('認証設定がありません。')
      return
    }
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: OAUTH_REDIRECT_URL, skipBrowserRedirect: true },
    })
    if (error) {
      setStatusMessage(error.message)
      return
    }
    if (data?.url) window.location.assign(data.url)
  }, [])

  const handleSourceChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const prepared = await prepareImageFile(file)
      setSource(prepared)
      setResultImage(null)
      setStatusMessage('元画像を読み込みました。')
    } catch (error) {
      setStatusMessage(normalizeError(error))
    }
  }

  const handleReferenceChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const prepared = await prepareImageFile(file)
      setReference(prepared)
      setStatusMessage('参照画像を読み込みました。')
    } catch (error) {
      setStatusMessage(normalizeError(error))
    }
  }

  const submitGenerate = useCallback(async (): Promise<SubmitResult> => {
    if (!source) throw new Error('元画像が必要です。')

    const input: Record<string, unknown> = {
      prompt: prompt.trim(),
      image_base64: source.payload,
      image_name: source.name || 'source.png',
      width: source.width,
      height: source.height,
      steps: generationSteps,
      cfg: cfgScale,
      megapixels: FIXED_MEGAPIXELS,
      model: 'distilled',
      sampler_name: 'euler',
      lora_name: ANATOMY_LORA_NAME,
      strength_model: ANATOMY_LORA_STRENGTH,
      strength_clip: 0,
      randomize_seed: true,
      filename_prefix: 'melteichi-i2i',
    }
    if (reference) {
      input.reference_image_base64 = reference.payload
      input.reference_image_name = reference.name || 'reference.png'
      input.reference_images = [{ image_base64: reference.payload, image_name: reference.name, name: reference.name }]
    }

    const res = await fetchWithAuth(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    })
    const data = await res.json().catch(() => ({}))
    const nextTickets = Number(data?.ticketsLeft ?? data?.tickets_left)
    if (Number.isFinite(nextTickets)) setTicketCount(nextTickets)

    if (!res.ok) throw new Error(normalizeError(extractError(data) || data))
    const images = extractImages(data)
    if (images.length) return { images, usageId: data?.usage_id }
    const jobId = extractJobId(data)
    if (!jobId) throw new Error('ジョブIDを取得できませんでした。')
    return { jobId, usageId: data?.usage_id }
  }, [cfgScale, fetchWithAuth, generationSteps, prompt, reference, source])

  const pollJob = useCallback(
    async (jobId: string, usageId: string | undefined, runId: number) => {
      for (let i = 0; i < 180; i += 1) {
        if (runIdRef.current !== runId) return []
        const params = new URLSearchParams({ id: jobId })
        if (usageId) params.set('usage_id', usageId)
        const res = await fetchWithAuth(`${ENDPOINT}?${params.toString()}`)
        const data = await res.json().catch(() => ({}))
        const nextTickets = Number(data?.ticketsLeft ?? data?.tickets_left)
        if (Number.isFinite(nextTickets)) setTicketCount(nextTickets)
        if (!res.ok) throw new Error(normalizeError(extractError(data) || data))
        const status = String(data?.status || data?.state || '').toLowerCase()
        const error = extractError(data)
        if (error || isFailureStatus(status)) throw new Error(normalizeError(error || '生成に失敗しました。'))
        const images = extractImages(data)
        if (images.length) return images
        await wait(2000 + Math.min(1500, i * 50))
      }
      throw new Error('生成がタイムアウトしました。')
    },
    [fetchWithAuth],
  )

  const handleGenerate = async () => {
    if (!canGenerate) {
      setStatusMessage(session ? '元画像とプロンプトを入力してください。' : '先にログインしてください。')
      return
    }

    const runId = runIdRef.current + 1
    runIdRef.current = runId
    setIsRunning(true)
    setResultImage(null)
    setStatusMessage('I2Iで画像編集を実行中です。')

    try {
      const submitted = await submitGenerate()
      if (runIdRef.current !== runId) return
      const images =
        'images' in submitted && submitted.images?.length
          ? submitted.images
          : typeof submitted.jobId === 'string'
            ? await pollJob(submitted.jobId, submitted.usageId, runId)
            : []
      if (runIdRef.current !== runId) return
      if (!images.length) throw new Error('生成結果を取得できませんでした。')
      setResultImage(images[0])
      setStatusMessage('生成が完了しました。')
      void refreshTickets()
    } catch (error) {
      if (runIdRef.current !== runId) return
      setStatusMessage(normalizeError(error))
      void refreshTickets()
    } finally {
      if (runIdRef.current === runId) setIsRunning(false)
    }
  }

  const handleSave = async () => {
    if (!resultImage || isSaving) return
    setIsSaving(true)
    try {
      await saveGeneratedAsset({ source: resultImage, filenamePrefix: 'melteichi-i2i', fallbackExtension: 'png' })
    } finally {
      setIsSaving(false)
    }
  }

  if (!authReady) {
    return (
      <div className="studio-page">
        <TopNav />
        <div className="studio-loader">読み込み中...</div>
      </div>
    )
  }

  return (
    <div className="studio-page inpaint-page">
      <TopNav />
      <main className="studio-wrap studio-wrap--workspace inpaint-wrap">
        <section className="studio-panel studio-panel--controls">
          <header className="studio-heading">
            <h1>I2I</h1>
            <p>MeltAI公式のI2Iを強化した画像編集です。よりリアル感や多様な表現を可能にしました。Step8は4よりも安定感が上がりますが、通常は4Stepで十分です。</p>
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
                  <strong className="studio-account-gem">{ticketCount === null ? '確認中...' : `${ticketCount} Gem`}</strong>
                </div>
              </div>
              <div className="studio-account-actions">
                <Link className="studio-btn studio-btn--ghost" to="/purchase">
                  Gem購入
                </Link>
              </div>
            </section>
          )}

          <div className="studio-ticket-row">
            <span className="studio-ticket-label">必要Gem</span>
            <strong className="studio-ticket-value">{ticketCost}</strong>
            <span className="studio-ticket-cost">1回生成</span>
          </div>

          <div className="studio-stack">
            <section className="studio-section">
              <h2 className="studio-section-title">Images</h2>
              <label className="studio-upload">
                <input type="file" accept="image/png,image/jpeg,image/webp" onChange={handleSourceChange} />
                <span className="studio-upload-inner">
                  <strong>元画像</strong>
                  <span>{source?.name || 'PNG / JPG / WebP'}</span>
                </span>
              </label>
              {source && (
                <div className="studio-thumb-wrap inpaint-thumb">
                  <img className="studio-thumb" src={source.dataUrl} alt="元画像プレビュー" />
                  <button type="button" className="studio-thumb-remove" onClick={() => setSource(null)}>
                    削除
                  </button>
                </div>
              )}

              <label className="studio-upload">
                <input type="file" accept="image/png,image/jpeg,image/webp" onChange={handleReferenceChange} />
                <span className="studio-upload-inner">
                  <strong>参照画像</strong>
                  <span>{reference?.name || '任意で1枚追加'}</span>
                </span>
              </label>
              {reference && (
                <div className="studio-thumb-wrap inpaint-thumb">
                  <img className="studio-thumb" src={reference.dataUrl} alt="参照画像プレビュー" />
                  <button type="button" className="studio-thumb-remove" onClick={() => setReference(null)}>
                    削除
                  </button>
                </div>
              )}
            </section>

            <section className="studio-section">
              <h2 className="studio-section-title">Prompt</h2>
              <label className="studio-field">
                <span>プロンプト</span>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  maxLength={1600}
                  placeholder="編集内容を詳しく入力"
                />
              </label>
              <p className="studio-field-note">{prompt.length}/1600</p>
            </section>

            <section className="studio-section">
              <h2 className="studio-section-title">Settings</h2>
              <label className="studio-field studio-field--compact">
                <span>Steps</span>
                <div className="studio-toggle-row">
                  {[4, 8].map((step) => (
                    <button
                      key={step}
                      type="button"
                      className={`studio-chip ${generationSteps === step ? 'studio-chip--active' : ''}`}
                      onClick={() => setGenerationSteps(step as 4 | 8)}
                      aria-pressed={generationSteps === step}
                    >
                      {step}
                    </button>
                  ))}
                </div>
              </label>
              <label className="studio-field studio-field--compact">
                <span>CFG: {cfgScale.toFixed(2)}</span>
                <div className="studio-cfg-row">
                  <input
                    type="range"
                    min={1}
                    max={2}
                    step={0.05}
                    value={cfgScale}
                    onChange={(event) => setCfgScale(Number(event.target.value))}
                  />
                  <input
                    type="number"
                    min={1}
                    max={2}
                    step={0.05}
                    value={cfgScale}
                    onChange={(event) => setCfgScale(Math.max(1, Math.min(2, Number(event.target.value) || 1)))}
                  />
                </div>
              </label>
            </section>
          </div>

          <div className="studio-generate-dock">
            {session ? (
              <button type="button" className="studio-btn studio-btn--primary" onClick={handleGenerate} disabled={!canGenerate}>
                {isRunning ? '生成中...' : `${ticketCost} Gem消費して生成`}
              </button>
            ) : (
              <button type="button" className="studio-btn studio-btn--primary" onClick={handleGoogleSignIn}>
                Googleでログイン
              </button>
            )}
            {statusMessage && <p className="studio-status">{statusMessage}</p>}
          </div>
        </section>

        <section className="studio-panel studio-panel--preview">
          <div className="studio-preview-head">
            <h2>元画像</h2>
            <span>{source ? `${source.width} x ${source.height}` : '未設定'}</span>
          </div>
          <div className="studio-canvas inpaint-canvas" style={viewerStyle}>
            {source ? (
              <img className="studio-result-media" src={source.dataUrl} alt="元画像" />
            ) : (
              <div className="studio-preview-idle">
                <p>元画像を選択するとここに表示されます。</p>
              </div>
            )}
          </div>

          <div className="studio-preview-head inpaint-result-head">
            <h2>生成結果</h2>
            <span>{isRunning ? '生成中' : resultImage ? '完了' : '待機中'}</span>
          </div>
          <div className="studio-canvas inpaint-result-canvas" style={viewerStyle}>
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
                <p className="studio-loading__subtitle">画像編集を実行しています。</p>
              </div>
            ) : resultImage ? (
              <>
                <img className="studio-result-media" src={resultImage} alt="生成結果" />
                <button type="button" className="studio-save-btn" onClick={handleSave} disabled={isSaving}>
                  {isSaving ? '保存中' : '保存'}
                </button>
              </>
            ) : (
              <div className="studio-preview-idle">
                <p>生成結果はここに表示されます。</p>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  )
}
