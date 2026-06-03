# DB マイグレーションガイド（fork 版）

このドキュメントは `saniman/line-harness-oss`（`Shudesu/line-harness-oss` の fork）における
DB マイグレーションの管理ルールを定める。

---

## マイグレーションの仕組み

### 新規インストール（schema.sql が正規ソース）

```bash
wrangler d1 execute line-harness --file=packages/db/schema.sql --remote
```

`schema.sql` が全テーブルの定義を保持する。新規 DB はこれだけで再現できる。

### 既存 DB への差分適用（マイグレーションファイル）

```bash
wrangler d1 execute line-harness --file=packages/db/migrations/NNN_name.sql --remote
```

`migrations/` 以下のファイルは、既存 DB に対する増分変更を記述する。
wrangler の組み込みマイグレーション管理（`d1_migrations` テーブル）は**現時点では未使用**であり、
どのファイルが適用済みかはオペレーターが手動で管理する。

> **TODO**: `wrangler.toml` に `migrations_dir` を設定してトラッキングを自動化する（計画中）。

---

## 番号採番ルール（重要）

### なぜルールが必要か

upstream（`Shudesu/line-harness-oss`）と fork が独立して連番を採番すると、
同じ番号が別内容のファイルになる衝突が発生する。

**実際に発生した衝突（2026-06-03 解消）:**

| 番号 | fork の内容 | upstream の内容 |
|------|------------|----------------|
| 028 | `business_hours` テーブル作成 | `messages_log.source` カラム追加 |
| 029 | `events` テーブル作成 | `broadcasts` テーブル再作成 |
| 030 | Stripe 決済カラム追加 | `broadcasts.dedup_progress` 追加 |
| 031 | `events.price` 追加 | `broadcasts.batch_lock_at` 追加 |
| 032 | `event_bookings_v2` 再作成 | `messages_log.line_account_id` 追加 |
| 033 | 返金カラム追加 | `auto_replies.template_id` 追加 |

解消方法: upstream の 028-045 を fork の 034-054 に移植。

### 採番ルール（今後）

```
001 〜 799  upstream 由来のマイグレーション（変更しない）
800 〜 999  fork 固有のマイグレーション（business_hours, events, Stripe 等）
```

#### upstream のマイグレーションを取り込む場合

upstream が新しいマイグレーション（例: `046_xxx.sql`）を追加したら、
fork の現在の最大番号 + 1 で取り込む：

```bash
# upstream の 046 を fork の 055 として追加する例
cp <upstream_content> packages/db/migrations/055_xxx.sql
# 先頭にコメントを追加
# -- Ported from upstream Shudesu/line-harness-oss migration 046_xxx.sql
```

#### fork 固有の機能を追加する場合

```bash
# 800 番台を使う（現在: 800〜805 使用済み）
packages/db/migrations/806_new_fork_feature.sql
```

> **なぜ 800 番台か**: upstream は現在 045 番台。800 まで 755 本の余裕があり、
> 仮に upstream が年 50 本追加しても 15 年以上衝突しない。

---

## 現在の番号割り当て状況

### upstream 由来（fork に移植済み）

| fork 番号 | upstream 元ファイル | 内容 |
|-----------|-------------------|------|
| 001–027 | 同番号 | upstream と同一 |
| 034 | 028_messages_log_source | `messages_log.source` |
| 035 | 029_account_management_v2 | `broadcasts` 再作成・`line_accounts` 拡張 |
| 036 | 030_dedup_progress | `broadcasts.dedup_progress` |
| 037 | 031_batch_lock_at | `broadcasts.batch_lock_at` |
| 038 | 032_messages_log_line_account_id | `messages_log.line_account_id` |
| 039 | 033_auto_replies_template_id | `auto_replies.template_id` |
| 040 | 034_webhook_secret_required | webhook セキュリティ fail-close |
| 041 | 035_rich_menu_groups | リッチメニューテーブル群 |
| 042 | 036_booking | スタッフ予約テーブル群 |
| 043 | 037_scenario_delivery_mode | no-op マーカー |
| 044 | 038_entry_routes_pool_and_push | `entry_routes` 拡張 |
| 045 | 038_scenario_templates_and_stats | `scenario_steps`・`messages_log` 拡張 |
| 046 | 039_default_main_pool | デフォルトプール投入 |
| 047 | 040_events_multi_account | `events`・`event_bookings` マルチアカウント対応 |
| 048 | 041_event_custom_messages | `events` カスタムメッセージ |
| 049 | 041_update_history | `update_history` テーブル |
| 050 | 041_account_og_defaults | `line_accounts` OGP カラム |
| 051 | 042_tracked_links_og | `tracked_links` OGP カラム |
| 052 | 043_events_og | `events` OGP カラム |
| 053 | 044_forms_og | `forms` OGP カラム |
| 054 | 045_menus_auto_tag | `menus.auto_tag_id` |

### fork 固有（800 番台）

| fork 番号 | 内容 |
|-----------|------|
| 800 | `business_hours`・`business_holidays` テーブル（旧 028） |
| 801 | `events`・`event_bookings` テーブル（旧 029） |
| 802 | Stripe 決済カラム（旧 030） |
| 803 | `events.price`（旧 031） |
| 804 | `event_bookings_v2` 再作成（旧 032） |
| 805 | 返金カラム（旧 033） |

> これらは**本番 D1 には既に 028-033 として適用済み**。800 番台ファイルは
> 新規インストール用の参照ドキュメントとして作成する（次のステップ）。

### スキップ済み

| upstream ファイル | 理由 |
|-----------------|------|
| `037_event_booking.sql` | fork の `events` テーブル（INTEGER PK / `title` 列）と upstream（TEXT PK / `name` 列）が非互換。インデックス作成が `line_account_id` 列不在で失敗する |

---

## 新しいマイグレーションを追加するとき

### チェックリスト

```
[ ] 番号は 800〜999 の未使用番号を選んだ（fork 固有機能の場合）
[ ] ファイル名: NNN_snake_case_description.sql
[ ] 先頭にコメントで変更内容を説明した
[ ] schema.sql を同期した（後述）
[ ] ローカル D1 で動作確認した
[ ] 本番 D1 に --remote で適用した
```

### ローカル確認

```bash
cd apps/worker
npx wrangler@latest d1 execute line-harness --local \
  --file=../../packages/db/migrations/NNN_name.sql
```

### 本番適用

```bash
cd apps/worker
npx wrangler@latest d1 execute line-harness --remote \
  --file=../../packages/db/migrations/NNN_name.sql
```

---

## schema.sql の同期

マイグレーションを適用したら `schema.sql` も更新する。
`schema.sql` は新規インストール用の正規ソースであり、
マイグレーションファイルと乖離すると新規セットアップができなくなる。

```bash
# ローカル D1 の現在の状態を確認
npx wrangler@latest d1 execute line-harness --local \
  --command="SELECT sql FROM sqlite_master WHERE type='table' AND name='<テーブル名>'"
```

---

## events テーブルの設計乖離について

fork の `events` テーブルは upstream と**根本的に異なる設計**をしている：

| 観点 | fork | upstream |
|------|------|----------|
| PK | `INTEGER AUTOINCREMENT` | `TEXT` (UUID) |
| 日程 | `start_at` / `end_at` 直接保持 | `event_slots` テーブルで分離 |
| マルチアカウント | 対応なし（`line_account_id` なし） | 対応済み |
| 決済 | Stripe 統合済み | 未実装 |

upstream の `037_event_booking.sql` はこの設計差のため適用不可。
将来的には fork の Stripe 統合を upstream に PR することで解消を目指す（`docs/OSS-SYNC-CHARTER.md` 参照）。
