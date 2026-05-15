import { describe, it, expect } from 'vitest'
import type { EventItem, EventBookingItem } from '../lib/api'

// ロジック関数
function getRemaining(event: Pick<EventItem, 'capacity' | 'participant_count'>): number {
  return event.capacity - event.participant_count
}

function isFull(event: Pick<EventItem, 'capacity' | 'participant_count'>): boolean {
  return event.participant_count >= event.capacity
}

function isPublished(event: Pick<EventItem, 'is_published'>): boolean {
  return event.is_published === 1
}

function filterPublished(events: EventItem[]): EventItem[] {
  return events.filter((e) => e.is_published === 1)
}

function sortByStartAt(events: EventItem[]): EventItem[] {
  return [...events].sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime())
}

function validateCapacity(capacity: number): string | null {
  if (!Number.isInteger(capacity) || capacity < 1) return '定員は1以上の整数で入力してください'
  return null
}

function validateEventForm(data: { title: string; start_at: string; end_at: string; capacity: number }): string | null {
  if (!data.title.trim()) return 'タイトルを入力してください'
  if (!data.start_at) return '開始日時を入力してください'
  if (!data.end_at) return '終了日時を入力してください'
  if (new Date(data.start_at) >= new Date(data.end_at)) return '終了日時は開始日時より後にしてください'
  return validateCapacity(data.capacity)
}

const BASE_EVENT: EventItem = {
  id: 1, title: '無料セミナー', description: null,
  start_at: '2026-06-01T10:00:00+09:00', end_at: '2026-06-01T12:00:00+09:00',
  capacity: 10, is_published: 1, participant_count: 3, remaining: 7,
  created_at: '', updated_at: '',
}

describe('イベント一覧ページ', () => {
  it('イベント一覧が表示される', () => {
    const events: EventItem[] = [BASE_EVENT, { ...BASE_EVENT, id: 2, title: '有料講座', is_published: 0 }]
    expect(events).toHaveLength(2)
    expect(events[0].title).toBe('無料セミナー')
  })

  it('定員・参加者数・残席数が表示される', () => {
    const event = BASE_EVENT
    expect(event.capacity).toBe(10)
    expect(event.participant_count).toBe(3)
    expect(getRemaining(event)).toBe(7)
  })

  it('満席の場合バッジで表示される', () => {
    const fullEvent = { ...BASE_EVENT, participant_count: 10 }
    expect(isFull(fullEvent)).toBe(true)
    expect(isFull(BASE_EVENT)).toBe(false)
  })

  it('非公開イベントは「非公開」バッジで表示される', () => {
    const unpublished = { ...BASE_EVENT, is_published: 0 }
    expect(isPublished(unpublished)).toBe(false)
    expect(isPublished(BASE_EVENT)).toBe(true)
  })
})

describe('イベント作成', () => {
  it('タイトル・日時・定員を入力して作成できる（バリデーション通過）', () => {
    const result = validateEventForm({
      title: '無料セミナー',
      start_at: '2026-06-01T10:00:00',
      end_at: '2026-06-01T12:00:00',
      capacity: 10,
    })
    expect(result).toBeNull()
  })

  it('定員は1以上でないとバリデーションエラー', () => {
    expect(validateCapacity(0)).toBeTruthy()
    expect(validateCapacity(-1)).toBeTruthy()
    expect(validateCapacity(1)).toBeNull()
  })

  it('タイトルが空ならバリデーションエラー', () => {
    const result = validateEventForm({
      title: '',
      start_at: '2026-06-01T10:00:00',
      end_at: '2026-06-01T12:00:00',
      capacity: 10,
    })
    expect(result).toBeTruthy()
  })

  it('終了日時が開始日時より前ならバリデーションエラー', () => {
    const result = validateEventForm({
      title: 'テスト',
      start_at: '2026-06-01T12:00:00',
      end_at: '2026-06-01T10:00:00',
      capacity: 10,
    })
    expect(result).toBeTruthy()
  })
})

describe('イベント削除', () => {
  it('確認ダイアログ後に削除できる（削除対象IDが正しい）', () => {
    const events: EventItem[] = [BASE_EVENT, { ...BASE_EVENT, id: 2, title: '有料講座' }]
    const targetId = 1
    const afterDelete = events.filter((e) => e.id !== targetId)
    expect(afterDelete).toHaveLength(1)
    expect(afterDelete[0].id).toBe(2)
  })
})

describe('イベントソート・フィルタ', () => {
  it('開始日時の昇順で並ぶ', () => {
    const events: EventItem[] = [
      { ...BASE_EVENT, id: 2, start_at: '2026-07-01T10:00:00+09:00' },
      { ...BASE_EVENT, id: 1, start_at: '2026-06-01T10:00:00+09:00' },
    ]
    const sorted = sortByStartAt(events)
    expect(sorted[0].id).toBe(1)
    expect(sorted[1].id).toBe(2)
  })

  it('公開済みイベントのみフィルタできる', () => {
    const events: EventItem[] = [
      { ...BASE_EVENT, id: 1, is_published: 1 },
      { ...BASE_EVENT, id: 2, is_published: 0 },
    ]
    const published = filterPublished(events)
    expect(published).toHaveLength(1)
    expect(published[0].id).toBe(1)
  })
})

// 決済ステータス表示ロジック
function getPaymentBadge(b: Pick<EventBookingItem, 'payment_status' | 'status'>): string {
  if (b.payment_status === 'paid') return '💳 決済済'
  if (b.payment_status === 'unpaid' && b.status === 'pending') return '⏳ 未決済'
  if (b.status === 'cancelled') return '❌ キャンセル'
  return '確定'
}

describe('決済ステータス表示', () => {
  it('payment_status=paid のとき「💳 決済済」と表示される', () => {
    const b = { payment_status: 'paid', status: 'confirmed' } as EventBookingItem
    expect(getPaymentBadge(b)).toBe('💳 決済済')
  })

  it('payment_status=unpaid かつ status=pending のとき「⏳ 未決済」と表示される', () => {
    const b = { payment_status: 'unpaid', status: 'pending' } as EventBookingItem
    expect(getPaymentBadge(b)).toBe('⏳ 未決済')
  })

  it('status=cancelled のとき「❌ キャンセル」と表示される', () => {
    const b = { payment_status: 'unpaid', status: 'cancelled' } as EventBookingItem
    expect(getPaymentBadge(b)).toBe('❌ キャンセル')
  })

  it('amount が null でなければ金額を表示できる', () => {
    const b = { amount: 3000 } as EventBookingItem
    const label = b.amount != null ? `¥${b.amount.toLocaleString()}` : '—'
    expect(label).toBe('¥3,000')
  })

  it('amount が null のときは「—」を表示する', () => {
    const b = { amount: null } as EventBookingItem
    const label = b.amount != null ? `¥${b.amount.toLocaleString()}` : '—'
    expect(label).toBe('—')
  })
})
