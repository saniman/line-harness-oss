import { describe, it, expect } from 'vitest'
import {
  normalizeDbDatetime,
  formatJST,
  formatJSTWithYear,
  formatJSTTime,
  toJstDatetimeLocal,
  jstDatetimeLocalToIso,
} from '../lib/format-jst'

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

  it('秒の小数部が付いていても取りこぼさない', () => {
    // 完全一致の正規表現だと素通りして「ローカル時刻として解釈」に戻ってしまう。
    // 失敗が無音なので、桁のゆらぎは受け止める
    expect(normalizeDbDatetime('2026-09-01 01:50:08.123')).toBe('2026-09-01T01:50:08.123Z')
    expect(normalizeDbDatetime('2026-09-01T10:50:08.123')).toBe('2026-09-01T10:50:08.123+09:00')
  })

  it('秒が省略されていても取りこぼさない', () => {
    expect(normalizeDbDatetime('2026-09-01 01:50')).toBe('2026-09-01T01:50Z')
    expect(normalizeDbDatetime('2026-09-01T10:50')).toBe('2026-09-01T10:50+09:00')
  })
})

describe('時刻だけの表示（HH:mm）', () => {
  it('JST の時刻を返す', () => {
    expect(formatJSTTime(UTC_SPACE)).toBe('10:50')
    expect(formatJSTTime(ISO_Z)).toBe('10:50')
  })

  it('解釈できない値でも桁を頼りにさせない', () => {
    // 以前は formatJSTWithYear(...).slice(11) で時刻を切り出しており、
    // 不正値のとき '—'.slice(11) が空文字になって「〜」だけが残っていた
    expect(formatJSTTime('')).toBe('—')
  })
})

describe('編集フォーム（datetime-local）との往復', () => {
  it('JST の壁時計を datetime-local の値にする', () => {
    // 閲覧環境のタイムゾーンに関係なく、一覧の表示と同じ時刻を出す
    expect(toJstDatetimeLocal(ISO_Z)).toBe('2026-09-01T10:50')
  })

  it('datetime-local の値を JST として ISO に戻す', () => {
    expect(jstDatetimeLocalToIso('2026-09-01T10:50')).toBe('2026-09-01T01:50:00.000Z')
  })

  it('往復しても同じ瞬間を指す（表示だけ直して保存側を直さないとズレる）', () => {
    const original = '2026-09-10T10:00:00.000Z'
    expect(jstDatetimeLocalToIso(toJstDatetimeLocal(original))).toBe(original)
  })

  it('解釈できない値は空文字にする（フォームに Invalid を入れない）', () => {
    expect(toJstDatetimeLocal('')).toBe('')
    expect(jstDatetimeLocalToIso('')).toBe('')
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

  it('日付と時刻をスペースで区切る（一覧の桁揃えが崩れないように）', () => {
    expect(formatJSTWithYear(ISO_Z)).toMatch(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/)
  })

  it('解釈できない値は Invalid Date を画面に出さない', () => {
    expect(formatJSTWithYear('')).toBe('—')
  })
})
