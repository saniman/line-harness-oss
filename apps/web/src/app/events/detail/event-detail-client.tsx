'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import type { EventItem, EventBookingItem } from '@/lib/api'
import Header from '@/components/layout/header'

function formatJST(iso: string): string {
  const d = new Date(iso)
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000)
  const mm = String(jst.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(jst.getUTCDate()).padStart(2, '0')
  const hh = String(jst.getUTCHours()).padStart(2, '0')
  const min = String(jst.getUTCMinutes()).padStart(2, '0')
  const weekdays = ['日', '月', '火', '水', '木', '金', '土']
  const dow = weekdays[jst.getUTCDay()]
  return `${mm}/${dd}(${dow}) ${hh}:${min}`
}

export default function EventDetailClient({ eventId }: { eventId: number }) {
  const router = useRouter()
  const [event, setEvent] = useState<EventItem | null>(null)
  const [bookings, setBookings] = useState<EventBookingItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [toggling, setToggling] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [evRes, bRes] = await Promise.all([
        api.events.get(eventId),
        api.events.getBookings(eventId),
      ])
      if (evRes.success) setEvent(evRes.data)
      else setError('イベントの読み込みに失敗しました')
      if (bRes.success) setBookings(bRes.data)
    } catch {
      setError('読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [eventId])

  useEffect(() => { load() }, [load])

  const handleTogglePublish = async () => {
    if (!event) return
    setToggling(true)
    try {
      await api.events.update(eventId, { is_published: event.is_published === 1 ? 0 : 1 })
      await load()
    } catch {
      setError('更新に失敗しました')
    } finally {
      setToggling(false)
    }
  }

  const handleDelete = async () => {
    if (!event) return
    if (!window.confirm(`「${event.title}」を削除しますか？\n参加申込データも全て削除されます。`)) return
    setDeleting(true)
    try {
      await api.events.delete(eventId)
      router.push('/events')
    } catch {
      setError('削除に失敗しました')
      setDeleting(false)
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-8 bg-gray-200 rounded w-48 animate-pulse" />
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-24 bg-gray-100 rounded-lg animate-pulse" />
        ))}
      </div>
    )
  }

  if (!event) {
    return (
      <div>
        <p className="text-sm text-gray-500">イベントが見つかりません。</p>
        <button onClick={() => router.push('/events')} className="mt-4 text-sm text-green-600 hover:underline">
          一覧に戻る
        </button>
      </div>
    )
  }

  const full = event.participant_count >= event.capacity

  return (
    <div>
      <Header title={event.title} description="イベント詳細・参加者一覧" />

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-6">
        {/* 参加者一覧 */}
        <div>
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-700">参加者一覧</h2>
              <span className="text-xs text-gray-500">{bookings.length} 名</span>
            </div>

            {bookings.length === 0 ? (
              <div className="p-8 text-center text-sm text-gray-400">参加申込はまだありません</div>
            ) : (
              <>
                <div className="hidden sm:grid sm:grid-cols-[1fr_100px_100px_80px_140px] gap-4 px-4 py-2 bg-gray-50 border-b border-gray-100 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  <span>参加者</span>
                  <span>ステータス</span>
                  <span>決済</span>
                  <span>金額</span>
                  <span>申込日時</span>
                </div>
                {bookings.map((b) => {
                  const paymentBadge = (() => {
                    if (b.payment_status === 'paid') return { label: '💳 決済済', cls: 'bg-green-100 text-green-700' }
                    if (b.payment_status === 'unpaid' && b.status === 'pending') return { label: '⏳ 未決済', cls: 'bg-yellow-100 text-yellow-700' }
                    if (b.status === 'cancelled') return { label: '❌ キャンセル', cls: 'bg-gray-100 text-gray-500' }
                    return { label: '確定', cls: 'bg-green-100 text-green-700' }
                  })()
                  return (
                    <div
                      key={b.id}
                      className="grid grid-cols-1 sm:grid-cols-[1fr_100px_100px_80px_140px] gap-1 sm:gap-4 px-4 py-3 border-b border-gray-100 last:border-0 hover:bg-gray-50 transition-colors"
                    >
                      <div>
                        <p className="text-sm font-medium text-gray-900">{b.name}</p>
                        <p className="text-xs text-gray-400 truncate">{b.email}</p>
                      </div>
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700 w-fit self-center">
                        {b.status === 'confirmed' ? '確定' : b.status === 'pending' ? '保留' : 'キャンセル'}
                      </span>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium w-fit self-center ${paymentBadge.cls}`}>
                        {paymentBadge.label}
                      </span>
                      <p className="text-sm text-gray-700 self-center">
                        {b.amount != null ? `¥${b.amount.toLocaleString()}` : '—'}
                      </p>
                      <p className="text-xs text-gray-400 self-center">{formatJST(b.created_at)}</p>
                    </div>
                  )
                })}
              </>
            )}
          </div>
        </div>

        {/* イベント情報・操作 */}
        <div className="space-y-4">
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">イベント情報</h2>
            <dl className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <dt className="text-gray-500 w-16 shrink-0">開始</dt>
                <dd className="text-gray-900">{formatJST(event.start_at)}</dd>
              </div>
              <div className="flex items-center gap-2">
                <dt className="text-gray-500 w-16 shrink-0">終了</dt>
                <dd className="text-gray-900">{formatJST(event.end_at)}</dd>
              </div>
              <div className="flex items-center gap-2">
                <dt className="text-gray-500 w-16 shrink-0">定員</dt>
                <dd className="text-gray-900">{event.capacity} 名</dd>
              </div>
              <div className="flex items-center gap-2">
                <dt className="text-gray-500 w-16 shrink-0">参加</dt>
                <dd className="text-gray-900">{event.participant_count} 名</dd>
              </div>
              <div className="flex items-center gap-2">
                <dt className="text-gray-500 w-16 shrink-0">残席</dt>
                <dd className={full ? 'text-red-500 font-medium' : 'text-green-600'}>
                  {full ? '満席' : `${event.remaining} 名`}
                </dd>
              </div>
              <div className="flex items-center gap-2">
                <dt className="text-gray-500 w-16 shrink-0">参加費</dt>
                <dd className="text-gray-900">
                  {event.price != null && event.price > 0 ? `¥${event.price.toLocaleString()}` : '無料'}
                </dd>
              </div>
              {event.description && (
                <div className="pt-2 border-t border-gray-100">
                  <dt className="text-gray-500 mb-1">説明</dt>
                  <dd className="text-gray-700 text-xs whitespace-pre-wrap">{event.description}</dd>
                </div>
              )}
            </dl>
          </div>

          <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
            <h2 className="text-sm font-semibold text-gray-700">操作</h2>
            <button
              onClick={handleTogglePublish}
              disabled={toggling}
              className="w-full py-2 text-sm font-medium border rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              style={event.is_published === 1
                ? { borderColor: '#d1d5db', color: '#4b5563' }
                : { backgroundColor: '#06C755', borderColor: '#06C755', color: '#fff' }
              }
            >
              {toggling ? '更新中...' : event.is_published === 1 ? '非公開にする' : '公開する'}
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="w-full py-2 text-sm font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {deleting ? '削除中...' : 'イベントを削除'}
            </button>
            <button
              onClick={() => router.push('/events')}
              className="w-full py-2 text-sm text-gray-500 hover:text-gray-700 transition-colors"
            >
              ← 一覧に戻る
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
