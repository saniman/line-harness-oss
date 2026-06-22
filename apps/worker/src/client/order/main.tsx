// main.tsx — モバイルオーダー React エントリ。LIFF orchestrator (main.ts) から
// 動的 import され、初期化済みコンテキスト（liffId/lineUserId/idToken/tableToken）を受け取る。

import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { OrderProvider, useOrderContext, type OrderContext } from './lib/context.js';
import {
  buildLine,
  addToCart,
  changeQty,
  cartCount,
  cartTotal,
  toOrderItems,
  type OrderableMenu,
  type CartLine,
} from './lib/cart.js';
import {
  fetchMenu,
  fetchMyOrders,
  createOrder,
  checkoutOrder,
  type CreateOrderResult,
  type CheckoutResult,
} from './lib/api.js';
import {
  USER_STATUS_LABEL,
  sumTotals,
  checkoutButtonState,
  type MyOrder,
  type TableSummary,
} from './lib/history.js';
import './styles.css';

const yen = (n: number) => '¥' + n.toLocaleString('ja-JP');

function categoriesOf(menus: OrderableMenu[]): string[] {
  const cats: string[] = [];
  for (const m of menus) {
    const c = (m as OrderableMenu & { category_label?: string | null }).category_label || 'メニュー';
    if (!cats.includes(c)) cats.push(c);
  }
  return cats;
}

function catOf(m: OrderableMenu): string {
  return (m as OrderableMenu & { category_label?: string | null }).category_label || 'メニュー';
}

function App() {
  const ctx = useOrderContext();
  const [menus, setMenus] = useState<OrderableMenu[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [activeCat, setActiveCat] = useState<string>('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [optionTarget, setOptionTarget] = useState<OrderableMenu | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [done, setDone] = useState<CreateOrderResult | null>(null);
  const [myOrders, setMyOrders] = useState<MyOrder[]>([]);
  const [summary, setSummary] = useState<TableSummary | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [checkingOut, setCheckingOut] = useState(false);
  const [checkoutError, setCheckoutError] = useState('');
  const [paid, setPaid] = useState<CheckoutResult | null>(null);

  const reloadHistory = () => {
    fetchMyOrders(ctx).then(({ orders, summary }) => {
      setMyOrders(orders);
      setSummary(summary);
    });
  };

  const handleCheckout = async () => {
    if (!window.confirm('お会計をします。よろしいですか？')) return;
    setCheckingOut(true);
    setCheckoutError('');
    const res = await checkoutOrder(ctx);
    setCheckingOut(false);
    if (res.ok) {
      setPaid(res.data);
      setHistoryOpen(false);
      reloadHistory();
    } else if (res.error === 'not_all_served') {
      setCheckoutError('まだお作りしている品があります。提供までお待ちください。');
    } else if (res.error === 'nothing_to_settle') {
      setCheckoutError('お会計対象のご注文がありません。');
    } else if (res.error === 'friend_required') {
      setCheckoutError('ご注文には友だち追加が必要です。');
    } else {
      setCheckoutError('お会計に失敗しました。時間をおいて再度お試しください。');
    }
  };

  useEffect(() => {
    fetchMenu(ctx)
      .then((m) => {
        setMenus(m);
        const cats = categoriesOf(m);
        setActiveCat(cats[0] ?? '');
      })
      .catch(() => setLoadError('メニュー情報の取得に失敗しました。'))
      .finally(() => setLoading(false));
    reloadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx]);

  const spentSoFar = sumTotals(myOrders);

  const cats = useMemo(() => categoriesOf(menus), [menus]);
  const count = cartCount(cart);
  const total = cartTotal(cart);

  const handleAdd = (m: OrderableMenu) => {
    if (m.options && m.options.length > 0) setOptionTarget(m);
    else setCart((c) => addToCart(c, buildLine(m, [])));
  };

  const submit = async () => {
    setSubmitting(true);
    setSubmitError('');
    const res = await createOrder(ctx, toOrderItems(cart), note);
    setSubmitting(false);
    if (res.ok) {
      setDone(res.data);
      setCart([]);
      setCartOpen(false);
      reloadHistory();
    } else if (res.error === 'friend_required') {
      setSubmitError('ご注文には友だち追加が必要です。一度トーク画面から友だち追加してください。');
    } else if (res.error === 'table_not_found') {
      setSubmitError('テーブル情報が無効です。お手数ですが卓上のQRを読み取り直してください。');
    } else {
      setSubmitError('注文の送信に失敗しました。時間をおいて再度お試しください。');
    }
  };

  if (loading) return <div className="mo-center">読み込み中…</div>;
  if (loadError) return <div className="mo-center mo-err">{loadError}</div>;
  if (paid) return <PaidScreen result={paid} onClose={() => setPaid(null)} />;
  if (done) return <DoneScreen result={done} onMore={() => setDone(null)} />;

  return (
    <div className="mo-root">
      <div className="mo-header">
        <span className="mo-shop">🏮 ご注文</span>
        <button className="mo-hist-btn" onClick={() => { reloadHistory(); setHistoryOpen(true); }}>
          注文履歴
          {myOrders.length > 0 && <span className="mo-hist-total">¥{spentSoFar.toLocaleString('ja-JP')}</span>}
        </button>
      </div>

      <div className="mo-cats">
        {cats.map((c) => (
          <button key={c} className={`mo-cat${c === activeCat ? ' active' : ''}`} onClick={() => setActiveCat(c)}>
            {c}
          </button>
        ))}
      </div>

      <div className="mo-menu">
        {menus.filter((m) => catOf(m) === activeCat).map((m) => {
          const inCart = cart.filter((c) => c.menu_id === m.id).reduce((s, c) => s + c.quantity, 0);
          const hasOpt = m.options && m.options.length > 0;
          return (
            <div key={m.id} className="mo-card">
              <div className="mo-info">
                <div className="mo-name">{m.name}</div>
                {(m as { description?: string | null }).description && (
                  <div className="mo-desc">{(m as { description?: string | null }).description}</div>
                )}
                <div className="mo-price">{yen(m.base_price)}{hasOpt ? ' 〜' : ''}</div>
              </div>
              {inCart > 0 && !hasOpt ? (
                <div className="mo-stepper">
                  <button onClick={() => setCart((c) => changeQty(c, `${m.id}|`, -1))}>−</button>
                  <span>{inCart}</span>
                  <button onClick={() => setCart((c) => changeQty(c, `${m.id}|`, +1))}>＋</button>
                </div>
              ) : (
                <button className="mo-add" onClick={() => handleAdd(m)}>＋</button>
              )}
            </div>
          );
        })}
      </div>

      {count > 0 && (
        <div className="mo-cartbar">
          <button className="mo-cartbtn" onClick={() => setCartOpen(true)}>
            <span className="mo-badge">{count}</span>
            注文内容を確認
            <span>{yen(total)}</span>
          </button>
        </div>
      )}

      {optionTarget && (
        <OptionSheet
          menu={optionTarget}
          onClose={() => setOptionTarget(null)}
          onAdd={(ids) => {
            setCart((c) => addToCart(c, buildLine(optionTarget, ids)));
            setOptionTarget(null);
          }}
        />
      )}

      {cartOpen && (
        <CartSheet
          cart={cart}
          total={total}
          count={count}
          note={note}
          setNote={setNote}
          submitting={submitting}
          error={submitError}
          onClose={() => setCartOpen(false)}
          onChangeQty={(uid, d) => setCart((c) => changeQty(c, uid, d))}
          onSubmit={submit}
        />
      )}

      {historyOpen && (
        <HistorySheet
          orders={myOrders}
          total={spentSoFar}
          summary={summary}
          checkingOut={checkingOut}
          checkoutError={checkoutError}
          onCheckout={handleCheckout}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </div>
  );
}

function HistorySheet({ orders, total, summary, checkingOut, checkoutError, onCheckout, onClose }: {
  orders: MyOrder[];
  total: number;
  summary: TableSummary | null;
  checkingOut: boolean;
  checkoutError: string;
  onCheckout: () => void;
  onClose: () => void;
}) {
  const checkout = checkoutButtonState(summary);
  return (
    <div className="mo-mask" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="mo-sheet">
        <h3>注文履歴</h3>
        <div className="mo-sub">このテーブルでのご注文と状況</div>
        {orders.length === 0 ? (
          <div className="mo-hist-empty">まだ注文はありません</div>
        ) : (
          <>
            <div className="mo-total">
              <span>これまでの合計（{orders.length}件）</span>
              <span className="mo-total-val">{yen(total)}<small>（税込）</small></span>
            </div>
            {orders.map((o) => (
              <div key={o.id} className="mo-hist-card">
                <div className="mo-hist-top">
                  <span className={`mo-badge-status mo-st-${o.status}`}>{USER_STATUS_LABEL[o.status]}</span>
                  <span className="mo-hist-amount">{yen(o.total_amount)}</span>
                </div>
                <ul className="mo-hist-items">
                  {o.items.map((it, i) => (
                    <li key={i}>×{it.quantity} {it.name_snapshot}{it.options_text ? ` / ${it.options_text}` : ''}</li>
                  ))}
                </ul>
              </div>
            ))}
          </>
        )}
        {checkout.visible && (
          <>
            {checkout.note && <div className="mo-paynote">{checkout.note}</div>}
            {checkoutError && <div className="mo-err-box">{checkoutError}</div>}
            <button
              className="mo-submit"
              disabled={checkout.disabled || checkingOut}
              onClick={onCheckout}
            >
              {checkingOut
                ? 'お会計中…'
                : `お会計をする（${yen(summary?.open_total ?? 0)}）`}
            </button>
          </>
        )}
        <button className="mo-ghost" onClick={onClose}>閉じる</button>
      </div>
    </div>
  );
}

function PaidScreen({ result, onClose }: { result: CheckoutResult; onClose: () => void }) {
  return (
    <div className="mo-done">
      <div className="mo-check">✓</div>
      <h3>お会計ありがとうございました！</h3>
      <p>
        テーブル <b>{result.table_number}</b><br />
        お会計 <b>{yen(result.settled_total)}</b>（税込・{result.settled_count}件）<br />
        またのご来店をお待ちしております。
      </p>
      <button className="mo-ghost" onClick={onClose}>注文画面に戻る</button>
    </div>
  );
}

function OptionSheet({ menu, onClose, onAdd }: {
  menu: OrderableMenu;
  onClose: () => void;
  onAdd: (ids: string[]) => void;
}) {
  // group_label ごとに単一選択。初期値は各グループの先頭。
  const groups = useMemo(() => {
    const map = new Map<string, typeof menu.options>();
    for (const o of menu.options) {
      const arr = map.get(o.group_label) ?? [];
      arr.push(o);
      map.set(o.group_label, arr);
    }
    return [...map.entries()];
  }, [menu]);
  const [sel, setSel] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const [label, opts] of groups) init[label] = opts[0].id;
    return init;
  });
  const ids = Object.values(sel);
  const extra = menu.options.filter((o) => ids.includes(o.id)).reduce((s, o) => s + o.extra_price, 0);

  return (
    <div className="mo-mask" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="mo-sheet">
        <h3>{menu.name}</h3>
        <div className="mo-sub">オプションを選択してください</div>
        {groups.map(([label, opts]) => (
          <div key={label} className="mo-optgroup">
            <div className="mo-oglabel">{label}</div>
            {opts.map((o) => (
              <div
                key={o.id}
                className={`mo-optrow${sel[label] === o.id ? ' sel' : ''}`}
                onClick={() => setSel((s) => ({ ...s, [label]: o.id }))}
              >
                <span>{o.choice_name}</span>
                <span className="mo-opprice">{o.extra_price > 0 ? '+' + yen(o.extra_price) : '±0'}</span>
              </div>
            ))}
          </div>
        ))}
        <button className="mo-submit" onClick={() => onAdd(ids)}>
          {yen(menu.base_price + extra)} をカートに追加
        </button>
      </div>
    </div>
  );
}

function CartSheet({ cart, total, count, note, setNote, submitting, error, onClose, onChangeQty, onSubmit }: {
  cart: CartLine[];
  total: number;
  count: number;
  note: string;
  setNote: (v: string) => void;
  submitting: boolean;
  error: string;
  onClose: () => void;
  onChangeQty: (uid: string, d: number) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="mo-mask" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="mo-sheet">
        <h3>ご注文内容</h3>
        <div className="mo-sub">数量を確認して注文してください</div>
        {cart.map((c) => (
          <div key={c.uid} className="mo-cartline">
            <div className="mo-ci-info">
              <div className="mo-ci-name">{c.name}</div>
              {c.options_text && <div className="mo-ci-opt">{c.options_text}</div>}
            </div>
            <div className="mo-stepper">
              <button onClick={() => onChangeQty(c.uid, -1)}>−</button>
              <span>{c.quantity}</span>
              <button onClick={() => onChangeQty(c.uid, +1)}>＋</button>
            </div>
            <div className="mo-ci-price">{yen(c.unit_price * c.quantity)}</div>
          </div>
        ))}
        <textarea
          className="mo-note"
          placeholder="アレルギー・要望など（任意）"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <div className="mo-total">
          <span>合計（{count}点）</span>
          <span className="mo-total-val">{yen(total)}<small>（税込）</small></span>
        </div>
        <div className="mo-paynote">💴 お会計はお帰りの際に <b>「注文履歴」→「お会計をする」</b> からどうぞ。</div>
        {error && <div className="mo-err-box">{error}</div>}
        <button className="mo-submit" disabled={submitting || count === 0} onClick={onSubmit}>
          {submitting ? '送信中…' : 'この内容で注文する'}
        </button>
      </div>
    </div>
  );
}

function DoneScreen({ result, onMore }: { result: CreateOrderResult; onMore: () => void }) {
  return (
    <div className="mo-done">
      <div className="mo-check">✓</div>
      <h3>ご注文を承りました！</h3>
      <p>
        テーブル <b>{result.table_number}</b><br />
        合計 <b>{yen(result.total)}</b>（税込）<br />
        厨房で順番にお作りします。<br />できあがりまで少々お待ちください。
      </p>
      <button className="mo-ghost" onClick={onMore}>追加で注文する</button>
    </div>
  );
}

let _root: Root | null = null;

export function mountOrder(container: HTMLElement, ctx: OrderContext): void {
  document.body.classList.add('mo-active');
  if (_root) { _root.unmount(); _root = null; }
  container.innerHTML = '';
  _root = createRoot(container);
  _root.render(
    <StrictMode>
      <OrderProvider value={ctx}>
        <App />
      </OrderProvider>
    </StrictMode>,
  );
}

export function unmountOrder(): void {
  if (_root) { _root.unmount(); _root = null; }
  document.body.classList.remove('mo-active');
}
