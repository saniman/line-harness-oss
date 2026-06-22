-- 飲食店モバイルオーダー用のサンプルメニュー シード
--
-- 目的: 動作確認・デモ用に menus / menu_options / dining_tables へ数件投入する。
-- 冪等: 固定IDの INSERT OR IGNORE なので何度流しても重複しない。
-- 前提: line_accounts に有効なアカウントが1件以上ある（line_account_id は最古の有効行を参照）。
-- 飲食では duration_minutes / buffer_after_minutes は使わないので 0 を入れる。
--
-- 適用:
--   ローカル: npx wrangler@latest d1 execute line-harness --local  --file=packages/db/seeds/mobile-order-seed.sql
--   本番:     npx wrangler@latest d1 execute line-harness --remote --file=packages/db/seeds/mobile-order-seed.sql
-- 取り消し（シードのみ削除）はファイル末尾の DELETE 文コメント参照。

-- ── メニュー本体 ───────────────────────────────────────────
-- 列: id, line_account_id, name, category_label, description,
--     duration_minutes, buffer_after_minutes, base_price, sort_order, is_active
INSERT OR IGNORE INTO menus
  (id, line_account_id, name, category_label, description, duration_minutes, buffer_after_minutes, base_price, sort_order, is_active)
SELECT v.id, (SELECT id FROM line_accounts WHERE is_active = 1 ORDER BY created_at ASC LIMIT 1),
       v.name, v.cat, v.descr, 0, 0, v.price, v.sort, 1
FROM (
  -- おすすめ
  SELECT 'seedmo-sashimi' AS id, '本日の刺身5点盛り' AS name, 'おすすめ' AS cat, '沖縄近海の鮮魚をその日仕入れで' AS descr, 1280 AS price, 0 AS sort
  UNION ALL SELECT 'seedmo-margherita', 'マルゲリータ', 'おすすめ', '石窯焼き・バジルの香り', 1080, 1
  -- ドリンク
  UNION ALL SELECT 'seedmo-beer',     '生ビール',           'ドリンク', 'キンキンに冷えた一杯',   600, 10
  UNION ALL SELECT 'seedmo-highball', 'ハイボール',         'ドリンク', '角・濃いめ',             500, 11
  UNION ALL SELECT 'seedmo-sour',     '自家製レモンサワー', 'ドリンク', '丸ごとレモン',           550, 12
  UNION ALL SELECT 'seedmo-oolong',   'ウーロン茶',         'ドリンク', NULL,                     350, 13
  -- フード
  UNION ALL SELECT 'seedmo-karaage', '鶏の唐揚げ',     'フード', '国産鶏・5個',         680, 20
  UNION ALL SELECT 'seedmo-edamame', '枝豆',           'フード', '沖縄県産',            350, 21
  UNION ALL SELECT 'seedmo-caesar',  'シーザーサラダ', 'フード', '半熟卵とベーコン',     580, 22
  UNION ALL SELECT 'seedmo-mentaiko','明太子パスタ',   'フード', '大葉と刻み海苔',       880, 23
  -- デザート
  UNION ALL SELECT 'seedmo-icecream', 'バニラアイス',   'デザート', '黒糖ソースがけ', 380, 30
  UNION ALL SELECT 'seedmo-gateau',   'ガトーショコラ', 'デザート', '温かい状態で',   480, 31
) AS v;

-- ── メニューオプション（サイズ・味変） ─────────────────────
-- 列: id, menu_id, group_label, choice_name, extra_price, sort_order, is_active
INSERT OR IGNORE INTO menu_options
  (id, menu_id, group_label, choice_name, extra_price, sort_order, is_active)
VALUES
  ('seedmo-opt-beer-m',   'seedmo-beer',    'サイズ', '中ジョッキ',  0,   0, 1),
  ('seedmo-opt-beer-l',   'seedmo-beer',    'サイズ', '大ジョッキ',  200, 1, 1),
  ('seedmo-opt-kara-none','seedmo-karaage', '味変',   'そのまま',    0,   0, 1),
  ('seedmo-opt-kara-mayo','seedmo-karaage', '味変',   '特製マヨ',    50,  1, 1),
  ('seedmo-opt-kara-lemon','seedmo-karaage','味変',   'レモン塩',    0,   2, 1);

-- ── テーブル（動作確認用。本番運用では管理画面の「テーブル管理」でランダム発行推奨） ──
-- 列: id, line_account_id, table_number, qr_token, is_active
INSERT OR IGNORE INTO dining_tables (id, line_account_id, table_number, qr_token, is_active)
SELECT v.id, (SELECT id FROM line_accounts WHERE is_active = 1 ORDER BY created_at ASC LIMIT 1),
       v.num, v.token, 1
FROM (
  SELECT 'seedmo-tbl-a1' AS id, 'A-1' AS num, 'seedmo-table-a1' AS token
  UNION ALL SELECT 'seedmo-tbl-a2', 'A-2', 'seedmo-table-a2'
  UNION ALL SELECT 'seedmo-tbl-a3', 'A-3', 'seedmo-table-a3'
) AS v;

-- ── 取り消し（シードで入れた行だけ削除したい場合） ─────────
-- DELETE FROM menu_options  WHERE id LIKE 'seedmo-%';
-- DELETE FROM order_items   WHERE menu_id LIKE 'seedmo-%';
-- DELETE FROM menus         WHERE id LIKE 'seedmo-%';
-- DELETE FROM dining_tables WHERE id LIKE 'seedmo-%';
