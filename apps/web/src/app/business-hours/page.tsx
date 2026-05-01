'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import type { BusinessHoursRow, HolidayRow } from '@/lib/api'
import Header from '@/components/layout/header'

const DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土']
const START_HOURS = [6, 7, 8, 9, 10, 11, 12]
const END_HOURS = [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]
const SLOT_OPTIONS = [30, 60, 90, 120]

function BusinessHoursRow({ bh, onSave }: { bh: BusinessHoursRow; onSave: (updated: Partial<BusinessHoursRow>) => Promise<void> }) {
  const [isOpen, setIsOpen] = useState(!!bh.is_open)
  const [startHour, setStartHour] = useState(bh.start_hour)
  const [endHour, setEndHour] = useState(bh.end_hour)
  const [slotMinutes, setSlotMinutes] = useState(bh.slot_minutes)
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave({ is_open: isOpen ? 1 : 0, start_hour: startHour, end_hour: endHour, slot_minutes: slotMinutes })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 py-3 border-b border-gray-100 last:border-0">
      {/* 曜日 */}
      <span className="w-8 text-sm font-semibold text-gray-700">{DAY_NAMES[bh.day_of_week]}</span>

      {/* 営業/休みトグル */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${isOpen ? 'bg-green-500' : 'bg-gray-300'}`}
        aria-label={`${DAY_NAMES[bh.day_of_week]}曜日の営業設定`}
      >
        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${isOpen ? 'translate-x-6' : 'translate-x-1'}`} />
      </button>
      <span className="text-xs text-gray-500 w-8">{isOpen ? '営業' : '休み'}</span>

      {/* 開始・終了時間 */}
      <select
        value={startHour}
        onChange={(e) => setStartHour(Number(e.target.value))}
        disabled={!isOpen}
        className="text-sm border border-gray-300 rounded-lg px-2 py-1.5 bg-white disabled:bg-gray-50 disabled:text-gray-400 focus:outline-none focus:ring-2 focus:ring-green-500"
      >
        {START_HOURS.map(h => <option key={h} value={h}>{h}時</option>)}
      </select>
      <span className="text-sm text-gray-400">〜</span>
      <select
        value={endHour}
        onChange={(e) => setEndHour(Number(e.target.value))}
        disabled={!isOpen}
        className="text-sm border border-gray-300 rounded-lg px-2 py-1.5 bg-white disabled:bg-gray-50 disabled:text-gray-400 focus:outline-none focus:ring-2 focus:ring-green-500"
      >
        {END_HOURS.map(h => <option key={h} value={h}>{h}時</option>)}
      </select>

      {/* スロット時間 */}
      <select
        value={slotMinutes}
        onChange={(e) => setSlotMinutes(Number(e.target.value))}
        disabled={!isOpen}
        className="text-sm border border-gray-300 rounded-lg px-2 py-1.5 bg-white disabled:bg-gray-50 disabled:text-gray-400 focus:outline-none focus:ring-2 focus:ring-green-500"
      >
        {SLOT_OPTIONS.map(m => <option key={m} value={m}>{m}分</option>)}
      </select>

      {/* 保存ボタン */}
      <button
        onClick={handleSave}
        disabled={saving}
        className="px-4 py-1.5 text-sm font-medium text-white rounded-lg disabled:opacity-50 transition-opacity"
        style={{ backgroundColor: '#06C755' }}
      >
        {saving ? '保存中...' : '保存'}
      </button>
    </div>
  )
}

export default function BusinessHoursPage() {
  const [hours, setHours] = useState<BusinessHoursRow[]>([])
  const [holidays, setHolidays] = useState<HolidayRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [newDate, setNewDate] = useState('')
  const [newReason, setNewReason] = useState('')
  const [addingHoliday, setAddingHoliday] = useState(false)
  const [holidayError, setHolidayError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [hoursRes, holidaysRes] = await Promise.all([
        api.businessHours.list(),
        api.businessHours.listHolidays(),
      ])
      if (hoursRes.success) setHours(hoursRes.data)
      else setError('営業時間の読み込みに失敗しました')
      if (holidaysRes.success) setHolidays(holidaysRes.data)
    } catch {
      setError('読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleSave = async (dayOfWeek: number, updates: Partial<BusinessHoursRow>) => {
    try {
      await api.businessHours.update(dayOfWeek, updates)
    } catch {
      setError('保存に失敗しました')
    }
  }

  const handleAddHoliday = async () => {
    if (!newDate) { setHolidayError('日付を入力してください'); return }
    setAddingHoliday(true)
    setHolidayError('')
    try {
      await api.businessHours.addHoliday({ date: newDate, reason: newReason || undefined })
      setNewDate('')
      setNewReason('')
      await load()
    } catch {
      setHolidayError('追加に失敗しました')
    } finally {
      setAddingHoliday(false)
    }
  }

  const handleDeleteHoliday = async (date: string) => {
    if (!window.confirm(`${date} の休業日設定を削除しますか？`)) return
    try {
      await api.businessHours.deleteHoliday(date)
      await load()
    } catch {
      setError('削除に失敗しました')
    }
  }

  return (
    <div>
      <Header title="営業時間設定" description="曜日ごとの営業時間と休業日を管理します" />

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
      )}

      {/* 営業時間設定 */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
        <h2 className="text-sm font-semibold text-gray-700 mb-4">営業時間設定</h2>
        {loading ? (
          <div className="space-y-3">
            {[...Array(7)].map((_, i) => (
              <div key={i} className="flex items-center gap-3 py-3 border-b border-gray-100 animate-pulse">
                <div className="h-4 w-6 bg-gray-200 rounded" />
                <div className="h-6 w-11 bg-gray-200 rounded-full" />
                <div className="h-8 w-20 bg-gray-100 rounded-lg" />
                <div className="h-8 w-20 bg-gray-100 rounded-lg" />
                <div className="h-8 w-20 bg-gray-100 rounded-lg" />
                <div className="h-8 w-14 bg-gray-100 rounded-lg" />
              </div>
            ))}
          </div>
        ) : (
          <div>
            {hours.map((bh) => (
              <BusinessHoursRow
                key={bh.day_of_week}
                bh={bh}
                onSave={(updates) => handleSave(bh.day_of_week, updates)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 休業日設定 */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 className="text-sm font-semibold text-gray-700 mb-4">休業日設定</h2>

        {/* 追加フォーム */}
        <div className="flex flex-col sm:flex-row gap-2 mb-4">
          <input
            type="date"
            value={newDate}
            onChange={(e) => { setNewDate(e.target.value); setHolidayError('') }}
            className="text-sm border border-gray-300 rounded-lg px-3 py-2 min-h-[42px] focus:outline-none focus:ring-2 focus:ring-green-500"
          />
          <input
            type="text"
            value={newReason}
            onChange={(e) => setNewReason(e.target.value)}
            placeholder="理由（任意）"
            className="flex-1 text-sm border border-gray-300 rounded-lg px-3 py-2 min-h-[42px] focus:outline-none focus:ring-2 focus:ring-green-500"
          />
          <button
            onClick={handleAddHoliday}
            disabled={addingHoliday || !newDate}
            className="px-5 py-2 min-h-[42px] text-sm font-medium text-white rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
            style={{ backgroundColor: '#3B82F6' }}
          >
            {addingHoliday ? '追加中...' : '追加'}
          </button>
        </div>
        {holidayError && <p className="mb-3 text-sm text-red-600">{holidayError}</p>}

        {/* 休業日一覧 */}
        {loading ? (
          <div className="space-y-2">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-10 bg-gray-100 rounded-lg animate-pulse" />
            ))}
          </div>
        ) : holidays.length === 0 ? (
          <p className="text-sm text-gray-500">休業日が登録されていません。</p>
        ) : (
          <div className="divide-y divide-gray-100">
            {holidays.map((h) => (
              <div key={h.date} className="flex items-center justify-between py-2.5">
                <div>
                  <span className="text-sm font-medium text-gray-900">{h.date}</span>
                  {h.reason && <span className="ml-2 text-xs text-gray-500">{h.reason}</span>}
                </div>
                <button
                  onClick={() => handleDeleteHoliday(h.date)}
                  className="text-xs text-red-500 hover:text-red-700 px-2 py-1 rounded hover:bg-red-50 transition-colors"
                >
                  削除
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
