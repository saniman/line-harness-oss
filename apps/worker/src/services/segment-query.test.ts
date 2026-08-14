import { describe, it, expect } from 'vitest'
import { buildSegmentQuery, withFollowingOnly } from './segment-query.js'

describe('withFollowingOnly', () => {
  it('セグメント SQL にフォロー中の条件を差し込む', () => {
    const { sql } = buildSegmentQuery({
      operator: 'AND',
      rules: [{ type: 'ref_code', value: 'abc' }],
    })

    const filtered = withFollowingOnly(sql)

    expect(filtered).toContain('f.is_following = 1 AND')
    // 元の条件は保持される
    expect(filtered).toContain('ref_code')
  })

  it('バインド値を増やさない（リテラル 1 を使う）', () => {
    const { sql, bindings } = buildSegmentQuery({
      operator: 'AND',
      rules: [{ type: 'ref_code', value: 'abc' }],
    })

    const filtered = withFollowingOnly(sql)

    // ? の数が変わらない＝呼び出し側の bindings 順序に影響しない
    const before = (sql.match(/\?/g) ?? []).length
    const after = (filtered.match(/\?/g) ?? []).length
    expect(after).toBe(before)
    expect(bindings).toEqual(['abc'])
  })

  it('アカウント絞り込みを適用済みの SQL にも重ねられる（bindings 順序を壊さない）', () => {
    const { sql } = buildSegmentQuery({
      operator: 'AND',
      rules: [{ type: 'ref_code', value: 'abc' }],
    })
    // 送信経路と同じ順序: アカウント絞り込み → フォロー中
    const withAccount = sql.replace('WHERE', 'WHERE f.line_account_id = ? AND')

    const filtered = withFollowingOnly(withAccount)

    // is_following はリテラルなので、最初の ? は引き続き line_account_id のもの
    expect(filtered.indexOf('f.line_account_id = ?')).toBeGreaterThan(-1)
    expect(filtered.slice(0, filtered.indexOf('?'))).toContain('f.is_following = 1')
  })

  it('条件が空（全員）でもフォロー中に絞られる', () => {
    const { sql } = buildSegmentQuery({ operator: 'AND', rules: [] })

    expect(withFollowingOnly(sql)).toContain('f.is_following = 1 AND 1=1')
  })
})
