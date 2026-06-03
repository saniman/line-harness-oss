-- D1マイグレーション自動トラッキングのブートストラップ
-- 目的: migrations_dir 導入前に手動適用済みのマイグレーションを d1_migrations テーブルに登録する
-- 実行タイミング: migrations_dir を wrangler.toml に追加した直後、一度だけ実行する
--
-- 適用済みとしてマークするファイル:
--   001-033: 実際に remote DB に適用済み
--   800-805: 028-033 として内容が適用済み（fork 固有: business_hours, events, Stripe）
--
-- 未適用（034-054）は pending のまま残す。
-- `npx wrangler d1 migrations list line-harness --remote` で確認後、
-- `npx wrangler d1 migrations apply line-harness --remote` で適用する。

CREATE TABLE IF NOT EXISTS d1_migrations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

INSERT OR IGNORE INTO d1_migrations (name) VALUES
  ('001_round2.sql'),
  ('002_round3.sql'),
  ('003_entry_routes.sql'),
  ('004_friend_metadata.sql'),
  ('005_step_branching.sql'),
  ('006_tracked_links.sql'),
  ('007_forms.sql'),
  ('008_multi_account.sql'),
  ('009_delivery_type.sql'),
  ('009_token_expiry.sql'),
  ('010_ad_conversions.sql'),
  ('011_staff_members.sql'),
  ('012_alt_text.sql'),
  ('013_broadcast_insights.sql'),
  ('014_form_submit_message.sql'),
  ('015_auto_reply_account.sql'),
  ('016_traffic_pools.sql'),
  ('017_form_webhook.sql'),
  ('018_broadcast_queue.sql'),
  ('018_message_templates.sql'),
  ('019_pool_accounts.sql'),
  ('020_tracked_link_intro.sql'),
  ('021_tracked_link_reward.sql'),
  ('022_friend_first_tracked_link.sql'),
  ('023_friend_ig_igsid.sql'),
  ('024_form_opens.sql'),
  ('025_account_settings.sql'),
  ('026_delivery_type_test.sql'),
  ('027_dedup_delivery.sql'),
  ('028_business_hours.sql'),
  ('029_events.sql'),
  ('030_stripe.sql'),
  ('031_events_price.sql'),
  ('032_event_bookings_pending.sql'),
  ('033_event_booking_refund.sql'),
  -- 800-805: 028-033 と同内容が DB に適用済みのため pending から除外
  ('800_business_hours.sql'),
  ('801_events.sql'),
  ('802_stripe_event_bookings.sql'),
  ('803_events_price.sql'),
  ('804_event_bookings_pending.sql'),
  ('805_event_booking_refund.sql');
