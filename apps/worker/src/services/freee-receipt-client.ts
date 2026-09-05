/**
 * freee請求書 API で領収書を発行する HTTP クライアント。
 *
 * 仕様の出典（OAS3・公開されている）:
 *   https://raw.githubusercontent.com/freee/freee-api-schema/master/iv/open-api-3/api-schema.yml
 *
 * ⚠️ **freee会計の `POST /api/1/receipts` とは別物**。会計側は「受け取った領収書の画像を
 *    アップロードする」API で、発行はできない。ベース URL が違う（会計は api.freee.co.jp/api/1）。
 *
 * ⚠️ ここが発行するのは**実際の証憑**。二重発行・金額違いは経理の事故になるので、
 *    冪等性の判定は呼び出し側（services/freee-receipt.ts）で必ず行う。
 */

/** freee請求書 API のベース URL（OAS3 の servers[0].url） */
const FREEE_INVOICE_API_BASE = 'https://api.freee.co.jp/iv';

/**
 * 消費税率（%）。イベント参加費は軽減税率の対象外なので 10% 固定。
 * 飲食物の提供が主目的の催しを扱うようになったら、イベント側に税率を持たせる必要がある。
 */
const TAX_RATE = 10;

/** freee 呼び出しのタイムアウト。現金受領ボタンの応答を待たせすぎない。 */
const TIMEOUT_MS = 10_000;

export interface FreeeReceiptParams {
  accessToken: string;
  companyId: number;
  /** 領収書に印字する宛名（freee の partner_display_name） */
  payeeName: string;
  /** 税込金額（円） */
  amount: number;
  /** 領収日。JST の暦日 `YYYY-MM-DD` */
  issueDate: string;
  /** 但し書き（明細行の摘要） */
  description: string;
  /** 件名 */
  subject: string;
  /** 取引先コード（freee 側に登録済みの取引先） */
  partnerCode?: string;
  /** 取引先ID（partnerCode の代わりに使える） */
  partnerId?: number;
}

export interface FreeeReceiptResult {
  /** freee 上の領収書ID */
  receiptId: number | null;
  /** 帳票詳細ページの URL（freee の report_url） */
  receiptUrl: string;
}

/**
 * 領収書を1件発行する最小のインターフェース。
 *
 * `.claude/rules/api-coding.md` の「外部SDKクライアントをサービス関数に渡す場合の型設計」に従い、
 * サービス側はこの構造的インターフェースだけに依存する（テストでモックを差せるようにするため）。
 */
export interface FreeeReceiptIssuer {
  createReceipt(params: FreeeReceiptParams): Promise<FreeeReceiptResult>;
}

/** 宛名が法人・団体に見えるか（見えれば「御中」、そうでなければ「様」） */
const ORGANIZATION_PATTERNS = [
  '株式会社', '有限会社', '合同会社', '合資会社', '合名会社',
  '（株）', '(株)', '（有）', '(有)', '（同）', '(同)',
  '一般社団法人', '一般財団法人', '公益社団法人', '公益財団法人',
  '特定非営利活動法人', 'NPO法人', '医療法人', '学校法人',
  '宗教法人', '社会福祉法人', '独立行政法人', '事業協同組合',
];

/** 英文の法人格。大文字小文字を無視して判定する */
const ORGANIZATION_PATTERNS_EN = /\b(inc|ltd|llc|llp|corp|corporation|company|co)\b\.?/i;

/**
 * 敬称を決める。
 *
 * 「株式会社◯◯ 様」は日本のビジネス文書として誤り（法人は「御中」）。
 * 逆に個人に「御中」を付けるのも誤りなので、宛名の見た目で振り分ける。
 * 判定を外しても領収書としては有効なので、ここは best effort でよい。
 */
export function resolvePartnerTitle(payeeName: string): '御中' | '様' {
  const isOrg =
    ORGANIZATION_PATTERNS.some((p) => payeeName.includes(p)) ||
    ORGANIZATION_PATTERNS_EN.test(payeeName);
  return isOrg ? '御中' : '様';
}

/** freee のエラーレスポンス（OAS3 の badRequest 等） */
interface FreeeErrorBody {
  status_code?: number;
  errors?: { type?: string; messages?: string[] }[];
}

/** エラー本文から人が読めるメッセージを組み立てる（トークンは含めない） */
function describeError(status: number, body: unknown): string {
  const errors = (body as FreeeErrorBody | null)?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const messages = errors.flatMap((e) => e.messages ?? []).filter(Boolean);
    if (messages.length > 0) return `freee ${status}: ${messages.join(' / ')}`;
  }
  return `freee ${status}`;
}

/**
 * 本番の freee請求書 API を叩く発行器。
 *
 * 例外は投げっぱなしにする（呼び出し側が「領収書は未発行」として握る）。
 */
export const freeeReceiptIssuer: FreeeReceiptIssuer = {
  async createReceipt(params: FreeeReceiptParams): Promise<FreeeReceiptResult> {
    // ⚠️ 取引先の指定について。
    //    OAS3 の required に partner_id / partner_code は入っていないが、
    //    partner_id の説明に「取引先IDと取引先コードはどちらか一方を必ず指定してください」とあり、
    //    レスポンスの required にも partner_id が入っている（＝必ず取引先に紐づく）。
    //    参加者ごとに取引先を作ると freee のマスタが人数分汚れるので、
    //    「イベント参加者」など固定の取引先を1つ用意し、宛名だけ partner_display_name で上書きする。
    const body: Record<string, unknown> = {
      company_id: params.companyId,
      receipt_date: params.issueDate,
      // 税込表示。price は税込で持っているため 'in'。'out' にすると税額が上乗せされる
      tax_entry_method: 'in',
      tax_fraction: 'omit',
      // 源泉徴収はイベント参加費では発生しないが、必須項目なので指定する
      withholding_tax_entry_method: 'out',
      partner_title: resolvePartnerTitle(params.payeeName),
      partner_display_name: params.payeeName,
      subject: params.subject,
      lines: [
        {
          type: 'item',
          description: params.description,
          quantity: 1,
          // unit_price は数値ではなく文字列（OAS3 の pattern が文字列前提）
          unit_price: String(params.amount),
          tax_rate: TAX_RATE,
        },
      ],
    };
    if (params.partnerId != null) body.partner_id = params.partnerId;
    else if (params.partnerCode) body.partner_code = params.partnerCode;

    const res = await fetch(`${FREEE_INVOICE_API_BASE}/receipts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    // レスポンスは1回しか読めないので、成否に関わらずここで読み切る
    const parsed = await res.json().catch(() => null);

    if (!res.ok) {
      // ⚠️ ここで body（宛名を含む）やトークンをログに出さない。
      //    宛名は参加者の氏名＝個人情報なので、エラー種別と HTTP ステータスだけ残す。
      throw new Error(describeError(res.status, parsed));
    }

    const receipt = (parsed as { receipt?: { id?: number; report_url?: string } } | null)?.receipt;
    const receiptUrl = typeof receipt?.report_url === 'string' ? receipt.report_url : '';

    return {
      receiptId: typeof receipt?.id === 'number' ? receipt.id : null,
      receiptUrl,
    };
  },
};
