import { useCallback, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { TopNav } from '../components/TopNav'
import './camera.css'
import './tts.css'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const MAX_TEXT_LENGTH = 100
const MAX_VOICE_DESIGN_LENGTH = 300
const FIXED_SECONDS = 20
const FIXED_NUM_STEPS = 40
const HIDDEN_MODEL_NAME_PATTERN =
  /Irodori-TTS-500M-v2-VoiceDesign|Irodori-TTS-500M-v2|Irodori-TTS|Irodori|VoiceDesign/gi
const GENERIC_MODEL_LABEL = '音声モデル'

const sanitizeUserMessage = (value: string) => value.replace(HIDDEN_MODEL_NAME_PATTERN, GENERIC_MODEL_LABEL).trim()

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
      return {
        data: root.audio_base64,
        mime: typeof root.audio_mime === 'string' && root.audio_mime ? root.audio_mime : 'audio/wav',
      }
    }

    const audioObj = root.audio
    if (typeof audioObj === 'string' && audioObj) {
      if (audioObj.startsWith('data:audio/')) {
        return { data: audioObj, mime: 'audio/wav', isDataUrl: true }
      }
      return { data: audioObj, mime: 'audio/wav' }
    }

    if (audioObj && typeof audioObj === 'object') {
      const base64 = audioObj.base64 ?? audioObj.data ?? audioObj.audio_base64
      if (typeof base64 === 'string' && base64) {
        const mime = typeof audioObj.mime === 'string' && audioObj.mime ? audioObj.mime : 'audio/wav'
        return { data: base64, mime }
      }
      const url = audioObj.url ?? audioObj.audio_url
      if (typeof url === 'string' && url.startsWith('data:audio/')) {
        return { data: url, mime: 'audio/wav', isDataUrl: true }
      }
    }
  }

  return null
}

const extractError = (payload: any) =>
  sanitizeUserMessage(
    String(
      payload?.error ||
        payload?.message ||
        payload?.detail ||
        payload?.output?.error ||
        payload?.output?.message ||
        payload?.result?.error ||
        payload?.result?.message ||
        payload?.output?.output?.error ||
        payload?.result?.output?.error ||
        '',
    ),
  )

const extractStatus = (payload: any) =>
  String(payload?.status || payload?.state || payload?.output?.status || payload?.result?.status || '').toLowerCase()

const isFailureStatus = (status: string) => {
  const normalized = status.toLowerCase()
  return normalized.includes('fail') || normalized.includes('error') || normalized.includes('cancel') || normalized.includes('timeout')
}

const extractJobId = (payload: any) => payload?.id || payload?.jobId || payload?.job_id || payload?.output?.id

const normalizeAudioUrl = (audio: { data: string; mime: string; isDataUrl?: boolean }) => {
  if (audio.isDataUrl || audio.data.startsWith('data:audio/')) return audio.data
  return `data:${audio.mime};base64,${audio.data}`
}

export function Tts() {
  const [text, setText] = useState('')
  const [referenceText, setReferenceText] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const [outputAudioUrl, setOutputAudioUrl] = useState<string | null>(null)
  const [outputMeta, setOutputMeta] = useState<{ seed?: number; sampleRate?: number } | null>(null)
  const runIdRef = useRef(0)

  const canGenerate = text.trim().length > 0 && !isRunning
  const downloadName = useMemo(() => `speech-${Date.now()}.wav`, [outputAudioUrl])

  const pollJob = useCallback(async (jobId: string, runId: number) => {
    for (let i = 0; i < 180; i += 1) {
      if (runIdRef.current !== runId) return null

      const res = await fetch(`/api/irodori?id=${encodeURIComponent(jobId)}`)
      const data = await res.json().catch(() => ({}))

      if (!res.ok) {
        throw new Error(extractError(data) || 'ステータス確認に失敗しました。')
      }

      const maybeAudio = extractAudio(data)
      if (maybeAudio) {
        return { audio: normalizeAudioUrl(maybeAudio), payload: data }
      }

      const status = extractStatus(data)
      if (isFailureStatus(status)) {
        throw new Error(extractError(data) || `ジョブが失敗しました: ${status}`)
      }

      await wait(2000 + i * 50)
    }

    throw new Error('音声生成がタイムアウトしました。')
  }, [])

  const handleGenerate = useCallback(async () => {
    if (!canGenerate) return

    const runId = runIdRef.current + 1
    runIdRef.current = runId
    setIsRunning(true)
    setStatusMessage('ジョブを送信しています...')
    setOutputAudioUrl(null)
    setOutputMeta(null)

    try {
      const input: Record<string, unknown> = {
        text: text.trim(),
        seconds: FIXED_SECONDS,
        num_steps: FIXED_NUM_STEPS,
        model_variant: 'voicedesign',
      }
      if (referenceText.trim()) {
        input.reference_text = referenceText.trim()
      }

      const res = await fetch('/api/irodori', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
      })
      const data = await res.json().catch(() => ({}))

      if (!res.ok) {
        throw new Error(extractError(data) || '生成リクエストに失敗しました。')
      }

      const immediateAudio = extractAudio(data)
      if (immediateAudio) {
        if (runIdRef.current !== runId) return
        setOutputAudioUrl(normalizeAudioUrl(immediateAudio))
        setOutputMeta({
          seed: Number.isFinite(Number(data?.seed ?? data?.output?.seed)) ? Number(data?.seed ?? data?.output?.seed) : undefined,
          sampleRate: Number.isFinite(Number(data?.sample_rate ?? data?.output?.sample_rate))
            ? Number(data?.sample_rate ?? data?.output?.sample_rate)
            : undefined,
        })
        setStatusMessage('音声生成が完了しました。')
        return
      }

      const jobId = extractJobId(data)
      if (!jobId) {
        throw new Error('ジョブIDを取得できませんでした。')
      }

      setStatusMessage('生成キューに入りました。完了を待っています...')
      const result = await pollJob(String(jobId), runId)
      if (!result || runIdRef.current !== runId) return

      setOutputAudioUrl(result.audio)
      setOutputMeta({
        seed: Number.isFinite(Number(result.payload?.output?.seed ?? result.payload?.seed))
          ? Number(result.payload?.output?.seed ?? result.payload?.seed)
          : undefined,
        sampleRate: Number.isFinite(Number(result.payload?.output?.sample_rate ?? result.payload?.sample_rate))
          ? Number(result.payload?.output?.sample_rate ?? result.payload?.sample_rate)
          : undefined,
      })
      setStatusMessage('音声生成が完了しました。')
    } catch (error) {
      if (runIdRef.current !== runId) return
      const message = error instanceof Error ? error.message : String(error)
      setStatusMessage(sanitizeUserMessage(message))
    } finally {
      if (runIdRef.current === runId) {
        setIsRunning(false)
      }
    }
  }, [canGenerate, pollJob, referenceText, text])

  return (
    <div className='studio-page tts-page'>
      <TopNav />
      <main className='tts-wrap'>
        <section className='tts-panel'>
          <header className='tts-heading'>
            <h1>音声生成</h1>
            <p>音声モデルで音声生成します。ボイスデザインは任意です。</p>
          </header>

          <label className='tts-field'>
            <span>セリフ</span>
            <textarea
              rows={5}
              maxLength={MAX_TEXT_LENGTH}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder='例: おはようございます。今日もよろしくお願いします。'
            />
          </label>

          <label className='tts-field'>
            <span>ボイスデザイン (任意)</span>
            <textarea
              rows={3}
              maxLength={MAX_VOICE_DESIGN_LENGTH}
              value={referenceText}
              onChange={(e) => setReferenceText(e.target.value)}
              placeholder='声色や雰囲気を説明（例: 柔らかく明るいトーン）'
            />
          </label>

          <div className='tts-actions'>
            <button type='button' className='tts-generate' disabled={!canGenerate} onClick={handleGenerate}>
              {isRunning ? '生成中...' : '音声生成'}
            </button>
            {statusMessage && <p className='tts-status'>{statusMessage}</p>}
          </div>
        </section>

        <section className='tts-panel tts-panel--result'>
          <header className='tts-heading'>
            <h2>生成結果</h2>
          </header>
          {outputAudioUrl ? (
            <div className='tts-result'>
              <audio controls src={outputAudioUrl} />
              <a className='tts-download' href={outputAudioUrl} download={downloadName}>
                WAVを保存
              </a>
              <div className='tts-meta'>
                {outputMeta?.sampleRate ? <p>Sample Rate: {outputMeta.sampleRate} Hz</p> : null}
                {outputMeta?.seed !== undefined ? <p>Seed: {outputMeta.seed}</p> : null}
              </div>
            </div>
          ) : (
            <div className='tts-empty'>生成結果はここに表示されます。</div>
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
