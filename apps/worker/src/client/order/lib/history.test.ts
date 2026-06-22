import { describe, it, expect } from 'vitest'
import { USER_STATUS_LABEL, sumTotals, checkoutButtonState, type MyOrder } from './history.js'

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

describe('checkoutButtonState（お会計ボタンの状態）', () => {
  it('summary が無い / 未会計の注文が無いときは非表示', () => {
    expect(checkoutButtonState(null)).toEqual({ visible: false, disabled: true, note: null })
    expect(checkoutButtonState({ can_checkout: false, unserved_count: 0, open_total: 0, checkout_requested: false }))
      .toEqual({ visible: false, disabled: true, note: null })
  })
  it('既に会計依頼済みなら表示するが無効＋「お願い中」案内', () => {
    const s = checkoutButtonState({ can_checkout: true, unserved_count: 0, open_total: 1200, checkout_requested: true })
    expect(s.visible).toBe(true)
    expect(s.disabled).toBe(true)
    expect(s.note).toContain('お願い中')
  })
  it('未提供が残るときは表示するが無効＋案内文', () => {
    const s = checkoutButtonState({ can_checkout: false, unserved_count: 1, open_total: 1200, checkout_requested: false })
    expect(s.visible).toBe(true)
    expect(s.disabled).toBe(true)
    expect(s.note).toContain('お作りしている')
  })
  it('全品提供済み・未依頼なら活性', () => {
    expect(checkoutButtonState({ can_checkout: true, unserved_count: 0, open_total: 1200, checkout_requested: false }))
      .toEqual({ visible: true, disabled: false, note: null })
  })
})
