import { describe, it, expect } from 'vitest';
import { encodeState, decodeState } from './oauth-state.js';

describe('encodeState / decodeState', () => {
  describe('従来の btoa との互換性', () => {
    it('ASCII のみの場合は従来の btoa と同じ文字列になる', () => {
      const state = JSON.stringify({ ref: 'lp-summer', redirect: '/thanks', utmSource: 'google' });
      expect(encodeState(state)).toBe(btoa(state));
    });

    it('旧 btoa が発行した ASCII の state をデコードできる', () => {
      const state = JSON.stringify({ ref: 'abc', gclid: 'CjwKCAjw' });
      expect(decodeState(btoa(state))).toBe(state);
    });
  });

  describe('マルチバイト文字（広告運用で実際に来る値）', () => {
    it('日本語の utm_campaign を含む場合でも例外を投げずにエンコードできる', () => {
      const state = JSON.stringify({ ref: 'lp', utmCampaign: '夏キャンペーン' });
      expect(() => encodeState(state)).not.toThrow();
    });

    it('日本語を含む場合でもエンコードしてデコードすると元に戻る', () => {
      const state = JSON.stringify({ ref: 'lp', utmCampaign: '夏キャンペーン', utmSource: 'ヤフー広告' });
      expect(decodeState(encodeState(state))).toBe(state);
    });

    it('絵文字（サロゲートペア）を含む場合でも往復する', () => {
      const state = JSON.stringify({ ref: 'lp', utmCampaign: '沖縄フェア🏝️' });
      expect(decodeState(encodeState(state))).toBe(state);
    });
  });

  describe('境界値', () => {
    it('空文字の場合は空文字に戻る', () => {
      expect(decodeState(encodeState(''))).toBe('');
    });
  });
});
