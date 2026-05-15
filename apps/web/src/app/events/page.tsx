'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import type { EventItem } from '@/lib/api'
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

function validateForm(data: { title: string; start_at: string; end_at: string; capacity: number; price: number | null }): string | null {
  if (!data.title.trim()) return 'タイトルを入力してください'
  if (!data.start_at) return '開始日時を入力してください'
  if (!data.end_at) return '終了日時を入力してください'
  if (new Date(data.start_at) >= new Date(data.end_at)) return '終了日時は開始日時より後にしてください'
  if (!Number.isInteger(data.capacity) || data.capacity < 1) return '定員は1以上の整数で入力してください'
  if (data.price !== null && (!Number.isInteger(data.price) || data.price < 0)) return '参加費は0以上の整数で入力してください'
  return null
}

const FIELD_CLASS = 'text-sm border border-gray-300 rounded-lg px-3 py-2 w-full focus:outline-none focus:ring-2 focus:ring-green-500'

export default function EventsPage() {
  const router = useRouter()
  const [events, setEvents] = useState<EventItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState<number | null>(null)

  // 作成フォーム
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [startAt, setStartAt] = useState('')
  const [endAt, setEndAt] = useState('')
  const [capacity, setCapacity] = useState(10)
  const [price, setPrice] = useState<string>('')
  const [isPublished, setIsPublished] = useState(false)
  const [creating, setCreating] = useState(false)
  const [formError, setFormError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.events.list()
      if (res.success) setEvents(res.data)
      else setError('イベントの読み込みに失敗しました')
    } catch {
      setError('イベントの読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    const cap = Number(capacity)
    const priceVal = price === '' ? null : Number(price)
    const err = validateForm({ title, start_at: startAt, end_at: endAt, capacity: cap, price: priceVal })
    if (err) { setFormError(err); return }
    setCreating(true)
    setFormError('')
    try {
      await api.events.create({
        title: title.trim(),
        description: description.trim() || undefined,
        start_at: new Date(startAt).toISOString(),
        end_at: new Date(endAt).toISOString(),
        capacity: cap,
        price: priceVal ?? undefined,
        is_published: isPublished ? 1 : 0,
      })
      setTitle('')
      setDescription('')
      setStartAt('')
      setEndAt('')
      setCapacity(10)
      setPrice('')
      setIsPublished(false)
      await load()
    } catch {
      setFormError('作成に失敗しました')
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async (event: EventItem) => {
    if (!window.confirm(`「${event.title}」を削除しますか？\n参加申込データも全て削除されます。`)) return
    setDeleting(event.id)
    try {
      await api.events.delete(event.id)
      await load()
    } catch {
      setError('削除に失敗しました')
    } finally {
      setDeleting(null)
    }
  }

  return (
    <div>
      <Header title="イベント管理" description="定員制イベントの作成・管理ができます" />

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6">
        {/* イベント一覧 */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-gray-500">
              {loading ? '読み込み中...' : `${events.length} 件`}
            </span>
          </div>

          {loading ? (
            <div className="space-y-3">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="bg-white rounded-lg border border-gray-200 p-4 animate-pulse">
                  <div className="h-4 bg-gray-200 rounded w-40 mb-2" />
                  <div className="h-3 bg-gray-100 rounded w-56" />
                </div>
              ))}
            </div>
          ) : events.length === 0 ? (
            <div className="bg-white rounded-lg border border-gray-200 p-12 text-center text-gray-400 text-sm">
              イベントがありません。右のフォームから作成してください。
            </div>
          ) : (
            <div className="space-y-3">
              {events.map((ev) => {
                const full = ev.participant_count >= ev.capacity
                return (
                  <div key={ev.id} className="bg-white rounded-lg border border-gray-200 p-4 hover:border-gray-300 transition-colors">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2 mb-1">
                          <span className="text-sm font-semibold text-gray-900 truncate">{ev.title}</span>
                          {ev.is_published === 1 ? (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">公開</span>
                          ) : (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500">非公開</span>
                          )}
                          {full && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-600">満席</span>
                          )}
                        </div>
                        <p className="text-xs text-gray-500">
                          {formatJST(ev.start_at)} 〜 {formatJST(ev.end_at)}
                        </p>
                        <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
                          <span>定員 {ev.capacity}名</span>
                          <span>参加 {ev.participant_count}名</span>
                          <span className={full ? 'text-red-500 font-medium' : 'text-green-600'}>
                            残席 {ev.remaining}名
                          </span>
                          <span>{ev.price != null && ev.price > 0 ? `¥${ev.price.toLocaleString()}` : '無料'}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => router.push(`/events/detail?id=${ev.id}`)}
                          className="px-3 py-1.5 text-xs font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
                        >
                          詳細
                        </button>
                        <button
                          onClick={() => handleDelete(ev)}
                          disabled={deleting === ev.id}
                          className="px-3 py-1.5 text-xs font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                          {deleting === ev.id ? '削除中...' : '削除'}
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* 作成フォーム */}
        <div>
          <div className="bg-white rounded-lg border border-gray-200 p-5">
            <h2 className="text-sm font-semibold text-gray-700 mb-4">イベントを作成</h2>
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  タイトル <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="無料セミナー"
                  className={FIELD_CLASS}
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">説明（任意）</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="イベントの詳細を入力してください"
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
                  value={startAt}
                  onChange={(e) => setStartAt(e.target.value)}
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
                  value={endAt}
                  onChange={(e) => setEndAt(e.target.value)}
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
                  value={capacity}
                  onChange={(e) => setCapacity(Number(e.target.value))}
                  min={1}
                  className={FIELD_CLASS}
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">参加費（円）</label>
                <input
                  type="number"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  min={0}
                  placeholder="空欄 = 無料"
                  className={FIELD_CLASS}
                />
                <p className="text-xs text-gray-400 mt-1">Stripe決済が必要な場合は金額を入力してください</p>
              </div>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setIsPublished(!isPublished)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${isPublished ? 'bg-green-500' : 'bg-gray-300'}`}
                  aria-label="公開設定"
                >
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${isPublished ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
                <span className="text-sm text-gray-600">{isPublished ? '公開' : '非公開'}</span>
              </div>

              {formError && (
                <p className="text-xs text-red-600">{formError}</p>
              )}

              <button
                type="submit"
                disabled={creating}
                className="w-full py-2.5 text-sm font-medium text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
                style={{ backgroundColor: '#06C755' }}
              >
                {creating ? '作成中...' : '作成する'}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  )
}
