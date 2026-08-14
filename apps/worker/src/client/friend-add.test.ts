// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { buildFriendAddHtml } from './friend-add.js'

const PROFILE = { displayName: '山田太郎', pictureUrl: 'https://example.com/p.jpg' }

describe('buildFriendAddHtml', () => {
  it('botBasicId があれば友だち追加リンクを出す', () => {
    const html = buildFriendAddHtml(PROFILE, '@173djjvp')

    expect(html).toContain('href="https://line.me/R/ti/p/@173djjvp"')
    expect(html).toContain('友だち追加して始める')
    expect(html).toContain('追加後、この画面に戻ってきてください')
  })

  it('botBasicId が空なら href="#" のボタンを出さない（タップしても無反応な状態を作らない）', () => {
    const html = buildFriendAddHtml(PROFILE, '')

    expect(html).not.toContain('href="#"')
    expect(html).not.toContain('友だち追加して始める')
    // 何が起きているか分かる文言を出す
    expect(html).toContain('友だち追加リンクを取得できませんでした')
  })

  it('表示名をエスケープする', () => {
    const html = buildFriendAddHtml({ displayName: '<script>alert(1)</script>' }, '@abc')

    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('pictureUrl が無ければ img を出さない', () => {
    const html = buildFriendAddHtml({ displayName: '山田太郎' }, '@abc')

    expect(html).not.toContain('<img')
    expect(html).toContain('山田太郎')
  })

  it('botBasicId の前後の空白を除去する（href が壊れて無反応になるのを防ぐ）', () => {
    const html = buildFriendAddHtml(PROFILE, '  @173djjvp\n')

    expect(html).toContain('href="https://line.me/R/ti/p/@173djjvp"')
  })

  it('botBasicId が空白のみなら友だち追加リンクを出さない', () => {
    const html = buildFriendAddHtml(PROFILE, '   ')

    expect(html).not.toContain('add-friend-btn')
    expect(html).toContain('友だち追加リンクを取得できませんでした')
  })

  it('属性値をエスケープする（escapeHtml は " を変換しないため別扱い）', () => {
    const html = buildFriendAddHtml(
      { displayName: 'x', pictureUrl: 'https://example.com/p.jpg" onerror="alert(1)' },
      '@abc" onclick="alert(1)',
    )

    expect(html).not.toContain('onerror="alert(1)"')
    expect(html).not.toContain('onclick="alert(1)"')
    expect(html).toContain('&quot;')
  })
})
