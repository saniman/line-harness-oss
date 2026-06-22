import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

vi.mock('../services/liff-identity.js', () => ({
  resolveAccountIdFromLiff: vi.fn(),
  verifyCallerLineUserId: vi.fn(),
  resolveFriendId: vi.fn(),
}))

vi.mock('../services/orders.js', () => ({
  approveTableCheckout: vi.fn(),
  buildOrderItems: vi.fn(),
  canTransitionOrderStatus: vi.fn(),
  getOrderableMenus: vi.fn(),
  getOrderStatus: vi.fn(),
  getTableCheckoutSummary: vi.fn(),
  insertOrder: vi.fn(),
  listKitchenOrders: vi.fn(),
  listOrdersByTable: vi.fn(),
  listOrdersForFriend: vi.fn(),
  listTodaysSales: vi.fn(),
  requestTableCheckout: vi.fn(),
  resolveTableByToken: vi.fn(),
  updateOrderStatus: vi.fn(),
}))

vi.mock('../services/default-line-account.js', () => ({
  ensureDefaultLineAccount: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@line-crm/db', () => ({
  getLineAccounts: vi.fn().mockResolvedValue([{ id: 'acc1' }]),
}))

import {
  resolveAccountIdFromLiff,
  verifyCallerLineUserId,
  resolveFriendId,
} from '../services/liff-identity.js'
import {
  approveTableCheckout,
  buildOrderItems,
  canTransitionOrderStatus,
  getOrderableMenus,
  getOrderStatus,
  getTableCheckoutSummary,
  insertOrder,
  listKitchenOrders,
  listOrdersByTable,
  listOrdersForFriend,
  listTodaysSales,
  requestTableCheckout,
  resolveTableByToken,
  updateOrderStatus,
} from '../services/orders.js'
import { orders } from './orders.js'

const mResolveAccount = vi.mocked(resolveAccountIdFromLiff)
const mVerify = vi.mocked(verifyCallerLineUserId)
const mResolveFriend = vi.mocked(resolveFriendId)
const mBuild = vi.mocked(buildOrderItems)
const mCanTransition = vi.mocked(canTransitionOrderStatus)
const mGetMenus = vi.mocked(getOrderableMenus)
const mGetOrderStatus = vi.mocked(getOrderStatus)
const mInsert = vi.mocked(insertOrder)
const mListKitchen = vi.mocked(listKitchenOrders)
const mListByTable = vi.mocked(listOrdersByTable)
const mListForFriend = vi.mocked(listOrdersForFriend)
const mResolveTable = vi.mocked(resolveTableByToken)
const mUpdateStatus = vi.mocked(updateOrderStatus)
const mRequestCheckout = vi.mocked(requestTableCheckout)
const mApproveCheckout = vi.mocked(approveTableCheckout)
const mSummary = vi.mocked(getTableCheckoutSummary)
const mTodaysSales = vi.mocked(listTodaysSales)

const app = new Hono()
app.route('/', orders)

// friend lookup 用の最小モック DB。first() の戻りを差し替えて使う。
function makeDb(firstResult: unknown) {
  return {
    prepare: () => ({
      bind: () => ({
        first: vi.fn().mockResolvedValue(firstResult),
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn().mockResolvedValue({}),
      }),
    }),
  } as unknown as D1Database
}

beforeEach(() => {
  vi.clearAllMocks()
  mGetMenus.mockResolvedValue(new Map())
})

describe('POST /api/liff/order/orders（注文作成）', () => {
  it('id_token 検証に失敗したら 401 unauthorized', async () => {
    mResolveAccount.mockResolvedValue('acc1')
    mVerify.mockResolvedValue(null)
    const res = await app.request(
      '/api/liff/order/orders?liffId=L1',
      { method: 'POST', body: JSON.stringify({ table_token: 't1', items: [] }) },
      { DB: makeDb(null) },
    )
    expect(res.status).toBe(401)
  })

  it('友だち未登録なら 403 friend_required', async () => {
    mResolveAccount.mockResolvedValue('acc1')
    mVerify.mockResolvedValue('U123')
    mResolveFriend.mockResolvedValue(null)
    const res = await app.request(
      '/api/liff/order/orders?liffId=L1',
      { method: 'POST', body: JSON.stringify({ table_token: 't1', items: [{ menu_id: 'm1', quantity: 1 }] }) },
      { DB: makeDb(null) },
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'friend_required' })
  })

  it('フォロー解除済み（is_following=0）なら 403 friend_required', async () => {
    mResolveAccount.mockResolvedValue('acc1')
    mVerify.mockResolvedValue('U123')
    mResolveFriend.mockResolvedValue('f1')
    const res = await app.request(
      '/api/liff/order/orders?liffId=L1',
      { method: 'POST', body: JSON.stringify({ table_token: 't1', items: [{ menu_id: 'm1', quantity: 1 }] }) },
      { DB: makeDb({ is_following: 0 }) },
    )
    expect(res.status).toBe(403)
  })

  it('テーブルが見つからなければ 404 table_not_found', async () => {
    mResolveAccount.mockResolvedValue('acc1')
    mVerify.mockResolvedValue('U123')
    mResolveFriend.mockResolvedValue('f1')
    mResolveTable.mockResolvedValue(null)
    const res = await app.request(
      '/api/liff/order/orders?liffId=L1',
      { method: 'POST', body: JSON.stringify({ table_token: 'bad', items: [{ menu_id: 'm1', quantity: 1 }] }) },
      { DB: makeDb({ is_following: 1 }) },
    )
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'table_not_found' })
  })

  it('明細ビルドに失敗したら 422 をそのまま返す', async () => {
    mResolveAccount.mockResolvedValue('acc1')
    mVerify.mockResolvedValue('U123')
    mResolveFriend.mockResolvedValue('f1')
    mResolveTable.mockResolvedValue({ id: 'tbl1', table_number: 'A-3' })
    mBuild.mockReturnValue({ ok: false, error: 'invalid_option' })
    const res = await app.request(
      '/api/liff/order/orders?liffId=L1',
      { method: 'POST', body: JSON.stringify({ table_token: 't1', items: [{ menu_id: 'm1', quantity: 1, option_ids: ['x'] }] }) },
      { DB: makeDb({ is_following: 1 }) },
    )
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'invalid_option' })
  })

  it('正常系: 201 で order_id と合計を返し insertOrder を呼ぶ', async () => {
    mResolveAccount.mockResolvedValue('acc1')
    mVerify.mockResolvedValue('U123')
    mResolveFriend.mockResolvedValue('f1')
    mResolveTable.mockResolvedValue({ id: 'tbl1', table_number: 'A-3' })
    mBuild.mockReturnValue({
      ok: true,
      total: 950,
      items: [{ menu_id: 'm1', name_snapshot: '生ビール', options_text: '大ジョッキ', unit_price: 800, quantity: 1, line_total: 800 }],
    })
    mInsert.mockResolvedValue('order-uuid')
    const res = await app.request(
      '/api/liff/order/orders?liffId=L1',
      { method: 'POST', body: JSON.stringify({ table_token: 't1', items: [{ menu_id: 'm1', quantity: 1 }], customer_note: '辛さ控えめ' }) },
      { DB: makeDb({ is_following: 1 }) },
    )
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({
      success: true,
      data: { order_id: 'order-uuid', table_number: 'A-3', total: 950 },
    })
    expect(mInsert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ accountId: 'acc1', tableId: 'tbl1', friendId: 'f1', total: 950, customerNote: '辛さ控えめ' }),
    )
  })
})

describe('PUT /api/order/admin/orders/:id/status（ステータス更新）', () => {
  it('存在しない注文は 404', async () => {
    mGetOrderStatus.mockResolvedValue(null)
    const res = await app.request(
      '/api/order/admin/orders/o1/status',
      { method: 'PUT', body: JSON.stringify({ status: 'preparing' }) },
      { DB: makeDb(null) },
    )
    expect(res.status).toBe(404)
  })

  it('不正な遷移は 409 invalid_transition', async () => {
    mGetOrderStatus.mockResolvedValue({ status: 'new', line_account_id: 'acc1' })
    mCanTransition.mockReturnValue(false)
    const res = await app.request(
      '/api/order/admin/orders/o1/status',
      { method: 'PUT', body: JSON.stringify({ status: 'served' }) },
      { DB: makeDb(null) },
    )
    expect(res.status).toBe(409)
  })

  it('別アカウントの注文は 404（テナント分離）', async () => {
    mGetOrderStatus.mockResolvedValue({ status: 'new', line_account_id: 'OTHER' })
    const res = await app.request(
      '/api/order/admin/orders/o1/status',
      { method: 'PUT', body: JSON.stringify({ status: 'preparing' }) },
      { DB: makeDb(null) },
    )
    expect(res.status).toBe(404)
  })

  it('served → closed は markPaid=true で会計完了を記録する', async () => {
    mGetOrderStatus.mockResolvedValue({ status: 'served', line_account_id: 'acc1' })
    mCanTransition.mockReturnValue(true)
    const res = await app.request(
      '/api/order/admin/orders/o1/status',
      { method: 'PUT', body: JSON.stringify({ status: 'closed' }) },
      { DB: makeDb(null) },
    )
    expect(res.status).toBe(200)
    expect(mUpdateStatus).toHaveBeenCalledWith(expect.anything(), 'o1', 'closed', true)
  })

  it('new → preparing は markPaid=false', async () => {
    mGetOrderStatus.mockResolvedValue({ status: 'new', line_account_id: 'acc1' })
    mCanTransition.mockReturnValue(true)
    await app.request(
      '/api/order/admin/orders/o1/status',
      { method: 'PUT', body: JSON.stringify({ status: 'preparing' }) },
      { DB: makeDb(null) },
    )
    expect(mUpdateStatus).toHaveBeenCalledWith(expect.anything(), 'o1', 'preparing', false)
  })
})

describe('DELETE /api/order/admin/tables/:id（テーブル削除）', () => {
  // run() の meta.changes を差し替えられる DB モック
  function makeDbWithChanges(changes: number) {
    return {
      prepare: () => ({
        bind: () => ({
          first: vi.fn().mockResolvedValue(null),
          all: vi.fn().mockResolvedValue({ results: [] }),
          run: vi.fn().mockResolvedValue({ meta: { changes } }),
        }),
      }),
    } as unknown as D1Database
  }

  it('削除できたら 200 を返す', async () => {
    const res = await app.request(
      '/api/order/admin/tables/t1',
      { method: 'DELETE' },
      { DB: makeDbWithChanges(1) },
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { id: 't1' } })
  })

  it('対象が無ければ 404 table_not_found', async () => {
    const res = await app.request(
      '/api/order/admin/tables/none',
      { method: 'DELETE' },
      { DB: makeDbWithChanges(0) },
    )
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ success: false, error: 'table_not_found' })
  })
})

describe('GET /api/liff/order/me（ユーザーの注文履歴）', () => {
  it('id_token 検証失敗は 401', async () => {
    mResolveAccount.mockResolvedValue('acc1')
    mVerify.mockResolvedValue(null)
    const res = await app.request('/api/liff/order/me?liffId=L1', { method: 'GET' }, { DB: makeDb(null) })
    expect(res.status).toBe(401)
  })

  it('友だち未登録は空配列を返す', async () => {
    mResolveAccount.mockResolvedValue('acc1')
    mVerify.mockResolvedValue('U1')
    mResolveFriend.mockResolvedValue(null)
    const res = await app.request('/api/liff/order/me?liffId=L1', { method: 'GET' }, { DB: makeDb(null) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: [] })
    expect(mListForFriend).not.toHaveBeenCalled()
  })

  it('table トークンが解決できれば、その卓に限定して履歴を返す', async () => {
    mResolveAccount.mockResolvedValue('acc1')
    mVerify.mockResolvedValue('U1')
    mResolveFriend.mockResolvedValue('f1')
    mResolveTable.mockResolvedValue({ id: 'tbl1', table_number: 'A-3' })
    mListForFriend.mockResolvedValue([])
    const res = await app.request('/api/liff/order/me?liffId=L1&table=tok', { method: 'GET' }, { DB: makeDb(null) })
    expect(res.status).toBe(200)
    expect(mListForFriend).toHaveBeenCalledWith(expect.anything(), 'acc1', 'f1', 'tbl1')
  })

  it('table トークンが無効なら空配列（他卓を出さない）', async () => {
    mResolveAccount.mockResolvedValue('acc1')
    mVerify.mockResolvedValue('U1')
    mResolveFriend.mockResolvedValue('f1')
    mResolveTable.mockResolvedValue(null)
    const res = await app.request('/api/liff/order/me?liffId=L1&table=bad', { method: 'GET' }, { DB: makeDb(null) })
    expect(await res.json()).toEqual({ success: true, data: [] })
    expect(mListForFriend).not.toHaveBeenCalled()
  })
})

describe('GET /api/order/admin/tables/:id/orders（伝票確認）', () => {
  it('指定テーブルの注文一覧を返す', async () => {
    mListByTable.mockResolvedValue([])
    const res = await app.request('/api/order/admin/tables/tbl1/orders', { method: 'GET' }, { DB: makeDb(null) })
    expect(res.status).toBe(200)
    expect(mListByTable).toHaveBeenCalledWith(expect.anything(), 'acc1', 'tbl1')
  })
})

describe('GET /api/order/admin/orders（厨房一覧）', () => {
  it('既定で new+preparing を取得する', async () => {
    mListKitchen.mockResolvedValue([])
    const res = await app.request('/api/order/admin/orders', { method: 'GET' }, { DB: makeDb(null) })
    expect(res.status).toBe(200)
    expect(mListKitchen).toHaveBeenCalledWith(expect.anything(), 'acc1', ['new', 'preparing'])
  })
})

describe('POST /api/liff/order/checkout（お客さん側の会計依頼）', () => {
  it('id_token 検証失敗は 401', async () => {
    mResolveAccount.mockResolvedValue('acc1')
    mVerify.mockResolvedValue(null)
    const res = await app.request(
      '/api/liff/order/checkout?liffId=L1',
      { method: 'POST', body: JSON.stringify({ table_token: 't1' }) },
      { DB: makeDb(null) },
    )
    expect(res.status).toBe(401)
  })

  it('友だち未登録は 403 friend_required', async () => {
    mResolveAccount.mockResolvedValue('acc1')
    mVerify.mockResolvedValue('U1')
    mResolveFriend.mockResolvedValue(null)
    const res = await app.request(
      '/api/liff/order/checkout?liffId=L1',
      { method: 'POST', body: JSON.stringify({ table_token: 't1' }) },
      { DB: makeDb(null) },
    )
    expect(res.status).toBe(403)
  })

  it('未提供が残る場合は 409 not_all_served', async () => {
    mResolveAccount.mockResolvedValue('acc1')
    mVerify.mockResolvedValue('U1')
    mResolveFriend.mockResolvedValue('f1')
    mResolveTable.mockResolvedValue({ id: 'tbl1', table_number: 'A-3' })
    mRequestCheckout.mockResolvedValue({ ok: false, error: 'not_all_served' })
    const res = await app.request(
      '/api/liff/order/checkout?liffId=L1',
      { method: 'POST', body: JSON.stringify({ table_token: 't1' }) },
      { DB: makeDb(null) },
    )
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ success: false, error: 'not_all_served' })
  })

  it('正常系: 会計依頼（requestTableCheckout）を呼び件数と合計を返す（会計完了にはしない）', async () => {
    mResolveAccount.mockResolvedValue('acc1')
    mVerify.mockResolvedValue('U1')
    mResolveFriend.mockResolvedValue('f1')
    mResolveTable.mockResolvedValue({ id: 'tbl1', table_number: 'A-3' })
    mRequestCheckout.mockResolvedValue({ ok: true, requested_count: 2, requested_total: 1950 })
    const res = await app.request(
      '/api/liff/order/checkout?liffId=L1',
      { method: 'POST', body: JSON.stringify({ table_token: 't1' }) },
      { DB: makeDb(null) },
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true,
      data: { table_number: 'A-3', requested_count: 2, requested_total: 1950 },
    })
    expect(mRequestCheckout).toHaveBeenCalledWith(expect.anything(), 'acc1', 'tbl1')
    expect(mApproveCheckout).not.toHaveBeenCalled()
  })
})

describe('GET /api/liff/order/me（summary 添付）', () => {
  it('table 解決時はテーブル集計を summary として返す', async () => {
    mResolveAccount.mockResolvedValue('acc1')
    mVerify.mockResolvedValue('U1')
    mResolveFriend.mockResolvedValue('f1')
    mResolveTable.mockResolvedValue({ id: 'tbl1', table_number: 'A-3' })
    mListForFriend.mockResolvedValue([])
    mSummary.mockResolvedValue({ can_checkout: true, unserved_count: 0, open_total: 1200, checkout_requested: true })
    const res = await app.request('/api/liff/order/me?liffId=L1&table=tok', { method: 'GET' }, { DB: makeDb(null) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true,
      data: [],
      summary: { can_checkout: true, unserved_count: 0, open_total: 1200, checkout_requested: true },
    })
    expect(mSummary).toHaveBeenCalledWith(expect.anything(), 'acc1', 'tbl1')
  })
})

describe('POST /api/order/admin/tables/:id/checkout（厨房の会計承認）', () => {
  it('正常系: approveTableCheckout を呼び件数と合計を返す', async () => {
    mApproveCheckout.mockResolvedValue({ ok: true, settled_count: 1, settled_total: 800 })
    const res = await app.request(
      '/api/order/admin/tables/tbl1/checkout',
      { method: 'POST' },
      { DB: makeDb(null) },
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true,
      data: { settled_count: 1, settled_total: 800 },
    })
    expect(mApproveCheckout).toHaveBeenCalledWith(expect.anything(), 'acc1', 'tbl1')
  })

  it('未提供が残れば 409', async () => {
    mApproveCheckout.mockResolvedValue({ ok: false, error: 'not_all_served' })
    const res = await app.request(
      '/api/order/admin/tables/tbl1/checkout',
      { method: 'POST' },
      { DB: makeDb(null) },
    )
    expect(res.status).toBe(409)
  })
})

describe('GET /api/order/admin/sales/today（本日の売上）', () => {
  it('listTodaysSales の結果を返す', async () => {
    mTodaysSales.mockResolvedValue({ orders: [], total: 5400, count: 3 })
    const res = await app.request('/api/order/admin/sales/today', { method: 'GET' }, { DB: makeDb(null) })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, data: { orders: [], total: 5400, count: 3 } })
    expect(mTodaysSales).toHaveBeenCalledWith(expect.anything(), 'acc1')
  })
})
