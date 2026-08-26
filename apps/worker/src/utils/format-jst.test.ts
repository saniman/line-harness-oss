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
})
