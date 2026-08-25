import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  renderEventBookingEmail,
  sendEventBookingNotification,
  type EventBookingEmailContext,
} from './email-notifier.js'

/** 開催日時 JST 2026-06-13(土) 14:00 */
const EVENT_START = '2026-06-13T05:00:00.000Z'

function ctx(overrides: Partial<EventBookingEmailContext> = {}): EventBookingEmailContext {
  return {
    eventTitle: '沖縄AI活用セミナー',
    eventStartAt: EVENT_START,
    applicantName: '山田太郎',
    bookingId: 12,
    paymentKind: 'free',
    amount: null,
    participantCount: 3,
    capacity: 20,
    ...overrides,
  }
}

describe('renderEventBookingEmail', () => {
  it('件名にイベント名と申込者名が入る', () => {
    const mail = renderEventBookingEmail(ctx())
    expect(mail.subject).toBe('【イベント申込】沖縄AI活用セミナー（山田太郎）')
  })

  it('申込者名が未入力でも件名・本文が壊れない', () => {
    const mail = renderEventBookingEmail(ctx({ applicantName: '' }))
    expect(mail.subject).toBe('【イベント申込】沖縄AI活用セミナー（名前未入力）')
    expect(mail.text).toContain('申込者: 名前未入力')
  })

  it('開催日時が JST 表記になる（UTC の ISO をそのまま出さない）', () => {
    const mail = renderEventBookingEmail(ctx())
    expect(mail.text).toContain('開催日時: 06/13(土) 14:00')
    expect(mail.text).not.toContain('2026-06-13T05:00:00.000Z')
    expect(mail.html).not.toContain('2026-06-13T05:00:00.000Z')
  })

  it('開催日時が不明なら「未設定」と表示する', () => {
    const mail = renderEventBookingEmail(ctx({ eventStartAt: null }))
    expect(mail.text).toContain('開催日時: 未設定')
  })

  it('Stripe決済は金額付きで支払い区分を表示する', () => {
    const mail = renderEventBookingEmail(ctx({ paymentKind: 'stripe', amount: 3000 }))
    expect(mail.text).toContain('支払い: Stripe決済 ¥3,000')
  })

  it('当日現金は「当日現金」と表示する', () => {
    const mail = renderEventBookingEmail(ctx({ paymentKind: 'cash' }))
    expect(mail.text).toContain('支払い: 当日現金')
  })

  it('無料は「無料」と表示する', () => {
    const mail = renderEventBookingEmail(ctx({ paymentKind: 'free' }))
    expect(mail.text).toContain('支払い: 無料')
  })

  it('有料イベントの未払い申込は「未払い」と金額を表示する', () => {
    const mail = renderEventBookingEmail(ctx({ paymentKind: 'unpaid', amount: 3000 }))
    expect(mail.text).toContain('支払い: 未払い（要確認）¥3,000')
  })

  it('予約IDと申込状況（申込数/定員）を含む', () => {
    const mail = renderEventBookingEmail(ctx())
    expect(mail.text).toContain('予約ID: 12')
    expect(mail.text).toContain('申込状況: 3 / 20 名')
  })

  it('申込数・定員が不明なら申込状況の行を出さない', () => {
    const mail = renderEventBookingEmail(ctx({ participantCount: null, capacity: null }))
    expect(mail.text).not.toContain('申込状況')
  })

  it('HTML と プレーンテキストの両方を返す（スパム判定対策）', () => {
    const mail = renderEventBookingEmail(ctx())
    expect(mail.text.length).toBeGreaterThan(0)
    expect(mail.html).toContain('<')
  })

  it('申込者名の改行を除去する（件名へのヘッダ挿入・送信失敗を防ぐ）', () => {
    const mail = renderEventBookingEmail(ctx({
      applicantName: '山田太郎\r\nBcc: attacker@example.com',
    }))
    expect(mail.subject).not.toMatch(/[\r\n]/)
    expect(mail.subject).toBe('【イベント申込】沖縄AI活用セミナー（山田太郎 Bcc: attacker@example.com）')
  })

  it('イベント名の改行も除去する', () => {
    const mail = renderEventBookingEmail(ctx({ eventTitle: 'セミナー\n第2回' }))
    expect(mail.subject).not.toMatch(/[\r\n]/)
    expect(mail.subject).toContain('セミナー 第2回')
  })

  it('極端に長い名前・イベント名は切り詰める（送信失敗の無音化を防ぐ）', () => {
    const mail = renderEventBookingEmail(ctx({
      eventTitle: 'あ'.repeat(500),
      applicantName: 'い'.repeat(500),
    }))
    expect(mail.subject.length).toBeLessThanOrEqual(200)
  })

  it('イベント名・申込者名の HTML 特殊文字をエスケープする', () => {
    const mail = renderEventBookingEmail(ctx({
      eventTitle: '<script>alert(1)</script>',
      applicantName: 'A & B',
    }))
    expect(mail.html).not.toContain('<script>')
    expect(mail.html).toContain('&lt;script&gt;')
    expect(mail.html).toContain('A &amp; B')
  })
})

describe('sendEventBookingNotification', () => {
  const send = vi.fn()
  const email = { send }

  beforeEach(() => {
    vi.clearAllMocks()
    send.mockResolvedValue({ messageId: 'msg-1' })
  })

  it('宛先・送信元・バインディングが揃っていればメールを送る', async () => {
    const sent = await sendEventBookingNotification({
      email,
      to: 'admin@example.com',
      from: 'noreply@walover-co.work',
      ctx: ctx(),
    })
    expect(sent).toBe(true)
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      to: 'admin@example.com',
      from: expect.objectContaining({ email: 'noreply@walover-co.work' }),
      subject: '【イベント申込】沖縄AI活用セミナー（山田太郎）',
    }))
  })

  it('EMAIL バインディングが無い場合は送らない（未設定環境でも落ちない）', async () => {
    const sent = await sendEventBookingNotification({
      email: undefined,
      to: 'admin@example.com',
      from: 'noreply@walover-co.work',
      ctx: ctx(),
    })
    expect(sent).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('宛先（ADMIN_NOTIFY_EMAIL）が未設定なら送らない', async () => {
    const sent = await sendEventBookingNotification({
      email,
      to: undefined,
      from: 'noreply@walover-co.work',
      ctx: ctx(),
    })
    expect(sent).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('送信元（MAIL_FROM_ADDRESS）が未設定なら送らない', async () => {
    const sent = await sendEventBookingNotification({
      email,
      to: 'admin@example.com',
      from: undefined,
      ctx: ctx(),
    })
    expect(sent).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('送信が失敗しても例外を投げない（ベストエフォート）', async () => {
    send.mockRejectedValue(new Error('boom'))
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sent = await sendEventBookingNotification({
      email,
      to: 'admin@example.com',
      from: 'noreply@walover-co.work',
      ctx: ctx(),
    })
    expect(sent).toBe(false)
    expect(consoleSpy).toHaveBeenCalled()
    consoleSpy.mockRestore()
  })
})
