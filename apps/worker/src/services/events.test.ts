import { describe, it, expect, vi, beforeEach } from 'vitest'

interface EventRow {
  id: number
  title: string
  description: string | null
  start_at: string
  end_at: string
  capacity: number
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
  created_at: string
  updated_at: string
}

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

import {
  createEvent,
  getEvents,
  getEventById,
  updateEvent,
  deleteEvent,
  getParticipantCount,
  getEventBookings,
  createEventBooking,
} from './events.js'

const EVENT1: EventWithCount = {
  id: 1, title: '無料セミナー', description: null,
  start_at: '2026-06-01T10:00:00+09:00', end_at: '2026-06-01T12:00:00+09:00',
  capacity: 10, is_published: 1, created_at: '', updated_at: '',
  participant_count: 0,
}

const BOOKING1: EventBookingRow = {
  id: 1, event_id: 1, friend_id: null, name: '山田太郎',
  email: 'yamada@example.com', status: 'confirmed', created_at: '', updated_at: '',
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
  it('参加申込を作成して返す', async () => {
    const db = makeDb(makeStmt(null), makeStmt(BOOKING1))
    const result = await createEventBooking(db, {
      event_id: 1,
      name: '山田太郎',
      email: 'yamada@example.com',
    })
    expect(result.name).toBe('山田太郎')
    expect(result.event_id).toBe(1)
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO event_bookings'))
  })
})
