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
