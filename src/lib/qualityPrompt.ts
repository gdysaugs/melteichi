const QUALITY_TAGS = [
  'masterpiece',
  'best quality',
  'ultra detailed',
  'highly detailed',
  'sharp focus',
]

export const buildPromptWithQualityTags = (prompt: string, enabled: boolean) => {
  const base = prompt.trim()
  if (!enabled) return base

  const lowered = base.toLowerCase()
  const missingTags = QUALITY_TAGS.filter((tag) => !lowered.includes(tag.toLowerCase()))
  if (!missingTags.length) return base

  const prefix = missingTags.join(', ')
  return base ? `${prefix}, ${base}` : prefix
}
