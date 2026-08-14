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
}))

vi.mock('../services/event-followup.js', () => ({
  enrollEventFollowupScenarios: vi.fn().mockResolvedValue(0),
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
  created_at: '', updated_at: '',
}

const EVENT1 = {
  id: 1, title: '無料セミナー', description: null,
  start_at: '2026-06-01T10:00:00+09:00', end_at: '2026-06-01T12:00:00+09:00',
  capacity: 10, price: 3000, is_published: 1, created_at: '', updated_at: '',
  participant_count: 2,
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
