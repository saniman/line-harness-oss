// イベント参加者一覧の表示ロジック。
// pure function に切り出して __tests__/booking-display.test.ts でカバーする
// （payment-badge.ts と同じ作法）。

export type StatusBadge = {
  label: string
  cls: string
}

/**
 * 申込ステータスのバッジ。
 *
 * 以前は全ステータスを同じ緑で描いていたため、キャンセル・保留が確定と見分けられなかった。
 * 決済バッジ（payment-badge.ts）と色の意味を揃える: 緑=確定 / 黄=保留 / グレー=終了。
 */
export function getStatusBadge(status: string): StatusBadge {
  if (status === 'confirmed') return { label: '確定', cls: 'bg-green-100 text-green-700' }
  if (status === 'pending') return { label: '保留', cls: 'bg-yellow-100 text-yellow-700' }
  if (status === 'cancelled') return { label: 'キャンセル', cls: 'bg-gray-100 text-gray-500' }
  // 想定外の値は無言で丸めず、そのまま出して気づけるようにする
  return { label: status, cls: 'bg-gray-100 text-gray-700' }
}

/** 表示に必要な最小の申込。EventBookingItem がこの形を満たす。 */
export interface BookingDisplayRow {
  status: string
  name: string
  friend_display_name: string | null
  cancel_reason: string | null
}

/**
 * 一覧に出す参加者名。
 *
 * Stripe 決済に到達しなかった申込は name が空のまま残る（名前は決済完了時に
 * customer_details から埋める設計のため）。friend_id は紐づいているので、
 * LINE の表示名にフォールバックすれば空欄を避けられる。
 */
export function participantDisplayName(booking: BookingDisplayRow): string {
  const name = booking.name?.trim()
  if (name) return name
  if (booking.friend_display_name) return booking.friend_display_name
  return '(名前未取得)'
}

/**
 * 決済に至らなかった申込か。
 *
 * status も見るのは、期限切れ扱いの後に決済が完了した申込（cancel_reason が
 * 残ったまま confirmed になる可能性がある）を隠さないため。
 */
export function isCheckoutDropout(booking: BookingDisplayRow): boolean {
  return booking.status === 'cancelled' && booking.cancel_reason !== null
}

/**
 * 決済離脱の理由を運営者向けの言葉にする。
 * 内部の識別子（checkout_expired 等）をそのまま画面に出さない。
 */
export function getDropoutReasonLabel(cancelReason: string | null): string {
  if (cancelReason === 'checkout_expired') return '決済画面を離脱（期限切れ）'
  if (cancelReason === 'checkout_abandoned') return '決済画面から戻る'
  // 想定外の値・null は無言で丸めず、そのまま出して気づけるようにする
  return cancelReason ?? 'キャンセル'
}

/**
 * 参加者一覧を「通常表示するもの」と「決済に至らなかったもの」に仕分ける。
 * 並び順は元の配列（申込順）を保つ。
 */
export function partitionBookings<T extends BookingDisplayRow>(
  bookings: T[],
): { active: T[]; dropouts: T[]; confirmedCount: number } {
  const active: T[] = []
  const dropouts: T[] = []
  for (const b of bookings) {
    if (isCheckoutDropout(b)) dropouts.push(b)
    else active.push(b)
  }
  return {
    active,
    dropouts,
    confirmedCount: bookings.filter((b) => b.status === 'confirmed').length,
  }
}
