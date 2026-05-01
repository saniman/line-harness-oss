export interface BusinessHoursRow {
  id: number
  day_of_week: number
  is_open: number
  start_hour: number
  end_hour: number
  slot_minutes: number
  created_at: string
  updated_at: string
}

export interface HolidayRow {
  id: number
  date: string
  reason: string | null
  created_at: string
}

export async function getBusinessHours(db: D1Database, dayOfWeek?: number): Promise<BusinessHoursRow[]> {
  if (dayOfWeek !== undefined) {
    const row = await db.prepare('SELECT * FROM business_hours WHERE day_of_week = ?')
      .bind(dayOfWeek).first<BusinessHoursRow>()
    return row ? [row] : []
  }
  const result = await db.prepare('SELECT * FROM business_hours ORDER BY day_of_week')
    .all<BusinessHoursRow>()
  return result.results
}

export async function isBusinessDay(db: D1Database, date: string): Promise<boolean> {
  const dow = new Date(`${date}T12:00:00+09:00`).getUTCDay()
  const bh = await db.prepare('SELECT * FROM business_hours WHERE day_of_week = ?')
    .bind(dow).first<BusinessHoursRow>()
  if (!bh || !bh.is_open) return false
  const holiday = await db.prepare('SELECT id FROM business_holidays WHERE date = ?')
    .bind(date).first<{ id: number }>()
  return !holiday
}

export async function getHolidays(db: D1Database, opts?: { from?: string; to?: string }): Promise<HolidayRow[]> {
  if (opts?.from && opts?.to) {
    const result = await db.prepare(
      'SELECT * FROM business_holidays WHERE date BETWEEN ? AND ? ORDER BY date'
    ).bind(opts.from, opts.to).all<HolidayRow>()
    return result.results
  }
  const result = await db.prepare('SELECT * FROM business_holidays ORDER BY date')
    .all<HolidayRow>()
  return result.results
}

export async function updateBusinessHours(
  db: D1Database,
  dayOfWeek: number,
  updates: { is_open?: number; start_hour?: number; end_hour?: number; slot_minutes?: number }
): Promise<BusinessHoursRow | null> {
  const sets: string[] = ["updated_at = datetime('now')"]
  const binds: unknown[] = []
  if (updates.is_open !== undefined) { sets.push('is_open = ?'); binds.push(updates.is_open) }
  if (updates.start_hour !== undefined) { sets.push('start_hour = ?'); binds.push(updates.start_hour) }
  if (updates.end_hour !== undefined) { sets.push('end_hour = ?'); binds.push(updates.end_hour) }
  if (updates.slot_minutes !== undefined) { sets.push('slot_minutes = ?'); binds.push(updates.slot_minutes) }
  binds.push(dayOfWeek)
  await db.prepare(`UPDATE business_hours SET ${sets.join(', ')} WHERE day_of_week = ?`)
    .bind(...binds).run()
  return db.prepare('SELECT * FROM business_hours WHERE day_of_week = ?')
    .bind(dayOfWeek).first<BusinessHoursRow>()
}

export async function addHoliday(db: D1Database, date: string, reason?: string | null): Promise<HolidayRow> {
  await db.prepare('INSERT INTO business_holidays (date, reason) VALUES (?, ?)')
    .bind(date, reason ?? null).run()
  const row = await db.prepare('SELECT * FROM business_holidays WHERE date = ?')
    .bind(date).first<HolidayRow>()
  return row!
}

export async function removeHoliday(db: D1Database, date: string): Promise<void> {
  await db.prepare('DELETE FROM business_holidays WHERE date = ?').bind(date).run()
}
