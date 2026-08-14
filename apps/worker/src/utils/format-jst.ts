const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'] as const

/**
 * D1 に保存された ISO 8601 日時（UTC）を JST の「MM/DD(曜) HH:mm」に変換する。
 *
 * DB の値をそのまま人目に触れる場所へ出すと `2026-06-13T05:00:00.000Z` のように
 * 読めない文字列になるため、LINE 通知・メール本文では必ずこの関数を通す。
 * （`.claude/rules/api-coding.md` の「日時フォーマット」）
 */
export function formatJST(iso: string): string {
  const d = new Date(iso)
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000)
  const mm = String(jst.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(jst.getUTCDate()).padStart(2, '0')
  const hh = String(jst.getUTCHours()).padStart(2, '0')
  const min = String(jst.getUTCMinutes()).padStart(2, '0')
  const dow = WEEKDAYS_JA[jst.getUTCDay()]
  return `${mm}/${dd}(${dow}) ${hh}:${min}`
}
