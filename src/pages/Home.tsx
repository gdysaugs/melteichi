import { useState } from 'react'
import { TopNav } from '../components/TopNav'
import './camera.css'
import './home.css'

const LP_REFERENCE_IMAGE = '/media/lp/akuma-lp-reference.avif'
const LP_DEMO_VIDEO = '/media/lp/akuma-lp-demo.mp4'
const LP_VOICE_SAMPLE = '/media/lp/caption_sample6.wav'
const LP_SFX_SAMPLE_VIDEO = '/media/lp/moviegenaudio-example-1-exact-20260402.mp4'

const VOICE_EMOJI_GROUPS = [
  {
    title: '音声演出',
    items: [
      ['👂', '囁き、耳元の音'],
      ['😮‍💨', '吐息、溜息、寝息'],
      ['⏸️', '間、沈黙'],
      ['🤭', '笑い（くすくす、含み笑いなど）'],
      ['🥵', '喘ぎ、うめき声、唸り声'],
      ['📢', 'エコー、リバーブ'],
      ['🌬️', '息切れ、荒い息遣い、呼吸音'],
      ['😮', '息をのむ'],
      ['👅', '舐める音、咀嚼音、水音'],
      ['💋', 'リップノイズ'],
      ['📞', '電話越し、スピーカー越しのような音'],
      ['🥤', '唾を飲み込む音'],
      ['🤧', '咳き込み、鼻をすする、くしゃみ、咳払い'],
      ['😒', '舌打ち'],
      ['👌', '相槌、頷く音'],
      ['🎵', '鼻歌'],
      ['🤐', '口を塞がれて'],
    ],
  },
  {
    title: '感情表現',
    items: [
      ['🫶', '優しく'],
      ['😭', '嗚咽、泣き声、悲しみ'],
      ['😱', '悲鳴、叫び、絶叫'],
      ['😆', '喜びながら'],
      ['😠', '怒り、不満げに、拗ねながら'],
      ['😲', '驚き、感嘆'],
      ['😖', '苦しげに'],
      ['😟', '心配そうに'],
      ['🫣', '恥ずかしそうに、照れながら'],
      ['🙄', '呆れたように'],
      ['😊', '楽しげに、嬉しそうに'],
      ['🙏', '懇願するように'],
      ['😌', '安堵、満足げに'],
      ['🤔', '疑問の声'],
    ],
  },
  {
    title: '話し方',
    items: [
      ['😏', 'からかうように'],
      ['🥺', '声を震わせながら、自信のなさげに'],
      ['😪', '眠そうに、気だるげに'],
      ['😰', '慌てて、動揺、緊張、どもり'],
      ['🥴', '酔っ払って'],
      ['🥱', 'あくび'],
    ],
  },
  {
    title: '速度・リズム',
    items: [
      ['⏩', '早口、一気にまくしたてる、急いで'],
      ['🐢', 'ゆっくりと'],
    ],
  },
] as const

export function Home() {
  const [demoVideoKey, setDemoVideoKey] = useState(0)

  return (
    <div className='home-page home-page--lp'>
      <TopNav />
      <main className='home-wrap home-wrap--lp'>
        <section className='home-lp-hero' aria-label='LPヘッダー'>
          <h1>画像からセリフ効果音付きの動画を作ろう</h1>
        </section>

        <section className='home-lp-showcase' aria-label='生成サンプル'>
          <figure className='home-lp-card'>
            <img src={LP_REFERENCE_IMAGE} alt='参考イメージ' loading='eager' />
            <figcaption>Input Image</figcaption>
          </figure>
          <figure className='home-lp-card'>
            <video
              key={demoVideoKey}
              controls
              playsInline
              preload='metadata'
              poster={LP_REFERENCE_IMAGE}
              src={LP_DEMO_VIDEO}
              onEnded={() => setDemoVideoKey((prev) => prev + 1)}
            />
            <figcaption>Output Preview</figcaption>
          </figure>
        </section>

        <div className='home-lp-inline-example' aria-label='入力例'>
          <article className='home-lp-inline-example__item'>
            <strong>プロンプト</strong>
            <span>女性が睨む</span>
          </article>
          <article className='home-lp-inline-example__item'>
            <strong>セリフ</strong>
            <span>何見てんのよ？💋</span>
          </article>
          <article className='home-lp-inline-example__item'>
            <strong>効果音</strong>
            <span>wind</span>
          </article>
        </div>

        <section className='home-lp-capabilities' aria-label='AkumaAIでできること'>
          <h2>AkumaAIでできること</h2>
          <ul>
            <li>5秒 / 7秒 / 10秒の動画を生成可能</li>
            <li>無料登録で3回まで生成を体験可能</li>
            <li>画像1枚からセリフ付き動画を簡単生成</li>
            <li>効果音付き動画をワンステップで生成</li>
            <li>ボイス指示で声質・感情を細かく調整可能</li>
          </ul>
        </section>

        <div className='home-lp-voice__cta-wrap'>
          <a className='home-lp-voice__cta' href='/video?model=v6'>
            今すぐ無料で試す
          </a>
        </div>

        <section className='home-lp-voice' aria-label='ボイスデザイン案内'>
          <h2>テキスト指示だけで、声質と感情を作れる</h2>
          <p>VoiceDesignは文章と絵文字の指定だけで、声の雰囲気・感情・話し方を調整できます。</p>
          <p>対応絵文字は全39種類です。</p>
          <article className='home-lp-voice__sample'>
            <h3>実際の音声サンプル</h3>
            <p className='home-lp-voice__sample-label'>セリフ</p>
            <p className='home-lp-voice__sample-text'>これ😠、昨日からずっと机の上に置きっぱなしになってますよ😒早く片付けておいてくださいね😠</p>
            <p className='home-lp-voice__sample-label'>ボイス指示</p>
            <p className='home-lp-voice__sample-text'>低めの女性の声で、嫌悪感を示しながら怒っているように話してほしいです。途中で舌打ちを挟み、強い憎しみを持って見下している感じでお願いします。</p>
            <audio controls preload='metadata' src={LP_VOICE_SAMPLE} />
          </article>
          <div className='home-lp-voice__grid'>
            {VOICE_EMOJI_GROUPS.map((group) => (
              <article key={group.title} className='home-lp-voice__card'>
                <h3>{group.title}</h3>
                <ul>
                  {group.items.map(([emoji, meaning]) => (
                    <li key={group.title + '-' + emoji}>
                      <span className='home-lp-voice__emoji' aria-hidden='true'>
                        {emoji}
                      </span>
                      <span>{meaning}</span>
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </section>

        <section className='home-lp-sfx' aria-label='効果音機能アピール'>
          <h2>効果音機能</h2>
          <p>動画の内容を自動で解析し、テキスト指示と合わせて最適な効果音を自動生成して動画に合成。</p>
          <article className='home-lp-sfx__prompt'>
            <h3>プロンプト例</h3>
            <p>氷が鋭いパキッという音を立てて割れ、金属製の道具が氷の表面をこすります。</p>
          </article>
          <div className='home-lp-sfx__video'>
            <video controls playsInline preload='metadata' src={LP_SFX_SAMPLE_VIDEO} />
          </div>
        </section>
      </main>
    </div>
  )
}
