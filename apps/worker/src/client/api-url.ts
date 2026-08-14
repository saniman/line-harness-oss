/**
 * LIFF クライアントから Worker API を叩くための URL 解決。
 *
 * LIFF は Cloudflare Pages、API は別ドメインの Worker（api.walover-co.work）に
 * ホストされている。相対パスで fetch すると **リクエストが Pages に着弾し**、
 * SPA フォールバックの index.html（200 / text/html）が返るため `res.json()` が失敗する。
 * 失敗を握りつぶしている呼び出しでは無言で機能が死ぬ（#25 の友だち追加ボタン無反応）。
 *
 * 詳細: .claude/rules/liff.md「LIFFクライアントのfetchは必ず VITE_API_BASE 経由の絶対URLにする」
 */

export const API_BASE: string =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE) || ''

/**
 * API パスを絶対 URL に解決する。
 * `base` が空のとき（Worker が assets で LIFF も配信する構成）は相対パスのまま返す。
 */
export function apiUrl(path: string, base: string = API_BASE): string {
  if (!base) return path
  return new URL(path, base).toString()
}
