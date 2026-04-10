import { Link } from 'react-router-dom'
import { TopNav } from '../components/TopNav'
import './camera.css'
import './legal.css'

export function Tokushoho() {
  return (
    <div className="camera-app">
      <TopNav />
      <main className="legal-shell">
        <section className="legal-card">
          <h1>特定商取引法に基づく表記</h1>
          <p>
            本表記は、MeltAI-Hが提供するデジタルサービス（Gem購入・動画生成機能等）に関する取引条件を示すものです。
          </p>

          <div className="legal-table">
            <div className="legal-row">
              <div className="legal-key">販売事業者</div>
              <div className="legal-value">MeltAI運営事務局</div>
            </div>
            <div className="legal-row">
              <div className="legal-key">運営責任者</div>
              <div className="legal-value">Sato Natsu</div>
            </div>
            <div className="legal-row">
              <div className="legal-key">所在地</div>
              <div className="legal-value">愛知県名古屋市中区</div>
            </div>
            <div className="legal-row">
              <div className="legal-key">電話番号</div>
              <div className="legal-value">0582105684301</div>
            </div>
            <div className="legal-row">
              <div className="legal-key">問い合わせ先</div>
              <div className="legal-value">サイト内問い合わせフォームまたは上記電話番号</div>
            </div>
            <div className="legal-row">
              <div className="legal-key">販売価格</div>
              <div className="legal-value">購入ページに表示された各プランの価格（消費税込）</div>
            </div>
            <div className="legal-row">
              <div className="legal-key">商品代金以外の必要料金</div>
              <div className="legal-value">インターネット接続料金、通信料金、決済時に発生する各種手数料（発生する場合）</div>
            </div>
            <div className="legal-row">
              <div className="legal-key">支払方法</div>
              <div className="legal-value">クレジットカード決済（Stripe）</div>
            </div>
            <div className="legal-row">
              <div className="legal-key">支払時期</div>
              <div className="legal-value">購入手続き完了時に決済処理が行われます</div>
            </div>
            <div className="legal-row">
              <div className="legal-key">商品の提供時期</div>
              <div className="legal-value">決済完了後、直ちにアカウントへ反映・利用可能</div>
            </div>
            <div className="legal-row">
              <div className="legal-key">販売数量の制限</div>
              <div className="legal-value">システムの在庫・上限設定・不正利用対策により、購入数量を制限する場合があります</div>
            </div>
            <div className="legal-row">
              <div className="legal-key">返品・交換・キャンセル</div>
              <div className="legal-value">デジタル商品の性質上、決済完了後の返品・交換・キャンセルは原則不可</div>
            </div>
            <div className="legal-row">
              <div className="legal-key">返金について</div>
              <div className="legal-value">法令に基づき返金義務がある場合を除き、返金には対応していません</div>
            </div>
            <div className="legal-row">
              <div className="legal-key">動作環境</div>
              <div className="legal-value">最新の主要ブラウザ（Chrome / Edge / Safari 等）および安定したインターネット接続環境</div>
            </div>
            <div className="legal-row">
              <div className="legal-key">特別条件</div>
              <div className="legal-value">キャンペーン・無料付与Gem等の条件は、告知なく変更・終了する場合があります</div>
            </div>
          </div>

          <div className="legal-links">
            <Link className="legal-link" to="/terms">
              利用規約
            </Link>
            <Link className="legal-link" to="/">
              生成ページへ戻る
            </Link>
          </div>
        </section>
      </main>
    </div>
  )
}
