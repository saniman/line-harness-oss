import { formatJST } from '../utils/format-jst.js'

/**
 * イベント申込の運営者向けメール通知。
 *
 * 送信基盤は Cloudflare Email Sending（Workers の `send_email` バインディング）。
 * バインディングの実型 `SendEmail` をそのまま引数に取らず、使うメソッドだけの
 * ミニマルな構造的インターフェースを定義する（テストでモックを代入できるようにするため。
 * `.claude/rules/api-coding.md`「外部SDKクライアントをサービス関数に渡す場合の型設計」）。
 */
export interface EmailSendClient {
  send(message: {
    to: string
    from: { email: string; name?: string }
    subject: string
    text: string
    html: string
  }): Promise<unknown>
}

export type EventBookingPaymentKind = 'stripe' | 'cash' | 'free'

export interface EventBookingEmailContext {
  eventTitle: string
  /** イベント開催日時（DB の ISO 文字列）。不明なら null */
  eventStartAt: string | null
  applicantName: string
  bookingId: number
  paymentKind: EventBookingPaymentKind
  /** Stripe 決済額（円）。無料・現金なら null */
  amount?: number | null
  participantCount?: number | null
  capacity?: number | null
  /** 管理画面の参加者一覧 URL（省略時は既定値） */
  adminUrl?: string
}

const DEFAULT_ADMIN_URL = 'https://admin.walover-co.work/events'

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
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export interface RenderedEmail {
  subject: string
  text: string
  html: string
}

/**
 * 申込通知メールの件名・本文を組み立てる（純粋関数）。
 * html / text の両方を返す（片方だけだとスパム判定が上がるため）。
 */
export function renderEventBookingEmail(ctx: EventBookingEmailContext): RenderedEmail {
  const applicant = ctx.applicantName.trim() || '名前未入力'
  const startAt = ctx.eventStartAt ? formatJST(ctx.eventStartAt) : '未設定'
  const payment = paymentLabel(ctx.paymentKind, ctx.amount)
  const adminUrl = ctx.adminUrl ?? DEFAULT_ADMIN_URL

  const rows: Array<[string, string]> = [
    ['イベント', ctx.eventTitle],
    ['開催日時', startAt],
    ['申込者', applicant],
    ['支払い', payment],
    ['予約ID', String(ctx.bookingId)],
  ]
  if (ctx.participantCount != null && ctx.capacity != null) {
    rows.push(['申込状況', `${ctx.participantCount} / ${ctx.capacity} 名`])
  }

  const subject = `【イベント申込】${ctx.eventTitle}（${applicant}）`

  const text = [
    'イベントの申込がありました。',
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    '',
    `管理画面: ${adminUrl}`,
  ].join('\n')

  const html = [
    '<div style="font-family:sans-serif;font-size:14px;line-height:1.7;color:#333333">',
    '<p>イベントの申込がありました。</p>',
    '<table style="border-collapse:collapse">',
    ...rows.map(
      ([label, value]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#666666">${escapeHtml(label)}</td>` +
        `<td style="padding:4px 0"><strong>${escapeHtml(value)}</strong></td></tr>`,
    ),
    '</table>',
    `<p><a href="${escapeHtml(adminUrl)}">管理画面で参加者を確認する</a></p>`,
    '</div>',
  ].join('')

  return { subject, text, html }
}

export interface SendEventBookingNotificationParams {
  /** env.EMAIL（未設定なら undefined） */
  email?: EmailSendClient | null
  /** 通知先＝ADMIN_NOTIFY_EMAIL */
  to?: string | null
  /** 送信元＝MAIL_FROM_ADDRESS（Email Sending を有効化したドメインのアドレス） */
  from?: string | null
  fromName?: string
  ctx: EventBookingEmailContext
}

/**
 * 運営者へ申込通知メールを送る（ベストエフォート）。
 *
 * - バインディング・宛先・送信元のいずれかが未設定なら何もしない（OSS 利用者やローカル開発で
 *   メール設定が無くても申込フローが壊れないようにするため）
 * - 送信失敗は console.error に記録するだけで例外を投げない（申込自体は必ず成功させる）
 *
 * @returns 実際に送信したら true
 */
export async function sendEventBookingNotification(
  params: SendEventBookingNotificationParams,
): Promise<boolean> {
  const { email, to, from, ctx } = params
  if (!email || !to || !from) return false

  try {
    const mail = renderEventBookingEmail(ctx)
    await email.send({
      to,
      from: { email: from, name: params.fromName ?? 'LINE Harness' },
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    })
    return true
  } catch (err) {
    console.error('[email-notifier] イベント申込メールの送信に失敗:', err)
    return false
  }
}
