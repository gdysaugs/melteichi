import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { Navigate, Route, Routes, useSearchParams } from 'react-router-dom'
import { supabase } from './lib/supabaseClient'
import { Account } from './pages/Account'
import { Home } from './pages/Home'
import { Purchase } from './pages/Purchase'
import { Terms } from './pages/Terms'
import { Tokushoho } from './pages/Tokushoho'
import { Video } from './pages/Video'
import { FluxTurboTest } from './pages/FluxTurboTest'
import { AudioI2V } from './pages/AudioI2V'
import { MsrReferenceTest } from './pages/MsrReferenceTest'

function HomeRouteGate() {
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
  if (!session) return <Home />
  return <Video />
}

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

function VideoRouteGate() {
  const [session, setSession] = useState<Session | null>(null)
  const [searchParams] = useSearchParams()
  const requestedEngine = searchParams.get('engine')?.toLowerCase()
  const activeEngine = requestedEngine === 'b' || requestedEngine === 'c' ? requestedEngine : 'a'
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
  if (activeEngine === 'b') return <AudioI2V />
  if (activeEngine === 'c') return <MsrReferenceTest />
  return <Video />
}


export function App() {
  return (
    <Routes>
      <Route path='/' element={<HomeRouteGate />} />
      <Route path='/video' element={<VideoRouteGate />} />
      <Route path='/video-rapid' element={<Navigate to='/video' replace />} />
      <Route path='/video-remix' element={<Navigate to='/video' replace />} />
      <Route path='/fastmove' element={<Navigate to='/video' replace />} />
      <Route path='/smoothmix' element={<Navigate to='/video' replace />} />
      <Route path='/video-lora' element={<Navigate to='/video' replace />} />
      <Route path='/t2v' element={<Navigate to='/video' replace />} />
      <Route path='/tts' element={<Navigate to='/' replace />} />
      <Route path='/lipsync' element={<Navigate to='/' replace />} />
      <Route path='/voice' element={<Navigate to='/' replace />} />
      <Route path='/mmaudio' element={<Navigate to='/' replace />} />
      <Route path='/sfx' element={<Navigate to='/video' replace />} />
      <Route path='/image' element={<Navigate to='/video' replace />} />
      <Route path='/i2i' element={<FluxTurboTest />} />
      <Route path='/__msr-test' element={<Navigate to='/video?engine=c' replace />} />
      <Route path='/flux-turbo-test' element={<Navigate to='/i2i' replace />} />
      <Route path='/purchase' element={<PurchaseRouteGate />} />
      <Route path='/account' element={<Account />} />
      <Route path='/terms' element={<Terms />} />
      <Route path='/tokushoho' element={<Tokushoho />} />
      <Route path='*' element={<Navigate to='/' replace />} />
    </Routes>
  )
}
