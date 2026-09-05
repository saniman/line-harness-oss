/**
 * 現金を受け取った予約に対して、freee で領収書を発行する。
 *
 * 呼び出し元は「現金受領」ボタン（POST /api/events/:id/bookings/:bookingId/cash-received）。
 *
 * ## 設計方針: 現金の受領記録と、領収書の発行を切り離す
 *
 * 現金は**物理的に受け取っている**。freee が落ちていても、宛名が空でも、その事実は変わらない。
 * ここで例外を投げて受領記録ごと巻き戻すと、「お金は受け取ったのに記録が無い」状態になり、
 * 経理が合わなくなる。だから **この関数は例外を投げない**。発行できなければ理由を返すだけにして、
 * 受領の記録は残す。未発行分の再送は #48 で扱う。
 */

import type { Env } from '../index.js';
import { getValidAccessTokenFreee } from './freee-oauth.js';
import {
  getEventBookingById,
  getEventBookingForReceipt,
  resolveReceiptName,
} from './events.js';
import { formatJstDate } from '../utils/format-jst.js';
import {
  freeeReceiptIssuer,
  FreeeReceiptApiError,
  type FreeeReceiptIssuer,
} from './freee-receipt-client.js';

export type { FreeeReceiptIssuer } from './freee-receipt-client.js';

/** 発行できなかった理由。文言ではなくこのコードで分岐する */
export type ReceiptIssueCode =
  | 'not_found'
  | 'event_mismatch'
  | 'cancelled'
  | 'not_received'
  | 'no_payee'
  | 'no_amount'
  | 'bad_date'
  | 'freee_unavailable'
  | 'freee_reauth_required'
  | 'issue_in_progress'
  | 'issue_failed';

export interface IssueReceiptResult {
  /** 領収書の URL が確定しているか（既発行を含む） */
  issued: boolean;
  /** 既に発行済みで、今回は何もしなかった */
  alreadyIssued?: boolean;
  receiptUrl?: string | null;
  code?: ReceiptIssueCode;
  /** 発行できなかった理由。管理画面に出す（参加者には見せない） */
  error?: string;
  /**
   * 発行はできたが人の確認が要ること。
   *
   * ⚠️ `error` と分けてある。`issued: true` のときに `error` へ入れると、
   *    「発行できたなら理由は不要」という素直な実装（`issued ? null : error`）で
   *    黙って捨てられる。実際に1周目の修正でそうなり、二重発行の警告が
   *    画面に出ていなかった。
   */
  warning?: string;
}

export interface IssueReceiptOptions {
  /** 但し書き・件名に使うイベント名 */
  eventTitle?: string;
}

/**
 * 発行権を持ち続けられる上限。これを過ぎた claim は放棄されたとみなして奪い返す。
 *
 * freee 呼び出しには 10 秒のタイムアウトがあるので、正常系がここに達することはない。
 * Worker が発行の途中で落ちたときに、その予約が永久に発行不能になるのを防ぐための保険。
 */
const CLAIM_TIMEOUT = '-5 minutes';

/**
 * この失敗で「freee に領収書が作られていない」と断言できるか。
 *
 * ここが本質。発行権（receipt_issued_at）は**作られたか不明なときこそ持ち続ける**もので、
 * 一律に返すと押し直しで2枚目が出る。
 *
 *   断言できる … トークンを取れず freee を呼んでいない / freee が 4xx で拒否した
 *   断言できない … タイムアウト・通信断・5xx（freee 側で完了している可能性がある）
 *
 * 断言できないときは発行権を持ったままにする。CLAIM_TIMEOUT を過ぎれば自動で解放され、
 * それまでは押し直しても freee を呼ばない。
 */
function isDefinitelyNotCreated(err: unknown): boolean {
  // freee を呼ぶ前に落ちた
  if (err instanceof TokenUnavailableError) return true;
  // freee が受け付けなかった（4xx）。5xx は処理途中で落ちた可能性があるので含めない
  if (err instanceof FreeeReceiptApiError) return err.status >= 400 && err.status < 500;
  return false;
}

/** 但し書き。「〜として」まで入れて領収書らしくする */
function buildDescription(eventTitle: string | undefined): string {
  const title = eventTitle?.trim();
  return title ? `${title} 参加費として` : 'イベント参加費として';
}

export async function issueReceiptForBooking(
  env: Env['Bindings'],
  db: D1Database,
  eventId: number,
  bookingId: number,
  issuer: FreeeReceiptIssuer = freeeReceiptIssuer,
  options: IssueReceiptOptions = {},
): Promise<IssueReceiptResult> {
  // 友だちの表示名まで取る。宛名は「指定 → 申込時の氏名 → LINE の表示名」の3段で決まるが、
  // SELECT * だと3段目が常に undefined になる（getEventBookingForReceipt のコメント参照）
  const booking = await getEventBookingForReceipt(db, bookingId);
  if (!booking) {
    return { issued: false, code: 'not_found', error: '予約が見つかりませんでした。' };
  }
  if (booking.event_id !== eventId) {
    return { issued: false, code: 'event_mismatch', error: 'イベントが一致しません。' };
  }

  // ⚠️ 冪等ガード。ここを外すと、ボタン連打・#48 のリトライ・管理画面の二重タブで
  //    同じ参加者に領収書が2枚発行される（freee 上は取消が必要な経理事故になる）。
  if (booking.receipt_url) {
    return { issued: true, alreadyIssued: true, receiptUrl: booking.receipt_url };
  }

  if (booking.status === 'cancelled') {
    return { issued: false, code: 'cancelled', error: 'キャンセル済みの予約です。' };
  }
  // 受け取っていない金額の領収書を出してはいけない
  if (!booking.cash_received_at) {
    return { issued: false, code: 'not_received', error: 'まだ現金を受領していません。' };
  }

  // 宛名は「指定 → 申込時の氏名」の順に解決する。全部空なら発行しない。
  // 空欄の宛名で発行すると freee 側で作り直しになるため、未発行のまま #48 に回す。
  const payeeName = resolveReceiptName(booking);
  if (!payeeName) {
    return { issued: false, code: 'no_payee', error: '領収書の宛名を決められませんでした。' };
  }

  // amount は現金受領時に events.price から焼き込まれる（markCashReceived 参照）。
  // それでも null なら、イベントの価格が未設定だった等なので発行しない。
  if (booking.amount == null || booking.amount <= 0) {
    return { issued: false, code: 'no_amount', error: '領収書に載せる金額がありません。' };
  }

  const issueDate = formatJstDate(booking.cash_received_at);
  if (!issueDate) {
    return { issued: false, code: 'bad_date', error: '受領日時を解釈できませんでした。' };
  }

  // ────────────────────────────────────────────────────────────────
  // ここから先は freee を呼ぶ。**先に発行権を取ってから呼ぶ**。
  //
  // ⚠️ 上の `if (booking.receipt_url)` は SELECT を見た「読んでから書く」判定なので、
  //    同時実行を防げない。受付に端末が2台あると両方が「未発行」と読み、
  //    両方が freee を呼んで領収書が2枚できる（実際に再現した）。
  //    receipt_issued_at を「発行中」の印として先に立て、取れた1本だけが freee を呼ぶ。
  // ────────────────────────────────────────────────────────────────
  const claimed = await db
    .prepare(
      `UPDATE event_bookings
          SET receipt_issued_at = datetime('now'),
              updated_at = datetime('now')
        WHERE id = ?
          AND receipt_url IS NULL
          AND (receipt_issued_at IS NULL OR receipt_issued_at < datetime('now', ?))
      RETURNING id, receipt_issued_at`,
    )
    .bind(bookingId, CLAIM_TIMEOUT)
    .first<{ id: number; receipt_issued_at: string }>();

  if (!claimed) {
    // 取れなかった理由は2つ。読み直して見分ける。
    //   ① 別のリクエストが一瞬先に発行を終えた → その URL を返す（成功）
    //   ② 別のリクエストが今まさに発行中 → 二重に呼ばず、発行中として返す
    const fresh = await getEventBookingById(db, bookingId);
    if (fresh?.receipt_url) {
      return { issued: true, alreadyIssued: true, receiptUrl: fresh.receipt_url };
    }
    console.warn('[freee] 別のリクエストが発行中のため見送りました:', bookingId);
    return {
      issued: false,
      code: 'issue_in_progress',
      error: 'ほかの操作で領収書を発行中です。少し待ってから状態を確認してください。',
    };
  }

  /**
   * 発行権を返す。freee を呼べなかった／失敗したときに、次の試行を塞がないため。
   *
   * ⚠️ **自分が立てた印のときだけ消す**（`receipt_issued_at = ?`）。
   *    条件を `receipt_url IS NULL` だけにすると、期限切れで別のリクエストが
   *    引き継いだ後に自分が release したとき、その相手の発行権まで消してしまい、
   *    3本目が同時に走れるようになる（＝二重発行の窓が開く）。
   */
  const releaseClaim = async () => {
    await db
      .prepare(
        `UPDATE event_bookings
            SET receipt_issued_at = NULL,
                updated_at = datetime('now')
          WHERE id = ?
            AND receipt_url IS NULL
            AND receipt_issued_at = ?`,
      )
      .bind(bookingId, claimed.receipt_issued_at)
      .run();
  };

  const partnerId = Number(env.FREEE_PARTNER_ID);
  const params = {
    payeeName,
    amount: booking.amount,
    issueDate,
    description: buildDescription(options.eventTitle),
    subject: options.eventTitle?.trim() || 'イベント参加費',
    partnerId: Number.isInteger(partnerId) && partnerId > 0 ? partnerId : undefined,
    partnerCode: env.FREEE_PARTNER_CODE || undefined,
  };

  let result: { receiptId: number | null; receiptUrl: string };
  try {
    result = await issueWithReauthRetry(env, db, issuer, params, bookingId);
  } catch (err) {
    // ⚠️ **作られていないと断言できるときだけ**発行権を返す。
    //    タイムアウトや 5xx は freee 側で完了している可能性があるので持ち続ける。
    if (isDefinitelyNotCreated(err)) {
      await releaseClaim();
    } else {
      console.error(
        '[freee] 発行の結果が不明です。領収書が作られた可能性があるため、発行権を保持します:',
        bookingId,
      );
    }
    // ⚠️ ここで throw しない（受領記録を巻き戻さないため。冒頭のコメント参照）
    console.error('[freee] 領収書の発行に失敗しました:', bookingId, err);

    if (err instanceof TokenUnavailableError) {
      return {
        issued: false,
        code: err.reauthRequired ? 'freee_reauth_required' : 'freee_unavailable',
        error: err.adminMessage,
      };
    }
    // 401 は「期限内に見えるトークンが無効化された」＝再認可しないと直らない。
    // 一時障害と混ぜると、運営者が原因（#44 の連携し直し）に辿り着けない。
    if (err instanceof FreeeReceiptApiError && err.status === 401) {
      return {
        issued: false,
        code: 'freee_reauth_required',
        error: 'freee との連携が切れています。管理画面から連携し直してください。',
      };
    }
    // ⚠️ freee のメッセージを固定文で潰さない。
    //    取引先が未設定だと freee は「取引先を指定してください」と教えてくれるが、
    //    これを捨てると運営者は原因に辿り着けない（デプロイ直後がまさにこの状態）。
    //    宛名は describeError で伏せ済みなので、そのまま出してよい。
    if (err instanceof FreeeReceiptApiError) {
      return {
        issued: false,
        code: 'issue_failed',
        error: `領収書を発行できませんでした。（${err.message}）`,
      };
    }
    // freee 以外の失敗（通信断・タイムアウト）はメッセージに何が入るか読めないので出さない。
    // 作られた可能性があることは伝える（押し直して2枚目を作らせないため）
    return {
      issued: false,
      code: 'issue_failed',
      error:
        '領収書を発行できませんでした。freee 側で発行済みの可能性があるため、'
        + '確認してから再度お試しください。',
    };
  }

  // URL が取れなければ保存しない。空文字を入れると上の冪等ガードが効かないまま
  // 「発行済み扱いの空 URL」になり、再発行も参加者への送付もできなくなる。
  //
  // ⚠️ ここは freee が 2xx を返している＝**領収書は作られている**。
  //    発行権を返すと押し直しで2枚目が出るので、保持したままにする。
  //    領収書ID は個人情報ではないのでログに残す（迷子の1枚を特定する唯一の手がかり）。
  if (!result.receiptUrl) {
    console.error(
      '[freee] 領収書は作成されたが URL が取れませんでした。freee 側を確認してください:',
      bookingId,
      'receipt_id=',
      result.receiptId,
    );
    return {
      issued: false,
      code: 'issue_failed',
      error:
        'freee 側に領収書は作成されましたが、URL を取得できませんでした。'
        + 'freee で確認して手動で共有してください。',
    };
  }

  // ⚠️ receipt_url をログに出さない。URL を知っていれば誰でも開ける可能性があるため、
  //    ログに残すのは booking_id だけにする。
  const saved = await db
    .prepare(
      `UPDATE event_bookings
          SET receipt_url = ?,
              receipt_issued_at = datetime('now'),
              updated_at = datetime('now')
        WHERE id = ?
          AND receipt_url IS NULL
      RETURNING receipt_url`,
    )
    .bind(result.receiptUrl, bookingId)
    .first<{ receipt_url: string }>();

  // 発行権を持っていたので通常ここは通らない。通ったなら claim の期限切れ等で
  // 2本が同時に走った可能性があり、**freee 上に迷子の領収書が1枚ある**。
  // 黙って成功を返すと突合できなくなるので、必ず気づける形で残す。
  if (!saved) {
    const fresh = await getEventBookingById(db, bookingId);
    console.error(
      '[freee] 領収書を保存できませんでした。freee 側に重複した領収書がある可能性があります:',
      bookingId,
    );
    return {
      issued: true,
      alreadyIssued: true,
      receiptUrl: fresh?.receipt_url ?? null,
      warning:
        'ほかの操作と重なり、領収書が2枚発行された可能性があります。freee 側を確認してください。',
    };
  }

  console.log('[freee] 領収書を発行しました:', bookingId);
  return { issued: true, receiptUrl: result.receiptUrl };
}

/**
 * トークンを取れなかった。
 *
 * ⚠️ 理由を潰さないこと。freee 側で連携を解除されると **refresh の段階で
 *    REAUTH_REQUIRED になる**（/receipts まで到達しないので 401 は返ってこない）。
 *    一律で「一時的に接続できません」にすると、再認可の案内が永久に出ない。
 */
class TokenUnavailableError extends Error {
  constructor(
    /** 再認可しないと直らないか */
    readonly reauthRequired: boolean,
    /** 管理画面に出す案内 */
    readonly adminMessage: string,
  ) {
    super('TOKEN_UNAVAILABLE');
  }
}

/** getValidAccessTokenFreee が投げるエラーを、運営者向けの案内に翻訳する */
function describeTokenFailure(err: unknown): TokenUnavailableError {
  const reason = err instanceof Error ? err.message : '';
  if (reason === 'REAUTH_REQUIRED') {
    return new TokenUnavailableError(
      true,
      'freee との連携が切れています。管理画面から連携し直してください。',
    );
  }
  if (reason === 'FREEE_NOT_CONNECTED') {
    return new TokenUnavailableError(
      false,
      'freee と連携していません。管理画面から連携してください。',
    );
  }
  return new TokenUnavailableError(
    false,
    'freee に一時的に接続できませんでした。少し待ってから再度お試しください。',
  );
}

/**
 * トークンを取って発行する。401 なら一度だけ取り直して再試行する。
 *
 * freee 側でアプリ連携を解除されると、`token_expires_at` がまだ先でも 401 になる。
 * キャッシュされたトークンを使い続けると、期限が来るまで（最大で数時間）
 * 現金受領のたびに黙って失敗し続けるため、401 を見たら必ず取り直す。
 */
async function issueWithReauthRetry(
  env: Env['Bindings'],
  db: D1Database,
  issuer: FreeeReceiptIssuer,
  params: Omit<Parameters<FreeeReceiptIssuer['createReceipt']>[0], 'accessToken' | 'companyId'>,
  bookingId: number,
): Promise<{ receiptId: number | null; receiptUrl: string }> {
  const getToken = async (forceRefresh: boolean) => {
    try {
      return await getValidAccessTokenFreee(env, db, forceRefresh);
    } catch (err) {
      console.error('[freee] トークンを取得できませんでした:', bookingId, err);
      throw describeTokenFailure(err);
    }
  };

  const first = await getToken(false);
  try {
    return await issuer.createReceipt({
      ...params,
      accessToken: first.accessToken,
      companyId: first.companyId,
    });
  } catch (err) {
    if (!(err instanceof FreeeReceiptApiError) || err.status !== 401) throw err;

    console.warn('[freee] 401 を受けたのでトークンを取り直して再試行します:', bookingId);
    const retried = await getToken(true);
    return issuer.createReceipt({
      ...params,
      accessToken: retried.accessToken,
      companyId: retried.companyId,
    });
  }
}
