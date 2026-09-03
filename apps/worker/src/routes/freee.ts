/**
 * freee 連携（OAuth2 認可フロー）
 *
 * 現金決済領収書自動化（Epic #41 / #43）の認証基盤。
 * ルート構成は既存の Google Calendar 連携（routes/calendar.ts）に合わせている。
 *
 * ⚠️ このファイルはトークンを扱う。画面にもログにも
 *    access_token / refresh_token / client_secret を出さないこと。
 */

import { Hono } from 'hono';
import { getFreeeAuthUrl, exchangeCodeForTokens } from '../services/freee-oauth.js';
import type { Env } from '../index.js';

const freee = new Hono<Env>();

/** HTML に値を埋めるときのエスケープ（認可エラー文言をそのまま出さない） */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ========== OAuth ==========

freee.get('/api/integrations/freee/auth', async (c) => {
  try {
    const state = crypto.randomUUID();
    const url = getFreeeAuthUrl(c.env, state);
    // redirect=1 ならブラウザで直接開ける（管理画面の「接続する」ボタン用）
    if (c.req.query('redirect') === '1') {
      return c.redirect(url);
    }
    return c.json({ success: true, data: { url } });
  } catch (err) {
    console.error('GET /api/integrations/freee/auth error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

freee.get('/api/integrations/freee/callback', async (c) => {
  const code = c.req.query('code');
  const error = c.req.query('error');

  if (error || !code) {
    // freee 側のエラー種別（access_denied 等）はユーザーに見せてよい
    return c.html(
      `<html><body style="font-family:sans-serif;padding:32px">
        <h1>認証失敗</h1>
        <p>${escapeHtml(error ?? 'codeが取得できませんでした')}</p>
      </body></html>`,
      400,
    );
  }

  try {
    const tokens = await exchangeCodeForTokens(c.env, code);
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
    const id = crypto.randomUUID();

    await c.env.DB.prepare(`
      INSERT INTO freee_accounts
        (id, company_id, access_token, refresh_token, token_expires_at, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
    `).bind(
      id,
      tokens.company_id ?? null,
      tokens.access_token,
      tokens.refresh_token,
      expiresAt,
    ).run();

    // トークンはログに出さない。追跡は接続IDで行う。
    console.log('[freee callback] 連携を作成:', id);

    return c.html(`
      <html><body style="font-family:sans-serif;padding:32px">
        <h1>✅ freee 連携完了</h1>
        <p>接続ID: <code style="background:#f0f0f0;padding:4px 8px;border-radius:4px">${escapeHtml(id)}</code></p>
        <p>この画面は閉じて構いません。管理画面から接続状態を確認できます。</p>
      </body></html>
    `);
  } catch (err: unknown) {
    // 例外本文には freee のレスポンスが入る。client_secret は含めない実装だが、
    // 念のため画面には固定文言だけを出し、詳細はサーバーログに残す。
    console.error('[freee callback] トークン交換に失敗:', err);
    return c.html(
      `<html><body style="font-family:sans-serif;padding:32px">
        <h1>エラー</h1>
        <p>freee との連携に失敗しました。時間をおいて再度お試しください。</p>
      </body></html>`,
      500,
    );
  }
});

export { freee };
