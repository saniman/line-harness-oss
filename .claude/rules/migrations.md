---
description: D1/SQLite マイグレーションの採番・適用・SQLite制約ルール（fork固有）
paths:
  - "packages/db/**"
  - "**/*.sql"
---
# マイグレーションルール（fork 固有・重要）

## ⛔ 既存のマイグレーションファイルをリネーム・削除しない（最重要）

**適用済みのマイグレーションファイルは、いかなる理由があってもリネーム・リナンバ・削除しない。**

理由: D1 は適用済みマイグレーションを `d1_migrations` テーブルに**ファイル名で**記録する。
さらに `deploy-worker.yml` が deploy の前に `d1 migrations apply --remote` を自動実行する。
適用済みファイルをリネームすると wrangler は「未適用の新規マイグレーション」と判断して**再実行**し、
`ALTER TABLE ... ADD COLUMN` は `duplicate column name` で落ちるか、中途半端に適用される。

### 番号の重複は「衝突」ではない

fork には既に **009 / 018 / 043 が 2 本ずつ**存在し、本番で正常に動作している。

```
009_delivery_type.sql    009_token_expiry.sql
018_broadcast_queue.sql  018_message_templates.sql
043_scenario_delivery_mode.sql  043_z_schema_gaps.sql
```

ファイル名が違えば `d1_migrations` 上は**別レコード**であり、適用順もファイル名のソート順で決定的。
番号が重なっていること自体は何の問題も起こさない。**これを「衝突」「要対処」と判断しないこと。**

> 2026-08-17 の upstream sync レポートが、この誤解から「fork の 050〜054 を 070番台に
> リナンバせよ」を CRITICAL として提案した。実行していれば本番 D1 が壊れていた（Issue #32）。

## 採番レンジ

新しいマイグレーションを追加するときは、**出自（fork 独自 / upstream 取り込み）を問わず
常に「現在の最大番号 + 1」**を使う。

番号は推論せず、必ずスクリプトで取得する（ハードコードした番号はすぐ陳腐化する）:

```bash
node packages/db/scripts/next-migration-number.mjs
# 次の採番: 819
# 現在の最大: 818 (818_tracked_links_short_code.sql)
# 番号の重複（正常・対処不要）: 009, 018, 043
```

upstream のファイルを取り込む場合は、先頭に出典コメントを入れる:

```sql
-- Ported from upstream Shudesu/line-harness-oss migration 046_xxx.sql
```

### 番号帯の由来（歴史。今後の採番判断には使わない）

- **001〜799**: 2026-06-03 の衝突解消時点で upstream 由来だったもの
- **800〜**: それ以降に追加したもの（fork 独自機能・upstream からの移植の両方を含む）

2026-06-03 に upstream の 028-033 と fork の 028-033 が別内容で衝突したため、
upstream の 028-045 を fork の 034-054 に移植して解消した。その後の追加（800番台）は
fork 独自機能・upstream 移植（816-818 は upstream 046/048/049）が混在しており、
**番号帯から出自は判別できない**。出自はファイル先頭の出典コメントで判断すること。

詳細な経緯・設計乖離については `packages/db/MIGRATIONS.md` を参照。

## マイグレーションの適用コマンド

```bash
# 未適用の確認（apps/worker から実行）
npx wrangler@latest d1 migrations list line-harness --remote

# 適用
npx wrangler@latest d1 migrations apply line-harness --remote
```

wrangler 4.0.0 には `d1 execute --file` で相対パスを使うバグがあるため、
`npx wrangler@latest`（4.97.0+）を使うこと。

## schema.sql との同期
マイグレーション適用後は必ず `packages/db/schema.sql` も更新する。
schema.sql は新規インストール用の正規ソース（マイグレーションファイルと乖離すると新規セットアップ不可）。

## 必須ルール
- DBスキーマを変更したら必ずローカル・リモート両方にマイグレーション実行する。
- リモート適用（`--remote`）は共有リソースへの操作。並列レーンでは走らせない・実行可否は人間に確認する。

## SQLite ALTER TABLE 制約
CHECK 制約は ALTER TABLE で変更不可。既存の CHECK 制約を変えたい場合はテーブル再作成が必要：
  1. 新テーブル作成（v2）
  2. INSERT INTO v2 SELECT * FROM 旧テーブル
  3. DROP TABLE 旧テーブル
  4. ALTER TABLE v2 RENAME TO 旧テーブル名

> テーブル再作成の詳細な注意（実DDLをカラム順まで確認する・`SELECT *` を使わない・enum廃止はCHECKを触らない等）は
> `.claude/rules/api-coding.md` の D1操作セクションを参照（worker src を触ると自動ロード）。
