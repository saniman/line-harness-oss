import { describe, it, expect, vi } from 'vitest'
import {
  renderEventBookingNotice,
  notifyAdminEventBooking,
  type EventBookingNoticeContext,
} from './admin-notifier.js'

const BASE: EventBookingNoticeContext = {
  eventTitle: '沖縄AI活用セミナー',
  eventStartAt: '2026-09-13T05:00:00.000Z', // JST 09/13(日) 14:00
  applicantName: '山田太郎',
  bookingId: 34,
  paymentKind: 'stripe',
  amount: 2000,
  participantCount: 3,
  capacity: 20,
}

/** Flex の中に現れる色指定（color / backgroundColor）を再帰的に集める */
function collectColors(node: unknown, acc: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) collectColors(child, acc)
    return acc
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if ((key === 'color' || key === 'backgroundColor') && typeof value === 'string') acc.push(value)
      else collectColors(value, acc)
    }
  }
  return acc
}

const asText = (contents: unknown) => JSON.stringify(contents)

describe('renderEventBookingNotice', () => {
  it('イベント名・開催日時(JST)・申込者・支払い・予約IDを含む', () => {
    const { contents } = renderEventBookingNotice(BASE)
    const body = asText(contents)

    expect(body).toContain('沖縄AI活用セミナー')
    expect(body).toContain('09/13(日) 14:00') // UTC ではなく JST で出す
    expect(body).toContain('山田太郎')
    expect(body).toContain('Stripe決済 ¥2,000')
    expect(body).toContain('34')
  })

  it('altText は一覧で識別できる形にする', () => {
    const { altText } = renderEventBookingNotice(BASE)
    expect(altText).toContain('沖縄AI活用セミナー')
    expect(altText).toContain('山田太郎')
  })

  it('申込状況は participantCount と capacity が揃っているときだけ出す', () => {
    expect(asText(renderEventBookingNotice(BASE).contents)).toContain('3 / 20 名')

    const withoutCount = renderEventBookingNotice({ ...BASE, participantCount: null, capacity: null })
    expect(asText(withoutCount.contents)).not.toContain('申込状況')
  })

  it('支払い区分ごとに正しいラベルを出す', () => {
    const label = (ctx: Partial<EventBookingNoticeContext>) =>
      asText(renderEventBookingNotice({ ...BASE, ...ctx } as EventBookingNoticeContext).contents)

    expect(label({ paymentKind: 'stripe', amount: 2000 })).toContain('Stripe決済 ¥2,000')
    expect(label({ paymentKind: 'cash', amount: null })).toContain('当日現金')
    expect(label({ paymentKind: 'free', amount: null })).toContain('無料')
    // 未入金は運営者が見分けられないと取りっぱぐれる
    expect(label({ paymentKind: 'unpaid', amount: 3000 })).toContain('未払い（要確認）¥3,000')
  })

  it('開催日時が不明でも落ちない', () => {
    const { contents } = renderEventBookingNotice({ ...BASE, eventStartAt: null })
    expect(asText(contents)).toContain('未設定')
  })

  it('申込者名の改行を潰し、長すぎる名前は切り詰める', () => {
    const { altText, contents } = renderEventBookingNotice({
      ...BASE,
      applicantName: '山田\n太郎',
      eventTitle: 'あ'.repeat(120),
    })
    expect(altText).not.toContain('\n')
    expect(altText).toContain('山田 太郎')
    expect(asText(contents)).not.toContain('あ'.repeat(81))
  })

  it('名前が空でも「名前未入力」で埋める', () => {
    const { contents } = renderEventBookingNotice({ ...BASE, applicantName: '' })
    expect(asText(contents)).toContain('名前未入力')
  })

  it('色指定はすべて6桁HEX（3桁は LINE API が拒否する）', () => {
    const { contents } = renderEventBookingNotice(BASE)
    const colors = collectColors(contents)
    expect(colors.length).toBeGreaterThan(0)
    for (const color of colors) {
      expect(color).toMatch(/^#[0-9a-fA-F]{6}$/)
    }
  })

  it('管理画面へ遷移するボタンを持つ', () => {
    const { contents } = renderEventBookingNotice(BASE)
    expect(asText(contents)).toContain('https://admin.walover-co.work/events')
  })
})

describe('notifyAdminEventBooking', () => {
  it('クライアントと宛先が揃っていれば Flex を push する', async () => {
    const pushMessage = vi.fn().mockResolvedValue({})

    const sent = await notifyAdminEventBooking({
      client: { pushMessage },
      adminLineUserId: 'Uadmin',
      ctx: BASE,
    })

    expect(sent).toBe(true)
    expect(pushMessage).toHaveBeenCalledTimes(1)
    const [to, messages] = pushMessage.mock.calls[0]
    expect(to).toBe('Uadmin')
    expect(messages[0].type).toBe('flex')
    expect(messages[0].altText).toContain('沖縄AI活用セミナー')
  })

  it('宛先（ADMIN_LINE_USER_ID）が未設定なら送らない', async () => {
    const pushMessage = vi.fn()
    const sent = await notifyAdminEventBooking({
      client: { pushMessage },
      adminLineUserId: undefined,
      ctx: BASE,
    })

    expect(sent).toBe(false)
    expect(pushMessage).not.toHaveBeenCalled()
  })

  it('LINE クライアントが無い場合は送らない（未設定環境でも落ちない）', async () => {
    const sent = await notifyAdminEventBooking({
      client: null,
      adminLineUserId: 'Uadmin',
      ctx: BASE,
    })
    expect(sent).toBe(false)
  })

  it('push が失敗しても例外を投げない（申込フローを壊さない）', async () => {
    const pushMessage = vi.fn().mockRejectedValue(new Error('LINE API 500'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const sent = await notifyAdminEventBooking({
      client: { pushMessage },
      adminLineUserId: 'Uadmin',
      ctx: BASE,
    })

    expect(sent).toBe(false)
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})
