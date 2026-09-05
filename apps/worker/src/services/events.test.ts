import { describe, it, expect, vi, beforeEach } from 'vitest'

interface EventRow {
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

interface EventWithCount extends EventRow {
  participant_count: number
}

interface EventBookingRow {
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
  cash_received_at: string | null
  receipt_name: string | null
  receipt_url: string | null
  receipt_issued_at: string | null
  cancel_reason: string | null
  created_at: string
  updated_at: string
}

vi.mock('./event-followup.js', () => ({
  switchToCancelledFollowup: vi.fn().mockResolvedValue({ stopped: 0, enrolled: 0 }),
}))

function makeStmt(firstResult: unknown = null, allResult: { results: unknown[] } = { results: [] }) {
  return {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ meta: { last_row_id: 1 } }),
    first: vi.fn().mockResolvedValue(firstResult),
    all: vi.fn().mockResolvedValue(allResult),
  }
}

function makeDb(...stmts: ReturnType<typeof makeStmt>[]) {
  let i = 0
  return { prepare: vi.fn().mockImplementation(() => stmts[i++] ?? makeStmt()) } as unknown as D1Database
}

import { switchToCancelledFollowup } from './event-followup.js'
import {
  createEvent,
  getEvents,
  getEventById,
  updateEvent,
  deleteEvent,
  getParticipantCount,
  getEventBookings,
  createEventBooking,
  createPendingBooking,
  updateBookingStripeSessionId,
  getEventBookingById,
  confirmEventBooking,
  cancelEventBooking,
  expireCheckoutBooking,
  failCheckoutBooking,
  markCashReceived,
  resolveReceiptName,
} from './events.js'

const mockSwitchToCancelled = vi.mocked(switchToCancelledFollowup)

const EVENT1: EventWithCount = {
  id: 1, title: '無料セミナー', description: null,
  start_at: '2026-06-01T10:00:00+09:00', end_at: '2026-06-01T12:00:00+09:00',
  capacity: 10, is_published: 1, price: 3000, created_at: '', updated_at: '',
  participant_count: 0,
}

const BOOKING1: EventBookingRow = {
  id: 1, event_id: 1, friend_id: null, name: '山田太郎',
  email: 'yamada@example.com', status: 'confirmed',
  payment_status: 'unpaid', stripe_session_id: null, paid_at: null, amount: null,
  stripe_refund_id: null, refund_status: null,
  cash_received_at: null, receipt_name: null, receipt_url: null, receipt_issued_at: null,
  cancel_reason: null,
  created_at: '', updated_at: '',
}

beforeEach(() => { vi.clearAllMocks() })

describe('createEvent', () => {
  it('イベントを作成してIDを返す', async () => {
    const db = makeDb(makeStmt(null), makeStmt(EVENT1))
    const result = await createEvent(db, {
      title: '無料セミナー',
      start_at: '2026-06-01T10:00:00+09:00',
      end_at: '2026-06-01T12:00:00+09:00',
      capacity: 10,
    })
    expect(result.title).toBe('無料セミナー')
    expect(result.id).toBe(1)
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO events'))
  })

  it('必須項目が欠けたらエラー', async () => {
    const db = makeDb()
    await expect(
      createEvent(db, { title: '', start_at: '2026-06-01T10:00:00+09:00', end_at: '2026-06-01T12:00:00+09:00', capacity: 10 })
    ).rejects.toThrow()
  })

  it('price: 1000 を渡すとINSERT文にpriceが含まれる', async () => {
    const eventWithPrice: EventWithCount = { ...EVENT1, price: 1000 }
    const db = makeDb(makeStmt(null), makeStmt(eventWithPrice))
    const result = await createEvent(db, {
      title: '有料セミナー',
      start_at: '2026-06-01T10:00:00+09:00',
      end_at: '2026-06-01T12:00:00+09:00',
      capacity: 10,
      price: 1000,
    })
    expect(result.price).toBe(1000)
    const insertSql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(insertSql).toContain('price')
  })

  it('priceを省略するとINSERT文にprice列が含まれnullで保存される', async () => {
    const eventFree: EventWithCount = { ...EVENT1, price: null }
    const db = makeDb(makeStmt(null), makeStmt(eventFree))
    const result = await createEvent(db, {
      title: '無料セミナー',
      start_at: '2026-06-01T10:00:00+09:00',
      end_at: '2026-06-01T12:00:00+09:00',
      capacity: 10,
    })
    expect(result.price).toBeNull()
    const insertSql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(insertSql).toContain('price')
  })
})

describe('getEvents', () => {
  it('イベント一覧を返す（参加者数付き）', async () => {
    const eventWithCount = { ...EVENT1, participant_count: 3 }
    const db = makeDb(makeStmt(null, { results: [eventWithCount] }))
    const result = await getEvents(db)
    expect(result).toHaveLength(1)
    expect(result[0].participant_count).toBe(3)
  })
})

describe('getEventById', () => {
  it('IDでイベントを1件取得する', async () => {
    const db = makeDb(makeStmt(EVENT1))
    const result = await getEventById(db, 1)
    expect(result).not.toBeNull()
    expect(result?.id).toBe(1)
    expect(result?.title).toBe('無料セミナー')
  })

  it('存在しないIDはnullを返す', async () => {
    const db = makeDb(makeStmt(null))
    const result = await getEventById(db, 999)
    expect(result).toBeNull()
  })
})

describe('updateEvent', () => {
  it('イベントを更新する', async () => {
    const updated: EventWithCount = { ...EVENT1, title: '更新済みセミナー' }
    const db = makeDb(makeStmt(null), makeStmt(updated))
    const result = await updateEvent(db, 1, { title: '更新済みセミナー' })
    expect(result?.title).toBe('更新済みセミナー')
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE events'))
  })

  it('price: 2000 を渡すとUPDATE文にprice = ?が含まれる', async () => {
    const updated: EventWithCount = { ...EVENT1, price: 2000 }
    const db = makeDb(makeStmt(null), makeStmt(updated))
    const result = await updateEvent(db, 1, { price: 2000 })
    expect(result?.price).toBe(2000)
    const updateSql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(updateSql).toContain('price = ?')
  })

  it('タイトル・定員・説明を同時に更新できる', async () => {
    const updated: EventWithCount = { ...EVENT1, title: '新タイトル', capacity: 20, description: '新しい説明' }
    const db = makeDb(makeStmt(null), makeStmt(updated))
    const result = await updateEvent(db, 1, { title: '新タイトル', capacity: 20, description: '新しい説明' })
    expect(result?.title).toBe('新タイトル')
    expect(result?.capacity).toBe(20)
    expect(result?.description).toBe('新しい説明')
    const updateSql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(updateSql).toContain('title = ?')
    expect(updateSql).toContain('capacity = ?')
    expect(updateSql).toContain('description = ?')
  })
})

describe('deleteEvent', () => {
  it('イベントを削除する', async () => {
    const db = makeDb(makeStmt(null))
    await deleteEvent(db, 1)
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM events'))
  })
})

describe('getParticipantCount', () => {
  it('confirmed の参加者数を返す', async () => {
    const db = makeDb(makeStmt({ count: 3 }))
    const count = await getParticipantCount(db, 1)
    expect(count).toBe(3)
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("status = 'confirmed'"))
  })

  it('満席判定（count >= capacity）が正しく動く', async () => {
    const db = makeDb(makeStmt({ count: 10 }))
    const count = await getParticipantCount(db, 1)
    const capacity = 10
    expect(count >= capacity).toBe(true)
  })
})

describe('getEventBookings', () => {
  it('指定イベントのconfirmed参加申込一覧を返す', async () => {
    const db = makeDb(makeStmt(null, { results: [BOOKING1] }))
    const result = await getEventBookings(db, 1)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('山田太郎')
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("status = 'confirmed'"))
  })
})

describe('createEventBooking', () => {
  it('参加申込を作成して返す（email省略可）', async () => {
    const db = makeDb(makeStmt(null), makeStmt(BOOKING1))
    const result = await createEventBooking(db, {
      event_id: 1,
      name: '山田太郎',
    })
    expect(result.name).toBe('山田太郎')
    expect(result.event_id).toBe(1)
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO event_bookings'))
  })
})

describe('createPendingBooking', () => {
  it("status='pending', payment_status='unpaid' のbookingを作成する", async () => {
    const pendingBooking: EventBookingRow = {
      ...BOOKING1, id: 2, name: '', email: '',
      status: 'pending', payment_status: 'unpaid',
    }
    const db = makeDb(makeStmt(null), makeStmt(pendingBooking))
    const result = await createPendingBooking(db, { event_id: 1 })
    expect(result.status).toBe('pending')
    expect(result.payment_status).toBe('unpaid')
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO event_bookings'))
  })
})

describe('updateBookingStripeSessionId', () => {
  it('stripe_session_id を更新する', async () => {
    const db = makeDb(makeStmt(null))
    await updateBookingStripeSessionId(db, 1, 'cs_test_xxx')
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('stripe_session_id'))
  })
})

describe('getEventBookingById', () => {
  it('IDでbookingを1件取得する', async () => {
    const db = makeDb(makeStmt(BOOKING1))
    const result = await getEventBookingById(db, 1)
    expect(result).not.toBeNull()
    expect(result?.id).toBe(1)
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('SELECT'))
  })

  it('存在しないIDはnullを返す', async () => {
    const db = makeDb(makeStmt(null))
    const result = await getEventBookingById(db, 999)
    expect(result).toBeNull()
  })
})

describe('confirmEventBooking', () => {
  it("status='confirmed', payment_status='paid' に更新する", async () => {
    const db = makeDb(makeStmt(null))
    await confirmEventBooking(db, 1, 3000)
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("status = 'confirmed'"))
  })

  it('返金済みの申込は復活させない', async () => {
    // notifyAdminEventBooking が try/catch されていないため LINE 障害で webhook が 500 になり、
    // Stripe は最大3日リトライする。その間に本人がキャンセル＋返金していると、
    // リトライで confirmed/paid に戻り定員まで食ってしまう
    const db = makeDb(makeStmt(null))
    await confirmEventBooking(db, 1, 3000)
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('stripe_refund_id IS NULL'))
  })

  it('cancel_reason を消す（期限切れ扱いの後に決済が完了したケース）', async () => {
    // cron スイープ／期限切れ webhook が先に取り消した後で決済完了が届くことがある。
    // 理由が残ると確定行なのに参加者一覧から畳まれてしまう
    const db = makeDb(makeStmt(null))
    await confirmEventBooking(db, 1, 3000)
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('cancel_reason = NULL'))
  })
})

function makeStripe(overrides?: { sessionPaymentIntent?: string | null; refundId?: string; refundStatus?: string; throwRefund?: boolean }) {
  return {
    checkout: {
      sessions: {
        retrieve: vi.fn().mockResolvedValue({
          payment_intent: overrides?.sessionPaymentIntent ?? 'pi_test_xxx',
        }),
      },
    },
    refunds: {
      create: overrides?.throwRefund
        ? vi.fn().mockRejectedValue(new Error('Stripe error'))
        : vi.fn().mockResolvedValue({ id: overrides?.refundId ?? 're_test_xxx', status: overrides?.refundStatus ?? 'succeeded' }),
    },
  }
}

describe('cancelEventBooking', () => {
  it('存在しないbookingIDの場合はエラーを返す', async () => {
    const db = makeDb(makeStmt(null))
    const stripe = makeStripe()
    const result = await cancelEventBooking(db, 999, null, stripe)
    expect(result.success).toBe(false)
    expect(result.error).toContain('見つかりません')
  })

  it('すでにcancelledの場合は二重キャンセルエラーを返す', async () => {
    const cancelled: EventBookingRow = { ...BOOKING1, status: 'cancelled' }
    const db = makeDb(makeStmt(cancelled))
    const stripe = makeStripe()
    const result = await cancelEventBooking(db, 1, null, stripe)
    expect(result.success).toBe(false)
    expect(result.error).toContain('キャンセル済み')
  })

  it('friendId が一致しない場合はエラーを返す', async () => {
    const booking: EventBookingRow = { ...BOOKING1, friend_id: 'U_owner' }
    const db = makeDb(makeStmt(booking))
    const stripe = makeStripe()
    const result = await cancelEventBooking(db, 1, 'U_other', stripe)
    expect(result.success).toBe(false)
    expect(result.error).toContain('見つかりません')
  })

  it('booking.friend_id=nullの場合はオーナーチェックをスキップしてキャンセルする', async () => {
    // friend_id が null の予約（checkout-session時にlookup失敗等）でも
    // キャンセルできる必要がある（cancelBookingと同じパターン）
    const db = makeDb(makeStmt(BOOKING1), makeStmt(null))
    const stripe = makeStripe()
    const result = await cancelEventBooking(db, 1, 'U_any_friend', stripe)
    expect(result.success).toBe(true)
    expect(result.refunded).toBe(false)
    expect(result.eventId).toBe(BOOKING1.event_id)
  })

  it('payment_status=unpaid の場合は返金なしでキャンセルする', async () => {
    const db = makeDb(makeStmt(BOOKING1), makeStmt(null))
    const stripe = makeStripe()
    const result = await cancelEventBooking(db, 1, null, stripe)
    expect(result.success).toBe(true)
    expect(result.refunded).toBe(false)
    expect(result.eventId).toBe(BOOKING1.event_id)
    expect(stripe.refunds.create).not.toHaveBeenCalled()
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("status = 'cancelled'"))
  })

  it('payment_status=paid の場合はStripe返金を実行してcancelledにする', async () => {
    const paidBooking: EventBookingRow = {
      ...BOOKING1, payment_status: 'paid', stripe_session_id: 'cs_test_xxx',
    }
    const db = makeDb(makeStmt(paidBooking), makeStmt(null), makeStmt(null))
    const stripe = makeStripe()
    const result = await cancelEventBooking(db, 1, null, stripe)
    expect(result.success).toBe(true)
    expect(result.refunded).toBe(true)
    expect(result.refundId).toBe('re_test_xxx')
    expect(stripe.refunds.create).toHaveBeenCalledWith({ payment_intent: 'pi_test_xxx' })
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('stripe_refund_id'))
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("status = 'cancelled'"))
  })

  it('Stripe返金が失敗してもキャンセル自体は成功する', async () => {
    const paidBooking: EventBookingRow = {
      ...BOOKING1, payment_status: 'paid', stripe_session_id: 'cs_test_xxx',
    }
    const db = makeDb(makeStmt(paidBooking), makeStmt(null))
    const stripe = makeStripe({ throwRefund: true })
    const result = await cancelEventBooking(db, 1, null, stripe)
    expect(result.success).toBe(true)
    expect(result.refunded).toBe(false)
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("status = 'cancelled'"))
  })

  it('confirmedの予約をキャンセルすると開催日を渡してキャンセル者向けフォローへ切り替える', async () => {
    const confirmed: EventBookingRow = { ...BOOKING1, friend_id: 'f1', status: 'confirmed' }
    const db = makeDb(
      makeStmt(confirmed),                                    // SELECT booking
      makeStmt(null),                                         // UPDATE status='cancelled'
      makeStmt({ start_at: '2026-06-01T10:00:00+09:00' }),    // SELECT events.start_at
    )
    const stripe = makeStripe()
    const result = await cancelEventBooking(db, 1, 'f1', stripe)
    expect(result.success).toBe(true)
    expect(mockSwitchToCancelled).toHaveBeenCalledWith(db, 'f1', '2026-06-01T10:00:00+09:00')
  })

  it('pendingの予約のキャンセルではフォロー切り替えを行わない', async () => {
    // 決済せず放置して取り消しただけの人には「残念でした」を送らない
    const pending: EventBookingRow = { ...BOOKING1, friend_id: 'f1', status: 'pending' }
    const db = makeDb(makeStmt(pending), makeStmt(null))
    const stripe = makeStripe()
    const result = await cancelEventBooking(db, 1, 'f1', stripe)
    expect(result.success).toBe(true)
    expect(mockSwitchToCancelled).not.toHaveBeenCalled()
  })

  it('フォロー切り替えが失敗してもキャンセル自体は成功する', async () => {
    const confirmed: EventBookingRow = { ...BOOKING1, friend_id: 'f1', status: 'confirmed' }
    const db = makeDb(makeStmt(confirmed), makeStmt(null), makeStmt({ start_at: '2026-06-01T10:00:00+09:00' }))
    const stripe = makeStripe()
    mockSwitchToCancelled.mockRejectedValueOnce(new Error('boom'))
    const result = await cancelEventBooking(db, 1, 'f1', stripe)
    expect(result.success).toBe(true)
  })

  it('pending からのキャンセルは cancel_reason に checkout_abandoned を記録する', async () => {
    // Stripe 決済画面で「戻る」を押すと cancel_url 経由で LIFF がこの API を叩く。
    // 本人都合のキャンセルと区別できないと参加者一覧のゴミ行と混ざる（Issue #56）
    const pending: EventBookingRow = { ...BOOKING1, friend_id: 'f1', status: 'pending' }
    const stmts = [makeStmt(pending), makeStmt(null)]
    const db = makeDb(...stmts)
    const stripe = makeStripe()

    await cancelEventBooking(db, 1, 'f1', stripe)

    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('cancel_reason'))
    expect(stmts[1].bind).toHaveBeenCalledWith('checkout_abandoned', 1)
  })

  it('confirmed からのキャンセルは cancel_reason を NULL のままにする', async () => {
    // 本人都合のキャンセル。返金対象になり得るため離脱と混同してはいけない
    const confirmed: EventBookingRow = { ...BOOKING1, friend_id: 'f1', status: 'confirmed' }
    const stmts = [makeStmt(confirmed), makeStmt(null), makeStmt({ start_at: '2026-06-01T10:00:00+09:00' })]
    const db = makeDb(...stmts)
    const stripe = makeStripe()

    await cancelEventBooking(db, 1, 'f1', stripe)

    expect(stmts[1].bind).toHaveBeenCalledWith(null, 1)
  })
})

describe('expireCheckoutBooking', () => {
  function makeRunStmt(changes: number | undefined) {
    return {
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValue(changes === undefined ? {} : { meta: { changes } }),
      first: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue({ results: [] }),
    }
  }

  it('pending を cancelled + checkout_expired にして true を返す', async () => {
    const stmt = makeRunStmt(1)
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database

    const result = await expireCheckoutBooking(db, 42)

    expect(result).toBe(true)
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(sql).toContain("status = 'cancelled'")
    // 理由は SQL に埋め込まず bind する（値に ' が入っても壊れないように）
    expect(sql).toContain('cancel_reason = ?')
    expect(stmt.bind).toHaveBeenCalledWith('checkout_expired', 42)
  })

  it('pending 以外は書き換えない（条件付き UPDATE）', async () => {
    // Stripe は webhook をリトライする。期限切れ通知が遅れて届いたときに
    // 確定済みの申込を巻き戻すと「支払ったのに参加できない」事故になる
    const stmt = makeRunStmt(0)
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database

    const result = await expireCheckoutBooking(db, 42)

    expect(result).toBe(false)
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(sql).toContain("status = 'pending'")
  })

  it('meta.changes が返らない D1 でも false として扱う', async () => {
    const stmt = makeRunStmt(undefined)
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database

    expect(await expireCheckoutBooking(db, 42)).toBe(false)
  })
})

describe('failCheckoutBooking', () => {
  function makeRunStmt(changes: number) {
    return {
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValue({ meta: { changes } }),
      first: vi.fn().mockResolvedValue(null),
      all: vi.fn().mockResolvedValue({ results: [] }),
    }
  }

  it('離脱ではなく checkout_create_failed として記録する', async () => {
    // Stripe の鍵ミス・API 障害を「客が離脱しただけ」と混ぜると、
    // 折りたたみに隠れて障害に気づけなくなる
    const stmt = makeRunStmt(1)
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database

    expect(await failCheckoutBooking(db, 7)).toBe(true)
    expect(stmt.bind).toHaveBeenCalledWith('checkout_create_failed', 7)
  })

  it('pending 以外は書き換えない', async () => {
    const stmt = makeRunStmt(0)
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database

    expect(await failCheckoutBooking(db, 7)).toBe(false)
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(sql).toContain("status = 'pending'")
  })
})

describe('markCashReceived', () => {
  const CASH: EventBookingRow = {
    ...BOOKING1, friend_id: 'f1', status: 'confirmed', payment_status: 'cash',
  }

  it('現金の未受領を受領済みにする', async () => {
    const db = makeDb(makeStmt(CASH), makeStmt({ cash_received_at: '2026-09-05 09:00:00' }))
    const res = await markCashReceived(db, 1, 1)
    expect(res.success).toBe(true)
    expect(res.alreadyReceived).toBe(false)
    expect(res.booking?.cash_received_at).toBe('2026-09-05 09:00:00')
  })

  it('記録した実際の値を返す（保存されていない値を作って返さない）', async () => {
    const db = makeDb(makeStmt(CASH), makeStmt({ cash_received_at: '2026-09-05 09:00:00' }))
    const res = await markCashReceived(db, 1, 1)
    expect(res.booking?.cash_received_at).toBe('2026-09-05 09:00:00')
  })

  it('存在しない予約なら success:false', async () => {
    const db = makeDb(makeStmt(null))
    const res = await markCashReceived(db, 1, 999)
    expect(res.success).toBe(false)
    expect(res.error).toContain('見つかりません')
  })

  it('既に受領済みなら二重に記録せず alreadyReceived:true を返す（冪等）', async () => {
    // ボタン連打や再試行で受領日時が上書きされると、経理の突合がずれる
    const received: EventBookingRow = {
      ...CASH, cash_received_at: '2026-09-05T18:00:00.000+09:00',
    }
    const db = makeDb(makeStmt(received))
    const res = await markCashReceived(db, 1, 1)
    expect(res.success).toBe(true)
    expect(res.alreadyReceived).toBe(true)
    expect(db.prepare).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE'))
  })

  it('現金以外（Stripe決済）は受領対象にしない', async () => {
    const paid: EventBookingRow = { ...CASH, payment_status: 'paid' }
    const db = makeDb(makeStmt(paid))
    const res = await markCashReceived(db, 1, 1)
    expect(res.success).toBe(false)
    expect(res.error).toContain('現金')
  })

  it('キャンセル済みの予約は受領できない', async () => {
    // キャンセルした人から現金を受け取ることはない。押せてしまうと領収書まで飛ぶ
    const cancelled: EventBookingRow = { ...CASH, status: 'cancelled' }
    const db = makeDb(makeStmt(cancelled))
    const res = await markCashReceived(db, 1, 1)
    expect(res.success).toBe(false)
    expect(res.error).toContain('キャンセル')
  })

  it('決済待ち（pending）の予約は受領できない', async () => {
    const pending: EventBookingRow = { ...CASH, status: 'pending' }
    const db = makeDb(makeStmt(pending))
    const res = await markCashReceived(db, 1, 1)
    expect(res.success).toBe(false)
  })

  it('更新は未受領のときだけ通す（同時押しで二重更新しない）', async () => {
    const db = makeDb(makeStmt(CASH), makeStmt({ cash_received_at: 'x' }))
    await markCashReceived(db, 1, 1)
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as string).find((q) => q.includes('UPDATE')) ?? ''
    expect(sql).toContain('cash_received_at IS NULL')
  })

  // ── 更新結果を見る（レビュー③）────────────────────────────

  it('【重要】0行更新でも、記録されていなければ失敗として返す', async () => {
    // WHERE に status/payment_status を足したので、0行更新の意味が2通りに増えた:
    //   ① 誰かが先に記録した → 受領済みで正しい
    //   ② 間にキャンセルされた → 受領できていない
    // ②を「受領済み」と答えると、現物の現金を受け取ったのに記録が残らず、
    // 画面にもエラーが出ない。
    const cancelled: EventBookingRow = { ...CASH, status: 'cancelled' }
    const db = makeDb(
      makeStmt(CASH),        // SELECT: このときは確定・未受領に見えた
      makeStmt(null),        // UPDATE: 0行
      makeStmt(cancelled),   // 読み直し: cash_received_at は null のまま
    )

    const res = await markCashReceived(db, 1, 1)

    expect(res.success).toBe(false)
    expect(res.code).toBe('state_changed')
  })

  it('【重要】0行更新なら成功と偽らず alreadyReceived として返す', async () => {
    // 別のスタッフが一瞬先に押した場合。更新結果を見ないと、
    // 保存されていない日時を「今記録した」と返してしまう。
    const stored: EventBookingRow = { ...CASH, cash_received_at: '2026-09-05T09:00:00' }
    const db = makeDb(
      makeStmt(CASH),      // SELECT: このとき未受領に見えた
      makeStmt(null),      // UPDATE: 0行（競合に負けた）
      makeStmt(stored),    // 読み直し
    )

    const res = await markCashReceived(db, 1, 1)

    expect(res.success).toBe(true)
    expect(res.alreadyReceived).toBe(true)
    expect(res.booking?.cash_received_at).toBe('2026-09-05T09:00:00')
  })

  it('UPDATE の WHERE で status と payment_status も守る', async () => {
    // SELECT と UPDATE の間にキャンセルされても押印しない
    const db = makeDb(makeStmt(CASH), makeStmt({ cash_received_at: 'x' }))
    await markCashReceived(db, 1, 1)
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as string).find((q) => q.includes('UPDATE')) ?? ''
    expect(sql).toContain("status = 'confirmed'")
    expect(sql).toContain("payment_status = 'cash'")
  })

  // ── 日時規約（レビュー④）──────────────────────────────────

  it('受領日時は event_bookings の他の列と同じ UTC 表記で記録する', async () => {
    // paid_at / created_at / updated_at はすべて datetime('now')。
    // ここだけ JST(+09:00) にすると、SQLite の文字列比較で 9 時間ずれる。
    const db = makeDb(makeStmt(CASH), makeStmt({ cash_received_at: 'x' }))
    await markCashReceived(db, 1, 1)
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as string).find((q) => q.includes('UPDATE')) ?? ''
    expect(sql).toContain("cash_received_at = datetime('now')")
  })

  // ── 受け取った金額を残す（レビューB）──────────────────────

  it('受領時に amount を焼き込む（未設定なら）', async () => {
    // amount は Stripe の webhook でしか入らないため現金申込は常に null。
    // 領収書（#46）が載せる金額を読み出せるよう、受領時に確定させる。
    const db = makeDb(makeStmt(CASH), makeStmt({ cash_received_at: 'x' }))
    await markCashReceived(db, 1, 1)
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as string).find((q) => q.includes('UPDATE')) ?? ''
    expect(sql).toContain('amount = COALESCE(amount,')
  })

  it('金額はサーバー側で events.price から引く（クライアントから受け取らない）', async () => {
    // ブラウザから金額を送れると、領収書の金額を改ざんできてしまう
    const db = makeDb(makeStmt(CASH), makeStmt({ cash_received_at: 'x' }))
    await markCashReceived(db, 1, 1)
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as string).find((q) => q.includes('UPDATE')) ?? ''
    expect(sql).toContain('SELECT price FROM events')
  })

  it('既に amount があれば上書きしない（COALESCE）', async () => {
    const db = makeDb(makeStmt(CASH), makeStmt({ cash_received_at: 'x' }))
    await markCashReceived(db, 1, 1)
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as string).find((q) => q.includes('UPDATE')) ?? ''
    // COALESCE の第1引数が既存の amount であること
    expect(sql).toMatch(/amount = COALESCE\(amount,/)
  })

  // ── 機械可読なエラーコード（レビューC）────────────────────

  it('エラーを日本語の文言でなく code で見分けられる', async () => {
    // ルートが 404/400 を「見つかりません」の部分一致で判定していると、
    // 文言を直した瞬間にステータスが変わる
    const db = makeDb(makeStmt(null))
    const res = await markCashReceived(db, 1, 999)
    expect(res.code).toBe('not_found')
  })

  it('キャンセル済みは code=cancelled', async () => {
    const db = makeDb(makeStmt({ ...CASH, status: 'cancelled' }))
    expect((await markCashReceived(db, 1, 1)).code).toBe('cancelled')
  })

  it('現金以外は code=not_cash', async () => {
    const db = makeDb(makeStmt({ ...CASH, payment_status: 'paid' }))
    expect((await markCashReceived(db, 1, 1)).code).toBe('not_cash')
  })

  it('イベント不一致は code=event_mismatch', async () => {
    const db = makeDb(makeStmt({ ...CASH, event_id: 99 }))
    expect((await markCashReceived(db, 1, 1)).code).toBe('event_mismatch')
  })

  // ── イベントIDの突き合わせ（レビュー⑤）────────────────────

  it('パスのイベントIDと予約のイベントIDが違えば拒否する', async () => {
    // 別イベントの予約に受領を記録できてしまうと、
    // 成功が返るのに一覧に変化が無く、間違いに気づけない
    const otherEvent: EventBookingRow = { ...CASH, event_id: 99 }
    const db = makeDb(makeStmt(otherEvent))

    const res = await markCashReceived(db, 1, 1)

    expect(res.success).toBe(false)
    expect(res.error).toContain('イベント')
  })
})

describe('createEventBooking の領収書宛名', () => {
  it('宛名を渡すと INSERT に含める', async () => {
    const db = makeDb(makeStmt(null), makeStmt(BOOKING1))
    await createEventBooking(db, {
      event_id: 1, name: '山田太郎', receipt_name: '株式会社サンプル',
    })
    const sql = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(sql).toContain('receipt_name')
  })

  it('【重要】宛名はサーバー側で正規化してから保存する', async () => {
    // LIFF を経由せず API を直接叩けるので、クライアント検証だけでは守れない。
    // 改行や双方向制御文字を残すと、管理画面や領収書で別の名前に見せかけられる。
    const stmt = makeStmt(null)
    const db = makeDb(stmt, makeStmt(BOOKING1))
    await createEventBooking(db, {
      event_id: 1, name: '山田太郎',
      receipt_name: `  株式会社\n\nサンプル${String.fromCharCode(0x202e)}  `,
    })
    const bound = (stmt.bind as ReturnType<typeof vi.fn>).mock.calls.flat()
    expect(bound).toContain('株式会社 サンプル')
  })

  it('宛名が空文字なら null で保存する（氏名へのフォールバックを効かせる）', async () => {
    // ⚠️ bound に null が「含まれるか」で見てはいけない。friend_id ?? null が
    //    常に null を入れるため、正規化が壊れていても通ってしまう。
    //    受け渡し位置（6番目のパラメータ）を名指しで確認する。
    const stmt = makeStmt(null)
    const db = makeDb(stmt, makeStmt(BOOKING1))
    await createEventBooking(db, { event_id: 1, name: '山田太郎', receipt_name: '   ' })
    const args = (stmt.bind as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(args[5]).toBeNull()
  })

  it('宛名を渡したときも受け渡し位置が正しい', async () => {
    const stmt = makeStmt(null)
    const db = makeDb(stmt, makeStmt(BOOKING1))
    await createEventBooking(db, {
      event_id: 1, name: '山田太郎', receipt_name: '株式会社サンプル',
    })
    const args = (stmt.bind as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(args[5]).toBe('株式会社サンプル')
  })

  it('宛名を渡さない既存の呼び出しも動く（後方互換）', async () => {
    const db = makeDb(makeStmt(null), makeStmt(BOOKING1))
    const res = await createEventBooking(db, { event_id: 1, name: '山田太郎' })
    expect(res).toBeTruthy()
  })
})

describe('resolveReceiptName', () => {
  it('宛名の指定があればそれを使う', () => {
    expect(resolveReceiptName({ receipt_name: '株式会社サンプル', name: 'あきひさ' }))
      .toBe('株式会社サンプル')
  })

  it('指定が無ければ申込時の氏名（LINEの表示名）を使う', () => {
    expect(resolveReceiptName({ receipt_name: null, name: 'あきひさ' })).toBe('あきひさ')
  })

  it('どちらも無ければ空文字（発行側で判断できるように null にしない）', () => {
    expect(resolveReceiptName({ receipt_name: null, name: '' })).toBe('')
  })

  it('宛名が空文字でも氏名にフォールバックする', () => {
    // 現状 sanitizeReceiptName は '' を返さないので到達しないが、
    // 管理画面からの編集や手動 SQL で '' が入った瞬間に宛名が空欄になる。
    // ?? では '' を「指定あり」と扱ってしまう。
    expect(resolveReceiptName({ receipt_name: '', name: 'あきひさ' })).toBe('あきひさ')
  })

  it('宛名が空白のみでも氏名にフォールバックする', () => {
    expect(resolveReceiptName({ receipt_name: '   ', name: 'あきひさ' })).toBe('あきひさ')
  })
})
