import { describe, it, expect } from 'vitest';
import { computeAnchoredDeliveryAt } from '@line-crm/db';

// イベント開催日(start_at)アンカーの配信時刻計算。
// anchorAt は UTC ISO（例: 2026-06-13T05:00:00.000Z = JST 6/13 14:00）。
// 戻り値は JST 壁時計の '...+09:00' 形式。
describe('computeAnchoredDeliveryAt', () => {
  it('開催当日(0日後)の指定時刻になる', () => {
    // JST 6/13 14:00 開催 → 当日 10:00
    expect(computeAnchoredDeliveryAt('2026-06-13T05:00:00.000Z', 0, '10:00')).toBe(
      '2026-06-13T10:00:00+09:00',
    );
  });

  it('翌日(1日後)10:00になる（開催時刻に依存しない）', () => {
    // JST 6/13 14:00 開催 → 翌日 6/14 10:00
    expect(computeAnchoredDeliveryAt('2026-06-13T05:00:00.000Z', 1, '10:00')).toBe(
      '2026-06-14T10:00:00+09:00',
    );
  });

  it('開催時刻が朝でも翌日の指定時刻は固定される', () => {
    // JST 6/13 09:00 開催（00:00Z）→ 翌日 6/14 10:00
    expect(computeAnchoredDeliveryAt('2026-06-13T00:00:00.000Z', 1, '10:00')).toBe(
      '2026-06-14T10:00:00+09:00',
    );
  });

  it('3日後の指定時刻になる', () => {
    expect(computeAnchoredDeliveryAt('2026-06-13T05:00:00.000Z', 3, '13:30')).toBe(
      '2026-06-16T13:30:00+09:00',
    );
  });

  it('月跨ぎを正しく処理する', () => {
    // JST 6/30 開催 → 3日後 = 7/3
    expect(computeAnchoredDeliveryAt('2026-06-30T05:00:00.000Z', 3, '09:00')).toBe(
      '2026-07-03T09:00:00+09:00',
    );
  });

  it('JST日付境界: UTC夜の開催はJSTの翌日が暦日になる', () => {
    // 2026-06-13T15:30:00Z = JST 6/14 00:30 → JST暦日は6/14。翌日(1)=6/15 10:00
    expect(computeAnchoredDeliveryAt('2026-06-13T15:30:00.000Z', 1, '10:00')).toBe(
      '2026-06-15T10:00:00+09:00',
    );
  });

  it('時刻はゼロ埋めされる', () => {
    expect(computeAnchoredDeliveryAt('2026-06-13T05:00:00.000Z', 0, '9:05')).toBe(
      '2026-06-13T09:05:00+09:00',
    );
  });

  it('+09:00表記のanchorAtも受け付ける', () => {
    // JST 6/13 14:00 を +09:00 で表現 → 翌日 10:00
    expect(computeAnchoredDeliveryAt('2026-06-13T14:00:00+09:00', 1, '10:00')).toBe(
      '2026-06-14T10:00:00+09:00',
    );
  });
});
