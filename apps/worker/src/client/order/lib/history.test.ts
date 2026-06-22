import { describe, it, expect } from 'vitest'
import { USER_STATUS_LABEL, sumTotals, type MyOrder } from './history.js'

const order = (over: Partial<MyOrder>): MyOrder => ({
  id: 'o', table_number: 'A-3', status: 'new', payment_status: 'unpaid',
  total_amount: 0, placed_at: '2026-06-22T05:00:00.000Z', items: [], ...over,
})

describe('USER_STATUS_LABEL（お客様向け文言）', () => {
  it('new は「受付しました」', () => {
    expect(USER_STATUS_LABEL.new).toBe('受付しました')
  })
  it('served は「提供済み」', () => {
    expect(USER_STATUS_LABEL.served).toBe('提供済み')
  })
  it('closed は「お会計済み」', () => {
    expect(USER_STATUS_LABEL.closed).toBe('お会計済み')
  })
})

describe('sumTotals（これまでの合計）', () => {
  it('空配列は 0', () => {
    expect(sumTotals([])).toBe(0)
  })
  it('total_amount を合算する', () => {
    expect(sumTotals([order({ total_amount: 800 }), order({ total_amount: 1150 })])).toBe(1950)
  })
})
