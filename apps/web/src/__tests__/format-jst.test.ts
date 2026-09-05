import { describe, it, expect } from 'vitest'
import { normalizeDbDatetime, formatJST, formatJSTWithYear } from '../lib/format-jst'

// D1 に入っている実際の形式。schema.sql に 2 系統が混在している（Issue #58）
const UTC_SPACE = '2026-09-01 01:50:08'        // datetime('now') … UTC・スペース区切り
const JST_NO_OFFSET = '2026-09-01T10:50:08.000' // strftime(… '+9 hours') … JST・オフセット表記なし
const ISO_Z = '2026-09-01T01:50:08.000Z'        // toISOString() … UTC・Z 付き
const ISO_OFFSET = '2026-09-01T10:50:08+09:00'  // オフセット付き

// 上の 4 つはすべて「JST 2026-09-01 10:50」という同じ瞬間を指す

describe('DB 日時の正規化', () => {
  it('スペース区切り（datetime）を UTC として解釈する', () => {
    expect(normalizeDbDatetime(UTC_SPACE)).toBe('2026-09-01T01:50:08Z')
  })

  it('オフセットの無い ISO（strftime の JST 保存）を JST として解釈する', () => {
    expect(normalizeDbDatetime(JST_NO_OFFSET)).toBe('2026-09-01T10:50:08.000+09:00')
  })

  it('Z 付き・オフセット付きはそのまま通す', () => {
    expect(normalizeDbDatetime(ISO_Z)).toBe(ISO_Z)
    expect(normalizeDbDatetime(ISO_OFFSET)).toBe(ISO_OFFSET)
  })

  it('想定外の文字列はそのまま返す（勝手に補正しない）', () => {
    expect(normalizeDbDatetime('not a date')).toBe('not a date')
    expect(normalizeDbDatetime('')).toBe('')
  })
})

describe('参加者一覧などの日時表示（MM/DD(曜) HH:mm）', () => {
  it('datetime 形式の保存値を正しい JST で表示する', () => {
    // 修正前は「09/01(火) 01:50」＝ UTC の数字をそのまま JST として出していた
    expect(formatJST(UTC_SPACE)).toBe('09/01(火) 10:50')
  })

  it('同じ瞬間を指す 4 つの形式がすべて同じ表示になる', () => {
    const expected = '09/01(火) 10:50'
    expect(formatJST(UTC_SPACE)).toBe(expected)
    expect(formatJST(JST_NO_OFFSET)).toBe(expected)
    expect(formatJST(ISO_Z)).toBe(expected)
    expect(formatJST(ISO_OFFSET)).toBe(expected)
  })

  it('日付をまたぐ時刻でも正しく繰り上がる', () => {
    // UTC 2026-09-01 15:30 = JST 2026-09-02 00:30
    expect(formatJST('2026-09-01 15:30:00')).toBe('09/02(水) 00:30')
  })

  it('解釈できない値は Invalid Date を画面に出さない', () => {
    expect(formatJST('')).toBe('—')
    expect(formatJST('not a date')).toBe('—')
  })
})

describe('予約一覧などの日時表示（YYYY/MM/DD HH:mm）', () => {
  it('datetime 形式の保存値を正しい JST で表示する', () => {
    expect(formatJSTWithYear(UTC_SPACE)).toBe('2026/09/01 10:50')
  })

  it('11 文字目以降が時刻になる（reservations が slice(11) で切り出している）', () => {
    // apps/web/src/app/reservations/page.tsx が formatJST(...).slice(11) で
    // 終了時刻だけを表示している。桁を変えるとその表示が壊れる
    expect(formatJSTWithYear(ISO_Z).slice(11)).toBe('10:50')
  })

  it('解釈できない値は Invalid Date を画面に出さない', () => {
    expect(formatJSTWithYear('')).toBe('—')
  })
})
