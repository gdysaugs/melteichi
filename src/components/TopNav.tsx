import { useEffect, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { NavLink } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'

export function TopNav() {
  const [session, setSession] = useState<Session | null>(null)
  const [isAuthReady, setIsAuthReady] = useState(!supabase)
  const [isAccountOpen, setIsAccountOpen] = useState(false)
  const accountMenuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!supabase) {
      setIsAuthReady(true)
      return
    }

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null)
      setIsAuthReady(true)
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      setIsAuthReady(true)
    })

    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!supabase || typeof window === 'undefined') return

    const rawHash = window.location.hash
    if (!rawHash || !rawHash.includes('access_token=')) return

    const hashParams = new URLSearchParams(rawHash.startsWith('#') ? rawHash.slice(1) : rawHash)
    const accessToken = hashParams.get('access_token')
    const refreshToken = hashParams.get('refresh_token')
    if (!accessToken || !refreshToken) return

    let isCancelled = false
    void supabase.auth
      .setSession({ access_token: accessToken, refresh_token: refreshToken })
      .then(({ error }) => {
        if (error || isCancelled) return
        const url = new URL(window.location.href)
        url.hash = ''
        window.history.replaceState({}, document.title, url.toString())
      })
      .catch(() => {
        // no-op: onAuthStateChange/getSession already handles auth status display.
      })

    return () => {
      isCancelled = true
    }
  }, [])

  useEffect(() => {
    if (!isAccountOpen) return

    const handlePointerDown = (event: MouseEvent) => {
      if (!accountMenuRef.current?.contains(event.target as Node)) {
        setIsAccountOpen(false)
      }
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsAccountOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [isAccountOpen])

  const isLoggedIn = Boolean(session)
  const homePath = '/'
  const userEmail = session?.user?.email ?? ''

  const handleSignOut = async () => {
    if (!supabase) return
    setIsAccountOpen(false)
    await supabase.auth.signOut({ scope: 'local' }).catch(() => null)
    if (typeof window !== 'undefined') {
      window.location.assign('/')
    }
  }

  return (
    <header className={`top-nav${isAuthReady && !isLoggedIn ? ' top-nav--guest' : ''}`}>
      <div className='top-nav__brand'>
        <NavLink className='top-nav__title' to={homePath}>
          MeltAI-H
        </NavLink>
      </div>
      {isAuthReady && isLoggedIn ? (
        <div className='top-nav__account' ref={accountMenuRef}>
          <button
            type='button'
            className={`top-nav__account-button${isAccountOpen ? ' is-open' : ''}`}
            onClick={() => setIsAccountOpen((current) => !current)}
            aria-expanded={isAccountOpen}
            aria-haspopup='menu'
          >
            Account
          </button>
          {isAccountOpen ? (
            <div className='top-nav__account-menu' role='menu'>
              {userEmail ? <p className='top-nav__account-email'>{userEmail}</p> : null}
              <NavLink className='top-nav__account-link' to='/purchase' onClick={() => setIsAccountOpen(false)}>
                Purchase
              </NavLink>
              <button type='button' className='top-nav__account-logout' onClick={handleSignOut}>
                Logout
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </header>
  )
}
