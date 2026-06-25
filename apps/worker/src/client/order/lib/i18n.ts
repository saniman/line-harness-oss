// モバイルオーダー注文画面の UI 文言の多言語化（メニュー本体はサーバ翻訳・ここは画面の固定文言）。
// 後から言語を足しやすいよう DICT に追加するだけにする。

export type Lang = 'ja' | 'en';

export function detectLang(raw: string | null | undefined): Lang {
  return (raw ?? '').toLowerCase().startsWith('en') ? 'en' : 'ja';
}

type Dict = Record<string, string>;

const JA: Dict = {
  order_header: '🏮 ご注文',
  history: '注文履歴',
  review: '注文内容を確認',
  your_order: 'ご注文内容',
  check_qty: '数量を確認して注文してください',
  note_placeholder: 'アレルギー・要望など（任意）',
  total: '合計',
  tax_incl: '（税込）',
  cart_pay_note: '💴 お会計はお帰りの際に「注文履歴」→「お会計をお願いする」からどうぞ。',
  place_order: 'この内容で注文する',
  sending: '送信中…',
  loading: '読み込み中…',
  choose_options: 'オプションを選択してください',
  add_to_cart: 'カートに追加',
  history_sub: 'このテーブルでのご注文と状況',
  no_orders: 'まだ注文はありません',
  total_so_far: 'これまでの合計',
  checkout_request: 'お会計をお願いする',
  close: '閉じる',
  requested_title: 'お会計をお願いしました！',
  requested_l1: 'スタッフが確認にうかがいます。',
  requested_l2: '少々お待ちください。',
  back_to_menu: '注文画面に戻る',
  done_title: 'ご注文を承りました！',
  done_l1: '厨房で順番にお作りします。',
  done_l2: 'できあがりまで少々お待ちください。',
  order_more: '追加で注文する',
  table: 'テーブル',
  group_food: '🍽 お食事',
  group_drink: '🍷 ドリンク',
  st_new: '受付しました',
  st_preparing: '調理中',
  st_served: '提供済み',
  st_closed: 'お会計済み',
  st_cancelled: 'キャンセル',
};

const EN: Dict = {
  order_header: '🏮 Order',
  history: 'My Orders',
  review: 'Review order',
  your_order: 'Your order',
  check_qty: 'Check the quantities and place your order',
  note_placeholder: 'Allergies / requests (optional)',
  total: 'Total',
  tax_incl: ' (tax incl.)',
  cart_pay_note: '💴 To pay, tap “My Orders” → “Request checkout” when you are ready to leave.',
  place_order: 'Place order',
  sending: 'Sending…',
  loading: 'Loading…',
  choose_options: 'Choose your options',
  add_to_cart: 'Add to cart',
  history_sub: 'Your orders and their status at this table',
  no_orders: 'No orders yet',
  total_so_far: 'Total so far',
  checkout_request: 'Request checkout',
  close: 'Close',
  requested_title: 'Checkout requested!',
  requested_l1: 'A staff member will come to assist you.',
  requested_l2: 'Please wait a moment.',
  back_to_menu: 'Back to menu',
  done_title: 'Order received!',
  done_l1: 'The kitchen is preparing your order.',
  done_l2: 'Please wait a little while.',
  order_more: 'Order more',
  table: 'Table',
  group_food: '🍽 Food',
  group_drink: '🍷 Drinks',
  st_new: 'Received',
  st_preparing: 'Preparing',
  st_served: 'Served',
  st_closed: 'Paid',
  st_cancelled: 'Cancelled',
};

const DICT: Record<Lang, Dict> = { ja: JA, en: EN };

// 純粋関数（テスト対象）。未知キーは ja → key の順でフォールバック。
export function translate(lang: Lang, key: string): string {
  return DICT[lang]?.[key] ?? DICT.ja[key] ?? key;
}

// コンポーネント用の簡易ヘルパー。App が描画前に setLang() で現在の言語をセットする
// （描画は同期なので、その描画サイクルの t() はすべて同じ言語になる）。
let current: Lang = 'ja';
export function setLang(lang: Lang): void {
  current = lang;
}
export function t(key: string): string {
  return translate(current, key);
}
