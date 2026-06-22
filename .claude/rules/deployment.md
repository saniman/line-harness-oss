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
| Worker API | `git push origin main` → CI が自動デプロイ（deploy-worker.yml） |
| 管理画面 (apps/web) | `git push origin main` → CI が自動ビルド・Pages デプロイ（deploy-web.yml） |
| LIFF (apps/worker/src/client) | `git push origin main` → CI が自動デプロイ（deploy-liff.yml）。`/deploy` は CI が使えない時のみ |

> ⚠️ **LIFF も push で自動デプロイされる**（2026-06-22 訂正）。
> `deploy-liff.yml` が `apps/worker/src/client/**` / `apps/worker/vite.config.*` / `packages/**` の
> 変更で発火する。`/deploy` スキル（手動 `wrangler pages deploy`）を push 後に併用すると**二重デプロイ**になる。
> 手動 LIFF デプロイは「CI が落ちている / 緊急で即反映したい」等の例外時のみ使う。

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
2. `npx tsc --noEmit` → 型エラーなしを確認（vitest は型チェックをしないため必須）
3. `git add` （対象ファイルを明示的に指定）
4. `git commit -m "..."`
5. `git push origin main`
6. GitHub Actions の完了を待つ（それだけ）

> **vitest がパス ≠ TypeScript が正しい**
> vitest はランタイムテストのみ実行し、型エラーは無視する。
> CI は tsc を別途実行するため、ローカルで通っても CI で落ちることがある。

### ⚠️ LIFF デプロイ前チェックリスト（2026-06-08 追記）

LIFF を新規リリースまたは本番初公開するときは必ず確認する：

- [ ] **LINE Login チャンネルが Published** か確認する
  → LINE Developers Console → LINE Login チャンネル → Publishing タブ
  → Developing のまま公開すると一般ユーザー全員が 400 エラーになる
- [ ] **非開発者アカウント**（開発者ロールなし）でエンドツーエンドを通す
  → 開発者は Developing 状態でも通れるため、開発者テストだけでは発覚しない

### 手動 wrangler コマンドを使って良いケース

- D1マイグレーション（`npx wrangler d1 execute ... --remote --file=...`）← deploy-worker.yml に
  自動適用ステップがあるが、トークンに D1 権限が無い等で手動が必要なケースは下記参照
- `wrangler secret put` の設定 ← これも手動 OK
- LIFF のデプロイ ← **通常は push で自動**（deploy-liff.yml）。`/deploy` は CI が使えない例外時のみ

---

## CI で D1 マイグレーションを自動適用する（2026-06-22 追記）

`deploy-worker.yml` は deploy の**前**に `npx wrangler@latest d1 migrations apply line-harness --remote`
を実行する（migrate→deploy の順で、新コードが旧スキーマに当たる事故を防ぐ）。
pending が無ければ no-op。

### ⚠️ `CLOUDFLARE_API_TOKEN` に D1:Edit 権限が必須

症状: Worker デプロイが migrate ステップで失敗する。
```
✘ A request to the Cloudflare API (/accounts/.../d1/database/.../query) failed.
  The given account is not valid or is not authorized to access this service [code: 7403]
```
原因: トークンが Workers 専用で **D1 権限を持たない**。migrate は deploy の前にあるため、
ここで落ちると **Worker デプロイ自体がブロックされる**（pending ゼロでも確認クエリで 7403）。

✅ 対処: Cloudflare → My Profile → API Tokens → 該当トークンに **Account → D1 → Edit** を追加。
権限追加だけならトークン値は変わらないので **GitHub Secrets の更新は不要**。
付与後に `gh run rerun <run_id> -R saniman/line-harness-oss` で再実行する。

---

## fork での CI 状態確認（gh CLI の注意・2026-06-22 追記）

このリポジトリは upstream(Shudesu) remote を持つため、`gh` のデフォルト解決がズレる。

- `gh run view <id>` は **upstream を見て 404** になる → **必ず `-R saniman/line-harness-oss`** を付ける
- `gh run list` は表示がキャッシュで古い（過去 push が出て最新が出ない）ことがある
  → 最新は `gh api "repos/saniman/line-harness-oss/actions/runs?head_sha=<sha>" --jq '.workflow_runs[] | "\(.conclusion)\t\(.name)"'`
- 完了待ちは `gh run watch <id> -R saniman/line-harness-oss --exit-status --interval 15`
- 失敗ログは `gh run view <id> -R saniman/line-harness-oss --log-failed`

push（main）で発火するワークフロー: **Test / Deploy Worker / Deploy Web / Deploy LIFF**（各 path filter 依存）。
