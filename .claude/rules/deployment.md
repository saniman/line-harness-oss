---
description: デプロイとgit pushのルール
globs: ""
---
# デプロイルール

## git push によるデプロイ

- デプロイは `git push origin main` で行う
- Cloudflare Pages は GitHub連携により自動デプロイされる
- pushの前に必ず `npx vitest run` でテストがグリーンであることを確認する
- コミットメッセージは conventional commits 形式（feat/fix/docs/test/chore）

## デプロイ対象とコマンド

| 対象 | 方法 |
|------|------|
| Worker API | `git push origin main` → CI が `pnpm deploy:worker` を実行 |
| 管理画面 (apps/web) | `git push origin main` → CI が自動ビルド・Pages デプロイ |
| LIFF (apps/worker/src/client) | `/deploy` スキルを参照（手動デプロイ必要） |

## 注意事項

- pushするとCIが自動でテスト → デプロイを実行する
- テストが失敗するとデプロイは実行されない
- ローカルで `npx vitest run` を通してからpushすること（Bunクラッシュ対策）
- Worker のローカルテストは `npx vitest run`（`pnpm --filter worker test` はBunクラッシュの恐れ）

---

## ⚠️ 二重デプロイ禁止

`git push origin main` を実行すれば GitHub Actions が自動でデプロイする。
以下のコマンドは CI/CD と重複するため、**絶対に手動実行してはいけない**：

- `npx wrangler pages deploy`（管理画面）← git push で自動実行される
- `npx wrangler deploy` / `pnpm deploy:worker`（Worker）← git push で自動実行される

### 正しいデプロイ手順

1. `npx vitest run` → 全テストグリーン確認
2. `git add` （対象ファイルを明示的に指定）
3. `git commit -m "..."`
4. `git push origin main`
5. GitHub Actions の完了を待つ（それだけ）

### 手動 wrangler コマンドを使って良いケース

- D1マイグレーション（`npx wrangler d1 execute ... --remote --file=...`）← CI に含まれないので手動 OK
- `wrangler secret put` の設定 ← これも手動 OK
- LIFF のデプロイ（`/deploy` スキル参照）← CI に含まれないので手動 OK
