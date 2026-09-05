import { describe, it, expect } from 'vitest'
import { formatJST } from './format-jst.js'

describe('formatJST', () => {
  it('UTC の ISO 文字列を JST の 月/日(曜) 時:分 に変換する', () => {
    expect(formatJST('2026-06-13T05:00:00.000Z')).toBe('06/13(土) 14:00')
  })

  it('JST に直すと翌日になる時刻の場合は日付も繰り上がる', () => {
    expect(formatJST('2026-06-13T15:30:00.000Z')).toBe('06/14(日) 00:30')
  })

  it('+09:00 オフセット付きの文字列でも同じ結果になる', () => {
    expect(formatJST('2026-06-13T14:00:00+09:00')).toBe('06/13(土) 14:00')
  })

  it("datetime('now') 形式（UTC・スペース区切り）も正しく解釈する", () => {
    // events / event_bookings の created_at はこの形式。素の new Date() では
    // ローカル時刻として解釈され、+9 時間の補正が打ち消される（Issue #58）
    expect(formatJST('2026-06-13 05:00:00')).toBe('06/13(土) 14:00')
  })

  it('オフセットの無い ISO（JST 保存）も正しく解釈する', () => {
    // tags / staff_members などの strftime(… '+9 hours') 形式
    expect(formatJST('2026-06-13T14:00:00.000')).toBe('06/13(土) 14:00')
  })

  it('秒の小数部が付いていても取りこぼさない', () => {
    // web 側（apps/web/src/lib/format-jst.ts）と同じ仕様にすること。
    // 完全一致に絞ると素通りして「ローカル時刻として解釈」に戻り、
    // JST 環境では通って UTC の CI で落ちるテストになる
    expect(formatJST('2026-06-13 05:00:00.123')).toBe('06/13(土) 14:00')
    expect(formatJST('2026-06-13T14:00:00.123')).toBe('06/13(土) 14:00')
  })

  it('秒が省略されていても取りこぼさない', () => {
    expect(formatJST('2026-06-13 05:00')).toBe('06/13(土) 14:00')
    expect(formatJST('2026-06-13T14:00')).toBe('06/13(土) 14:00')
  })

  it('解釈できない値は Invalid Date を出さない', () => {
    expect(formatJST('')).toBe('—')
    expect(formatJST('not a date')).toBe('—')
  })
})
