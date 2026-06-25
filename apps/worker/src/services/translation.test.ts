import { describe, it, expect } from 'vitest'
import {
  collectMenuStrings,
  applyMenuTranslations,
  parseTranslationArray,
} from './translation.js'
import type { OrderableMenu } from './orders.js'

const MENU: OrderableMenu = {
  id: 'm1',
  name: '生ビール',
  base_price: 600,
  menu_group: 'drink',
  category_label: 'ドリンク',
  description: 'よく冷えた一杯',
  options: [
    { id: 'o1', group_label: 'サイズ', choice_name: '中', extra_price: 0 },
    { id: 'o2', group_label: 'サイズ', choice_name: '大', extra_price: 200 },
  ],
}

describe('collectMenuStrings（翻訳対象の収集）', () => {
  it('name/description/category_label/オプションを重複なく集める', () => {
    const s = collectMenuStrings([MENU])
    expect(s).toContain('生ビール')
    expect(s).toContain('よく冷えた一杯')
    expect(s).toContain('ドリンク')
    expect(s).toContain('サイズ')
    expect(s).toContain('中')
    expect(s).toContain('大')
    // 'サイズ' は2オプションで共通だが1回だけ
    expect(s.filter((x) => x === 'サイズ')).toHaveLength(1)
  })
})

describe('applyMenuTranslations（差し替え）', () => {
  it('訳があるものは差し替え、無いものは原文のまま。価格やidは不変', () => {
    const map = new Map<string, string>([
      ['生ビール', 'Draft Beer'],
      ['ドリンク', 'Drinks'],
      ['サイズ', 'Size'],
      ['大', 'Large'],
      // '中' と '説明' は未訳
    ])
    const [r] = applyMenuTranslations([MENU], map)
    expect(r.name).toBe('Draft Beer')
    expect(r.category_label).toBe('Drinks')
    expect(r.description).toBe('よく冷えた一杯') // 未訳は原文
    expect(r.base_price).toBe(600)
    expect(r.id).toBe('m1')
    expect(r.options[0].group_label).toBe('Size')
    expect(r.options[0].choice_name).toBe('中') // 未訳は原文
    expect(r.options[1].choice_name).toBe('Large')
  })
})

describe('parseTranslationArray（Claude応答のJSON抽出）', () => {
  it('素のJSON配列を読む', () => {
    expect(parseTranslationArray('["A","B"]', 2)).toEqual(['A', 'B'])
  })
  it('コードフェンスや前後文を許容する', () => {
    expect(parseTranslationArray('```json\n["A","B"]\n```', 2)).toEqual(['A', 'B'])
    expect(parseTranslationArray('Here: ["A","B"] done', 2)).toEqual(['A', 'B'])
  })
  it('件数不一致や不正は null', () => {
    expect(parseTranslationArray('["A"]', 2)).toBeNull()
    expect(parseTranslationArray('not json', 2)).toBeNull()
  })
})
