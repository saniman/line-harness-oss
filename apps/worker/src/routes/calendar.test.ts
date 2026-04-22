import { describe, it, expect } from 'vitest'
import { validateBookingRequest } from './calendar.js'

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
