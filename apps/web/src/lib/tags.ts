export const DEFAULT_TAG_COLOR = '#3B82F6'

export function validateTagName(name: string): string | null {
  if (!name || !name.trim()) {
    return 'タグ名を入力してください'
  }
  return null
}

export function getTagTextColor(backgroundColor: string): string {
  const hex = backgroundColor.replace('#', '')
  const r = parseInt(hex.substring(0, 2), 16)
  const g = parseInt(hex.substring(2, 4), 16)
  const b = parseInt(hex.substring(4, 6), 16)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance > 0.5 ? '#1f2937' : '#ffffff'
}
