/**
 * 貼り付けられた共有リンクが「その予約の領収書か」を freee に問い合わせて照合する。
 * Issue #47 の取り違え対策・第4層。
 *
 * ## なぜこれで照合できるのか
 *
 * 共有ページ（`/ivex/dl/<uuid>`）は Vite の SPA で、HTML には領収書の中身が入っていない。
 * だが**PDF の実体**（`/api/ivex/dl/<uuid>/0`）は素のサーバーリクエストで取得でき、
 * `Content-Disposition` に**宛名と領収書番号**が入っている。
 *
 *   filename*=UTF-8''テスト株式会社御中_領収書_REC-0000000008.pdf
 *
 * `HEAD` で呼べば本体を1バイトも転送せずにこのヘッダだけ取れる（実測で確認済み）。
 *
 * ## ⚠️ これは freee の非公開エンドポイント
 *
 * 公式スペックに載っていないため、freee 側の変更で**予告なく壊れうる**。
 * だから「壊れたら拒否」ではなく「**壊れたら検証できないと明示する**」設計にする。
 * 黙って通すのが最悪（運営者に「検証済み」と誤解させる）。
 * 検証が無くても第1〜3.5層で守れるようにしてある。
 */

import { extractReceiptNumber } from '../utils/receipt-share-url.js';

const SHARE_FILE_BASE = 'https://invoice.secure.freee.co.jp/api/ivex/dl';

/** 貼付操作の応答を待たせすぎない。照合は「あれば嬉しい」ものなので短くてよい */
const TIMEOUT_MS = 8_000;

/**
 * 照合に必要な最小のインターフェース。
 * `.claude/rules/api-coding.md` の「ミニマルな構造的インターフェース」に従い、
 * サービス側はこれだけに依存する（テストで fetch を差し替えられるようにするため）。
 */
export interface ShareFileFetcher {
  headReceiptFile(uuid: string): Promise<{
    status: number;
    contentDisposition: string | null;
  }>;
}

export type VerifyResult = {
  /**
   * match       … 一致した。保存してよい
   * mismatch    … **別の人の領収書**。保存を拒否する
   * not_found   … 無効・削除済み・期限切れのリンク。保存を拒否する
   * unavailable … 検証できなかった。拒否はせず、人の確認に委ねる
   */
  result: 'match' | 'mismatch' | 'not_found' | 'unavailable';
  /** freee 側から読み取れた領収書番号（分かったときだけ） */
  receiptNumber?: string | null;
};

/**
 * 貼られたリンクの領収書番号と、予約の領収書番号を突き合わせる。
 *
 * @param expectedNumber その予約の領収書番号。null なら照合できない（#46 より前のデータ）
 */
export async function verifyShareUrl(
  uuid: string,
  expectedNumber: string | null,
  fetcher: ShareFileFetcher = freeeShareVerifier,
): Promise<VerifyResult> {
  // 比較対象が無ければ問い合わせる意味がない。freee に無駄な負荷もかけない
  if (!expectedNumber) return { result: 'unavailable' };

  let res: Awaited<ReturnType<ShareFileFetcher['headReceiptFile']>>;
  try {
    res = await fetcher.headReceiptFile(uuid);
  } catch (err) {
    // ⚠️ 例外を投げない。freee の一時障害で貼付操作そのものを止めない
    console.warn('[receipt] 共有リンクの照合に失敗しました（検証なしで続行）:', err);
    return { result: 'unavailable' };
  }

  // 404 は「そのリンクが存在しない」＝ 貼り間違い・削除済み・期限切れ。確実に拒否できる
  if (res.status === 404) return { result: 'not_found' };
  // それ以外の失敗は freee 側の問題かもしれないので、拒否せず未検証にする
  if (res.status < 200 || res.status >= 300) return { result: 'unavailable' };

  const actual = extractReceiptNumber(res.contentDisposition);
  // ⚠️ 番号を読めなかったときに mismatch にしない。
  //    freee がファイル名の規則を変えただけで、正しい操作が全部止まってしまう
  if (!actual) return { result: 'unavailable' };

  return actual === expectedNumber
    ? { result: 'match', receiptNumber: actual }
    : { result: 'mismatch', receiptNumber: actual };
}

/** 本番の freee 呼び出し */
export const freeeShareVerifier: ShareFileFetcher = {
  async headReceiptFile(uuid: string) {
    // ⚠️ `?is_download=1` を付けない。付けると freee 側で「ダウンロード済み」扱いになり、
    //    運営者が画面で見る状態が汚れる。HEAD なら本体も転送されない。
    const res = await fetch(`${SHARE_FILE_BASE}/${uuid}/0`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return {
      status: res.status,
      contentDisposition: res.headers.get('Content-Disposition'),
    };
  },
};
