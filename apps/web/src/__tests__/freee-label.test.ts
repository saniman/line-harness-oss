import { describe, it, expect } from 'vitest'
import { sanitizeCompanyName, buildConnectionLabel, needsReauth } from '../lib/freee-label'

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

describe('sanitizeCompanyName（視覚偽装への耐性）', () => {
  const RLO = String.fromCharCode(0x202e)
  const ZWJ = String.fromCharCode(0x200d)
  const BOM = String.fromCharCode(0xfeff)
  const LRI = String.fromCharCode(0x2066)

  it('RLO（右横書きオーバーライド）を潰す', () => {
    // 残すと、併記した「（事業所ID: N）」が逆順に描画され、別のIDに見せかけられる
    expect(sanitizeCompanyName(`WALOVER${RLO}`)).toBe('WALOVER')
  })

  it('ゼロ幅接合子（ZWJ）を潰す', () => {
    expect(sanitizeCompanyName(`WALO${ZWJ}VER`)).toBe('WALO VER')
  })

  it('BOM / BIDI アイソレートも潰す', () => {
    expect(sanitizeCompanyName(`${BOM}A${LRI}B`)).toBe('A B')
  })

  it('RLO を混ぜても事業所IDの併記は残る', () => {
    const label = buildConnectionLabel(`偽装${RLO}`, 7654321)
    expect(label).toContain('事業所ID: 7654321')
    expect(label).not.toContain(RLO)
  })

  it('サロゲートペアの途中で切らない（壊れ字を出さない）', () => {
    // 40文字目が絵文字だと、コードユニット単位の slice では片割れが残る
    const name = 'あ'.repeat(39) + '😀' + 'い'.repeat(10)
    const result = sanitizeCompanyName(name)!
    expect(result).not.toContain(String.fromCharCode(0xfffd))
    expect(result).toContain('😀')
  })
})

describe('needsReauth', () => {
  const NOW = new Date('2026-09-05T12:00:00+09:00')

  it('期限が未来なら再連携は不要', () => {
    expect(needsReauth('2026-09-05T18:00:00.000+09:00', NOW)).toBe(false)
  })

  it('期限が過去なら再連携が必要', () => {
    expect(needsReauth('2026-09-05T06:00:00.000+09:00', NOW)).toBe(true)
  })

  it('未設定は再連携が必要', () => {
    expect(needsReauth(null, NOW)).toBe(true)
  })

  it('解釈できない値は再連携が必要（黙って正常に見せない）', () => {
    expect(needsReauth('こわれた値', NOW)).toBe(true)
  })
})
