import { describe, it, expect } from 'vitest'
import { APPLICATION_DEADLINE_MINUTES, isApplicationClosed } from './event-deadline.js'

// start_at は UTC の ISO 8601 で保存されている。ここでは JST 変換をせず epoch 同士で比較する
// （表示のときだけ formatJST を通す。ここで JST を挟むと二重変換のバグになる）。
const START_AT = '2026-09-01T10:00:00+09:00'
const START_MS = Date.parse(START_AT)
const DEADLINE_MS = START_MS - APPLICATION_DEADLINE_MINUTES * 60 * 1000
const MINUTE = 60 * 1000

describe('isApplicationClosed', () => {
  it('締切は開始の60分前', () => {
    expect(APPLICATION_DEADLINE_MINUTES).toBe(60)
  })

  it('締切より前（開始61分前）は申込可', () => {
    expect(isApplicationClosed(START_AT, DEADLINE_MS - MINUTE)).toBe(false)
  })

  it('締切1分前は申込可（境界値）', () => {
    expect(isApplicationClosed(START_AT, DEADLINE_MS - MINUTE)).toBe(false)
  })

  it('締切ちょうどは申込不可（境界値）', () => {
    expect(isApplicationClosed(START_AT, DEADLINE_MS)).toBe(true)
  })

  it('締切1分後は申込不可（境界値）', () => {
    expect(isApplicationClosed(START_AT, DEADLINE_MS + MINUTE)).toBe(true)
  })

  it('開始時刻を過ぎていれば申込不可', () => {
    expect(isApplicationClosed(START_AT, START_MS + 60 * MINUTE)).toBe(true)
  })

  it('タイムゾーン表記が違っても同じ瞬間なら同じ判定になる（JST二重変換をしない）', () => {
    const sameInstantUtc = '2026-09-01T01:00:00.000Z' // = 2026-09-01T10:00+09:00
    expect(isApplicationClosed(sameInstantUtc, DEADLINE_MS - MINUTE)).toBe(false)
    expect(isApplicationClosed(sameInstantUtc, DEADLINE_MS)).toBe(true)
  })

  it('日時が壊れている場合は締切扱いにしない（全申込を止めない）', () => {
    expect(isApplicationClosed('not-a-date', DEADLINE_MS + MINUTE)).toBe(false)
  })
})
