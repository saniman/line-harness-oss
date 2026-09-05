/**
 * 参加者が領収書を開くための公開ルート（Issue #47 の取り違え対策・第2層）。
 *
 * ## なぜ freee の URL を直接送らないのか
 *
 * freee の共有リンクを LINE でそのまま送ると、**誤配に気づいても止める手段が無い**
 * （LINE の送信は取り消せない）。間に自前のリダイレクタを挟めば、
 * 気づいた時点で無効化でき、いつ開かれたかも記録できる。
 *
 * ⚠️ 一度開かれると転送先 URL はブラウザ履歴に残るため、開封後は止められない。
 *    それでも「まだ開かれていない誤配」は確実に止められる。
 *
 * ## ⚠️ これは capability URL（URL を知っていれば誰でも開ける）
 *
 * - 認証を通さない（参加者は管理画面のトークンを持たない）→ auth のスキップリストに追加済み
 * - トークンは推測不能にする（`crypto.randomUUID()`）
 * - **トークンと転送先をログに出さない**（Workers Logs の閲覧権限だけで領収書が開ける）
 * - 検索に載らないよう noindex、遷移先に漏れないよう no-referrer を付ける
 */

import { Hono } from 'hono';
import type { Env } from '../index.js';

const receipt = new Hono<Env>();

/** トークンの長さの上限。これを超える入力で DB を引かない（UUID は 36 文字） */
const MAX_TOKEN_LENGTH = 64;

interface ShareRow {
  id: number;
  receipt_share_url: string | null;
  receipt_share_expires_at: string | null;
  receipt_share_revoked_at: string | null;
  receipt_share_opened_at: string | null;
}

/** 期限切れか。解釈できない値は「切れている」側に倒す（黙って開かせない） */
function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  const at = new Date(`${expiresAt.replace(' ', 'T')}Z`).getTime();
  if (Number.isNaN(at)) return true;
  return at <= Date.now();
}

/** 参加者に見せる簡素なページ。事情を説明して、問い合わせ先へ誘導する */
function notice(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${title}</title></head>
<body style="font-family:sans-serif;padding:32px;line-height:1.8;color:#333333">
<h1 style="font-size:18px">${title}</h1><p>${body}</p></body></html>`;
}

/** capability URL 共通のヘッダ。検索・リファラ・キャッシュから URL を守る */
function protect(headers: Record<string, string> = {}): Record<string, string> {
  return {
    'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'private, no-store',
    ...headers,
  };
}

receipt.get('/receipt/:token', async (c) => {
  try {
    const token = c.req.param('token');
    // 長すぎる入力で DB を引かない
    if (!token || token.length > MAX_TOKEN_LENGTH) {
      return c.html(notice('見つかりません', 'このリンクは無効です。'), 404, protect());
    }

    const row = await c.env.DB.prepare(
      `SELECT id, receipt_share_url, receipt_share_expires_at,
              receipt_share_revoked_at, receipt_share_opened_at
         FROM event_bookings WHERE receipt_share_token = ?`,
    )
      .bind(token)
      .first<ShareRow>();

    // ⚠️ 存在しないトークンは一律 404。存在の有無を漏らさない
    if (!row?.receipt_share_url) {
      return c.html(notice('見つかりません', 'このリンクは無効です。'), 404, protect());
    }

    if (row.receipt_share_revoked_at) {
      return c.html(
        notice(
          'このリンクは無効になりました',
          'お手数ですが、主催者までお問い合わせください。',
        ),
        410,
        protect(),
      );
    }

    if (isExpired(row.receipt_share_expires_at)) {
      return c.html(
        notice(
          'ダウンロード期限が過ぎています',
          '領収書のダウンロード期限が過ぎました。'
          + 'お手数ですが、主催者までお問い合わせください。',
        ),
        410,
        protect(),
      );
    }

    // 開封を記録する（誤配が起きたときに被害範囲を把握するため）。
    // ⚠️ 初回だけ入れる。上書きすると「いつ最初に開かれたか」が分からなくなる
    if (!row.receipt_share_opened_at) {
      await c.env.DB.prepare(
        `UPDATE event_bookings
            SET receipt_share_opened_at = datetime('now')
          WHERE id = ? AND receipt_share_opened_at IS NULL`,
      )
        .bind(row.id)
        .run();
    }

    // ⚠️ トークンも転送先もログに出さない。出すのは booking_id だけ
    console.log('[receipt] 領収書が開かれました:', row.id);

    // ⚠️ リダイレクトにも保護ヘッダを付ける。ここが参加者が通る本線なので、
    //    ここに付け忘れると noindex も no-referrer も効かない
    return new Response(null, {
      status: 302,
      headers: protect({ Location: row.receipt_share_url }),
    });
  } catch (err) {
    console.error('GET /receipt/:token error:', err);
    return c.html(notice('エラー', '時間をおいて再度お試しください。'), 500, protect());
  }
});

export default receipt;
