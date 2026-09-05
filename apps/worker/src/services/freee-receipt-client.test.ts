import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { freeeReceiptIssuer, resolvePartnerTitle } from './freee-receipt-client.js';

const BASE_PARAMS = {
  accessToken: 'at-secret-1',
  companyId: 1234567,
  payeeName: 'あきひさ',
  amount: 3000,
  issueDate: '2026-09-06',
  description: '無料セミナー 参加費として',
  subject: '無料セミナー',
};

function okResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
}

const SUCCESS = {
  receipt: { id: 987, report_url: 'https://invoice.secure.freee.co.jp/ivex/dl/abc' },
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(okResponse(SUCCESS));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 投げられた例外を取り出す。投げられなければテストを失敗させる */
async function captureError(p: Promise<unknown>): Promise<Error> {
  return p.then(
    () => {
      throw new Error('例外が投げられませんでした');
    },
    (e: unknown) => e as Error,
  );
}

/** 直近の fetch に渡された JSON ボディ */
function sentBody(): Record<string, any> {
  return JSON.parse(fetchMock.mock.calls[0][1].body);
}

describe('resolvePartnerTitle', () => {
  it.each([
    '株式会社サンプル',
    'サンプル株式会社',
    '合同会社WALOVER',
    '有限会社テスト',
    '（株）サンプル',
    '(株)サンプル',
    '一般社団法人テスト',
    'NPO法人テスト',
    '医療法人テスト',
    'Sample Inc.',
    'Sample Ltd',
    'Sample LLC',
  ])('法人・団体に見える「%s」は御中になる', (name) => {
    expect(resolvePartnerTitle(name)).toBe('御中');
  });

  it.each(['あきひさ', '山田 太郎', 'Taro Yamada', '田中'])(
    '個人に見える「%s」は様になる',
    (name) => {
      expect(resolvePartnerTitle(name)).toBe('様');
    },
  );
});

describe('freeeReceiptIssuer.createReceipt（送信内容）', () => {
  it('freee請求書 API の /receipts に POST する', async () => {
    await freeeReceiptIssuer.createReceipt(BASE_PARAMS);

    const [url, init] = fetchMock.mock.calls[0];
    // ⚠️ 会計 API（api.freee.co.jp/api/1/receipts）は「受け取った領収書の画像アップロード」で別物
    expect(url).toBe('https://api.freee.co.jp/iv/receipts');
    expect(init.method).toBe('POST');
  });

  it('アクセストークンを Bearer で送る', async () => {
    await freeeReceiptIssuer.createReceipt(BASE_PARAMS);

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer at-secret-1');
  });

  it('事業所ID・領収日・宛名・件名を送る', async () => {
    await freeeReceiptIssuer.createReceipt(BASE_PARAMS);

    expect(sentBody()).toMatchObject({
      company_id: 1234567,
      receipt_date: '2026-09-06',
      partner_display_name: 'あきひさ',
      partner_title: '様',
      subject: '無料セミナー',
    });
  });

  it('【重要】金額は税込として送る（tax_entry_method=in）', async () => {
    // 'out'（外税）にすると freee が 3000 円に消費税を上乗せし、
    // 受け取った額と領収書の額が食い違う
    await freeeReceiptIssuer.createReceipt(BASE_PARAMS);

    expect(sentBody().tax_entry_method).toBe('in');
  });

  it('明細に但し書き・数量1・単価・税率10%を載せる', async () => {
    await freeeReceiptIssuer.createReceipt(BASE_PARAMS);

    expect(sentBody().lines).toEqual([
      {
        type: 'item',
        description: '無料セミナー 参加費として',
        quantity: 1,
        unit_price: '3000', // OAS3 の pattern は文字列前提
        tax_rate: 10,
      },
    ]);
  });

  it('freee の必須項目をすべて含む', async () => {
    // OAS3 の required: company_id, receipt_date, tax_entry_method,
    //                   tax_fraction, withholding_tax_entry_method, partner_title, lines
    const body = await freeeReceiptIssuer
      .createReceipt(BASE_PARAMS)
      .then(() => sentBody());

    for (const key of [
      'company_id',
      'receipt_date',
      'tax_entry_method',
      'tax_fraction',
      'withholding_tax_entry_method',
      'partner_title',
      'lines',
    ]) {
      expect(body).toHaveProperty(key);
    }
  });

  it('取引先IDを指定すると partner_id を送る', async () => {
    await freeeReceiptIssuer.createReceipt({ ...BASE_PARAMS, partnerId: 42 });

    expect(sentBody().partner_id).toBe(42);
    expect(sentBody()).not.toHaveProperty('partner_code');
  });

  it('取引先コードを指定すると partner_code を送る', async () => {
    await freeeReceiptIssuer.createReceipt({ ...BASE_PARAMS, partnerCode: 'EVENT' });

    expect(sentBody().partner_code).toBe('EVENT');
    expect(sentBody()).not.toHaveProperty('partner_id');
  });

  it('取引先IDとコードの両方があればIDを優先する', async () => {
    await freeeReceiptIssuer.createReceipt({ ...BASE_PARAMS, partnerId: 42, partnerCode: 'EVENT' });

    expect(sentBody().partner_id).toBe(42);
    expect(sentBody()).not.toHaveProperty('partner_code');
  });

  it('取引先の指定が無ければどちらも送らない', async () => {
    await freeeReceiptIssuer.createReceipt(BASE_PARAMS);

    expect(sentBody()).not.toHaveProperty('partner_id');
    expect(sentBody()).not.toHaveProperty('partner_code');
  });
});

describe('freeeReceiptIssuer.createReceipt（レスポンス）', () => {
  it('report_url と領収書IDを返す', async () => {
    const res = await freeeReceiptIssuer.createReceipt(BASE_PARAMS);

    expect(res).toEqual({
      receiptId: 987,
      receiptUrl: 'https://invoice.secure.freee.co.jp/ivex/dl/abc',
    });
  });

  it('report_url が無ければ空文字を返す（呼び出し側が未発行として扱う）', async () => {
    fetchMock.mockResolvedValue(okResponse({ receipt: { id: 987 } }));

    const res = await freeeReceiptIssuer.createReceipt(BASE_PARAMS);

    expect(res.receiptUrl).toBe('');
  });

  it('レスポンスが JSON でなくても落ちずに例外にする', async () => {
    fetchMock.mockResolvedValue(new Response('<html>502</html>', { status: 502 }));

    await expect(freeeReceiptIssuer.createReceipt(BASE_PARAMS)).rejects.toThrow(/502/);
  });
});

describe('freeeReceiptIssuer.createReceipt（エラー）', () => {
  function errorResponse(status: number, messages: string[]) {
    return new Response(
      JSON.stringify({ status_code: status, errors: [{ type: 'bad_request', messages }] }),
      { status, headers: { 'Content-Type': 'application/json' } },
    );
  }

  it('freee のエラーメッセージを例外に含める', async () => {
    fetchMock.mockResolvedValue(errorResponse(400, ['取引先を指定してください。']));

    await expect(freeeReceiptIssuer.createReceipt(BASE_PARAMS)).rejects.toThrow(
      /取引先を指定してください/,
    );
  });

  it('レート制限（429）も例外になる', async () => {
    fetchMock.mockResolvedValue(errorResponse(429, ['リクエスト回数制限を超えました。']));

    await expect(freeeReceiptIssuer.createReceipt(BASE_PARAMS)).rejects.toThrow(/429/);
  });

  it('【重要】例外メッセージにアクセストークンを含めない', async () => {
    fetchMock.mockResolvedValue(errorResponse(401, ['アクセストークンが無効です。']));

    const err = await captureError(freeeReceiptIssuer.createReceipt(BASE_PARAMS));

    expect(err.message).not.toContain('at-secret-1');
  });

  it('【重要】例外メッセージに宛名（個人情報）を含めない', async () => {
    // 例外は console.error に流れる。宛名は参加者の氏名なのでログに残さない
    fetchMock.mockResolvedValue(errorResponse(400, ['形式が不正です。']));

    const err = await captureError(
      freeeReceiptIssuer.createReceipt({ ...BASE_PARAMS, payeeName: '山田太郎' }),
    );

    expect(err.message).not.toContain('山田太郎');
  });
});
