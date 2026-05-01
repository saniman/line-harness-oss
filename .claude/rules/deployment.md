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
