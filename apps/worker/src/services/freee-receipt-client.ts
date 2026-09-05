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

/**
 * subject / 明細の摘要の上限（OAS3 の maxLength）。
 *
 * events.title は長さ無制限の TEXT で、API 側にも検証が無い。超えるとイベント単位で
 * 全員の発行が 400 になるので、送る直前にここで切る。
 */
const MAX_TEXT_LENGTH = 255;

/**
 * コードポイント単位で切り詰める。
 * slice は UTF-16 コードユニット単位なので、絵文字や補助漢字の途中で切ると
 * サロゲートが片割れだけ残って壊れ字になる。
 */
function truncate(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : chars.slice(0, max).join('');
}

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

/**
 * freee が返したエラー。HTTP ステータスを保持する。
 *
 * 401（トークン失効）と 5xx（一時障害）では運営者にすべき案内が違うため、
 * 呼び出し側がステータスで分岐できるようにする。
 */
export class FreeeReceiptApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'FreeeReceiptApiError';
  }
}

/** freee のエラーレスポンス（OAS3 の badRequest 等） */
interface FreeeErrorBody {
  status_code?: number;
  errors?: { type?: string; messages?: string[] }[];
}

/**
 * エラー本文から人が読めるメッセージを組み立てる。
 *
 * ⚠️ freee のバリデーションエラーは**送った値をそのまま echo することがある**
 *    （例:「partner_display_name「山田太郎」は不正です」）。この文字列は呼び出し側の
 *    console.error に流れるため、素通しすると参加者の氏名が Cloudflare のログに残る。
 *    宛名だけは必ず伏せてから返す。
 *
 * メッセージ自体は落とさない。「取引先を指定してください」のように、
 * 設定ミスの原因がそのまま書かれていることが多く、消すと運営者が原因に辿り着けない。
 */
function describeError(status: number, body: unknown, payeeName: string): string {
  const errors = (body as FreeeErrorBody | null)?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const messages = errors.flatMap((e) => e.messages ?? []).filter(Boolean);
    if (messages.length > 0) {
      const safe = redactPayee(messages.join(' / '), payeeName);
      // 伏せられなかったときはメッセージを捨て、種別だけにフォールバックする
      if (safe !== null) return `freee ${status}: ${safe}`;
    }
    const types = errors.map((e) => e.type).filter(Boolean);
    if (types.length > 0) return `freee ${status}: ${types.join(' / ')}`;
  }
  return `freee ${status}`;
}

/**
 * 単純な文字列置換で安全に伏せられる宛名の最小長（コードポイント）。
 *
 * 宛名は1文字でも保存できる（「林」「李」など実在する姓）。1文字を置換すると
 * freee のメッセージ中の**無関係な同じ文字まで**「（宛名）」になり、
 * 原因究明のために残したはずのメッセージが読めなくなる。
 */
const MIN_REDACTABLE_LENGTH = 2;

/**
 * メッセージ中の宛名を伏せる。
 *
 * @returns 伏せた文字列。安全に伏せられないときは null（呼び出し側でメッセージ自体を諦める）
 */
function redactPayee(message: string, payeeName: string): string | null {
  if (!payeeName) return message;
  // 短すぎる宛名は置換すると誤爆する。メッセージを出さない側に倒す
  // （個人情報を漏らすくらいなら、原因が分からない方がまし）
  if (Array.from(payeeName).length < MIN_REDACTABLE_LENGTH) {
    return message.includes(payeeName) ? null : message;
  }
  return message.split(payeeName).join('（宛名）');
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
      subject: truncate(params.subject, MAX_TEXT_LENGTH),
      lines: [
        {
          type: 'item',
          description: truncate(params.description, MAX_TEXT_LENGTH),
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
      throw new FreeeReceiptApiError(
        describeError(res.status, parsed, params.payeeName),
        res.status,
      );
    }

    const receipt = (parsed as { receipt?: { id?: number; report_url?: string } } | null)?.receipt;
    const receiptUrl = typeof receipt?.report_url === 'string' ? receipt.report_url : '';

    return {
      receiptId: typeof receipt?.id === 'number' ? receipt.id : null,
      receiptUrl,
    };
  },
};
