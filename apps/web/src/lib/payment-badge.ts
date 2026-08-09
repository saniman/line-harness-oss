// イベント参加者の支払い方法バッジの表示ロジック。
// pure function に切り出して __tests__/payment-badge.test.ts でカバーする。

export type PaymentBadge = {
  label: string
  cls: string
}

/**
 * 参加者の支払い方法バッジを返す。
 *
 * event_bookings.payment_status の値と発生元:
 * - 'paid'   … Stripe 決済完了（confirmEventBooking）
 * - 'cash'   … 当日現金（LIFF の「当日現金の方はこちら」→ /join に paymentMethod: 'cash'）
 * - 'unpaid' … 無料イベント参加（確定済み）／ Stripe 決済の途中離脱（pending）
 *
 * キャンセルを最優先で判定する。返金済みキャンセルは payment_status が 'paid' のまま残るため、
 * 決済状態を先に見ると「決済済」と表示されてしまう。
 */
export function getPaymentBadge(
  booking: { status: string; payment_status: string },
): PaymentBadge {
  if (booking.status === 'cancelled') {
    return { label: '❌ キャンセル', cls: 'bg-gray-100 text-gray-500' }
  }
  if (booking.payment_status === 'paid') {
    return { label: '💳 決済済', cls: 'bg-green-100 text-green-700' }
  }
  if (booking.payment_status === 'cash') {
    // 未収（当日その場で受け取る）。決済済みと取り違えないよう緑を使わない
    return { label: '💴 当日現金', cls: 'bg-amber-100 text-amber-700' }
  }
  if (booking.payment_status === 'unpaid') {
    return booking.status === 'pending'
      ? { label: '⏳ 未決済', cls: 'bg-yellow-100 text-yellow-700' }
      : { label: '🆓 無料', cls: 'bg-blue-100 text-blue-700' }
  }
  // 想定外の値は無言で「確定」に丸めず、そのまま出して気づけるようにする
  return { label: booking.payment_status, cls: 'bg-gray-100 text-gray-700' }
}
