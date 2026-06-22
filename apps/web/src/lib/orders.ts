// 厨房ディスプレイ（モバイルオーダー）の表示ロジック。
// pure function に切り出して __tests__/orders.test.ts でカバーする。

export type OrderStatus = 'new' | 'preparing' | 'served' | 'closed' | 'cancelled'
export type PaymentStatus = 'unpaid' | 'paid'

export type KitchenOrderItem = {
  name_snapshot: string
  options_text: string
  quantity: number
}

export type KitchenOrder = {
  id: string
  table_number: string
  status: OrderStatus
  payment_status: PaymentStatus
  total_amount: number
  customer_note: string | null
  placed_at: string
  // お客さんが会計依頼した時刻（厨房承認まで会計完了にしない）。未依頼は null。
  checkout_requested_at: string | null
  items: KitchenOrderItem[]
}

// 本日（JST）の売上: 会計済み伝票一覧 + 合計金額・件数。
export type TodaysSales = {
  orders: KitchenOrder[]
  total: number
  count: number
}

// 厨房ディスプレイに並べるカラム（closed/cancelled は表示しない）
export const KITCHEN_COLUMNS: { status: OrderStatus; label: string }[] = [
  { status: 'new', label: '🔔 新規' },
  { status: 'preparing', label: '🔥 調理中' },
  { status: 'served', label: '✅ 提供済み' },
]

export const STATUS_LABEL: Record<OrderStatus, string> = {
  new: '新規',
  preparing: '調理中',
  served: '提供済み',
  closed: '会計済み',
  cancelled: 'キャンセル',
}

// 各ステータスで押せる次アクション。null は操作なし。
// 会計は伝票ごとではなく「テーブル一括会計」に集約したため、served の個別会計操作は持たない
// （served は提供完了済みで、あとはテーブル一括会計で closed になる）。
export function nextAction(
  status: OrderStatus,
): { to: OrderStatus; label: string } | null {
  switch (status) {
    case 'new':
      return { to: 'preparing', label: '調理開始' }
    case 'preparing':
      return { to: 'served', label: '提供完了' }
    default:
      return null
  }
}

// テーブル一括会計の可否（厨房UIの「このテーブルを会計」ボタン活性判定）。
// 未会計（closed/cancelled 以外）が1件以上あり、その全てが提供済み（served）なら true。
// サーバ側 services/orders.ts の canCheckoutTable と同じ判定。
export function canCheckoutTable(orders: { status: OrderStatus }[]): boolean {
  const open = orders.filter((o) => o.status !== 'cancelled' && o.status !== 'closed')
  if (open.length === 0) return false
  return open.every((o) => o.status === 'served')
}

// D1 の datetime('now') は "YYYY-MM-DD HH:MM:SS"（UTC・タイムゾーン無し）で入る。
// JS Date が確実に UTC として解釈できる ISO 形式に正規化する。
export function parsePlacedAt(s: string): number {
  if (!s) return NaN
  let iso = s.includes('T') ? s : s.replace(' ', 'T')
  // タイムゾーン指定が無ければ UTC とみなす
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(iso)) iso += 'Z'
  return new Date(iso).getTime()
}

// 経過時間を "m:ss" で返す（負値・不正値は "0:00"）。
export function elapsedLabel(placedAtIso: string, nowMs: number): string {
  const placed = parsePlacedAt(placedAtIso)
  if (Number.isNaN(placed)) return '0:00'
  const sec = Math.max(0, Math.floor((nowMs - placed) / 1000))
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

// 経過分に応じた緊急度。10分以上=late, 5分以上=warn。
export function urgencyLevel(placedAtIso: string, nowMs: number): 'normal' | 'warn' | 'late' {
  const placed = parsePlacedAt(placedAtIso)
  if (Number.isNaN(placed)) return 'normal'
  const min = (nowMs - placed) / 60000
  if (min >= 10) return 'late'
  if (min >= 5) return 'warn'
  return 'normal'
}
