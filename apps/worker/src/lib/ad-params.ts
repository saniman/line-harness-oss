/**
 * 広告のクリックID + UTM パラメータの転送ヘルパー。
 *
 * これらの値が最終的に DB に残るのは `/auth/callback` の `recordRefTracking()` だけで、
 * そこへ届く経路は **OAuth state 経由のみ**（`/auth/line` と `/auth/oauth` が state に詰める）。
 * LIFF の URL に付けても LIFF クライアントは読まないため計測にはならない。
 * したがって「広告パラメータを転送する」＝「OAuth 経路に渡す」であり、それ以外の
 * URL（LIFF 直リンク・QR ペイロード）に付けても効果はない。
 *
 * キー一覧が `/auth/oauth`（routes/liff.ts）の読み取りとズレると、転送しても state に
 * 入らず無言で計測が落ちる。実際 `/auth/line` / `/auth/oauth` / `/r/:ref` で並びが
 * バラバラになっていたため、ここを単一の情報源にしてテストで固定する。
 */
export const AD_TRACKING_PARAMS = [
  'gclid',
  'fbclid',
  'twclid',
  'ttclid',
  'utm_source',
  'utm_medium',
  'utm_campaign',
] as const;

/**
 * `read` から広告パラメータを読み、値があるものだけ `target` に積む。
 *
 * @param read  キーを受け取って値を返す関数（Hono なら `(k) => c.req.query(k)`）
 * @param target 転送先。既存のパラメータは壊さない
 */
export function forwardAdParams(
  read: (key: string) => string | undefined,
  target: URLSearchParams,
): void {
  for (const key of AD_TRACKING_PARAMS) {
    const value = read(key);
    // 空文字は「広告経由ではない」と同じ扱い。空で埋めると state 側で
    // 値ありと区別できなくなる。
    if (value) target.set(key, value);
  }
}
