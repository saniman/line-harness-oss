# DBマイグレーションスキル

## 使い方
「テーブルを追加して」「カラムを追加して」と言われたら使う

## 手順
1. packages/db/schema.sql を更新
2. ローカルに適用:
   npx wrangler d1 execute line-harness --local --command="<SQL>"
3. リモートに適用:
   npx wrangler@latest d1 execute line-harness --remote --command="<SQL>"
4. 適用確認:
   npx wrangler@latest d1 execute line-harness --remote \
     --command="SELECT sql FROM sqlite_master WHERE name='<テーブル名>'"

## マイグレーションファイルを作る場合

上の手順は `d1 execute` で SQL を直接流すもので、`packages/db/migrations/` にファイルは残らない。
履歴として残す（＝新規インストールや他環境で再現する）場合は、番号を必ずスクリプトで取得する:

```bash
node "$(git rev-parse --show-toplevel)/packages/db/scripts/next-migration-number.mjs"
```

⛔ **既存のマイグレーションファイルはリネーム・リナンバ・削除しない**
（`d1_migrations` がファイル名で適用済みを記録しているため、再適用されて本番が壊れる）。
採番ルールの詳細は `.claude/rules/migrations.md` を参照。

## 注意
- wrangler 4.0.0 は Node.js v25 で FileHandle エラーが出る → npx wrangler@latest を使う
- ローカルとリモートの両方に必ず適用する
- ALTER TABLE で既存カラムは変更不可（SQLite制約）→ 新テーブル作成 + データ移行が必要
