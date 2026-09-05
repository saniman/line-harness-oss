import { describe, it, expect } from 'vitest'
import { getPaymentBadge } from '../lib/payment-badge'

describe('参加者の支払い方法バッジ', () => {
  it('Stripe決済済みの場合は「決済済」バッジになる', () => {
    const badge = getPaymentBadge({ status: 'confirmed', payment_status: 'paid' })
    expect(badge.label).toContain('決済済')
  })

  it('当日現金の場合は「当日現金」バッジになる', () => {
    const badge = getPaymentBadge({ status: 'confirmed', payment_status: 'cash' })
    expect(badge.label).toContain('当日現金')
  })

  it('無料イベント参加（unpaid かつ確定）の場合は「無料」バッジになる', () => {
    const badge = getPaymentBadge({ status: 'confirmed', payment_status: 'unpaid' })
    expect(badge.label).toContain('無料')
  })

  it('当日現金と無料イベント参加が同じ表示にならない', () => {
    const cash = getPaymentBadge({ status: 'confirmed', payment_status: 'cash' })
    const free = getPaymentBadge({ status: 'confirmed', payment_status: 'unpaid' })
    expect(cash.label).not.toBe(free.label)
  })

  it('Stripe決済の途中離脱（pending）の場合は「未決済」バッジになる', () => {
    const badge = getPaymentBadge({ status: 'pending', payment_status: 'unpaid' })
    expect(badge.label).toContain('未決済')
  })

  it('キャンセル済みの場合は決済状態より優先して「キャンセル」バッジになる', () => {
    // 返金済みキャンセルは payment_status が 'paid' のまま残るため、
    // cancelled を先に判定しないと「決済済」に見えてしまう
    const badge = getPaymentBadge({ status: 'cancelled', payment_status: 'paid' })
    expect(badge.label).toContain('キャンセル')
  })

  it('想定外の payment_status は握りつぶさず生の値を表示する', () => {
    const badge = getPaymentBadge({ status: 'confirmed', payment_status: 'partially_refunded' })
    expect(badge.label).toContain('partially_refunded')
  })

  it('各バッジは Tailwind の配色クラスを持つ', () => {
    const statuses = ['paid', 'cash', 'unpaid', 'unknown']
    for (const payment_status of statuses) {
      const badge = getPaymentBadge({ status: 'confirmed', payment_status })
      expect(badge.cls).toMatch(/bg-\w+-\d+/)
      expect(badge.cls).toMatch(/text-\w+-\d+/)
    }
  })

  it('現金（未収）と決済済みは配色が異なる', () => {
    const cash = getPaymentBadge({ status: 'confirmed', payment_status: 'cash' })
    const paid = getPaymentBadge({ status: 'confirmed', payment_status: 'paid' })
    expect(cash.cls).not.toBe(paid.cls)
  })
})

describe('現金の受領状態（#45）', () => {
  it('現金で未受領なら「未受領」と分かる表示になる', () => {
    const badge = getPaymentBadge({
      status: 'confirmed', payment_status: 'cash', cash_received_at: null,
    })
    expect(badge.label).toContain('未受領')
  })

  it('現金を受領済みなら「受領済」になる', () => {
    const badge = getPaymentBadge({
      status: 'confirmed', payment_status: 'cash', cash_received_at: '2026-09-05T18:00:00.000+09:00',
    })
    expect(badge.label).toContain('受領済')
    expect(badge.label).not.toContain('未受領')
  })

  it('未受領と受領済みが同じ表示にならない', () => {
    const yet = getPaymentBadge({ status: 'confirmed', payment_status: 'cash', cash_received_at: null })
    const done = getPaymentBadge({
      status: 'confirmed', payment_status: 'cash', cash_received_at: '2026-09-05T18:00:00.000+09:00',
    })
    expect(yet.label).not.toBe(done.label)
    expect(yet.cls).not.toBe(done.cls)
  })

  it('受領済みでも「決済済（カード）」とは区別できる', () => {
    // どちらも入金済みだが、現金かカードかは経理で区別が要る
    const cash = getPaymentBadge({
      status: 'confirmed', payment_status: 'cash', cash_received_at: '2026-09-05T18:00:00.000+09:00',
    })
    const card = getPaymentBadge({ status: 'confirmed', payment_status: 'paid' })
    expect(cash.label).not.toBe(card.label)
  })

  it('キャンセルは受領済みより優先される（返金済みを入金済みに見せない）', () => {
    const badge = getPaymentBadge({
      status: 'cancelled', payment_status: 'cash', cash_received_at: '2026-09-05T18:00:00.000+09:00',
    })
    expect(badge.label).toContain('キャンセル')
  })

  it('cash_received_at を渡さない既存の呼び出しは従来どおり動く', () => {
    // 引数を足したことで既存箇所が壊れていないことの保証
    const badge = getPaymentBadge({ status: 'confirmed', payment_status: 'cash' })
    expect(badge.label).toContain('当日現金')
  })
})
