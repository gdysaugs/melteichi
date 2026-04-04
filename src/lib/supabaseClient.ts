import { createClient } from '@supabase/supabase-js'

function normalizeEnvString(v: string | undefined): string {
  // Guard against accidentally quoted/whitespace-padded values in build vars.
  return (v ?? '').trim().replace(/^"(.*)"$/, '$1')
}

function normalizeSupabaseUrl(v: string | undefined): string {
  const s = normalizeEnvString(v)
  if (!s) return ''

  try {
    const u = new URL(s)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return ''
    // Supabase client expects a base URL, not an arbitrary path.
    return u.origin
  } catch {
    return ''
  }
}

function extractRefFromSupabaseUrl(url: string): string {
  if (!url) return ''
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (!host.endsWith('.supabase.co')) return ''
    return host.split('.')[0] || ''
  } catch {
    return ''
  }
}

function decodeBase64Url(input: string): string {
  if (!input) return ''
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  try {
    return atob(padded)
  } catch {
    return ''
  }
}

function extractRefFromAnonKey(anonKey: string): string {
  if (!anonKey) return ''
  const parts = anonKey.split('.')
  if (parts.length < 2) return ''
  const payloadJson = decodeBase64Url(parts[1])
  if (!payloadJson) return ''
  try {
    const payload = JSON.parse(payloadJson) as { ref?: unknown }
    return typeof payload.ref === 'string' ? payload.ref : ''
  } catch {
    return ''
  }
}

const supabaseUrl = normalizeSupabaseUrl(import.meta.env.VITE_SUPABASE_URL)
const supabaseAnonKey = normalizeEnvString(import.meta.env.VITE_SUPABASE_ANON_KEY)

const refFromUrl = extractRefFromSupabaseUrl(supabaseUrl)
const refFromAnonKey = extractRefFromAnonKey(supabaseAnonKey)
const isRefMismatch = Boolean(refFromUrl && refFromAnonKey && refFromUrl !== refFromAnonKey)

export const authConfigError = !supabaseUrl || !supabaseAnonKey
  ? 'VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY is not configured.'
  : isRefMismatch
    ? 'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY belong to different Supabase projects.'
    : null

if (authConfigError && typeof console !== 'undefined') {
  console.error(`[supabase] ${authConfigError}`)
}

export const isAuthConfigured = authConfigError === null
export const supabase = isAuthConfigured ? createClient(supabaseUrl, supabaseAnonKey) : null
