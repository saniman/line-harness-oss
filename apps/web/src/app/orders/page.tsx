'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '@/lib/api'
import type { DiningTable } from '@/lib/api'
import {
  STATUS_LABEL,
  nextAction,
  canCheckoutTable,
  groupOrdersByTable,
  splitItemsByGroup,
  elapsedLabel,
  urgencyLevel,
  type KitchenOrder,
  type KitchenOrderItem,
  type TableGroup,
  type TodaysSales,
} from '@/lib/orders'
import Header from '@/components/layout/header'

const POLL_MS = 5000

const URGENCY_CLASS: Record<'normal' | 'warn' | 'late', string> = {
  normal: 'text-gray-500',
  warn: 'text-amber-600 font-bold',
  late: 'text-red-600 font-bold',
}

export default function OrdersPage() {
  const [orders, setOrders] = useState<KitchenOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [serving, setServing] = useState<string | null>(null)
  const [checkingOut, setCheckingOut] = useState<string | null>(null)

  // ポーリングが重ならないよう、進行中の load を抑制する
  const loadingRef = useRef(false)

  // active な注文（新規・提供済み）のみ取得。会計済み(closed)は本日の売上で見る。
  const load = useCallback(async () => {
    if (loadingRef.current) return
    loadingRef.current = true
    try {
      const res = await api.orders.list('new,served')
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

  const handleServe = async (order: KitchenOrder) => {
    setServing(order.id)
    try {
      await api.orders.updateStatus(order.id, 'served')
      await load()
    } catch {
      setError('ステータス更新に失敗しました')
    } finally {
      setServing(null)
    }
  }

  const handleCheckout = async (tableId: string) => {
    if (!window.confirm('このテーブルを会計しますか？（提供済みの伝票がまとめて会計済みになります）')) return
    setCheckingOut(tableId)
    try {
      const res = await api.orders.tables.checkout(tableId)
      if (!res.success) setError('会計に失敗しました')
      await load()
    } catch {
      setError('会計に失敗しました')
    } finally {
      setCheckingOut(null)
    }
  }

  const groups = groupOrdersByTable(orders)

  return (
    <div>
      <Header
        title="厨房ディスプレイ"
        description="テーブルごとの注文をリアルタイムで確認・提供・会計できます（5秒ごとに自動更新）"
      />

      <div className="px-6 py-4">
        {error && (
          <div className="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3">
            {error}
          </div>
        )}

        {loading ? (
          <div className="text-gray-500 text-sm py-12 text-center">読み込み中…</div>
        ) : groups.length === 0 ? (
          <div className="text-gray-400 text-sm py-12 text-center">
            現在ご注文中のテーブルはありません
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {groups.map((g) => (
              <TableCard
                key={g.table_id ?? g.table_number}
                group={g}
                now={now}
                serving={serving}
                checkingOut={checkingOut === g.table_id}
                onServe={handleServe}
                onCheckout={handleCheckout}
              />
            ))}
          </div>
        )}

        <TodaysSalesPanel />
        <TablesPanel />
      </div>
    </div>
  )
}

// 1テーブルのカード。そのテーブルの active 注文（伝票）を上から並べ、提供・会計操作を持つ。
function TableCard({ group, now, serving, checkingOut, onServe, onCheckout }: {
  group: TableGroup
  now: number
  serving: string | null
  checkingOut: boolean
  onServe: (order: KitchenOrder) => void
  onCheckout: (tableId: string) => void
}) {
  const requested = group.orders.some((o) => o.checkout_requested_at)
  const openTotal = group.orders.reduce((s, o) => s + o.total_amount, 0)
  const canCheckout = canCheckoutTable(group.orders)
  const borderClass = requested ? 'border-amber-400' : 'border-gray-200'

  return (
    <div className={`bg-white rounded-xl shadow-sm border ${borderClass} flex flex-col`}>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100">
        <span className="text-lg font-extrabold text-gray-900">{group.table_number}</span>
        {requested && (
          <span className="text-xs font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-300">
            🧾 会計依頼中
          </span>
        )}
        <span className="ml-auto text-xs text-gray-500">
          {group.orders.length}伝票 / ¥{openTotal.toLocaleString('ja-JP')}
        </span>
      </div>

      <div className="flex flex-col gap-2 p-3">
        {group.orders.map((order) => (
          <OrderSlip
            key={order.id}
            order={order}
            now={now}
            serving={serving === order.id}
            onServe={() => onServe(order)}
          />
        ))}
      </div>

      <div className="px-3 pb-3 mt-auto">
        {requested && (
          <div className="text-xs font-bold text-amber-700 mb-1 text-center">
            🧾 お客様から会計依頼が来ています
          </div>
        )}
        <button
          onClick={() => group.table_id && onCheckout(group.table_id)}
          disabled={!canCheckout || checkingOut || !group.table_id}
          className="w-full text-sm font-bold px-3 py-2 rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {checkingOut
            ? '会計処理中…'
            : requested
              ? `会計を承認（¥${openTotal.toLocaleString('ja-JP')}）`
              : `このテーブルを会計（¥${openTotal.toLocaleString('ja-JP')}）`}
        </button>
        {!canCheckout && (
          <div className="text-xs text-amber-600 mt-1 text-center">
            未提供の伝票があるため、まだ会計できません
          </div>
        )}
      </div>
    </div>
  )
}

// 1伝票（注文）。明細をドリンク/お食事に分けて表示し、新規なら「提供済みにする」操作。
function OrderSlip({ order, now, serving, onServe }: {
  order: KitchenOrder
  now: number
  serving: boolean
  onServe: () => void
}) {
  const urgency = urgencyLevel(order.placed_at, now)
  const { drink, food } = splitItemsByGroup(order.items)
  const isNew = order.status === 'new'
  return (
    <div className={`rounded-lg border-l-4 ${isNew ? 'border-l-red-400 bg-red-50/40' : 'border-l-green-500 bg-green-50/30'} p-2`}>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-bold px-1.5 py-0.5 rounded bg-gray-200 text-gray-700">
          {STATUS_LABEL[order.status]}
        </span>
        <span className="text-xs text-gray-400">No.{order.id.slice(0, 6)}</span>
        <span className={`ml-auto text-sm tabular-nums ${URGENCY_CLASS[urgency]}`}>
          {elapsedLabel(order.placed_at, now)}
        </span>
      </div>

      {drink.length > 0 && <ItemGroup label="🍷 ドリンク" items={drink} />}
      {food.length > 0 && <ItemGroup label="🍽 お食事" items={food} />}

      {order.customer_note && (
        <div className="text-xs text-gray-500 bg-gray-50 rounded px-2 py-1 mt-1">
          📝 {order.customer_note}
        </div>
      )}

      <div className="flex items-center justify-between mt-1.5">
        <span className="text-xs text-gray-500">¥{order.total_amount.toLocaleString('ja-JP')}</span>
        {isNew ? (
          <button
            onClick={onServe}
            disabled={serving}
            className="text-sm font-semibold px-3 py-1.5 rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
          >
            {serving ? '更新中…' : '提供済みにする'}
          </button>
        ) : (
          <span className="text-xs text-green-700 font-semibold">✅ 提供済み</span>
        )}
      </div>
    </div>
  )
}

// 伝票内の明細グループ（ドリンク/お食事の小見出し付き）。
function ItemGroup({ label, items }: { label: string; items: KitchenOrderItem[] }) {
  return (
    <div className="mb-1">
      <div className="text-[11px] font-bold text-gray-500">{label}</div>
      <ul className="flex flex-col gap-0.5">
        {items.map((it, i) => (
          <li key={i} className="text-sm text-gray-800 flex gap-2">
            <span className="font-bold text-amber-600 shrink-0">×{it.quantity}</span>
            <span>
              {it.name_snapshot}
              {it.options_text && <span className="text-xs text-gray-500"> / {it.options_text}</span>}
            </span>
          </li>
        ))}
      </ul>
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

// 伝票/売上の時刻フォーマット（UTC ISO → JST HH:MM）。
function fmtSlipTime(iso: string): string {
  const ms = iso.includes('T') ? Date.parse(iso) : Date.parse(iso.replace(' ', 'T') + 'Z')
  if (Number.isNaN(ms)) return ''
  const d = new Date(ms + 9 * 3600_000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
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
