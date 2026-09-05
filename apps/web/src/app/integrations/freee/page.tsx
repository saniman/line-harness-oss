'use client'

import { useState, useEffect, useCallback } from 'react'
import { api, type FreeeConnection } from '@/lib/api'
import Header from '@/components/layout/header'

/**
 * freee 連携の接続管理。
 *
 * ⚠️ 認可のコールバックは認証をかけられない公開エンドポイントのため、
 *    第三者が自分の freee 事業所で認可を完走すると、その接続がここに並びうる。
 *    新規接続は「保留」で保存され、**この画面で有効化するまで使われない**。
 *    有効化の前に必ず事業所を確認すること。
 */
export default function FreeePage() {
  const [connections, setConnections] = useState<FreeeConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [busyId, setBusyId] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.freee.list()
      if (res.success) {
        setConnections(res.data as FreeeConnection[])
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
    setError('')
    try {
      const res = await api.freee.getAuthUrl()
      if (res.success && res.data) {
        window.location.href = (res.data as { url: string }).url
      } else {
        setError('認証URLの取得に失敗しました（FREEE_CLIENT_ID の設定漏れかもしれません）')
      }
    } catch {
      setError('APIに接続できませんでした')
    }
    setConnecting(false)
  }

  const handleActivate = async (conn: FreeeConnection) => {
    const label = conn.companyName ?? `事業所ID ${conn.companyId}`
    if (!confirm(
      `「${label}」を有効化しますか？\n\n` +
      `有効化すると、この事業所で領収書が発行されます。\n` +
      `身に覚えのない接続は有効化せず、削除してください。`
    )) return

    setBusyId(conn.id)
    setError('')
    try {
      const res = await api.freee.activate(conn.id)
      if (!res.success) setError('有効化に失敗しました')
      await load()
    } catch {
      setError('有効化に失敗しました')
    }
    setBusyId('')
  }

  const handleDelete = async (conn: FreeeConnection) => {
    if (!confirm('この接続を削除しますか？')) return
    setBusyId(conn.id)
    try {
      await api.freee.delete(conn.id)
      await load()
    } catch {
      setError('削除に失敗しました')
    }
    setBusyId('')
  }

  const hasPending = connections.some((c) => !c.isActive)

  return (
    <div>
      <Header
        title="freee 連携"
        description="現金受領時の領収書自動発行に使う freee アカウントの接続管理"
        action={
          <button
            onClick={handleConnect}
            disabled={connecting}
            className="px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
            style={{ backgroundColor: '#2864F0' }}
          >
            {connecting ? '接続中...' : '+ freee と連携する'}
          </button>
        }
      />

      <div className="p-6">
        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-50 text-red-700 text-sm">{error}</div>
        )}

        {hasPending && (
          <div className="mb-4 p-4 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-sm">
            <p className="font-medium mb-1">⚠️ 有効化の前に事業所を確認してください</p>
            <p>
              認可の入口は誰でも踏めるため、第三者が自分の freee 事業所を登録できる可能性があります。
              <strong>身に覚えのない接続は有効化せず、削除してください。</strong>
              有効化した事業所で領収書が発行されます。
            </p>
          </div>
        )}

        {loading ? (
          <p className="text-sm text-gray-500">読み込み中...</p>
        ) : connections.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-500 bg-white rounded-lg border border-gray-200">
            <p className="mb-2">まだ freee と連携していません。</p>
            <p>右上の「freee と連携する」から接続してください。</p>
          </div>
        ) : (
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="text-left px-4 py-3 font-medium">状態</th>
                  <th className="text-left px-4 py-3 font-medium">事業所</th>
                  <th className="text-left px-4 py-3 font-medium">事業所ID</th>
                  <th className="text-left px-4 py-3 font-medium">接続日時</th>
                  <th className="text-right px-4 py-3 font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {connections.map((conn) => (
                  <tr key={conn.id} className="border-t border-gray-100">
                    <td className="px-4 py-3">
                      {conn.isActive ? (
                        <span className="px-2 py-1 rounded text-xs bg-green-100 text-green-700">✅ 有効</span>
                      ) : (
                        <span className="px-2 py-1 rounded text-xs bg-amber-100 text-amber-700">⏸ 保留</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {conn.companyName ?? <span className="text-gray-400">（名称未取得）</span>}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{conn.companyId}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs">{conn.createdAt}</td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {!conn.isActive && (
                        <button
                          onClick={() => handleActivate(conn)}
                          disabled={busyId === conn.id}
                          className="px-3 py-1 mr-2 rounded text-xs text-white bg-green-600 disabled:opacity-50"
                        >
                          有効化
                        </button>
                      )}
                      <button
                        onClick={() => handleDelete(conn)}
                        disabled={busyId === conn.id}
                        className="px-3 py-1 rounded text-xs text-red-600 border border-red-200 disabled:opacity-50"
                      >
                        削除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-4 text-xs text-gray-500">
          freee のリフレッシュトークンは有効期限が 90 日です。長期間使わないと失効するため、
          その場合は「freee と連携する」からやり直してください。
        </p>
      </div>
    </div>
  )
}
