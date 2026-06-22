import { describe, it, expect } from 'vitest'
import {
  canTransitionOrderStatus,
  canCheckoutTable,
  buildOrderItems,
  type OrderableMenu,
} from './orders.js'

// 商品マスタ（オプション付き）のテスト用マップ
const MENUS: Map<string, OrderableMenu> = new Map([
  ['m1', {
    id: 'm1', name: '生ビール', base_price: 600, menu_group: 'drink',
    category_label: 'ドリンク', description: null,
    options: [
      { id: 'o1', group_label: 'サイズ', choice_name: '中ジョッキ', extra_price: 0 },
      { id: 'o2', group_label: 'サイズ', choice_name: '大ジョッキ', extra_price: 200 },
    ],
  }],
  ['m2', {
    id: 'm2', name: '枝豆', base_price: 350, menu_group: 'food',
    category_label: 'フード', description: null, options: [],
  }],
])

describe('canTransitionOrderStatus（注文ステータス遷移）', () => {
  it('new から served へ直接遷移できる（調理中ステップを廃止）', () => {
    expect(canTransitionOrderStatus('new', 'served')).toBe(true)
  })
  it('served から closed へ遷移できる', () => {
    expect(canTransitionOrderStatus('served', 'closed')).toBe(true)
  })
  it('new から cancelled へ遷移できる', () => {
    expect(canTransitionOrderStatus('new', 'cancelled')).toBe(true)
  })
  it('new から preparing へは遷移しない（preparing は廃止）', () => {
    expect(canTransitionOrderStatus('new', 'preparing')).toBe(false)
  })
  it('served から cancelled へは遷移できない（提供後はキャンセル不可）', () => {
    expect(canTransitionOrderStatus('served', 'cancelled')).toBe(false)
  })
  it('closed は終端で遷移できない', () => {
    expect(canTransitionOrderStatus('closed', 'served')).toBe(false)
  })
  it('cancelled は終端で遷移できない', () => {
    expect(canTransitionOrderStatus('cancelled', 'new')).toBe(false)
  })
})

describe('canCheckoutTable（テーブル一括会計の可否）', () => {
  it('未会計の注文が全て提供済みなら会計できる', () => {
    expect(canCheckoutTable([{ status: 'served' }, { status: 'served' }])).toBe(true)
  })
  it('未提供（new/preparing）が1件でも残っていたら会計できない', () => {
    expect(canCheckoutTable([{ status: 'served' }, { status: 'preparing' }])).toBe(false)
    expect(canCheckoutTable([{ status: 'new' }])).toBe(false)
  })
  it('未会計の注文が無い（空・全て会計済み/キャンセル）なら会計できない', () => {
    expect(canCheckoutTable([])).toBe(false)
    expect(canCheckoutTable([{ status: 'closed' }])).toBe(false)
    expect(canCheckoutTable([{ status: 'cancelled' }])).toBe(false)
  })
  it('キャンセル済みは判定から除外し、残りが全て提供済みなら会計できる', () => {
    expect(canCheckoutTable([{ status: 'served' }, { status: 'cancelled' }])).toBe(true)
  })
  it('会計済みが混ざっていても、未会計分が全て提供済みなら会計できる', () => {
    expect(canCheckoutTable([{ status: 'closed' }, { status: 'served' }])).toBe(true)
  })
})

describe('buildOrderItems（注文明細のサーバー側ビルド・価格再計算）', () => {
  it('オプション無し商品の単価と合計を計算する', () => {
    const r = buildOrderItems([{ menu_id: 'm2', quantity: 2 }], MENUS)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.items[0]).toMatchObject({
      menu_id: 'm2', name_snapshot: '枝豆', unit_price: 350,
      quantity: 2, options_text: '', line_total: 700,
    })
    expect(r.total).toBe(700)
  })

  it('オプション加算を単価に反映する（大ジョッキ +200）', () => {
    const r = buildOrderItems([{ menu_id: 'm1', quantity: 1, option_ids: ['o2'] }], MENUS)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.items[0]).toMatchObject({
      unit_price: 800, options_text: '大ジョッキ', line_total: 800,
    })
    expect(r.total).toBe(800)
  })

  it('複数明細の合計を積み上げる', () => {
    const r = buildOrderItems([
      { menu_id: 'm1', quantity: 2, option_ids: ['o2'] }, // (600+200)*2 = 1600
      { menu_id: 'm2', quantity: 1 },                      // 350
    ], MENUS)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.total).toBe(1950)
  })

  it('空の注文は empty_order エラー', () => {
    const r = buildOrderItems([], MENUS)
    expect(r).toEqual({ ok: false, error: 'empty_order' })
  })

  it('存在しない menu_id は menu_not_found エラー', () => {
    const r = buildOrderItems([{ menu_id: 'zzz', quantity: 1 }], MENUS)
    expect(r).toEqual({ ok: false, error: 'menu_not_found' })
  })

  it('数量0以下は invalid_quantity エラー', () => {
    const r = buildOrderItems([{ menu_id: 'm2', quantity: 0 }], MENUS)
    expect(r).toEqual({ ok: false, error: 'invalid_quantity' })
  })

  it('過大な数量（100以上）は invalid_quantity エラー', () => {
    const r = buildOrderItems([{ menu_id: 'm2', quantity: 100 }], MENUS)
    expect(r).toEqual({ ok: false, error: 'invalid_quantity' })
  })

  it('小数の数量は invalid_quantity エラー', () => {
    const r = buildOrderItems([{ menu_id: 'm2', quantity: 1.5 }], MENUS)
    expect(r).toEqual({ ok: false, error: 'invalid_quantity' })
  })

  it('その商品に属さない option_id は invalid_option エラー', () => {
    const r = buildOrderItems([{ menu_id: 'm2', quantity: 1, option_ids: ['o1'] }], MENUS)
    expect(r).toEqual({ ok: false, error: 'invalid_option' })
  })

  it('複数オプションは group 順に options_text を連結する', () => {
    const r = buildOrderItems([{ menu_id: 'm1', quantity: 1, option_ids: ['o1', 'o2'] }], MENUS)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.items[0].options_text).toBe('中ジョッキ / 大ジョッキ')
    expect(r.items[0].unit_price).toBe(800) // 600 + 0 + 200
  })
})
