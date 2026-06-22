-- 飲食店モバイルオーダー用のサンプルメニュー シード
--
-- 目的: 動作確認・デモ用に menus / menu_options / dining_tables へ数件投入する。
-- 冪等: 固定IDの INSERT OR IGNORE なので何度流しても重複しない。
-- 前提: line_accounts に有効なアカウントが1件以上ある（line_account_id は最古の有効行を参照）。
-- 飲食では duration_minutes / buffer_after_minutes は使わないので 0 を入れる。
--
-- D1 はコンパウンドSELECT(UNION ALL 連結)の項数上限が低いため、
-- メニュー/テーブルは「1行=1 INSERT」で記述する（UNION ALL を使わない）。
--
-- 適用（推奨）: bash apps/worker/seed-mobile-order.sh
-- 手動:        npx wrangler@latest d1 execute line-harness --remote --file=packages/db/seeds/mobile-order-seed.sql

-- ── メニュー本体（1行=1 INSERT。line_account_id は最古の有効アカウントを参照）──
-- 列: id, line_account_id, name, category_label, description, duration_minutes, buffer_after_minutes, base_price, sort_order, is_active, menu_type
-- menu_type='food' で飲食モバイルオーダー用。サロン予約一覧には出ない。
INSERT OR IGNORE INTO menus (id,line_account_id,name,category_label,description,duration_minutes,buffer_after_minutes,base_price,sort_order,is_active,menu_type)
  SELECT 'seedmo-sashimi',(SELECT id FROM line_accounts WHERE is_active=1 ORDER BY created_at ASC LIMIT 1),'本日の刺身5点盛り','おすすめ','沖縄近海の鮮魚をその日仕入れで',0,0,1280,0,1,'food';
INSERT OR IGNORE INTO menus (id,line_account_id,name,category_label,description,duration_minutes,buffer_after_minutes,base_price,sort_order,is_active,menu_type)
  SELECT 'seedmo-margherita',(SELECT id FROM line_accounts WHERE is_active=1 ORDER BY created_at ASC LIMIT 1),'マルゲリータ','おすすめ','石窯焼き・バジルの香り',0,0,1080,1,1,'food';
INSERT OR IGNORE INTO menus (id,line_account_id,name,category_label,description,duration_minutes,buffer_after_minutes,base_price,sort_order,is_active,menu_type)
  SELECT 'seedmo-beer',(SELECT id FROM line_accounts WHERE is_active=1 ORDER BY created_at ASC LIMIT 1),'生ビール','ドリンク','キンキンに冷えた一杯',0,0,600,10,1,'food';
INSERT OR IGNORE INTO menus (id,line_account_id,name,category_label,description,duration_minutes,buffer_after_minutes,base_price,sort_order,is_active,menu_type)
  SELECT 'seedmo-highball',(SELECT id FROM line_accounts WHERE is_active=1 ORDER BY created_at ASC LIMIT 1),'ハイボール','ドリンク','角・濃いめ',0,0,500,11,1,'food';
INSERT OR IGNORE INTO menus (id,line_account_id,name,category_label,description,duration_minutes,buffer_after_minutes,base_price,sort_order,is_active,menu_type)
  SELECT 'seedmo-sour',(SELECT id FROM line_accounts WHERE is_active=1 ORDER BY created_at ASC LIMIT 1),'自家製レモンサワー','ドリンク','丸ごとレモン',0,0,550,12,1,'food';
INSERT OR IGNORE INTO menus (id,line_account_id,name,category_label,description,duration_minutes,buffer_after_minutes,base_price,sort_order,is_active,menu_type)
  SELECT 'seedmo-oolong',(SELECT id FROM line_accounts WHERE is_active=1 ORDER BY created_at ASC LIMIT 1),'ウーロン茶','ドリンク',NULL,0,0,350,13,1,'food';
INSERT OR IGNORE INTO menus (id,line_account_id,name,category_label,description,duration_minutes,buffer_after_minutes,base_price,sort_order,is_active,menu_type)
  SELECT 'seedmo-karaage',(SELECT id FROM line_accounts WHERE is_active=1 ORDER BY created_at ASC LIMIT 1),'鶏の唐揚げ','フード','国産鶏・5個',0,0,680,20,1,'food';
INSERT OR IGNORE INTO menus (id,line_account_id,name,category_label,description,duration_minutes,buffer_after_minutes,base_price,sort_order,is_active,menu_type)
  SELECT 'seedmo-edamame',(SELECT id FROM line_accounts WHERE is_active=1 ORDER BY created_at ASC LIMIT 1),'枝豆','フード','沖縄県産',0,0,350,21,1,'food';
INSERT OR IGNORE INTO menus (id,line_account_id,name,category_label,description,duration_minutes,buffer_after_minutes,base_price,sort_order,is_active,menu_type)
  SELECT 'seedmo-caesar',(SELECT id FROM line_accounts WHERE is_active=1 ORDER BY created_at ASC LIMIT 1),'シーザーサラダ','フード','半熟卵とベーコン',0,0,580,22,1,'food';
INSERT OR IGNORE INTO menus (id,line_account_id,name,category_label,description,duration_minutes,buffer_after_minutes,base_price,sort_order,is_active,menu_type)
  SELECT 'seedmo-mentaiko',(SELECT id FROM line_accounts WHERE is_active=1 ORDER BY created_at ASC LIMIT 1),'明太子パスタ','フード','大葉と刻み海苔',0,0,880,23,1,'food';
INSERT OR IGNORE INTO menus (id,line_account_id,name,category_label,description,duration_minutes,buffer_after_minutes,base_price,sort_order,is_active,menu_type)
  SELECT 'seedmo-icecream',(SELECT id FROM line_accounts WHERE is_active=1 ORDER BY created_at ASC LIMIT 1),'バニラアイス','デザート','黒糖ソースがけ',0,0,380,30,1,'food';
INSERT OR IGNORE INTO menus (id,line_account_id,name,category_label,description,duration_minutes,buffer_after_minutes,base_price,sort_order,is_active,menu_type)
  SELECT 'seedmo-gateau',(SELECT id FROM line_accounts WHERE is_active=1 ORDER BY created_at ASC LIMIT 1),'ガトーショコラ','デザート','温かい状態でご提供',0,0,480,31,1,'food';

-- 既に menu_type 列追加(810)より前に投入済みの行は 'salon' になっているため 'food' に補正する（冪等）
UPDATE menus SET menu_type='food' WHERE id LIKE 'seedmo-%' AND menu_type<>'food';

-- ── メニューオプション（サイズ・味変）。VALUES なのでコンパウンドSELECT非該当 ──
-- 列: id, menu_id, group_label, choice_name, extra_price, sort_order, is_active
INSERT OR IGNORE INTO menu_options (id,menu_id,group_label,choice_name,extra_price,sort_order,is_active) VALUES
  ('seedmo-opt-beer-m','seedmo-beer','サイズ','中ジョッキ',0,0,1),
  ('seedmo-opt-beer-l','seedmo-beer','サイズ','大ジョッキ',200,1,1),
  ('seedmo-opt-kara-none','seedmo-karaage','味変','そのまま',0,0,1),
  ('seedmo-opt-kara-mayo','seedmo-karaage','味変','特製マヨ',50,1,1),
  ('seedmo-opt-kara-lemon','seedmo-karaage','味変','レモン塩',0,2,1);

-- ── テーブル（動作確認用。1行=1 INSERT）──
-- 列: id, line_account_id, table_number, qr_token, is_active
INSERT OR IGNORE INTO dining_tables (id,line_account_id,table_number,qr_token,is_active)
  SELECT 'seedmo-tbl-a1',(SELECT id FROM line_accounts WHERE is_active=1 ORDER BY created_at ASC LIMIT 1),'A-1','seedmo-table-a1',1;
INSERT OR IGNORE INTO dining_tables (id,line_account_id,table_number,qr_token,is_active)
  SELECT 'seedmo-tbl-a2',(SELECT id FROM line_accounts WHERE is_active=1 ORDER BY created_at ASC LIMIT 1),'A-2','seedmo-table-a2',1;
INSERT OR IGNORE INTO dining_tables (id,line_account_id,table_number,qr_token,is_active)
  SELECT 'seedmo-tbl-a3',(SELECT id FROM line_accounts WHERE is_active=1 ORDER BY created_at ASC LIMIT 1),'A-3','seedmo-table-a3',1;

-- ── 取り消し（シードで入れた行だけ削除したい場合） ──
-- DELETE FROM menu_options  WHERE id LIKE 'seedmo-%';
-- DELETE FROM order_items   WHERE menu_id LIKE 'seedmo-%';
-- DELETE FROM menus         WHERE id LIKE 'seedmo-%';
-- DELETE FROM dining_tables WHERE id LIKE 'seedmo-%';
