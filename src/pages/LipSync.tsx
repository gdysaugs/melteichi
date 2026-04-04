import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { Link } from 'react-router-dom'
import { TopNav } from '../components/TopNav'
import './camera.css'
import './lipsync.css'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const MAX_TEXT_LENGTH = 100
const MAX_VOICE_DESIGN_LENGTH = 300
const HIDDEN_MODEL_NAME_PATTERN =
  /Irodori-TTS-500M-v2-VoiceDesign|Irodori-TTS-500M-v2|Irodori-TTS|Irodori|VoiceDesign/gi
const GENERIC_MODEL_LABEL = '\u97f3\u58f0\u30e2\u30c7\u30eb'

const EMOJI_MANUAL_GROUPS = [
  {
    title: '\u97f3\u58f0\u6f14\u51fa',
    items: [
      ['\u{1F92B}', '\u56c1\u304d\u3001\u8033\u5143\u306e\u97f3'],
      ['\u{1F62E}\u200d\u{1F4A8}', '\u5410\u606f\u3001\u6e9c\u606f\u3001\u5bdd\u606f'],
      ['\u23F8\uFE0F', '\u9593\u3001\u6c88\u9ed9'],
      ['\u{1F602}', '\u7b11\u3044\uff08\u304f\u3059\u304f\u3059\u3001\u542b\u307f\u7b11\u3044\uff09'],
      ['\u{1F62E}', '\u606f\u3092\u306e\u3080'],
      ['\u{1F60B}', '\u8210\u3081\u308b\u97f3\u3001\u54c0\u568c\u97f3\u3001\u6c34\u97f3'],
      ['\u{1F444}', '\u30ea\u30c3\u30d7\u30ce\u30a4\u30ba'],
      ['\u{1F4DE}', '\u96fb\u8a71\u8d8a\u3057\u30fb\u30b9\u30d4\u30fc\u30ab\u30fc\u8d8a\u3057\u98a8'],
    ],
  },
  {
    title: '\u611f\u60c5\u8868\u73fe',
    items: [
      ['\u{1F622}', '\u55da\u54bd\u3001\u6ce3\u304d\u58f0\u3001\u60b2\u3057\u307f'],
      ['\u{1F631}', '\u60b2\u9cf4\u3001\u53eb\u3073\u3001\u7d76\u53eb'],
      ['\u{1F621}', '\u6012\u308a\u3001\u4e0d\u6e80\u3052'],
      ['\u{1F62F}', '\u9a5a\u304d\u3001\u611f\u5606'],
      ['\u{1F97A}', '\u61c7\u9858\u3059\u308b\u3088\u3046\u306b'],
      ['\u{1F633}', '\u6065\u305a\u304b\u3057\u305d\u3046\u306b\u3001\u7167\u308c\u306a\u304c\u3089'],
      ['\u{1F644}', '\u5446\u308c\u305f\u3088\u3046\u306b'],
      ['\u{1F60C}', '\u5b89\u582a\u3001\u6e80\u8db3\u3052\u306b'],
    ],
  },
  {
    title: '\u8a71\u3057\u65b9\u30fb\u30c8\u30fc\u30f3',
    items: [
      ['\u{1F60F}', '\u304b\u3089\u304b\u3046\u3088\u3046\u306b\u3001\u7518\u3048\u308b\u3088\u3046\u306b'],
      ['\u{1F60A}', '\u512a\u3057\u304f'],
      ['\u{1F634}', '\u7720\u305d\u3046\u306b\u3001\u6c17\u3060\u308b\u3052\u306b'],
      ['\u{1F4AB}', '\u58f0\u3092\u9707\u308f\u305b\u306a\u304c\u3089\u3001\u81ea\u4fe1\u306a\u3055\u3052\u306b'],
      ['\u{1F62E}\u200d\u{1F4A8}', '\u606f\u5207\u308c\u3001\u8352\u3044\u606f\u9063\u3044'],
      ['\u{1F62E}\u200d\u{1F4A7}', '\u6163\u3066\u3066\u3001\u52d5\u63fa\u3001\u7dca\u5f35\u3001\u3069\u3082\u308a'],
      ['\u{1F92F}', '\u9154\u3063\u6255\u3063\u3066'],
      ['\u{1F914}', '\u7591\u554f\u306e\u58f0'],
    ],
  },
  {
    title: '\u901f\u5ea6\u30fb\u30ea\u30ba\u30e0',
    items: [
      ['\u23E9', '\u65e9\u53e3\u3001\u4e00\u6c17\u306b\u307e\u304f\u3057\u305f\u3066\u308b'],
      ['\u{1F422}', '\u3086\u3063\u304f\u308a\u3068'],
      ['\u{1F44D}', '\u76f8\u69cc\u3001\u9817\u304f\u97f3'],
      ['\u{1F3B5}', '\u9f3b\u6b4c'],
      ['\u{1F910}', '\u53e3\u3092\u585e\u304c\u308c\u3066\u3044\u308b\u3088\u3046\u306a\u58f0'],
      ['\u{1F927}', '\u54b3\u8fbc\u307f\u3001\u9f3b\u3092\u3059\u3059\u308b\u3001\u304f\u3057\u3083\u307f'],
      ['\u{1F971}', '\u3042\u304f\u3073'],
      ['\u{1F61E}', '\u82e6\u3057\u3052\u306b'],
    ],
  },
] as const

const JP_READ_VIDEO_FAIL = '\u52d5\u753b\u306e\u8aad\u307f\u8fbc\u307f\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002'
const JP_STATUS_DONE = '\u751f\u6210\u304c\u5b8c\u4e86\u3057\u307e\u3057\u305f\u3002'
const JP_STATUS_QUEUE = '\u30ad\u30e5\u30fc\u3067\u5f85\u6a5f\u4e2d\u3067\u3059\u2026'
const JP_STATUS_PROGRESS = '\u52d5\u753b\u3092\u751f\u6210\u4e2d\u3067\u3059\u2026'
const JP_STATUS_FAILED = '\u751f\u6210\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002'
const JP_STATUS_PREFIX = '\u72b6\u614b: '
const JP_START_FAIL = '\u751f\u6210\u958b\u59cb\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002'
const JP_VIDEO_READY = '\u52d5\u753b\u3092\u751f\u6210\u3057\u307e\u3057\u305f\u3002'
const JP_JOB_ID_FAIL = '\u30b8\u30e7\u30d6ID\u306e\u53d6\u5f97\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002'
const JP_STATUS_CHECK_FAIL = '\u30b9\u30c6\u30fc\u30bf\u30b9\u78ba\u8a8d\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002'
const JP_JOB_FAILED_PREFIX = '\u30b8\u30e7\u30d6\u304c\u5931\u6557\u3057\u307e\u3057\u305f: '
const JP_TIMEOUT = '\u52d5\u753b\u751f\u6210\u304c\u30bf\u30a4\u30e0\u30a2\u30a6\u30c8\u3057\u307e\u3057\u305f\u3002'
const JP_STATUS_SPEECH = '\u97f3\u58f0\u3092\u751f\u6210\u3057\u3066\u3044\u307e\u3059\u2026'
const JP_STATUS_VIDEO = '\u52d5\u753b\u3092\u751f\u6210\u4e2d\u3067\u3059\u2026'

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

const sanitizeUserMessage = (value: string) => value.replace(HIDDEN_MODEL_NAME_PATTERN, GENERIC_MODEL_LABEL).trim()

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

export function LipSync() {
  const [text, setText] = useState('')
  const [voiceDesign, setVoiceDesign] = useState('')
  const [sourceVideoPreview, setSourceVideoPreview] = useState<string | null>(null)
  const [sourceVideoName, setSourceVideoName] = useState('')
  const [sourceVideoBase64, setSourceVideoBase64] = useState<string | null>(null)
  const [sourceVideoExt, setSourceVideoExt] = useState('.mp4')

  const [statusMessage, setStatusMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const [outputVideoUrl, setOutputVideoUrl] = useState<string | null>(null)
  const [outputFilename, setOutputFilename] = useState<string>('lipsync-output.mp4')

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
  const downloadName = useMemo(() => outputFilename || `lipsync-${Date.now()}.mp4`, [outputFilename])

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
    setStatusMessage(JP_STATUS_SPEECH)

    try {
      const input: Record<string, unknown> = {
        text: text.trim(),
        video_base64: sourceVideoBase64,
        video_ext: sourceVideoExt,
      }
      if (voiceDesign.trim()) {
        input.reference_text = voiceDesign.trim()
      }

      const res = await fetch('/api/lipsync', {
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
        setOutputFilename(String(data?.output_filename || 'lipsync-output.mp4'))
        setStatusMessage(JP_VIDEO_READY)
        return
      }

      const jobId = extractJobId(data)
      if (!jobId) {
        throw new Error(JP_JOB_ID_FAIL)
      }

      setStatusMessage(JP_STATUS_VIDEO)
      for (let i = 0; i < 180; i += 1) {
        if (runIdRef.current !== runId) return

        const pollRes = await fetch(`/api/lipsync?id=${encodeURIComponent(String(jobId))}`)
        const pollData = await pollRes.json().catch(() => ({}))

        if (!pollRes.ok) {
          throw new Error(extractError(pollData) || JP_STATUS_CHECK_FAIL)
        }

        const maybeVideo = extractVideo(pollData)
        if (maybeVideo) {
          if (runIdRef.current !== runId) return
          setOutputVideoUrl(maybeVideo)
          setOutputFilename(String(pollData?.output_filename || 'lipsync-output.mp4'))
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
      const message = error instanceof Error ? error.message : String(error)
      setErrorMessage(sanitizeUserMessage(message))
      setStatusMessage('')
    } finally {
      if (runIdRef.current === runId) {
        setIsRunning(false)
      }
    }
  }, [canGenerate, sourceVideoBase64, sourceVideoExt, text, voiceDesign])

  return (
    <div className='studio-page lipsync-page'>
      <TopNav />
      <main className='lipsync-wrap'>
        <section className='lipsync-panel'>
          <header className='lipsync-heading'>
            <h1>{'\u53e3\u30d1\u30af\u52d5\u753b\u751f\u6210'}</h1>
            <p>{'\u30bb\u30ea\u30d5\u3068\u5143\u52d5\u753b\u304b\u3089\u53e3\u30d1\u30af\u52d5\u753b\u3092\u751f\u6210\u3057\u307e\u3059\u3002'}</p>
          </header>

          <label className='lipsync-field'>
            <span>{'\u5143\u52d5\u753b'}</span>
            <input type='file' accept='video/*' onChange={handleVideoChange} />
          </label>

          {sourceVideoPreview ? (
            <div className='lipsync-preview'>
              <video controls src={sourceVideoPreview} />
              <p>{sourceVideoName}</p>
            </div>
          ) : (
            <div className='lipsync-empty'>{'\u52d5\u753b\u3092\u9078\u629e\u3059\u308b\u3068\u3053\u3053\u306b\u8868\u793a\u3055\u308c\u307e\u3059\u3002'}</div>
          )}

          <label className='lipsync-field'>
            <span>{'\u30bb\u30ea\u30d5'}</span>
            <textarea
              rows={4}
              maxLength={MAX_TEXT_LENGTH}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={'\u4f8b: \u304a\u306f\u3088\u3046\u3054\u3056\u3044\u307e\u3059\u3002\u4eca\u65e5\u3082\u3088\u308d\u3057\u304f\u304a\u9858\u3044\u3057\u307e\u3059\u3002'}
            />
          </label>

          <label className='lipsync-field'>
            <span>{'\u30dc\u30a4\u30b9\u30c7\u30b6\u30a4\u30f3\uff08\u4efb\u610f\uff09'}</span>
            <textarea
              rows={3}
              maxLength={MAX_VOICE_DESIGN_LENGTH}
              value={voiceDesign}
              onChange={(e) => setVoiceDesign(e.target.value)}
              placeholder={'\u4f8b:\u5e7c\u3044\u5973\u306e\u5b50\u306e\u58f0\u3002\u304b\u3089\u304b\u3046\u3088\u3046\u306a\u3057\u3083\u3079\u308a\u65b9\u3002'}
            />
          </label>



          <section className='lipsync-manual' aria-label={'\u30dc\u30a4\u30b9\u30c7\u30b6\u30a4\u30f3\u5165\u529b\u30de\u30cb\u30e5\u30a2\u30eb'}>
            <h3>{'\u30dc\u30a4\u30b9\u30c7\u30b6\u30a4\u30f3\u5165\u529b\u30de\u30cb\u30e5\u30a2\u30eb'}</h3>
            <p>
              {
                '\u3053\u306e\u97f3\u58f0\u30e2\u30c7\u30eb\u306f\u3001\u30bb\u30ea\u30d5\u5185\u306e\u7d75\u6587\u5b57\u3067\u611f\u60c5\u3084\u8a71\u3057\u65b9\u3001\u97f3\u306e\u6f14\u51fa\u3092\u5236\u5fa1\u3067\u304d\u307e\u3059\u3002'
              }
            </p>
            <p>
              {
                '\u540c\u3058\u7d75\u6587\u5b57\u3092\u8907\u6570\u56de\u4f7f\u3046\u3068\u52b9\u679c\u3092\u5f37\u3081\u3089\u308c\u307e\u3059\u3002\u52b9\u679c\u306f\u5b8c\u5168\u56fa\u5b9a\u3067\u306f\u306a\u3044\u306e\u3067\u3001\u751f\u6210\u7d50\u679c\u3092\u898b\u306a\u304c\u3089\u8abf\u6574\u3057\u3066\u304f\u3060\u3055\u3044\u3002'
              }
            </p>
            <p className='lipsync-manual__example'>
              {'\u4f8b: \u300c\u304a\u306f\u3088\u3046\u{1F60A}\u300d\u300c\u3073\u3063\u304f\u308a\u3057\u305f\u{1F62F}\u300d\u300c\u3086\u3063\u304f\u308a\u8a71\u3057\u3066\u{1F422}\u300d'}
            </p>
            <div className='lipsync-manual__groups'>
              {EMOJI_MANUAL_GROUPS.map((group) => (
                <div key={group.title} className='lipsync-manual__group'>
                  <h4>{group.title}</h4>
                  <ul>
                    {group.items.map(([emoji, meaning]) => (
                      <li key={`${group.title}-${emoji}`}>
                        <span className='lipsync-manual__emoji' aria-hidden='true'>
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
          <div className='lipsync-actions'>
            <button type='button' className='lipsync-generate' disabled={!canGenerate} onClick={handleGenerate}>
              {isRunning ? '\u751f\u6210\u4e2d\u2026' : '\u751f\u6210\u958b\u59cb'}
            </button>
            {statusMessage ? <p className='lipsync-status'>{statusMessage}</p> : null}
            {errorMessage ? <p className='lipsync-error'>{errorMessage}</p> : null}
          </div>
        </section>

        <section className='lipsync-panel lipsync-panel--result'>
          <header className='lipsync-heading'>
            <h2>{'\u751f\u6210\u7d50\u679c'}</h2>
          </header>
          {outputVideoUrl ? (
            <div className='lipsync-result'>
              <video controls src={outputVideoUrl} />
              <a className='lipsync-download' href={outputVideoUrl} download={downloadName}>
                {'\u52d5\u753b\u3092\u4fdd\u5b58'}
              </a>
            </div>
          ) : (
            <div className='lipsync-empty'>{'\u751f\u6210\u7d50\u679c\u306f\u3053\u3053\u306b\u8868\u793a\u3055\u308c\u307e\u3059\u3002'}</div>
          )}
        </section>

        <nav className='studio-legal-links' aria-label={'\u30ea\u30fc\u30ac\u30eb\u30ea\u30f3\u30af'}>
          <Link className='studio-legal-links__item' to='/terms'>
            {'\u5229\u7528\u898f\u7d04'}
          </Link>
          <Link className='studio-legal-links__item' to='/tokushoho'>
            {'\u7279\u5546\u6cd5'}
          </Link>
        </nav>
      </main>
    </div>
  )
}


