import type { FlexContainer, Message } from '@line-crm/line-sdk'
import { formatJST } from '../utils/format-jst.js'

/**
 * 運営者（管理者）への LINE 通知。
 *
 * 当初は Cloudflare Email Sending でメール通知していたが、Email Sending は
 * **Workers Paid プラン限定**でこのアカウント（無料プラン）では一度も送信できていなかった（#49）。
 * 運営者が毎日見ていて追加コストもゼロの LINE に通知経路を一本化する。
 *
 * LINE クライアントは SDK の `LineClient` 実型ではなく、使うメソッドだけの
 * ミニマルな構造的インターフェースで受ける（テストでモックを代入できるようにするため。
 * `.claude/rules/api-coding.md`「外部SDKクライアントをサービス関数に渡す場合の型設計」）。
 */
export interface AdminPushClient {
  pushMessage(to: string, messages: Message[]): Promise<unknown>
}

/**
 * stripe=決済済み / cash=当日現金 / free=無料 / unpaid=有料イベントだが未入金
 * （`unpaid` は運営者が未収に気づけるようにするための区分）
 */
export type EventBookingPaymentKind = 'stripe' | 'cash' | 'free' | 'unpaid'

export interface EventBookingNoticeContext {
  eventTitle: string
  /** イベント開催日時（DB の ISO 文字列 = UTC）。不明なら null */
  eventStartAt: string | null
  applicantName: string
  bookingId: number
  paymentKind: EventBookingPaymentKind
  /** 金額（円）。決済済みなら実決済額、未払いならイベント価格。無料・現金なら null */
  amount?: number | null
  participantCount?: number | null
  capacity?: number | null
  /** 管理画面の参加者一覧 URL（省略時は既定値） */
  adminUrl?: string
}

const DEFAULT_ADMIN_URL = 'https://admin.walover-co.work/events'

// 色は必ず6桁 HEX で書く。3桁の短縮形は LINE API が invalid property で拒否する
// （`.claude/rules/line-messaging.md`）。値は `.claude/rules/css.md` のパレットに合わせる。
const COLOR_LINE_GREEN = '#06C755'
const COLOR_WHITE = '#FFFFFF'
const COLOR_TEXT = '#333333'
const COLOR_TEXT_SUB = '#666666'
const COLOR_BORDER = '#E0E0E0'

/** 3桁区切り（Intl に依存せず結果を固定するため自前で組む） */
function formatYen(amount: number): string {
  return `¥${String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
}

function paymentLabel(kind: EventBookingPaymentKind, amount?: number | null): string {
  switch (kind) {
    case 'stripe':
      return amount != null ? `Stripe決済 ${formatYen(amount)}` : 'Stripe決済'
    case 'cash':
      return '当日現金'
    case 'free':
      return '無料'
    case 'unpaid':
      return amount != null ? `未払い（要確認）${formatYen(amount)}` : '未払い（要確認）'
  }
}

/** 表示に埋め込む外部入力の正規化。改行が混ざるとレイアウトが崩れるため潰す */
const MAX_FIELD_LENGTH = 80

function sanitizeField(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD_LENGTH)
}

/** ラベルと値を横並びにする1行 */
function detailRow(label: string, value: string): FlexContainer {
  return {
    type: 'box',
    layout: 'baseline',
    spacing: 'sm',
    contents: [
      { type: 'text', text: label, size: 'sm', color: COLOR_TEXT_SUB, flex: 2 },
      { type: 'text', text: value, size: 'sm', color: COLOR_TEXT, flex: 5, wrap: true },
    ],
  }
}

export interface RenderedNotice {
  altText: string
  contents: FlexContainer
}

/**
 * 申込通知の Flex メッセージを組み立てる（純粋関数）。
 *
 * 重要情報（イベント名・開催日時）を先頭に置き、CTA は footer に固定する
 * （`.claude/rules/line-messaging.md`。末尾のコンテンツは読まれずに閉じられるため）。
 */
export function renderEventBookingNotice(ctx: EventBookingNoticeContext): RenderedNotice {
  // 申込者名・イベント名は外部入力。改行や極端に長い文字列で表示が崩れるため正規化する
  const applicant = sanitizeField(ctx.applicantName) || '名前未入力'
  const title = sanitizeField(ctx.eventTitle) || 'イベント'
  // DB は UTC。人目に触れる場所は必ず JST に変換する（`.claude/rules/api-coding.md`）
  const startAt = ctx.eventStartAt ? formatJST(ctx.eventStartAt) : '未設定'
  const adminUrl = ctx.adminUrl ?? DEFAULT_ADMIN_URL

  const rows: FlexContainer[] = [
    detailRow('申込者', applicant),
    detailRow('支払い', paymentLabel(ctx.paymentKind, ctx.amount)),
  ]
  if (ctx.participantCount != null && ctx.capacity != null) {
    rows.push(detailRow('申込状況', `${ctx.participantCount} / ${ctx.capacity} 名`))
  }
  rows.push(detailRow('予約ID', String(ctx.bookingId)))

  const contents: FlexContainer = {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      backgroundColor: COLOR_LINE_GREEN,
      contents: [
        {
          type: 'text',
          text: '🎫 イベント申込がありました',
          color: COLOR_WHITE,
          weight: 'bold',
          size: 'md',
          wrap: true,
        },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '16px',
      spacing: 'sm',
      contents: [
        { type: 'text', text: title, weight: 'bold', size: 'lg', color: COLOR_TEXT, wrap: true },
        { type: 'text', text: startAt, size: 'sm', color: COLOR_TEXT_SUB },
        { type: 'separator', margin: 'md', color: COLOR_BORDER },
        { type: 'box', layout: 'vertical', margin: 'md', spacing: 'sm', contents: rows },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '12px',
      contents: [
        {
          type: 'button',
          style: 'primary',
          height: 'sm',
          color: COLOR_LINE_GREEN,
          action: { type: 'uri', label: '管理画面で参加者を確認', uri: adminUrl },
        },
      ],
    },
  }

  return { altText: `🎫 イベント申込：${title}（${applicant}）`, contents }
}

export interface NotifyAdminEventBookingParams {
  /** LINE クライアント（アクセストークン未設定なら null） */
  client?: AdminPushClient | null
  /** 通知先＝ADMIN_LINE_USER_ID */
  adminLineUserId?: string | null
  ctx: EventBookingNoticeContext
}

/**
 * 運営者へ申込通知を push する（ベストエフォート）。
 *
 * - クライアント・宛先のどちらかが未設定なら何もしない（OSS 利用者やローカル開発で
 *   LINE 設定が無くても申込フローが壊れないようにするため）
 * - 送信失敗は console.error に記録するだけで例外を投げない（申込自体は必ず成功させる）
 *
 * @returns 実際に送信したら true
 */
export async function notifyAdminEventBooking(
  params: NotifyAdminEventBookingParams,
): Promise<boolean> {
  const { client, adminLineUserId, ctx } = params
  if (!client || !adminLineUserId) return false

  try {
    const { altText, contents } = renderEventBookingNotice(ctx)
    await client.pushMessage(adminLineUserId, [{ type: 'flex', altText, contents }])
    return true
  } catch (err) {
    console.error('[admin-notifier] イベント申込の管理者通知に失敗:', err)
    return false
  }
}
