// 注文クライアントの API ラッパー。salon-booking と同じく VITE_API_BASE を
// 優先して絶対 URL で叩く（LIFF=Pages, API=Worker の別オリジン構成のため）。

import type { OrderContext } from './context.js';
import type { OrderableMenu } from './cart.js';
import type { OrderItemPayload } from './cart.js';
import type { MyOrder, TableSummary } from './history.js';

const API_BASE = import.meta.env?.VITE_API_BASE || '';

function withLiff(path: string, ctx: OrderContext): string {
  const u = new URL(path, API_BASE || window.location.origin);
  u.searchParams.set('liffId', ctx.liffId);
  if (API_BASE) return u.toString();
  return u.pathname + u.search;
}

function authHeaders(ctx: OrderContext, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${ctx.idToken}`, ...extra };
}

export async function fetchMenu(ctx: OrderContext): Promise<OrderableMenu[]> {
  const res = await fetch(withLiff('/api/liff/order/menu', ctx), { headers: authHeaders(ctx) });
  if (!res.ok) throw new Error(`menu ${res.status}`);
  const json = (await res.json()) as { menus: OrderableMenu[] };
  return json.menus ?? [];
}

export interface MyOrdersResult {
  orders: MyOrder[];
  summary: TableSummary | null;
}

// 自分の注文履歴（現在のテーブル分）+ テーブル会計集計。失敗時は空（履歴は best-effort）。
export async function fetchMyOrders(ctx: OrderContext): Promise<MyOrdersResult> {
  const path = `/api/liff/order/me?table=${encodeURIComponent(ctx.tableToken)}`;
  try {
    const res = await fetch(withLiff(path, ctx), { headers: authHeaders(ctx) });
    if (!res.ok) return { orders: [], summary: null };
    const json = (await res.json()) as { success: boolean; data: MyOrder[]; summary: TableSummary | null };
    return { orders: json.data ?? [], summary: json.summary ?? null };
  } catch {
    return { orders: [], summary: null };
  }
}

export interface CheckoutResult {
  table_number: string;
  settled_count: number;
  settled_total: number;
}

// テーブル一括会計。全品提供済みでなければサーバが 409 not_all_served を返す。
export async function checkoutOrder(
  ctx: OrderContext,
): Promise<{ ok: true; data: CheckoutResult } | { ok: false; error: string }> {
  const res = await fetch(withLiff('/api/liff/order/checkout', ctx), {
    method: 'POST',
    headers: authHeaders(ctx, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ table_token: ctx.tableToken }),
  });
  if (res.ok) {
    const json = (await res.json()) as { success: boolean; data: CheckoutResult };
    return { ok: true, data: json.data };
  }
  let error = `error_${res.status}`;
  try {
    const json = (await res.json()) as { error?: string };
    if (json.error) error = json.error;
  } catch {
    /* JSON 以外のエラーボディは無視 */
  }
  return { ok: false, error };
}

export interface CreateOrderResult {
  order_id: string;
  table_number: string;
  total: number;
}

// 注文確定。Idempotency-Key で二重送信を防ぐ。
// サーバーは id_token を verify し、友だち未登録なら 403 friend_required を返す。
export async function createOrder(
  ctx: OrderContext,
  items: OrderItemPayload[],
  customerNote: string,
): Promise<{ ok: true; data: CreateOrderResult } | { ok: false; error: string }> {
  const res = await fetch(withLiff('/api/liff/order/orders', ctx), {
    method: 'POST',
    headers: authHeaders(ctx, {
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
    }),
    body: JSON.stringify({
      table_token: ctx.tableToken,
      items,
      customer_note: customerNote || undefined,
    }),
  });
  if (res.ok) {
    const json = (await res.json()) as { success: boolean; data: CreateOrderResult };
    return { ok: true, data: json.data };
  }
  let error = `error_${res.status}`;
  try {
    const json = (await res.json()) as { error?: string };
    if (json.error) error = json.error;
  } catch {
    /* JSON 以外のエラーボディは無視 */
  }
  return { ok: false, error };
}
