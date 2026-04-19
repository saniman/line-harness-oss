'use client'

import { useState, useEffect, useCallback } from 'react'
import { api, type CalendarConnection } from '@/lib/api'
import Header from '@/components/layout/header'

export default function GoogleCalendarPage() {
  const [connections, setConnections] = useState<CalendarConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [connecting, setConnecting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.googleCalendar.list()
      if (res.success) {
        setConnections(res.data as CalendarConnection[])
      } else {
        setError('接続情報の取得に失敗しました')
      }
    } catch {
      setError('APIに接続できませんでした')
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const handleConnect = async () => {
    setConnecting(true)
    try {
      const res = await api.googleCalendar.getAuthUrl()
      if (res.success && res.data) {
        window.location.href = (res.data as { url: string }).url
      } else {
        setError('認証URLの取得に失敗しました')
      }
    } catch {
      setError('APIに接続できませんでした')
    }
    setConnecting(false)
  }

  const handleDelete = async (id: string) => {
    if (!confirm('この連携を解除しますか？')) return
    try {
      await api.googleCalendar.delete(id)
      load()
    } catch {
      setError('削除に失敗しました')
    }
  }

  return (
    <div>
      <Header
        title="Google Calendar 連携"
        description="予約機能用 Google Calendar の OAuth 接続管理"
        action={
          <button
            onClick={handleConnect}
            disabled={connecting}
            className="px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
            style={{ backgroundColor: '#4285F4' }}
          >
            {connecting ? '接続中...' : '+ Google アカウントで連携'}
          </button>
        }
      />

      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-400">
          読み込み中...
        </div>
      ) : connections.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-400">
          <p className="mb-1">Google Calendar が連携されていません</p>
          <p className="text-xs text-gray-300">「+ Google アカウントで連携」から OAuth 認証してください</p>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {connections.map((conn) => (
            <div key={conn.id} className="bg-white rounded-lg border border-gray-200 p-6">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div
                    className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold text-sm shrink-0"
                    style={{ backgroundColor: '#4285F4' }}
                  >
                    G
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-sm font-bold text-gray-900">
                        {conn.calendarId === 'primary' ? 'プライマリカレンダー' : conn.calendarId}
                      </h3>
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full ${
                          conn.isActive
                            ? 'bg-green-100 text-green-700'
                            : 'bg-gray-100 text-gray-500'
                        }`}
                      >
                        {conn.isActive ? '有効' : '無効'}
                      </span>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-600">
                        {conn.authType === 'oauth' ? 'OAuth' : conn.authType}
                      </span>
                    </div>
                    <p className="text-xs text-gray-400">
                      接続ID:{' '}
                      <code className="bg-gray-100 px-1.5 py-0.5 rounded text-gray-600 select-all">
                        {conn.id}
                      </code>
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => handleDelete(conn.id)}
                  className="text-red-500 hover:text-red-700 text-xs shrink-0"
                >
                  連携解除
                </button>
              </div>
              <p className="text-xs text-gray-400 mt-3 pt-3 border-t border-gray-100">
                連携日: {new Date(conn.createdAt).toLocaleString('ja-JP')}
              </p>
            </div>
          ))}
        </div>
      )}

      <div className="mt-6 p-4 bg-blue-50 border border-blue-100 rounded-lg text-sm text-blue-700">
        <p className="font-medium mb-1">接続IDの使い方</p>
        <p className="text-xs text-blue-600">
          予約フォームや自動化シナリオで Google Calendar を利用する際に、上記の接続IDを指定してください。
        </p>
      </div>
    </div>
  )
}
