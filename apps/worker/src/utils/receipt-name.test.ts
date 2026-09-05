import { describe, it, expect } from 'vitest';
import { sanitizeReceiptName, RECEIPT_NAME_MAX_LENGTH } from './receipt-name.js';

describe('sanitizeReceiptName', () => {
  it('通常の宛名はそのまま返す', () => {
    expect(sanitizeReceiptName('株式会社サンプル')).toBe('株式会社サンプル');
  });

  it('前後の空白を落とす', () => {
    expect(sanitizeReceiptName('  株式会社サンプル  ')).toBe('株式会社サンプル');
  });

  it('未入力（null / undefined / 空文字）は null にする', () => {
    // 空文字を保存すると「指定あり」と区別できず、フォールバックが効かなくなる
    expect(sanitizeReceiptName(null)).toBeNull();
    expect(sanitizeReceiptName(undefined)).toBeNull();
    expect(sanitizeReceiptName('')).toBeNull();
    expect(sanitizeReceiptName('    ')).toBeNull();
  });

  it('文字列以外が来たら null にする（APIを直接叩かれた場合）', () => {
    expect(sanitizeReceiptName(123 as unknown as string)).toBeNull();
    expect(sanitizeReceiptName({} as unknown as string)).toBeNull();
  });
});

describe('sanitizeReceiptName（視覚偽装への耐性）', () => {
  const RLO = String.fromCharCode(0x202e);
  const ZWJ = String.fromCharCode(0x200d);
  const BOM = String.fromCharCode(0xfeff);
  const LRI = String.fromCharCode(0x2066);

  it('改行を空白に畳む（1行に収める）', () => {
    expect(sanitizeReceiptName('株式会社\n\nサンプル')).toBe('株式会社 サンプル');
  });

  it('RLO（右横書きオーバーライド）を潰す', () => {
    // 残すと管理画面や領収書で「別の名前」に見せかけられる
    expect(sanitizeReceiptName(`株式会社${RLO}サンプル`)).toBe('株式会社 サンプル');
  });

  it('ゼロ幅接合子・BOM・BIDI アイソレートを潰す', () => {
    expect(sanitizeReceiptName(`A${ZWJ}B${BOM}C${LRI}D`)).toBe('A B C D');
  });

  it('非表示の制御文字（NUL / DEL）も潰す', () => {
    const NUL = String.fromCharCode(0);
    const DEL = String.fromCharCode(127);
    expect(sanitizeReceiptName(`A${NUL}B${DEL}C`)).toBe('A B C');
  });
});

describe('sanitizeReceiptName（長さ制限）', () => {
  it('上限を超えたら切り詰める', () => {
    const long = 'あ'.repeat(RECEIPT_NAME_MAX_LENGTH + 50);
    const result = sanitizeReceiptName(long)!;
    expect(Array.from(result).length).toBeLessThanOrEqual(RECEIPT_NAME_MAX_LENGTH);
  });

  it('上限ちょうどは切り詰めない', () => {
    const exact = 'あ'.repeat(RECEIPT_NAME_MAX_LENGTH);
    expect(sanitizeReceiptName(exact)).toBe(exact);
  });

  it('サロゲートペアの途中で切らない（壊れ字を出さない）', () => {
    // コードユニット単位で切ると絵文字が割れて U+FFFD になる
    const name = 'あ'.repeat(RECEIPT_NAME_MAX_LENGTH - 1) + '😀' + 'い'.repeat(10);
    const result = sanitizeReceiptName(name)!;
    expect(result).not.toContain(String.fromCharCode(0xfffd));
    expect(result.endsWith('😀')).toBe(true);
  });
});
