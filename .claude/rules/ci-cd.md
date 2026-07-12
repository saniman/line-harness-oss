---
description: CI/CD（GitHub Actions）の既知の問題と対処。ワークフロー編集時にロード
paths:
  - ".github/workflows/**"
---
# CI/CD ルールと既知の問題

## 基本ルール
- main への push 前に `pnpm --filter worker test`（CI）/ ローカルは `npx vitest run` でパス確認する。
- CI が赤い状態での push は禁止。

## Node.js 20 アクションの非互換問題（2026-05-15 対応済み）
GitHub のランナーが Node.js 24 に移行中のため、Node.js 20 ランタイムで動作する
GitHub Actions が CI で失敗する。対象アクション:
- `cloudflare/wrangler-action@v3` → `pnpm exec wrangler` の run ステップで代替
- `pnpm/action-setup@v4` → `corepack enable pnpm` の run ステップで代替

→ **原則**: アクション (uses:) は Node.js バージョン依存するため、
  代わりに `run:` ステップで直接コマンドを実行する。
→ **deploy-liff.yml も注意**: wrangler-action@v3 が残っていたため同様に修正が必要。

## wrangler 4系での破壊的変更
- `wrangler pages deploy` に `--account-id` フラグは存在しない
  → `CLOUDFLARE_ACCOUNT_ID` 環境変数で渡す
- `pnpm --filter worker exec wrangler` はワーキングディレクトリが `apps/worker` になる
  → Pages deploy の出力パスは `../web/out`（リポジトリルートからの `apps/web/out` ではない）
- GitHub Secrets の `CLOUDFLARE_ACCOUNT_ID` が未設定だと空文字列になり
  `wrangler.toml` の `account_id` を上書きしてしまう
  → 対処: deploy-worker.yml では env に渡さない、deploy-web.yml では値をハードコード

## Cloudflare Pages API が日本語コミットメッセージを拒否する問題（2026-05-19 対応済み）
`wrangler pages deploy` はデフォルトで git のコミットメッセージを Cloudflare Pages API に送信するが、
日本語などの非ASCII文字を含むと API 側が
`Invalid commit message, it must be a valid UTF-8 string [code: 8000111]` で拒否する
（日本語は有効な UTF-8 だが Cloudflare 側のバグ）。

→ **対処**: `--commit-message` に ASCII のみのコミットハッシュを渡して上書きする
```yaml
run: |
  COMMIT_HASH=$(git log -1 --format=%H)
  pnpm exec wrangler pages deploy ./dist/client \
    --project-name=line-harness-liff \
    --commit-message="$COMMIT_HASH"
```
→ `deploy-liff.yml` に適用済み。他の Pages デプロイでも同様に対処すること。
`LC_ALL: C.UTF-8` 環境変数では解決しない（API 側の問題のため）。

> D1 マイグレーションの CI 自動適用・トークン権限（D1:Edit 必須）・fork での `gh` の `-R` 注意は
> `.claude/rules/deployment.md`（常時ロード）を参照。
