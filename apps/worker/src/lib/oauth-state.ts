/**
 * LINE Login の OAuth `state` を base64 で往復させるヘルパー。
 *
 * `btoa()` は Latin-1 しか受け付けないため、マルチバイトの文字が 1 つでも
 * state に入ると `InvalidCharacterError` を投げ、/auth/line・/auth/oauth への
 * アクセスが丸ごと 500 になる。日本語の `utm_campaign=夏キャンペーン` のような
 * 値は広告運用では普通に来るため、クリック 1 件がまるごと失われる。
 *
 * そこで UTF-8 のバイト列を経由してエンコードする。ASCII のみの入力に対しては
 * 旧 `btoa()` と同じ出力になるため、既に発行済み（＝ユーザーが LINE の認可画面に
 * いる最中）の state も `decodeState()` でそのまま読める。
 *
 * upstream Shudesu/line-harness-oss の 6be3b7c を移植（fork ではテスト可能に
 * するため liff.ts 内のローカル関数ではなく lib に切り出している）。
 */
export function encodeState(state: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(state)));
}

/** `encodeState()`（および旧 `btoa()`）が作った state を復元する。 */
export function decodeState(encoded: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(encoded), (ch) => ch.charCodeAt(0)));
}
