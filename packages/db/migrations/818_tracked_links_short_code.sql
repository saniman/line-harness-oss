-- Ported from upstream Shudesu/line-harness-oss migration 049_tracked_links_short_code.sql
--
-- tracked_links.short_code — メッセージ内のリンクを短くするための 7 文字 base62 コード:
--   https://<domain>/t/Ab3xY9k   （36 文字の UUID を使う /t/<uuid> の代わり）
-- /t/:linkId は両形式を解決する（旧リンクは UUID、新規リンクは short_code）。
-- コードは作成時に生成される。既存行は NULL のままで UUID でのみ解決される。

ALTER TABLE tracked_links ADD COLUMN short_code TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tracked_links_short_code
  ON tracked_links (short_code) WHERE short_code IS NOT NULL;
