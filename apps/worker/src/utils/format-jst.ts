const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'] as const

/** 解釈できない値のときに出す文字。'Invalid Date' を人目に触れさせない。 */
const INVALID_LABEL = '—'

/** SQLite の datetime('now') 形式。UTC・スペース区切り・オフセット表記なし。 */
const SQLITE_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

/** strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') 形式。JST・T 区切り・オフセット表記なし。 */
const ISO_WITHOUT_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/

/**
 * DB の日時文字列を、タイムゾーンが確定した ISO に正規化する。
 *
 * schema.sql には 2 系統の日時規約が混在しており、どちらも素の `new Date()` では
 * **ローカル時刻**として解釈されてしまう（Issue #58）。
 *
 *   datetime('now')                                 → UTC・スペース区切り
 *   strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')  → JST・オフセット表記なし
 *
 * 前者は +9 時間の補正が打ち消されて UTC の数字がそのまま出る。
 * 後者は実行環境が JST のときだけ偶然正しく出る（CI は UTC なので合わない）。
 * ここでタイムゾーンを明示してから Date に渡す。
 *
 * apps/web 側にも同じ実装がある（`apps/web/src/lib/format-jst.ts`）。
 * worker と web はビルドが別なので共有せず、同じ仕様のテストを両方に置いている。
 */
function normalizeDbDatetime(value: string): string {
  if (SQLITE_DATETIME.test(value)) return `${value.replace(' ', 'T')}Z`
  if (ISO_WITHOUT_OFFSET.test(value)) return `${value}+09:00`
  return value
}

/**
 * D1 に保存された ISO 8601 日時（UTC）を JST の「MM/DD(曜) HH:mm」に変換する。
 *
 * DB の値をそのまま人目に触れる場所へ出すと `2026-06-13T05:00:00.000Z` のように
 * 読めない文字列になるため、LINE 通知・メール本文では必ずこの関数を通す。
 * （`.claude/rules/api-coding.md` の「日時フォーマット」）
 */
export function formatJST(iso: string): string {
  if (!iso) return INVALID_LABEL
  const d = new Date(normalizeDbDatetime(iso))
  if (Number.isNaN(d.getTime())) return INVALID_LABEL
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000)
  const mm = String(jst.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(jst.getUTCDate()).padStart(2, '0')
  const hh = String(jst.getUTCHours()).padStart(2, '0')
  const min = String(jst.getUTCMinutes()).padStart(2, '0')
  const dow = WEEKDAYS_JA[jst.getUTCDay()]
  return `${mm}/${dd}(${dow}) ${hh}:${min}`
}
