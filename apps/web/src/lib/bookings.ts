export type BookingStatus = 'confirmed' | 'cancelled'

export interface Booking {
  id: string
  connectionId: string
  friendId: string | null
  eventId: string | null
  title: string
  startAt: string
  endAt: string
  status: BookingStatus
  metadata: { name?: string; email?: string } | null
  createdAt: string
  // joined
  displayName?: string | null
}

/**
 * 予約日時の表示（`2026/09/01 10:50`）。
 *
 * 実体は `lib/format-jst.ts` に集約した。DB には UTC・スペース区切りと
 * JST・オフセット無しの 2 系統が混在しており、素の `new Date()` では
 * ローカル時刻として誤解釈されるため（Issue #58）。
 * 呼び出し側の import を変えずに済むよう、この名前は再エクスポートで残す。
 */
export { formatJSTWithYear as formatJST } from './format-jst'

export function getBookingName(booking: Pick<Booking, 'metadata' | 'displayName'>): string {
  return booking.metadata?.name || booking.displayName || '不明'
}

export const STATUS_LABEL: Record<BookingStatus, string> = {
  confirmed: '確定',
  cancelled: 'キャンセル',
}

export const STATUS_CLASS: Record<BookingStatus, string> = {
  confirmed: 'bg-green-100 text-green-800',
  cancelled: 'bg-gray-100 text-gray-500',
}

export function canCancel(booking: Pick<Booking, 'status'>): boolean {
  return booking.status === 'confirmed'
}
