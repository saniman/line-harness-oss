import { describe, it, expect } from 'vitest'
import { apiUrl } from './api-url.js'

const BASE = 'https://api.walover-co.work'

describe('apiUrl', () => {
  it('API_BASE があれば絶対URLにする', () => {
    // LIFF は Pages、API は別ドメインの Worker。相対パスだと Pages に着弾して
    // HTML が返り res.json() が失敗する（.claude/rules/liff.md）
    expect(apiUrl('/api/liff/config', BASE)).toBe(`${BASE}/api/liff/config`)
  })

  it('クエリ文字列を保持する', () => {
    expect(apiUrl('/api/liff/config?liffId=1661159603-5qlDj5wV', BASE))
      .toBe(`${BASE}/api/liff/config?liffId=1661159603-5qlDj5wV`)
  })

  it('エンコード済みのクエリを壊さない', () => {
    const path = '/api/liff/config?liffId=' + encodeURIComponent('1661159603-5qlDj5wV')
    expect(apiUrl(path, BASE)).toContain('liffId=1661159603-5qlDj5wV')
  })

  it('API_BASE が末尾スラッシュ付きでもパスが重複しない', () => {
    expect(apiUrl('/api/liff/link', 'https://api.walover-co.work/')).toBe(`${BASE}/api/liff/link`)
  })

  it('API_BASE が空なら相対パスのまま返す（同一オリジン配信へのフォールバック）', () => {
    // Worker が assets で LIFF を配信するケースでは相対パスで正しく届く
    expect(apiUrl('/api/liff/config', '')).toBe('/api/liff/config')
  })

  it('API_BASE が不正でも例外を投げず相対パスにフォールバックする', () => {
    // new URL() は同期 throw する。best-effort な fetch(...).catch() では拾えず
    // 画面全体のエラーになるため、ここで吸収する
    expect(() => apiUrl('/api/liff/link', 'not-a-url')).not.toThrow()
    expect(apiUrl('/api/liff/link', 'not-a-url')).toBe('/api/liff/link')
  })
})
