/**
 * freee 連携（OAuth2 認可フロー）
 *
 * 現金決済領収書自動化（Epic #41 / #43）の認証基盤。
 *
 * ⚠️ セキュリティ上の前提（PR #54 のレビュー指摘を受けた設計）
 *
 * 1. `/callback` は認証をかけられない（freee からのブラウザリダイレクトなので
 *    API キーを送れない）。つまり **誰でも叩ける公開エンドポイント**である。
 *    第三者が公開の `/auth` を自分で踏み、自分の freee 事業所で認可を完走すると、
 *    その人のトークンがこの DB に入りうる。
 *    → **新規接続は必ず is_active = 0（保留）で保存し、自動で有効化しない。**
 *      有効化は認証済みの管理画面から行う（#44）。登録できても使われない状態にする。
 *
 * 2. `state` は署名付き（services/freee-oauth.ts）で、必ず検証してから
 *    トークン交換に進む。検証前に交換すると、無関係な認可コードを消費してしまう。
 *
 * 3. 画面にもログにも access_token / refresh_token / client_secret を出さない。
 *    ログ閲覧権限だけで連携を乗っ取られるため。追跡は接続IDで行う。
 */

import { Hono } from 'hono';
import { jstNow } from '@line-crm/db';
import {
  getFreeeAuthUrl,
  exchangeCodeForTokens,
  createOAuthState,
  verifyOAuthState,
} from '../services/freee-oauth.js';
import type { Env } from '../index.js';

const freee = new Hono<Env>();

/** HTML に値を埋めるときのエスケープ */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function page(title: string, bodyHtml: string): string {
  return `<html><body style="font-family:sans-serif;padding:32px">
    <h1>${title}</h1>
    ${bodyHtml}
  </body></html>`;
}

// ========== OAuth ==========

freee.get('/api/integrations/freee/auth', async (c) => {
  try {
    const state = await createOAuthState(c.env);
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
  const state = c.req.query('state');

  if (error || !code) {
    // freee 側のエラー種別（access_denied 等）はユーザーに見せてよい
    return c.html(
      page('認証失敗', `<p>${escapeHtml(error ?? 'codeが取得できませんでした')}</p>`),
      400,
    );
  }

  // ⚠️ トークン交換より前に state を検証する。
  //    先に交換すると、他人が持ち込んだ認可コードを消費してしまう。
  // state 自体が無いケースも明示的に弾く（検証関数の実装に依存させない）
  if (!state || !(await verifyOAuthState(c.env, state))) {
    console.warn('[freee callback] state の検証に失敗したため中断しました');
    return c.html(
      page(
        '認証失敗',
        '<p>リンクが無効か、時間切れです。管理画面から接続をやり直してください。</p>',
      ),
      400,
    );
  }

  try {
    const tokens = await exchangeCodeForTokens(c.env, code);
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
    const now = jstNow();

    // 同じ事業所の接続が既にあれば UPDATE する。
    // 再認可は90日ごとの正常な運用なので、INSERT し続けると
    // 「死んだ refresh_token を持つ古い行」が is_active=1 のまま残ってしまう。
    // is_active は触らない（稼働中の連携を再認可で止めないため）。
    const existing = tokens.company_id
      ? await c.env.DB
          .prepare('SELECT id FROM freee_accounts WHERE company_id = ? LIMIT 1')
          .bind(tokens.company_id)
          .first<{ id: string }>()
      : null;

    let id: string;
    let isNew: boolean;

    if (existing) {
      id = existing.id;
      isNew = false;
      await c.env.DB.prepare(`
        UPDATE freee_accounts
           SET access_token = ?, refresh_token = ?, token_expires_at = ?, updated_at = ?
         WHERE id = ?
      `).bind(tokens.access_token, tokens.refresh_token, expiresAt, now, id).run();
    } else {
      id = crypto.randomUUID();
      isNew = true;
      // ⚠️ is_active は立てない（保留）。公開エンドポイントなので自動有効化しない。
      await c.env.DB.prepare(`
        INSERT INTO freee_accounts
          (id, company_id, access_token, refresh_token, token_expires_at, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?)
      `).bind(
        id,
        tokens.company_id ?? null,
        tokens.access_token,
        tokens.refresh_token,
        expiresAt,
        now,
        now,
      ).run();
    }

    // トークンはログに出さない。追跡は接続IDで行う。
    console.log(`[freee callback] 連携を${isNew ? '作成（保留）' : '更新'}:`, id);

    const note = isNew
      ? '<p>この接続はまだ<strong>保留</strong>です。管理画面から<strong>有効化</strong>してください。</p>'
      : '<p>既存の接続のトークンを更新しました。そのままご利用いただけます。</p>';

    return c.html(page('✅ freee 連携完了', `
      <p>接続ID: <code style="background:#f0f0f0;padding:4px 8px;border-radius:4px">${escapeHtml(id)}</code></p>
      ${note}
    `));
  } catch (err: unknown) {
    // 認可コードは既に消費済み。同じリンクを開き直しても絶対に成功しないので、
    // 「時間をおいて再試行」ではなく「最初からやり直す」を案内する。
    console.error('[freee callback] トークン交換に失敗:', err);
    return c.html(
      page(
        'エラー',
        '<p>freee との連携に失敗しました。お手数ですが、管理画面から接続を最初からやり直してください。</p>',
      ),
      500,
    );
  }
});

export { freee };
