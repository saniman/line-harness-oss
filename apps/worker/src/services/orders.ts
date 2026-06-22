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

// テーブル一括会計の可否（純粋関数）。
// 「未会計（closed/cancelled 以外）」の注文が 1 件以上あり、その全てが提供済み（served）の
// ときだけ会計できる。未提供（new/preparing）が残るうちは厨房が作りかけを見失うため不可。
export function canCheckoutTable(orders: Array<{ status: OrderStatus }>): boolean {
  const open = orders.filter((o) => o.status !== 'cancelled' && o.status !== 'closed')
  if (open.length === 0) return false
  return open.every((o) => o.status === 'served')
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
          AND menu_type = 'food'
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
  // お客さんが会計依頼した時刻（厨房承認まで会計完了にしない）。未依頼は null。
  checkout_requested_at: string | null
  items: Array<{ name_snapshot: string; options_text: string; quantity: number }>
}

// 厨房ディスプレイ向けに、指定ステータスの注文を明細込みで取得する。
// 注文ヘッダ配列に order_items をまとめて 1 クエリで付与する（N+1 回避）。
async function hydrateItems(
  db: D1Database,
  orders: Array<Omit<KitchenOrder, 'items'>>,
): Promise<KitchenOrder[]> {
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

const ORDER_HEADER_COLS =
  'id, table_number, status, payment_status, total_amount, customer_note, placed_at, checkout_requested_at'

export async function listKitchenOrders(
  db: D1Database,
  accountId: string,
  statuses: OrderStatus[],
): Promise<KitchenOrder[]> {
  const placeholders = statuses.map(() => '?').join(',')
  const orderRows = await db
    .prepare(
      `SELECT ${ORDER_HEADER_COLS}
         FROM orders
        WHERE line_account_id = ? AND status IN (${placeholders})
        ORDER BY placed_at ASC`,
    )
    .bind(accountId, ...statuses)
    .all<Omit<KitchenOrder, 'items'>>()
  return hydrateItems(db, orderRows.results as Array<Omit<KitchenOrder, 'items'>>)
}

// 厨房の「伝票確認」用: 1テーブルの注文（キャンセル除く）を新しい順に。
export async function listOrdersByTable(
  db: D1Database,
  accountId: string,
  tableId: string,
): Promise<KitchenOrder[]> {
  const orderRows = await db
    .prepare(
      `SELECT ${ORDER_HEADER_COLS}
         FROM orders
        WHERE line_account_id = ? AND table_id = ? AND status <> 'cancelled'
        ORDER BY placed_at DESC`,
    )
    .bind(accountId, tableId)
    .all<Omit<KitchenOrder, 'items'>>()
  return hydrateItems(db, orderRows.results as Array<Omit<KitchenOrder, 'items'>>)
}

// ユーザーの注文履歴用: caller(friend) の注文を新しい順に。tableId 指定時はその卓に限定。
export async function listOrdersForFriend(
  db: D1Database,
  accountId: string,
  friendId: string,
  tableId: string | null,
): Promise<KitchenOrder[]> {
  const binds: unknown[] = [accountId, friendId]
  let where = `line_account_id = ? AND friend_id = ? AND status <> 'cancelled'`
  if (tableId) {
    where += ` AND table_id = ?`
    binds.push(tableId)
  }
  const orderRows = await db
    .prepare(`SELECT ${ORDER_HEADER_COLS} FROM orders WHERE ${where} ORDER BY placed_at DESC`)
    .bind(...binds)
    .all<Omit<KitchenOrder, 'items'>>()
  return hydrateItems(db, orderRows.results as Array<Omit<KitchenOrder, 'items'>>)
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

// ----------------------------------------------------------------
// テーブル一括会計 / 本日の売上

interface OpenOrderRow {
  status: OrderStatus
  total_amount: number
  checkout_requested_at: string | null
}

// テーブルの未会計（closed/cancelled 以外）注文を取得する。会計可否判定・集計に使う。
async function getOpenTableOrderRows(
  db: D1Database,
  accountId: string,
  tableId: string,
): Promise<OpenOrderRow[]> {
  const rows = await db
    .prepare(
      `SELECT status, total_amount, checkout_requested_at
         FROM orders
        WHERE line_account_id = ? AND table_id = ?
          AND status NOT IN ('closed','cancelled')`,
    )
    .bind(accountId, tableId)
    .all<OpenOrderRow>()
  return rows.results
}

export interface TableCheckoutSummary {
  can_checkout: boolean
  unserved_count: number
  open_total: number
  // お客さんが既に会計依頼済みか（依頼後は LIFF の依頼ボタンを無効化する）。
  checkout_requested: boolean
}

// LIFF / 厨房の会計ボタン活性判定用のテーブル集計（同卓の全注文が対象）。
export async function getTableCheckoutSummary(
  db: D1Database,
  accountId: string,
  tableId: string,
): Promise<TableCheckoutSummary> {
  const open = await getOpenTableOrderRows(db, accountId, tableId)
  const unserved = open.filter((o) => o.status === 'new' || o.status === 'preparing')
  return {
    can_checkout: canCheckoutTable(open),
    unserved_count: unserved.length,
    open_total: open.reduce((s, o) => s + o.total_amount, 0),
    checkout_requested: open.some((o) => o.checkout_requested_at != null),
  }
}

export type RequestCheckoutResult =
  | { ok: true; requested_count: number; requested_total: number }
  | { ok: false; error: 'nothing_to_settle' | 'not_all_served' }

// お客さん(LIFF)からの会計依頼。提供済みの注文に依頼フラグ（checkout_requested_at）を立てるだけで
// 会計完了にはしない。厨房承認まで status は 'served' のまま。未提供が残る場合は依頼を受け付けない。
export async function requestTableCheckout(
  db: D1Database,
  accountId: string,
  tableId: string,
): Promise<RequestCheckoutResult> {
  const open = await getOpenTableOrderRows(db, accountId, tableId)
  if (open.length === 0) return { ok: false, error: 'nothing_to_settle' }
  if (!canCheckoutTable(open)) return { ok: false, error: 'not_all_served' }

  const served = open.filter((o) => o.status === 'served')
  const requestedTotal = served.reduce((s, o) => s + o.total_amount, 0)
  const res = await db
    .prepare(
      `UPDATE orders
          SET checkout_requested_at = datetime('now'), updated_at = datetime('now')
        WHERE line_account_id = ? AND table_id = ? AND status = 'served'`,
    )
    .bind(accountId, tableId)
    .run()
  return { ok: true, requested_count: res.meta.changes ?? served.length, requested_total: requestedTotal }
}

export type ApproveCheckoutResult =
  | { ok: true; settled_count: number; settled_total: number }
  | { ok: false; error: 'nothing_to_settle' | 'not_all_served' }

// 厨房ディスプレイからの会計承認（＝会計完了）。提供済みの注文をまとめて closed + paid にする。
// お客さんの会計依頼を承認するケースと、現金/店頭会計（依頼なし）の両方で使う。
// 未提供が残る場合は何も変更せず not_all_served を返す（厨房が作りかけを見失う事故を防ぐ）。
export async function approveTableCheckout(
  db: D1Database,
  accountId: string,
  tableId: string,
): Promise<ApproveCheckoutResult> {
  const open = await getOpenTableOrderRows(db, accountId, tableId)
  if (open.length === 0) return { ok: false, error: 'nothing_to_settle' }
  if (!canCheckoutTable(open)) return { ok: false, error: 'not_all_served' }

  const served = open.filter((o) => o.status === 'served')
  const settledTotal = served.reduce((s, o) => s + o.total_amount, 0)
  const res = await db
    .prepare(
      `UPDATE orders
          SET status = 'closed', payment_status = 'paid',
              paid_at = datetime('now'), updated_at = datetime('now')
        WHERE line_account_id = ? AND table_id = ? AND status = 'served'`,
    )
    .bind(accountId, tableId)
    .run()
  return { ok: true, settled_count: res.meta.changes ?? served.length, settled_total: settledTotal }
}

export interface TodaysSales {
  orders: KitchenOrder[]
  total: number
  count: number
}

// 本日（JST）の会計済み伝票一覧 + 売上合計・件数。
// paid_at は UTC 保存のため、JST 当日 0 時を UTC に換算して境界にする
// （datetime('now','+9 hours','start of day','-9 hours')）。
export async function listTodaysSales(
  db: D1Database,
  accountId: string,
): Promise<TodaysSales> {
  const orderRows = await db
    .prepare(
      `SELECT ${ORDER_HEADER_COLS}
         FROM orders
        WHERE line_account_id = ? AND status = 'closed'
          AND paid_at >= datetime('now','+9 hours','start of day','-9 hours')
        ORDER BY paid_at DESC`,
    )
    .bind(accountId)
    .all<Omit<KitchenOrder, 'items'>>()
  const orders = await hydrateItems(db, orderRows.results as Array<Omit<KitchenOrder, 'items'>>)
  const total = orders.reduce((s, o) => s + o.total_amount, 0)
  return { orders, total, count: orders.length }
}
