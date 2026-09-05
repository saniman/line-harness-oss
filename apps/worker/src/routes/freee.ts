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
import { jstNow, toJstString } from '@line-crm/db';
import { requireRole } from '../middleware/role-guard.js';
import {
  getFreeeAuthUrl,
  exchangeCodeForTokens,
  createOAuthState,
  verifyOAuthState,
  fetchFreeeCompanyName,
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
    // 認証必須（管理画面から叩く）。URL を返し、遷移はブラウザ側で行う。
    // ブラウザから直接開ける redirect=1 は廃止した（state オラクルになるため）。
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
  // state 自体が無いケースも明示的に弾く（検証関数の実装に依存させない）。
  // FREEE_CLIENT_SECRET 未設定だと HMAC の importKey が例外を投げるため、
  // 例外も「検証に通らなかった」として扱い、素の 500 を出さない。
  let stateOk = false;
  try {
    stateOk = !!state && (await verifyOAuthState(c.env, state));
  } catch (err) {
    console.error('[freee callback] state の検証でエラー（シークレット未設定の可能性）:', err);
  }

  if (!stateOk) {
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

    // ⚠️ company_id が無い接続は保存しない。
    //    (1) 部分UNIQUE(company_id IS NOT NULL) の対象外になるため UPSERT が効かず、
    //        再認可のたびに行が増え、古い行が死んだ refresh_token を抱えたまま残る。
    //    (2) company_name も未取得なので、#44 の有効化画面で
    //        「自分の接続」と「第三者の接続」を見分ける手がかりが無くなる。
    //        保留にして目視確認させる、という防御そのものが成立しなくなる。
    //    見分けのつかない行を作るくらいなら、原因を名指しして止める。
    if (tokens.company_id == null) {
      console.error('[freee callback] company_id が取得できないため保存を中止しました');
      return c.html(
        page(
          'エラー',
          `<p>freee から<strong>事業所ID</strong>が取得できなかったため、連携を保存しませんでした。</p>
           <p>認可のときに<strong>事業所の選択</strong>が表示されたか確認し、もう一度お試しください。
           繰り返し失敗する場合は、freee アプリのスコープ設定をご確認ください。</p>`,
        ),
        500,
      );
    }

    // 事業所名はベストエフォート（取れなくても連携は成立させる）。
    // 管理画面で「自分の事業所」を見分けるための表示用。
    const companyName = await fetchFreeeCompanyName(tokens.access_token, tokens.company_id);

    // ⚠️ 期限も JST(+09:00) で保存する。SQLite の日時比較は文字列比較なので、
    //    ここだけ UTC の Z にすると created_at 等との比較が9時間ずれる。
    const expiresAt = toJstString(new Date(Date.now() + tokens.expires_in * 1000));
    const now = jstNow();

    // 1文の UPSERT で保存する。SELECT→INSERT に分けると、同じ事業所の再認可が
    // 同時に走ったとき両方 INSERT され、「死んだ refresh_token を持つ行」が
    // 残ってしまう（この処理が防ごうとしている状態そのもの）。
    //
    // ⚠️ is_active は INSERT 時のみ 0（保留）。ON CONFLICT 側では触らない。
    //    再認可のたびに 0 へ戻すと、稼働中の連携が90日ごとに止まる。
    const row = await c.env.DB.prepare(`
      INSERT INTO freee_accounts
        (id, company_id, company_name, access_token, refresh_token, token_expires_at, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(company_id) WHERE company_id IS NOT NULL DO UPDATE SET
        company_name     = COALESCE(excluded.company_name, freee_accounts.company_name),
        access_token     = excluded.access_token,
        refresh_token    = excluded.refresh_token,
        token_expires_at = excluded.token_expires_at,
        updated_at       = excluded.updated_at
      RETURNING id, is_active
    `).bind(
      crypto.randomUUID(),
      tokens.company_id,
      companyName,
      tokens.access_token,
      tokens.refresh_token,
      expiresAt,
      now,
      now,
    ).first<{ id: string; is_active: number }>();

    const id = row?.id ?? '(不明)';
    const isPending = !row || row.is_active === 0;

    // トークンはログに出さない。追跡は接続IDで行う。
    console.log(`[freee callback] 連携を保存${isPending ? '（保留）' : '（有効）'}:`, id);

    const note = isPending
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

// ========== 接続管理（管理画面から・要認証）==========

/**
 * 接続一覧。
 *
 * ⚠️ トークン列は絶対に返さない。管理画面に出す＝ブラウザに渡るため、
 *    漏れると連携を乗っ取られる。列追加で事故らないよう `SELECT *` を使わず明示する。
 */
freee.get('/api/integrations/freee', async (c) => {
  try {
    const rows = await c.env.DB.prepare(
      `SELECT id, company_id, company_name, is_active, token_expires_at, created_at, updated_at
         FROM freee_accounts
        ORDER BY is_active DESC, created_at DESC`,
    ).all<{
      id: string;
      company_id: number;
      company_name: string | null;
      is_active: number;
      token_expires_at: string | null;
      created_at: string;
      updated_at: string;
    }>();

    return c.json({
      success: true,
      data: rows.results.map((r) => ({
        id: r.id,
        companyId: r.company_id,
        companyName: r.company_name,
        isActive: Boolean(r.is_active),
        tokenExpiresAt: r.token_expires_at,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/integrations/freee error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * 接続を有効化する。
 *
 * 有効な接続は常に1本に保つ。複数あると getValidAccessTokenFreee が
 * どれを拾うか実質不定になり、領収書の発行先が揺れる。
 */
// ⚠️ owner 限定。この機能の防御は「認証済みの管理者が事業所を目視して有効化する」ことに
//    依存している。staff の API キーで有効化できると、公開コールバックで登録した
//    自分の事業所へ領収書の発行先を差し替えられてしまう。
//    LINE アカウント管理・スタッフ管理と同じ扱いにする。
freee.post('/api/integrations/freee/:id/activate', requireRole('owner'), async (c) => {
  try {
    const id = c.req.param('id');
    const now = jstNow();

    // ⚠️ 2文を別々に実行すると、2文目が失敗したときに「有効な接続が2本」という
    //    この処理が防ごうとしている状態そのものを作ってしまう。
    //    D1 の batch はトランザクションなので、まとめて成否が決まる。
    //
    //    無効化側には EXISTS のガードを付ける。batch は両方走るため、
    //    ガードが無いと「存在しないIDを投げるだけで全接続を止められる」ことになる。
    //    `is_active = 1` の条件は、無関係な行の updated_at を動かさないため
    //    （管理画面の「最終更新」が嘘になるのを防ぐ）。
    const [activated] = await c.env.DB.batch([
      c.env.DB
        .prepare('UPDATE freee_accounts SET is_active = 1, updated_at = ? WHERE id = ?')
        .bind(now, id),
      c.env.DB
        .prepare(
          `UPDATE freee_accounts
              SET is_active = 0, updated_at = ?
            WHERE id != ?
              AND is_active = 1
              AND EXISTS (SELECT 1 FROM freee_accounts WHERE id = ?)`,
        )
        .bind(now, id, id),
    ]);

    if (!activated.meta.changes) {
      return c.json({ success: false, error: 'Connection not found' }, 404);
    }

    console.log('[freee] 接続を有効化:', id);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('POST /api/integrations/freee/:id/activate error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/** 接続を削除する（身に覚えのない接続の始末用）。有効化と同じく owner 限定。 */
freee.delete('/api/integrations/freee/:id', requireRole('owner'), async (c) => {
  try {
    const id = c.req.param('id');
    const deleted = await c.env.DB
      .prepare('DELETE FROM freee_accounts WHERE id = ?')
      .bind(id)
      .run();

    // 存在しないIDに success を返すと、古いタブから消えた接続を消したときに
    // 「削除できた」と嘘の表示になる。有効化の 404 と挙動を揃える。
    if (!deleted.meta.changes) {
      return c.json({ success: false, error: 'Connection not found' }, 404);
    }

    console.log('[freee] 接続を削除:', id);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/integrations/freee/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { freee };
