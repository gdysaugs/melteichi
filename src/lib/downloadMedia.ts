type SaveGeneratedAssetOptions = {
  source: string
  filenamePrefix: string
  fallbackExtension: string
}

type PrepareGeneratedAssetOptions = {
  source: string
  fallbackExtension: string
}

export type PreparedGeneratedAsset = {
  url: string
  extension: string
  release: () => void
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

const dataUrlToBlob = (source: string) => {
  const commaIndex = source.indexOf(',')
  if (commaIndex < 0) throw new Error('invalid_data_url')

  const metadata = source.slice(5, commaIndex)
  const payload = source.slice(commaIndex + 1).replace(/\s+/g, '')
  const mimeType = metadata.split(';', 1)[0] || 'application/octet-stream'
  if (!metadata.toLowerCase().includes(';base64')) {
    return new Blob([decodeURIComponent(payload)], { type: mimeType })
  }

  const encodedChunkSize = 4 * 1024 * 1024
  const chunks: ArrayBuffer[] = []
  for (let offset = 0; offset < payload.length; offset += encodedChunkSize) {
    const binary = atob(payload.slice(offset, offset + encodedChunkSize))
    const buffer = new ArrayBuffer(binary.length)
    const bytes = new Uint8Array(buffer)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    chunks.push(buffer)
  }
  return new Blob(chunks, { type: mimeType })
}

const createPreparedBlob = (blob: Blob, source: string, fallbackExtension: string): PreparedGeneratedAsset => {
  const objectUrl = URL.createObjectURL(blob)
  const extension =
    getExtensionFromMime(blob.type) ?? getExtensionFromSource(source) ?? fallbackExtension.toLowerCase()
  let released = false
  return {
    url: objectUrl,
    extension,
    release: () => {
      if (released) return
      released = true
      URL.revokeObjectURL(objectUrl)
    },
  }
}

export const prepareGeneratedAsset = async ({
  source,
  fallbackExtension,
}: PrepareGeneratedAssetOptions): Promise<PreparedGeneratedAsset> => {
  if (source.startsWith('data:')) {
    return createPreparedBlob(dataUrlToBlob(source), source, fallbackExtension)
  }

  if (source.startsWith('blob:')) {
    return {
      url: source,
      extension: getExtensionFromSource(source) ?? fallbackExtension.toLowerCase(),
      release: () => undefined,
    }
  }

  try {
    const response = await fetch(source)
    if (!response.ok) throw new Error('fetch_failed')
    return createPreparedBlob(await response.blob(), source, fallbackExtension)
  } catch {
    return {
      url: source,
      extension: getExtensionFromSource(source) ?? fallbackExtension.toLowerCase(),
      release: () => undefined,
    }
  }
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

export const saveGeneratedAsset = ({ source, filenamePrefix, fallbackExtension }: SaveGeneratedAssetOptions) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const baseName = sanitizeFilenamePart(filenamePrefix) + '-' + timestamp
  const extension = getExtensionFromSource(source) ?? fallbackExtension.toLowerCase()
  triggerDownload(source, baseName + '.' + extension)
}
