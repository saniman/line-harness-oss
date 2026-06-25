-- Fork-specific migration: 814_translation_cache.sql
-- モバイルオーダーの英語対応。メニュー名・説明・オプション等の日本語を Claude で翻訳し、
-- (target_lang, source_text) で結果をキャッシュする（同じ原文は1回だけ翻訳して全店で再利用）。
-- UI 文言はクライアント側の辞書で対応するため、ここは「メニュー本体の翻訳キャッシュ」専用。

CREATE TABLE IF NOT EXISTS translation_cache (
  id              TEXT PRIMARY KEY,
  target_lang     TEXT NOT NULL,   -- 'en' など
  source_text     TEXT NOT NULL,   -- 日本語原文
  translated_text TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_translation_cache ON translation_cache (target_lang, source_text);
