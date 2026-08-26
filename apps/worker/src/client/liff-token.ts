// LIFF の ID トークンの有効期限判定と、期限切れからの復帰処理。
//
// 背景（#28）: `liff.getIDToken()` は **`liff.init()` 時に取得したトークン**を返し、
// ID トークンの有効期限は**発行から1時間**。ページを開いたまま放置すると、
// ボタンを押した時点では期限切れのトークンを送ることになり、サーバーに 401 で弾かれる。
//
// 復帰手段は環境で異なる（LINE 公式ドキュメントに基づく）:
//   - LINE アプリ内（LIFF ブラウザ）: `liff.login()` は**使えない**
//     （"You can't use liff.login() in a LIFF browser, as it is automatically executed
//       when liff.init() is executed."）→ **リロードして init を走らせ直す**のが唯一の手段
//   - 外部ブラウザ: `liff.logout()` → `liff.login()` の順で再ログインさせる
//     （`liff.login()` は**すでにログイン済みだと何もしない**。ID トークンだけが期限切れでも
//       SDK 側のログイン状態は残っているため、先に logout でセッションを捨てないと
//       「復帰を開始したつもりで実際は何も起きない」状態になる）
//
// pure function に切り出して liff-token.test.ts でカバーする。

/** 復帰を試みた回数を持つ sessionStorage のキー。リロードを跨いで残る必要がある。 */
export const RECOVERY_STORAGE_KEY = 'liff_session_recovery_count'

/** 自動復帰の上限。超えたら自動処理をやめてユーザーに案内する（リロード地獄の防止）。 */
const MAX_RECOVERY_ATTEMPTS = 1

/** 通信中に期限が切れるのを避けるための猶予。この秒数以内なら期限切れ扱いにする。 */
const EXPIRY_SKEW_MS = 60_000

type MinimalStorage = Pick<Storage, 'getItem' | 'setItem'>

/** ID トークン(JWT)の exp をミリ秒で返す。読めなければ null。 */
export function getIdTokenExpMs(idToken: string | null | undefined): number | null {
  if (!idToken) return null
  try {
    const parts = idToken.split('.')
    if (parts.length !== 3) return null
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    const payload = JSON.parse(atob(padded)) as { exp?: unknown }
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

/**
 * ID トークンが期限切れ（または期限間近）かを返す。
 *
 * トークンが無い・exp を読めない場合は **false**（＝サーバーの判断に委ねる）。
 * ここで true にすると、判定できないだけのケースまで復帰処理に流れてしまうため。
 */
export function isIdTokenExpired(
  idToken: string | null | undefined,
  nowMs: number,
  skewMs: number = EXPIRY_SKEW_MS,
): boolean {
  const expMs = getIdTokenExpMs(idToken)
  if (expMs === null) return false
  return expMs - skewMs <= nowMs
}

export interface LiffSessionDeps {
  /** liff.isInClient() の結果 */
  isInClient: boolean
  /** liff.logout()（外部ブラウザでのみ使う。すでに未ログインなら何もしなくてよい） */
  logout: () => void
  /** liff.login() */
  login: (opts: { redirectUri: string }) => void
  /** window.location.reload() */
  reload: () => void
  /** window.location.href */
  href: string
  /** sessionStorage（使えない環境では null） */
  storage: MinimalStorage | null
}

/**
 * 期限切れセッションからの復帰を試みる。
 *
 * @returns 復帰処理を開始したら true（呼び出し側はエラー文言を出さない）。
 *          false なら自動復帰できなかった＝呼び出し側でユーザーに案内する。
 */
export function recoverLiffSession(deps: LiffSessionDeps): boolean {
  const { isInClient, logout, login, reload, href, storage } = deps

  // 試行回数を数えられない環境では自動復帰しない。
  // リロードしても直らなかった場合に無限ループへ落ちるため。
  if (!storage) return false

  const attempts = Number(storage.getItem(RECOVERY_STORAGE_KEY) ?? '0') || 0
  if (attempts >= MAX_RECOVERY_ATTEMPTS) return false
  storage.setItem(RECOVERY_STORAGE_KEY, String(attempts + 1))

  if (isInClient) {
    // liff.init() を走らせ直して ID トークンを再発行させる
    reload()
  } else {
    // login() は「ログイン済み」だと何もしないため、先にセッションを捨てて認可フローを必ず開始させる
    logout()
    login({ redirectUri: href })
  }
  return true
}

/** API 呼び出しが成功した＝セッションは健全。次に期限切れになったとき再び復帰できるようにする。 */
export function markLiffSessionHealthy(storage: MinimalStorage | null): void {
  storage?.setItem(RECOVERY_STORAGE_KEY, '0')
}
