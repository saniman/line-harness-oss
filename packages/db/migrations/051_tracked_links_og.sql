-- Ported from upstream Shudesu/line-harness-oss migration 042_tracked_links_og.sql
ALTER TABLE tracked_links ADD COLUMN og_title TEXT;
ALTER TABLE tracked_links ADD COLUMN og_description TEXT;
ALTER TABLE tracked_links ADD COLUMN og_image_url TEXT;
