-- Fork-specific migration: 822_freee_accounts.sql
-- freee OAuth2 連携のトークンを保存するテーブル（Epic #41 / 子 Issue #43）。
--
-- 構成は既存の google_calendar_connections に倣うが、freee 固有の事情がある:
--
--   ⚠️ freee のリフレッシュトークンは「1回限り・有効期限90日」。
--      使うたびに新しい refresh_token が発行され、古いものは無効になる
--      （rotating refresh token）。Google のように使い回せない。
--      → リフレッシュ時は必ず refresh_token も UPDATE すること（#44）。
--      → 90日リフレッシュしないと失効するため、再認証導線が必須。
--      出典: https://developer.freee.co.jp/reference/認可コード
--
-- company_id は freee の事業所ID。1アカウントが複数事業所を持てるため、
-- 認可時に prompt=select_company で選ばせた結果を保持する。
-- トークン交換のレスポンスに含まれない場合があるので NULL 許容。

CREATE TABLE IF NOT EXISTS freee_accounts (
  id               TEXT PRIMARY KEY,
  -- freee の事業所ID（NULL = 未取得。#44 で /companies から補完する余地あり）
  company_id       INTEGER,
  company_name     TEXT,
  access_token     TEXT,
  -- ⚠️ 1回限り使用可。リフレッシュのたびに新しい値へ差し替えること
  refresh_token    TEXT,
  token_expires_at TEXT,
  -- 0 = 保留（認可直後の既定）/ 1 = 有効。
  -- /callback は公開エンドポイントなので、認可を完走した第三者の事業所が
  -- ここに入りうる。新規接続は必ず 0 で作り、有効化は認証済みの管理画面から行う。
  -- 再認可（90日ごと）では既存行のトークンだけ更新し is_active は触らない。
  is_active        INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_freee_accounts_is_active ON freee_accounts (is_active);

-- 同じ事業所の接続を1本に保つ。再認可が同時に走っても行が重複しないよう DB 側で担保し、
-- routes/freee.ts の UPSERT（ON CONFLICT(company_id)）のターゲットにもなる。
-- company_id が未取得（NULL）の行は対象外にするため部分インデックスにする。
CREATE UNIQUE INDEX IF NOT EXISTS idx_freee_accounts_company_id
  ON freee_accounts (company_id) WHERE company_id IS NOT NULL;
