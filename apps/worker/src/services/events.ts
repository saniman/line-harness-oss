import { jstNow } from '@line-crm/db'
import { switchToCancelledFollowup } from './event-followup.js'

export interface StripeRefundClient {
  checkout: {
    sessions: {
      retrieve(id: string): Promise<{ payment_intent: string | { id?: string } | null }>
    }
  }
  refunds: {
    create(params: { payment_intent: string }): Promise<{ id: string; status: string | null }>
  }
}

export interface EventRow {
  id: number
  title: string
  description: string | null
  start_at: string
  end_at: string
  capacity: number
  price: number | null
  is_published: number
  created_at: string
  updated_at: string
}

export interface EventWithCount extends EventRow {
  participant_count: number
}

export interface EventBookingRow {
  id: number
  event_id: number
  friend_id: string | null
  name: string
  email: string
  status: string
  payment_status: string
  stripe_session_id: string | null
  paid_at: string | null
  amount: number | null
  stripe_refund_id: string | null
  refund_status: string | null
  /** 当日現金を受け取った日時。null = 未受領（payment_status='cash' と併せて判定する） */
  cash_received_at: string | null
  /** freee が発行した領収書の URL。null = 未発行 */
  receipt_url: string | null
  /** 領収書を発行した日時。null = 未発行 */
  receipt_issued_at: string | null
  /**
   * キャンセルの理由。null = 本人都合のキャンセル（返金対象になり得る）。
   * 'checkout_abandoned' = Stripe 決済画面から戻った / 'checkout_expired' = セッション期限切れ。
   * 決済に至らなかった申込を参加者一覧から畳むための判別に使う（Issue #56）。
   */
  cancel_reason: string | null
  created_at: string
  updated_at: string
}

/** 決済に至らなかった申込に付く cancel_reason。null（本人都合のキャンセル）と区別する。 */
export const CHECKOUT_ABANDONED = 'checkout_abandoned'
export const CHECKOUT_EXPIRED = 'checkout_expired'
/** Stripe セッションを作れなかった＝申込者の離脱ではなく、こちら側の障害。 */
export const CHECKOUT_CREATE_FAILED = 'checkout_create_failed'

const PARTICIPANT_COUNT_SQL = `(SELECT COUNT(*) FROM event_bookings WHERE event_id = e.id AND status = 'confirmed') AS participant_count`

export async function createEvent(
  db: D1Database,
  data: { title: string; description?: string; start_at: string; end_at: string; capacity: number; price?: number | null; is_published?: number },
): Promise<EventWithCount> {
  if (!data.title) throw new Error('title is required')
  const result = await db.prepare(
    'INSERT INTO events (title, description, start_at, end_at, capacity, price, is_published) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).bind(data.title, data.description ?? null, data.start_at, data.end_at, data.capacity, data.price ?? null, data.is_published ?? 0).run()
  const lastId = (result as { meta?: { last_row_id?: number } }).meta?.last_row_id
  const row = await db.prepare(
    `SELECT e.*, ${PARTICIPANT_COUNT_SQL} FROM events e WHERE e.id = ?`,
  ).bind(lastId).first<EventWithCount>()
  return row!
}

export async function getEvents(db: D1Database): Promise<EventWithCount[]> {
  const result = await db.prepare(
    `SELECT e.*, ${PARTICIPANT_COUNT_SQL} FROM events e ORDER BY e.start_at`,
  ).all<EventWithCount>()
  return result.results
}

export async function getEventById(db: D1Database, id: number): Promise<EventWithCount | null> {
  const row = await db.prepare(
    `SELECT e.*, ${PARTICIPANT_COUNT_SQL} FROM events e WHERE e.id = ?`,
  ).bind(id).first<EventWithCount>()
  return row ?? null
}

export async function updateEvent(
  db: D1Database,
  id: number,
  updates: Partial<Pick<EventRow, 'title' | 'description' | 'start_at' | 'end_at' | 'capacity' | 'price' | 'is_published'>>,
): Promise<EventWithCount | null> {
  const sets: string[] = ["updated_at = datetime('now')"]
  const binds: unknown[] = []
  if (updates.title !== undefined) { sets.push('title = ?'); binds.push(updates.title) }
  if (updates.description !== undefined) { sets.push('description = ?'); binds.push(updates.description) }
  if (updates.start_at !== undefined) { sets.push('start_at = ?'); binds.push(updates.start_at) }
  if (updates.end_at !== undefined) { sets.push('end_at = ?'); binds.push(updates.end_at) }
  if (updates.capacity !== undefined) { sets.push('capacity = ?'); binds.push(updates.capacity) }
  if (updates.price !== undefined) { sets.push('price = ?'); binds.push(updates.price) }
  if (updates.is_published !== undefined) { sets.push('is_published = ?'); binds.push(updates.is_published) }
  binds.push(id)
  await db.prepare(`UPDATE events SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run()
  return getEventById(db, id)
}

export async function deleteEvent(db: D1Database, id: number): Promise<void> {
  await db.prepare('DELETE FROM events WHERE id = ?').bind(id).run()
}

export async function getParticipantCount(db: D1Database, eventId: number): Promise<number> {
  const row = await db.prepare(
    "SELECT COUNT(*) AS count FROM event_bookings WHERE event_id = ? AND status = 'confirmed'",
  ).bind(eventId).first<{ count: number }>()
  return row?.count ?? 0
}

export async function getEventBookings(db: D1Database, eventId: number): Promise<EventBookingRow[]> {
  const result = await db.prepare(
    "SELECT * FROM event_bookings WHERE event_id = ? AND status = 'confirmed' ORDER BY created_at",
  ).bind(eventId).all<EventBookingRow>()
  return result.results
}

/**
 * 管理画面用: 申込に紐づく友だちの情報を添えた行。
 * friend_id が NULL（＝友だち未連携）や is_following=0（未フォロー）を
 * 参加者一覧で判別できるようにするため JOIN して返す。
 */
export interface EventBookingWithFriend extends EventBookingRow {
  friend_display_name: string | null
  friend_is_following: number | null
}

export async function getEventBookingsAdmin(
  db: D1Database,
  eventId: number,
): Promise<EventBookingWithFriend[]> {
  const result = await db.prepare(
    `SELECT b.*, f.display_name AS friend_display_name, f.is_following AS friend_is_following
     FROM event_bookings b
     LEFT JOIN friends f ON f.id = b.friend_id
     WHERE b.event_id = ?
     ORDER BY b.created_at`,
  ).bind(eventId).all<EventBookingWithFriend>()
  return result.results
}

/** 申込に友だちを手動で紐付ける（lineUserId が復元できないケースの救済）。 */
export async function linkBookingToFriend(
  db: D1Database,
  bookingId: number,
  friendId: string,
): Promise<{ ok: boolean; error?: 'booking_not_found' | 'friend_not_found' }> {
  const friend = await db.prepare('SELECT id FROM friends WHERE id = ?')
    .bind(friendId).first<{ id: string }>()
  if (!friend) return { ok: false, error: 'friend_not_found' }

  const booking = await db.prepare('SELECT id FROM event_bookings WHERE id = ?')
    .bind(bookingId).first<{ id: number }>()
  if (!booking) return { ok: false, error: 'booking_not_found' }

  await db.prepare(
    "UPDATE event_bookings SET friend_id = ?, updated_at = datetime('now') WHERE id = ?",
  ).bind(friendId, bookingId).run()
  return { ok: true }
}

export async function createEventBooking(
  db: D1Database,
  data: { event_id: number; friend_id?: string | null; name: string; email?: string; payment_status?: string },
): Promise<EventBookingRow> {
  const paymentStatus = data.payment_status ?? 'unpaid'
  const result = await db.prepare(
    'INSERT INTO event_bookings (event_id, friend_id, name, email, payment_status) VALUES (?, ?, ?, ?, ?)',
  ).bind(data.event_id, data.friend_id ?? null, data.name, data.email ?? '', paymentStatus).run()
  const lastId = (result as { meta?: { last_row_id?: number } }).meta?.last_row_id
  const row = await db.prepare('SELECT * FROM event_bookings WHERE id = ?')
    .bind(lastId).first<EventBookingRow>()
  return row!
}

export async function createPendingBooking(
  db: D1Database,
  data: { event_id: number; friend_id?: string | null; name?: string; email?: string },
): Promise<EventBookingRow> {
  const result = await db.prepare(
    "INSERT INTO event_bookings (event_id, friend_id, name, email, status, payment_status) VALUES (?, ?, ?, ?, 'pending', 'unpaid')",
  ).bind(data.event_id, data.friend_id ?? null, data.name ?? '', data.email ?? '').run()
  const lastId = (result as { meta?: { last_row_id?: number } }).meta?.last_row_id
  const row = await db.prepare('SELECT * FROM event_bookings WHERE id = ?')
    .bind(lastId).first<EventBookingRow>()
  return row!
}

export async function updateBookingStripeSessionId(
  db: D1Database,
  bookingId: number,
  sessionId: string,
): Promise<void> {
  await db.prepare(
    "UPDATE event_bookings SET stripe_session_id = ?, updated_at = datetime('now') WHERE id = ?",
  ).bind(sessionId, bookingId).run()
}

export async function getEventBookingById(db: D1Database, id: number): Promise<EventBookingRow | null> {
  const row = await db.prepare('SELECT * FROM event_bookings WHERE id = ?')
    .bind(id).first<EventBookingRow>()
  return row ?? null
}

export async function cancelEventBooking(
  db: D1Database,
  bookingId: number,
  friendId: string | null,
  stripe: StripeRefundClient,
): Promise<{ success: boolean; refunded: boolean; refundId?: string; eventId?: number; error?: string }> {
  const booking = await getEventBookingById(db, bookingId)
  if (!booking) return { success: false, refunded: false, error: '予約が見つかりませんでした。' }

  if (booking.friend_id !== null && booking.friend_id !== friendId) {
    return { success: false, refunded: false, error: '予約が見つかりませんでした。' }
  }

  if (booking.status === 'cancelled') {
    return { success: false, refunded: false, error: 'すでにキャンセル済みです。' }
  }

  let refunded = false
  let refundId: string | undefined

  if (booking.payment_status === 'paid' && booking.stripe_session_id) {
    try {
      const session = await stripe.checkout.sessions.retrieve(booking.stripe_session_id)
      const paymentIntentId = typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent?.id
      if (paymentIntentId) {
        const refund = await stripe.refunds.create({ payment_intent: paymentIntentId })
        refundId = refund.id
        refunded = true
        await db.prepare(
          "UPDATE event_bookings SET stripe_refund_id = ?, refund_status = ?, updated_at = datetime('now') WHERE id = ?",
        ).bind(refund.id, refund.status, bookingId).run()
      }
    } catch (err) {
      console.error('[cancelEventBooking] Stripe refund failed:', err)
    }
  }

  // pending からのキャンセル＝Stripe 決済画面から戻ってきたケース（cancel_url 経由）。
  // 本人都合のキャンセル（confirmed からの遷移）と区別できないと、
  // 名前が空のゴミ行として参加者一覧に混ざる（Issue #56）。
  const cancelReason = booking.status === 'pending' ? CHECKOUT_ABANDONED : null

  await db.prepare(
    "UPDATE event_bookings SET status = 'cancelled', cancel_reason = ?, updated_at = datetime('now') WHERE id = ?",
  ).bind(cancelReason, bookingId).run()

  // 参加確定後のキャンセルだけ、お礼シナリオを止めてキャンセル者向けへ切り替える（ベストエフォート）。
  // pending（決済せず取り消しただけ）は申込意思が薄いため対象外。
  // ここで失敗してもキャンセル・返金自体は成功として返す。
  if (booking.status === 'confirmed') {
    try {
      const event = await db.prepare('SELECT start_at FROM events WHERE id = ?')
        .bind(booking.event_id).first<{ start_at: string }>()
      await switchToCancelledFollowup(db, booking.friend_id, event?.start_at ?? null)
    } catch (err) {
      console.error('[cancelEventBooking] switchToCancelledFollowup failed:', err)
    }
  }

  return { success: true, refunded, refundId, eventId: booking.event_id }
}

/**
 * 決済に至らなかった pending 申込を、理由付きで取り消す。
 *
 * 条件付き UPDATE（status='pending' のときだけ書き換える）にしているのは、
 * Stripe が webhook をリトライするうえ、期限切れ通知が遅れて届く場合があるため。
 * 無条件に上書きすると確定済みの申込を巻き戻して「支払ったのに参加できない」事故になる。
 *
 * @returns 実際に取り消したら true（＝この呼び出しが状態を変えた）
 */
async function cancelPendingCheckout(
  db: D1Database,
  bookingId: number,
  reason: string,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE event_bookings
        SET status = 'cancelled',
            cancel_reason = ?,
            updated_at = datetime('now')
      WHERE id = ? AND status = 'pending'`,
  ).bind(reason, bookingId).run()
  const changes = (result as { meta?: { changes?: number } }).meta?.changes ?? 0
  return changes > 0
}

/** Stripe Checkout セッションが期限切れになった pending 申込を取り消す。 */
export async function expireCheckoutBooking(
  db: D1Database,
  bookingId: number,
): Promise<boolean> {
  return cancelPendingCheckout(db, bookingId, CHECKOUT_EXPIRED)
}

/**
 * Stripe セッションを作れなかった pending 申込を取り消す。
 *
 * 期限切れ（＝申込者が離脱した）と分けて記録する。鍵の設定ミスや Stripe 障害では
 * 申込者全員がこの経路に落ちるため、離脱と同じ理由にすると
 * 参加者一覧の折りたたみの中で「今日は誰も申し込まなかった」と見分けがつかなくなり、
 * 運営者が障害に気づく手がかりが消える。
 */
export async function failCheckoutBooking(
  db: D1Database,
  bookingId: number,
): Promise<boolean> {
  return cancelPendingCheckout(db, bookingId, CHECKOUT_CREATE_FAILED)
}

export async function confirmEventBooking(
  db: D1Database,
  bookingId: number,
  amountTotal: number | null,
  name?: string | null,
  email?: string | null,
): Promise<void> {
  // cancel_reason も消す。cron スイープや期限切れ webhook が先に取り消した後で
  // 決済完了が届くケースがあり、理由が残ると確定行なのに参加者一覧から畳まれてしまう。
  //
  // ただし返金済み（stripe_refund_id あり）は復活させない。Stripe は webhook が
  // 失敗すると最大3日リトライするため、「確定 → 本人がキャンセル＋返金 → リトライ到着」
  // の順で届くことがある。無条件 UPDATE だと返金済みの申込が confirmed/paid に戻り、
  // 定員まで食ってしまう。取り消し後に決済が完了したケース（返金なし）は従来どおり復旧する。
  await db.prepare(
    "UPDATE event_bookings SET status = 'confirmed', payment_status = 'paid', paid_at = datetime('now'), amount = ?, name = COALESCE(?, name), email = COALESCE(?, email), cancel_reason = NULL, updated_at = datetime('now') WHERE id = ? AND stripe_refund_id IS NULL",
  ).bind(amountTotal, name ?? null, email ?? null, bookingId).run()
}

/**
 * 当日現金の受領を記録する。
 *
 * 現金は「申し込んだ」と「実際に受け取った」が別物で、受け取りはデジタルな信号が無いため
 * 人間が管理画面で押す。押した事実を `cash_received_at` に残し、
 * これを起点に領収書を発行する（#46）。
 *
 * ⚠️ payment_status は書き換えない。'cash' のまま据え置くことで、
 *    一覧で現金とカードを最後まで区別できる（#42 の設計）。
 *
 * 冪等にしてある。ボタン連打や再試行で受領日時が上書きされると、経理の突合がずれる。
 */
export async function markCashReceived(
  db: D1Database,
  bookingId: number,
): Promise<{ success: boolean; alreadyReceived: boolean; error?: string; booking?: EventBookingRow }> {
  const booking = await getEventBookingById(db, bookingId)
  if (!booking) {
    return { success: false, alreadyReceived: false, error: '予約が見つかりませんでした。' }
  }

  if (booking.status === 'cancelled') {
    // キャンセルした人から現金は受け取らない。通すと領収書まで発行されてしまう
    return { success: false, alreadyReceived: false, error: 'キャンセル済みの予約です。' }
  }
  if (booking.status !== 'confirmed') {
    return { success: false, alreadyReceived: false, error: '確定していない予約です。' }
  }
  if (booking.payment_status !== 'cash') {
    return { success: false, alreadyReceived: false, error: '当日現金の予約ではありません。' }
  }

  // 既に受領済みなら何もしない（日時を上書きしない）
  if (booking.cash_received_at) {
    return { success: true, alreadyReceived: true, booking }
  }

  const now = jstNow()
  // 未受領のときだけ通す。同時に押されても受領日時は最初の1回で確定する
  await db.prepare(
    "UPDATE event_bookings SET cash_received_at = ?, updated_at = datetime('now') WHERE id = ? AND cash_received_at IS NULL",
  ).bind(now, bookingId).run()

  return {
    success: true,
    alreadyReceived: false,
    booking: { ...booking, cash_received_at: now },
  }
}
