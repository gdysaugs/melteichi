import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabaseClient'
import { PURCHASE_PLANS } from '../lib/purchasePlans'
import { TopNav } from '../components/TopNav'
import './camera.css'
import './purchase.css'

export function Purchase() {
  const [session, setSession] = useState<Session | null>(null)
  const [purchaseStatus, setPurchaseStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [purchaseMessage, setPurchaseMessage] = useState('')

  const accessToken = session?.access_token ?? ''
  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null))
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      setPurchaseStatus('idle')
      setPurchaseMessage('')
    })
    return () => subscription.unsubscribe()
  }, [])

  const handleCheckout = async (planId: string) => {
    if (!session || !accessToken) {
      setPurchaseStatus('error')
      setPurchaseMessage('購入情報の読み込み中です。少し待ってから再試行してください。')
      return
    }

    setPurchaseStatus('loading')
    setPurchaseMessage('決済ページへ移動中...')
    const res = await fetch('/api/stripe/checkout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ plan_id: planId }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data?.url) {
      setPurchaseStatus('error')
      setPurchaseMessage(data?.error || '決済作成に失敗しました。')
      return
    }
    window.location.assign(data.url)
  }

  return (
    <div className="camera-app purchase-app purchase-page">
      <TopNav />
      <main className="token-lab">
        <section className="token-layout token-layout--single">
          <article className="token-card token-card--store">
            <div className="token-card__head">
              <div>
                <p className="token-card__kicker">STORE</p>
                <h2>Gem購入</h2>
              </div>
              <span className="token-pill">Stripe決済</span>
            </div>

            <div className="token-plan-grid">
              {PURCHASE_PLANS.map((plan) => {
                return (
                  <div key={plan.id} className="token-plan">
                    <div className="token-plan__tokens">
                      {plan.tickets}
                      <small> Gem</small>
                    </div>
                    <div className="token-plan__price-row">
                      <div className="token-plan__price">¥{plan.price.toLocaleString()}</div>
                    </div>
                    <button
                      type="button"
                      className="token-button token-button--buy"
                      onClick={() => handleCheckout(plan.id)}
                      disabled={!session || purchaseStatus === 'loading'}
                    >
                      {purchaseStatus === 'loading' ? '処理中...' : 'Gemを買う'}
                    </button>
                  </div>
                )
              })}
            </div>

            {purchaseMessage && (
              <p className={`token-inline-message ${purchaseStatus === 'error' ? 'token-inline-message--error' : ''}`}>
                {purchaseMessage}
              </p>
            )}
          </article>
        </section>
      </main>
    </div>
  )
}
