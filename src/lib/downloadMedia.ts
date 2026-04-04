type SaveGeneratedAssetOptions = {
  source: string
  filenamePrefix: string
  fallbackExtension: string
}

const MIME_EXTENSION_MAP: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
}

const sanitizeFilenamePart = (value: string) => {
  const cleaned = value.trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  return cleaned || 'asset'
}

const getExtensionFromMime = (mimeType: string) => {
  const normalized = mimeType.trim().toLowerCase()
  return MIME_EXTENSION_MAP[normalized] ?? null
}

const getExtensionFromSource = (source: string) => {
  const dataUrlMatch = source.match(/^data:([^;,]+)[;,]/i)
  if (dataUrlMatch) {
    return getExtensionFromMime(dataUrlMatch[1]) ?? null
  }

  try {
    const url = new URL(source)
    const pathname = url.pathname.toLowerCase()
    const ext = pathname.split('.').pop()
    if (ext && ext.length <= 5) return ext
  } catch {
    const cleaned = source.split('#')[0].split('?')[0].toLowerCase()
    const ext = cleaned.split('.').pop()
    if (ext && ext.length <= 5) return ext
  }

  return null
}

const triggerDownload = (href: string, filename: string) => {
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = filename
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

export const saveGeneratedAsset = async ({ source, filenamePrefix, fallbackExtension }: SaveGeneratedAssetOptions) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const baseName = sanitizeFilenamePart(filenamePrefix) + '-' + timestamp

  try {
    const response = await fetch(source)
    if (!response.ok) throw new Error('fetch_failed')
    const blob = await response.blob()
    const extension =
      getExtensionFromMime(blob.type) ?? getExtensionFromSource(source) ?? fallbackExtension.toLowerCase()
    const objectUrl = URL.createObjectURL(blob)
    triggerDownload(objectUrl, baseName + '.' + extension)
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1500)
    return
  } catch {
    const extension = getExtensionFromSource(source) ?? fallbackExtension.toLowerCase()
    triggerDownload(source, baseName + '.' + extension)
  }
}
