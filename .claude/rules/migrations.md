---
description: D1/SQLite マイグレーションの採番・適用・SQLite制約ルール（fork固有）
paths:
  - "packages/db/**"
  - "**/*.sql"
---
# マイグレーションルール（fork 固有・重要）

## 採番レンジ
- **001〜799**: upstream 由来のマイグレーション（変更・削除禁止）
- **800〜999**: この fork 固有のマイグレーション（business_hours, events, Stripe 等）

### 新しいマイグレーションを追加するとき
- fork 固有の機能追加 → **800番台**の未使用番号を使う（現在: 800-805 使用済み）
- upstream のマイグレーションを取り込む → fork の現在の最大番号 + 1 を使う

### なぜこのルールが必要か
2026-06-03 に upstream の 028-033 と fork の 028-033 が別内容で衝突した。
詳細な経緯・解消方法・設計乖離については `packages/db/MIGRATIONS.md` を参照。

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
