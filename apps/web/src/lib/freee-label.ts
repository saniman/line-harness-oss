// freee 接続を管理者に見せるときのラベル整形。
//
// ⚠️ この機能の防御は「管理者が目で見て自分の事業所か確認する」ことに全依存している。
// ところが事業所名は **第三者が freee 側で自由に決められる文字列** なので、
// そのまま confirm() に入れると細工できてしまう:
//
//   - 改行を大量に入れて、後続の警告文を画面外へ押し出す
//   - 「※この接続は正規のものです」等の偽の安心文を混ぜる
//   - 極端に長い名前でダイアログを埋める
//
// そこで制御文字を潰し、長さを切り、**必ず事業所ID（改ざんできない数値）を併記**する。

/** ダイアログに出す事業所名の最大長 */
const MAX_NAME_LENGTH = 40

/**
 * 制御文字かどうか。C0（改行・タブ含む）／ DEL ／ C1 ／ 行区切り文字を対象にする。
 *
 * 正規表現の文字クラスに直接書くとソースにリテラルの制御文字が入り、
 * 差分レビューで見えなくなる。コードポイントで判定する。
 */
function isControlChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0
  return (
    code < 0x20 ||             // C0（\n \t \r 等）
    code === 0x7f ||           // DEL
    (code >= 0x80 && code <= 0x9f) || // C1
    code === 0x2028 ||         // LINE SEPARATOR
    code === 0x2029            // PARAGRAPH SEPARATOR
  )
}

/**
 * 事業所名を1行に潰し、長さを切る。
 */
export function sanitizeCompanyName(name: string | null): string | null {
  if (name == null) return null

  let flattened = ''
  for (const ch of name) flattened += isControlChar(ch) ? ' ' : ch

  const collapsed = flattened.replace(/\s+/g, ' ').trim()
  if (!collapsed) return null

  return collapsed.length > MAX_NAME_LENGTH
    ? `${collapsed.slice(0, MAX_NAME_LENGTH)}…`
    : collapsed
}

/**
 * 確認ダイアログ用のラベル。
 * 事業所名は攻撃者が決められるので、**必ず事業所IDを併記**する。
 */
export function buildConnectionLabel(companyName: string | null, companyId: number): string {
  const safe = sanitizeCompanyName(companyName)
  return safe ? `${safe}（事業所ID: ${companyId}）` : `事業所ID: ${companyId}`
}
