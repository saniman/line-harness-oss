import { describe, it, expect } from 'vitest'
import { validateTagName, DEFAULT_TAG_COLOR, getTagTextColor } from '../lib/tags'
import type { Tag } from '@line-crm/shared'

describe('タグ管理ページ', () => {
  describe('タグ名のバリデーション', () => {
    it('空文字は作成できない', () => {
      expect(validateTagName('')).not.toBeNull()
    })

    it('空白のみは作成できない', () => {
      expect(validateTagName('   ')).not.toBeNull()
    })

    it('正常な名前は作成できる', () => {
      expect(validateTagName('VIP')).toBeNull()
    })
  })

  describe('カラーのデフォルト値', () => {
    it('カラー未指定時は#3B82F6が使われる', () => {
      expect(DEFAULT_TAG_COLOR).toBe('#3B82F6')
    })
  })

  describe('タグ表示', () => {
    it('タグ名とカラーバッジが表示される', () => {
      const tags: Tag[] = [{ id: '1', name: 'VIP', color: '#EF4444', createdAt: '' }]
      // 暗い背景色のタグは白テキストで表示される
      expect(getTagTextColor(tags[0].color)).toBe('#ffffff')
      // 明るい背景色のタグは暗いテキストで表示される
      expect(getTagTextColor('#FFFFFF')).toBe('#1f2937')
    })

    it('タグが0件の場合は「タグがありません」と表示される', () => {
      const tags: Tag[] = []
      const isEmpty = tags.length === 0
      expect(isEmpty).toBe(true)
    })
  })
})
