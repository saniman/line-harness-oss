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

describe('sanitizeReceiptName（\\s に該当しない不可視文字）', () => {
  // \\s で拾えないため、畳まないと「見た目は空なのに非 null」で保存され、
  // resolveReceiptName のフォールバックが効かず、宛名が空欄の領収書になる。
  const INVISIBLE: Array<[string, number]> = [
    ['U+2060 WORD JOINER', 0x2060],
    ['U+00AD SOFT HYPHEN', 0x00ad],
    ['U+3164 HANGUL FILLER', 0x3164],
    ['U+061C ARABIC LETTER MARK', 0x061c], // BIDI 制御。対策の穴だった
  ];

  it.each(INVISIBLE)('%s だけなら null にする', (_name, code) => {
    expect(sanitizeReceiptName(String.fromCharCode(code))).toBeNull();
  });

  it.each(INVISIBLE)('%s を含む宛名からは取り除く', (_name, code) => {
    const ch = String.fromCharCode(code);
    expect(sanitizeReceiptName(`株式会社${ch}サンプル`)).toBe('株式会社 サンプル');
  });

  it('不可視文字を並べただけの入力も null にする', () => {
    const junk = [0x2060, 0x00ad, 0x3164, 0x061c, 0x200b]
      .map((c) => String.fromCharCode(c)).join('');
    expect(sanitizeReceiptName(junk)).toBeNull();
  });
});

describe('sanitizeReceiptName（列挙では追いきれない不可視文字）', () => {
  // 1文字ずつ列挙していると必ず漏れる。実際 U+2060 を足したのに
  // 隣の U+2061 が素通りしていた。Unicode カテゴリで弾く。
  const MISSED_BY_ENUMERATION: Array<[string, number]> = [
    ['U+2061 INVISIBLE TIMES', 0x2061],   // 追加した U+2060 の隣
    ['U+2062 INVISIBLE TIMES', 0x2062],
    ['U+2064 INVISIBLE PLUS', 0x2064],
    ['U+180E MONGOLIAN VOWEL SEPARATOR', 0x180e],
    ['U+FFF9 INTERLINEAR ANNOTATION ANCHOR', 0xfff9],
    ['U+0600 ARABIC NUMBER SIGN', 0x0600],
  ];

  it.each(MISSED_BY_ENUMERATION)('%s だけなら null にする', (_name, code) => {
    expect(sanitizeReceiptName(String.fromCodePoint(code))).toBeNull();
  });

  it('TAG 文字（U+E0020〜U+E007F）も畳む', () => {
    // 絵文字の異体字セレクタ等に使われる。見た目には出ない
    const tag = String.fromCodePoint(0xe0041);
    expect(sanitizeReceiptName(`株式会社${tag}サンプル`)).toBe('株式会社 サンプル');
  });

  it('通常の文字・絵文字・全角スペースは誤検出しない', () => {
    expect(sanitizeReceiptName('株式会社サンプル')).toBe('株式会社サンプル');
    expect(sanitizeReceiptName('😀ラボ')).toBe('😀ラボ');
    // 全角スペースは \s に該当するので1つの半角に畳まれる（消えはしない）
    expect(sanitizeReceiptName('株式会社　サンプル')).toBe('株式会社 サンプル');
  });

  it('ハングルフィラー（Lo カテゴリ）も引き続き畳む', () => {
    // Cf ではないのでカテゴリ判定だけでは拾えない。明示的に足す必要がある
    for (const code of [0x3164, 0x115f, 0x1160, 0xffa0]) {
      expect(sanitizeReceiptName(String.fromCodePoint(code))).toBeNull();
    }
  });
});
