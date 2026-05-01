import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'

vi.mock('../services/business-hours.js', () => ({
  getBusinessHours: vi.fn(),
  updateBusinessHours: vi.fn(),
  isBusinessDay: vi.fn(),
  getHolidays: vi.fn(),
  addHoliday: vi.fn(),
  removeHoliday: vi.fn(),
}))

import * as bhService from '../services/business-hours.js'
import { businessHours } from './business-hours.js'

const mockDb = {} as D1Database
const app = new Hono()
app.route('/', businessHours)

const BH_MON = { id: 2, day_of_week: 1, is_open: 1, start_hour: 9, end_hour: 18, slot_minutes: 60, created_at: '', updated_at: '' }
const BH_SUN = { id: 1, day_of_week: 0, is_open: 0, start_hour: 9, end_hour: 18, slot_minutes: 60, created_at: '', updated_at: '' }
const HOLIDAY = { id: 1, date: '2026-05-11', reason: '社内休業', created_at: '' }

beforeEach(() => { vi.clearAllMocks() })

describe('GET /api/business-hours', () => {
  it('全曜日の設定一覧を返す', async () => {
    vi.mocked(bhService.getBusinessHours).mockResolvedValue([BH_SUN, BH_MON])
    const res = await app.request('/api/business-hours', {}, { DB: mockDb })
    expect(res.status).toBe(200)
    const json = await res.json() as { success: boolean; data: unknown[] }
    expect(json.success).toBe(true)
    expect(json.data).toHaveLength(2)
  })
})

describe('PUT /api/business-hours/:dayOfWeek', () => {
  it('曜日設定を更新する', async () => {
    const updated = { ...BH_MON, start_hour: 10, end_hour: 17 }
    vi.mocked(bhService.updateBusinessHours).mockResolvedValue(updated)
    const res = await app.request('/api/business-hours/1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start_hour: 10, end_hour: 17 }),
    }, { DB: mockDb })
    expect(res.status).toBe(200)
    const json = await res.json() as { success: boolean; data: typeof updated }
    expect(json.success).toBe(true)
    expect(vi.mocked(bhService.updateBusinessHours)).toHaveBeenCalledWith(mockDb, 1, { start_hour: 10, end_hour: 17 })
  })

  it('dayOfWeekが7以上はエラーを返す', async () => {
    const res = await app.request('/api/business-hours/7', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_open: 1 }),
    }, { DB: mockDb })
    expect(res.status).toBe(400)
  })

  it('dayOfWeekが負数はエラーを返す', async () => {
    const res = await app.request('/api/business-hours/-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_open: 1 }),
    }, { DB: mockDb })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/business-hours/holidays', () => {
  it('休業日一覧を返す', async () => {
    vi.mocked(bhService.getHolidays).mockResolvedValue([HOLIDAY])
    const res = await app.request('/api/business-hours/holidays', {}, { DB: mockDb })
    expect(res.status).toBe(200)
    const json = await res.json() as { success: boolean; data: unknown[] }
    expect(json.success).toBe(true)
    expect(json.data).toHaveLength(1)
  })

  it('from/toクエリパラメータで期間フィルタが渡される', async () => {
    vi.mocked(bhService.getHolidays).mockResolvedValue([HOLIDAY])
    await app.request('/api/business-hours/holidays?from=2026-05-01&to=2026-05-31', {}, { DB: mockDb })
    expect(vi.mocked(bhService.getHolidays)).toHaveBeenCalledWith(mockDb, { from: '2026-05-01', to: '2026-05-31' })
  })
})

describe('POST /api/business-hours/holidays', () => {
  it('休業日を追加して201を返す', async () => {
    vi.mocked(bhService.addHoliday).mockResolvedValue({ id: 2, date: '2026-12-25', reason: 'クリスマス', created_at: '' })
    const res = await app.request('/api/business-hours/holidays', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: '2026-12-25', reason: 'クリスマス' }),
    }, { DB: mockDb })
    expect(res.status).toBe(201)
    const json = await res.json() as { success: boolean }
    expect(json.success).toBe(true)
  })

  it('dateが不正な形式はエラーを返す', async () => {
    const res = await app.request('/api/business-hours/holidays', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: 'not-a-date' }),
    }, { DB: mockDb })
    expect(res.status).toBe(400)
  })

  it('dateが未指定はエラーを返す', async () => {
    const res = await app.request('/api/business-hours/holidays', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'test' }),
    }, { DB: mockDb })
    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/business-hours/holidays/:date', () => {
  it('休業日を削除して200を返す', async () => {
    vi.mocked(bhService.removeHoliday).mockResolvedValue(undefined)
    const res = await app.request('/api/business-hours/holidays/2026-05-11', {
      method: 'DELETE',
    }, { DB: mockDb })
    expect(res.status).toBe(200)
    const json = await res.json() as { success: boolean }
    expect(json.success).toBe(true)
    expect(vi.mocked(bhService.removeHoliday)).toHaveBeenCalledWith(mockDb, '2026-05-11')
  })
})
