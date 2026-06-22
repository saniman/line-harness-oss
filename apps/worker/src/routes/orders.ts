// 飲食店モバイルオーダーの HTTP ルート。
//
// LIFF-facing: /api/liff/order/*  — authMiddleware が /api/liff/ をスキップする（公開）。
//   注文作成は Authorization: Bearer <id_token> で本人確認し、友だち登録必須ゲートを通す。
// Admin-facing: /api/order/admin/* — グローバル authMiddleware（staff/owner）で保護。
//   厨房ディスプレイの一覧・ステータス更新・テーブル管理。
//
// UUID は crypto.randomUUID()、時刻は UTC ISO / datetime('now') で保存する。

import { Hono, type Context } from 'hono'
import { getLineAccounts } from '@line-crm/db'
import type { Env } from '../index.js'
import { ensureDefaultLineAccount } from '../services/default-line-account.js'
import {
  resolveAccountIdFromLiff,
  verifyCallerLineUserId,
  resolveFriendId,
} from '../services/liff-identity.js'
import {
  buildOrderItems,
  canTransitionOrderStatus,
  getOrderableMenus,
  getOrderStatus,
  insertOrder,
  listKitchenOrders,
  resolveTableByToken,
  updateOrderStatus,
  type OrderStatus,
  type RequestedItem,
} from '../services/orders.js'

const orders = new Hono<Env>()

// Admin: account_id クエリ優先、無ければ単一アカウントを解決（single-account fork）。
async function resolveAccountIdAdmin(c: Context<Env>): Promise<string | null> {
  const fromQuery = c.req.query('account_id')
  if (fromQuery) return fromQuery
  await ensureDefaultLineAccount(c.env.DB, c.env)
  const accounts = await getLineAccounts(c.env.DB)
  if (accounts.length === 1) return accounts[0].id
  return null
}

// ================================================================
// LIFF endpoints (/api/liff/order/*)
// ================================================================

// メニュー（オプション込み）を取得。カテゴリ単位でグルーピングしやすい形で返す。
orders.get('/api/liff/order/menu', async (c) => {
  const accountId = await resolveAccountIdFromLiff(c)
  if (!accountId) return c.json({ error: 'unknown_liff' }, 404)
  const menuMap = await getOrderableMenus(c.env.DB, accountId)
  const menus = [...menuMap.values()]
  return c.json({ menus })
})

// 注文作成。友だち登録必須・本人確認・冪等キーで二重送信を防ぐ。
orders.post('/api/liff/order/orders', async (c) => {
  const accountId = await resolveAccountIdFromLiff(c)
  if (!accountId) return c.json({ error: 'unknown_liff' }, 404)

  // 本人確認（id_token）。友だち登録ゲートの前提。
  const callerLineUserId = await verifyCallerLineUserId(c)
  if (!callerLineUserId) return c.json({ error: 'unauthorized' }, 401)

  let body: {
    table_token?: string
    items?: RequestedItem[]
    customer_note?: string
  }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }
  if (!body.table_token) return c.json({ error: 'missing_table' }, 400)

  // 友だち登録必須ゲート: friend 行が無い / フォロー解除済みは注文不可。
  const friendId = await resolveFriendId(c.env.DB, callerLineUserId, accountId)
  if (!friendId) return c.json({ error: 'friend_required' }, 403)
  const friend = await c.env.DB
    .prepare(`SELECT is_following FROM friends WHERE id = ?`)
    .bind(friendId)
    .first<{ is_following: number }>()
  if (!friend || friend.is_following === 0) {
    return c.json({ error: 'friend_required' }, 403)
  }

  // テーブル解決（QR トークン → dining_tables）。
  const table = await resolveTableByToken(c.env.DB, accountId, body.table_token)
  if (!table) return c.json({ error: 'table_not_found' }, 404)

  // サーバー側で価格を再計算（クライアント申告は信用しない）。
  const menuMap = await getOrderableMenus(c.env.DB, accountId)
  const built = buildOrderItems(body.items ?? [], menuMap)
  if (!built.ok) {
    return c.json({ error: built.error }, 422)
  }

  const orderId = await insertOrder(c.env.DB, {
    accountId,
    tableId: table.id,
    tableNumber: table.table_number,
    friendId,
    items: built.items,
    total: built.total,
    customerNote: body.customer_note?.trim() || null,
  })

  return c.json({
    success: true,
    data: { order_id: orderId, table_number: table.table_number, total: built.total },
  }, 201)
})

// ================================================================
// Admin endpoints (/api/order/admin/*)
// ================================================================

// 厨房ディスプレイ一覧。?status=active（既定: new+preparing）/ all / カンマ区切り個別指定。
orders.get('/api/order/admin/orders', async (c) => {
  const accountId = await resolveAccountIdAdmin(c)
  if (!accountId) return c.json({ success: false, error: 'account_not_resolved' }, 400)

  const VALID: OrderStatus[] = ['new', 'preparing', 'served', 'closed', 'cancelled']
  const statusParam = c.req.query('status') ?? 'active'
  let statuses: OrderStatus[]
  if (statusParam === 'active') statuses = ['new', 'preparing']
  else if (statusParam === 'all') statuses = VALID
  else {
    statuses = statusParam.split(',').filter((s): s is OrderStatus => VALID.includes(s as OrderStatus))
    if (statuses.length === 0) return c.json({ success: false, error: 'invalid_status' }, 400)
  }

  const list = await listKitchenOrders(c.env.DB, accountId, statuses)
  return c.json({ success: true, data: list })
})

// ステータス更新。?action 相当を body.status で受け取り、遷移可否をサーバーで検証する。
orders.put('/api/order/admin/orders/:id/status', async (c) => {
  const accountId = await resolveAccountIdAdmin(c)
  if (!accountId) return c.json({ success: false, error: 'account_not_resolved' }, 400)

  const orderId = c.req.param('id')
  let body: { status?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ success: false, error: 'invalid_json' }, 400)
  }
  const VALID: OrderStatus[] = ['new', 'preparing', 'served', 'closed', 'cancelled']
  if (!body.status || !VALID.includes(body.status as OrderStatus)) {
    return c.json({ success: false, error: 'invalid_status' }, 400)
  }
  const to = body.status as OrderStatus

  const current = await getOrderStatus(c.env.DB, orderId)
  if (!current || current.line_account_id !== accountId) {
    return c.json({ success: false, error: 'order_not_found' }, 404)
  }
  if (!canTransitionOrderStatus(current.status, to)) {
    return c.json({ success: false, error: 'invalid_transition' }, 409)
  }

  // served → closed は会計完了とみなし支払い済みも記録する。
  const markPaid = current.status === 'served' && to === 'closed'
  await updateOrderStatus(c.env.DB, orderId, to, markPaid)
  return c.json({ success: true, data: { id: orderId, status: to } })
})

// テーブル一覧。
orders.get('/api/order/admin/tables', async (c) => {
  const accountId = await resolveAccountIdAdmin(c)
  if (!accountId) return c.json({ success: false, error: 'account_not_resolved' }, 400)
  const rows = await c.env.DB
    .prepare(
      `SELECT id, table_number, qr_token, is_active
         FROM dining_tables
        WHERE line_account_id = ?
        ORDER BY table_number ASC`,
    )
    .bind(accountId)
    .all()
  return c.json({ success: true, data: rows.results })
})

// テーブル作成。qr_token は推測困難な UUID を自動採番（QR / LIFF URL に埋め込む）。
orders.post('/api/order/admin/tables', async (c) => {
  const accountId = await resolveAccountIdAdmin(c)
  if (!accountId) return c.json({ success: false, error: 'account_not_resolved' }, 400)
  let body: { table_number?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ success: false, error: 'invalid_json' }, 400)
  }
  if (!body.table_number?.trim()) {
    return c.json({ success: false, error: 'missing_table_number' }, 400)
  }
  const id = crypto.randomUUID()
  const qrToken = crypto.randomUUID()
  await c.env.DB
    .prepare(
      `INSERT INTO dining_tables (id, line_account_id, table_number, qr_token)
       VALUES (?,?,?,?)`,
    )
    .bind(id, accountId, body.table_number.trim(), qrToken)
    .run()
  return c.json({ success: true, data: { id, table_number: body.table_number.trim(), qr_token: qrToken } }, 201)
})

// テーブル削除。テナント分離のため account スコープで削除する。
orders.delete('/api/order/admin/tables/:id', async (c) => {
  const accountId = await resolveAccountIdAdmin(c)
  if (!accountId) return c.json({ success: false, error: 'account_not_resolved' }, 400)
  const tableId = c.req.param('id')
  const res = await c.env.DB
    .prepare(`DELETE FROM dining_tables WHERE id = ? AND line_account_id = ?`)
    .bind(tableId, accountId)
    .run()
  if (!res.meta.changes) {
    return c.json({ success: false, error: 'table_not_found' }, 404)
  }
  return c.json({ success: true, data: { id: tableId } })
})

export { orders }
