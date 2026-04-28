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

export function formatJST(iso: string): string {
  const d = new Date(iso)
  const jst = new Date(d.getTime())
  // Use Intl for correct JST output regardless of host timezone
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(jst).replace(/\//g, '/').replace(',', '')
}

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
