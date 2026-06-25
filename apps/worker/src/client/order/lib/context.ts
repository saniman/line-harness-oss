// 注文クライアントの caller-context。main.ts が liff.init / getProfile /
// getIDToken / getFriendship を済ませた状態で mount 時に渡す。
// tableToken は QR / LIFF URL の ?table=<qr_token> から取得したテーブル識別子。

import { createContext, useContext } from 'react';
import type { Lang } from './i18n.js';

export interface OrderContext {
  liffId: string;
  lineUserId: string;
  idToken: string;
  tableToken: string;
  // LINE アプリの言語から判定した初期言語（画面トグルで切替可能）。
  lang: Lang;
}

const Ctx = createContext<OrderContext | null>(null);

export const OrderProvider = Ctx.Provider;

export function useOrderContext(): OrderContext {
  const v = useContext(Ctx);
  if (!v) throw new Error('OrderContext not provided');
  return v;
}
