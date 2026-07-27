import { useCallback, useEffect, useState } from 'react'

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

const formatRemainingSeconds = (value: unknown) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return ''
  const seconds = Math.max(0, Math.floor(parsed))
  if (seconds <= 0) return ''
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  return `${hours}時間${minutes.toString().padStart(2, '0')}分`
}

const isDailyClaimAvailable = (
  canClaim: boolean,
  targetIso: string | null,
  remainingSeconds?: unknown,
) => {
  if (canClaim) return true
  if (remainingSeconds !== null && remainingSeconds !== undefined) {
    const parsed = Number(remainingSeconds)
    if (Number.isFinite(parsed) && parsed <= 0) return true
  }
  if (!targetIso) return false
  const target = new Date(targetIso).getTime()
  return Number.isFinite(target) && target <= Date.now()
}

const normalizeDailyBonusError = (value: unknown) => {
  if (!value) return 'ボーナスの受け取りに失敗しました。'
  if (value instanceof Error && value.message) return value.message
  if (typeof value === 'object') {
    const candidate = value as { error?: unknown; message?: unknown; detail?: unknown }
    const picked = candidate.error ?? candidate.message ?? candidate.detail
    if (typeof picked === 'string' && picked.trim()) return picked
  }
  const message = String(value).trim()
  return message || 'ボーナスの受け取りに失敗しました。'
}

type UseDailyBonusOptions = {
  accessToken: string
  isAuthenticated: boolean
  refreshGemBalance: (token: string) => Promise<unknown> | unknown
}

export type DailyBonusController = {
  canClaim: boolean
  countdown: string
  isLoading: boolean
  isClaiming: boolean
  buttonLabel: string
  statusMessage: string | null
  claim: () => Promise<void>
}

export const useDailyBonus = ({
  accessToken,
  isAuthenticated,
  refreshGemBalance,
}: UseDailyBonusOptions): DailyBonusController => {
  const [claimStatus, setClaimStatus] = useState<string | null>(null)
  const [nextEligibleAt, setNextEligibleAt] = useState<string | null>(null)
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null)
  const [canClaim, setCanClaim] = useState(false)
  const [countdown, setCountdown] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isClaiming, setIsClaiming] = useState(false)

  const effectiveCanClaim = isDailyClaimAvailable(
    canClaim,
    nextEligibleAt,
    remainingSeconds,
  )
  const buttonLabel = isClaiming
    ? '受取中...'
    : isLoading
      ? '確認中...'
      : effectiveCanClaim
        ? 'デイリーを受け取る'
        : 'ボーナス待機中'

  const fetchStatus = useCallback(async (token: string) => {
    if (!token) return
    setIsLoading(true)
    try {
      const response = await fetch('/api/daily-bonus', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        setCanClaim(false)
        setNextEligibleAt(null)
        setRemainingSeconds(null)
        setCountdown('')
        return
      }

      const nextAt = data?.next_eligible_at
        ? String(data.next_eligible_at)
        : null
      const remainingValue = Number(data?.remaining_seconds)
      const remaining = Number.isFinite(remainingValue)
        ? Math.max(0, Math.floor(remainingValue))
        : null
      const available = isDailyClaimAvailable(
        Boolean(data?.can_claim),
        nextAt,
        remaining,
      )

      setCanClaim(available)
      setNextEligibleAt(nextAt)
      setRemainingSeconds(remaining)
      if (!available && nextAt) {
        setCountdown(
          formatRemainingSeconds(remaining) || formatRemaining(nextAt),
        )
      } else {
        setCountdown('')
      }
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!isAuthenticated || !accessToken) {
      setCanClaim(false)
      setNextEligibleAt(null)
      setRemainingSeconds(null)
      setCountdown('')
      setClaimStatus(null)
      return
    }
    void fetchStatus(accessToken)
  }, [accessToken, fetchStatus, isAuthenticated])

  useEffect(() => {
    if (!isAuthenticated || !accessToken) return
    const timer = window.setInterval(() => {
      void fetchStatus(accessToken)
    }, 60_000)
    return () => window.clearInterval(timer)
  }, [accessToken, fetchStatus, isAuthenticated])

  useEffect(() => {
    if (!nextEligibleAt || canClaim) {
      setCountdown('')
      return
    }

    let didRefresh = false
    const update = () => {
      const remaining = formatRemaining(nextEligibleAt)
      setCountdown(remaining)
      if (!remaining && !didRefresh && accessToken) {
        didRefresh = true
        setCanClaim(true)
        void fetchStatus(accessToken)
      }
    }

    update()
    const timer = window.setInterval(update, 15_000)
    return () => window.clearInterval(timer)
  }, [accessToken, canClaim, fetchStatus, nextEligibleAt])

  useEffect(() => {
    if (!isAuthenticated || !accessToken) return

    const refreshIfVisible = () => {
      if (document.visibilityState === 'visible') {
        void fetchStatus(accessToken)
      }
    }

    window.addEventListener('focus', refreshIfVisible)
    document.addEventListener('visibilitychange', refreshIfVisible)
    return () => {
      window.removeEventListener('focus', refreshIfVisible)
      document.removeEventListener('visibilitychange', refreshIfVisible)
    }
  }, [accessToken, fetchStatus, isAuthenticated])

  const claim = useCallback(async () => {
    if (!accessToken || !isAuthenticated) {
      setClaimStatus('ログインしてください。')
      return
    }
    if (isClaiming) return

    setIsClaiming(true)
    setClaimStatus(null)
    try {
      const response = await fetch('/api/daily-bonus', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        setClaimStatus(
          normalizeDailyBonusError(
            data?.error ?? data?.message ?? data?.detail,
          ),
        )
        return
      }

      const nextAt = data?.next_eligible_at
        ? String(data.next_eligible_at)
        : null
      const remainingValue = Number(data?.remaining_seconds)
      const remaining = Number.isFinite(remainingValue)
        ? Math.max(0, Math.floor(remainingValue))
        : null

      setCanClaim(false)
      setNextEligibleAt(nextAt)
      setRemainingSeconds(remaining)

      if (data?.granted) {
        setClaimStatus(`無料${DAILY_BONUS_AMOUNT} Gemを付与しました。`)
        void Promise.resolve(refreshGemBalance(accessToken)).catch(() => undefined)
      } else {
        const remainingText =
          formatRemainingSeconds(remaining) || formatRemaining(nextAt)
        setClaimStatus(
          remainingText
            ? `次の受け取りまで ${remainingText}`
            : 'まだ受け取れません。',
        )
      }
    } catch (error) {
      setClaimStatus(normalizeDailyBonusError(error))
    } finally {
      setIsClaiming(false)
      void fetchStatus(accessToken)
    }
  }, [
    accessToken,
    fetchStatus,
    isAuthenticated,
    isClaiming,
    refreshGemBalance,
  ])

  return {
    canClaim: effectiveCanClaim,
    countdown,
    isLoading,
    isClaiming,
    buttonLabel,
    statusMessage: claimStatus,
    claim,
  }
}
