// 厨房ディスプレイ（モバイルオーダー）の表示ロジック。
// pure function に切り出して __tests__/orders.test.ts でカバーする。

export type OrderStatus = 'new' | 'preparing' | 'served' | 'closed' | 'cancelled'
export type PaymentStatus = 'unpaid' | 'paid'
export type MenuGroup = 'food' | 'drink'

export type KitchenOrderItem = {
  name_snapshot: string
  options_text: string
  quantity: number
  // 'drink'（ドリンク・調理不要）/ 'food'（お食事）。厨房カードの分割表示に使う。
  menu_group: MenuGroup
}

export type KitchenOrder = {
  id: string
  table_id: string | null
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

export const STATUS_LABEL: Record<OrderStatus, string> = {
  new: '新規',
  preparing: '調理中',
  served: '提供済み',
  closed: '会計済み',
  cancelled: 'キャンセル',
}

// 各ステータスで押せる次アクション。null は操作なし。
// 「調理中」は廃止し、新規→提供済みの1ステップにした（ドリンクは調理しないため）。
// 提供後（served）は会計（テーブル一括承認）で closed になる。
export function nextAction(
  status: OrderStatus,
): { to: OrderStatus; label: string } | null {
  switch (status) {
    case 'new':
      return { to: 'served', label: '提供済みにする' }
    default:
      return null
  }
}

// active 注文をテーブル単位にまとめる（テーブル中心レイアウト用）。
// 表示順は「会計依頼が来ているテーブル → 古い注文があるテーブル」を優先。
export type TableGroup = {
  table_id: string | null
  table_number: string
  orders: KitchenOrder[]
}

export function groupOrdersByTable(orders: KitchenOrder[]): TableGroup[] {
  const map = new Map<string, TableGroup>()
  for (const o of orders) {
    const key = o.table_id ?? `num:${o.table_number}`
    const g = map.get(key) ?? { table_id: o.table_id, table_number: o.table_number, orders: [] }
    g.orders.push(o)
    map.set(key, g)
  }
  const groups = [...map.values()]
  // 各テーブル内は古い順（先に来た注文が上）。
  for (const g of groups) {
    g.orders.sort((a, b) => parsePlacedAt(a.placed_at) - parsePlacedAt(b.placed_at))
  }
  // テーブル間は「会計依頼あり」を先頭に、その次に最も古い注文が早いテーブル順。
  return groups.sort((a, b) => {
    const ar = a.orders.some((o) => o.checkout_requested_at) ? 0 : 1
    const br = b.orders.some((o) => o.checkout_requested_at) ? 0 : 1
    if (ar !== br) return ar - br
    return parsePlacedAt(a.orders[0]?.placed_at ?? '') - parsePlacedAt(b.orders[0]?.placed_at ?? '')
  })
}

// 1伝票の明細をドリンク/お食事に分割する（厨房カードの小見出し表示用）。
export function splitItemsByGroup(items: KitchenOrderItem[]): {
  drink: KitchenOrderItem[]
  food: KitchenOrderItem[]
} {
  return {
    drink: items.filter((it) => it.menu_group === 'drink'),
    food: items.filter((it) => it.menu_group !== 'drink'),
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
