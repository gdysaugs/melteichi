import type { MouseEvent } from 'react'
import { Link } from 'react-router-dom'

export type VideoEngine = 'a' | 'b' | 'c'

type VideoEngineCardsProps = {
  activeEngine: VideoEngine
  disabled?: boolean
}

export function VideoEngineCards({ activeEngine, disabled = false }: VideoEngineCardsProps) {
  const blockWhenDisabled = (event: MouseEvent<HTMLAnchorElement>) => {
    if (disabled) event.preventDefault()
  }

  return (
    <section className="studio-engine-switcher" aria-label="生成エンジン切り替え">
      <Link
        to="/video"
        className={`studio-engine-card studio-engine-card--a${activeEngine === 'a' ? ' is-active' : ''}${disabled ? ' is-disabled' : ''}`}
        aria-current={activeEngine === 'a' ? 'page' : undefined}
        aria-disabled={disabled || undefined}
        tabIndex={disabled ? -1 : undefined}
        onClick={blockWhenDisabled}
      >
        <span className="studio-engine-card__label">エンジンA</span>
        <strong>動画生成</strong>
        <span className="studio-engine-card__description">画像と指示から動画を生成します。</span>
        {activeEngine === 'a' && <span className="studio-engine-card__active">選択中</span>}
      </Link>

      <Link
        to="/video?engine=b"
        className={`studio-engine-card studio-engine-card--b${activeEngine === 'b' ? ' is-active' : ''}${disabled ? ' is-disabled' : ''}`}
        aria-current={activeEngine === 'b' ? 'page' : undefined}
        aria-disabled={disabled || undefined}
        tabIndex={disabled ? -1 : undefined}
        onClick={blockWhenDisabled}
      >
        <span className="studio-engine-card__label">エンジンB</span>
        <strong>音声付き動画生成</strong>
        <span className="studio-engine-card__description">映像と音声を同時に生成します。</span>
        {activeEngine === 'b' && <span className="studio-engine-card__active">選択中</span>}
      </Link>

      <Link
        to="/video?engine=c"
        className={`studio-engine-card studio-engine-card--c${activeEngine === 'c' ? ' is-active' : ''}${disabled ? ' is-disabled' : ''}`}
        aria-current={activeEngine === 'c' ? 'page' : undefined}
        aria-disabled={disabled || undefined}
        tabIndex={disabled ? -1 : undefined}
        onClick={blockWhenDisabled}
      >
        <span className="studio-engine-card__label">エンジンC</span>
        <strong>複数素材動画生成</strong>
        <span className="studio-engine-card__description">人物画像とオブジェクト画像から動画を生成します。</span>
        {activeEngine === 'c' && <span className="studio-engine-card__active">選択中</span>}
      </Link>
    </section>
  )
}
