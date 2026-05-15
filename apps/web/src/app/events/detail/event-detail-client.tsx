'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import type { EventItem, EventBookingItem } from '@/lib/api'
import Header from '@/components/layout/header'

const FIELD_CLASS = 'text-sm border border-gray-300 rounded-lg px-3 py-2 w-full focus:outline-none focus:ring-2 focus:ring-green-500'

function isoToDatetimeLocal(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

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
  const [editing, setEditing] = useState(false)
  const [editForm, setEditForm] = useState({
    title: '', description: '', start_at: '', end_at: '',
    capacity: 10, price: '', is_published: false,
  })
  const [saving, setSaving] = useState(false)
  const [editError, setEditError] = useState('')

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

  const handleEditOpen = () => {
    if (!event) return
    setEditForm({
      title: event.title,
      description: event.description ?? '',
      start_at: isoToDatetimeLocal(event.start_at),
      end_at: isoToDatetimeLocal(event.end_at),
      capacity: event.capacity,
      price: event.price != null && event.price > 0 ? String(event.price) : '',
      is_published: event.is_published === 1,
    })
    setEditError('')
    setEditing(true)
  }

  const handleEditSave = async (e: React.FormEvent) => {
    e.preventDefault()
    const cap = Number(editForm.capacity)
    const priceVal = editForm.price === '' ? null : Number(editForm.price)
    if (!editForm.title.trim()) { setEditError('タイトルを入力してください'); return }
    if (!editForm.start_at || !editForm.end_at) { setEditError('日時を入力してください'); return }
    if (new Date(editForm.start_at) >= new Date(editForm.end_at)) { setEditError('終了日時は開始日時より後にしてください'); return }
    if (!Number.isInteger(cap) || cap < 1) { setEditError('定員は1以上の整数で入力してください'); return }
    if (priceVal !== null && (!Number.isInteger(priceVal) || priceVal < 0)) { setEditError('参加費は0以上の整数で入力してください'); return }
    setSaving(true)
    setEditError('')
    try {
      await api.events.update(eventId, {
        title: editForm.title.trim(),
        description: editForm.description.trim() || undefined,
        start_at: new Date(editForm.start_at).toISOString(),
        end_at: new Date(editForm.end_at).toISOString(),
        capacity: cap,
        price: priceVal != null && priceVal > 0 ? priceVal : null,
        is_published: editForm.is_published ? 1 : 0,
      })
      setEditing(false)
      await load()
    } catch {
      setEditError('保存に失敗しました')
    } finally {
      setSaving(false)
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
              onClick={handleEditOpen}
              className="w-full py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              編集
            </button>
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

      {/* 編集モーダル */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-800">イベントを編集</h2>
              <button
                onClick={() => setEditing(false)}
                className="text-gray-400 hover:text-gray-600 text-lg leading-none"
                aria-label="閉じる"
              >
                ×
              </button>
            </div>
            <form onSubmit={handleEditSave} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  タイトル <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={editForm.title}
                  onChange={(e) => setEditForm((f) => ({ ...f, title: e.target.value }))}
                  className={FIELD_CLASS}
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">説明（任意）</label>
                <textarea
                  value={editForm.description}
                  onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
                  rows={3}
                  className={FIELD_CLASS}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  開始日時 <span className="text-red-500">*</span>
                </label>
                <input
                  type="datetime-local"
                  value={editForm.start_at}
                  onChange={(e) => setEditForm((f) => ({ ...f, start_at: e.target.value }))}
                  className={FIELD_CLASS}
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  終了日時 <span className="text-red-500">*</span>
                </label>
                <input
                  type="datetime-local"
                  value={editForm.end_at}
                  onChange={(e) => setEditForm((f) => ({ ...f, end_at: e.target.value }))}
                  className={FIELD_CLASS}
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  定員 <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  value={editForm.capacity}
                  onChange={(e) => setEditForm((f) => ({ ...f, capacity: Number(e.target.value) }))}
                  min={1}
                  className={FIELD_CLASS}
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">参加費（円）</label>
                <input
                  type="number"
                  value={editForm.price}
                  onChange={(e) => setEditForm((f) => ({ ...f, price: e.target.value }))}
                  min={0}
                  placeholder="空欄 = 無料"
                  className={FIELD_CLASS}
                />
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setEditForm((f) => ({ ...f, is_published: !f.is_published }))}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${editForm.is_published ? 'bg-green-500' : 'bg-gray-300'}`}
                  aria-label="公開設定"
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${editForm.is_published ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
                <span className="text-sm text-gray-600">{editForm.is_published ? '公開' : '非公開'}</span>
              </div>
              {editError && <p className="text-xs text-red-600">{editError}</p>}
              <div className="flex gap-3 pt-2">
                <button
                  type="submit"
                  disabled={saving}
                  className="flex-1 py-2.5 text-sm font-medium text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
                  style={{ backgroundColor: '#06C755' }}
                >
                  {saving ? '保存中...' : '保存する'}
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="flex-1 py-2.5 text-sm font-medium text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  キャンセル
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
