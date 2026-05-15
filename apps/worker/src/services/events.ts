export interface EventRow {
  id: number
  title: string
  description: string | null
  start_at: string
  end_at: string
  capacity: number
  price: number | null
  is_published: number
  created_at: string
  updated_at: string
}

export interface EventWithCount extends EventRow {
  participant_count: number
}

export interface EventBookingRow {
  id: number
  event_id: number
  friend_id: string | null
  name: string
  email: string
  status: string
  payment_status: string
  stripe_session_id: string | null
  paid_at: string | null
  amount: number | null
  created_at: string
  updated_at: string
}

const PARTICIPANT_COUNT_SQL = `(SELECT COUNT(*) FROM event_bookings WHERE event_id = e.id AND status = 'confirmed') AS participant_count`

export async function createEvent(
  db: D1Database,
  data: { title: string; description?: string; start_at: string; end_at: string; capacity: number; is_published?: number },
): Promise<EventWithCount> {
  if (!data.title) throw new Error('title is required')
  const result = await db.prepare(
    'INSERT INTO events (title, description, start_at, end_at, capacity, is_published) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(data.title, data.description ?? null, data.start_at, data.end_at, data.capacity, data.is_published ?? 0).run()
  const lastId = (result as { meta?: { last_row_id?: number } }).meta?.last_row_id
  const row = await db.prepare(
    `SELECT e.*, ${PARTICIPANT_COUNT_SQL} FROM events e WHERE e.id = ?`,
  ).bind(lastId).first<EventWithCount>()
  return row!
}

export async function getEvents(db: D1Database): Promise<EventWithCount[]> {
  const result = await db.prepare(
    `SELECT e.*, ${PARTICIPANT_COUNT_SQL} FROM events e ORDER BY e.start_at`,
  ).all<EventWithCount>()
  return result.results
}

export async function getEventById(db: D1Database, id: number): Promise<EventWithCount | null> {
  const row = await db.prepare(
    `SELECT e.*, ${PARTICIPANT_COUNT_SQL} FROM events e WHERE e.id = ?`,
  ).bind(id).first<EventWithCount>()
  return row ?? null
}

export async function updateEvent(
  db: D1Database,
  id: number,
  updates: Partial<Pick<EventRow, 'title' | 'description' | 'start_at' | 'end_at' | 'capacity' | 'is_published'>>,
): Promise<EventWithCount | null> {
  const sets: string[] = ["updated_at = datetime('now')"]
  const binds: unknown[] = []
  if (updates.title !== undefined) { sets.push('title = ?'); binds.push(updates.title) }
  if (updates.description !== undefined) { sets.push('description = ?'); binds.push(updates.description) }
  if (updates.start_at !== undefined) { sets.push('start_at = ?'); binds.push(updates.start_at) }
  if (updates.end_at !== undefined) { sets.push('end_at = ?'); binds.push(updates.end_at) }
  if (updates.capacity !== undefined) { sets.push('capacity = ?'); binds.push(updates.capacity) }
  if (updates.is_published !== undefined) { sets.push('is_published = ?'); binds.push(updates.is_published) }
  binds.push(id)
  await db.prepare(`UPDATE events SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run()
  return getEventById(db, id)
}

export async function deleteEvent(db: D1Database, id: number): Promise<void> {
  await db.prepare('DELETE FROM events WHERE id = ?').bind(id).run()
}

export async function getParticipantCount(db: D1Database, eventId: number): Promise<number> {
  const row = await db.prepare(
    "SELECT COUNT(*) AS count FROM event_bookings WHERE event_id = ? AND status = 'confirmed'",
  ).bind(eventId).first<{ count: number }>()
  return row?.count ?? 0
}

export async function getEventBookings(db: D1Database, eventId: number): Promise<EventBookingRow[]> {
  const result = await db.prepare(
    "SELECT * FROM event_bookings WHERE event_id = ? AND status = 'confirmed' ORDER BY created_at",
  ).bind(eventId).all<EventBookingRow>()
  return result.results
}

export async function createEventBooking(
  db: D1Database,
  data: { event_id: number; friend_id?: string | null; name: string; email: string },
): Promise<EventBookingRow> {
  const result = await db.prepare(
    'INSERT INTO event_bookings (event_id, friend_id, name, email) VALUES (?, ?, ?, ?)',
  ).bind(data.event_id, data.friend_id ?? null, data.name, data.email).run()
  const lastId = (result as { meta?: { last_row_id?: number } }).meta?.last_row_id
  const row = await db.prepare('SELECT * FROM event_bookings WHERE id = ?')
    .bind(lastId).first<EventBookingRow>()
  return row!
}

export async function createPendingBooking(
  db: D1Database,
  data: { event_id: number; friend_id?: string | null; name?: string; email?: string },
): Promise<EventBookingRow> {
  const result = await db.prepare(
    "INSERT INTO event_bookings (event_id, friend_id, name, email, status, payment_status) VALUES (?, ?, ?, ?, 'pending', 'unpaid')",
  ).bind(data.event_id, data.friend_id ?? null, data.name ?? '', data.email ?? '').run()
  const lastId = (result as { meta?: { last_row_id?: number } }).meta?.last_row_id
  const row = await db.prepare('SELECT * FROM event_bookings WHERE id = ?')
    .bind(lastId).first<EventBookingRow>()
  return row!
}

export async function updateBookingStripeSessionId(
  db: D1Database,
  bookingId: number,
  sessionId: string,
): Promise<void> {
  await db.prepare(
    "UPDATE event_bookings SET stripe_session_id = ?, updated_at = datetime('now') WHERE id = ?",
  ).bind(sessionId, bookingId).run()
}

export async function getEventBookingById(db: D1Database, id: number): Promise<EventBookingRow | null> {
  const row = await db.prepare('SELECT * FROM event_bookings WHERE id = ?')
    .bind(id).first<EventBookingRow>()
  return row ?? null
}

export async function confirmEventBooking(
  db: D1Database,
  bookingId: number,
  amountTotal: number | null,
): Promise<void> {
  await db.prepare(
    "UPDATE event_bookings SET status = 'confirmed', payment_status = 'paid', paid_at = datetime('now'), amount = ?, updated_at = datetime('now') WHERE id = ?",
  ).bind(amountTotal, bookingId).run()
}
