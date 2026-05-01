import { describe, it, expect } from 'vitest'
import { canCancel } from '../lib/bookings'
import type { Booking } from '../lib/bookings'

describe('予約管理ページ（キャンセル機能）', () => {
  describe('canCancel', () => {
    it('confirmed の予約はキャンセルできる', () => {
      expect(canCancel({ status: 'confirmed' } as Pick<Booking, 'status'>)).toBe(true)
    })

    it('cancelled の予約はキャンセルできない', () => {
      expect(canCancel({ status: 'cancelled' } as Pick<Booking, 'status'>)).toBe(false)
    })
  })

  describe('ステータスフィルタリング', () => {
    const bookings: Booking[] = [
      { id: '1', connectionId: 'c1', friendId: null, eventId: null, title: 'A', startAt: '2026-05-01T10:00:00+09:00', endAt: '2026-05-01T11:00:00+09:00', status: 'confirmed', metadata: null, createdAt: '' },
      { id: '2', connectionId: 'c1', friendId: null, eventId: null, title: 'B', startAt: '2026-05-02T10:00:00+09:00', endAt: '2026-05-02T11:00:00+09:00', status: 'cancelled', metadata: null, createdAt: '' },
    ]

    it('confirmed フィルタは confirmed のみを返す', () => {
      const filtered = bookings.filter(b => b.status === 'confirmed')
      expect(filtered).toHaveLength(1)
      expect(filtered[0].id).toBe('1')
    })

    it('cancelled フィルタは cancelled のみを返す', () => {
      const filtered = bookings.filter(b => b.status === 'cancelled')
      expect(filtered).toHaveLength(1)
      expect(filtered[0].id).toBe('2')
    })

    it('all フィルタは全件を返す', () => {
      expect(bookings).toHaveLength(2)
    })
  })

  describe('デフォルトソート', () => {
    it('予約日時の降順で並ぶ', () => {
      const bookings: Pick<Booking, 'id' | 'startAt'>[] = [
        { id: 'old', startAt: '2026-04-01T10:00:00+09:00' },
        { id: 'new', startAt: '2026-05-01T10:00:00+09:00' },
      ]
      const sorted = [...bookings].sort(
        (a, b) => new Date(b.startAt).getTime() - new Date(a.startAt).getTime()
      )
      expect(sorted[0].id).toBe('new')
      expect(sorted[1].id).toBe('old')
    })
  })
})
