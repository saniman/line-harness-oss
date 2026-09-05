// 現金を受け取ったあとにキャンセルされた予約の「要返金」表示（Issue #65）。
//
// ## なぜ getPaymentBadge を直さないのか
//
// `getPaymentBadge` はキャンセルを最優先で返す。これは
// **返金済みキャンセルが「💳 決済済」に見える**という Issue #14 の不具合を直したときの判断で、
// ここを崩すと同じ問題が再発する。
//
// だからバッジ自体には触らず、**別の印を併記**する。
//
//     ❌ キャンセル  ⚠️ 要返金 ¥100
//
// 「キャンセルされた」という事実と「まだ現金を返していないかもしれない」という
// 運営者へのお願いは別の情報なので、別々に出すほうが素直でもある。

export type RefundNotice = {
  label: string
  cls: string
}

/**
 * 現金を受け取ったままキャンセルされた予約に出す印を返す。
 *
 * ⚠️ 「返金済みか」は追跡していない（#65 のスコープ外）。ここが出しているのは
 *    「**現金を受け取った記録があるのにキャンセルされている**」という事実だけ。
 *    運営者が現金を返したかどうかは、この印では分からない。
 *
 * @returns 出す必要が無ければ null
 */
export function getRefundNotice(
  booking: {
    status: string
    cash_received_at?: string | null
    amount?: number | null
  },
): RefundNotice | null {
  if (booking.status !== 'cancelled') return null
  // 受け取っていないならそもそも返すものが無い
  if (!booking.cash_received_at) return null

  // 金額は受領時に events.price から焼き込まれる（markCashReceived）。
  // それでも無いときは「いくら返すか」を出せないので、金額なしで注意だけ出す
  const amount = typeof booking.amount === 'number' && booking.amount > 0
    ? `¥${booking.amount.toLocaleString()}`
    : ''

  return {
    label: amount ? `⚠️ 要返金 ${amount}` : '⚠️ 要返金',
    cls: 'bg-red-100 text-red-700',
  }
}
