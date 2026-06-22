import { describe, it, expect } from 'vitest'
import {
  STATUS_LABEL,
  nextAction,
  canCheckoutTable,
  parsePlacedAt,
  elapsedLabel,
  urgencyLevel,
} from '../lib/orders'

describe('ステータスラベル', () => {
  it('new は「新規」', () => {
    expect(STATUS_LABEL.new).toBe('新規')
  })
  it('served は「提供済み」', () => {
    expect(STATUS_LABEL.served).toBe('提供済み')
  })
})

describe('nextAction（次に押せる操作）', () => {
  it('new → 調理開始（preparing へ）', () => {
    expect(nextAction('new')).toEqual({ to: 'preparing', label: '調理開始' })
  })
  it('preparing → 提供完了（served へ）', () => {
    expect(nextAction('preparing')).toEqual({ to: 'served', label: '提供完了' })
  })
  it('served は操作なし（会計はテーブル一括会計に集約）', () => {
    expect(nextAction('served')).toBeNull()
  })
  it('closed は操作なし（null）', () => {
    expect(nextAction('closed')).toBeNull()
  })
  it('cancelled は操作なし（null）', () => {
    expect(nextAction('cancelled')).toBeNull()
  })
})

describe('canCheckoutTable（テーブル一括会計の可否）', () => {
  it('未会計が全て提供済みなら会計できる', () => {
    expect(canCheckoutTable([{ status: 'served' }, { status: 'served' }])).toBe(true)
  })
  it('未提供が残れば会計できない', () => {
    expect(canCheckoutTable([{ status: 'served' }, { status: 'preparing' }])).toBe(false)
  })
  it('未会計が無い（空・全て会計済み）なら会計できない', () => {
    expect(canCheckoutTable([])).toBe(false)
    expect(canCheckoutTable([{ status: 'closed' }])).toBe(false)
  })
  it('キャンセルは除外して判定する', () => {
    expect(canCheckoutTable([{ status: 'served' }, { status: 'cancelled' }])).toBe(true)
  })
})

describe('parsePlacedAt（D1 datetime を UTC として解釈）', () => {
  it('スペース区切りの datetime を UTC ミリ秒に変換する', () => {
    const ms = parsePlacedAt('2026-06-22 12:00:00')
    expect(ms).toBe(Date.UTC(2026, 5, 22, 12, 0, 0))
  })
  it('既に ISO(Z付き) の場合もそのまま解釈する', () => {
    const ms = parsePlacedAt('2026-06-22T12:00:00.000Z')
    expect(ms).toBe(Date.UTC(2026, 5, 22, 12, 0, 0))
  })
  it('空文字は NaN', () => {
    expect(Number.isNaN(parsePlacedAt(''))).toBe(true)
  })
})

describe('elapsedLabel（経過時間 m:ss）', () => {
  const base = Date.UTC(2026, 5, 22, 12, 0, 0)
  it('3分5秒経過を 3:05 と表示する', () => {
    expect(elapsedLabel('2026-06-22 12:00:00', base + (3 * 60 + 5) * 1000)).toBe('3:05')
  })
  it('秒は2桁ゼロ埋めする', () => {
    expect(elapsedLabel('2026-06-22 12:00:00', base + 9 * 1000)).toBe('0:09')
  })
  it('未来（負の経過）は 0:00', () => {
    expect(elapsedLabel('2026-06-22 12:00:00', base - 5000)).toBe('0:00')
  })
})

describe('urgencyLevel（緊急度）', () => {
  const base = Date.UTC(2026, 5, 22, 12, 0, 0)
  it('5分未満は normal', () => {
    expect(urgencyLevel('2026-06-22 12:00:00', base + 4 * 60000)).toBe('normal')
  })
  it('5分以上は warn', () => {
    expect(urgencyLevel('2026-06-22 12:00:00', base + 6 * 60000)).toBe('warn')
  })
  it('10分以上は late', () => {
    expect(urgencyLevel('2026-06-22 12:00:00', base + 11 * 60000)).toBe('late')
  })
})
