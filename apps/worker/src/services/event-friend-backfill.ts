/**
 * イベント申込の friend_id 遡及復元。
 *
 * イベント申込は #18 で友だち登録必須ゲートを通るようになったが、それ以前に申し込んだ人は
 * `event_bookings.friend_id` が NULL のままで、管理画面の友だち管理にも現れない。
 * トリガー型の自動化は過去のレコードに遡らないため、遡及手段を併設する
 * （.claude/rules/api-coding.md「トリガー型自動化は新規発生分のみ」）。
 *
 * 有料申込は Stripe Checkout Session の metadata.lineUserId を持っているため、
 * `stripe_session_id` からセッションを引けば申込者の LINE userId を後から復元できる。
 */

import { upsertFriend } from '@line-crm/db'
import { probeFriendship, type LineProfileClient } from './event-friend.js'

/**
 * Stripe SDK のうちセッションの metadata 取得だけを要求するミニマルなインターフェース。
 * services/events.ts の StripeRefundClient とは用途が違うため別に定義する
 * （.claude/rules/api-coding.md「外部SDKクライアントの型設計」）。
 */
export interface StripeSessionMetadataClient {
  checkout: {
    sessions: {
      retrieve(id: string): Promise<{ metadata?: Record<string, string> | null }>
    }
  }
}

export interface BackfillResult {
  /** friend_id が NULL の申込の総数 */
  total: number
  /** friend_id を埋められた件数 */
  linked: number
  /** friends 行を新規作成した件数（linked の内数） */
  created: number
  /** 復元できずスキップした件数 */
  skipped: number
  /** 上限に達して未処理を残したか */
  truncated: boolean
}

/**
 * 1回の実行で処理する上限。Stripe API を件数分呼ぶため青天井にしない。
 * 超過分は truncated で呼び出し側に伝え、黙って切り捨てない。
 */
export const BACKFILL_LIMIT = 50

interface UnlinkedBooking {
  id: number
  stripe_session_id: string | null
  name: string
}

export async function backfillEventBookingFriends(
  db: D1Database,
  eventId: number,
  stripe: StripeSessionMetadataClient | null,
  lineClient: LineProfileClient | null,
  lineAccountId: string | null,
): Promise<BackfillResult> {
  // friend_id IS NULL だけを対象にするので、何度実行しても二重処理にならない（冪等）。
  const { results } = await db
    .prepare(
      `SELECT id, stripe_session_id, name FROM event_bookings
       WHERE event_id = ? AND friend_id IS NULL
       ORDER BY created_at`,
    )
    .bind(eventId)
    .all<UnlinkedBooking>()

  const total = results.length
  const targets = results.slice(0, BACKFILL_LIMIT)
  const result: BackfillResult = {
    total,
    linked: 0,
    created: 0,
    skipped: 0,
    truncated: total > BACKFILL_LIMIT,
  }

  for (const booking of targets) {
    const friendId = await resolveFriendIdForBooking(db, booking, stripe, lineClient, lineAccountId, result)
    if (!friendId) {
      result.skipped++
      continue
    }
    await db
      .prepare("UPDATE event_bookings SET friend_id = ?, updated_at = datetime('now') WHERE id = ? AND friend_id IS NULL")
      .bind(friendId, booking.id)
      .run()
    result.linked++
  }

  return result
}

/** 1件の申込から friend_id を復元する。復元できなければ null（呼び出し側で skip 集計）。 */
async function resolveFriendIdForBooking(
  db: D1Database,
  booking: UnlinkedBooking,
  stripe: StripeSessionMetadataClient | null,
  lineClient: LineProfileClient | null,
  lineAccountId: string | null,
  result: BackfillResult,
): Promise<string | null> {
  // 無料/現金の申込は Stripe セッションを持たない → 手動紐付けに回す
  if (!booking.stripe_session_id) return null
  if (!stripe) {
    console.error('[backfillEventBookingFriends] Stripe client is not configured')
    return null
  }

  let lineUserId: string | undefined
  try {
    const session = await stripe.checkout.sessions.retrieve(booking.stripe_session_id)
    lineUserId = session.metadata?.lineUserId || undefined
  } catch (err) {
    // 1件の失敗で全体を止めない
    console.error(`[backfillEventBookingFriends] retrieve failed booking=${booking.id}:`, err)
    return null
  }
  if (!lineUserId) return null

  const existing = await db
    .prepare('SELECT id FROM friends WHERE line_user_id = ? LIMIT 1')
    .bind(lineUserId)
    .first<{ id: string }>()
  if (existing) return existing.id

  // friends 行が無い。LINE 側の友だち状態を確認して is_following を決める。
  const probe = await probeFriendship(lineClient, lineUserId)
  if (probe.status === 'unknown') {
    // 判定不能。ここで is_following を決め打ちすると誤った状態で登録されるため、
    // 紐付けせず次回の実行に回す。
    return null
  }

  const friend = probe.status === 'friend'
    ? await upsertFriend(db, {
        lineUserId,
        displayName: probe.profile.displayName ?? null,
        pictureUrl: probe.profile.pictureUrl ?? null,
        statusMessage: probe.profile.statusMessage ?? null,
        isFollowing: true,
        lineAccountId,
      })
    : await upsertFriend(db, {
        // 未友だち。LINE から表示名が取れないので Stripe の申込者名を使う
        // （空欄だと友だち管理で誰か分からなくなる）。
        lineUserId,
        displayName: booking.name || null,
        isFollowing: false,
        lineAccountId,
      })

  result.created++
  return friend.id
}
