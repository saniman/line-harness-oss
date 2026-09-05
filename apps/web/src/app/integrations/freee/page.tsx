'use client'

import { useState, useEffect, useCallback } from 'react'
import { api, type FreeeConnection } from '@/lib/api'
import { buildConnectionLabel, sanitizeCompanyName, needsReauth } from '@/lib/freee-label'
import { formatJSTWithYear } from '@/lib/format-jst'
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

  /**
   * 一覧を読み直す。
   *
   * ⚠️ `clearError: false` を渡せる形にしてあるのは、呼び出し側の catch で立てた
   *    エラーをここが消してしまうため。`setError(...)` と `setError('')` の間に
   *    await が挟まらないと React の自動バッチングで同じコミットに合流し、
   *    後勝ちで空文字が採用されてエラーが一度も表示されない。
   */
  const load = useCallback(async (opts: { clearError?: boolean } = {}) => {
    const { clearError = true } = opts
    setLoading(true)
    if (clearError) setError('')
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
    // ⚠️ 事業所名は第三者が freee 側で決められる文字列。改行を詰めて警告文を
    //    押し出したり、偽の安心文を混ぜたりできるため、そのまま出さない。
    //    改ざんできない事業所IDを必ず併記する。
    const label = buildConnectionLabel(conn.companyName, conn.companyId)
    if (!confirm(
      `有効化すると、以下の事業所で領収書が発行されます。\n` +
      `身に覚えのない接続は有効化せず、削除してください。\n\n` +
      `${label}\n\n` +
      `有効化しますか？`
    )) return

    setBusyId(conn.id)
    setError('')
    try {
      const res = await api.freee.activate(conn.id)
      if (!res.success) setError('有効化に失敗しました')
    } catch {
      // 403（権限不足）や 404（既に消えている）も例外で来る
      setError('有効化できませんでした。権限があるか、接続が残っているかご確認ください。')
    }
    // 一覧は最新に合わせ直すが、上で立てたエラーは消さない
    await load({ clearError: false })
    setBusyId('')
  }

  const handleDelete = async (conn: FreeeConnection) => {
    const label = buildConnectionLabel(conn.companyName, conn.companyId)
    const warning = conn.isActive
      ? '\n\n⚠️ この接続は現在有効です。削除すると領収書の自動発行が止まります。'
      : ''
    if (!confirm(`以下の接続を削除しますか？\n\n${label}${warning}`)) return
    setBusyId(conn.id)
    setError('')
    try {
      await api.freee.delete(conn.id)
    } catch {
      // 404（既に消えている）でも fetchApi は例外を投げる。
      // ここで再読込を止めると、消えたはずの行が画面に残り続ける
      // ——「古いタブ」対策として 404 を返した意味が無くなる。
      setError('削除できませんでした。最新の状態を読み込みます。')
    }
    // 成否にかかわらずサーバーの状態に合わせ直す（エラーは消さない）
    await load({ clearError: false })
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
                        needsReauth(conn.tokenExpiresAt) ? (
                          // 失効しても is_active は落とさない設計なので、期限で判断する
                          <span className="px-2 py-1 rounded text-xs bg-red-100 text-red-700">⚠️ 要再連携</span>
                        ) : (
                          <span className="px-2 py-1 rounded text-xs bg-green-100 text-green-700">✅ 有効</span>
                        )
                      ) : (
                        <span className="px-2 py-1 rounded text-xs bg-amber-100 text-amber-700">⏸ 保留</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {sanitizeCompanyName(conn.companyName) ?? (
                        <span className="text-gray-400">（名称未取得）</span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{conn.companyId}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {formatJSTWithYear(conn.createdAt)}
                    </td>
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
          freee のリフレッシュトークンは有効期限が 90 日です。長期間使わないと失効します。
          <strong>⚠️ 要再連携</strong> と出ている接続は、上の「freee と連携する」からやり直してください
          （有効／保留の設定はそのまま保たれます）。
        </p>
      </div>
    </div>
  )
}
