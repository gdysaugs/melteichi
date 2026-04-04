import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { Navigate, Route, Routes } from 'react-router-dom'
import { supabase } from './lib/supabaseClient'
import { Account } from './pages/Account'
import { Purchase } from './pages/Purchase'
import { Terms } from './pages/Terms'
import { Tokushoho } from './pages/Tokushoho'
import { Video } from './pages/Video'

function PurchaseRouteGate() {
  const [session, setSession] = useState<Session | null>(null)
  const [authReady, setAuthReady] = useState(!supabase)

  useEffect(() => {
    if (!supabase) {
      setAuthReady(true)
      return
    }

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session ?? null)
      setAuthReady(true)
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
      setAuthReady(true)
    })

    return () => subscription.unsubscribe()
  }, [])

  if (!authReady) return null
  if (!session) return <Navigate to='/' replace />
  return <Purchase />
}

export function App() {
  return (
    <Routes>
      <Route path='/' element={<Video />} />
      <Route path='/video' element={<Navigate to='/' replace />} />
      <Route path='/video-rapid' element={<Navigate to='/' replace />} />
      <Route path='/video-remix' element={<Navigate to='/' replace />} />
      <Route path='/fastmove' element={<Navigate to='/' replace />} />
      <Route path='/smoothmix' element={<Navigate to='/' replace />} />
      <Route path='/video-lora' element={<Navigate to='/' replace />} />
      <Route path='/t2v' element={<Navigate to='/' replace />} />
      <Route path='/tts' element={<Navigate to='/' replace />} />
      <Route path='/lipsync' element={<Navigate to='/' replace />} />
      <Route path='/voice' element={<Navigate to='/' replace />} />
      <Route path='/mmaudio' element={<Navigate to='/' replace />} />
      <Route path='/sfx' element={<Navigate to='/' replace />} />
      <Route path='/image' element={<Navigate to='/' replace />} />
      <Route path='/purchase' element={<PurchaseRouteGate />} />
      <Route path='/account' element={<Account />} />
      <Route path='/terms' element={<Terms />} />
      <Route path='/tokushoho' element={<Tokushoho />} />
      <Route path='*' element={<Navigate to='/' replace />} />
    </Routes>
  )
}
