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

### 既存 DB への差分適用（wrangler 自動トラッキング）

`wrangler.toml` に `migrations_dir = "../../packages/db/migrations"` を設定済み。
`d1_migrations` テーブルが適用済みファイルを自動トラッキングする。

```bash
# 未適用マイグレーションの確認（apps/worker から実行）
npx wrangler@latest d1 migrations list line-harness --remote

# 未適用マイグレーションをすべて適用
npx wrangler@latest d1 migrations apply line-harness --remote
```

> **注意**: wrangler 4.0.0 には `d1 execute --file` で相対パスを使うと
> `ERR_INVALID_STATE` が発生するバグがある。`npx wrangler@latest` を使うこと。

#### 適用状況（2026-08-28 確認）

**リポジトリ上のマイグレーションはすべて本番 D1 に適用済み**（`migrations list --remote` が
`No migrations to apply!` を返す状態）。

```bash
# 未適用の確認（読み取りのみ）
pnpm exec wrangler d1 migrations list line-harness --remote
```

`deploy-worker.yml` が deploy の前に `d1 migrations apply --remote` を自動実行するため、
`main` にマージされたマイグレーションは通常そのまま本番に適用される。手動適用は
CI が使えない例外時のみ（`.claude/rules/deployment.md` 参照）。

> ⚠️ **適用済み＝ファイル名が `d1_migrations` に記録済み**ということ。
> だからこそ既存ファイルのリネーム・削除は禁止（上記「⛔ 既存ファイルのリネーム・削除は禁止」）。
> かつてここには「034-054 は本番未適用」と書かれていたが、その後 CI 自動適用が入って
> 現況と乖離していた（2026-08-28 に実機確認して修正）。

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

> ルールの単一の情報源は `.claude/rules/migrations.md`。ここは経緯の記録に徹する。

**新規追加は出自（fork 独自 / upstream 取り込み）を問わず、常に「現在の最大番号 + 1」**を使う。
番号は推論せず、必ずスクリプトで取得する：

```bash
node packages/db/scripts/next-migration-number.mjs
# 次の採番: 819
```

upstream から取り込む場合は、先頭に出典コメントを入れる：

```sql
-- Ported from upstream Shudesu/line-harness-oss migration 046_xxx.sql
```

#### ⛔ 既存ファイルのリネーム・削除は禁止

適用済みファイルをリネームすると `d1_migrations`（ファイル名で記録）と食い違い、
再適用されて本番が壊れる。**番号の重複は衝突ではない**（009 / 018 / 043 が 2 本ずつ
存在し正常に動作している）。理由の詳細は `.claude/rules/migrations.md` を参照。

#### ⚠️ 番号帯から出自は判別できない

当初は「001〜799＝upstream 由来 / 800〜999＝fork 固有」と定めていたが、実態は違う。

| 番号帯 | 出自 |
|---|---|
| `001`〜`027` | fork 作成前から両方にある共通の祖先 |
| `028`〜`033` | **fork 固有**（`800`〜`805` に同内容の写しがある） |
| `034`〜`054` | **upstream 移植**（upstream の 028〜045） |
| `800`〜`815` | fork 固有 |
| `816`〜`818` | **upstream 移植**（upstream の 046 / 048 / 049） |

`001〜799` にも `800〜` にも両方の出自が混在している。
**出自はファイル先頭の `-- Ported from upstream ...` コメントの有無で判断すること。**

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

### `800`〜`805`（`028`〜`033` の参照用コピー）

| fork 番号 | 内容 |
|-----------|------|
| 800 | `business_hours`・`business_holidays` テーブル（旧 028） |
| 801 | `events`・`event_bookings` テーブル（旧 029） |
| 802 | Stripe 決済カラム（旧 030） |
| 803 | `events.price`（旧 031） |
| 804 | `event_bookings_v2` 再作成（旧 032） |
| 805 | 返金カラム（旧 033） |

> これらの内容は**先に `028`〜`033` として本番 D1 に適用済み**で、`800`〜`805` はその
> 参照用の写しとして後から追加したもの（`CREATE TABLE IF NOT EXISTS` なので再適用は無害）。
> 現在は `028`〜`033` と `800`〜`805` の**両方が `d1_migrations` に記録済み**で、
> `migrations list --remote` は `No migrations to apply!` を返す。
>
> ⛔ 重複しているからといって、**どちらのファイルも削除・リネームしてはいけない**。
> 削除すると新規インストールが再現できなくなり、リネームすると再適用される。
>
> なお `806` 以降も fork 固有だが、こちらは写しではなく通常のマイグレーション。

### スキップ済み

| upstream ファイル | 理由 |
|-----------------|------|
| `037_event_booking.sql` | fork の `events` テーブル（INTEGER PK / `title` 列）と upstream（TEXT PK / `name` 列）が非互換。インデックス作成が `line_account_id` 列不在で失敗する |

---

## 新しいマイグレーションを追加するとき

### チェックリスト

```
[ ] 番号は `node packages/db/scripts/next-migration-number.mjs` の出力（最大+1）を使った
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
