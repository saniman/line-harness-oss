-- Fork-specific migration: 809_mobile_order.sql
-- 飲食店モバイルオーダー（店内テーブルオーダー / 店頭・現金併用決済）
--   dining_tables  : テーブル登録（QRトークン → LIFF URL ?table=<qr_token>）
--   menu_options   : 商品オプション（サイズ・トッピング等）。menus を商品マスタとして再利用
--   orders         : 注文ヘッダ。dec済は店頭のため payment_status を店員が更新（Stripe 非依存）
--   order_items    : 注文明細（注文時点の商品名・単価・オプションをスナップショット保存）
-- menus.duration_minutes 等のサロン用カラムは飲食では 0 を入れて使う。

CREATE TABLE IF NOT EXISTS dining_tables (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL,
  table_number    TEXT NOT NULL,              -- 表示用ラベル（例: A-3）
  qr_token        TEXT NOT NULL,              -- QR / LIFF URL に埋め込む推測困難なトークン
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dining_tables_qr ON dining_tables (qr_token);
CREATE INDEX IF NOT EXISTS idx_dining_tables_account ON dining_tables (line_account_id, is_active);

CREATE TABLE IF NOT EXISTS menu_options (
  id          TEXT PRIMARY KEY,
  menu_id     TEXT NOT NULL,
  group_label TEXT NOT NULL,                  -- 例: サイズ / 味変
  choice_name TEXT NOT NULL,                  -- 例: 大ジョッキ
  extra_price INTEGER NOT NULL DEFAULT 0,     -- 追加料金（円）
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (menu_id) REFERENCES menus(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_menu_options_menu ON menu_options (menu_id, sort_order);

CREATE TABLE IF NOT EXISTS orders (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL,
  table_id        TEXT REFERENCES dining_tables(id) ON DELETE SET NULL,
  table_number    TEXT NOT NULL,              -- 注文時点のテーブル表示名スナップショット
  friend_id       TEXT REFERENCES friends(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new','preparing','served','closed','cancelled')),
  payment_status  TEXT NOT NULL DEFAULT 'unpaid'
                    CHECK (payment_status IN ('unpaid','paid')),
  total_amount    INTEGER NOT NULL DEFAULT 0,
  customer_note   TEXT,
  placed_at       TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at         TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id)
);
CREATE INDEX IF NOT EXISTS idx_orders_account_status ON orders (line_account_id, status, placed_at);

CREATE TABLE IF NOT EXISTS order_items (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_id       TEXT REFERENCES menus(id) ON DELETE SET NULL,
  name_snapshot TEXT NOT NULL,                -- 注文時点の商品名
  options_text  TEXT NOT NULL DEFAULT '',     -- 選択オプション（例: 大ジョッキ / 特製マヨ）
  unit_price    INTEGER NOT NULL,             -- 単価（base_price + オプション加算）
  quantity      INTEGER NOT NULL,
  line_total    INTEGER NOT NULL,             -- unit_price * quantity
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items (order_id);
