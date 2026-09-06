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

// ─── LIFF の外で開かれたときの復帰（#84） ─────────────────────
//
// 背景: Pages のエンドポイント URL（`https://line-harness-liff-35k.pages.dev/?page=event`）を
// LINE のトーク等から直接開くと、LINE は **LIFF ではなくアプリ内ブラウザ**で表示する。
// このとき `liff.init()` は通り `liff.login()` も成功するが、LIFF としての起動コンテキストが
// 無いため `liff.getIDToken()` が null になり、申込フローが行き止まりになる。
//
// さらに、そこで出していた文言が「LINE アプリ内で再度開いてください」だった。
// **ユーザーはすでに LINE の中にいる**ので、何をすればいいのか分からない案内になっていた。

/** LIFF へ開き直そうとしたことを覚えるキー。リダイレクトを跨いで残る必要がある。 */
export const REOPEN_STORAGE_KEY = 'liff_reopen_attempted'

/**
 * 無事に ID トークンを取れた＝開き直しは解決済み。次に詰まったとき再び救済できるようにする。
 *
 * これが無いと、一度フラグを立てたあとはそのセッション中ずっと自動復帰が効かず、
 * 2回目以降は手動のボタン画面までしか戻れない。
 */
export function markLiffReopenResolved(storage: MinimalStorage | null): void {
  storage?.setItem(REOPEN_STORAGE_KEY, '0')
}

/**
 * LIFF ID の形（多層防御の一枚目）。
 *
 * ⚠️ **これは「安全な文字だけか」の確認であって、信頼の判断ではない。**
 *    `liffId` は `?liffId=` から読むのでユーザーが自由に入れられる。
 *    「自動で飛ばしてよい ID か」は `shouldReopenInLiff` の `liffIdIsTrusted` で決める。
 *
 * ⚠️ 桁数を固定しない。`\d{10}-[0-9a-zA-Z]{8}` のように実物へ寄せて書くと、
 *    LINE がチャネルIDの桁数を変えた瞬間に**正当な ID を弾いて機能が黙って無効化**される。
 *    ここで防ぎたいのは `/` `:` `?` `#` などでパスから抜け出されることだけ。
 */
const LIFF_ID_PATTERN = /^[0-9]+-[0-9a-zA-Z]+$/

/**
 * LIFF として開き直すための URL を組み立てる。
 *
 * @param search `window.location.search`（`?page=event` 等）。どの画面を見ていたかを失わないよう引き継ぐ
 * @returns 組み立てられなければ null（LIFF ID の形が違う・空）
 */
export function buildLiffUrl(liffId: string, search: string): string | null {
  if (!LIFF_ID_PATTERN.test(liffId)) return null
  const qs = search.startsWith('?') ? search.slice(1) : search
  return `https://liff.line.me/${liffId}${qs ? `?${qs}` : ''}`
}

export interface ReopenDeps {
  /** liff.isInClient() の結果 */
  isInClient: boolean
  /** sessionStorage（使えない環境では null） */
  storage: MinimalStorage | null
  /**
   * LIFF ID がビルド時の値（＝こちらが決めた値）から来ているか。
   *
   * ⚠️ `?liffId=` 由来のときは **false**。ユーザーが自由に入れられるので、
   *    攻撃者の LIFF ID を入れた URL を送られると、正規のドメインから
   *    攻撃者の LIFF へ自動遷移させられる（形の検証だけでは防げない）。
   */
  liffIdIsTrusted: boolean
}

/**
 * ID トークンが取れなかったとき、LIFF として開き直すべきかを返す。
 *
 * ⚠️ **一度きり**。開き直しても取れなかった場合に再度飛ばすと、
 *    リダイレクトの無限ループになる（行き止まりより悪い）。
 * ⚠️ 期限切れ復帰（`RECOVERY_STORAGE_KEY`）とは**別のキー**で数える。
 *    共有すると片方のリセットがもう片方の防御を消してしまう。
 *
 * @returns true なら呼び出し側が LIFF URL へ遷移する
 */
export function shouldReopenInLiff({ isInClient, storage, liffIdIsTrusted }: ReopenDeps): boolean {
  // すでに LIFF の中。同じ場所へ送り直しても何も変わらない
  if (isInClient) return false
  // 信頼できない宛先へは自動で飛ばさない。
  // ⚠️ フラグを消費する**前**に返す。消費すると、あとで正しい経路で開いたときに
  //    自動復帰できなくなる
  if (!liffIdIsTrusted) return false
  // 回数を数えられない＝ループを止められない。行き止まりのほうがまだマシ
  if (!storage) return false
  if (storage.getItem(REOPEN_STORAGE_KEY) === '1') return false
  storage.setItem(REOPEN_STORAGE_KEY, '1')
  return true
}

/**
 * ID トークンを取れなかったときの案内文。
 *
 * ⚠️ 「LINE アプリ内で再度開いてください」は**使わない**。
 *    この文言が出る人はすでに LINE の中にいるので、実行できる操作を指していない。
 *    その場で本当にできることだけを書く。
 */
export interface AuthErrorContext {
  isInClient: boolean
  /** ［LINE で開き直す］ボタンを実際に出せるか */
  canReopen: boolean
}

/**
 * ID トークンを取れなかったときの案内文。
 *
 * ⚠️ 「LINE アプリ内で再度開いてください」は**使わない**。
 *    この文言が出る人はすでに LINE の中にいるので、実行できる操作を指していない。
 *
 * ⚠️ **ボタンの有無と同じ条件で決める。** 「下のボタンから」と書いたのに
 *    ボタンが描画されないと、存在しないものを押せと言うことになる
 *    ——まさにこの修正が無くそうとしている失敗そのもの。
 */
export function buildAuthErrorMessage({ isInClient, canReopen }: AuthErrorContext): string {
  // LIFF ブラウザでは liff.login() が使えないため、開き直す以外に手が無い
  if (isInClient) {
    return 'LINE の認証情報を取得できませんでした。お手数ですが、この画面を閉じて、もう一度開いてください。'
  }
  if (canReopen) {
    return 'この画面では LINE の情報を取得できませんでした。下のボタンから開き直すと申し込めます。'
  }
  // 送り先を作れない（LIFF ID が無い・形が違う）。押せるものが無いので、
  // その人が実際にできる操作だけを書く
  return 'この画面では LINE の情報を取得できませんでした。お手数ですが、LINE のトーク画面から、もう一度リンクを開いてください。'
}

/**
 * クエリパラメータを、`liff.state` に畳まれている場合も含めて読む（#85 レビュー④）。
 *
 * `https://liff.line.me/<id>?page=order&table=xxx` を開くと、LINE はエンドポイントへ
 * **クエリを `liff.state` に畳んで**渡すことがある（`?liff.state=%3Fpage%3Dorder...`）。
 * `getPage()` だけがこれを展開していたため、`table` / `id` / `payment` を
 * `location.search` から直接読んでいる箇所は**値を取り落としていた**
 * （例: 卓上QRから入ったのに「テーブル情報が見つかりません」）。
 *
 * ⚠️ 生のクエリを優先する。両方にあるなら、いま開いている URL のほうが新しい。
 */
export function readLiffParam(search: string, name: string): string | null {
  const params = new URLSearchParams(search)
  const direct = params.get(name)
  if (direct !== null) return direct

  const liffState = params.get('liff.state')
  if (!liffState) return null
  try {
    const stateStr = liffState.startsWith('?') ? liffState.slice(1) : liffState
    return new URLSearchParams(stateStr).get(name)
  } catch {
    // 壊れた liff.state で画面ごと落とさない
    return null
  }
}
