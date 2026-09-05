import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

const mockConstructEventAsync = vi.hoisted(() => vi.fn())
const mockPushMessage = vi.hoisted(() => vi.fn())

vi.mock('stripe', () => {
  const MockStripe: any = vi.fn().mockImplementation(() => ({
    checkout: { sessions: { create: vi.fn() } },
    webhooks: { constructEventAsync: mockConstructEventAsync },
  }))
  MockStripe.createFetchHttpClient = vi.fn().mockReturnValue({})
  return { default: MockStripe }
})

vi.mock('@line-crm/line-sdk', () => ({
  LineClient: vi.fn().mockImplementation(() => ({
    pushMessage: mockPushMessage,
  })),
}))

vi.mock('../services/events.js', () => ({
  createEvent: vi.fn(),
  getEvents: vi.fn(),
  getEventById: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
  getParticipantCount: vi.fn(),
  getEventBookings: vi.fn(),
  createEventBooking: vi.fn(),
  createPendingBooking: vi.fn(),
  updateBookingStripeSessionId: vi.fn(),
  getEventBookingById: vi.fn(),
  confirmEventBooking: vi.fn(),
  expireCheckoutBooking: vi.fn(),
}))

vi.mock('../services/event-followup.js', () => ({
  enrollEventFollowupScenarios: vi.fn().mockResolvedValue(0),
  switchToCancelledFollowup: vi.fn().mockResolvedValue({ stopped: 0, enrolled: 0 }),
}))

vi.mock('../services/event-friend.js', () => ({
  resolveEventApplicant: vi.fn(),
}))

vi.mock('../services/default-line-account.js', () => ({
  resolveDefaultLineAccountId: vi.fn().mockResolvedValue('acc-1'),
}))

import * as eventsService from '../services/events.js'
import { enrollEventFollowupScenarios } from '../services/event-followup.js'
import { resolveEventApplicant } from '../services/event-friend.js'
import { stripe } from './stripe.js'

const mockEnrollFollowup = vi.mocked(enrollEventFollowupScenarios)
const mockResolveApplicant = vi.mocked(resolveEventApplicant)

/** friend_id 復元時の UPDATE を記録する D1 モック */
const dbUpdates: { sql: string; binds: unknown[] }[] = []
const mockDb = {
  prepare: (sql: string) => ({
    bind: (...binds: unknown[]) => {
      dbUpdates.push({ sql, binds })
      return { run: async () => ({ meta: {} }), first: async () => null }
    },
  }),
} as unknown as D1Database
const app = new Hono()
app.route('/', stripe)

const MOCK_ENV = {
  DB: mockDb,
  STRIPE_SECRET_KEY: 'sk_test_xxx',
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
  LINE_CHANNEL_ACCESS_TOKEN: 'line_token',
  LIFF_BASE_URL: 'https://liff.line.me/1661159603-5qlDj5wV',
}

const PENDING_BOOKING = {
  id: 1, event_id: 1, friend_id: null, name: '', email: '',
  status: 'pending', payment_status: 'unpaid',
  stripe_session_id: 'cs_test_xxx', paid_at: null, amount: null,
  stripe_refund_id: null, refund_status: null,
  cash_received_at: null, receipt_name: null, receipt_url: null, receipt_issued_at: null,
  cancel_reason: null,
  created_at: '', updated_at: '',
}

const EVENT1 = {
  id: 1, title: '無料セミナー', description: null,
  start_at: '2026-06-01T10:00:00+09:00', end_at: '2026-06-01T12:00:00+09:00',
  capacity: 10, price: 3000, is_published: 1, created_at: '', updated_at: '',
  participant_count: 2,
  // 当日リマインド（#67）。既定は未設定＝配信しない
  reminder_at: null, reminder_message_extra: null,
}

const MOCK_SESSION = {
  id: 'cs_test_xxx',
  amount_total: 3000,
  metadata: { bookingId: '1', lineUserId: 'U123', eventId: '1' },
  customer_details: { name: '山田太郎', email: 'yamada@example.com' },
}

beforeEach(() => {
  vi.clearAllMocks()
  dbUpdates.length = 0
  mockResolveApplicant.mockResolvedValue({ status: 'not_friend' })
})

describe('POST /api/stripe/webhook', () => {
  it('正常系：署名検証OK → booking確定・LINE通知送信', async () => {
    mockConstructEventAsync.mockResolvedValue({
      type: 'checkout.session.completed',
      data: { object: MOCK_SESSION },
    })
    vi.mocked(eventsService.getEventBookingById).mockResolvedValue(PENDING_BOOKING)
    vi.mocked(eventsService.confirmEventBooking).mockResolvedValue(undefined)
    vi.mocked(eventsService.getEventById).mockResolvedValue(EVENT1)
    mockPushMessage.mockResolvedValue({})

    const res = await app.request('/api/stripe/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=123,v1=abc' },
      body: JSON.stringify({ type: 'checkout.session.completed' }),
    }, MOCK_ENV)

    expect(res.status).toBe(200)
    const json = await res.json() as { received: boolean }
    expect(json.received).toBe(true)
    expect(eventsService.confirmEventBooking).toHaveBeenCalledWith(mockDb, 1, 3000, '山田太郎', 'yamada@example.com')
    expect(mockPushMessage).toHaveBeenCalledOnce()
  })

  it('friend_id が NULL なら metadata の lineUserId から復元して booking に埋める', async () => {
    mockConstructEventAsync.mockResolvedValue({
      type: 'checkout.session.completed',
      data: { object: MOCK_SESSION },
    })
    vi.mocked(eventsService.getEventBookingById).mockResolvedValue(PENDING_BOOKING)
    vi.mocked(eventsService.confirmEventBooking).mockResolvedValue(undefined)
    vi.mocked(eventsService.getEventById).mockResolvedValue(EVENT1)
    mockResolveApplicant.mockResolvedValue({ status: 'ok', friendId: 'friend-restored' })
    mockPushMessage.mockResolvedValue({})

    const res = await app.request('/api/stripe/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=123,v1=abc' },
      body: JSON.stringify({}),
    }, MOCK_ENV)

    expect(res.status).toBe(200)
    const update = dbUpdates.find((u) => u.sql.includes('UPDATE event_bookings'))
    expect(update?.binds).toEqual(['friend-restored', 1])
    // 復元した friend_id でアフターフォローに載せる
    expect(mockEnrollFollowup).toHaveBeenCalledWith(mockDb, 'friend-restored', EVENT1.start_at)
  })

  it('friend_id が既にあるなら復元処理を走らせない', async () => {
    mockConstructEventAsync.mockResolvedValue({
      type: 'checkout.session.completed',
      data: { object: MOCK_SESSION },
    })
    vi.mocked(eventsService.getEventBookingById).mockResolvedValue({ ...PENDING_BOOKING, friend_id: 'friend-1' })
    vi.mocked(eventsService.confirmEventBooking).mockResolvedValue(undefined)
    vi.mocked(eventsService.getEventById).mockResolvedValue(EVENT1)
    mockPushMessage.mockResolvedValue({})

    await app.request('/api/stripe/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=123,v1=abc' },
      body: JSON.stringify({}),
    }, MOCK_ENV)

    expect(mockResolveApplicant).not.toHaveBeenCalled()
    expect(mockEnrollFollowup).toHaveBeenCalledWith(mockDb, 'friend-1', EVENT1.start_at)
  })

  it('異常系：署名検証NG → 400', async () => {
    mockConstructEventAsync.mockRejectedValue(new Error('Signature verification failed'))

    const res = await app.request('/api/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 'invalid' },
      body: 'invalid',
    }, MOCK_ENV)

    expect(res.status).toBe(400)
    expect(eventsService.confirmEventBooking).not.toHaveBeenCalled()
  })

  it('異常系：bookingIdが存在しない → 200（冪等性）', async () => {
    mockConstructEventAsync.mockResolvedValue({
      type: 'checkout.session.completed',
      data: { object: MOCK_SESSION },
    })
    vi.mocked(eventsService.getEventBookingById).mockResolvedValue(null)

    const res = await app.request('/api/stripe/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=123,v1=abc' },
      body: JSON.stringify({}),
    }, MOCK_ENV)

    expect(res.status).toBe(200)
    expect(eventsService.confirmEventBooking).not.toHaveBeenCalled()
  })

  it('正常系：customer_detailsがない場合もbooking確定される', async () => {
    const sessionWithoutDetails = { ...MOCK_SESSION, customer_details: null }
    mockConstructEventAsync.mockResolvedValue({
      type: 'checkout.session.completed',
      data: { object: sessionWithoutDetails },
    })
    vi.mocked(eventsService.getEventBookingById).mockResolvedValue(PENDING_BOOKING)
    vi.mocked(eventsService.confirmEventBooking).mockResolvedValue(undefined)
    vi.mocked(eventsService.getEventById).mockResolvedValue(EVENT1)
    mockPushMessage.mockResolvedValue({})

    const res = await app.request('/api/stripe/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=123,v1=abc' },
      body: JSON.stringify({}),
    }, MOCK_ENV)

    expect(res.status).toBe(200)
    expect(eventsService.confirmEventBooking).toHaveBeenCalledWith(mockDb, 1, 3000, null, null)
  })

  it('checkout.session.expired：pending を期限切れとして取り消す', async () => {
    // 決済画面を閉じたまま戻ってこなかった申込。放置すると名前が空のゴミ行が
    // 参加者一覧に溜まり続ける（Issue #56）
    mockConstructEventAsync.mockResolvedValue({
      type: 'checkout.session.expired',
      data: { object: MOCK_SESSION },
    })
    vi.mocked(eventsService.expireCheckoutBooking).mockResolvedValue(true)

    const res = await app.request('/api/stripe/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=123,v1=abc' },
      body: JSON.stringify({}),
    }, MOCK_ENV)

    expect(res.status).toBe(200)
    expect(eventsService.expireCheckoutBooking).toHaveBeenCalledWith(mockDb, 1)
    // 確定処理は走らせない
    expect(eventsService.confirmEventBooking).not.toHaveBeenCalled()
  })

  it('checkout.session.expired：離脱者に LINE 通知を送らない', async () => {
    // 申し込まなかった人に「キャンセルしました」を送るのはノイズ
    mockConstructEventAsync.mockResolvedValue({
      type: 'checkout.session.expired',
      data: { object: MOCK_SESSION },
    })
    vi.mocked(eventsService.expireCheckoutBooking).mockResolvedValue(true)

    await app.request('/api/stripe/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=123,v1=abc' },
      body: JSON.stringify({}),
    }, MOCK_ENV)

    expect(mockPushMessage).not.toHaveBeenCalled()
    expect(mockEnrollFollowup).not.toHaveBeenCalled()
  })

  it('checkout.session.expired：bookingId が無ければ何もせず 200', async () => {
    mockConstructEventAsync.mockResolvedValue({
      type: 'checkout.session.expired',
      data: { object: { ...MOCK_SESSION, metadata: {} } },
    })

    const res = await app.request('/api/stripe/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=123,v1=abc' },
      body: JSON.stringify({}),
    }, MOCK_ENV)

    expect(res.status).toBe(200)
    expect(eventsService.expireCheckoutBooking).not.toHaveBeenCalled()
  })

  it('checkout.session.expired：既に確定済みで変化なしでも 200（冪等性）', async () => {
    mockConstructEventAsync.mockResolvedValue({
      type: 'checkout.session.expired',
      data: { object: MOCK_SESSION },
    })
    vi.mocked(eventsService.expireCheckoutBooking).mockResolvedValue(false)

    const res = await app.request('/api/stripe/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=123,v1=abc' },
      body: JSON.stringify({}),
    }, MOCK_ENV)

    expect(res.status).toBe(200)
  })

  it('正常系：checkout.session.completed以外のイベント → 200（無視）', async () => {
    mockConstructEventAsync.mockResolvedValue({
      type: 'payment_intent.succeeded',
      data: { object: {} },
    })

    const res = await app.request('/api/stripe/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=123,v1=abc' },
      body: JSON.stringify({}),
    }, MOCK_ENV)

    expect(res.status).toBe(200)
    const json = await res.json() as { received: boolean }
    expect(json.received).toBe(true)
    expect(eventsService.confirmEventBooking).not.toHaveBeenCalled()
  })
})
describe('Stripe決済確定時の運営者 LINE 通知', () => {
  // 運営者の宛先。申込者本人（U123）と区別できるよう別 ID にする
  const ADMIN_ENV = { ...MOCK_ENV, ADMIN_LINE_USER_ID: 'Uadmin' }

  /** 運営者宛の push だけを取り出す（申込者本人への push と同じモックを共有しているため） */
  function adminPush() {
    return mockPushMessage.mock.calls.find(([to]) => to === 'Uadmin')
  }

  async function webhook(env: Record<string, unknown>, booking = PENDING_BOOKING) {
    mockConstructEventAsync.mockResolvedValue({
      type: 'checkout.session.completed',
      data: { object: MOCK_SESSION },
    })
    vi.mocked(eventsService.getEventBookingById).mockResolvedValue(booking)
    vi.mocked(eventsService.confirmEventBooking).mockResolvedValue(undefined)
    vi.mocked(eventsService.getEventById).mockResolvedValue(EVENT1)
    mockPushMessage.mockResolvedValue({})
    return app.request('/api/stripe/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=123,v1=abc' },
      body: JSON.stringify({}),
    }, env)
  }

  it('決済確定で運営者に申込を通知する（金額付き）', async () => {
    const res = await webhook(ADMIN_ENV)
    expect(res.status).toBe(200)

    const call = adminPush()
    expect(call).toBeDefined()
    expect(call?.[1][0].type).toBe('flex')
    expect(JSON.stringify(call?.[1])).toContain('Stripe決済 ¥3,000')
  })

  it('webhook 再送（すでに confirmed の booking）では通知しない', async () => {
    const res = await webhook(ADMIN_ENV, { ...PENDING_BOOKING, status: 'confirmed' })
    expect(res.status).toBe(200)
    expect(adminPush()).toBeUndefined()
  })

  it('ADMIN_LINE_USER_ID 未設定の環境では通知せず決済確定は成功する', async () => {
    // 未設定は console.warn を出す設計（設定漏れと区別するため）。テスト出力を汚さないよう抑える
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await webhook(MOCK_ENV)
    expect(res.status).toBe(200)
    expect(eventsService.confirmEventBooking).toHaveBeenCalled()
    expect(adminPush()).toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('運営者への通知が失敗しても決済確定は成功する（ベストエフォート）', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockConstructEventAsync.mockResolvedValue({
      type: 'checkout.session.completed',
      data: { object: MOCK_SESSION },
    })
    vi.mocked(eventsService.getEventBookingById).mockResolvedValue(PENDING_BOOKING)
    vi.mocked(eventsService.confirmEventBooking).mockResolvedValue(undefined)
    vi.mocked(eventsService.getEventById).mockResolvedValue(EVENT1)
    // Once にして後続テストへ実装が漏れないようにする（clearAllMocks は実装を戻さない）
    mockPushMessage.mockRejectedValueOnce(new Error('LINE down'))

    const res = await app.request('/api/stripe/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=123,v1=abc' },
      body: JSON.stringify({}),
    }, ADMIN_ENV)

    expect(res.status).toBe(200)
    expect(eventsService.confirmEventBooking).toHaveBeenCalled()
    consoleSpy.mockRestore()
  })
})
