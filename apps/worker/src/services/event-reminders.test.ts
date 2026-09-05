import { describe, it, expect, vi } from 'vitest'
import {
  renderEventReminderText,
  processEventReminders,
  type EventReminderDueRow,
} from './event-reminders.js'

// JST 9/13(日) 19:00 開催 / 12:00-16:00 JST
const START_AT = '2026-09-13T10:00:00.000Z' // JST 9/13 19:00
const END_AT = '2026-09-13T13:00:00.000Z'   // JST 9/13 22:00
const EXTRA = [
  '📍【会場名】レンタルスペース Eir',
  'https://maps.app.goo.gl/57Tq8qAjKKmows1r8',
  '💻 ノートパソコン・電源アダプタをお忘れなく',
].join('\n')

/** JST の壁時計から epoch ms を作る（テストの意図を読みやすくするため） */
const jst = (iso: string) => Date.parse(`${iso}+09:00`)

describe('renderEventReminderText', () => {
  it('開催当日に送るときは「本日」と時刻だけを出す', () => {
    const text = renderEventReminderText({
      eventTitle: '沖縄AI活用セミナー',
      startAt: START_AT,
      extra: null,
      nowMs: jst('2026-09-13T09:00:00'), // 当日の朝
    })

    expect(text).toContain('本日')
    expect(text).toContain('沖縄AI活用セミナー')
    expect(text).toContain('19:00')       // JST。UTC の 10:00 が出てはいけない
    expect(text).not.toContain('10:00')
    expect(text).not.toContain('2026-09-13T10:00:00.000Z')
  })

  it('前日に送るときは「明日」になる', () => {
    const text = renderEventReminderText({
      eventTitle: '沖縄AI活用セミナー',
      startAt: START_AT,
      extra: null,
      nowMs: jst('2026-09-12T18:00:00'),
    })
    expect(text).toContain('明日')
    expect(text).not.toContain('本日')
  })

  it('2日以上前に送るときは日付を出す（「本日」と書いて嘘にならないように）', () => {
    const text = renderEventReminderText({
      eventTitle: '沖縄AI活用セミナー',
      startAt: START_AT,
      extra: null,
      nowMs: jst('2026-09-10T09:00:00'),
    })
    expect(text).not.toContain('本日')
    expect(text).not.toContain('明日')
    expect(text).toContain('09/13(日) 19:00') // 日付まで出す
  })

  it('JST の日付境界をまたいでも暦日で判定する', () => {
    // JST 9/12 23:50 に送る → 開催は翌日 = 「明日」
    const text = renderEventReminderText({
      eventTitle: 'セミナー',
      startAt: START_AT,
      extra: null,
      nowMs: jst('2026-09-12T23:50:00'),
    })
    expect(text).toContain('明日')
  })

  it('自由文をそのまま連結する（URL を壊さない）', () => {
    const text = renderEventReminderText({
      eventTitle: 'セミナー',
      startAt: START_AT,
      extra: EXTRA,
      nowMs: jst('2026-09-13T09:00:00'),
    })
    expect(text).toContain('https://maps.app.goo.gl/57Tq8qAjKKmows1r8')
    expect(text).toContain('📍【会場名】レンタルスペース Eir')
    expect(text).toContain('💻 ノートパソコン・電源アダプタをお忘れなく')
  })

  it('自由文が無くても本文だけで成立する', () => {
    const text = renderEventReminderText({
      eventTitle: 'セミナー',
      startAt: START_AT,
      extra: null,
      nowMs: jst('2026-09-13T09:00:00'),
    })
    expect(text.trim().endsWith('19:00')).toBe(true)
  })

  it('自由文の前後の余分な空白で本文が崩れない', () => {
    const text = renderEventReminderText({
      eventTitle: 'セミナー',
      startAt: START_AT,
      extra: '\n\n  会場は変更ありません  \n\n',
      nowMs: jst('2026-09-13T09:00:00'),
    })
    expect(text).toContain('会場は変更ありません')
    expect(text).not.toMatch(/\n{3,}/)
  })
})

function makeRow(over: Partial<EventReminderDueRow> = {}): EventReminderDueRow {
  return {
    booking_id: 1,
    friend_id: 'friend-1',
    event_id: 5,
    title: '沖縄AI活用セミナー',
    start_at: START_AT,
    end_at: END_AT,
    reminder_at: '2026-09-13T00:00:00.000Z', // JST 9/13 09:00
    reminder_message_extra: EXTRA,
    line_user_id: 'U1',
    channel_access_token: 'account-token',
    ...over,
  }
}

function stubDb(rows: EventReminderDueRow[]) {
  const updates: Array<{ sql: string; bound: unknown[] }> = []
  const queries: string[] = []
  const db = {
    prepare(sql: string) {
      queries.push(sql)
      let bound: unknown[] = []
      const stmt = {
        bind(...args: unknown[]) { bound = args; return stmt },
        async all() {
          return { results: sql.includes('FROM event_bookings') ? rows : [] }
        },
        async run() {
          updates.push({ sql, bound })
          return { success: true, meta: { changes: 1 } }
        },
        async first() { return null },
      }
      return stmt
    },
  } as unknown as D1Database

  return { db, updates, queries }
}

const NOW = Date.parse('2026-09-13T01:00:00.000Z') // JST 9/13 10:00（reminder_at を1時間過ぎている）

describe('processEventReminders', () => {
  it('配信時刻を過ぎた参加者に push して送信済みを記録する', async () => {
    const pushMessage = vi.fn().mockResolvedValue({})
    const { db, updates } = stubDb([makeRow()])

    const result = await processEventReminders(db, {
      defaultClient: { pushMessage },
      createClient: () => ({ pushMessage }),
      nowMs: NOW,
    })

    expect(result).toEqual({ sent: 1, failed: 0 })
    expect(pushMessage).toHaveBeenCalledTimes(1)
    const [to, messages] = pushMessage.mock.calls[0]
    expect(to).toBe('U1')
    expect(messages[0].type).toBe('text')
    expect(messages[0].text).toContain('沖縄AI活用セミナー')
    // 送信できた申込だけ reminder_sent_at を埋める
    expect(updates.some((u) => u.sql.includes('reminder_sent_at'))).toBe(true)
  })

  it('配信時刻がまだ来ていないイベントには送らない', async () => {
    const pushMessage = vi.fn()
    const { db, updates } = stubDb([
      makeRow({ reminder_at: '2026-09-13T05:00:00.000Z' }), // JST 14:00（まだ先）
    ])

    const result = await processEventReminders(db, {
      defaultClient: { pushMessage },
      nowMs: NOW,
    })

    expect(result.sent).toBe(0)
    expect(pushMessage).not.toHaveBeenCalled()
    expect(updates).toHaveLength(0)
  })

  it('すでに終了したイベントには送らない（遅れて確定した申込の巻き添えを防ぐ）', async () => {
    const pushMessage = vi.fn()
    const { db } = stubDb([makeRow({ end_at: '2026-09-13T00:30:00.000Z' })]) // NOW より前

    const result = await processEventReminders(db, {
      defaultClient: { pushMessage },
      nowMs: NOW,
    })

    expect(result.sent).toBe(0)
    expect(pushMessage).not.toHaveBeenCalled()
  })

  it('同じ友だちが同じイベントに2件申し込んでいても1通だけ送る', async () => {
    const pushMessage = vi.fn().mockResolvedValue({})
    const { db, updates } = stubDb([
      makeRow({ booking_id: 1 }),
      makeRow({ booking_id: 2 }),
    ])

    const result = await processEventReminders(db, {
      defaultClient: { pushMessage },
      createClient: () => ({ pushMessage }),
      nowMs: NOW,
    })

    expect(pushMessage).toHaveBeenCalledTimes(1)
    expect(result.sent).toBe(1)
    // 1通しか送らないが、両方の申込を送信済みにする（次の tick で再送しないため）
    const marked = updates.find((u) => u.sql.includes('reminder_sent_at'))
    expect(marked?.bound).toEqual(expect.arrayContaining([1, 2]))
  })

  it('別の友だちには別々に送る', async () => {
    const pushMessage = vi.fn().mockResolvedValue({})
    const { db } = stubDb([
      makeRow({ booking_id: 1, friend_id: 'friend-1', line_user_id: 'U1' }),
      makeRow({ booking_id: 2, friend_id: 'friend-2', line_user_id: 'U2' }),
    ])

    const result = await processEventReminders(db, {
      defaultClient: { pushMessage },
      createClient: () => ({ pushMessage }),
      nowMs: NOW,
    })

    expect(result.sent).toBe(2)
    expect(pushMessage.mock.calls.map(([to]) => to)).toEqual(['U1', 'U2'])
  })

  it('push が失敗した人は送信済みにしない（次の tick で再試行される）', async () => {
    const pushMessage = vi.fn().mockRejectedValue(new Error('LINE down'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db, updates } = stubDb([makeRow()])

    const result = await processEventReminders(db, {
      defaultClient: { pushMessage },
      createClient: () => ({ pushMessage }),
      nowMs: NOW,
    })

    expect(result).toEqual({ sent: 0, failed: 1 })
    expect(updates.some((u) => u.sql.includes('reminder_sent_at'))).toBe(false)
    errorSpy.mockRestore()
  })

  it('1人の失敗が他の人の配信を止めない', async () => {
    const pushMessage = vi.fn()
      .mockRejectedValueOnce(new Error('LINE down'))
      .mockResolvedValue({})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = stubDb([
      makeRow({ booking_id: 1, friend_id: 'friend-1', line_user_id: 'U1' }),
      makeRow({ booking_id: 2, friend_id: 'friend-2', line_user_id: 'U2' }),
    ])

    const result = await processEventReminders(db, {
      defaultClient: { pushMessage },
      createClient: () => ({ pushMessage }),
      nowMs: NOW,
    })

    expect(result).toEqual({ sent: 1, failed: 1 })
    errorSpy.mockRestore()
  })

  it('友だちのアカウントのトークンでクライアントを作る', async () => {
    const pushMessage = vi.fn().mockResolvedValue({})
    const createClient = vi.fn(() => ({ pushMessage }))
    const { db } = stubDb([makeRow({ channel_access_token: 'account-token' })])

    await processEventReminders(db, {
      defaultClient: { pushMessage: vi.fn() },
      createClient,
      nowMs: NOW,
    })

    expect(createClient).toHaveBeenCalledWith('account-token')
  })

  it('アカウントのトークンが引けない場合は既定クライアントで送る', async () => {
    const defaultPush = vi.fn().mockResolvedValue({})
    const createClient = vi.fn()
    const { db } = stubDb([makeRow({ channel_access_token: null })])

    const result = await processEventReminders(db, {
      defaultClient: { pushMessage: defaultPush },
      createClient,
      nowMs: NOW,
    })

    expect(result.sent).toBe(1)
    expect(createClient).not.toHaveBeenCalled()
    expect(defaultPush).toHaveBeenCalledTimes(1)
  })

  it('確定・未送信・友だち継続中だけを DB 側で絞る', async () => {
    const { db, queries } = stubDb([])
    await processEventReminders(db, { defaultClient: { pushMessage: vi.fn() }, nowMs: NOW })

    const sql = queries.find((q) => q.includes('FROM event_bookings')) ?? ''
    expect(sql).toContain("status = 'confirmed'")
    expect(sql).toContain('reminder_sent_at IS NULL')
    expect(sql).toContain('reminder_at IS NOT NULL')
    expect(sql).toContain('is_following = 1')
  })
})
