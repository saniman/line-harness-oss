import { describe, it, expect } from 'vitest';
import {
  buildLine,
  addToCart,
  changeQty,
  cartCount,
  cartTotal,
  toOrderItems,
  groupsPresent,
  type OrderableMenu,
  type CartLine,
} from './cart.js';

const BEER: OrderableMenu = {
  id: 'm1', name: '生ビール', base_price: 600, menu_group: 'drink',
  options: [
    { id: 'o1', group_label: 'サイズ', choice_name: '中', extra_price: 0 },
    { id: 'o2', group_label: 'サイズ', choice_name: '大', extra_price: 200 },
  ],
};
const EDAMAME: OrderableMenu = { id: 'm2', name: '枝豆', base_price: 350, menu_group: 'food', options: [] };

describe('groupsPresent（メニューの大分類）', () => {
  it('お食事を先頭にして存在する種別だけ返す', () => {
    expect(groupsPresent([BEER, EDAMAME])).toEqual(['food', 'drink']);
  });
  it('ドリンクしか無ければドリンクのみ', () => {
    expect(groupsPresent([BEER])).toEqual(['drink']);
  });
  it('空なら空配列', () => {
    expect(groupsPresent([])).toEqual([]);
  });
});

describe('buildLine（カート行の生成）', () => {
  it('オプション無しは base_price をそのまま単価にする', () => {
    const line = buildLine(EDAMAME, []);
    expect(line).toMatchObject({ menu_id: 'm2', unit_price: 350, quantity: 1, options_text: '' });
    expect(line.uid).toBe('m2|');
  });

  it('オプション加算を単価とテキストに反映する', () => {
    const line = buildLine(BEER, ['o2']);
    expect(line.unit_price).toBe(800);
    expect(line.options_text).toBe('大');
    expect(line.uid).toBe('m1|o2');
  });

  it('オプションはメニュー定義順に並べる（uid を安定させる）', () => {
    const line = buildLine(BEER, ['o2', 'o1']);
    expect(line.option_ids).toEqual(['o1', 'o2']);
    expect(line.options_text).toBe('中 / 大');
  });
});

describe('addToCart（追加と集約）', () => {
  it('同一 uid は数量を加算する', () => {
    let cart: CartLine[] = [];
    cart = addToCart(cart, buildLine(BEER, ['o2']));
    cart = addToCart(cart, buildLine(BEER, ['o2']));
    expect(cart).toHaveLength(1);
    expect(cart[0].quantity).toBe(2);
  });

  it('異なるオプションは別行になる', () => {
    let cart: CartLine[] = [];
    cart = addToCart(cart, buildLine(BEER, ['o1']));
    cart = addToCart(cart, buildLine(BEER, ['o2']));
    expect(cart).toHaveLength(2);
  });

  it('元の配列を破壊しない（immutable）', () => {
    const cart: CartLine[] = [];
    const next = addToCart(cart, buildLine(EDAMAME, []));
    expect(cart).toHaveLength(0);
    expect(next).toHaveLength(1);
  });
});

describe('changeQty（数量変更）', () => {
  it('数量を増やせる', () => {
    let cart = addToCart([], buildLine(EDAMAME, []));
    cart = changeQty(cart, 'm2|', 1);
    expect(cart[0].quantity).toBe(2);
  });

  it('0 以下になった行は除去される', () => {
    let cart = addToCart([], buildLine(EDAMAME, []));
    cart = changeQty(cart, 'm2|', -1);
    expect(cart).toHaveLength(0);
  });
});

describe('合計の計算', () => {
  it('cartCount は数量の総和', () => {
    let cart = addToCart([], buildLine(BEER, ['o2'])); // 1
    cart = changeQty(cart, 'm1|o2', 1);                 // 2
    cart = addToCart(cart, buildLine(EDAMAME, []));     // +1
    expect(cartCount(cart)).toBe(3);
  });

  it('cartTotal は単価×数量の総和', () => {
    let cart = addToCart([], buildLine(BEER, ['o2'])); // 800
    cart = changeQty(cart, 'm1|o2', 1);                 // 800*2 = 1600
    cart = addToCart(cart, buildLine(EDAMAME, []));     // +350
    expect(cartTotal(cart)).toBe(1950);
  });
});

describe('toOrderItems（API送信形式への変換）', () => {
  it('menu_id / quantity / option_ids だけを抽出する', () => {
    let cart = addToCart([], buildLine(BEER, ['o2']));
    cart = changeQty(cart, 'm1|o2', 1);
    expect(toOrderItems(cart)).toEqual([
      { menu_id: 'm1', quantity: 2, option_ids: ['o2'] },
    ]);
  });
});
