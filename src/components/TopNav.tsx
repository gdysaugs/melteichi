import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { NavLink } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'

export function TopNav() {
  const [session, setSession] = useState<Session | null>(null)
  const [isAuthReady, setIsAuthReady] = useState(!supabase)

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

  const isLoggedIn = Boolean(session)
  const homePath = '/'

  return (
    <header className={`top-nav${isAuthReady && !isLoggedIn ? ' top-nav--guest' : ''}`}>
      <div className='top-nav__brand'>
        <img className='top-nav__logo' src='/apple-touch-icon.png' alt='' aria-hidden='true' />
        <NavLink className='top-nav__title' to={homePath}>
          AkumaAI
        </NavLink>
      </div>
      <div className='top-nav__links'>
        <NavLink className={({ isActive }) => `top-nav__link${isActive ? ' is-active' : ''}`} to='/purchase'>
          ショップ
        </NavLink>
      </div>
    </header>
  )
}
