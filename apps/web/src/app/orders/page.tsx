'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '@/lib/api'
import type { DiningTable } from '@/lib/api'
import {
  KITCHEN_COLUMNS,
  STATUS_LABEL,
  nextAction,
  canCheckoutTable,
  elapsedLabel,
  urgencyLevel,
  type KitchenOrder,
  type OrderStatus,
  type TodaysSales,
} from '@/lib/orders'
import Header from '@/components/layout/header'

const POLL_MS = 5000

const URGENCY_CLASS: Record<'normal' | 'warn' | 'late', string> = {
  normal: 'text-gray-500',
  warn: 'text-amber-600 font-bold',
  late: 'text-red-600 font-bold',
}
const COLUMN_BORDER: Record<OrderStatus, string> = {
  new: 'border-l-red-400',
  preparing: 'border-l-amber-400',
  served: 'border-l-green-500',
  closed: 'border-l-gray-300',
  cancelled: 'border-l-gray-300',
}

export default function OrdersPage() {
  const [orders, setOrders] = useState<KitchenOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [updating, setUpdating] = useState<string | null>(null)

  // ポーリングが重ならないよう、進行中の load を抑制する
  const loadingRef = useRef(false)

  const load = useCallback(async () => {
    if (loadingRef.current) return
    loadingRef.current = true
    try {
      const res = await api.orders.list('new,preparing,served')
      if (res.success) {
        setOrders(res.data)
        setError('')
      } else {
        setError('注文の読み込みに失敗しました')
      }
    } catch {
      setError('注文の読み込みに失敗しました')
    } finally {
      loadingRef.current = false
      setLoading(false)
    }
  }, [])

  // 5秒ごとに最新の注文を取得
  useEffect(() => {
    load()
    const id = setInterval(load, POLL_MS)
    return () => clearInterval(id)
  }, [load])

  // 経過時間表示のため1秒ごとに now を更新
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const handleAction = async (order: KitchenOrder) => {
    const action = nextAction(order.status)
    if (!action) return
    setUpdating(order.id)
    try {
      await api.orders.updateStatus(order.id, action.to)
      await load()
    } catch {
      setError('ステータス更新に失敗しました')
    } finally {
      setUpdating(null)
    }
  }

  const byStatus = (status: OrderStatus) =>
    orders.filter((o) => o.status === status)

  return (
    <div>
      <Header
        title="厨房ディスプレイ"
        description="モバイルオーダーの注文をリアルタイムで確認・調理状況を更新できます（5秒ごとに自動更新）"
      />

      <div className="px-6 py-4">
        {error && (
          <div className="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3">
            {error}
          </div>
        )}

        {loading ? (
          <div className="text-gray-500 text-sm py-12 text-center">読み込み中…</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {KITCHEN_COLUMNS.map((col) => {
              const list = byStatus(col.status)
              return (
                <div key={col.status} className="bg-gray-50 rounded-xl p-3">
                  <div className="text-sm font-bold text-gray-600 mb-3 px-1">
                    {col.label}（{list.length}）
                  </div>
                  <div className="flex flex-col gap-3">
                    {list.length === 0 ? (
                      <div className="text-gray-400 text-xs text-center py-8">伝票なし</div>
                    ) : (
                      list.map((order) => {
                        const action = nextAction(order.status)
                        const urgency = urgencyLevel(order.placed_at, now)
                        return (
                          <div
                            key={order.id}
                            className={`bg-white rounded-lg shadow-sm border-l-4 ${COLUMN_BORDER[order.status]} p-3`}
                          >
                            <div className="flex items-center gap-2 mb-2">
                              <span className="text-base font-extrabold text-gray-900">
                                {order.table_number}
                              </span>
                              <span className="text-xs text-gray-400">
                                No.{order.id.slice(0, 6)}
                              </span>
                              <span className={`ml-auto text-sm tabular-nums ${URGENCY_CLASS[urgency]}`}>
                                {elapsedLabel(order.placed_at, now)}
                              </span>
                            </div>

                            <ul className="flex flex-col gap-1 mb-2">
                              {order.items.map((it, i) => (
                                <li key={i} className="text-sm text-gray-800 flex gap-2">
                                  <span className="font-bold text-amber-600 shrink-0">
                                    ×{it.quantity}
                                  </span>
                                  <span>
                                    {it.name_snapshot}
                                    {it.options_text && (
                                      <span className="text-xs text-gray-500"> / {it.options_text}</span>
                                    )}
                                  </span>
                                </li>
                              ))}
                            </ul>

                            {order.customer_note && (
                              <div className="text-xs text-gray-500 bg-gray-50 rounded px-2 py-1 mb-2">
                                📝 {order.customer_note}
                              </div>
                            )}

                            <div className="flex items-center justify-between">
                              <span className="text-xs text-gray-500">
                                合計 ¥{order.total_amount.toLocaleString('ja-JP')}
                                {order.payment_status === 'paid' && (
                                  <span className="ml-1 text-green-600 font-semibold">支払済</span>
                                )}
                              </span>
                              {action && (
                                <button
                                  onClick={() => handleAction(order)}
                                  disabled={updating === order.id}
                                  className="text-sm font-semibold px-3 py-1.5 rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
                                >
                                  {updating === order.id ? '更新中…' : action.label}
                                </button>
                              )}
                            </div>
                          </div>
                        )
                      })
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        <TodaysSalesPanel />
        <TablesPanel />
      </div>
    </div>
  )
}

// テーブル管理（QRトークン発行）。各テーブルの ?table=<qr_token> を QR にして卓に貼る。
function TablesPanel() {
  const [tables, setTables] = useState<DiningTable[]>([])
  const [tableNumber, setTableNumber] = useState('')
  const [creating, setCreating] = useState(false)
  const [open, setOpen] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  // 伝票確認: 開いているテーブルIDと、その注文一覧
  const [slipTableId, setSlipTableId] = useState<string | null>(null)
  const [slipOrders, setSlipOrders] = useState<KitchenOrder[]>([])
  const [slipLoading, setSlipLoading] = useState(false)
  const [checkingOutId, setCheckingOutId] = useState<string | null>(null)

  // テーブル一括会計（現金・店頭会計などお客さんが操作しないケース用）。
  const checkout = async (tableId: string) => {
    if (!window.confirm('このテーブルを会計しますか？（提供済みの伝票がまとめて会計済みになります）')) return
    setCheckingOutId(tableId)
    try {
      const res = await api.orders.tables.checkout(tableId)
      if (res.success) {
        // 伝票表示を最新化（会計済みは厨房ボードから次回ポーリングで消える）。
        const r = await api.orders.tables.orders(tableId)
        if (r.success) setSlipOrders(r.data)
      }
    } finally {
      setCheckingOutId(null)
    }
  }

  const toggleSlip = async (id: string) => {
    if (slipTableId === id) {
      setSlipTableId(null)
      return
    }
    setSlipTableId(id)
    setSlipLoading(true)
    try {
      const res = await api.orders.tables.orders(id)
      if (res.success) setSlipOrders(res.data)
    } catch {
      setSlipOrders([])
    } finally {
      setSlipLoading(false)
    }
  }

  // LIFF の注文URL。LIFF ID はビルド時の NEXT_PUBLIC_LIFF_ID（無ければ本番ID）を使う。
  const LIFF_ID = process.env.NEXT_PUBLIC_LIFF_ID || '1661159603-5qlDj5wV'
  const orderUrl = (token: string) => `https://liff.line.me/${LIFF_ID}?page=order&table=${token}`

  const copy = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedId(id)
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500)
    } catch {
      /* clipboard 不可環境では何もしない */
    }
  }

  const remove = async (id: string, label: string) => {
    if (!window.confirm(`テーブル「${label}」を削除しますか？`)) return
    setDeletingId(id)
    try {
      await api.orders.tables.delete(id)
      await load()
    } finally {
      setDeletingId(null)
    }
  }

  const load = useCallback(async () => {
    try {
      const res = await api.orders.tables.list()
      if (res.success) setTables(res.data)
    } catch {
      /* テーブル取得失敗は致命的でないため握りつぶす */
    }
  }, [])

  useEffect(() => {
    if (open) load()
  }, [open, load])

  const create = async () => {
    if (!tableNumber.trim()) return
    setCreating(true)
    try {
      await api.orders.tables.create(tableNumber.trim())
      setTableNumber('')
      await load()
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="mt-8">
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-sm text-gray-600 hover:text-gray-900 font-medium"
      >
        {open ? '▼' : '▶'} テーブル管理（QR発行）
      </button>
      {open && (
        <div className="mt-3 bg-white rounded-xl border border-gray-200 p-4">
          <div className="flex gap-2 mb-4">
            <input
              value={tableNumber}
              onChange={(e) => setTableNumber(e.target.value)}
              placeholder="テーブル番号（例: A-3）"
              className="text-sm border border-gray-300 rounded-lg px-3 py-2 flex-1 focus:outline-none focus:ring-2 focus:ring-green-500"
            />
            <button
              onClick={create}
              disabled={creating || !tableNumber.trim()}
              className="text-sm font-semibold px-4 py-2 rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
            >
              {creating ? '追加中…' : '追加'}
            </button>
          </div>
          {tables.length === 0 ? (
            <div className="text-gray-400 text-xs">テーブル未登録</div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="text-xs text-gray-500">
                各テーブルの注文URL。これをQRコードにして卓上に貼ってください。
              </div>
              {tables.map((t) => {
                const url = orderUrl(t.qr_token)
                return (
                  <div key={t.id} className="border border-gray-200 rounded-lg p-3">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-bold text-sm">{t.table_number}</span>
                      <span className="ml-auto flex gap-2">
                        <button
                          onClick={() => toggleSlip(t.id)}
                          className="text-xs font-semibold px-3 py-1.5 rounded-md bg-blue-50 text-blue-700 hover:bg-blue-100"
                        >
                          {slipTableId === t.id ? '伝票を閉じる' : '伝票確認'}
                        </button>
                        {/* モバイルで見やすいようコピーはアイコンのみ */}
                        <button
                          onClick={() => copy(url, t.id)}
                          aria-label="注文URLをコピー"
                          title="注文URLをコピー"
                          className="text-sm px-3 py-1.5 rounded-md bg-gray-800 text-white hover:bg-gray-700 min-w-[40px]"
                        >
                          {copiedId === t.id ? '✓' : '📋'}
                        </button>
                        {/* 削除はモバイルではアイコンのみ、md以上で文字併記 */}
                        <button
                          onClick={() => remove(t.id, t.table_number)}
                          disabled={deletingId === t.id}
                          aria-label="テーブルを削除"
                          title="テーブルを削除"
                          className="text-sm px-3 py-1.5 rounded-md bg-red-50 text-red-600 hover:bg-red-100 disabled:opacity-50 min-w-[40px]"
                        >
                          <span className="md:hidden">{deletingId === t.id ? '…' : '🗑'}</span>
                          <span className="hidden md:inline text-xs font-semibold">
                            {deletingId === t.id ? '削除中…' : '削除'}
                          </span>
                        </button>
                      </span>
                    </div>
                    <div className="font-mono text-xs text-gray-600 break-all bg-gray-50 rounded px-2 py-1">
                      {url}
                    </div>
                    {slipTableId === t.id && (
                      <TableSlip
                        loading={slipLoading}
                        orders={slipOrders}
                        checkingOut={checkingOutId === t.id}
                        onCheckout={() => checkout(t.id)}
                      />
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// 伝票確認の時刻フォーマット（UTC ISO → JST HH:MM）。
function fmtSlipTime(iso: string): string {
  const ms = iso.includes('T') ? Date.parse(iso) : Date.parse(iso.replace(' ', 'T') + 'Z')
  if (Number.isNaN(ms)) return ''
  const d = new Date(ms + 9 * 3600_000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

// 伝票（指定テーブルの注文一覧 + 合計 + テーブル一括会計）。テーブル管理から開く。
function TableSlip({ loading, orders, checkingOut, onCheckout }: {
  loading: boolean
  orders: KitchenOrder[]
  checkingOut: boolean
  onCheckout: () => void
}) {
  if (loading) {
    return <div className="mt-2 text-xs text-gray-400">読み込み中…</div>
  }
  if (orders.length === 0) {
    return <div className="mt-2 text-xs text-gray-400">このテーブルの注文はありません</div>
  }
  const grand = orders.reduce((s, o) => s + o.total_amount, 0)
  // 未会計（closed/cancelled 以外）の合計＝今回の会計対象額。
  const openTotal = orders
    .filter((o) => o.status !== 'closed' && o.status !== 'cancelled')
    .reduce((s, o) => s + o.total_amount, 0)
  const canCheckout = canCheckoutTable(orders)
  const hasOpen = openTotal > 0
  return (
    <div className="mt-2 bg-gray-50 rounded-lg p-2">
      {orders.map((o) => (
        <div key={o.id} className="py-1.5 border-b border-gray-200 last:border-0">
          <div className="flex items-center gap-2 text-xs text-gray-500 mb-0.5">
            <span>{fmtSlipTime(o.placed_at)}</span>
            <span className="px-1.5 py-0.5 rounded bg-gray-200 text-gray-700">{STATUS_LABEL[o.status]}</span>
            {o.payment_status === 'paid' && <span className="text-green-600 font-semibold">支払済</span>}
            <span className="ml-auto font-bold text-gray-800">¥{o.total_amount.toLocaleString('ja-JP')}</span>
          </div>
          <ul className="text-xs text-gray-700">
            {o.items.map((it, i) => (
              <li key={i}>
                <span className="text-amber-600 font-bold">×{it.quantity}</span> {it.name_snapshot}
                {it.options_text && <span className="text-gray-400"> / {it.options_text}</span>}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div className="flex justify-between items-baseline pt-2 mt-1 border-t border-gray-300">
        <span className="text-xs text-gray-500">合計（{orders.length}伝票）</span>
        <span className="text-base font-extrabold">¥{grand.toLocaleString('ja-JP')}</span>
      </div>
      {hasOpen && (
        <div className="mt-2">
          <button
            onClick={onCheckout}
            disabled={!canCheckout || checkingOut}
            className="w-full text-sm font-bold px-3 py-2 rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {checkingOut
              ? '会計処理中…'
              : `このテーブルを会計（¥${openTotal.toLocaleString('ja-JP')}）`}
          </button>
          {!canCheckout && (
            <div className="text-xs text-amber-600 mt-1 text-center">
              未提供（調理中・新規）の伝票があるため、まだ会計できません
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// 本日（JST）の売上パネル。会計済み伝票の合計・件数・一覧を表示する。
function TodaysSalesPanel() {
  const [sales, setSales] = useState<TodaysSales | null>(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.orders.salesToday()
      if (res.success) setSales(res.data)
    } catch {
      /* 売上取得失敗は致命的でないため握りつぶす */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) load()
  }, [open, load])

  return (
    <div className="mt-8">
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-sm text-gray-600 hover:text-gray-900 font-medium"
      >
        {open ? '▼' : '▶'} 本日の売上
        {sales && !open && (
          <span className="ml-2 text-green-700 font-bold">
            ¥{sales.total.toLocaleString('ja-JP')}（{sales.count}件）
          </span>
        )}
      </button>
      {open && (
        <div className="mt-3 bg-white rounded-xl border border-gray-200 p-4">
          {loading ? (
            <div className="text-gray-400 text-xs">読み込み中…</div>
          ) : !sales || sales.count === 0 ? (
            <div className="text-gray-400 text-xs">本日の会計済み伝票はまだありません</div>
          ) : (
            <>
              <div className="flex justify-between items-baseline pb-3 mb-3 border-b border-gray-200">
                <span className="text-sm text-gray-500">本日の売上（{sales.count}件）</span>
                <span className="text-2xl font-extrabold text-green-700">
                  ¥{sales.total.toLocaleString('ja-JP')}
                </span>
              </div>
              <div className="flex flex-col gap-1">
                {sales.orders.map((o) => (
                  <div key={o.id} className="flex items-center gap-2 text-xs py-1 border-b border-gray-100 last:border-0">
                    <span className="text-gray-400">{fmtSlipTime(o.placed_at)}</span>
                    <span className="font-bold text-gray-800">{o.table_number}</span>
                    <span className="text-gray-500 truncate">
                      {o.items.map((it) => `${it.name_snapshot}×${it.quantity}`).join('・')}
                    </span>
                    <span className="ml-auto font-bold text-gray-800 shrink-0">
                      ¥{o.total_amount.toLocaleString('ja-JP')}
                    </span>
                  </div>
                ))}
              </div>
              <button onClick={load} className="mt-3 text-xs text-blue-600 hover:text-blue-800">
                ↻ 更新
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
