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
 * 折りたたみ対象にする cancel_reason。
 *
 * ホワイトリストにしているのは、cancel_reason に CHECK 制約を付けていない
 * （＝値が今後増える前提）ため。「null 以外は全部畳む」にすると、後から増えた理由
 * ——たとえば運営都合で返金対象の申込を取り消したケース——が、誰にも気づかれないまま
 * 折りたたみに消える。知らない値は畳まず一覧に出して気づけるようにする。
 */
const CHECKOUT_DROPOUT_REASONS = [
  'checkout_abandoned',
  'checkout_expired',
]

// checkout_create_failed はあえて含めない。あれは申込者の離脱ではなく
// こちら側の障害（Stripe の鍵ミス・API 障害）で、鍵を間違えた日は申込者全員が
// これになる。畳むと一覧が「決済に至った申込はまだありません」になり、
// 折りたたみを開かない限り警告に到達しない。通常の一覧に出して目に入るようにする。

/**
 * 決済に至らなかった申込か。
 *
 * status も見るのは、期限切れ扱いの後に決済が完了した申込（cancel_reason が
 * 残ったまま confirmed になる可能性がある）を隠さないため。
 */
export function isCheckoutDropout(booking: BookingDisplayRow): boolean {
  if (booking.status !== 'cancelled') return false
  return booking.cancel_reason !== null && CHECKOUT_DROPOUT_REASONS.includes(booking.cancel_reason)
}

/**
 * 決済離脱の理由を運営者向けの言葉にする。
 * 内部の識別子（checkout_expired 等）をそのまま画面に出さない。
 */
export function getDropoutReasonLabel(cancelReason: string | null): string {
  if (cancelReason === 'checkout_expired') return '決済画面を離脱（期限切れ）'
  if (cancelReason === 'checkout_abandoned') return '決済画面から戻る'
  // 申込者の離脱ではなく、こちら側の障害（Stripe の鍵ミス・API 障害）。
  // 「客が来なかった」と読み違えると原因調査が始まらないので明示的に分ける
  if (cancelReason === 'checkout_create_failed') return '⚠️ 決済の開始に失敗（要確認）'
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

/**
 * 参加者に確認する金額を決める。
 *
 * `event_bookings.amount` は Stripe の webhook（confirmEventBooking）でしか入らない。
 * 当日現金の申込は `createEventBooking` が amount を INSERT しないため**常に null**で、
 * 補わないと「現金受領」の確認ダイアログが毎回「金額未設定」になり、
 * 押し間違い防止として一度も機能しない。イベントの価格で補う。
 *
 * 0 は「無料」という意味のある値なので null に丸めない。
 */
export function resolveBookingAmount(
  booking: { amount: number | null },
  eventPrice: number | null | undefined,
): number | null {
  if (booking.amount != null) return booking.amount
  return eventPrice ?? null
}
