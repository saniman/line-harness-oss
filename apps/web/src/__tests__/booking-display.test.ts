import { describe, it, expect } from 'vitest'
import {
  getStatusBadge,
  participantDisplayName,
  isCheckoutDropout,
  partitionBookings,
  getDropoutReasonLabel,
} from '../lib/booking-display'

type Row = Parameters<typeof partitionBookings>[0][number]

function row(overrides: Partial<Row> = {}): Row {
  return {
    status: 'confirmed',
    name: '山田太郎',
    friend_display_name: null,
    cancel_reason: null,
    ...overrides,
  } as Row
}

describe('参加者のステータスバッジ', () => {
  it('確定は緑になる', () => {
    expect(getStatusBadge('confirmed').label).toBe('確定')
    expect(getStatusBadge('confirmed').cls).toContain('green')
  })

  it('保留とキャンセルが確定と同じ色にならない', () => {
    // 全部緑だと一覧を見たときに確定と見分けがつかない（Issue #56）
    const confirmed = getStatusBadge('confirmed').cls
    expect(getStatusBadge('pending').cls).not.toBe(confirmed)
    expect(getStatusBadge('cancelled').cls).not.toBe(confirmed)
  })

  it('保留とキャンセルも互いに違う色になる', () => {
    expect(getStatusBadge('pending').cls).not.toBe(getStatusBadge('cancelled').cls)
  })

  it('想定外の値はそのまま出して気づけるようにする', () => {
    expect(getStatusBadge('weird').label).toBe('weird')
  })
})

describe('参加者の表示名', () => {
  it('申込時の名前があればそれを使う', () => {
    expect(participantDisplayName(row({ name: '山田太郎' }))).toBe('山田太郎')
  })

  it('名前が空なら友だちの表示名にフォールバックする', () => {
    // Stripe 決済に到達しなかった申込は name が空のまま残る。
    // friend_id は紐づいているので LINE の表示名は出せる（Issue #56）
    expect(participantDisplayName(row({ name: '', friend_display_name: 'あきひさ' }))).toBe('あきひさ')
  })

  it('空白だけの名前も空として扱う', () => {
    expect(participantDisplayName(row({ name: '  ', friend_display_name: 'あきひさ' }))).toBe('あきひさ')
  })

  it('どちらも無ければ空欄でなく理由が分かる表記にする', () => {
    const label = participantDisplayName(row({ name: '', friend_display_name: null }))
    expect(label).not.toBe('')
    expect(label).toContain('未取得')
  })
})

describe('決済離脱の判定', () => {
  it('cancel_reason があれば離脱とみなす', () => {
    expect(isCheckoutDropout(row({ status: 'cancelled', cancel_reason: 'checkout_expired' }))).toBe(true)
    expect(isCheckoutDropout(row({ status: 'cancelled', cancel_reason: 'checkout_abandoned' }))).toBe(true)
  })

  it('本人都合のキャンセルは離脱としない', () => {
    // 返金対象になり得る申込を一覧から隠してはいけない
    expect(isCheckoutDropout(row({ status: 'cancelled', cancel_reason: null }))).toBe(false)
  })

  it('Stripe セッション作成の失敗も離脱とみなす', () => {
    expect(isCheckoutDropout(row({ status: 'cancelled', cancel_reason: 'checkout_create_failed' }))).toBe(true)
  })

  it('未知の理由は畳まず一覧に出す', () => {
    // cancel_reason に CHECK 制約を付けていない＝値は今後増える前提。
    // 知らない理由を無条件で畳むと、例えば運営都合の返金対象キャンセルが
    // 誰にも気づかれず折りたたみに消える（同ファイルの他の関数と方針を揃える）
    expect(isCheckoutDropout(row({ status: 'cancelled', cancel_reason: 'admin_cancelled' }))).toBe(false)
  })

  it('確定済みは cancel_reason が残っていても離脱としない', () => {
    // 期限切れ扱いの後に決済が完了したケース。確定を隠すと当日の人数が合わなくなる
    expect(isCheckoutDropout(row({ status: 'confirmed', cancel_reason: 'checkout_expired' }))).toBe(false)
  })

  it('まだ決済中の pending は離脱としない', () => {
    expect(isCheckoutDropout(row({ status: 'pending', cancel_reason: null }))).toBe(false)
  })
})

describe('決済離脱の理由ラベル', () => {
  it('期限切れと途中離脱を運営者に分かる言葉で出し分ける', () => {
    const expired = getDropoutReasonLabel('checkout_expired')
    const abandoned = getDropoutReasonLabel('checkout_abandoned')
    expect(expired).not.toBe(abandoned)
    expect(expired).not.toContain('checkout')
    expect(abandoned).not.toContain('checkout')
  })

  it('未知の理由はそのまま出して気づけるようにする', () => {
    expect(getDropoutReasonLabel('something_new')).toBe('something_new')
  })

  it('Stripe セッション作成の失敗は離脱と区別できる言葉にする', () => {
    // 鍵の設定ミスや Stripe 障害を「客が離脱しただけ」と読み違えないようにする
    const failed = getDropoutReasonLabel('checkout_create_failed')
    expect(failed).not.toBe(getDropoutReasonLabel('checkout_expired'))
    expect(failed).not.toContain('checkout')
  })

  it('理由が無い場合も空文字にならない', () => {
    expect(getDropoutReasonLabel(null)).not.toBe('')
  })
})

describe('参加者一覧の仕分け', () => {
  const bookings = [
    row({ status: 'confirmed', name: 'あきひさ' }),
    row({ status: 'confirmed', name: 'まみ' }),
    row({ status: 'cancelled', name: '黒部', cancel_reason: null }),
    row({ status: 'cancelled', name: '', cancel_reason: 'checkout_abandoned' }),
    row({ status: 'cancelled', name: '', cancel_reason: 'checkout_expired' }),
    row({ status: 'cancelled', name: '', cancel_reason: 'checkout_create_failed' }),
  ]

  it('離脱行を通常の一覧から外す', () => {
    const { active, dropouts } = partitionBookings(bookings)
    expect(active).toHaveLength(3)
    expect(dropouts).toHaveLength(3)
  })

  it('確定人数は確定ステータスだけ数える', () => {
    // ヘッダーに全件数を出すと定員と混同して「満席では」と誤読される（Issue #56）
    expect(partitionBookings(bookings).confirmedCount).toBe(2)
  })

  it('空配列でも壊れない', () => {
    const { active, dropouts, confirmedCount } = partitionBookings([])
    expect(active).toEqual([])
    expect(dropouts).toEqual([])
    expect(confirmedCount).toBe(0)
  })

  it('元の並び順を保つ', () => {
    const { active } = partitionBookings(bookings)
    expect(active.map((b) => b.name)).toEqual(['あきひさ', 'まみ', '黒部'])
  })
})
