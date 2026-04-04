import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { isAuthConfigured, supabase } from '../lib/supabaseClient'
import { PURCHASE_PLANS } from '../lib/purchasePlans'
import { TopNav } from '../components/TopNav'
import './camera.css'
import './purchase.css'

const OAUTH_REDIRECT_URL =
  import.meta.env.VITE_SUPABASE_REDIRECT_URL ?? (typeof window !== 'undefined' ? window.location.origin : undefined)
const DAILY_BONUS_COOLDOWN_HOURS = 24
const DAILY_BONUS_AMOUNT = 3

const formatRemaining = (targetIso: string | null) => {
  if (!targetIso) return ''
  const target = new Date(targetIso).getTime()
  if (!Number.isFinite(target)) return ''
  const diff = target - Date.now()
  if (diff <= 0) return ''
  const hours = Math.floor(diff / 3_600_000)
  const minutes = Math.floor((diff % 3_600_000) / 60_000)
  return `${hours}時間${minutes.toString().padStart(2, '0')}分`
}

const normalizeErrorMessage = (value: unknown) => {
  if (!value) return 'デイリーボーナスに失敗しました。'
  if (typeof value === 'string') return value
  if (value instanceof Error && value.message) return value.message
  if (typeof value === 'object' && value) {
    const maybe = value as { error?: unknown; message?: unknown; detail?: unknown }
    const picked = maybe.error ?? maybe.message ?? maybe.detail
    if (typeof picked === 'string' && picked) return picked
  }
  return 'デイリーボーナスに失敗しました。'
}

export function Purchase() {
  const [session, setSession] = useState<Session | null>(null)
  const [authStatus, setAuthStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [authMessage, setAuthMessage] = useState('')
  const [ticketCount, setTicketCount] = useState<number | null>(null)
  const [ticketStatus, setTicketStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [ticketMessage, setTicketMessage] = useState('')
  const [purchaseStatus, setPurchaseStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [purchaseMessage, setPurchaseMessage] = useState('')
  const [dailyClaimStatus, setDailyClaimStatus] = useState<string | null>(null)
  const [dailyNextEligibleAt, setDailyNextEligibleAt] = useState<string | null>(null)
  const [dailyCanClaim, setDailyCanClaim] = useState(false)
  const [dailyCountdown, setDailyCountdown] = useState('')
  const [isLoadingDailyStatus, setIsLoadingDailyStatus] = useState(false)
  const [isClaimingDaily, setIsClaimingDaily] = useState(false)

  const accessToken = session?.access_token ?? ''
  const bestValuePlanId = useMemo(() => {
    if (!PURCHASE_PLANS.length) return null
    return [...PURCHASE_PLANS].sort((a, b) => a.price / a.tickets - b.price / b.tickets)[0]?.id ?? null
  }, [])

  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null))
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      setAuthStatus('idle')
      setAuthMessage('')
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
        setAuthStatus('error')
        setAuthMessage(error.message)
        return
      }
      const url = new URL(window.location.href)
      url.searchParams.delete('code')
      url.searchParams.delete('state')
      window.history.replaceState({}, document.title, url.toString())
    })
  }, [])

  const fetchTickets = useCallback(async (token: string) => {
    if (!token) return
    setTicketStatus('loading')
    setTicketMessage('')
    const res = await fetch('/api/tickets', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      setTicketStatus('error')
      setTicketMessage(data?.error || 'ポイント取得に失敗しました。')
      setTicketCount(null)
      return
    }
    setTicketStatus('idle')
    setTicketMessage('')
    setTicketCount(Number(data?.tickets ?? 0))
  }, [])

  useEffect(() => {
    if (!session || !accessToken) {
      setTicketCount(null)
      setTicketStatus('idle')
      setTicketMessage('')
      setDailyCanClaim(false)
      setDailyNextEligibleAt(null)
      setDailyCountdown('')
      return
    }
    void fetchTickets(accessToken)
  }, [accessToken, fetchTickets, session])

  const fetchDailyBonusStatus = useCallback(async (token: string) => {
    if (!token) return
    setIsLoadingDailyStatus(true)
    try {
      const res = await fetch('/api/daily-bonus', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setDailyCanClaim(false)
        setDailyNextEligibleAt(null)
        setDailyCountdown('')
        return
      }
      const canClaim = Boolean(data?.can_claim)
      const nextEligibleAt = data?.next_eligible_at ? String(data.next_eligible_at) : null
      setDailyCanClaim(canClaim)
      setDailyNextEligibleAt(nextEligibleAt)
      if (!canClaim && nextEligibleAt) {
        setDailyCountdown(formatRemaining(nextEligibleAt))
      } else {
        setDailyCountdown('')
      }
    } finally {
      setIsLoadingDailyStatus(false)
    }
  }, [])

  useEffect(() => {
    if (!session || !accessToken) return
    void fetchDailyBonusStatus(accessToken)
  }, [accessToken, fetchDailyBonusStatus, session])

  useEffect(() => {
    if (!dailyNextEligibleAt || dailyCanClaim) {
      setDailyCountdown('')
      return
    }
    let didRefresh = false
    const update = () => {
      const remain = formatRemaining(dailyNextEligibleAt)
      setDailyCountdown(remain)
      if (!remain && !didRefresh && accessToken) {
        didRefresh = true
        void fetchDailyBonusStatus(accessToken)
      }
    }
    update()
    const timer = window.setInterval(update, 15_000)
    return () => window.clearInterval(timer)
  }, [accessToken, dailyCanClaim, dailyNextEligibleAt, fetchDailyBonusStatus])

  const dailyBonusHint = isLoadingDailyStatus
    ? '次回まで確認中...'
    : dailyCanClaim
      ? '今すぐ受け取り可能'
      : dailyCountdown
        ? `次回まで ${dailyCountdown}`
        : '次回までまもなく'

  const handleGoogleSignIn = async () => {
    if (!supabase || !isAuthConfigured) {
      setAuthStatus('error')
      setAuthMessage('認証設定が未完了です。')
      return
    }
    setAuthStatus('loading')
    setAuthMessage('')
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: OAUTH_REDIRECT_URL, skipBrowserRedirect: true },
    })
    if (error) {
      setAuthStatus('error')
      setAuthMessage(error.message)
      return
    }
    if (data?.url) {
      window.location.assign(data.url)
      return
    }
    setAuthStatus('error')
    setAuthMessage('認証URLの取得に失敗しました。')
  }

  const handleSignOut = async () => {
    if (!supabase) return
    try {
      await supabase.auth.signOut({ scope: 'local' })
      window.location.assign('/')
    } catch (error) {
      setAuthStatus('error')
      setAuthMessage(error instanceof Error ? error.message : 'ログアウトに失敗しました。')
    }
  }

  const handleCheckout = async (priceId: string) => {
    if (!session || !accessToken) {
      setPurchaseStatus('error')
      setPurchaseMessage('購入するにはログインが必要です。')
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
      body: JSON.stringify({ price_id: priceId }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data?.url) {
      setPurchaseStatus('error')
      setPurchaseMessage(data?.error || '決済作成に失敗しました。')
      return
    }
    window.location.assign(data.url)
  }

  const handleClaimDaily = async () => {
    if (!accessToken || !session) {
      setDailyClaimStatus('ログインしてください。')
      return
    }
    if (isClaimingDaily) return
    setIsClaimingDaily(true)
    setDailyClaimStatus(null)
    try {
      const res = await fetch('/api/daily-bonus', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const message = normalizeErrorMessage(data?.error ?? data?.message ?? data?.detail)
        setDailyClaimStatus(message)
        window.alert(message)
        return
      }
      if (data?.granted) {
        setDailyClaimStatus('無料ポイントを付与しました。')
        void fetchTickets(accessToken)
        setDailyCanClaim(false)
        setDailyNextEligibleAt(data?.next_eligible_at ? String(data.next_eligible_at) : null)
      } else {
        const reason = data?.reason
        if (reason === 'cooldown' || reason === 'not_eligible_yet') {
          const remain = formatRemaining(data?.next_eligible_at ?? null)
          setDailyClaimStatus(remain ? `次の受け取りまで ${remain}` : 'まだ受け取れません。')
          setDailyCanClaim(false)
          setDailyNextEligibleAt(data?.next_eligible_at ? String(data.next_eligible_at) : null)
        } else {
          setDailyClaimStatus('まだ受け取れません。')
        }
      }
    } catch (error) {
      const message = normalizeErrorMessage(error)
      setDailyClaimStatus(message)
      window.alert(message)
    } finally {
      setIsClaimingDaily(false)
      void fetchDailyBonusStatus(accessToken)
    }
  }

  return (
    <div className="camera-app purchase-app purchase-page">
      <TopNav />
      <main className="token-lab">
        <section className="token-layout">
          <article className="token-card token-card--account">
            <div className="token-card__head">
              <div>
                <p className="token-card__kicker">LOGIN</p>
                <h2>ログイン / ボーナス</h2>
              </div>
              {session ? (
                <span className="token-pill token-pill--online">接続済み</span>
              ) : (
                <span className="token-pill">未接続</span>
              )}
            </div>

            {session ? (
              <div className="token-auth-row">
                <p className="token-auth-lead">このまま購入できます。</p>
              </div>
            ) : (
              <div className="token-auth-row">
                <p className="token-auth-lead">購入するにはログインしてください。</p>
                <button
                  type="button"
                  className="token-button token-button--primary"
                  onClick={handleGoogleSignIn}
                  disabled={authStatus === 'loading'}
                >
                  {authStatus === 'loading' ? '接続中...' : 'Googleでログイン'}
                </button>
              </div>
            )}

            {authMessage && <p className="token-inline-message token-inline-message--error">{authMessage}</p>}

            {session && (
              <div className="token-bonus-card">
                <div className="token-bonus-card__head">
                  <div>
                    <p className="token-card__kicker">DAILY</p>
                    <h3>{`毎日${DAILY_BONUS_AMOUNT}ポイント配布`}</h3>
                  </div>
                  <span className={`token-bonus-state ${dailyCanClaim ? 'is-ready' : ''}`}>{dailyBonusHint}</span>
                </div>
                <div className="token-bonus-card__actions">
                  <button
                    type="button"
                    className="token-button token-button--primary"
                    onClick={handleClaimDaily}
                    disabled={isClaimingDaily || isLoadingDailyStatus || !dailyCanClaim}
                  >
                    {isClaimingDaily ? '処理中...' : isLoadingDailyStatus ? '確認中...' : dailyCanClaim ? '受け取る' : '待機中'}
                  </button>
                  {dailyClaimStatus && <span className="token-bonus-result">{dailyClaimStatus}</span>}
                </div>
              </div>
            )}
          </article>

          <article className="token-card token-card--store">
            <div className="token-card__head">
              <div>
                <p className="token-card__kicker">SHOP</p>
                <h2>ポイント購入</h2>
              </div>
              <span className="token-pill">カード決済</span>
            </div>
            <div className="token-plan-grid">
              {PURCHASE_PLANS.map((plan) => {
                const unitPrice = plan.price / plan.tickets
                const unitPriceDisplay = unitPrice.toLocaleString('ja-JP', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })
                const isBestValue = plan.id === bestValuePlanId
                return (
                  <div key={plan.id} className={`token-plan ${isBestValue ? 'is-featured' : ''}`}>
                    <div className="token-plan__top">
                      <div className="token-plan__name">{plan.label}</div>
                      {isBestValue && <span className="token-plan__badge">おすすめ</span>}
                    </div>
                    <div className="token-plan__tokens">
                      {plan.tickets}
                      <small> pt</small>
                    </div>
                    <div className="token-plan__price-row">
                      <div className="token-plan__price">¥{plan.price.toLocaleString()}</div>
                      <div className="token-plan__unit">{`1ptあたり約 ¥${unitPriceDisplay}`}</div>
                    </div>
                    <button
                      type="button"
                      className="token-button token-button--buy"
                      onClick={() => handleCheckout(plan.priceId)}
                      disabled={!session || purchaseStatus === 'loading'}
                    >
                      {purchaseStatus === 'loading' ? '処理中...' : '補充する'}
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

        <section className="token-account-bottom" aria-label="アカウント情報">
          <div className="token-account-bottom__line">
            <span>アカウント</span>
            <strong>{session?.user?.email ?? '未ログイン'}</strong>
          </div>
          <div className="token-account-bottom__line">
            <span>保有ポイント</span>
            <strong>{session ? (ticketStatus === 'loading' ? '確認中...' : `${ticketCount ?? 0}pt`) : '--'}</strong>
          </div>
          {session && ticketStatus === 'error' && ticketMessage && (
            <p className="token-inline-message token-inline-message--error token-account-bottom__error">{ticketMessage}</p>
          )}
          {session && (
            <button type="button" className="token-button token-button--ghost token-account-bottom__logout" onClick={handleSignOut}>
              ログアウト
            </button>
          )}
        </section>
      </main>
    </div>
  )
}
