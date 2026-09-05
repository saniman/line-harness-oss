/**
 * イベント当日のリマインド配信（#67）
 *
 * 運営者が管理画面でイベントごとに「送信日時（events.reminder_at）」と
 * 「本文（events.reminder_message_extra）」を設定しておくと、5分毎の cron が
 * 時刻を過ぎた未送信の確定参加者へ LINE で push する。
 *
 * ## なぜ Flex ではなくプレーンテキストなのか
 * Flex の text コンポーネントは **URL を自動リンクしない**。会場の地図 URL をタップ可能に
 * するには uri アクションのボタンにする必要があり、「自由文の中に URL を混ぜる」今回の
 * 形式と両立しない。テキストなら LINE クライアントが自動でリンク化する。
 *
 * ## 送信済みの記録は申込（event_bookings）単位
 * 参加者ごとに `reminder_sent_at` を埋めるので、一部の push が失敗しても
 * 次の tick でその人だけ再試行される。「送ってから記録」なので at-least-once
 * （送信直後に落ちるとまれに2通）。既存の booking-reminders.ts と同じ性質。
 */

import type { Message } from '@line-crm/line-sdk'
import { formatJST } from '../utils/format-jst.js'
import { addJitter, sleep } from './stealth.js'

/**
 * LINE クライアントは SDK 実型ではなく、使うメソッドだけのミニマルな構造的
 * インターフェースで受ける（`.claude/rules/api-coding.md`）。
 */
export interface EventReminderPushClient {
  pushMessage(to: string, messages: Message[]): Promise<unknown>
}

export interface EventReminderContext {
  eventTitle: string
  /** イベント開催日時（DB の ISO 文字列 = UTC） */
  startAt: string
  /** events.reminder_message_extra（自由文）。null なら本文だけ */
  extra: string | null
  /** 送信時点の epoch ms。開催日との JST 暦日差から「本日 / 明日 / 日付」を出す */
  nowMs: number
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/** epoch ms を JST の暦日インデックス（1970-01-01 JST からの日数）にする */
function jstDayIndex(ms: number): number {
  return Math.floor((ms + JST_OFFSET_MS) / DAY_MS)
}

/**
 * 開催日までの JST 暦日差から見出しラベルを返す。当日/翌日以外は null。
 *
 * 「本日」を決め打ちにすると、運営者が前日に送る設定にしたときに嘘になる。
 */
function leadLabel(startAt: string, nowMs: number): '本日' | '明日' | null {
  const diff = jstDayIndex(Date.parse(startAt)) - jstDayIndex(nowMs)
  if (diff === 0) return '本日'
  if (diff === 1) return '明日'
  return null
}

/**
 * リマインドの本文を組み立てる（純粋関数）。
 *
 * コードが組むのは見出し・イベント名・開始時刻の3行だけで、
 * 会場・持ち物・事前確認などは `extra` をそのまま連結する。
 */
export function renderEventReminderText(ctx: EventReminderContext): string {
  const label = leadLabel(ctx.startAt, ctx.nowMs)
  // DB は UTC。人目に触れる場所は必ず JST に変換する（`.claude/rules/api-coding.md`）
  const jstText = formatJST(ctx.startAt) // 'MM/DD(曜) HH:mm'
  // 当日/翌日は日付が自明なので時刻だけ。それ以外は日付ごと出す
  const startText = label ? (jstText.split(' ')[1] ?? jstText) : jstText

  const head = [
    `📢 ${label ? `${label}の` : ''}イベントリマインドです`,
    '',
    `「${ctx.eventTitle}」`,
    `⏰ 開始 ${startText}`,
  ].join('\n')

  const extra = ctx.extra?.trim()
  return extra ? `${head}\n\n${extra}` : head
}

/** 配信対象を1クエリで取り切るための行（booking-reminders.ts と同じ作法） */
export interface EventReminderDueRow {
  booking_id: number
  friend_id: string
  event_id: number
  title: string
  start_at: string
  end_at: string
  reminder_at: string
  reminder_message_extra: string | null
  line_user_id: string
  /** friend のアカウントのトークン。引けなければ null（既定クライアントで送る） */
  channel_access_token: string | null
}

export interface ProcessEventRemindersParams {
  /** アカウントのトークンが引けないときに使うクライアント */
  defaultClient: EventReminderPushClient
  /** channel_access_token からクライアントを作る（テストで差し替える） */
  createClient?: (channelAccessToken: string) => EventReminderPushClient
  /** 現在時刻（epoch ms）。省略時は Date.now() */
  nowMs?: number
}

/**
 * 未送信の対象を1クエリで取り切る。
 *
 * `is_published` では絞らない。満席になったイベントを一覧から隠すために非公開へ
 * 戻す運用がありえて、そこで参加者のリマインドが黙って止まると
 * 「申込は成立しているのに案内が来ない」という気づけない事故になるため。
 */
const DUE_SQL = `
  SELECT
    b.id                        AS booking_id,
    b.friend_id                 AS friend_id,
    e.id                        AS event_id,
    e.title                     AS title,
    e.start_at                  AS start_at,
    e.end_at                    AS end_at,
    e.reminder_at               AS reminder_at,
    e.reminder_message_extra    AS reminder_message_extra,
    f.line_user_id              AS line_user_id,
    la.channel_access_token     AS channel_access_token
  FROM event_bookings b
  JOIN events   e  ON e.id = b.event_id
  JOIN friends  f  ON f.id = b.friend_id
  LEFT JOIN line_accounts la ON la.id = f.line_account_id
  WHERE b.status = 'confirmed'
    AND b.reminder_sent_at IS NULL
    AND e.reminder_at IS NOT NULL
    AND f.is_following = 1
  ORDER BY b.id
`

/**
 * 配信時刻を過ぎたイベントのリマインドを確定参加者へ送る。
 *
 * 日時の比較は **文字列ではなく epoch** で行う。`start_at` / `end_at` は実データで
 * `...+09:00` 形式と `...Z` 形式が混在しており、文字列比較だと壊れるため
 * （events テーブルは小さいので、候補を取ってから JS で絞るコストは無視できる）。
 */
export async function processEventReminders(
  db: D1Database,
  params: ProcessEventRemindersParams,
): Promise<{ sent: number; failed: number }> {
  const nowMs = params.nowMs ?? Date.now()
  const result = await db.prepare(DUE_SQL).all<EventReminderDueRow>()

  const due = (result.results ?? []).filter((row) => {
    const remindAtMs = Date.parse(row.reminder_at)
    const endAtMs = Date.parse(row.end_at)
    if (Number.isNaN(remindAtMs) || Number.isNaN(endAtMs)) return false
    // 配信時刻を過ぎている & まだ終わっていない
    return remindAtMs <= nowMs && endAtMs > nowMs
  })

  // 同じ友だちが同じイベントに複数申し込んでいても push は1通に寄せる。
  // 送信済みマークは申込ごとに付ける（次の tick で再送しないため）。
  const groups = new Map<string, { row: EventReminderDueRow; bookingIds: number[] }>()
  for (const row of due) {
    const key = `${row.event_id}:${row.friend_id}`
    const group = groups.get(key)
    if (group) group.bookingIds.push(row.booking_id)
    else groups.set(key, { row, bookingIds: [row.booking_id] })
  }

  let sent = 0
  let failed = 0
  let index = 0

  for (const { row, bookingIds } of groups.values()) {
    try {
      // ステルス: バースト回避のためランダム遅延（reminder-delivery.ts と同じ作法）
      if (index > 0) await sleep(addJitter(50, 200))
      index++

      const client =
        row.channel_access_token && params.createClient
          ? params.createClient(row.channel_access_token)
          : params.defaultClient

      const text = renderEventReminderText({
        eventTitle: row.title,
        startAt: row.start_at,
        extra: row.reminder_message_extra,
        nowMs,
      })
      await client.pushMessage(row.line_user_id, [{ type: 'text', text }])

      // 送信できてから記録する（記録が先だと落ちたときに送り漏れる）
      const placeholders = bookingIds.map(() => '?').join(', ')
      await db
        .prepare(
          `UPDATE event_bookings
              SET reminder_sent_at = datetime('now'), updated_at = datetime('now')
            WHERE id IN (${placeholders})`,
        )
        .bind(...bookingIds)
        .run()
      sent++
    } catch (err) {
      // 1人の失敗で残りを止めない。マークしないので次の tick で再試行される
      console.error(
        `[event-reminders] 配信に失敗: eventId=${row.event_id} bookingIds=${bookingIds.join(',')}`,
        err,
      )
      failed++
    }
  }

  return { sent, failed }
}
