import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { Link } from 'react-router-dom'
import { TopNav } from '../components/TopNav'
import './camera.css'
import './mmaudio.css'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const MAX_TEXT_LENGTH = 500

const JP_READ_VIDEO_FAIL = '動画の読み込みに失敗しました。'
const JP_STATUS_DONE = '生成が完了しました。'
const JP_STATUS_QUEUE = 'キューで待機中です…'
const JP_STATUS_PROGRESS = '効果音付き動画を生成中です…'
const JP_STATUS_FAILED = '生成に失敗しました。'
const JP_STATUS_PREFIX = '状態: '
const JP_START_FAIL = '生成開始に失敗しました。'
const JP_VIDEO_READY = '効果音付き動画を生成しました。'
const JP_JOB_ID_FAIL = 'ジョブIDの取得に失敗しました。'
const JP_STATUS_CHECK_FAIL = 'ステータス確認に失敗しました。'
const JP_JOB_FAILED_PREFIX = 'ジョブが失敗しました: '
const JP_TIMEOUT = '動画生成がタイムアウトしました。'

const readFileAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(new Error(JP_READ_VIDEO_FAIL))
    reader.readAsDataURL(file)
  })

const toBase64 = (dataUrl: string) => {
  const parts = dataUrl.split(',')
  return parts.length > 1 ? parts[1] : dataUrl
}

const mapStatusText = (status: string) => {
  const normalized = status.toUpperCase()
  if (normalized.includes('COMPLETED')) return JP_STATUS_DONE
  if (normalized.includes('IN_QUEUE') || normalized.includes('QUEUED')) return JP_STATUS_QUEUE
  if (normalized.includes('IN_PROGRESS') || normalized.includes('PROCESS')) return JP_STATUS_PROGRESS
  if (normalized.includes('FAILED') || normalized.includes('ERROR')) return JP_STATUS_FAILED
  return `${JP_STATUS_PREFIX}${status}`
}

const extractError = (payload: any) =>
  payload?.error ||
  payload?.message ||
  payload?.detail ||
  payload?.output?.error ||
  payload?.output?.message ||
  payload?.result?.error ||
  payload?.result?.message

const extractStatus = (payload: any) =>
  String(payload?.status || payload?.state || payload?.output?.status || payload?.result?.status || '').toUpperCase()

const isFailureStatus = (status: string) => {
  const normalized = status.toUpperCase()
  return (
    normalized.includes('FAIL') ||
    normalized.includes('ERROR') ||
    normalized.includes('CANCEL') ||
    normalized.includes('TIMEOUT')
  )
}

const extractJobId = (payload: any) => payload?.id || payload?.jobId || payload?.job_id || payload?.output?.id

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

export function MMAudio() {
  const [text, setText] = useState('')
  const [sourceVideoPreview, setSourceVideoPreview] = useState<string | null>(null)
  const [sourceVideoName, setSourceVideoName] = useState('')
  const [sourceVideoBase64, setSourceVideoBase64] = useState<string | null>(null)
  const [sourceVideoExt, setSourceVideoExt] = useState('.mp4')

  const [statusMessage, setStatusMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const [outputVideoUrl, setOutputVideoUrl] = useState<string | null>(null)
  const [outputFilename, setOutputFilename] = useState<string>('mmaudio-output.mp4')

  const runIdRef = useRef(0)
  const previewUrlRef = useRef<string | null>(null)

  useEffect(
    () => () => {
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current)
        previewUrlRef.current = null
      }
    },
    [],
  )

  const canGenerate = text.trim().length > 0 && Boolean(sourceVideoBase64) && !isRunning
  const downloadName = useMemo(() => outputFilename || `mmaudio-${Date.now()}.mp4`, [outputFilename])

  const handleVideoChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    setErrorMessage('')
    setStatusMessage('')
    setOutputVideoUrl(null)

    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current)
      previewUrlRef.current = null
    }

    const preview = URL.createObjectURL(file)
    previewUrlRef.current = preview
    setSourceVideoPreview(preview)
    setSourceVideoName(file.name)

    const extMatch = file.name.toLowerCase().match(/\.([a-z0-9]{1,5})$/)
    setSourceVideoExt(extMatch ? `.${extMatch[1]}` : '.mp4')

    try {
      const dataUrl = await readFileAsDataUrl(file)
      setSourceVideoBase64(toBase64(dataUrl))
    } catch (error) {
      setSourceVideoBase64(null)
      setErrorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      event.target.value = ''
    }
  }, [])

  const handleGenerate = useCallback(async () => {
    if (!canGenerate || !sourceVideoBase64) return

    const runId = runIdRef.current + 1
    runIdRef.current = runId
    setIsRunning(true)
    setErrorMessage('')
    setOutputVideoUrl(null)
    setStatusMessage(JP_STATUS_PROGRESS)

    try {
      const input: Record<string, unknown> = {
        text: text.trim(),
        video_base64: sourceVideoBase64,
        video_ext: sourceVideoExt,
      }

      const res = await fetch('/api/mmaudio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(extractError(data) || JP_START_FAIL)
      }

      const immediateVideo = extractVideo(data)
      if (immediateVideo) {
        if (runIdRef.current !== runId) return
        setOutputVideoUrl(immediateVideo)
        setOutputFilename(String(data?.output_filename || 'mmaudio-output.mp4'))
        setStatusMessage(JP_VIDEO_READY)
        return
      }

      const jobId = extractJobId(data)
      if (!jobId) {
        throw new Error(JP_JOB_ID_FAIL)
      }

      setStatusMessage(JP_STATUS_PROGRESS)
      for (let i = 0; i < 180; i += 1) {
        if (runIdRef.current !== runId) return

        const pollRes = await fetch(`/api/mmaudio?id=${encodeURIComponent(String(jobId))}`)
        const pollData = await pollRes.json().catch(() => ({}))

        if (!pollRes.ok) {
          throw new Error(extractError(pollData) || JP_STATUS_CHECK_FAIL)
        }

        const maybeVideo = extractVideo(pollData)
        if (maybeVideo) {
          if (runIdRef.current !== runId) return
          setOutputVideoUrl(maybeVideo)
          setOutputFilename(String(pollData?.output_filename || 'mmaudio-output.mp4'))
          setStatusMessage(JP_VIDEO_READY)
          return
        }

        const status = extractStatus(pollData)
        if (isFailureStatus(status)) {
          throw new Error(extractError(pollData) || `${JP_JOB_FAILED_PREFIX}${status}`)
        }

        setStatusMessage(mapStatusText(status))
        await wait(2500)
      }

      throw new Error(JP_TIMEOUT)
    } catch (error) {
      if (runIdRef.current !== runId) return
      setErrorMessage(error instanceof Error ? error.message : String(error))
      setStatusMessage('')
    } finally {
      if (runIdRef.current === runId) {
        setIsRunning(false)
      }
    }
  }, [canGenerate, sourceVideoBase64, sourceVideoExt, text])

  return (
    <div className='studio-page mmaudio-page'>
      <TopNav />
      <main className='mmaudio-wrap'>
        <section className='mmaudio-panel'>
          <header className='mmaudio-heading'>
            <h1>MMAudio</h1>
            <p>動画とテキストから、効果音付きの動画を生成します。</p>
          </header>

          <label className='mmaudio-field'>
            <span>元動画</span>
            <input type='file' accept='video/*' onChange={handleVideoChange} />
          </label>

          {sourceVideoPreview ? (
            <div className='mmaudio-preview'>
              <video controls src={sourceVideoPreview} />
              <p>{sourceVideoName}</p>
            </div>
          ) : (
            <div className='mmaudio-empty'>動画を選択するとここに表示されます。</div>
          )}

          <label className='mmaudio-field'>
            <span>効果音プロンプト</span>
            <textarea
              rows={4}
              maxLength={MAX_TEXT_LENGTH}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder='例: footsteps on wet street, distant thunder, soft city ambience'
            />
          </label>

          <div className='mmaudio-actions'>
            <button type='button' className='mmaudio-generate' disabled={!canGenerate} onClick={handleGenerate}>
              {isRunning ? '生成中…' : '生成開始'}
            </button>
            {statusMessage ? <p className='mmaudio-status'>{statusMessage}</p> : null}
            {errorMessage ? <p className='mmaudio-error'>{errorMessage}</p> : null}
          </div>
        </section>

        <section className='mmaudio-panel mmaudio-panel--result'>
          <header className='mmaudio-heading'>
            <h2>生成結果</h2>
          </header>
          {outputVideoUrl ? (
            <div className='mmaudio-result'>
              <video controls src={outputVideoUrl} />
              <a className='mmaudio-download' href={outputVideoUrl} download={downloadName}>
                動画を保存
              </a>
            </div>
          ) : (
            <div className='mmaudio-empty'>生成結果はここに表示されます。</div>
          )}
        </section>

        <nav className='studio-legal-links' aria-label='リーガルリンク'>
          <Link className='studio-legal-links__item' to='/terms'>
            利用規約
          </Link>
          <Link className='studio-legal-links__item' to='/tokushoho'>
            特商法
          </Link>
        </nav>
      </main>
    </div>
  )
}

