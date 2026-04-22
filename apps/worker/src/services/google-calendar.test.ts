import { describe, it, expect } from 'vitest'
import { isTokenExpiringSoon, isSlotOverlapping, generateSlots } from './google-calendar.js'

describe('スロット生成', () => {
  it('10:00〜18:00で8枠生成される', () => {
    const slots = generateSlots('2025-05-01', 10, 18, 60)
    expect(slots).toHaveLength(8)
  })

  it('9:00〜18:00で9枠生成される', () => {
    const slots = generateSlots('2025-05-01', 9, 18, 60)
    expect(slots).toHaveLength(9)
  })

  it('各スロットの開始・終了が60分ずつになっている', () => {
    const slots = generateSlots('2025-05-01', 10, 12, 60)
    expect(slots).toHaveLength(2)
    const diff0 = slots[0].endAt.getTime() - slots[0].startAt.getTime()
    const diff1 = slots[1].endAt.getTime() - slots[1].startAt.getTime()
    expect(diff0).toBe(60 * 60 * 1000)
    expect(diff1).toBe(60 * 60 * 1000)
  })

  it('連続するスロットの終了時刻と次の開始時刻が一致する', () => {
    const slots = generateSlots('2025-05-01', 10, 13, 60)
    expect(slots[0].endAt.getTime()).toBe(slots[1].startAt.getTime())
    expect(slots[1].endAt.getTime()).toBe(slots[2].startAt.getTime())
  })
})

describe('FreeBusy の重複チェック', () => {
  it('スロットと予定が完全に重なっていればtrue', () => {
    // slot: 10:00〜11:00, busy: 10:00〜11:00
    const slot = { start: new Date('2025-05-01T10:00:00+09:00'), end: new Date('2025-05-01T11:00:00+09:00') }
    const busy = { start: new Date('2025-05-01T10:00:00+09:00'), end: new Date('2025-05-01T11:00:00+09:00') }
    expect(isSlotOverlapping(slot.start.getTime(), slot.end.getTime(), busy.start.getTime(), busy.end.getTime())).toBe(true)
  })

  it('予定がスロット内に収まっていればtrue', () => {
    // slot: 10:00〜11:00, busy: 10:15〜10:45
    const slot = { start: new Date('2025-05-01T10:00:00+09:00'), end: new Date('2025-05-01T11:00:00+09:00') }
    const busy = { start: new Date('2025-05-01T10:15:00+09:00'), end: new Date('2025-05-01T10:45:00+09:00') }
    expect(isSlotOverlapping(slot.start.getTime(), slot.end.getTime(), busy.start.getTime(), busy.end.getTime())).toBe(true)
  })

  it('予定がスロットの直後ならfalse（境界は重複しない）', () => {
    // slot: 10:00〜11:00, busy: 11:00〜12:00
    const slot = { start: new Date('2025-05-01T10:00:00+09:00'), end: new Date('2025-05-01T11:00:00+09:00') }
    const busy = { start: new Date('2025-05-01T11:00:00+09:00'), end: new Date('2025-05-01T12:00:00+09:00') }
    expect(isSlotOverlapping(slot.start.getTime(), slot.end.getTime(), busy.start.getTime(), busy.end.getTime())).toBe(false)
  })

  it('予定がスロットの直前ならfalse（境界は重複しない）', () => {
    // slot: 11:00〜12:00, busy: 10:00〜11:00
    const slot = { start: new Date('2025-05-01T11:00:00+09:00'), end: new Date('2025-05-01T12:00:00+09:00') }
    const busy = { start: new Date('2025-05-01T10:00:00+09:00'), end: new Date('2025-05-01T11:00:00+09:00') }
    expect(isSlotOverlapping(slot.start.getTime(), slot.end.getTime(), busy.start.getTime(), busy.end.getTime())).toBe(false)
  })

  it('予定がスロットと無関係ならfalse', () => {
    // slot: 10:00〜11:00, busy: 14:00〜15:00
    const slot = { start: new Date('2025-05-01T10:00:00+09:00'), end: new Date('2025-05-01T11:00:00+09:00') }
    const busy = { start: new Date('2025-05-01T14:00:00+09:00'), end: new Date('2025-05-01T15:00:00+09:00') }
    expect(isSlotOverlapping(slot.start.getTime(), slot.end.getTime(), busy.start.getTime(), busy.end.getTime())).toBe(false)
  })
})

describe('token_expires_at の期限切れ判定', () => {
  it('expiresAt が null ならリフレッシュ対象', () => {
    expect(isTokenExpiringSoon(null)).toBe(true)
  })

  it('トークンが5分以内に期限切れならリフレッシュ対象', () => {
    const soonExpiry = new Date(Date.now() + 4 * 60 * 1000) // 4分後
    expect(isTokenExpiringSoon(soonExpiry)).toBe(true)
  })

  it('トークンがちょうど5分後に切れる場合はリフレッシュ対象（境界値）', () => {
    const boundary = new Date(Date.now() + 5 * 60 * 1000 - 1) // 5分-1ms後
    expect(isTokenExpiringSoon(boundary)).toBe(true)
  })

  it('トークンが十分残っていればリフレッシュ不要', () => {
    const futureExpiry = new Date(Date.now() + 60 * 60 * 1000) // 1時間後
    expect(isTokenExpiringSoon(futureExpiry)).toBe(false)
  })

  it('トークンが5分超残っている場合はリフレッシュ不要', () => {
    const justOver = new Date(Date.now() + 5 * 60 * 1000 + 1000) // 5分+1秒後
    expect(isTokenExpiringSoon(justOver)).toBe(false)
  })

  it('トークンが既に期限切れならリフレッシュ対象', () => {
    const expired = new Date(Date.now() - 1000) // 1秒前
    expect(isTokenExpiringSoon(expired)).toBe(true)
  })
})
