import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
  linkBookingToFriend: vi.fn(),
}))

vi.mock('../services/event-followup.js', () => ({
  enrollEventFollowupScenarios: vi.fn().mockResolvedValue(0),
  enrollEventParticipants: vi.fn(),
  switchToCancelledFollowup: vi.fn().mockResolvedValue({ stopped: 0, enrolled: 0 }),
}))

vi.mock('../services/liff-identity.js', () => ({
  verifyCaller: vi.fn(),
}))

vi.mock('../services/event-friend.js', () => ({
  resolveEventApplicant: vi.fn(),
}))

vi.mock('../services/event-friend-backfill.js', () => ({
  backfillEventBookingFriends: vi.fn(),
}))

vi.mock('../services/default-line-account.js', () => ({
  resolveDefaultLineAccountId: vi.fn().mockResolvedValue('acc-1'),
}))

vi.mock('@line-crm/db', () => ({
  getScenarioById: vi.fn(),
}))

import * as eventsService from '../services/events.js'
import { enrollEventParticipants } from '../services/event-followup.js'
import { verifyCaller } from '../services/liff-identity.js'
import { resolveEventApplicant } from '../services/event-friend.js'
import { backfillEventBookingFriends } from '../services/event-friend-backfill.js'
import { resolveDefaultLineAccountId } from '../services/default-line-account.js'
import { getScenarioById } from '@line-crm/db'
import { events } from './events.js'

const mockEnrollParticipants = vi.mocked(enrollEventParticipants)
const mockGetScenarioById = vi.mocked(getScenarioById)
const mockVerifyCaller = vi.mocked(verifyCaller)
const mockResolveApplicant = vi.mocked(resolveEventApplicant)
const mockBackfill = vi.mocked(backfillEventBookingFriends)
const mockResolveDefaultAccountId = vi.mocked(resolveDefaultLineAccountId)

const mockDb = {} as D1Database
const app = new Hono()
app.route('/', events)

const EVENT1 = {
  id: 1, title: '無料セミナー', description: null,
  start_at: '2026-06-01T10:00:00+09:00', end_at: '2026-06-01T12:00:00+09:00',
  capacity: 10, is_published: 1, price: 3000, created_at: '', updated_at: '', participant_count: 2,
}
// 申込締切は start_at の60分前（services/event-deadline.ts）。
// テストの既定時刻は「締切1分前」＝まだ申し込める時点に固定する。
// これで既存テストは従来どおり通り、締切のテストだけ setSystemTime で時刻を進める。
const EVENT1_START_MS = Date.parse(EVENT1.start_at)
const EVENT1_DEADLINE_MS = EVENT1_START_MS - 60 * 60 * 1000
const MINUTE_MS = 60 * 1000

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

beforeEach(() => {
  vi.clearAllMocks()
  // Date のみ差し替える（setTimeout 等は本物のまま）。申込締切が現在時刻に依存するため、
  // 時刻を固定しないとテストが「実行した日」によって落ちる。
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(EVENT1_DEADLINE_MS - MINUTE_MS)
  // 既定は「idToken 検証OK・友だち登録済み」。異常系は各テストで上書きする。
  mockVerifyCaller.mockResolvedValue({ ok: true, lineUserId: 'U123' })
  mockResolveApplicant.mockResolvedValue({ status: 'ok', friendId: 'friend-1' })
  mockResolveDefaultAccountId.mockResolvedValue('acc-1')
})

afterEach(() => {
  vi.useRealTimers()
})

/** LIFF からの申込リクエスト（Authorization: Bearer <idToken> 付き） */
const LIFF_HEADERS = {
  'Content-Type': 'application/json',
  Authorization: 'Bearer dummy-id-token',
}

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

  it('締切前は application_closed: false を返す', async () => {
    vi.setSystemTime(EVENT1_DEADLINE_MS - MINUTE_MS)
    vi.mocked(eventsService.getEvents).mockResolvedValue([{ ...EVENT1, is_published: 1 }])
    const res = await app.request('/api/events/public', {}, { DB: mockDb })
    const json = await res.json() as { data: { application_closed: boolean; available: boolean }[] }
    expect(json.data[0].application_closed).toBe(false)
  })

  it('締切後は application_closed: true を返す（available には混ぜない）', async () => {
    vi.setSystemTime(EVENT1_DEADLINE_MS)
    vi.mocked(eventsService.getEvents).mockResolvedValue([{ ...EVENT1, is_published: 1 }])
    const res = await app.request('/api/events/public', {}, { DB: mockDb })
    const json = await res.json() as { data: { application_closed: boolean; available: boolean }[] }
    expect(json.data[0].application_closed).toBe(true)
    // 締切と満席は別の状態。混ぜると「締切なのに満席表示」になる（#14 の再発）
    expect(json.data[0].available).toBe(true)
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
  const paidBooking = {
    ...BOOKING1,
    status: 'confirmed',
    payment_status: 'paid',
    paid_at: '2026-06-01T10:00:00',
    amount: 3000,
    friend_display_name: null,
    friend_is_following: null,
  }

  it('参加申込一覧にpayment_status・paid_at・amountが含まれる', async () => {
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

  it('友だち連携の状態（display_name・is_following）が含まれる', async () => {
    vi.mocked(eventsService.getEventBookingsAdmin).mockResolvedValue([
      { ...paidBooking, friend_id: 'friend-1', friend_display_name: '黒部誠規', friend_is_following: 0 },
    ])
    const res = await app.request('/api/events/1/bookings', {}, { DB: mockDb })
    const json = await res.json() as { data: typeof paidBooking[] }
    expect(json.data[0].friend_display_name).toBe('黒部誠規')
    expect(json.data[0].friend_is_following).toBe(0)
  })
})

describe('POST /api/events/:id/join', () => {
  it('参加申込を作成して201を返す', async () => {
    const event = { ...EVENT1, participant_count: 2 }
    vi.mocked(eventsService.getEventById).mockResolvedValue(event)
    vi.mocked(eventsService.createEventBooking).mockResolvedValue(BOOKING1)
    const res = await app.request('/api/events/1/join', {
      method: 'POST',
      headers: LIFF_HEADERS,
      body: JSON.stringify({ name: '山田太郎' }),
    }, { DB: mockDb })
    expect(res.status).toBe(201)
    const json = await res.json() as { success: boolean }
    expect(json.success).toBe(true)
  })

  it('解決した friend_id が createEventBooking に渡る', async () => {
    vi.mocked(eventsService.getEventById).mockResolvedValue({ ...EVENT1, participant_count: 2 })
    vi.mocked(eventsService.createEventBooking).mockResolvedValue(BOOKING1)
    await app.request('/api/events/1/join', {
      method: 'POST',
      headers: LIFF_HEADERS,
      body: JSON.stringify({ name: '山田太郎' }),
    }, { DB: mockDb })
    expect(eventsService.createEventBooking).toHaveBeenCalledWith(mockDb, expect.objectContaining({
      friend_id: 'friend-1',
    }))
  })

  it('idToken が無効なら401を返し申込を作らない', async () => {
    mockVerifyCaller.mockResolvedValue({ ok: false, reason: 'invalid' })
    vi.mocked(eventsService.getEventById).mockResolvedValue({ ...EVENT1, participant_count: 2 })
    const res = await app.request('/api/events/1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '山田太郎' }),
    }, { DB: mockDb })
    expect(res.status).toBe(401)
    expect(eventsService.createEventBooking).not.toHaveBeenCalled()
  })

  it('idToken の期限切れは id_token_expired を返す（クライアントが再ログインで復帰できるように）', async () => {
    mockVerifyCaller.mockResolvedValue({ ok: false, reason: 'expired' })
    vi.mocked(eventsService.getEventById).mockResolvedValue({ ...EVENT1, participant_count: 2 })
    const res = await app.request('/api/events/1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '山田太郎' }),
    }, { DB: mockDb })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'id_token_expired' })
    expect(eventsService.createEventBooking).not.toHaveBeenCalled()
  })

  it('友だち未登録なら403 friend_required を返し申込を作らない', async () => {
    mockResolveApplicant.mockResolvedValue({ status: 'not_friend' })
    vi.mocked(eventsService.getEventById).mockResolvedValue({ ...EVENT1, participant_count: 2 })
    const res = await app.request('/api/events/1/join', {
      method: 'POST',
      headers: LIFF_HEADERS,
      body: JSON.stringify({ name: '山田太郎' }),
    }, { DB: mockDb })
    expect(res.status).toBe(403)
    const json = await res.json() as { error: string }
    expect(json.error).toBe('friend_required')
    expect(eventsService.createEventBooking).not.toHaveBeenCalled()
  })

  it('友だち判定不能（LINE API 障害等）なら503を返し申込を作らない', async () => {
    mockResolveApplicant.mockResolvedValue({ status: 'unavailable' })
    vi.mocked(eventsService.getEventById).mockResolvedValue({ ...EVENT1, participant_count: 2 })
    const res = await app.request('/api/events/1/join', {
      method: 'POST',
      headers: LIFF_HEADERS,
      body: JSON.stringify({ name: '山田太郎' }),
    }, { DB: mockDb })
    expect(res.status).toBe(503)
    const json = await res.json() as { error: string }
    expect(json.error).toBe('friend_check_unavailable')
    expect(eventsService.createEventBooking).not.toHaveBeenCalled()
  })

  it('LINE_CHANNEL_ACCESS_TOKEN があれば idToken 由来の userId に push通知を送る', async () => {
    const event = { ...EVENT1, participant_count: 2 }
    vi.mocked(eventsService.getEventById).mockResolvedValue(event)
    vi.mocked(eventsService.createEventBooking).mockResolvedValue(BOOKING1)
    mockPushMessage.mockResolvedValue({})
    const res = await app.request('/api/events/1/join', {
      method: 'POST',
      headers: LIFF_HEADERS,
      body: JSON.stringify({ name: '山田太郎' }),
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
      headers: LIFF_HEADERS,
      body: JSON.stringify({ name: '山田太郎' }),
    }, { DB: mockDb })
    expect(res.status).toBe(409)
  })

  it('締切1分前は申し込める（境界値）', async () => {
    vi.setSystemTime(EVENT1_DEADLINE_MS - MINUTE_MS)
    vi.mocked(eventsService.getEventById).mockResolvedValue({ ...EVENT1, participant_count: 2 })
    vi.mocked(eventsService.createEventBooking).mockResolvedValue(BOOKING1)
    const res = await app.request('/api/events/1/join', {
      method: 'POST',
      headers: LIFF_HEADERS,
      body: JSON.stringify({ name: '山田太郎' }),
    }, { DB: mockDb })
    expect(res.status).toBe(201)
  })

  it('締切ちょうどは409 application_closed を返し申込を作らない（境界値）', async () => {
    vi.setSystemTime(EVENT1_DEADLINE_MS)
    vi.mocked(eventsService.getEventById).mockResolvedValue({ ...EVENT1, participant_count: 2 })
    const res = await app.request('/api/events/1/join', {
      method: 'POST',
      headers: LIFF_HEADERS,
      body: JSON.stringify({ name: '山田太郎' }),
    }, { DB: mockDb })
    expect(res.status).toBe(409)
    const json = await res.json() as { error: string }
    expect(json.error).toBe('application_closed')
    expect(eventsService.createEventBooking).not.toHaveBeenCalled()
  })

  it('締切1分後も409 application_closed（境界値）', async () => {
    vi.setSystemTime(EVENT1_DEADLINE_MS + MINUTE_MS)
    vi.mocked(eventsService.getEventById).mockResolvedValue({ ...EVENT1, participant_count: 2 })
    const res = await app.request('/api/events/1/join', {
      method: 'POST',
      headers: LIFF_HEADERS,
      body: JSON.stringify({ name: '山田太郎' }),
    }, { DB: mockDb })
    expect(res.status).toBe(409)
    const json = await res.json() as { error: string }
    expect(json.error).toBe('application_closed')
  })

  it('当日現金（paymentMethod: cash）も締切後は弾く', async () => {
    vi.setSystemTime(EVENT1_DEADLINE_MS + MINUTE_MS)
    vi.mocked(eventsService.getEventById).mockResolvedValue({ ...EVENT1, participant_count: 2 })
    const res = await app.request('/api/events/1/join', {
      method: 'POST',
      headers: LIFF_HEADERS,
      body: JSON.stringify({ name: '山田太郎', paymentMethod: 'cash' }),
    }, { DB: mockDb })
    expect(res.status).toBe(409)
    const json = await res.json() as { error: string }
    expect(json.error).toBe('application_closed')
    expect(eventsService.createEventBooking).not.toHaveBeenCalled()
  })

  it('締切と満席が同時なら締切を優先して返す（利用者にとって情報量が多いため）', async () => {
    vi.setSystemTime(EVENT1_DEADLINE_MS + MINUTE_MS)
    vi.mocked(eventsService.getEventById).mockResolvedValue({ ...EVENT1, participant_count: 10 })
    const res = await app.request('/api/events/1/join', {
      method: 'POST',
      headers: LIFF_HEADERS,
      body: JSON.stringify({ name: '山田太郎' }),
    }, { DB: mockDb })
    expect(res.status).toBe(409)
    const json = await res.json() as { error: string }
    expect(json.error).toBe('application_closed')
  })

  it('イベントが存在しない場合は404を返す', async () => {
    vi.mocked(eventsService.getEventById).mockResolvedValue(null)
    const res = await app.request('/api/events/999/join', {
      method: 'POST',
      headers: LIFF_HEADERS,
      body: JSON.stringify({ name: '山田太郎' }),
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
      headers: LIFF_HEADERS,
    }, MOCK_ENV)
    expect(res.status).toBe(200)
    const json = await res.json() as { success: boolean; data: { url: string } }
    expect(json.success).toBe(true)
    expect(json.data.url).toBe('https://checkout.stripe.com/pay/test')
  })

  it('正常系：解決した friend_id で仮登録し metadata に idToken 由来の lineUserId を入れる', async () => {
    vi.mocked(eventsService.getEventById).mockResolvedValue({ ...EVENT1, participant_count: 2 })
    vi.mocked(eventsService.createPendingBooking).mockResolvedValue(PENDING_BOOKING)
    vi.mocked(eventsService.updateBookingStripeSessionId).mockResolvedValue(undefined)
    mockCheckoutSessionCreate.mockResolvedValue({ id: 'cs_test_xxx', url: 'https://checkout.stripe.com/pay/test' })
    await app.request('/api/events/1/checkout-session', {
      method: 'POST',
      headers: LIFF_HEADERS,
    }, MOCK_ENV)
    expect(eventsService.createPendingBooking).toHaveBeenCalledWith(mockDb, {
      event_id: 1, friend_id: 'friend-1',
    })
    expect(mockCheckoutSessionCreate).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ lineUserId: 'U123' }),
    }))
  })

  it('異常系：idToken が無効 → 401（仮登録もしない）', async () => {
    mockVerifyCaller.mockResolvedValue({ ok: false, reason: 'invalid' })
    vi.mocked(eventsService.getEventById).mockResolvedValue({ ...EVENT1, participant_count: 2 })
    const res = await app.request('/api/events/1/checkout-session', {
      method: 'POST',
    }, MOCK_ENV)
    expect(res.status).toBe(401)
    expect(eventsService.createPendingBooking).not.toHaveBeenCalled()
  })

  it('異常系：idToken の期限切れ → 401 id_token_expired（pending 行を作らない）', async () => {
    mockVerifyCaller.mockResolvedValue({ ok: false, reason: 'expired' })
    vi.mocked(eventsService.getEventById).mockResolvedValue({ ...EVENT1, participant_count: 2 })
    const res = await app.request('/api/events/1/checkout-session', {
      method: 'POST',
    }, MOCK_ENV)
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'id_token_expired' })
    expect(eventsService.createPendingBooking).not.toHaveBeenCalled()
  })

  it('異常系：友だち未登録 → 403 friend_required（pending 行を作らない）', async () => {
    mockResolveApplicant.mockResolvedValue({ status: 'not_friend' })
    vi.mocked(eventsService.getEventById).mockResolvedValue({ ...EVENT1, participant_count: 2 })
    const res = await app.request('/api/events/1/checkout-session', {
      method: 'POST',
      headers: LIFF_HEADERS,
    }, MOCK_ENV)
    expect(res.status).toBe(403)
    const json = await res.json() as { error: string }
    expect(json.error).toBe('friend_required')
    expect(eventsService.createPendingBooking).not.toHaveBeenCalled()
    expect(mockCheckoutSessionCreate).not.toHaveBeenCalled()
  })

  it('異常系：友だち判定不能 → 503（pending 行を作らない）', async () => {
    mockResolveApplicant.mockResolvedValue({ status: 'unavailable' })
    vi.mocked(eventsService.getEventById).mockResolvedValue({ ...EVENT1, participant_count: 2 })
    const res = await app.request('/api/events/1/checkout-session', {
      method: 'POST',
      headers: LIFF_HEADERS,
    }, MOCK_ENV)
    expect(res.status).toBe(503)
    expect(eventsService.createPendingBooking).not.toHaveBeenCalled()
    expect(mockCheckoutSessionCreate).not.toHaveBeenCalled()
  })

  it('異常系：存在しないイベントID → 404', async () => {
    vi.mocked(eventsService.getEventById).mockResolvedValue(null)
    const res = await app.request('/api/events/999/checkout-session', {
      method: 'POST',
      headers: LIFF_HEADERS,
    }, MOCK_ENV)
    expect(res.status).toBe(404)
  })

  it('異常系：非公開イベント → 404', async () => {
    vi.mocked(eventsService.getEventById).mockResolvedValue({ ...EVENT1, is_published: 0 })
    const res = await app.request('/api/events/1/checkout-session', {
      method: 'POST',
      headers: LIFF_HEADERS,
    }, MOCK_ENV)
    expect(res.status).toBe(404)
  })

  it('締切1分前は決済に進める（境界値）', async () => {
    vi.setSystemTime(EVENT1_DEADLINE_MS - MINUTE_MS)
    vi.mocked(eventsService.getEventById).mockResolvedValue({ ...EVENT1, participant_count: 2 })
    vi.mocked(eventsService.createPendingBooking).mockResolvedValue(PENDING_BOOKING)
    mockCheckoutSessionCreate.mockResolvedValue({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' })
    const res = await app.request('/api/events/1/checkout-session', {
      method: 'POST',
      headers: LIFF_HEADERS,
    }, MOCK_ENV)
    expect(res.status).toBe(200)
  })

  it('締切ちょうどは409 application_closed（pending 行も Stripe セッションも作らない・境界値）', async () => {
    vi.setSystemTime(EVENT1_DEADLINE_MS)
    vi.mocked(eventsService.getEventById).mockResolvedValue({ ...EVENT1, participant_count: 2 })
    const res = await app.request('/api/events/1/checkout-session', {
      method: 'POST',
      headers: LIFF_HEADERS,
    }, MOCK_ENV)
    expect(res.status).toBe(409)
    const json = await res.json() as { error: string }
    expect(json.error).toBe('application_closed')
    expect(eventsService.createPendingBooking).not.toHaveBeenCalled()
    expect(mockCheckoutSessionCreate).not.toHaveBeenCalled()
  })

  it('締切1分後も409 application_closed（境界値）', async () => {
    vi.setSystemTime(EVENT1_DEADLINE_MS + MINUTE_MS)
    vi.mocked(eventsService.getEventById).mockResolvedValue({ ...EVENT1, participant_count: 2 })
    const res = await app.request('/api/events/1/checkout-session', {
      method: 'POST',
      headers: LIFF_HEADERS,
    }, MOCK_ENV)
    expect(res.status).toBe(409)
    const json = await res.json() as { error: string }
    expect(json.error).toBe('application_closed')
  })

  it('異常系：定員満席（confirmedのみカウント） → 409', async () => {
    vi.mocked(eventsService.getEventById).mockResolvedValue({ ...EVENT1, participant_count: 10, capacity: 10 })
    const res = await app.request('/api/events/1/checkout-session', {
      method: 'POST',
      headers: LIFF_HEADERS,
    }, MOCK_ENV)
    expect(res.status).toBe(409)
  })

  it('異常系：Stripe APIエラー → 500', async () => {
    vi.mocked(eventsService.getEventById).mockResolvedValue({ ...EVENT1, participant_count: 2 })
    vi.mocked(eventsService.createPendingBooking).mockResolvedValue(PENDING_BOOKING)
    mockCheckoutSessionCreate.mockRejectedValue(new Error('Stripe API error'))
    const res = await app.request('/api/events/1/checkout-session', {
      method: 'POST',
      headers: LIFF_HEADERS,
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

describe('POST /api/events/:id/backfill-friends', () => {
  const BACKFILL_ENV = { ...MOCK_ENV, LINE_CHANNEL_ACCESS_TOKEN: 'test-token' }

  it('正常系：復元結果（total/linked/created/skipped/truncated）を返す', async () => {
    vi.mocked(eventsService.getEventById).mockResolvedValue(EVENT1)
    mockBackfill.mockResolvedValue({ total: 3, linked: 2, created: 1, skipped: 1, truncated: false })
    const res = await app.request('/api/events/1/backfill-friends', { method: 'POST' }, BACKFILL_ENV)
    expect(res.status).toBe(200)
    const json = await res.json() as { success: boolean; data: { linked: number; skipped: number } }
    expect(json.data.linked).toBe(2)
    expect(json.data.skipped).toBe(1)
    // 既定アカウントを解決して渡す（復元した friends 行の line_account_id 用）
    expect(mockBackfill).toHaveBeenCalledWith(mockDb, 1, expect.anything(), expect.anything(), 'acc-1')
  })

  it('イベントが存在しなければ404', async () => {
    vi.mocked(eventsService.getEventById).mockResolvedValue(null)
    const res = await app.request('/api/events/999/backfill-friends', { method: 'POST' }, BACKFILL_ENV)
    expect(res.status).toBe(404)
    expect(mockBackfill).not.toHaveBeenCalled()
  })

  it('不正なイベントIDは400', async () => {
    const res = await app.request('/api/events/abc/backfill-friends', { method: 'POST' }, BACKFILL_ENV)
    expect(res.status).toBe(400)
    expect(mockBackfill).not.toHaveBeenCalled()
  })
})

describe('POST /api/events/bookings/:id/link-friend', () => {
  it('正常系：手動で friend を紐付ける', async () => {
    vi.mocked(eventsService.linkBookingToFriend).mockResolvedValue({ ok: true })
    const res = await app.request('/api/events/bookings/11/link-friend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ friendId: 'friend-9' }),
    }, MOCK_ENV)
    expect(res.status).toBe(200)
    expect(eventsService.linkBookingToFriend).toHaveBeenCalledWith(mockDb, 11, 'friend-9')
  })

  it('friendId が無ければ400', async () => {
    const res = await app.request('/api/events/bookings/11/link-friend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, MOCK_ENV)
    expect(res.status).toBe(400)
    expect(eventsService.linkBookingToFriend).not.toHaveBeenCalled()
  })

  it('友だちが存在しなければ404', async () => {
    vi.mocked(eventsService.linkBookingToFriend).mockResolvedValue({ ok: false, error: 'friend_not_found' })
    const res = await app.request('/api/events/bookings/11/link-friend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ friendId: 'nope' }),
    }, MOCK_ENV)
    expect(res.status).toBe(404)
    const json = await res.json() as { error: string }
    expect(json.error).toContain('友だち')
  })

  it('申込が存在しなければ404', async () => {
    vi.mocked(eventsService.linkBookingToFriend).mockResolvedValue({ ok: false, error: 'booking_not_found' })
    const res = await app.request('/api/events/bookings/999/link-friend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ friendId: 'friend-9' }),
    }, MOCK_ENV)
    expect(res.status).toBe(404)
    const json = await res.json() as { error: string }
    expect(json.error).toContain('申込')
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
describe('POST /api/events/:id/join の運営者 LINE 通知', () => {
  // 運営者の宛先。申込者本人（U123）と区別できるよう別 ID にする
  const ADMIN_ENV = {
    DB: mockDb,
    LINE_CHANNEL_ACCESS_TOKEN: 'token',
    ADMIN_LINE_USER_ID: 'Uadmin',
  }

  /** 運営者宛の push だけを取り出す（申込者本人への push と同じモックを共有しているため） */
  function adminPush() {
    return mockPushMessage.mock.calls.find(([to]) => to === 'Uadmin')
  }
  const adminMessage = () => JSON.stringify(adminPush()?.[1])

  async function join(
    env: Record<string, unknown>,
    body: Record<string, unknown> = { name: '山田太郎' },
    event: Record<string, unknown> = {},
  ) {
    vi.mocked(eventsService.getEventById).mockResolvedValue({ ...EVENT1, participant_count: 2, ...event } as never)
    // createEventBooking と同じく paymentMethod='cash' のときだけ payment_status='cash' になる
    vi.mocked(eventsService.createEventBooking).mockResolvedValue({
      ...BOOKING1,
      payment_status: body.paymentMethod === 'cash' ? 'cash' : 'unpaid',
    })
    return app.request('/api/events/1/join', {
      method: 'POST',
      headers: LIFF_HEADERS,
      body: JSON.stringify(body),
    }, env)
  }

  it('ADMIN_LINE_USER_ID が設定されていれば運営者に申込を通知する', async () => {
    const res = await join(ADMIN_ENV)
    expect(res.status).toBe(201)

    const call = adminPush()
    expect(call).toBeDefined()
    expect(call?.[1][0].type).toBe('flex')
    expect(call?.[1][0].altText).toContain('無料セミナー')
    expect(adminMessage()).toContain('山田太郎')
  })

  it('有料イベントに paymentMethod なしで申し込むと「未払い」と載せる（クライアント申告を信用しない）', async () => {
    await join(ADMIN_ENV, { name: '山田太郎' })   // EVENT1 は price: 3000
    expect(adminMessage()).toContain('未払い（要確認）¥3,000')
  })

  it('無料イベント（price なし）は「無料」と載せる', async () => {
    // EVENT1 のタイトルが「無料セミナー」だと支払いラベルを見ずに通ってしまうため、
    // このケースだけタイトルを差し替えて本当に支払いラベルを検証する
    await join(ADMIN_ENV, { name: '山田太郎' }, { price: null, title: '体験会' })
    expect(adminMessage()).toContain('無料')
  })

  it('当日現金払いは金額付きで「当日現金」と載せる（その場で集金するため）', async () => {
    await join(ADMIN_ENV, { name: '山田太郎', paymentMethod: 'cash' })   // EVENT1 は price: 3000
    expect(adminMessage()).toContain('当日現金 ¥3,000')
  })

  it('この申込を含めた申込数を載せる（申込前カウント+1）', async () => {
    await join(ADMIN_ENV)
    expect(adminMessage()).toContain('3 / 10 名')
  })

  it('ADMIN_LINE_USER_ID 未設定の環境では通知せず申込は成功する', async () => {
    // 未設定は console.warn を出す設計（設定漏れと区別するため）。テスト出力を汚さないよう抑える
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await join({ DB: mockDb, LINE_CHANNEL_ACCESS_TOKEN: 'token' })
    expect(res.status).toBe(201)
    expect(adminPush()).toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('運営者への通知が失敗しても申込は201で成功する（ベストエフォート）', async () => {
    // Once にして後続テストへ実装が漏れないようにする（clearAllMocks は実装を戻さない）
    mockPushMessage.mockRejectedValueOnce(new Error('LINE down'))
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await join(ADMIN_ENV)
    expect(res.status).toBe(201)
    consoleSpy.mockRestore()
  })
})
