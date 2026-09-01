# DBマイグレーションスキル

## 使い方
「テーブルを追加して」「カラムを追加して」と言われたら使う

## 原則：スキーマ変更は必ずマイグレーションファイルにする

`d1 execute --command` で SQL を直接流すと、変更が `d1_migrations` に記録されない。
そうすると **CI の自動適用（`deploy-worker.yml` が deploy 前に `migrations apply --remote` を実行）に
乗らず、ローカル・他環境・新規インストールで再現できない**。本番とリポジトリの状態が静かに乖離する。

→ **スキーマを変えるときは必ず番号付きのマイグレーションファイルを作る。**
`d1 execute` は確認用の読み取り（`SELECT`）にだけ使う。

## 手順

### 1. 採番する（推論・ハードコードしない）

```bash
node "$(git rev-parse --show-toplevel)/packages/db/scripts/next-migration-number.mjs"
# 次の採番: 819
```

### 2. マイグレーションファイルを作る

```
packages/db/migrations/819_<snake_case_description>.sql
```

先頭に変更内容をコメントで書く。upstream から取り込んだ場合は出典も入れる。

### 3. `packages/db/schema.sql` を同期する

新規インストール用の正規ソース。マイグレーションと乖離すると新規セットアップが壊れる。

### 4. ローカルに適用して確認する

```bash
npx wrangler@latest d1 migrations apply line-harness --local
npx wrangler@latest d1 execute line-harness --local \
  --command="SELECT sql FROM sqlite_master WHERE name='<テーブル名>'"
```

### 5. 本番への適用

**通常は手動適用しない。** `main` にマージすれば `deploy-worker.yml` が deploy の前に
`d1 migrations apply --remote` を自動実行する。

CI が使えない等で手動適用が必要な場合のみ、**人間に可否を確認してから**実行する
（`--remote` は共有リソースへの操作。並列レーンでは走らせない）:

```bash
npx wrangler@latest d1 migrations list line-harness --remote   # 未適用の確認（読み取り）
npx wrangler@latest d1 migrations apply line-harness --remote  # 適用
```

## ⛔ 既存のマイグレーションファイルはリネーム・リナンバ・削除しない

`d1_migrations` がファイル名で適用済みを記録しているため、リネームすると
「未適用の新規ファイル」と判定されて**再適用され、本番が壊れる**。

例外は「まだ一度も適用もマージもされていない自分のファイル」だけ
（worktree 並列レーンで番号が衝突したときの直し方は `.claude/rules/migrations.md` 参照）。

## 注意
- wrangler 4.0.0 は Node.js v25 で FileHandle エラーが出る → `npx wrangler@latest` を使う
- ALTER TABLE で既存カラムは変更不可（SQLite制約）→ 新テーブル作成 + データ移行が必要。
  テーブル再作成は `migration-planner` エージェントに任せ、必ず実 DDL
  （`SELECT sql FROM sqlite_master`）を確認してから書く
- 採番ルール・出自・リネーム禁止の詳細は `.claude/rules/migrations.md`（単一の情報源）
