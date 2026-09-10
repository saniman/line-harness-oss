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

## ローカルで緑・CI で赤（外部コマンドのバージョン差・2026-09-06 追記）

CI の git / node は**ローカルより新しい**。外部コマンドの「表示用の整形」に依存したコードは
ローカルだけ通って CI で落ちる。

実例: `git for-each-ref --format=%(refname:short)` が `refs/remotes/origin/HEAD` を
2.39 では `origin/HEAD`、新しい git では `origin` と出す（PR #77 で発生）。

書き方と、**この壊れ方を検出できる再現テストの作り方**は
`.claude/rules/api-coding.md` の「外部コマンドを叩くコードは…」を参照。

## ⚠️ Cron Triggers はアカウント単位で上限があり、超えると**無言で登録されない**（2026-09-10 インシデント）

症状: イベント当日リマインド（#67）が参加者に届かない。

調べたところ、**コードもデータも設定もすべて正しかった**。

| 確認項目 | 結果 |
|---|---|
| `events.reminder_at` の設定 | ✅ 12:00 JST |
| 対象の申込（確定・未送信・友だち連携・フォロー中） | ✅ 6件 |
| 配信対象を取る SQL を**本番でそのまま実行** | ✅ 6行返る |
| 時間窓の判定を実値で再現 | ✅ `due = true` |
| `scheduled()` の配線・`export default` | ✅ 正しい |
| `wrangler.toml` の cron 式とコードのガードの一致 | ✅ 一致 |
| デプロイ済みか | ✅ 含まれている |
| **`wrangler tail` で5分以上（tick を跨いで）張る** | ❌ **scheduled が1件も出ない** |

ダッシュボード（Workers & Pages → 対象 Worker → Settings → Triggers）を見たら
**Cron Triggers が1本も登録されていなかった**。

### 原因: `wrangler deploy` は Cron Triggers を同期していなかった

当初「無料プランのアカウント上限（5本）に当たった」と考えたが、**違った**。
Cloudflare API で実際に問い合わせたところ:

```
line-harness      3本（0 23 * * SUN / 0 23 * * WED / 0 */6 * * *）
shiny-wind-43b1   0本
────────────────────────────
アカウント合計    3本   ← 上限には当たっていない。枠は空いていた
```

`wrangler.toml` には**4本**書いてあるのに、本番には**3本**しか無かった。
しかも3本の作成日は 2026-06-06 / 06-06 / 06-16 で、**その後の何十回ものデプロイで
一度も更新されていない**。`*/5 * * * *` だけが欠けた状態が数ヶ月続いていた。

> ⚠️ **`wrangler.toml` に書いてある ≠ 本番に登録されている。**
> デプロイは成功する。CI は緑。コードは正しい。データも条件を満たす。
> なのに何も動かない。誰も気づけない類の失敗で、今回は
> **イベント当日に参加者へ案内が届かない**形で表面化した。

復旧は API で4本を明示的に登録して行った（登録の1分後に配信された）。

```bash
TOKEN=$(grep '^oauth_token' ~/.wrangler/config/default.toml | sed 's/.*= *"//; s/"$//')
ACCT=<account_id>   # apps/worker/dist/line_harness/wrangler.json の account_id
# ⚠️ このエンドポイントは一覧を**丸ごと置き換える**。必ず全部を送る
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data '[{"cron":"*/5 * * * *"},{"cron":"0 */6 * * *"},{"cron":"0 23 * * SUN"},{"cron":"0 23 * * WED"}]' \
  "https://api.cloudflare.com/client/v4/accounts/$ACCT/workers/scripts/line-harness/schedules"

# 確認（GET すると現在の登録が見える）
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCT/workers/scripts/line-harness/schedules"
```

### 対処

- **cron 式を増やさない設計にする。** `scheduled()` は既に `cronExpr` で分岐しているので、
  1本（`*/5 * * * *`）に寄せて中で時刻判定すれば本数は増えない。
  本数を増やすほど上限に当たりやすく、かつ
  「`*/5` と `0 */6` が 00:00/06:00/12:00/18:00 UTC で同時発火する」二重実行の罠も増える
- cron を**追加・変更したときは、上の GET で本番の登録を確認する**。
  `wrangler.toml` を直しただけ・デプロイしただけでは反映されていないことがある
- ⚠️ **次のデプロイで消えないか、デプロイ後にもう一度 GET で確認する**
  （今回 API で入れた `*/5` が、次の `wrangler deploy` で失われないかは未検証）
- 上限に当たったら、他の Worker の不要な cron を消すか、統合する

### 同じ症状（「cron で動くはずの処理が動かない」）が出たときの切り分け手順

**コードを疑う前に、発火しているかを先に確かめる。** 今回はコードを疑って時間を使った。

```bash
# ① データが条件を満たすか（配信対象を取る SQL を本番でそのまま実行する）
npx wrangler d1 execute line-harness --remote --json --command="<DUE_SQL>"

# ② tick を跨いで tail を張る（5分毎なら5分以上）。
#    ⚠️ Worker 名の指定が要る。省略すると "Required Worker name missing" で何も出ない
npx wrangler tail line-harness --format pretty
```

- **scheduled が1件も出ない** → cron が発火していない＝**登録側の問題**。
  上の GET で本番の登録一覧を見る（ダッシュボードより確実で速い）
- **出るが処理が走っていない** → `scheduled()` 内の分岐かサービス側の問題

⚠️ `scheduled()` は `Promise.allSettled(jobs)` で例外を握るので、
1つのジョブが投げても他は動き、**ログにしか出ない**。tail か Workers Logs で見る。

