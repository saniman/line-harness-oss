-- Ported from upstream Shudesu/line-harness-oss migration 044_forms_og.sql
ALTER TABLE forms ADD COLUMN og_title TEXT;
ALTER TABLE forms ADD COLUMN og_description TEXT;
ALTER TABLE forms ADD COLUMN og_image_url TEXT;
