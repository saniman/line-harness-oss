import { describe, it, expect } from 'vitest'
import { formatJST, formatJstDate } from './format-jst.js'

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

describe('formatJstDate', () => {
  it('UTC の日時を JST の暦日にする', () => {
    expect(formatJstDate('2026-09-06 09:00:00')).toBe('2026-09-06')
  })

  it('【重要】JST で日付が繰り上がる時刻を1日ずらさない', () => {
    // UTC 15:00 以降は JST では翌日。ここを間違えると領収日がずれた証憑になる
    expect(formatJstDate('2026-09-06 16:30:00')).toBe('2026-09-07')
    expect(formatJstDate('2026-09-06 15:00:00')).toBe('2026-09-07')
    expect(formatJstDate('2026-09-06 14:59:59')).toBe('2026-09-06')
  })

  it('月末・年末をまたいでも正しく繰り上がる', () => {
    expect(formatJstDate('2026-09-30 15:00:00')).toBe('2026-10-01')
    expect(formatJstDate('2026-12-31 15:00:00')).toBe('2027-01-01')
  })

  it('月日を2桁でゼロ埋めする', () => {
    // freee の pattern は ^[0-9]{4}-[0-9]{2}-[0-9]{2}$。1桁だと 400 になる
    expect(formatJstDate('2026-01-05 00:00:00')).toBe('2026-01-05')
  })

  it('T 区切りの JST 表記（オフセットなし）も扱える', () => {
    expect(formatJstDate('2026-09-07T01:30:00')).toBe('2026-09-07')
  })

  it('解釈できない値は null を返す（発行を止められるように）', () => {
    // '—' のような表示用の文字列を返すと、それが領収日として freee に送られてしまう
    expect(formatJstDate('')).toBe(null)
    expect(formatJstDate('not a date')).toBe(null)
  })
})
