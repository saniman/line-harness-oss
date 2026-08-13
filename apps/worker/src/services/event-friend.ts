/**
 * イベント申込者の友だち解決（友だち登録必須ゲート）。
 *
 * モバイルオーダー（routes/orders.ts）・サロン予約（routes/booking.ts）が既に持っている
 * 「friends 行が無い / フォロー解除済みなら 403 friend_required」と同じ作法を、
 * イベント申込（無料・当日現金・Stripe決済）にも適用するためのヘルパー。
 *
 * friends 行が無い場合は「本当に未友だち」か「webhook の follow 取りこぼし」かを
 * LINE Messaging API の profile 取得（未友だちなら 404）で判定し、
 * 友だちであれば upsert して救済する（＝申込者を必ず friends に載せる）。
 */

import { upsertFriend } from '@line-crm/db'

/**
 * LINE Messaging API のうち profile 取得だけを要求するミニマルなインターフェース。
 * SDK クラス型（LineClient）を直接受けるとテストのモックが型を満たせないため、
 * 構造的部分型で受ける（.claude/rules/api-coding.md「外部SDKクライアントの型設計」）。
 */
export interface LineProfileClient {
  getProfile(userId: string): Promise<{
    userId: string
    displayName: string
    pictureUrl?: string
    statusMessage?: string
  }>
}

/**
 * 申込者の friend_id を解決する。
 *
 * @returns friend_id / 未友だち・ブロック中なら null（呼び出し側で 403 friend_required）
 */
export async function resolveEventApplicantFriendId(
  db: D1Database,
  lineUserId: string,
  lineClient: LineProfileClient | null,
): Promise<string | null> {
  if (!lineUserId) return null

  const row = await db
    .prepare('SELECT id, is_following FROM friends WHERE line_user_id = ? LIMIT 1')
    .bind(lineUserId)
    .first<{ id: string; is_following: number }>()

  if (row) {
    // ブロック中（is_following=0）は申込不可。友だち追加し直せば webhook が 1 に戻す。
    return row.is_following === 0 ? null : row.id
  }

  // friends 行が無い＝「未友だち」か「follow webhook の取りこぼし」。
  // クライアント申告の friendFlag は詐称できるため、LINE 側の状態を正として判定する。
  if (!lineClient) return null

  let profile: Awaited<ReturnType<LineProfileClient['getProfile']>>
  try {
    profile = await lineClient.getProfile(lineUserId)
  } catch (err) {
    // 未友だちなら 404。ネットワーク障害等も申込は通さず 403 に倒す（ゲートを素通りさせない）。
    console.error('[resolveEventApplicantFriendId] getProfile failed:', err)
    return null
  }

  const friend = await upsertFriend(db, {
    lineUserId,
    displayName: profile.displayName ?? null,
    pictureUrl: profile.pictureUrl ?? null,
    statusMessage: profile.statusMessage ?? null,
  })
  return friend.id
}
