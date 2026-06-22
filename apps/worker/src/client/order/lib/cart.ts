// モバイルオーダーのカート純粋ロジック。UI から切り離してテスト可能にする。
// 価格表示はクライアント側の参考値（最終的な合計はサーバーが menus から再計算する）。

export interface MenuOption {
  id: string;
  group_label: string;
  choice_name: string;
  extra_price: number;
}

export type MenuGroup = 'food' | 'drink';

export interface OrderableMenu {
  id: string;
  name: string;
  base_price: number;
  menu_group: MenuGroup;
  category_label?: string | null;
  description?: string | null;
  options: MenuOption[];
}

// メニューに含まれる大分類（お食事/ドリンク）を表示順で返す。
// お食事を先頭にし、その種別の商品が1件もなければタブに出さない。
export function groupsPresent(menus: OrderableMenu[]): MenuGroup[] {
  const order: MenuGroup[] = ['food', 'drink'];
  return order.filter((g) => menus.some((m) => m.menu_group === g));
}

// カート1行。同一メニュー×同一オプション組合せを 1 行に集約する（uid で識別）。
export interface CartLine {
  uid: string;
  menu_id: string;
  name: string;
  unit_price: number;
  quantity: number;
  option_ids: string[];
  options_text: string;
}

// メニュー定義順にオプションを並べ、単価・表示テキスト・uid を確定する。
export function buildLine(menu: OrderableMenu, optionIds: string[]): CartLine {
  const chosen = new Set(optionIds);
  let unit = menu.base_price;
  const names: string[] = [];
  const ids: string[] = [];
  for (const opt of menu.options) {
    if (chosen.has(opt.id)) {
      unit += opt.extra_price;
      names.push(opt.choice_name);
      ids.push(opt.id);
    }
  }
  return {
    uid: `${menu.id}|${ids.join(',')}`,
    menu_id: menu.id,
    name: menu.name,
    unit_price: unit,
    quantity: 1,
    option_ids: ids,
    options_text: names.join(' / '),
  };
}

// カートに1点追加（同一 uid は数量加算）。新しい配列を返す（immutable）。
export function addToCart(cart: CartLine[], line: CartLine): CartLine[] {
  const idx = cart.findIndex((c) => c.uid === line.uid);
  if (idx === -1) return [...cart, line];
  const next = cart.slice();
  next[idx] = { ...next[idx], quantity: next[idx].quantity + line.quantity };
  return next;
}

// 数量変更。0 以下になった行は除去する。
export function changeQty(cart: CartLine[], uid: string, delta: number): CartLine[] {
  return cart
    .map((c) => (c.uid === uid ? { ...c, quantity: c.quantity + delta } : c))
    .filter((c) => c.quantity > 0);
}

export function cartCount(cart: CartLine[]): number {
  return cart.reduce((s, c) => s + c.quantity, 0);
}

export function cartTotal(cart: CartLine[]): number {
  return cart.reduce((s, c) => s + c.unit_price * c.quantity, 0);
}

// POST /api/liff/order/orders に送る items 形式に変換する。
export interface OrderItemPayload {
  menu_id: string;
  quantity: number;
  option_ids: string[];
}

export function toOrderItems(cart: CartLine[]): OrderItemPayload[] {
  return cart.map((c) => ({
    menu_id: c.menu_id,
    quantity: c.quantity,
    option_ids: c.option_ids,
  }));
}
