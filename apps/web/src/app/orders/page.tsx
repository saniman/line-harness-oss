'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '@/lib/api'
import type { DiningTable } from '@/lib/api'
import {
  KITCHEN_COLUMNS,
  nextAction,
  elapsedLabel,
  urgencyLevel,
  type KitchenOrder,
  type OrderStatus,
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
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-200">
                  <th className="py-2">テーブル</th>
                  <th className="py-2">注文URLパラメータ（?table=）</th>
                </tr>
              </thead>
              <tbody>
                {tables.map((t) => (
                  <tr key={t.id} className="border-b border-gray-100">
                    <td className="py-2 font-semibold">{t.table_number}</td>
                    <td className="py-2 font-mono text-xs text-gray-600 break-all">{t.qr_token}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}
