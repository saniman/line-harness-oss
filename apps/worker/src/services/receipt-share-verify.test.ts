import { describe, it, expect, vi, beforeEach } from 'vitest';
import { verifyShareUrl, freeeShareVerifier } from './receipt-share-verify.js';

const UUID = 'd03d03bd-204b-4a5f-bb48-03d5f13bef50';
const DISPOSITION =
  "inline; filename*=UTF-8''%E3%83%86%E3%82%B9%E3%83%88%E6%A0%AA%E5%BC%8F%E4%BC%9A%E7%A4%BE%E5%BE%A1%E4%B8%AD_%E9%A0%98%E5%8F%8E%E6%9B%B8_REC-0000000008.pdf";

/** ヘッダだけ返す最小の照合器 */
function makeFetcher(result: { status: number; disposition?: string | null }) {
  return {
    headReceiptFile: vi.fn().mockResolvedValue({
      status: result.status,
      contentDisposition: result.disposition ?? null,
    }),
  };
}

describe('verifyShareUrl（貼られたリンクが本人の領収書か照合する）', () => {
  it('領収書番号が一致すれば通る', async () => {
    const fetcher = makeFetcher({ status: 200, disposition: DISPOSITION });

    const res = await verifyShareUrl(UUID, 'REC-0000000008', fetcher);

    expect(res).toEqual({ result: 'match', receiptNumber: 'REC-0000000008' });
  });

  it('【重要】別の領収書番号なら拒否する（取り違えの検出）', async () => {
    // これが第4層の本体。A さんのリンクを B さんに貼っても、ここで止まる
    const fetcher = makeFetcher({ status: 200, disposition: DISPOSITION });

    const res = await verifyShareUrl(UUID, 'REC-0000000012', fetcher);

    expect(res.result).toBe('mismatch');
    expect(res.receiptNumber).toBe('REC-0000000008');
  });

  it('freee が 404 なら無効なリンクとして拒否する', async () => {
    // 削除済み・期限切れ。送る前に気づける
    const fetcher = makeFetcher({ status: 404 });

    const res = await verifyShareUrl(UUID, 'REC-0000000008', fetcher);

    expect(res.result).toBe('not_found');
  });

  it('【重要】freee が 5xx なら「検証できない」を返す（黙って通さない）', async () => {
    // 通すと「検証済み」と誤解される。拒否もしない（freee の一時障害で運用が止まる）
    const fetcher = makeFetcher({ status: 503 });

    const res = await verifyShareUrl(UUID, 'REC-0000000008', fetcher);

    expect(res.result).toBe('unavailable');
  });

  it('【重要】通信に失敗しても例外を投げず「検証できない」を返す', async () => {
    const fetcher = {
      headReceiptFile: vi.fn().mockRejectedValue(new Error('timeout')),
    };

    const res = await verifyShareUrl(UUID, 'REC-0000000008', fetcher);

    expect(res.result).toBe('unavailable');
  });

  it('ファイル名から番号を取れなければ「検証できない」を返す', async () => {
    // freee がファイル名の規則を変えた場合。誤って mismatch にすると正しい操作を止めてしまう
    const fetcher = makeFetcher({ status: 200, disposition: 'inline; filename="receipt.pdf"' });

    const res = await verifyShareUrl(UUID, 'REC-0000000008', fetcher);

    expect(res.result).toBe('unavailable');
  });

  it('【重要】こちらが領収書番号を持っていなければ「検証できない」を返す', async () => {
    // #46 より前に発行された予約。拒否すると送れなくなるので、人の確認に委ねる
    const fetcher = makeFetcher({ status: 200, disposition: DISPOSITION });

    const res = await verifyShareUrl(UUID, null, fetcher);

    expect(res.result).toBe('unavailable');
    expect(fetcher.headReceiptFile).not.toHaveBeenCalled();
  });
});

describe('freeeShareVerifier（本番の HTTP 呼び出し）', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 200, headers: { 'Content-Disposition': DISPOSITION } }),
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  it('freee の PDF エンドポイントを叩く', async () => {
    await freeeShareVerifier.headReceiptFile(UUID);

    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://invoice.secure.freee.co.jp/api/ivex/dl/${UUID}/0`,
    );
  });

  it('【重要】HEAD で呼ぶ（本体を転送しない）', async () => {
    await freeeShareVerifier.headReceiptFile(UUID);

    expect(fetchMock.mock.calls[0][1].method).toBe('HEAD');
  });

  it('【重要】is_download を付けない（ダウンロード済み扱いにしない）', async () => {
    // 付けると freee 側の「ダウンロード状態」が変わり、運営者の見る情報が汚れる
    await freeeShareVerifier.headReceiptFile(UUID);

    expect(String(fetchMock.mock.calls[0][0])).not.toContain('is_download');
  });

  it('タイムアウトを付ける（貼付操作を待たせない）', async () => {
    await freeeShareVerifier.headReceiptFile(UUID);

    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('ステータスと Content-Disposition を返す', async () => {
    const res = await freeeShareVerifier.headReceiptFile(UUID);

    expect(res.status).toBe(200);
    expect(res.contentDisposition).toBe(DISPOSITION);
  });
});

describe('verifyShareUrl（比較の対称性）', () => {
  it('保存側に余分な空白があっても照合できる', async () => {
    const fetcher = makeFetcher({ status: 200, disposition: DISPOSITION });

    const res = await verifyShareUrl(UUID, '  REC-0000000008  ', fetcher);

    expect(res.result).toBe('match');
  });

  it('【重要】保存側から番号を抽出できなければ「検証できない」にする', async () => {
    // ここを mismatch にすると、freee が採番規則を変えただけで**全件が 400 で拒否**になり、
    // しかも「別の方の領収書です」と出て運営者は自分のミスだと思い込む。
    // 他の経路はすべて fail-open なので、ここだけ fail-closed にしない
    const fetcher = makeFetcher({ status: 200, disposition: DISPOSITION });

    const res = await verifyShareUrl(UUID, 'INVOICE-12345', fetcher);

    expect(res.result).toBe('unavailable');
  });

  it('番号が本当に違えば mismatch のまま', async () => {
    const fetcher = makeFetcher({ status: 200, disposition: DISPOSITION });

    const res = await verifyShareUrl(UUID, 'REC-0000000099', fetcher);

    expect(res.result).toBe('mismatch');
  });
});
