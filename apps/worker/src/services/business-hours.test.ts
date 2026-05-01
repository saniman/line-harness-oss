import { describe, it, expect, vi, beforeEach } from 'vitest'

interface BhRow {
  id: number; day_of_week: number; is_open: number
  start_hour: number; end_hour: number; slot_minutes: number
  created_at: string; updated_at: string
}
interface HolidayRow {
  id: number; date: string; reason: string | null; created_at: string
}

function makeStmt(firstResult: unknown = null, allResult: { results: unknown[] } = { results: [] }) {
  return {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({}),
    first: vi.fn().mockResolvedValue(firstResult),
    all: vi.fn().mockResolvedValue(allResult),
  }
}

function makeDb(...stmts: ReturnType<typeof makeStmt>[]) {
  let i = 0
  return { prepare: vi.fn().mockImplementation(() => stmts[i++] ?? makeStmt()) } as unknown as D1Database
}

import { getBusinessHours, isBusinessDay, getHolidays, updateBusinessHours, addHoliday, removeHoliday } from './business-hours.js'

const MON: BhRow = { id: 2, day_of_week: 1, is_open: 1, start_hour: 9, end_hour: 18, slot_minutes: 60, created_at: '', updated_at: '' }
const SUN: BhRow = { id: 1, day_of_week: 0, is_open: 0, start_hour: 9, end_hour: 18, slot_minutes: 60, created_at: '', updated_at: '' }
const H1: HolidayRow = { id: 1, date: '2026-05-11', reason: '社内休業', created_at: '' }
const H2: HolidayRow = { id: 2, date: '2026-06-01', reason: null, created_at: '' }

beforeEach(() => { vi.clearAllMocks() })

describe('getBusinessHours', () => {
  it('全曜日の営業時間を返す', async () => {
    const db = makeDb(makeStmt(null, { results: [SUN, MON] }))
    const result = await getBusinessHours(db)
    expect(result).toHaveLength(2)
    expect(result[0].day_of_week).toBe(0)
    expect(result[1].day_of_week).toBe(1)
  })

  it('指定曜日の営業時間を返す', async () => {
    const db = makeDb(makeStmt(MON))
    const result = await getBusinessHours(db, 1)
    expect(result).toHaveLength(1)
    expect(result[0].day_of_week).toBe(1)
    expect(result[0].is_open).toBe(1)
  })

  it('存在しない曜日は空配列を返す', async () => {
    const db = makeDb(makeStmt(null))
    const result = await getBusinessHours(db, 1)
    expect(result).toHaveLength(0)
  })
})

describe('isBusinessDay', () => {
  it('営業日はtrueを返す', async () => {
    // 2026-05-11 = 月曜日 (day_of_week=1)
    const db = makeDb(makeStmt(MON), makeStmt(null))
    const result = await isBusinessDay(db, '2026-05-11')
    expect(result).toBe(true)
  })

  it('is_open=0の曜日はfalseを返す', async () => {
    // 2026-05-10 = 日曜日 (day_of_week=0)
    const db = makeDb(makeStmt(SUN))
    const result = await isBusinessDay(db, '2026-05-10')
    expect(result).toBe(false)
  })

  it('business_holidaysに登録された日はfalseを返す', async () => {
    // 2026-05-11 = 月曜日だが休業日登録あり
    const db = makeDb(makeStmt(MON), makeStmt(H1))
    const result = await isBusinessDay(db, '2026-05-11')
    expect(result).toBe(false)
  })

  it('business_hoursが未設定の場合はfalseを返す', async () => {
    const db = makeDb(makeStmt(null))
    const result = await isBusinessDay(db, '2026-05-11')
    expect(result).toBe(false)
  })
})

describe('getHolidays', () => {
  it('休業日一覧を返す', async () => {
    const db = makeDb(makeStmt(null, { results: [H1, H2] }))
    const result = await getHolidays(db)
    expect(result).toHaveLength(2)
    expect(result[0].date).toBe('2026-05-11')
  })

  it('指定期間内の休業日を返す', async () => {
    const db = makeDb(makeStmt(null, { results: [H1] }))
    const result = await getHolidays(db, { from: '2026-05-01', to: '2026-05-31' })
    expect(result).toHaveLength(1)
    expect(result[0].date).toBe('2026-05-11')
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('BETWEEN'))
  })
})

describe('updateBusinessHours', () => {
  it('指定曜日の設定を更新する', async () => {
    const updated: BhRow = { ...MON, start_hour: 10, end_hour: 17 }
    const db = makeDb(makeStmt(null), makeStmt(updated))
    const result = await updateBusinessHours(db, 1, { start_hour: 10, end_hour: 17 })
    expect(result).not.toBeNull()
    expect(result?.start_hour).toBe(10)
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE business_hours'))
  })
})

describe('addHoliday', () => {
  it('休業日を追加する', async () => {
    const newHoliday: HolidayRow = { id: 3, date: '2026-12-25', reason: 'クリスマス', created_at: '' }
    const db = makeDb(makeStmt(null), makeStmt(newHoliday))
    const result = await addHoliday(db, '2026-12-25', 'クリスマス')
    expect(result.date).toBe('2026-12-25')
    expect(result.reason).toBe('クリスマス')
  })
})

describe('removeHoliday', () => {
  it('休業日を削除する', async () => {
    const db = makeDb(makeStmt(null))
    await removeHoliday(db, '2026-05-11')
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('DELETE'))
  })
})
