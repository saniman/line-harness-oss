'use client'

import { useState, useEffect, useCallback } from 'react'
import { fetchApi } from '@/lib/api'
import { formatJST, getBookingName, STATUS_LABEL, STATUS_CLASS } from '@/lib/bookings'
import type { Booking, BookingStatus } from '@/lib/bookings'
import Header from '@/components/layout/header'

const CONNECTION_ID = '0ba404af-3184-4640-bb56-d24c37c1f230'

type FilterStatus = 'all' | BookingStatus

export default function BookingsPage() {
  const [bookings, setBookings] = useState<Booking[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<FilterStatus>('all')

  const loadBookings = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetchApi<{ success: boolean; data: Booking[]; error?: string }>(
        `/api/integrations/google-calendar/bookings?connectionId=${CONNECTION_ID}`
      )
      if (res.success) {
        const sorted = [...res.data].sort(
          (a, b) => new Date(b.startAt).getTime() - new Date(a.startAt).getTime()
        )
        setBookings(sorted)
      } else {
        setError(res.error ?? '予約の読み込みに失敗しました。')
      }
    } catch {
      setError('予約の読み込みに失敗しました。もう一度お試しください。')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadBookings()
  }, [loadBookings])

  const filtered = filter === 'all' ? bookings : bookings.filter((b) => b.status === filter)

  return (
    <div>
      <Header title="予約一覧" />

      {/* フィルター */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3 mb-4">
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600 font-medium whitespace-nowrap">ステータス:</label>
          <select
            className="text-sm border border-gray-300 rounded-lg px-3 py-2 min-h-[44px] bg-white focus:outline-none focus:ring-2 focus:ring-green-500"
            value={filter}
            onChange={(e) => setFilter(e.target.value as FilterStatus)}
          >
            <option value="all">すべて</option>
            <option value="confirmed">確定のみ</option>
            <option value="cancelled">キャンセルのみ</option>
          </select>
        </div>
        <span className="text-sm text-gray-500">
          {loading ? '読み込み中...' : `${filtered.length} 件`}
        </span>
      </div>

      {/* エラー */}
      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* ローディング */}
      {loading ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="px-4 py-4 border-b border-gray-100 flex items-center gap-4 animate-pulse">
              <div className="flex-1 space-y-2">
                <div className="h-3 bg-gray-200 rounded w-32" />
                <div className="h-2 bg-gray-100 rounded w-48" />
              </div>
              <div className="h-5 bg-gray-100 rounded-full w-16" />
              <div className="h-3 bg-gray-100 rounded w-20" />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center text-gray-400 text-sm">
          予約がありません
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          {/* テーブルヘッダー（デスクトップ） */}
          <div className="hidden sm:grid sm:grid-cols-[1fr_1fr_160px_120px_100px] gap-4 px-4 py-3 bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wider">
            <span>予約者</span>
            <span>予約日時</span>
            <span>メールアドレス</span>
            <span>ステータス</span>
            <span>カレンダー</span>
          </div>

          {filtered.map((booking) => {
            const name = getBookingName(booking)
            const email = booking.metadata?.email ?? '—'
            return (
              <div
                key={booking.id}
                className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_160px_120px_100px] gap-1 sm:gap-4 px-4 py-4 border-b border-gray-100 last:border-0 hover:bg-gray-50 transition-colors"
              >
                {/* 予約者 */}
                <div>
                  <p className="text-sm font-medium text-gray-900">{name}</p>
                  <p className="text-xs text-gray-400 sm:hidden">{formatJST(booking.startAt)}</p>
                </div>

                {/* 予約日時 */}
                <div className="hidden sm:block">
                  <p className="text-sm text-gray-700">{formatJST(booking.startAt)}</p>
                  <p className="text-xs text-gray-400">〜{formatJST(booking.endAt).slice(11)}</p>
                </div>

                {/* メールアドレス */}
                <div className="hidden sm:block">
                  <p className="text-sm text-gray-600 truncate">{email}</p>
                </div>

                {/* ステータスバッジ */}
                <div className="flex items-center">
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_CLASS[booking.status as BookingStatus] ?? 'bg-gray-100 text-gray-500'}`}>
                    {STATUS_LABEL[booking.status as BookingStatus] ?? booking.status}
                  </span>
                </div>

                {/* Google Calendar連携 */}
                <div className="flex items-center">
                  {booking.eventId ? (
                    <span className="text-xs text-green-600 font-medium">📅 連携済み</span>
                  ) : (
                    <span className="text-xs text-gray-400">未連携</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
