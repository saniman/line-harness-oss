import { describe, it, expect } from 'vitest'
import { getRefundNotice } from '../lib/refund-badge'
import { getPaymentBadge } from '../lib/payment-badge'

describe('getRefundNotice（現金を受け取ったままキャンセルされた予約）', () => {
  it('【重要】受領済みキャンセルに金額つきで出す', () => {
    // 運営者が「いくら返すか」を画面で確認できないと、返金額が分からない
    const notice = getRefundNotice({
      status: 'cancelled',
      cash_received_at: '2026-09-06 05:00:00',
      amount: 100,
    })

    expect(notice?.label).toBe('⚠️ 要返金 ¥100')
  })

  it('金額を3桁区切りで出す', () => {
    const notice = getRefundNotice({
      status: 'cancelled',
      cash_received_at: '2026-09-06 05:00:00',
      amount: 12000,
    })

    expect(notice?.label).toContain('¥12,000')
  })

  it('金額が分からなくても注意だけは出す', () => {
    // 金額が無いから黙る、では受領の事実が消えたままになる
    const notice = getRefundNotice({
      status: 'cancelled',
      cash_received_at: '2026-09-06 05:00:00',
      amount: null,
    })

    expect(notice?.label).toBe('⚠️ 要返金')
  })

  it('未受領のキャンセルには出さない', () => {
    expect(getRefundNotice({
      status: 'cancelled',
      cash_received_at: null,
      amount: 100,
    })).toBe(null)
  })

  it('キャンセルしていなければ出さない', () => {
    expect(getRefundNotice({
      status: 'confirmed',
      cash_received_at: '2026-09-06 05:00:00',
      amount: 100,
    })).toBe(null)
  })

  it('Stripe 決済のキャンセルには出さない（返金は自動で走る）', () => {
    expect(getRefundNotice({
      status: 'cancelled',
      cash_received_at: null,
      amount: 3000,
    })).toBe(null)
  })
})

describe('getPaymentBadge との併用（Issue #14 の再発防止）', () => {
  const cancelledCash = {
    status: 'cancelled',
    payment_status: 'cash',
    cash_received_at: '2026-09-06 05:00:00',
    amount: 100,
  }

  it('【重要】バッジは「キャンセル」のまま（決済済に見せない）', () => {
    // ここを変えると「返金済みキャンセルが決済済に見える」Issue #14 が再発する
    expect(getPaymentBadge(cancelledCash).label).toBe('❌ キャンセル')
  })

  it('受領の事実は別の印で残る（画面から消えない）', () => {
    // #65 の目的。バッジだけだと「受け取った」情報がどこにも出ない
    expect(getRefundNotice(cancelledCash)).not.toBe(null)
  })

  it('【重要】返金済みの Stripe キャンセルが決済済に見えない', () => {
    // 返金しても payment_status は 'paid' のまま残る
    const refunded = {
      status: 'cancelled',
      payment_status: 'paid',
      cash_received_at: null,
      amount: 3000,
    }

    expect(getPaymentBadge(refunded).label).toBe('❌ キャンセル')
    expect(getRefundNotice(refunded)).toBe(null)
  })
})
