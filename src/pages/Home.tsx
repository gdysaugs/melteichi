import { useCallback } from 'react'
import { Link } from 'react-router-dom'
import { TopNav } from '../components/TopNav'
import { isAuthConfigured, supabase } from '../lib/supabaseClient'
import './camera.css'
import './home.css'

const HERO_BANNER = '/media/lp/meltai-h-banner.png'
const WORKFLOW_SAMPLE_VIDEOS = [
  { src: '/media/lp/meltai-h-sample-5s.mp4', poster: '/media/lp/meltai-h-sample-5s-poster.png', label: '5秒サンプル' },
  { src: '/media/lp/meltai-h-sample-8s.mp4', poster: '/media/lp/meltai-h-sample-8s-poster.png', label: '8秒サンプル' },
] as const

const ENGINE_STATS = [
  { value: 'Fixed', label: '強化学習パック' },
  { value: 'I2V', label: 'Image to video engine' },
  { value: 'HD', label: 'Crisp motion and detail' },
] as const

const FEATURE_CARDS = [
  {
    title: '最新の強化学習をまとめて搭載',
    body: 'MeltAIの動画モデルに、相性を見て選んだ最新の強化学習をまとめて搭載。1回の生成で密度の高い動きと質感を狙えます。',
  },
  {
    title: '1枚の画像から動画化',
    body: '元画像をアップロードして、動きの指示を書くだけでそのまま動画生成へ。複雑な設定を減らし、すぐ試せる構成にしています。',
  },
  {
    title: '固定ワークフローですぐ使える',
    body: '画像とプロンプトを入れて、そのまま生成。迷いにくい流れで、短いサンプルや訴求動画を素早く組み立てられます。',
  },
] as const

const ENGINE_POINTS = [
  'MeltAI-H は MeltAI の動画モデルに最新の強化学習をまとめて組み込んだ固定エンジンです。',
  '強化学習を個別に切り替えなくても、最初から密度感のある質感と動きの乗りを狙えます。',
  '1 枚の画像と短いプロンプトだけで、すぐに映像の方向性を確認できます。',
] as const

const WORKFLOW_STEPS = [
  {
    title: '1. Upload image',
    body: '元画像をアップロードして、ベースになるビジュアルを決めます。',
  },
  {
    title: '2. Write motion prompt',
    body: 'どう動かしたいかを短く書いて、動画の方向を指定します。',
  },
  {
    title: '3. Render and refine',
    body: '生成結果を見ながら、必要に応じてプロンプトを調整します。',
  },
] as const

const OAUTH_REDIRECT_URL =
  import.meta.env.VITE_SUPABASE_REDIRECT_URL ?? (typeof window !== 'undefined' ? window.location.origin : undefined)

export function Home() {
  const handleStart = useCallback(async () => {
    if (!supabase || !isAuthConfigured) return

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: OAUTH_REDIRECT_URL, skipBrowserRedirect: true },
    })

    if (error) {
      window.alert(error.message)
      return
    }

    if (data?.url) {
      window.location.assign(data.url)
    }
  }, [])

  return (
    <div className='home-page home-page--lp'>
      <TopNav />
      <main className='home-wrap home-wrap--lp home-ocean'>
        <section className='home-ocean-hero' aria-label='MeltAI-H hero'>
          <div className='home-ocean-copy'>
            <p className='home-ocean-kicker'>MeltAI-H Ocean Engine</p>
            <h1>MeltAIの動画モデルに最新の強化学習をまとめた動画エンジン</h1>
            <figure className='home-ocean-banner home-ocean-banner--mobile'>
              <img src={HERO_BANNER} alt='MeltAI-H banner visual' loading='eager' />
            </figure>
            <p className='home-ocean-lead'>
              1枚の画像から、強化学習を束ねたリッチな動画生成へ。MeltAI-H は、すぐ試せて、映像の密度を一段上げるための動画エンジンです。
            </p>
            <div className='home-ocean-actions'>
              <button type='button' className='home-lp-voice__cta' onClick={() => void handleStart()}>
                動画生成を試す
              </button>
            </div>
            <div className='home-ocean-stats' aria-label='engine stats'>
              {ENGINE_STATS.map((item) => (
                <article key={item.label} className='home-ocean-stat'>
                  <strong>{item.value}</strong>
                  <span>{item.label}</span>
                </article>
              ))}
            </div>
          </div>

          <figure className='home-ocean-banner'>
            <img src={HERO_BANNER} alt='MeltAI-H banner visual' loading='eager' />
          </figure>
        </section>

        <section className='home-ocean-grid' aria-label='features'>
          {FEATURE_CARDS.map((card) => (
            <article key={card.title} className='home-ocean-card'>
              <h2>{card.title}</h2>
              <p>{card.body}</p>
            </article>
          ))}
        </section>

        <section className='home-ocean-panel' aria-label='about MeltAI-H'>
          <div className='home-ocean-panel__head'>
            <p className='home-ocean-kicker'>Why MeltAI-H</p>
            <h2>強化学習をまとめて積んだ、すぐ使える動画パック</h2>
          </div>
          <div className='home-ocean-panel__body'>
            <ul className='home-ocean-list'>
              {ENGINE_POINTS.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </div>
        </section>

        <section className='home-ocean-workflow' aria-label='workflow'>
          <div className='home-ocean-panel__head'>
            <p className='home-ocean-kicker'>Simple Workflow</p>
            <h2>最短3ステップで動画生成</h2>
          </div>
          <div className='home-ocean-samples' aria-label='sample videos'>
            {WORKFLOW_SAMPLE_VIDEOS.map((sample) => (
              <figure key={sample.src} className='home-ocean-sample'>
                <video
                  src={sample.src}
                  poster={sample.poster}
                  controls
                  muted
                  loop
                  playsInline
                  preload='metadata'
                />
                <figcaption>{sample.label}</figcaption>
              </figure>
            ))}
          </div>
          <div className='home-ocean-workflow__grid'>
            {WORKFLOW_STEPS.map((step) => (
              <article key={step.title} className='home-ocean-step'>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </article>
            ))}
          </div>
        </section>

        <nav className='home-ocean-legal-links' aria-label='リーガルリンク'>
          <Link className='home-ocean-legal-links__item' to='/terms'>
            利用規約
          </Link>
          <Link className='home-ocean-legal-links__item' to='/tokushoho'>
            特商法
          </Link>
        </nav>
      </main>
    </div>
  )
}
