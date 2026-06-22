// ユーザー向け注文履歴の型と表示ロジック（純粋関数）。

export type OrderStatus = 'new' | 'preparing' | 'served' | 'closed' | 'cancelled'

export interface MyOrderItem {
  name_snapshot: string
  options_text: string
  quantity: number
}

export interface MyOrder {
  id: string
  table_number: string
  status: OrderStatus
  payment_status: 'unpaid' | 'paid'
  total_amount: number
  placed_at: string
  items: MyOrderItem[]
}

// ユーザーに見せるステータス文言（厨房用とは別で、お客様目線の表現にする）。
export const USER_STATUS_LABEL: Record<OrderStatus, string> = {
  new: '受付しました',
  preparing: '調理中',
  served: '提供済み',
  closed: 'お会計済み',
  cancelled: 'キャンセル',
}

// これまでの注文合計（予算の相談用）。
export function sumTotals(orders: MyOrder[]): number {
  return orders.reduce((s, o) => s + o.total_amount, 0)
}

// テーブル一括会計の集計（サーバの /me summary）。同卓の全員分が対象。
export interface TableSummary {
  can_checkout: boolean
  unserved_count: number
  open_total: number
  // お客さんが既に会計依頼済みか（依頼後は再依頼させない）。
  checkout_requested: boolean
}

// お会計（会計依頼）ボタンの表示状態（純粋関数）。
// 会計は厨房承認制のため、押下=「会計依頼」。
// - 未会計の注文が無い（まだ頼んでいない / 既に会計済み）→ 非表示
// - 既に依頼済み → 表示するが無効＋「お願い中」案内
// - 未提供が残る → 無効＋案内
// - 全品提供済み・未依頼 → 活性
export function checkoutButtonState(summary: TableSummary | null): {
  visible: boolean
  disabled: boolean
  note: string | null
} {
  if (!summary || summary.open_total === 0) {
    return { visible: false, disabled: true, note: null }
  }
  if (summary.checkout_requested) {
    return { visible: true, disabled: true, note: 'お会計をお願い中です。スタッフが確認します。' }
  }
  if (!summary.can_checkout) {
    return { visible: true, disabled: true, note: 'まだお作りしている品があります。提供までお待ちください。' }
  }
  return { visible: true, disabled: false, note: null }
}
