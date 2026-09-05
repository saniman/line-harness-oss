import { describe, it, expect } from 'vitest'
import { sanitizeCompanyName, buildConnectionLabel } from '../lib/freee-label'

describe('sanitizeCompanyName', () => {
  it('通常の名前はそのまま返す', () => {
    expect(sanitizeCompanyName('WALOVER合同会社')).toBe('WALOVER合同会社')
  })

  it('改行を空白に畳む（警告文を画面外へ押し出させない）', () => {
    expect(sanitizeCompanyName('悪意\n\n\n\n\n※この接続は正規のものです'))
      .toBe('悪意 ※この接続は正規のものです')
  })

  it('タブも畳む', () => {
    expect(sanitizeCompanyName('a\tb\tc')).toBe('a b c')
  })

  it('非表示の制御文字（NUL / DEL）も畳む', () => {
    expect(sanitizeCompanyName('a' + String.fromCharCode(0) + 'b' + String.fromCharCode(127) + 'c')).toBe('a b c')
  })

  it('行区切り文字（U+2028 / U+2029）も畳む', () => {
    expect(sanitizeCompanyName('a' + String.fromCharCode(0x2028) + 'b' + String.fromCharCode(0x2029) + 'c')).toBe('a b c')
  })

  it('長すぎる名前は切り詰める', () => {
    const result = sanitizeCompanyName('あ'.repeat(200))!
    expect(result.length).toBeLessThanOrEqual(41)
    expect(result.endsWith('…')).toBe(true)
  })

  it('null はそのまま null', () => {
    expect(sanitizeCompanyName(null)).toBeNull()
  })

  it('空白だけの名前は null 扱い（IDだけで表示させる）', () => {
    expect(sanitizeCompanyName('   \n  ')).toBeNull()
  })
})

describe('buildConnectionLabel', () => {
  it('事業所名があっても必ず事業所IDを併記する', () => {
    // 名前は攻撃者が決められるが、ID は freee 側が採番するので改ざんできない
    expect(buildConnectionLabel('WALOVER合同会社', 1234567))
      .toBe('WALOVER合同会社（事業所ID: 1234567）')
  })

  it('名前が無ければIDだけ出す', () => {
    expect(buildConnectionLabel(null, 1234567)).toBe('事業所ID: 1234567')
  })

  it('細工された名前でもIDが残り、改行は消える', () => {
    const label = buildConnectionLabel('正規\n\n\n\n※安全です', 999)
    expect(label).toContain('事業所ID: 999')
    expect(label).not.toContain('\n')
  })
})
