import { describe, it, expect } from 'vitest'
import { validateBookingRequest, buildSlots } from './calendar.js'

describe('予約リクエストのバリデーション', () => {
  const validBody = {
    connectionId: 'conn-123',
    title: '無料相談予約',
    startAt: '2025-05-01T10:00:00+09:00',
    endAt: '2025-05-01T11:00:00+09:00',
  }

  it('全項目が正しければnullを返す（バリデーション通過）', () => {
    expect(validateBookingRequest(validBody)).toBeNull()
  })

  it('connectionId が空なら400相当のエラーを返す', () => {
    const result = validateBookingRequest({ ...validBody, connectionId: '' })
    expect(result).toBeTruthy()
    expect(result).toContain('connectionId')
  })

  it('connectionId が未指定ならエラー', () => {
    const { connectionId: _, ...body } = validBody
    const result = validateBookingRequest(body)
    expect(result).toBeTruthy()
    expect(result).toContain('connectionId')
  })

  it('title が空なら400相当のエラーを返す', () => {
    const result = validateBookingRequest({ ...validBody, title: '' })
    expect(result).toBeTruthy()
    expect(result).toContain('title')
  })

  it('startAt が空なら400相当のエラーを返す', () => {
    const result = validateBookingRequest({ ...validBody, startAt: '' })
    expect(result).toBeTruthy()
  })

  it('endAt が空なら400相当のエラーを返す', () => {
    const result = validateBookingRequest({ ...validBody, endAt: '' })
    expect(result).toBeTruthy()
  })

  it('startAt が endAt より後なら400相当のエラーを返す', () => {
    const result = validateBookingRequest({
      ...validBody,
      startAt: '2025-05-01T12:00:00+09:00',
      endAt: '2025-05-01T11:00:00+09:00',
    })
    expect(result).toBeTruthy()
    expect(result).toContain('startAt')
  })

  it('startAt と endAt が同じ時刻なら400相当のエラーを返す', () => {
    const result = validateBookingRequest({
      ...validBody,
      startAt: '2025-05-01T10:00:00+09:00',
      endAt: '2025-05-01T10:00:00+09:00',
    })
    expect(result).toBeTruthy()
  })
})

describe('buildSlots', () => {
  it('指定時間帯のスロット数を正しく生成する', () => {
    const slots = buildSlots('2026-05-11', 9, 11, 60, [], [])
    expect(slots).toHaveLength(2) // 9-10, 10-11
    expect(slots[0].available).toBe(true)
    expect(slots[1].available).toBe(true)
  })

  it('30分刻みのスロットを生成する', () => {
    const slots = buildSlots('2026-05-11', 9, 11, 30, [], [])
    expect(slots).toHaveLength(4) // 9:00, 9:30, 10:00, 10:30
  })

  it('D1予約と重複するスロットはavailable=falseになる', () => {
    const bookings = [{ start_at: '2026-05-11T09:00:00+09:00', end_at: '2026-05-11T10:00:00+09:00' }]
    const slots = buildSlots('2026-05-11', 9, 11, 60, bookings, [])
    expect(slots[0].available).toBe(false)
    expect(slots[1].available).toBe(true)
  })

  it('Googleカレンダーの予定と重複するスロットはavailable=falseになる', () => {
    const googleBusy = [{ start: '2026-05-11T10:00:00+09:00', end: '2026-05-11T11:00:00+09:00' }]
    const slots = buildSlots('2026-05-11', 9, 11, 60, [], googleBusy)
    expect(slots[0].available).toBe(true)
    expect(slots[1].available).toBe(false)
  })

  it('休業日（スロット数0）は空配列になる', () => {
    // 休業日判定はルート層でisBusinessDayが空配列を返すため、buildSlotsは呼ばれない
    // startHour === endHour のケースで空を確認
    const slots = buildSlots('2026-05-10', 9, 9, 60, [], [])
    expect(slots).toHaveLength(0)
  })

  it('DBの営業時間設定（10-17時/30分）がスロット生成に反映される', () => {
    const slots = buildSlots('2026-05-11', 10, 17, 30, [], [])
    expect(slots).toHaveLength(14) // 7時間 × 2スロット/時間
    expect(slots[0].available).toBe(true)
  })
})
