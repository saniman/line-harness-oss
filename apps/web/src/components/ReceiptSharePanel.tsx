'use client'

import { useState } from 'react'
import { api, ApiError } from '@/lib/api'
import { formatJST } from '@/lib/format-jst'

/**
 * 領収書の共有リンクを登録して LINE で送るパネル（Issue #47）。
 *
 * ## ⚠️ 取り違えは個人情報の漏洩
 *
 * A さんの領収書リンクを B さんに送ると、A の氏名と金額が B に渡る。
 * しかも LINE の送信は取り消せない。過去に実際に起きているので、画面側でも守る。
 *
 *   - **1件ずつしか開かない**（親が開いている行を1つに制限する）。
 *     一覧に入力欄を並べると、クリップボードを持ち回って取り違える
 *   - 対象者の氏名と宛名を入力欄のすぐ上に出す
 *   - 貼り付け後、**リンク末尾8文字**を出す（前の人と同じなら目で気づける）
 *   - freee との照合が通らなかったときだけ「開いて確認した」のチェックを求める
 *     （機械で照合できたのに人に確認を強いると、慣れて素通しするようになる）
 *
 * 形式の検証・重複の検出・freee との照合は**すべてサーバー側**で行う。
 * ここでの表示は補助であって、防御の本体ではない。
 */

export interface ReceiptShareBooking {
  id: number
  name: string
  receipt_name: string | null
  friend_id: string | null
  /** freee の report_url（運営者用・ログイン必須）。「freeeで開く」に使う */
  receipt_url: string | null
  receipt_share_url: string | null
  receipt_share_expires_at: string | null
  receipt_share_verified_at: string | null
  receipt_share_revoked_at: string | null
  receipt_sent_at: string | null
}

interface Props {
  eventId: number
  booking: ReceiptShareBooking
  displayName: string
  onDone: () => Promise<void> | void
}

/** リンクの末尾8文字。前の人と同じリンクを貼っていないか目で確かめるためのもの */
function tail(url: string | null): string {
  if (!url) return ''
  return url.slice(-8)
}

export default function ReceiptSharePanel({ eventId, booking, displayName, onDone }: Props) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmed, setConfirmed] = useState(false)

  const saved = booking.receipt_share_url
  const verified = !!booking.receipt_share_verified_at
  const revoked = !!booking.receipt_share_revoked_at
  const sent = !!booking.receipt_sent_at
  const payee = booking.receipt_name || booking.name || displayName

  // 照合できていないときだけ、人の目での確認を求める。
  // 機械で照合できたのに毎回チェックさせると、運営者が慣れて素通しするようになる
  const needsManualCheck = !!saved && !verified
  const canSend = !!saved && !revoked && !sent && (verified || confirmed)

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      await onDone()
      return true
    } catch (err) {
      // サーバーが返す理由をそのまま出す。ここで固定文にすると原因に辿り着けない
      setError(err instanceof ApiError ? err.message : '通信に失敗しました。')
      return false
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="px-4 pb-3 bg-amber-50/60 border-t border-amber-100">
      <p className="text-xs text-gray-600 mt-2">
        <span className="font-medium text-gray-900">{displayName}</span> さんの領収書
        <span className="text-gray-500">（宛名: {payee}）</span>
      </p>

      {/* ① freee で開く: 該当の領収書へ直行できると、freee 内を探す手間と取り違えが減る */}
      {booking.receipt_url && (
        <a
          href={booking.receipt_url}
          target="_blank"
          rel="noreferrer"
          className="inline-block mt-2 text-xs text-blue-600 hover:underline"
        >
          ① freee でこの領収書を開く → 「URL共有」でリンクを作成してコピー
        </a>
      )}

      {/* ② 貼り付け */}
      <div className="mt-2 flex flex-col sm:flex-row gap-2">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="② https://invoice.secure.freee.co.jp/ivex/dl/..."
          className="flex-1 min-w-0 px-2 py-1 border border-gray-300 rounded text-xs"
          disabled={busy}
        />
        <button
          onClick={async () => {
            const ok = await run(() => api.eventBookings.saveReceiptShare(eventId, booking.id, url))
            if (ok) setUrl('')
          }}
          disabled={busy || !url.trim()}
          className="px-3 py-1 rounded text-xs text-white bg-gray-700 disabled:opacity-50 whitespace-nowrap"
        >
          {saved ? '貼り直す' : '登録'}
        </button>
      </div>

      {saved && (
        <div className="mt-2 text-xs">
          <p className="text-gray-600">
            登録済み <span className="font-mono text-gray-500">…{tail(saved)}</span>
            {verified
              ? <span className="ml-2 text-green-700">✓ freee と照合済み</span>
              : <span className="ml-2 text-amber-700">⚠️ 未照合（目視で確認してください）</span>}
          </p>
          {booking.receipt_share_expires_at && (
            <p className="text-gray-500 mt-0.5">
              ダウンロード期限: {formatJST(booking.receipt_share_expires_at)}
            </p>
          )}
        </div>
      )}

      {/* ③ 照合できなかったときだけ、人の目での確認を求める */}
      {needsManualCheck && !sent && (
        <label className="flex items-start gap-2 mt-2 text-xs text-gray-700">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            リンクを開いて、<span className="font-medium">{displayName}</span> さんの領収書であることを確認しました
          </span>
        </label>
      )}

      {/* ④ 送信 */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {sent ? (
          <span className="text-xs text-green-700">
            ✓ 送信済み（{formatJST(booking.receipt_sent_at as string)}）
          </span>
        ) : (
          <button
            onClick={() => run(() => api.eventBookings.sendReceipt(eventId, booking.id))}
            disabled={busy || !canSend}
            className="px-3 py-1 rounded text-xs text-white bg-green-600 disabled:opacity-50"
          >
            ④ LINEで送る
          </button>
        )}

        {/* 誤配に気づいたときの緊急停止。まだ開かれていなければ漏洩を防げる */}
        {saved && !revoked && (
          <button
            onClick={() => {
              if (!confirm(`${displayName}さんに送ったリンクを無効化します。\n参加者はダウンロードできなくなります。`)) return
              void run(() => api.eventBookings.revokeReceipt(eventId, booking.id))
            }}
            disabled={busy}
            className="px-3 py-1 rounded text-xs text-red-700 border border-red-300 disabled:opacity-50"
          >
            リンクを無効化
          </button>
        )}
        {revoked && <span className="text-xs text-red-700">無効化済み</span>}
      </div>

      {!booking.friend_id && (
        <p className="mt-2 text-xs text-red-600">
          LINE の友だちが紐づいていないため送信できません。先に友だちを紐付けてください。
        </p>
      )}

      {error && <p className="mt-2 text-xs text-red-700 bg-red-50 rounded p-2">{error}</p>}
    </div>
  )
}
