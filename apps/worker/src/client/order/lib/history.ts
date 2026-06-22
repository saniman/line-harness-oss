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
