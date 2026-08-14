/**
 * イベント申込者の友だち解決（友だち登録必須ゲート）。
 *
 * モバイルオーダー（routes/orders.ts）・サロン予約（routes/booking.ts）が既に持っている
 * 「friends 行が無い / フォロー解除済みなら 403 friend_required」と同じ作法を、
 * イベント申込（無料・当日現金・Stripe決済）にも適用するためのヘルパー。
 *
 * DB の friends 行は webhook の取りこぼしで実態とズレることがあるため、
 * 「friends 行が無い」「is_following=0」のどちらも LINE Messaging API の
 * profile 取得（未友だち・ブロック中なら 404）で実態を確認し、
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
 * 申込者の友だち判定結果。
 * - ok          : 申込可（friend_id 確定）
 * - not_friend  : 未友だち／ブロック中 → 403 friend_required
 * - unavailable : LINE API 障害・設定不備で「判定できなかった」 → 503
 *
 * not_friend と unavailable を分けているのは、判定不能を 403 に丸めると
 * クライアントが「友だち追加してください」を出す → 既に友だちなので何も起きず
 * 戻ってくる → また 403、というループになるため。
 */
export type EventApplicantResolution =
  | { status: 'ok'; friendId: string }
  | { status: 'not_friend' }
  | { status: 'unavailable' }

/** LINE API の 404（＝そのユーザーは友だちではない）かどうか。 */
function isNotFriendError(err: unknown): boolean {
  // LineClient.request() は `LINE API error: <status> <statusText> — <body>` を投げる。
  const message = err instanceof Error ? err.message : String(err)
  return /^LINE API error: 404\b/.test(message)
}

/**
 * LINE 側の友だち状態の判定結果。
 * DB の friends 行は webhook の取りこぼしで実態とズレるため、
 * 「LINE に聞く」処理を申込ゲート（resolveEventApplicant）と
 * 遡及復元（event-friend-backfill）で共有する。
 */
export type FriendshipProbe =
  | { status: 'friend'; profile: { displayName: string; pictureUrl?: string; statusMessage?: string } }
  | { status: 'not_friend' }
  | { status: 'unknown' }

/**
 * LINE Messaging API の profile 取得で友だち状態を判定する。
 * 未友だち・ブロック中は 404 が返る。それ以外のエラーは判定不能（unknown）として扱い、
 * 呼び出し側が「未友だち」と誤断定しないようにする。
 */
export async function probeFriendship(
  lineClient: LineProfileClient | null,
  lineUserId: string,
): Promise<FriendshipProbe> {
  if (!lineClient) {
    // チャネルアクセストークン未設定＝サーバー側の設定不備。ユーザーのせいにしない。
    console.error('[probeFriendship] LINE client is not configured')
    return { status: 'unknown' }
  }
  if (!lineUserId) return { status: 'not_friend' }

  try {
    const profile = await lineClient.getProfile(lineUserId)
    return { status: 'friend', profile }
  } catch (err) {
    if (isNotFriendError(err)) return { status: 'not_friend' }
    // ネットワーク障害・レート制限等。判定できない。
    console.error('[probeFriendship] getProfile failed:', err)
    return { status: 'unknown' }
  }
}

/**
 * 申込者の友だちを解決する。friends 行が実態とズレている場合は LINE 側を正として救済する。
 */
export async function resolveEventApplicant(
  db: D1Database,
  lineUserId: string,
  lineClient: LineProfileClient | null,
  lineAccountId: string | null = null,
): Promise<EventApplicantResolution> {
  if (!lineUserId) return { status: 'not_friend' }

  const row = await db
    .prepare('SELECT id, is_following FROM friends WHERE line_user_id = ? LIMIT 1')
    .bind(lineUserId)
    .first<{ id: string; is_following: number }>()

  if (row && row.is_following !== 0) return { status: 'ok', friendId: row.id }

  // ここに来るのは次の2ケース。どちらも DB だけでは実態が分からない。
  //   (a) friends 行が無い          … follow webhook の取りこぼし or 本当に未友だち
  //   (b) is_following = 0          … unfollow の取りこぼし or 本当にブロック中
  // クライアント申告の friendFlag は詐称できるため、LINE 側の状態を正として判定する。
  // (b) を無条件に 403 にすると、再フォロー済みなのに友だち追加を押しても
  // follow イベントが発火せず（既に友だちのため）自力で復帰できない詰みになる。
  const probe = await probeFriendship(lineClient, lineUserId)
  if (probe.status === 'not_friend') return { status: 'not_friend' }
  if (probe.status === 'unknown') {
    // 判定できないので 503 に倒す（403 にするとループを生む）。
    return { status: 'unavailable' }
  }

  // LINE 上は友だち。DB を実態に合わせる（upsertFriend は is_following=1 に戻す）。
  const friend = await upsertFriend(db, {
    lineUserId,
    displayName: probe.profile.displayName ?? null,
    pictureUrl: probe.profile.pictureUrl ?? null,
    statusMessage: probe.profile.statusMessage ?? null,
    lineAccountId,
  })
  return { status: 'ok', friendId: friend.id }
}
