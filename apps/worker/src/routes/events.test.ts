import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

vi.mock('../services/events.js', () => ({
  createEvent: vi.fn(),
  getEvents: vi.fn(),
  getEventById: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
  getParticipantCount: vi.fn(),
  createEventBooking: vi.fn(),
}))

import * as eventsService from '../services/events.js'
import { events } from './events.js'

const mockDb = {} as D1Database
const app = new Hono()
app.route('/', events)

const EVENT1 = {
  id: 1, title: '無料セミナー', description: null,
  start_at: '2026-06-01T10:00:00+09:00', end_at: '2026-06-01T12:00:00+09:00',
  capacity: 10, is_published: 1, created_at: '', updated_at: '', participant_count: 2,
}
const BOOKING1 = {
  id: 1, event_id: 1, friend_id: null, name: '山田太郎',
  email: 'yamada@example.com', status: 'confirmed', created_at: '', updated_at: '',
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

describe('POST /api/events/:id/join', () => {
  it('参加申込を作成して201を返す', async () => {
    const event = { ...EVENT1, participant_count: 2 }
    vi.mocked(eventsService.getEventById).mockResolvedValue(event)
    vi.mocked(eventsService.createEventBooking).mockResolvedValue(BOOKING1)
    const res = await app.request('/api/events/1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '山田太郎', email: 'yamada@example.com' }),
    }, { DB: mockDb })
    expect(res.status).toBe(201)
    const json = await res.json() as { success: boolean }
    expect(json.success).toBe(true)
  })

  it('定員超過は409を返す', async () => {
    const event = { ...EVENT1, participant_count: 10 }
    vi.mocked(eventsService.getEventById).mockResolvedValue(event)
    const res = await app.request('/api/events/1/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '山田太郎', email: 'yamada@example.com' }),
    }, { DB: mockDb })
    expect(res.status).toBe(409)
  })

  it('イベントが存在しない場合は404を返す', async () => {
    vi.mocked(eventsService.getEventById).mockResolvedValue(null)
    const res = await app.request('/api/events/999/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '山田太郎', email: 'yamada@example.com' }),
    }, { DB: mockDb })
    expect(res.status).toBe(404)
  })
})
