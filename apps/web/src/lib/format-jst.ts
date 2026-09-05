// D1 の日時文字列を JST で表示するための共有ユーティリティ（Issue #58）。
//
// 同じ関数が 3 箇所にコピーされており、1 箇所直しても他が残る状態だったのでここに集約する。
// 出力書式は 2 種類ある（`MM/DD(曜) HH:mm` と `YYYY/MM/DD HH:mm`）。
// どちらも利用側の表示に組み込まれているため 1 本には統合しない。

const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土']

/** 解釈できない値のときに画面へ出す文字。'Invalid Date' を見せない。 */
const INVALID_LABEL = '—'

// 秒とその小数部は省略・付与どちらもあり得る。完全一致に絞ると桁がゆらいだ値が
// 無音で素通りし、「ローカル時刻として解釈」に戻ってしまうため緩めに受ける。
const TIME = String.raw`\d{2}:\d{2}(:\d{2})?(\.\d+)?`

/** SQLite の datetime('now') 形式。UTC・スペース区切り・オフセット表記なし。 */
const SQLITE_DATETIME = new RegExp(String.raw`^\d{4}-\d{2}-\d{2} ${TIME}$`)

/** strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours') 形式。JST・T 区切り・オフセット表記なし。 */
const ISO_WITHOUT_OFFSET = new RegExp(String.raw`^\d{4}-\d{2}-\d{2}T${TIME}$`)

/**
 * DB の日時文字列を、タイムゾーンが確定した ISO に正規化する。
 *
 * schema.sql には 2 系統の日時規約が混在している:
 *
 *   datetime('now')                            → UTC・スペース区切り
 *     events / event_bookings / message_templates / pool_accounts
 *   strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours') → JST・オフセット表記なし
 *     tags / conversion_points / operators / staff_members
 *
 * どちらも `new Date()` に渡すと**ローカル時刻**として解釈される。
 * 前者はそのせいで +9 時間の補正が打ち消され、UTC の数字がそのまま表示されていた
 * （参加者一覧の申込日時が 9 時間ずれていた実バグ）。
 * 後者は閲覧者のブラウザが JST のときだけ偶然正しく出る状態だった。
 *
 * ここでタイムゾーンを明示してから Date に渡すことで、どちらの保存形式でも、
 * どの環境から見ても同じ瞬間として扱えるようにする。
 */
export function normalizeDbDatetime(value: string): string {
  if (SQLITE_DATETIME.test(value)) return `${value.replace(' ', 'T')}Z`
  if (ISO_WITHOUT_OFFSET.test(value)) return `${value}+09:00`
  // Z 付き・オフセット付き、および想定外の値はそのまま返す（勝手に補正しない）
  return value
}

/** 正規化してから Date にする。解釈できなければ null。 */
function toDate(value: string): Date | null {
  if (!value) return null
  const d = new Date(normalizeDbDatetime(value))
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * JST の時計の針を取り出す。
 *
 * 絶対時刻に +9 時間してから UTC 系のゲッターで読むので、閲覧者のタイムゾーンに依存しない
 * （壊れていたのは入力の解釈だけで、この計算自体は元から正しかった）。
 */
function jstParts(d: Date) {
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000)
  return {
    yyyy: String(jst.getUTCFullYear()),
    mm: String(jst.getUTCMonth() + 1).padStart(2, '0'),
    dd: String(jst.getUTCDate()).padStart(2, '0'),
    hh: String(jst.getUTCHours()).padStart(2, '0'),
    min: String(jst.getUTCMinutes()).padStart(2, '0'),
    dow: WEEKDAYS_JA[jst.getUTCDay()],
  }
}

/** イベント系の表示。例: `09/01(火) 10:50` */
export function formatJST(value: string): string {
  const d = toDate(value)
  if (!d) return INVALID_LABEL
  const { mm, dd, hh, min, dow } = jstParts(d)
  return `${mm}/${dd}(${dow}) ${hh}:${min}`
}

/**
 * 予約系の表示。例: `2026/09/01 10:50`
 */
export function formatJSTWithYear(value: string): string {
  const d = toDate(value)
  if (!d) return INVALID_LABEL
  const { yyyy, mm, dd, hh, min } = jstParts(d)
  return `${yyyy}/${mm}/${dd} ${hh}:${min}`
}

/**
 * 時刻だけの表示（`10:50`）。
 *
 * `formatJSTWithYear(...).slice(11)` で切り出す運用をやめるために用意した。
 * 桁に依存すると、不正値のときに sentinel（`—`）が切り落とされて空文字になる。
 */
export function formatJSTTime(value: string): string {
  const d = toDate(value)
  if (!d) return INVALID_LABEL
  const { hh, min } = jstParts(d)
  return `${hh}:${min}`
}

/**
 * `<input type="datetime-local">` に入れる値（`2026-09-01T10:50`）を JST で作る。
 *
 * ローカルのゲッターで組み立てると、JST 以外から見たとき
 * 「一覧に出ている時刻」と「編集フォームの時刻」が食い違う。
 * 保存側の `jstDatetimeLocalToIso` と必ず対で使うこと（片方だけ直すと往復でズレる）。
 */
export function toJstDatetimeLocal(value: string): string {
  const d = toDate(value)
  if (!d) return ''
  const { yyyy, mm, dd, hh, min } = jstParts(d)
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`
}

/** `<input type="datetime-local">` の値を JST の壁時計として解釈し、ISO（UTC）に戻す。 */
export function jstDatetimeLocalToIso(value: string): string {
  if (!value) return ''
  const d = new Date(`${value}:00+09:00`)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
}
