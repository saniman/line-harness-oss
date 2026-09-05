import { describe, it, expect } from 'vitest';
import {
  parseShareUrl,
  extractReceiptNumber,
  buildShareUrl,
} from './receipt-share-url.js';

const UUID = 'd03d03bd-204b-4a5f-bb48-03d5f13bef50';
const VALID = `https://invoice.secure.freee.co.jp/ivex/dl/${UUID}`;

describe('parseShareUrl（貼り付けられた共有リンクの検証）', () => {
  it('freee の共有リンクを受け付け、UUID を取り出す', () => {
    expect(parseShareUrl(VALID)).toEqual({ ok: true, uuid: UUID, url: VALID });
  });

  it('【重要】report_url を拒否する', () => {
    // 管理画面には report_url（運営者用・ログイン必須）と共有リンクが並ぶ。
    // 間違えて貼ると、参加者は freee のログイン画面を見ることになる
    const res = parseShareUrl(
      'https://invoice.secure.freee.co.jp/reports/receipts/67021206?from_public=true',
    );
    expect(res.ok).toBe(false);
  });

  it('【重要】ホストの後方一致で通さない', () => {
    // invoice.secure.freee.co.jp.evil.com のようなドメインを弾く
    const res = parseShareUrl(`https://invoice.secure.freee.co.jp.evil.com/ivex/dl/${UUID}`);
    expect(res.ok).toBe(false);
  });

  it('【重要】ホストの前方に文字を足したドメインを拒否する', () => {
    // endsWith で判定すると evilinvoice.secure.freee.co.jp が通ってしまう。
    // 実際にミューテーションテストで、後方一致に変えても検出できていなかった穴
    const res = parseShareUrl(`https://evilinvoice.secure.freee.co.jp/ivex/dl/${UUID}`);
    expect(res.ok).toBe(false);
  });

  it('【重要】パスが /ivex/dl/ で始まらないものを拒否する', () => {
    // UUID 判定だけに頼ると、前9文字が何であっても残りが UUID なら通ってしまう
    // （/ivex/dl/ は9文字。同じ長さの別パスで置き換えられる）
    const res = parseShareUrl(`https://invoice.secure.freee.co.jp/abcdefgh${UUID}`);
    expect(res.ok).toBe(false);
  });

  it('別ホストを拒否する', () => {
    expect(parseShareUrl(`https://evil.com/ivex/dl/${UUID}`).ok).toBe(false);
  });

  it('http を拒否する', () => {
    expect(parseShareUrl(`http://invoice.secure.freee.co.jp/ivex/dl/${UUID}`).ok).toBe(false);
  });

  it('UUID でないパスを拒否する', () => {
    expect(parseShareUrl('https://invoice.secure.freee.co.jp/ivex/dl/not-a-uuid').ok).toBe(false);
  });

  it('UUID v4 でないものを拒否する', () => {
    // freee は v4 を使う。バージョン桁が 4 でないものは形式違い
    const v1 = 'd03d03bd-204b-1a5f-bb48-03d5f13bef50';
    expect(parseShareUrl(`https://invoice.secure.freee.co.jp/ivex/dl/${v1}`).ok).toBe(false);
  });

  it('前後の空白・改行を取り除いて受け付ける', () => {
    // コピペで混入する。ここで弾くと運営者が原因に気づけない
    const res = parseShareUrl(`  ${VALID}\n`);
    expect(res).toEqual({ ok: true, uuid: UUID, url: VALID });
  });

  it('末尾のスラッシュを許容する', () => {
    expect(parseShareUrl(`${VALID}/`).ok).toBe(true);
  });

  it('クエリが付いていても受け付け、保存する URL からは落とす', () => {
    const res = parseShareUrl(`${VALID}?utm_source=mail`);
    // 一意制約（第1層）が効くよう、保存する形を正規化する。
    // クエリ違いの同じリンクを別物として登録できてはいけない
    expect(res).toEqual({ ok: true, uuid: UUID, url: VALID });
  });

  it('空文字・null・非文字列を拒否する（例外を投げない）', () => {
    expect(parseShareUrl('').ok).toBe(false);
    expect(parseShareUrl(null as unknown as string).ok).toBe(false);
    expect(parseShareUrl(undefined as unknown as string).ok).toBe(false);
    expect(parseShareUrl(123 as unknown as string).ok).toBe(false);
  });

  it('極端に長い入力でも止まらない', () => {
    // bodyLimit ミドルウェアが無いのでメガバイト級を投げられる
    const long = `${VALID}${'a'.repeat(1_000_000)}`;
    expect(parseShareUrl(long).ok).toBe(false);
  });

  it('大文字の UUID も受け付け、小文字に正規化する', () => {
    // 一意制約が大文字小文字で二重登録を許してしまわないようにする
    const res = parseShareUrl(`https://invoice.secure.freee.co.jp/ivex/dl/${UUID.toUpperCase()}`);
    expect(res).toEqual({ ok: true, uuid: UUID, url: VALID });
  });
});

describe('extractReceiptNumber（Content-Disposition から領収書番号を取り出す）', () => {
  it('RFC 5987 の filename* から取り出す', () => {
    const header =
      "inline; filename=\"%3F%3F.pdf\"; filename*=UTF-8''%E3%83%86%E3%82%B9%E3%83%88%E6%A0%AA%E5%BC%8F%E4%BC%9A%E7%A4%BE%E5%BE%A1%E4%B8%AD_%E3%83%86%E3%82%B9%E3%83%88_%E9%A0%98%E5%8F%8E%E6%9B%B8_REC-0000000008.pdf";
    expect(extractReceiptNumber(header)).toBe('REC-0000000008');
  });

  it('filename* が無く filename だけでも取り出す', () => {
    expect(extractReceiptNumber('inline; filename="receipt_REC-0000000012.pdf"')).toBe(
      'REC-0000000012',
    );
  });

  it('ヘッダが無ければ null', () => {
    expect(extractReceiptNumber(null)).toBe(null);
    expect(extractReceiptNumber('')).toBe(null);
  });

  it('REC- を含まなければ null', () => {
    expect(extractReceiptNumber('inline; filename="invoice.pdf"')).toBe(null);
  });

  it('パーセントエンコードが壊れていても例外にしない', () => {
    // decodeURIComponent は不正な並びで URIError を投げる
    expect(() => extractReceiptNumber("inline; filename*=UTF-8''%E3%81")).not.toThrow();
  });

  it('壊れたエンコードでも、生の文字列に番号があれば拾う', () => {
    expect(extractReceiptNumber("inline; filename*=UTF-8''%E3%81_REC-0000000008.pdf")).toBe(
      'REC-0000000008',
    );
  });
});

describe('buildShareUrl（参加者に送る URL）', () => {
  it('自前ドメインの /receipt/<token> を組み立てる', () => {
    // freee の URL を直接送らない。無効化できるようにするため
    expect(buildShareUrl('https://api.walover-co.work', 'abc123')).toBe(
      'https://api.walover-co.work/receipt/abc123',
    );
  });

  it('末尾のスラッシュがあっても二重にしない', () => {
    expect(buildShareUrl('https://api.walover-co.work/', 'abc123')).toBe(
      'https://api.walover-co.work/receipt/abc123',
    );
  });
});
