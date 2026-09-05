'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import type { EventItem, EventBookingItem, FriendWithTags } from '@/lib/api'
import { getPaymentBadge } from '@/lib/payment-badge'
import {
  getStatusBadge,
  participantDisplayName,
  partitionBookings,
  getDropoutReasonLabel,
  resolveBookingAmount,
} from '@/lib/booking-display'
import { formatJST, toJstDatetimeLocal, jstDatetimeLocalToIso } from '@/lib/format-jst'
import Header from '@/components/layout/header'

const FIELD_CLASS = 'text-sm border border-gray-300 rounded-lg px-3 py-2 w-full focus:outline-none focus:ring-2 focus:ring-green-500'

/**
 * 申込と友だちの連携状態バッジ。
 * friend_id が無い申込は CRM に取り込めていない（＝アフターフォロー・タグ・配信の対象外）ため、
 * 参加者一覧で気付けるようにする。
 */
function getFriendLinkBadge(b: EventBookingItem): { label: string; cls: string } | null {
  if (!b.friend_id) return { label: '友だち未連携', cls: 'bg-gray-100 text-gray-600' }
  if (b.friend_is_following === 0) return { label: '未フォロー', cls: 'bg-amber-100 text-amber-700' }
  return null
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
  // アフターフォロー一括登録
  const [followupScenarios, setFollowupScenarios] = useState<{ id: string; name: string }[]>([])
  const [selectedScenarioId, setSelectedScenarioId] = useState('')
  const [enrolling, setEnrolling] = useState(false)
  const [enrollResult, setEnrollResult] = useState('')
  // 友だち未連携の復元
  const [backfilling, setBackfilling] = useState(false)
  const [backfillResult, setBackfillResult] = useState('')
  // 手動紐付け（Stripe セッションを持たない無料/現金の申込用）
  // 現金受領。エラーはページ全体の error とは別に持つ
  // （load() が先頭で setError('') するため、そこへ入れると表示前に消える）
  const [cashBusyId, setCashBusyId] = useState<number | null>(null)
  const [cashError, setCashError] = useState('')
  const [linkingBookingId, setLinkingBookingId] = useState<number | null>(null)
  const [friendQuery, setFriendQuery] = useState('')
  const [friendCandidates, setFriendCandidates] = useState<FriendWithTags[]>([])
  const [linking, setLinking] = useState(false)

  useEffect(() => {
    api.scenarios.list().then((res) => {
      if (!res.success) return
      const evScenarios = res.data
        .filter((s) => s.triggerType === 'event_booking')
        .map((s) => ({ id: s.id, name: s.name }))
      setFollowupScenarios(evScenarios)
      if (evScenarios.length > 0) setSelectedScenarioId((prev) => prev || evScenarios[0].id)
    })
  }, [])

  const handleEnrollParticipants = async () => {
    if (!selectedScenarioId) return
    if (!confirm('このイベントの確定参加者を、選択したフォローシナリオに一括登録します。よろしいですか？')) return
    setEnrolling(true)
    setEnrollResult('')
    try {
      const res = await api.events.enrollParticipants(eventId, selectedScenarioId)
      if (res.success) {
        setEnrollResult(`確定参加者 ${res.data.total} 名中 ${res.data.enrolled} 名を登録しました（登録済みは除外）。`)
      } else {
        setEnrollResult('エラー: ' + res.error)
      }
    } catch {
      setEnrollResult('登録に失敗しました')
    } finally {
      setEnrolling(false)
    }
  }

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

  const handleBackfillFriends = async () => {
    if (!confirm('友だち未連携の申込について、決済情報から LINE ユーザーを特定して友だちに紐付けます。よろしいですか？')) return
    setBackfilling(true)
    setBackfillResult('')
    try {
      const res = await api.events.backfillFriends(eventId)
      if (res.success) {
        const { total, linked, created, skipped, truncated } = res.data
        const parts = [`確定申込のうち友だち未連携 ${total} 件中 ${linked} 件を紐付けました（新規の友だち ${created} 件）。`]
        if (skipped > 0) {
          parts.push(`${skipped} 件は紐付けできませんでした（無料・当日現金の申込、または LINE ユーザーを特定できなかったもの）。参加者一覧の「友だちを紐付け」から手動で指定してください。`)
        }
        // 黙って切り捨てない: 上限で打ち切ったことを必ず伝える
        if (truncated) parts.push('一度に処理できるのは 50 件までです。残りはもう一度実行してください。')
        setBackfillResult(parts.join(' '))
        await load()
      } else {
        setBackfillResult('エラー: ' + res.error)
      }
    } catch {
      setBackfillResult('復元に失敗しました')
    } finally {
      setBackfilling(false)
    }
  }

  /**
   * 当日現金の受領を記録する。
   *
   * 受け取ったというデジタルな信号が無いので、運営者が受付で押す。
   * これを起点に領収書が発行される（#46）ので、押し間違いを防ぐため金額を確認させる。
   */
  const handleCashReceived = async (b: EventBookingItem) => {
    // ⚠️ event_bookings.amount は Stripe の webhook でしか入らない。現金申込は常に null なので、
    //    イベント価格で補わないと確認ダイアログが毎回「金額未設定」になり、
    //    押し間違い防止として一度も機能しない。
    const resolved = resolveBookingAmount(b, event?.price ?? null)
    const amount = resolved != null ? `¥${resolved.toLocaleString()}` : '（金額未設定）'
    if (!confirm(
      `${participantDisplayName(b)} さんから ${amount} を受け取りましたか？\n\n` +
      `記録すると領収書が発行されます。取り消しはできません。`
    )) return

    setCashBusyId(b.id)
    setCashError('')
    try {
      await api.eventBookings.markCashReceived(eventId, b.id)
    } catch (err) {
      // fetchApi は非2xxで throw する。ステータスで案内を分けないと、
      // 「押しても永久に成功しない」ケースまで通信エラー扱いになり、運営者が押し続ける。
      const status = err instanceof ApiError ? err.status : 0
      if (status === 404) {
        setCashError('この申込は見つかりませんでした。ほかの端末で取り消された可能性があります。')
      } else if (status === 409) {
        setCashError('記録できませんでした。操作の途中で申込の状態が変わったようです。最新の状態を読み込みました。')
      } else if (status === 400) {
        setCashError('この申込は受領できません（キャンセル済み・現金以外など）。最新の状態を読み込みました。')
      } else {
        setCashError('受領を記録できませんでした。通信状態を確認して、もう一度お試しください。')
      }
    }
    // 成否にかかわらずサーバーの状態に合わせ直す（エラーは消さない）
    await load()
    setCashBusyId(null)
  }

  const handleSearchFriends = async (q: string) => {
    setFriendQuery(q)
    if (!q.trim()) { setFriendCandidates([]); return }
    try {
      const res = await api.friends.list({ search: q.trim(), limit: 10 })
      if (res.success) setFriendCandidates(res.data.items)
    } catch {
      setFriendCandidates([])
    }
  }

  const handleLinkFriend = async (bookingId: number, friendId: string) => {
    setLinking(true)
    try {
      const res = await api.events.linkBookingFriend(bookingId, friendId)
      if (res.success) {
        setLinkingBookingId(null)
        setFriendQuery('')
        setFriendCandidates([])
        await load()
      } else {
        setError('紐付けに失敗しました: ' + res.error)
      }
    } catch {
      setError('紐付けに失敗しました')
    } finally {
      setLinking(false)
    }
  }

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
      start_at: toJstDatetimeLocal(event.start_at),
      end_at: toJstDatetimeLocal(event.end_at),
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
    // 解釈できない日時（範囲外の年など）は空文字になる。そのまま送ると
    // updateEvent が start_at = '' を書き込み、イベントの開催日時が消える。
    // 送る前に弾いて、静かに壊れるのではなく画面にエラーを出す
    const startAtIso = jstDatetimeLocalToIso(editForm.start_at)
    const endAtIso = jstDatetimeLocalToIso(editForm.end_at)
    if (!startAtIso || !endAtIso) { setEditError('日時の形式が正しくありません'); return }
    if (!Number.isInteger(cap) || cap < 1) { setEditError('定員は1以上の整数で入力してください'); return }
    if (priceVal !== null && (!Number.isInteger(priceVal) || priceVal < 0)) { setEditError('参加費は0以上の整数で入力してください'); return }
    setSaving(true)
    setEditError('')
    try {
      await api.events.update(eventId, {
        title: editForm.title.trim(),
        description: editForm.description.trim() || undefined,
        start_at: startAtIso,
        end_at: endAtIso,
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
  // 決済に至らなかった申込を通常の一覧から外す（Issue #56）
  const { active, dropouts, confirmedCount } = partitionBookings(bookings)

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
              {/* 全件数だけを出すと定員と混同して「満席では」と誤読される（Issue #56） */}
              <span className="text-xs text-gray-500">
                確定 {confirmedCount} 名 <span className="text-gray-300">/</span> 全 {bookings.length} 件
              </span>
            </div>

            {/* ⚠️ エラーは分岐の外に出す。「他の端末で取り消された」ケースでは
                再読込後に active が空になることがあり、else 側に置くと
                まさにエラーを出したい場面で表示が消える */}
            {cashError && (
              <div className="mx-4 mt-3 p-3 rounded-lg bg-red-50 text-red-700 text-sm">{cashError}</div>
            )}

            {/* 表に出すのは active。判定を bookings.length にすると、
                離脱行しか無いイベントで見出しだけ出て中身ゼロになる */}
            {active.length === 0 ? (
              <div className="p-8 text-center text-sm text-gray-400">
                {dropouts.length > 0 ? '決済に至った申込はまだありません' : '参加申込はまだありません'}
              </div>
            ) : (
              <>
                <div className="hidden sm:grid sm:grid-cols-[1fr_100px_100px_80px_140px] gap-4 px-4 py-2 bg-gray-50 border-b border-gray-100 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  <span>参加者</span>
                  <span>ステータス</span>
                  <span>決済</span>
                  <span>金額</span>
                  <span>申込日時</span>
                </div>
                {active.map((b) => {
                  const paymentBadge = getPaymentBadge(b)
                  const statusBadge = getStatusBadge(b.status)
                  const friendBadge = getFriendLinkBadge(b)
                  // 白 = 確定（ヘッダーの「確定 N 名」に数えられている） /
                  // グレー = それ以外（保留・一覧に残るキャンセル）。ヘッダーの 2 つの数と見た目を揃える。
                  // ホバーはグレー行だけ一段濃くしないと、色が付いた瞬間に反応が見えなくなる
                  const dimmed = b.status !== 'confirmed'
                  return (
                    <div key={b.id} className="border-b border-gray-100 last:border-0">
                    <div
                      className={`grid grid-cols-1 sm:grid-cols-[1fr_100px_100px_80px_140px] gap-1 sm:gap-4 px-4 py-3 transition-colors ${
                        dimmed ? 'bg-gray-50 hover:bg-gray-100' : 'hover:bg-gray-50'
                      }`}
                    >
                      {/* ⚠️ min-w-0 が無いとグリッド項目は min-content 未満に縮まないため、
                          子に truncate を付けても長い文字列で 1fr 列が広がり表がはみ出す */}
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900">{participantDisplayName(b)}</p>
                        <p className="text-xs text-gray-400 truncate">{b.email}</p>
                        {/* 領収書の宛名。発行前に運営者が目視できるようにする
                            （参加者が自由に入れられる値なので、確認できることが大事） */}
                        {b.receipt_name && (
                          <p className="text-xs text-gray-500 mt-0.5 truncate">
                            領収書宛名: {b.receipt_name}
                          </p>
                        )}
                        {/* 畳まれずにここへ来た cancel_reason は、運営者に確認してほしい理由
                            （Stripe 障害・未知の値）。文言が出る場所がないと気づけない */}
                        {b.cancel_reason && (
                          <p className="text-xs text-red-600 mt-0.5">{getDropoutReasonLabel(b.cancel_reason)}</p>
                        )}
                        {friendBadge && (
                          <div className="flex items-center gap-2 mt-1">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${friendBadge.cls}`}>
                              {friendBadge.label}
                            </span>
                            {!b.friend_id && (
                              <button
                                onClick={() => {
                                  setLinkingBookingId(linkingBookingId === b.id ? null : b.id)
                                  setFriendQuery('')
                                  setFriendCandidates([])
                                }}
                                className="text-xs text-green-600 hover:underline"
                              >
                                友だちを紐付け
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium w-fit self-center ${statusBadge.cls}`}>
                        {statusBadge.label}
                      </span>
                      <div className="self-center">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium w-fit ${paymentBadge.cls}`}>
                          {paymentBadge.label}
                        </span>
                        {/* 当日現金で、まだ受け取っていない確定者にだけ出す。
                            押すと領収書の発行につながるので、キャンセル・未確定には出さない */}
                        {b.status === 'confirmed'
                          && b.payment_status === 'cash'
                          && !b.cash_received_at && (
                          <button
                            onClick={() => handleCashReceived(b)}
                            /* 処理中は全行を止める。単一の cashBusyId では、別の行を押すと
                               前の行の「記録中...」が解除され、同時に走った load() が
                               互いの結果を上書きする */
                            disabled={cashBusyId !== null}
                            className="mt-1 block px-2 py-0.5 rounded text-xs text-white bg-amber-600 disabled:opacity-50"
                          >
                            {cashBusyId === b.id ? '記録中...' : '現金受領'}
                          </button>
                        )}
                      </div>
                      <p className="text-sm text-gray-700 self-center">
                        {b.amount != null ? `¥${b.amount.toLocaleString()}` : '—'}
                      </p>
                      <p className="text-xs text-gray-400 self-center">{formatJST(b.created_at)}</p>
                    </div>

                    {/* 手動紐付け: 決済情報から LINE ユーザーを特定できない申込（無料/現金）用 */}
                    {linkingBookingId === b.id && (
                      <div className="px-4 pb-3 bg-gray-50">
                        <input
                          type="text"
                          value={friendQuery}
                          onChange={(e) => handleSearchFriends(e.target.value)}
                          placeholder="友だちの表示名で検索"
                          className={FIELD_CLASS}
                          autoFocus
                        />
                        {friendCandidates.length > 0 && (
                          <ul className="mt-2 border border-gray-200 rounded-lg bg-white divide-y divide-gray-100 max-h-48 overflow-y-auto">
                            {friendCandidates.map((f) => (
                              <li key={f.id}>
                                <button
                                  onClick={() => handleLinkFriend(b.id, f.id)}
                                  disabled={linking}
                                  className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-50"
                                >
                                  {f.displayName ?? '(名前なし)'}
                                  {!f.isFollowing && <span className="ml-2 text-xs text-gray-400">未フォロー</span>}
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                        {friendQuery.trim() !== '' && friendCandidates.length === 0 && (
                          <p className="mt-2 text-xs text-gray-400">該当する友だちが見つかりません</p>
                        )}
                      </div>
                    )}
                    </div>
                  )
                })}
              </>
            )}

            {/* 決済に至らなかった申込。参加者数の把握を邪魔しないよう既定で畳む（Issue #56） */}
            {dropouts.length > 0 && (
              <details className="border-t border-gray-100">
                <summary className="px-4 py-3 text-xs text-gray-500 cursor-pointer hover:bg-gray-50">
                  決済に至らなかった申込 {dropouts.length} 件を表示
                </summary>
                <div className="pb-2">
                  {dropouts.map((b) => (
                    <div
                      key={b.id}
                      className="grid grid-cols-1 sm:grid-cols-[1fr_140px_140px] gap-1 sm:gap-4 px-4 py-2 text-gray-400"
                    >
                      <p className="text-sm">{participantDisplayName(b)}</p>
                      <p className="text-xs self-center">{getDropoutReasonLabel(b.cancel_reason)}</p>
                      <p className="text-xs self-center">{formatJST(b.created_at)}</p>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>

          {/* 友だち未連携の復元 */}
          <div className="bg-white rounded-lg border border-gray-200 p-4 mt-4">
            <h2 className="text-sm font-semibold text-gray-700 mb-1">友だち未連携を復元</h2>
            <p className="text-xs text-gray-500 mb-3">
              「友だち未連携」の申込について、Stripe の決済情報から LINE ユーザーを特定し、友だちに登録して紐付けます。
              友だち追加をしていない申込者は「未フォロー」として友だち管理に登録されます（配信の対象にはなりません）。
              何度実行しても二重登録にはなりません。
            </p>
            <button
              onClick={handleBackfillFriends}
              disabled={backfilling}
              className="px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 disabled:opacity-50"
            >
              {backfilling ? '復元中...' : '友だち未連携を復元'}
            </button>
            {backfillResult && <p className="text-xs text-gray-600 mt-2">{backfillResult}</p>}
          </div>

          {/* アフターフォロー一括登録 */}
          <div className="bg-white rounded-lg border border-gray-200 p-4 mt-4">
            <h2 className="text-sm font-semibold text-gray-700 mb-1">アフターフォロー一括登録</h2>
            <p className="text-xs text-gray-500 mb-3">
              このイベントの確定参加者を、選んだフォローシナリオに一括登録します。配信はシナリオの設定（開催日アンカー）に従います。既に登録済みの参加者は自動的に除外されます。
            </p>
            {followupScenarios.length === 0 ? (
              <p className="text-xs text-gray-400">
                トリガーが「イベント参加・決済時」のシナリオがありません。先に
                <button onClick={() => router.push('/scenarios')} className="text-green-600 hover:underline mx-1">シナリオ</button>
                を作成してください。
              </p>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <select
                  className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500 bg-white"
                  value={selectedScenarioId}
                  onChange={(e) => setSelectedScenarioId(e.target.value)}
                >
                  {followupScenarios.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
                <button
                  onClick={handleEnrollParticipants}
                  disabled={enrolling}
                  className="px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 disabled:opacity-50"
                >
                  {enrolling ? '登録中...' : '参加者を一括登録'}
                </button>
              </div>
            )}
            {enrollResult && <p className="text-xs text-gray-600 mt-2">{enrollResult}</p>}
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
