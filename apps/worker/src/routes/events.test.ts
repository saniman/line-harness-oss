import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

const mockCheckoutSessionCreate = vi.hoisted(() => vi.fn())
const mockPushMessage = vi.hoisted(() => vi.fn().mockResolvedValue({}))

vi.mock('stripe', () => {
  const MockStripe: any = vi.fn().mockImplementation(() => ({
    checkout: { sessions: { create: mockCheckoutSessionCreate } },
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
  getEventBookingsAdmin: vi.fn(),
  createEventBooking: vi.fn(),
  createPendingBooking: vi.fn(),
  updateBookingStripeSessionId: vi.fn(),
  getEventBookingById: vi.fn(),
  confirmEventBooking: vi.fn(),
  cancelEventBooking: vi.fn(),
}))

vi.mock('../services/event-followup.js', () => ({
  enrollEventFollowupScenarios: vi.fn().mockResolvedValue(0),
  enrollEventParticipants: vi.fn(),
}))

vi.mock('@line-crm/db', () => ({
  getScenarioById: vi.fn(),
}))

import * as eventsService from '../services/events.js'
import { enrollEventParticipants } from '../services/event-followup.js'
import { getScenarioById } from '@line-crm/db'
import { events } from './events.js'

const mockEnrollParticipants = vi.mocked(enrollEventParticipants)
const mockGetScenarioById = vi.mocked(getScenarioById)

const mockDb = {} as D1Database
const app = new Hono()
app.route('/', events)

const EVENT1 = {
  id: 1, title: '無料セミナー', description: null,
  start_at: '2026-06-01T10:00:00+09:00', end_at: '2026-06-01T12:00:00+09:00',
  capacity: 10, is_published: 1, price: 3000, created_at: '', updated_at: '', participant_count: 2,
}
const BOOKING1 = {
  id: 1, event_id: 1, friend_id: null, name: '山田太郎',
  email: 'yamada@example.com', status: 'confirmed',
  payment_status: 'unpaid', stripe_session_id: null, paid_at: null, amount: null,
  stripe_refund_id: null, refund_status: null,
  created_at: '', updated_at: '',
}
const PENDING_BOOKING = {
  id: 2, event_id: 1, friend_id: null, name: '', email: '',
  status: 'pending', payment_status: 'unpaid',
  stripe_session_id: null, paid_at: null, amount: null,
  stripe_refund_id: null, refund_status: null,
  created_at: '', updated_at: '',
}

beforeEach(() => { vi.clearAllMocks() })

describe('GET /api/events', () => {
  it('イベント一覧を返す', async () => {
    vi.mocked(eventsService.getEvents).mockResolvedValue([EVENT1])
    const res = await app.request('/api/events', {}, { DB: mockDb })
    expect(res.status).toBe(200)
    const json = await res.json() as { success: boolean; data: unknown[] }
    expect(json.success).toBe(true)
    expect(json.data).toHaveLength(1)
  })
})

describe('POST /api/events', () => {
  it('イベントを作成して201を返す', async () => {
    vi.mocked(eventsService.createEvent).mockResolvedValue(EVENT1)
    const res = await app.request('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '無料セミナー', start_at: '2026-06-01T10:00:00+09:00', end_at: '2026-06-01T12:00:00+09:00', capacity: 10 }),
    }, { DB: mockDb })
    expect(res.status).toBe(201)
    const json = await res.json() as { success: boolean }
    expect(json.success).toBe(true)
  })

  it('必須項目が欠けたら400を返す', async () => {
    const res = await app.request('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start_at: '2026-06-01T10:00:00+09:00', end_at: '2026-06-01T12:00:00+09:00', capacity: 10 }),
    }, { DB: mockDb })
    expect(res.status).toBe(400)
  })

  it('price: 1000 を渡すとcreateEventにprice: 1000が渡される', async () => {
    vi.mocked(eventsService.createEvent).mockResolvedValue({ ...EVENT1, price: 1000 })
    const res = await app.request('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '有料セミナー', start_at: '2026-06-01T10:00:00+09:00', end_at: '2026-06-01T12:00:00+09:00', capacity: 10, price: 1000 }),
    }, { DB: mockDb })
    expect(res.status).toBe(201)
    const json = await res.json() as { success: boolean; data: { price: number } }
    expect(json.data.price).toBe(1000)
    expect(eventsService.createEvent).toHaveBeenCalledWith(mockDb, expect.objectContaining({ price: 1000 }))
  })

  it('priceを渡さないとcreateEventにprice: nullが渡される', async () => {
    vi.mocked(eventsService.createEvent).mockResolvedValue({ ...EVENT1, price: null })
    const res = await app.request('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '無料セミナー', start_at: '2026-06-01T10:00:00+09:00', end_at: '2026-06-01T12:00:00+09:00', capacity: 10 }),
    }, { DB: mockDb })
    expect(res.status).toBe(201)
    expect(eventsService.createEvent).toHaveBeenCalledWith(mockDb, expect.objectContaining({ price: null }))
  })

  it('price: 0 はnullとして扱われcreateEventにprice: nullが渡される', async () => {
    vi.mocked(eventsService.createEvent).mockResolvedValue({ ...EVENT1, price: null })
    const res = await app.request('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '無料セミナー', start_at: '2026-06-01T10:00:00+09:00', end_at: '2026-06-01T12:00:00+09:00', capacity: 10, price: 0 }),
    }, { DB: mockDb })
    expect(res.status).toBe(201)
    expect(eventsService.createEvent).toHaveBeenCalledWith(mockDb, expect.objectContaining({ price: null }))
  })
})

describe('GET /api/events/public', () => {
  it('公開イベントのみ返す（残席数付き）', async () => {
    const published = { ...EVENT1, is_published: 1 }
    vi.mocked(eventsService.getEvents).mockResolvedValue([published])
    const res = await app.request('/api/events/public', {}, { DB: mockDb })
    expect(res.status).toBe(200)
    const json = await res.json() as { success: boolean; data: { remaining: number }[] }
    expect(json.success).toBe(true)
    expect(json.data[0].remaining).toBe(EVENT1.capacity - EVENT1.participant_count)
  })
})

describe('GET /api/events/:id', () => {
  it('IDでイベントを1件取得する', async () => {
    vi.mocked(eventsService.getEventById).mockResolvedValue(EVENT1)
    const res = await app.request('/api/events/1', {}, { DB: mockDb })
    expect(res.status).toBe(200)
    const json = await res.json() as { success: boolean; data: typeof EVENT1 }
    expect(json.data.id).toBe(1)
  })

  it('存在しないIDは404を返す', async () => {
    vi.mocked(eventsService.getEventById).mockResolvedValue(null)
    const res = await app.request('/api/events/999', {}, { DB: mockDb })
    expect(res.status).toBe(404)
  })
})

describe('PUT /api/events/:id', () => {
  it('イベントを更新する', async () => {
    const updated = { ...EVENT1, title: '更新済みセミナー' }
    vi.mocked(eventsService.updateEvent).mockResolvedValue(updated)
    const res = await app.request('/api/events/1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '更新済みセミナー' }),
    }, { DB: mockDb })
    expect(res.status).toBe(200)
    const json = await res.json() as { success: boolean; data: typeof updated }
    expect(json.data.title).toBe('更新済みセミナー')
  })

  it('price: 2000 を渡すとupdateEventにprice: 2000が渡されレスポンスにprice: 2000が返る', async () => {
    const updated = { ...EVENT1, price: 2000 }
    vi.mocked(eventsService.updateEvent).mockResolvedValue(updated)
    const res = await app.request('/api/events/1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ price: 2000 }),
    }, { DB: mockDb })
    expect(res.status).toBe(200)
    const json = await res.json() as { success: boolean; data: { price: number } }
    expect(json.data.price).toBe(2000)
    expect(eventsService.updateEvent).toHaveBeenCalledWith(mockDb, 1, expect.objectContaining({ price: 2000 }))
  })

  it('タイトル・日時・定員・説明を同時に渡すとupdateEventに全フィールドが渡される', async () => {
    const updated = { ...EVENT1, title: '新タイトル', capacity: 20, description: '説明文' }
    vi.mocked(eventsService.updateEvent).mockResolvedValue(updated)
    const body = {
      title: '新タイトル',
      start_at: '2026-07-01T10:00:00.000Z',
      end_at: '2026-07-01T12:00:00.000Z',
      capacity: 20,
      description: '説明文',
    }
    const res = await app.request('/api/events/1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, { DB: mockDb })
    expect(res.status).toBe(200)
    expect(eventsService.updateEvent).toHaveBeenCalledWith(mockDb, 1, expect.objectContaining({
      title: '新タイトル',
      capacity: 20,
      description: '説明文',
    }))
  })
})

describe('DELETE /api/events/:id', () => {
  it('イベントを削除して200を返す', async () => {
    vi.mocked(eventsService.deleteEvent).mockResolvedValue(undefined)
    const res = await app.request('/api/events/1', { method: 'DELETE' }, { DB: mockDb })
    expect(res.status).toBe(200)
    const json = await res.json() as { success: boolean }
    expect(json.success).toBe(true)
  })
})

describe('GET /api/events/:id/bookings', () => {
  it('参加申込一覧にpayment_status・paid_at・amountが含まれる', async () => {
    const paidBooking = {
      ...BOOKING1,
      status: 'confirmed',
      payment_status: 'paid',
      paid_at: '2026-06-01T10:00:00',
      amount: 3000,
    }
    vi.mocked(eventsService.getEventBookingsAdmin).mockResolvedValue([paidBooking])
    const res = await app.request('/api/events/1/bookings', {}, { DB: mockDb })
    expect(res.status).toBe(200)
    const json = await res.json() as { success: boolean; data: typeof paidBooking[] }
    expect(json.success).toBe(true)
    expect(json.data).toHaveLength(1)
    expect(json.data[0].payment_status).toBe('paid')
    expect(json.data[0].paid_at).toBe('2026-06-01T10:00:00')
    expect(json.data[0].amount).toBe(3000)
  })
})

describe('POST /api/events/:id/join', () => {
  it('参加申込を作成して201を返す', async () => {
    const event = { ...EVENT1, participant_count: 2 }
    vi.mocked(eventsService.getEventById).mockResolvedValue(event)
    vi.mocked(eventsService.createEventBooking).mockResolvedValue(BOOKING1)
    const res = await app.request('/api/events/1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lineUserId: 'U123' }),
    }, { DB: mockDb })
    expect(res.status).toBe(201)
    const json = await res.json() as { success: boolean }
    expect(json.success).toBe(true)
  })

  it('lineUserId と LINE_CHANNEL_ACCESS_TOKEN があれば push通知を送る', async () => {
    const event = { ...EVENT1, participant_count: 2 }
    vi.mocked(eventsService.getEventById).mockResolvedValue(event)
    vi.mocked(eventsService.createEventBooking).mockResolvedValue(BOOKING1)
    mockPushMessage.mockResolvedValue({})
    const res = await app.request('/api/events/1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lineUserId: 'U123' }),
    }, { DB: mockDb, LINE_CHANNEL_ACCESS_TOKEN: 'test-token' })
    expect(res.status).toBe(201)
    expect(mockPushMessage).toHaveBeenCalledWith('U123', expect.arrayContaining([
      expect.objectContaining({ type: 'flex' }),
    ]))
  })

  it('定員超過は409を返す', async () => {
    const event = { ...EVENT1, participant_count: 10 }
    vi.mocked(eventsService.getEventById).mockResolvedValue(event)
    const res = await app.request('/api/events/1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lineUserId: 'U123' }),
    }, { DB: mockDb })
    expect(res.status).toBe(409)
  })

  it('イベントが存在しない場合は404を返す', async () => {
    vi.mocked(eventsService.getEventById).mockResolvedValue(null)
    const res = await app.request('/api/events/999/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lineUserId: 'U123' }),
    }, { DB: mockDb })
    expect(res.status).toBe(404)
  })
})

const MOCK_ENV = {
  DB: mockDb,
  STRIPE_SECRET_KEY: 'sk_test_xxx',
  LIFF_BASE_URL: 'https://liff.line.me/1661159603-5qlDj5wV',
}

describe('POST /api/events/:id/checkout-session', () => {
  it('正常系：Checkout Session URLが返る', async () => {
    vi.mocked(eventsService.getEventById).mockResolvedValue({ ...EVENT1, participant_count: 2 })
    vi.mocked(eventsService.createPendingBooking).mockResolvedValue(PENDING_BOOKING)
    vi.mocked(eventsService.updateBookingStripeSessionId).mockResolvedValue(undefined)
    mockCheckoutSessionCreate.mockResolvedValue({
      id: 'cs_test_xxx',
      url: 'https://checkout.stripe.com/pay/test',
    })
    const res = await app.request('/api/events/1/checkout-session', {
      method: 'POST',
      headers: { 'x-line-user-id': 'U123' },
    }, MOCK_ENV)
    expect(res.status).toBe(200)
    const json = await res.json() as { success: boolean; data: { url: string } }
    expect(json.success).toBe(true)
    expect(json.data.url).toBe('https://checkout.stripe.com/pay/test')
  })

  it('異常系：存在しないイベントID → 404', async () => {
    vi.mocked(eventsService.getEventById).mockResolvedValue(null)
    const res = await app.request('/api/events/999/checkout-session', {
      method: 'POST',
      headers: { 'x-line-user-id': 'U123' },
    }, MOCK_ENV)
    expect(res.status).toBe(404)
  })

  it('異常系：非公開イベント → 404', async () => {
    vi.mocked(eventsService.getEventById).mockResolvedValue({ ...EVENT1, is_published: 0 })
    const res = await app.request('/api/events/1/checkout-session', {
      method: 'POST',
      headers: { 'x-line-user-id': 'U123' },
    }, MOCK_ENV)
    expect(res.status).toBe(404)
  })

  it('異常系：定員満席（confirmedのみカウント） → 409', async () => {
    vi.mocked(eventsService.getEventById).mockResolvedValue({ ...EVENT1, participant_count: 10, capacity: 10 })
    const res = await app.request('/api/events/1/checkout-session', {
      method: 'POST',
      headers: { 'x-line-user-id': 'U123' },
    }, MOCK_ENV)
    expect(res.status).toBe(409)
  })

  it('異常系：Stripe APIエラー → 500', async () => {
    vi.mocked(eventsService.getEventById).mockResolvedValue({ ...EVENT1, participant_count: 2 })
    vi.mocked(eventsService.createPendingBooking).mockResolvedValue(PENDING_BOOKING)
    mockCheckoutSessionCreate.mockRejectedValue(new Error('Stripe API error'))
    const res = await app.request('/api/events/1/checkout-session', {
      method: 'POST',
      headers: { 'x-line-user-id': 'U123' },
    }, MOCK_ENV)
    expect(res.status).toBe(500)
  })
})

describe('POST /api/events/bookings/:id/cancel', () => {
  const CANCEL_ENV = { ...MOCK_ENV, LINE_CHANNEL_ACCESS_TOKEN: 'test-token' }

  it('正常系：キャンセル成功で200と refunded: false を返す', async () => {
    vi.mocked(eventsService.cancelEventBooking).mockResolvedValue({ success: true, refunded: false, eventId: 1 })
    vi.mocked(eventsService.getEventById).mockResolvedValue(EVENT1)
    const res = await app.request('/api/events/bookings/1/cancel', {
      method: 'POST',
      headers: { 'x-line-user-id': 'U123' },
    }, CANCEL_ENV)
    expect(res.status).toBe(200)
    const json = await res.json() as { success: boolean; data: { refunded: boolean } }
    expect(json.success).toBe(true)
    expect(json.data.refunded).toBe(false)
  })

  it('LINE通知：キャンセル成功時にpushMessageが呼ばれる', async () => {
    vi.mocked(eventsService.cancelEventBooking).mockResolvedValue({ success: true, refunded: false, eventId: 1 })
    vi.mocked(eventsService.getEventById).mockResolvedValue(EVENT1)
    await app.request('/api/events/bookings/1/cancel', {
      method: 'POST',
      headers: { 'x-line-user-id': 'U123' },
    }, CANCEL_ENV)
    expect(mockPushMessage).toHaveBeenCalledWith('U123', expect.arrayContaining([
      expect.objectContaining({ type: 'flex' }),
    ]))
  })

  it('LINE通知：返金ありの場合は返金文言が含まれる', async () => {
    vi.mocked(eventsService.cancelEventBooking).mockResolvedValue({ success: true, refunded: true, refundId: 're_xxx', eventId: 1 })
    vi.mocked(eventsService.getEventById).mockResolvedValue(EVENT1)
    await app.request('/api/events/bookings/1/cancel', {
      method: 'POST',
      headers: { 'x-line-user-id': 'U123' },
    }, CANCEL_ENV)
    const call = mockPushMessage.mock.calls[0]
    const flexMsg = call[1][0]
    const bodyText = JSON.stringify(flexMsg.contents.body)
    expect(bodyText).toContain('返金処理を開始しました')
    expect(bodyText).toContain('5〜10 営業日')
  })

  it('LINE_CHANNEL_ACCESS_TOKEN がなければ pushMessage は呼ばれない', async () => {
    vi.mocked(eventsService.cancelEventBooking).mockResolvedValue({ success: true, refunded: false, eventId: 1 })
    await app.request('/api/events/bookings/1/cancel', {
      method: 'POST',
      headers: { 'x-line-user-id': 'U123' },
    }, MOCK_ENV)
    expect(mockPushMessage).not.toHaveBeenCalled()
  })

  it('異常系：cancelEventBooking がエラーを返すと400', async () => {
    vi.mocked(eventsService.cancelEventBooking).mockResolvedValue({ success: false, refunded: false, error: 'すでにキャンセル済みです。' })
    const res = await app.request('/api/events/bookings/1/cancel', {
      method: 'POST',
    }, MOCK_ENV)
    expect(res.status).toBe(400)
    const json = await res.json() as { success: boolean; error: string }
    expect(json.error).toContain('キャンセル済み')
  })
})

describe('POST /api/events/:id/enroll-participants', () => {
  const EVENT_BOOKING_SCENARIO = {
    id: 'sc-1', name: 'もくもく会参加者', description: null,
    trigger_type: 'event_booking' as const, trigger_tag_id: null, line_account_id: null,
    is_active: 1, created_at: '', updated_at: '', steps: [],
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  function post(id: string, body: unknown) {
    return app.request(`/api/events/${id}/enroll-participants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, { DB: mockDb })
  }

  it('正常系：確定参加者を一括登録して enrolled/total を返す', async () => {
    mockGetScenarioById.mockResolvedValue(EVENT_BOOKING_SCENARIO)
    mockEnrollParticipants.mockResolvedValue({ eventFound: true, total: 2, enrolled: 2 })
    const res = await post('2', { scenarioId: 'sc-1' })
    expect(res.status).toBe(200)
    const json = await res.json() as { success: boolean; data: { enrolled: number; total: number } }
    expect(json.success).toBe(true)
    expect(json.data).toEqual({ enrolled: 2, total: 2 })
    expect(mockEnrollParticipants).toHaveBeenCalledWith(mockDb, 2, 'sc-1')
  })

  it('scenarioId が無ければ400', async () => {
    const res = await post('2', {})
    expect(res.status).toBe(400)
    expect(mockEnrollParticipants).not.toHaveBeenCalled()
  })

  it('シナリオが存在しなければ404', async () => {
    mockGetScenarioById.mockResolvedValue(null)
    const res = await post('2', { scenarioId: 'nope' })
    expect(res.status).toBe(404)
    expect(mockEnrollParticipants).not.toHaveBeenCalled()
  })

  it('event_booking 以外のシナリオは400で拒否する', async () => {
    mockGetScenarioById.mockResolvedValue({ ...EVENT_BOOKING_SCENARIO, trigger_type: 'friend_add' })
    const res = await post('2', { scenarioId: 'sc-1' })
    expect(res.status).toBe(400)
    expect(mockEnrollParticipants).not.toHaveBeenCalled()
  })

  it('イベントが存在しなければ404', async () => {
    mockGetScenarioById.mockResolvedValue(EVENT_BOOKING_SCENARIO)
    mockEnrollParticipants.mockResolvedValue({ eventFound: false, total: 0, enrolled: 0 })
    const res = await post('999', { scenarioId: 'sc-1' })
    expect(res.status).toBe(404)
  })
})
