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

## 注意
- wrangler 4.0.0 は Node.js v25 で FileHandle エラーが出る → npx wrangler@latest を使う
- ローカルとリモートの両方に必ず適用する
- ALTER TABLE で既存カラムは変更不可（SQLite制約）→ 新テーブル作成 + データ移行が必要
