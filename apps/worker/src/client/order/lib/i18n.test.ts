import { describe, it, expect } from 'vitest';
import { translate, detectLang } from './i18n.js';

describe('translate（UI文言）', () => {
  it('日本語・英語をキーで引ける', () => {
    expect(translate('ja', 'history')).toBe('注文履歴');
    expect(translate('en', 'history')).toBe('My Orders');
  });
  it('未知キーはそのまま返す', () => {
    expect(translate('en', 'no_such_key')).toBe('no_such_key');
  });
  it('英語辞書に無いキーは日本語にフォールバック', () => {
    // どの言語にも total はあるので、存在しないキーで ja フォールバック確認
    expect(translate('en', 'totally_missing')).toBe('totally_missing');
  });
});

describe('detectLang（LINE言語の判定）', () => {
  it('en で始まれば en', () => {
    expect(detectLang('en')).toBe('en');
    expect(detectLang('en-US')).toBe('en');
    expect(detectLang('EN')).toBe('en');
  });
  it('それ以外は ja', () => {
    expect(detectLang('ja')).toBe('ja');
    expect(detectLang('zh-TW')).toBe('ja');
    expect(detectLang(null)).toBe('ja');
    expect(detectLang(undefined)).toBe('ja');
  });
});
