// 飲食店モバイルオーダーのサービス層。
//
// 純粋関数（canTransitionOrderStatus / buildOrderItems）にビジネスロジックを集約し、
// DB ヘルパーは薄く保つ。価格はクライアント申告を信用せず、必ずサーバー側で
// menus.base_price + menu_options.extra_price から再計算する（店頭会計でも整合性のため）。

export type OrderStatus = 'new' | 'preparing' | 'served' | 'closed' | 'cancelled'
export type PaymentStatus = 'unpaid' | 'paid'

// 許可するステータス遷移。提供後（served）のキャンセルは不可。closed/cancelled は終端。
const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  new: ['preparing', 'cancelled'],
  preparing: ['served', 'cancelled'],
  served: ['closed'],
  closed: [],
  cancelled: [],
}

export function canTransitionOrderStatus(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from]?.includes(to) ?? false
}

// ----------------------------------------------------------------
// 注文明細のビルド（純粋関数）

export interface OrderableOption {
  id: string
  group_label: string
  choice_name: string
  extra_price: number
}

export interface OrderableMenu {
  id: string
  name: string
  base_price: number
  options: OrderableOption[]
}

export interface RequestedItem {
  menu_id: string
  quantity: number
  option_ids?: string[]
}

export interface BuiltOrderItem {
  menu_id: string
  name_snapshot: string
  options_text: string
  unit_price: number
  quantity: number
  line_total: number
}

export type BuildItemsResult =
  | { ok: true; items: BuiltOrderItem[]; total: number }
  | { ok: false; error: string }

const MAX_QTY = 99

// requested をサーバー側の商品マスタ（menus）と突合して明細を組み立てる。
// 価格・商品名・オプション名はすべてマスタからスナップショットする（クライアント申告は使わない）。
export function buildOrderItems(
  requested: RequestedItem[],
  menus: Map<string, OrderableMenu>,
): BuildItemsResult {
  if (!requested || requested.length === 0) {
    return { ok: false, error: 'empty_order' }
  }

  const items: BuiltOrderItem[] = []
  let total = 0

  for (const req of requested) {
    if (!Number.isInteger(req.quantity) || req.quantity < 1 || req.quantity > MAX_QTY) {
      return { ok: false, error: 'invalid_quantity' }
    }
    const menu = menus.get(req.menu_id)
    if (!menu) {
      return { ok: false, error: 'menu_not_found' }
    }

    let unitPrice = menu.base_price
    const optionNames: string[] = []
    const optionIds = req.option_ids ?? []
    // メニュー定義順にオプションを並べることで options_text の順序を安定させる。
    const chosen = new Set(optionIds)
    for (const id of optionIds) {
      if (!menu.options.some((o) => o.id === id)) {
        return { ok: false, error: 'invalid_option' }
      }
    }
    for (const opt of menu.options) {
      if (chosen.has(opt.id)) {
        unitPrice += opt.extra_price
        optionNames.push(opt.choice_name)
      }
    }

    const lineTotal = unitPrice * req.quantity
    items.push({
      menu_id: menu.id,
      name_snapshot: menu.name,
      options_text: optionNames.join(' / '),
      unit_price: unitPrice,
      quantity: req.quantity,
      line_total: lineTotal,
    })
    total += lineTotal
  }

  return { ok: true, items, total }
}

// ----------------------------------------------------------------
// DB ヘルパー（薄いラッパー。ルート統合テストでカバー）

export interface DiningTableRow {
  id: string
  table_number: string
}

// QR トークンから有効なテーブルを解決する（account スコープ）。
export async function resolveTableByToken(
  db: D1Database,
  accountId: string,
  qrToken: string,
): Promise<DiningTableRow | null> {
  const row = await db
    .prepare(
      `SELECT id, table_number FROM dining_tables
        WHERE qr_token = ? AND line_account_id = ? AND is_active = 1`,
    )
    .bind(qrToken, accountId)
    .first<DiningTableRow>()
  return row ?? null
}

// 注文用の商品マスタ（オプション込み）を取得して Map に整形する。
export async function getOrderableMenus(
  db: D1Database,
  accountId: string,
): Promise<Map<string, OrderableMenu>> {
  const menuRows = await db
    .prepare(
      `SELECT id, name, category_label, description, base_price, sort_order
         FROM menus
        WHERE line_account_id = ? AND is_active = 1 AND deleted_at IS NULL
        ORDER BY sort_order ASC, id ASC`,
    )
    .bind(accountId)
    .all<{ id: string; name: string; base_price: number }>()

  const map = new Map<string, OrderableMenu>()
  for (const m of menuRows.results) {
    map.set(m.id, { id: m.id, name: m.name, base_price: m.base_price, options: [] })
  }
  if (map.size === 0) return map

  const optRows = await db
    .prepare(
      `SELECT o.id, o.menu_id, o.group_label, o.choice_name, o.extra_price
         FROM menu_options o
         INNER JOIN menus m ON m.id = o.menu_id
        WHERE m.line_account_id = ? AND o.is_active = 1
        ORDER BY o.sort_order ASC, o.id ASC`,
    )
    .bind(accountId)
    .all<{ id: string; menu_id: string; group_label: string; choice_name: string; extra_price: number }>()
  for (const o of optRows.results) {
    const menu = map.get(o.menu_id)
    if (menu) {
      menu.options.push({
        id: o.id,
        group_label: o.group_label,
        choice_name: o.choice_name,
        extra_price: o.extra_price,
      })
    }
  }
  return map
}

export interface CreateOrderInput {
  accountId: string
  tableId: string
  tableNumber: string
  friendId: string
  items: BuiltOrderItem[]
  total: number
  customerNote: string | null
}

// 注文ヘッダ + 明細を 1 バッチで原子的に INSERT する。
export async function insertOrder(db: D1Database, input: CreateOrderInput): Promise<string> {
  const orderId = crypto.randomUUID()
  const stmts: D1PreparedStatement[] = []
  stmts.push(
    db
      .prepare(
        `INSERT INTO orders
          (id, line_account_id, table_id, table_number, friend_id, status,
           payment_status, total_amount, customer_note)
         VALUES (?,?,?,?,?, 'new', 'unpaid', ?, ?)`,
      )
      .bind(
        orderId,
        input.accountId,
        input.tableId,
        input.tableNumber,
        input.friendId,
        input.total,
        input.customerNote,
      ),
  )
  for (const it of input.items) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO order_items
            (id, order_id, menu_id, name_snapshot, options_text, unit_price, quantity, line_total)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .bind(
          crypto.randomUUID(),
          orderId,
          it.menu_id,
          it.name_snapshot,
          it.options_text,
          it.unit_price,
          it.quantity,
          it.line_total,
        ),
    )
  }
  await db.batch(stmts)
  return orderId
}

export interface KitchenOrder {
  id: string
  table_number: string
  status: OrderStatus
  payment_status: PaymentStatus
  total_amount: number
  customer_note: string | null
  placed_at: string
  items: Array<{ name_snapshot: string; options_text: string; quantity: number }>
}

// 厨房ディスプレイ向けに、指定ステータスの注文を明細込みで取得する。
export async function listKitchenOrders(
  db: D1Database,
  accountId: string,
  statuses: OrderStatus[],
): Promise<KitchenOrder[]> {
  const placeholders = statuses.map(() => '?').join(',')
  const orderRows = await db
    .prepare(
      `SELECT id, table_number, status, payment_status, total_amount, customer_note, placed_at
         FROM orders
        WHERE line_account_id = ? AND status IN (${placeholders})
        ORDER BY placed_at ASC`,
    )
    .bind(accountId, ...statuses)
    .all<Omit<KitchenOrder, 'items'>>()

  const orders = orderRows.results as Array<Omit<KitchenOrder, 'items'>>
  if (orders.length === 0) return []

  const ids = orders.map((o) => o.id)
  const itemRows = await db
    .prepare(
      `SELECT order_id, name_snapshot, options_text, quantity
         FROM order_items
        WHERE order_id IN (${ids.map(() => '?').join(',')})
        ORDER BY created_at ASC`,
    )
    .bind(...ids)
    .all<{ order_id: string; name_snapshot: string; options_text: string; quantity: number }>()

  const byOrder = new Map<string, KitchenOrder['items']>()
  for (const it of itemRows.results) {
    const arr = byOrder.get(it.order_id) ?? []
    arr.push({ name_snapshot: it.name_snapshot, options_text: it.options_text, quantity: it.quantity })
    byOrder.set(it.order_id, arr)
  }

  return orders.map((o) => ({ ...o, items: byOrder.get(o.id) ?? [] }))
}

export interface OrderStatusRow {
  status: OrderStatus
  line_account_id: string
}

export async function getOrderStatus(
  db: D1Database,
  orderId: string,
): Promise<OrderStatusRow | null> {
  const row = await db
    .prepare(`SELECT status, line_account_id FROM orders WHERE id = ?`)
    .bind(orderId)
    .first<OrderStatusRow>()
  return row ?? null
}

// ステータス更新。served → closed への遷移時に支払い済みもまとめて記録する。
export async function updateOrderStatus(
  db: D1Database,
  orderId: string,
  to: OrderStatus,
  markPaid: boolean,
): Promise<void> {
  if (markPaid) {
    await db
      .prepare(
        `UPDATE orders
            SET status = ?, payment_status = 'paid',
                paid_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ?`,
      )
      .bind(to, orderId)
      .run()
  } else {
    await db
      .prepare(`UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(to, orderId)
      .run()
  }
}
