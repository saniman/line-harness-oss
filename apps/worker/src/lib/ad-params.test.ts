import { describe, it, expect } from 'vitest';
import { AD_TRACKING_PARAMS, forwardAdParams } from './ad-params.js';

/** クエリ文字列から `c.req.query` 相当の読み取り関数を作る */
function reader(qs: string) {
  const params = new URLSearchParams(qs);
  return (key: string) => params.get(key) ?? undefined;
}

describe('forwardAdParams', () => {
  it('広告クリックIDとUTMが揃っている場合は全て転送される', () => {
    const target = new URLSearchParams();
    forwardAdParams(
      reader('gclid=CjwKCA&fbclid=IwAR1&twclid=tw1&ttclid=tt1&utm_source=google&utm_medium=cpc&utm_campaign=summer'),
      target,
    );
    expect(target.get('gclid')).toBe('CjwKCA');
    expect(target.get('fbclid')).toBe('IwAR1');
    expect(target.get('twclid')).toBe('tw1');
    expect(target.get('ttclid')).toBe('tt1');
    expect(target.get('utm_source')).toBe('google');
    expect(target.get('utm_medium')).toBe('cpc');
    expect(target.get('utm_campaign')).toBe('summer');
  });

  it('/auth/oauth が読むキーと同じ集合になっている', () => {
    // このリストが /auth/oauth（routes/liff.ts）の読み取りとズレると、
    // 転送しても state に入らず計測が落ちる。ドリフト検知のための固定。
    expect([...AD_TRACKING_PARAMS]).toEqual([
      'gclid', 'fbclid', 'twclid', 'ttclid', 'utm_source', 'utm_medium', 'utm_campaign',
    ]);
  });

  it('一部だけ付いている場合は付いているものだけ転送される', () => {
    const target = new URLSearchParams();
    forwardAdParams(reader('gclid=abc&utm_campaign=fair'), target);
    expect(target.get('gclid')).toBe('abc');
    expect(target.get('utm_campaign')).toBe('fair');
    expect(target.has('fbclid')).toBe(false);
    expect(target.has('utm_source')).toBe(false);
  });

  it('広告パラメータが無い場合は何も足さない', () => {
    const target = new URLSearchParams();
    target.set('ref', 'abc');
    forwardAdParams(reader('ref=abc&form=f1'), target);
    expect(target.toString()).toBe('ref=abc');
  });

  it('空文字の場合は転送しない（空の値で state を埋めない）', () => {
    const target = new URLSearchParams();
    forwardAdParams(reader('gclid=&utm_source=google'), target);
    expect(target.has('gclid')).toBe(false);
    expect(target.get('utm_source')).toBe('google');
  });

  it('日本語のキャンペーン名の場合もそのまま転送される（URLエンコードは呼び出し側）', () => {
    const target = new URLSearchParams();
    forwardAdParams(reader('utm_campaign=' + encodeURIComponent('夏キャンペーン')), target);
    expect(target.get('utm_campaign')).toBe('夏キャンペーン');
    expect(target.toString()).toContain('utm_campaign=');
  });

  it('既存のパラメータを壊さずに追記される', () => {
    const target = new URLSearchParams();
    target.set('ref', 'r1');
    target.set('gate', 'g1');
    forwardAdParams(reader('gclid=abc'), target);
    expect(target.get('ref')).toBe('r1');
    expect(target.get('gate')).toBe('g1');
    expect(target.get('gclid')).toBe('abc');
  });
});
