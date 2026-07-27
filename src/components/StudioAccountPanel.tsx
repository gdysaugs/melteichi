import { Link } from 'react-router-dom'
import type { DailyBonusController } from '../hooks/useDailyBonus'

type TicketStatus = 'idle' | 'loading' | 'error'

type StudioAccountPanelProps = {
  email: string | null | undefined
  ticketCount: number | null
  ticketStatus: TicketStatus
  ticketMessage?: string
  dailyBonus: DailyBonusController
}

export function StudioAccountPanel({
  email,
  ticketCount,
  ticketStatus,
  ticketMessage = '',
  dailyBonus,
}: StudioAccountPanelProps) {
  return (
    <section className="studio-account-panel">
      <div className="studio-account-summary">
        <div className="studio-account-meta">
          <span className="studio-account-label">ログイン中</span>
          <strong className="studio-account-email">
            {email ?? 'Google Account'}
          </strong>
        </div>
        <div className="studio-account-meta studio-account-meta--gems">
          <span className="studio-account-label">保有Gem</span>
          <strong className="studio-account-gem">
            {ticketStatus === 'loading'
              ? '確認中...'
              : `${ticketCount ?? 0} Gem`}
          </strong>
        </div>
      </div>
      <div className="studio-account-actions">
        <div className="studio-account-action-stack">
          {!dailyBonus.canClaim &&
            dailyBonus.countdown &&
            !dailyBonus.isLoading &&
            !dailyBonus.isClaiming && (
              <span className="studio-account-caption">
                {`残り ${dailyBonus.countdown}`}
              </span>
            )}
          <button
            type="button"
            className={`studio-btn ${
              dailyBonus.canClaim
                ? 'studio-btn--primary'
                : 'studio-btn--ghost'
            }`}
            onClick={() => void dailyBonus.claim()}
            disabled={
              dailyBonus.isClaiming ||
              dailyBonus.isLoading ||
              !dailyBonus.canClaim
            }
          >
            {dailyBonus.buttonLabel}
          </button>
        </div>
        <Link className="studio-btn studio-btn--ghost" to="/purchase">
          Gem購入
        </Link>
      </div>
      {ticketStatus === 'error' && ticketMessage && (
        <p className="studio-inline-error">{ticketMessage}</p>
      )}
      {dailyBonus.statusMessage && (
        <p className="studio-status studio-status--account">
          {dailyBonus.statusMessage}
        </p>
      )}
    </section>
  )
}
