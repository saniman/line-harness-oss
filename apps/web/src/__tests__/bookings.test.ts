import { describe, it, expect } from 'vitest'
import { formatJST, getBookingName, STATUS_LABEL, STATUS_CLASS } from '../lib/bookings'

describe('ステータスバッジ', () => {
  it('confirmedは緑色で「確定」と表示される', () => {
    expect(STATUS_LABEL.confirmed).toBe('確定')
    expect(STATUS_CLASS.confirmed).toContain('green')
  })

  it('cancelledはグレーで「キャンセル」と表示される', () => {
    expect(STATUS_LABEL.cancelled).toBe('キャンセル')
    expect(STATUS_CLASS.cancelled).toContain('gray')
  })
})

describe('日時フォーマット', () => {
  it('ISO日時がJST表示に変換される', () => {
    const formatted = formatJST('2026-04-25T10:00:00+09:00')
    expect(formatted).toBe('2026/04/25 10:00')
  })

  it('UTC時刻がJSTに変換される（+9時間）', () => {
    const formatted = formatJST('2026-04-25T01:00:00Z')
    expect(formatted).toBe('2026/04/25 10:00')
  })
})

describe('予約者名の表示', () => {
  it('metadataのnameを優先表示する', () => {
    const result = getBookingName({ metadata: { name: 'テスト太郎' }, displayName: 'LINE名' })
    expect(result).toBe('テスト太郎')
  })

  it('nameがない場合はdisplayNameを表示する', () => {
    const result = getBookingName({ metadata: {}, displayName: 'LINE名' })
    expect(result).toBe('LINE名')
  })

  it('両方ない場合は「不明」と表示する', () => {
    const result = getBookingName({ metadata: null, displayName: null })
    expect(result).toBe('不明')
  })
})
