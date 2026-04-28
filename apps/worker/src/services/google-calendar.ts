// Google Calendar API client
import type { Env } from '../index.js';

const GCAL_BASE = 'https://www.googleapis.com/calendar/v3';
const TIMEZONE = 'Asia/Tokyo';
const DEFAULT_REDIRECT_URI = 'https://api.walover-co.work/api/integrations/google-calendar/callback';

export interface GoogleCalendarConfig {
  calendarId: string;
  accessToken: string;
}

export interface BusyInterval {
  start: string;
  end: string;
}

export interface CreateEventInput {
  summary: string;
  start: string;   // ISO datetime string
  end: string;     // ISO datetime string
  description?: string;
  attendeeEmail?: string;
}

// ── OAuth helpers ──────────────────────────────────────────────────────────

export function getGoogleAuthUrl(env: Env['Bindings'], state?: string): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.GOOGLE_REDIRECT_URI ?? DEFAULT_REDIRECT_URI,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/calendar',
    access_type: 'offline',
    prompt: 'consent',
    ...(state ? { state } : {}),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeCodeForTokens(
  env: Env['Bindings'],
  code: string
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: env.GOOGLE_REDIRECT_URI ?? DEFAULT_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token exchange failed: ${err}`);
  }
  return res.json();
}

export async function refreshAccessToken(
  env: Env['Bindings'],
  refreshToken: string
): Promise<{ access_token: string; expires_in: number }> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token refresh failed: ${err}`);
  }
  return res.json();
}

export function isTokenExpiringSoon(expiresAt: Date | null, bufferMs = 5 * 60 * 1000): boolean {
  return !expiresAt || expiresAt.getTime() - Date.now() < bufferMs;
}

export function isSlotOverlapping(
  slotStart: number,
  slotEnd: number,
  intervalStart: number,
  intervalEnd: number
): boolean {
  return slotStart < intervalEnd && slotEnd > intervalStart;
}

export function generateSlots(
  date: string,
  startHour: number,
  endHour: number,
  slotMinutes: number
): { startAt: Date; endAt: Date }[] {
  const slots: { startAt: Date; endAt: Date }[] = [];
  const baseDate = new Date(`${date}T${String(startHour).padStart(2, '0')}:00:00+09:00`);
  for (let h = startHour; h < endHour; h += slotMinutes / 60) {
    const slotStart = new Date(baseDate);
    slotStart.setMinutes(slotStart.getMinutes() + (h - startHour) * 60);
    const slotEnd = new Date(slotStart);
    slotEnd.setMinutes(slotEnd.getMinutes() + slotMinutes);
    slots.push({ startAt: slotStart, endAt: slotEnd });
  }
  return slots;
}

// Returns a valid access token, refreshing if within 5 minutes of expiry.
export async function getValidAccessToken(
  env: Env['Bindings'],
  db: D1Database,
  connectionId: string
): Promise<string> {
  const conn = await db
    .prepare('SELECT * FROM google_calendar_connections WHERE id = ?')
    .bind(connectionId)
    .first<Record<string, unknown>>();

  if (!conn) throw new Error('Connection not found');
  if (!conn.refresh_token) {
    console.error('[GCal] refresh_tokenが未設定 — 再認証が必要です');
    throw new Error('REAUTH_REQUIRED');
  }

  const expiresAt = conn.token_expires_at ? new Date(conn.token_expires_at as string) : null;
  const shouldRefresh = isTokenExpiringSoon(expiresAt);

  if (shouldRefresh) {
    const tokens = await refreshAccessToken(env, conn.refresh_token as string);
    const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
    await db
      .prepare(
        'UPDATE google_calendar_connections SET access_token = ?, token_expires_at = ? WHERE id = ?'
      )
      .bind(tokens.access_token, newExpiresAt, connectionId)
      .run();
    return tokens.access_token;
  }

  return conn.access_token as string;
}

// getValidAccessToken でトークンを更新してから FreeBusy を取得する。
// conn.access_token を直接使わないことでトークン期限切れを防ぐ。
export async function getFreeBusyWithRefresh(
  env: Env['Bindings'],
  db: D1Database,
  connectionId: string,
  calendarId: string,
  timeMin: string,
  timeMax: string
): Promise<BusyInterval[]> {
  const accessToken = await getValidAccessToken(env, db, connectionId);
  const gcal = new GoogleCalendarClient({ calendarId, accessToken });
  return gcal.getFreeBusy(timeMin, timeMax);
}

// ── Event params builder ────────────────────────────────────────────────────

export interface CreateEventParams {
  summary: string;
  description?: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  attendees?: { email: string }[];
  sendUpdates?: 'all';
}

export function buildCreateEventParams(input: {
  title: string;
  startAt: string;
  endAt: string;
  description?: string;
  guestEmail?: string;
}): CreateEventParams {
  const params: CreateEventParams = {
    summary: input.title,
    description: input.description,
    start: { dateTime: input.startAt, timeZone: TIMEZONE },
    end: { dateTime: input.endAt, timeZone: TIMEZONE },
  };
  if (input.guestEmail) {
    params.attendees = [{ email: input.guestEmail }];
    params.sendUpdates = 'all';
  }
  return params;
}

// ── API client ─────────────────────────────────────────────────────────────

export class GoogleCalendarClient {
  constructor(private config: GoogleCalendarConfig) {}

  /**
   * Get busy time intervals from Google Calendar FreeBusy API.
   * Returns an array of { start, end } intervals when the calendar is busy.
   */
  async getFreeBusy(timeMin: string, timeMax: string): Promise<BusyInterval[]> {
    const url = `${GCAL_BASE}/freeBusy`;
    const body = {
      timeMin,
      timeMax,
      items: [{ id: this.config.calendarId }],
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Google FreeBusy API error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as {
      calendars?: Record<string, { busy?: { start: string; end: string }[] }>;
    };

    const calendarData = data.calendars?.[this.config.calendarId];
    return calendarData?.busy ?? [];
  }

  /**
   * Create an event on Google Calendar.
   * Returns the created event's ID.
   */
  async createEvent(event: CreateEventInput): Promise<{ eventId: string }> {
    const params = buildCreateEventParams({
      title: event.summary,
      startAt: event.start,
      endAt: event.end,
      description: event.description,
      guestEmail: event.attendeeEmail,
    });

    // sendUpdates は Google Calendar API のクエリパラメータ（ボディではない）
    const { sendUpdates, ...bodyParams } = params;
    const baseUrl = `${GCAL_BASE}/calendars/${encodeURIComponent(this.config.calendarId)}/events`;
    const url = sendUpdates ? `${baseUrl}?sendUpdates=${sendUpdates}` : baseUrl;

    console.log('[GCal] createEvent リクエスト', {
      url,
      attendees: bodyParams.attendees,
      hasGuestEmail: !!bodyParams.attendees?.length,
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(bodyParams),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Google Calendar createEvent error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as { id?: string };
    if (!data.id) {
      throw new Error('Google Calendar createEvent: response missing event id');
    }

    console.log('[GCal] createEvent レスポンス', { status: res.status, eventId: data.id });
    return { eventId: data.id };
  }

  /**
   * Delete an event from Google Calendar.
   */
  async deleteEvent(eventId: string): Promise<void> {
    const url = `${GCAL_BASE}/calendars/${encodeURIComponent(this.config.calendarId)}/events/${encodeURIComponent(eventId)}`;

    const res = await fetch(url, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
      },
    });

    // 204 = success, 410 = already deleted — both are acceptable
    if (!res.ok && res.status !== 410) {
      const text = await res.text().catch(() => '');
      throw new Error(`Google Calendar deleteEvent error ${res.status}: ${text}`);
    }
  }
}
