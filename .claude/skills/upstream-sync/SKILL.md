# upstream-sync スキル

## 使い方

upstream（`Shudesu/line-harness-oss`）の新規コミットを評価し、
fork 独自機能との競合リスクを分類してレポートを生成する。

```
「/upstream-sync」          → 即時実行
「/upstream-sync --dry-run」→ 通知なし・レポートのみ
```

スケジュール設定（週次自動実行）は後述の「初回セットアップ」を参照。

---

## 実行手順

### STEP 1: upstream-sync エージェントを呼ぶ

`upstream-sync` エージェントに以下を依頼する：

```
upstream-sync エージェントとして動いてください。
.claude/upstream-sync-state.json を読んで前回同期コミットを確認し、
upstream/main の新規コミットを評価してレポートを生成してください。
```

エージェントが以下を実行する：
1. `git fetch upstream`
2. 前回同期コミット以降の変更を取得
3. ファイルを3分類（安全 / 要確認 / 貢献候補）
4. `.claude/upstream-sync-report.md` にレポートを保存
5. LINE push 通知を送信（認証情報が設定済みの場合）
6. `.claude/upstream-sync-state.json` を更新

### STEP 2: レポートを確認

```bash
cat /Users/akihisa/line-harness-oss/.claude/upstream-sync-report.md
```

### STEP 3: 取り込み作業（人間が判断する）

**安全ファイルの取り込み：**
```bash
cd /Users/akihisa/line-harness-oss
git checkout upstream/main -- <ファイルパス>
```

**要確認ファイルの対応：**
各ファイルのレポート差分を読んで、手動でマージする。
競合が複雑な場合は `migration-planner` または `event-manager` エージェントに相談。

**貢献候補の PR 送付：**
OSS-SYNC-CHARTER.md のセクション 6「外部 PR の受け入れ基準」を参照して PR を送る。

---

## 初回セットアップ

### LINE 通知認証情報の設定

`.claude/.env.upstream-sync` を作成する（gitignore 済み）：

```bash
cat > /Users/akihisa/line-harness-oss/.claude/.env.upstream-sync << 'EOF'
LINE_CHANNEL_ACCESS_TOKEN=<本番チャネルアクセストークン>
ADMIN_LINE_USER_ID=<管理者のLINEユーザーID>
EOF
```

トークンは Cloudflare Workers の wrangler secret と同じ値。
`wrangler secret list` で設定済みキー名を確認できるが値は取得不可なので、
LINE Developers コンソールから再取得すること。

### スケジュール設定（週次・月曜 9:00 JST）

`/schedule` スキルを呼んで以下を設定する：

```
毎週月曜日の朝9時（JST）に /upstream-sync を自動実行するスケジュールを作成してください。
```

手動で確認したい場合は `cron: "0 0 * * 1"` (UTC) で設定する。

---

## 状態管理ファイル

| ファイル | 役割 |
|---------|------|
| `.claude/upstream-sync-state.json` | 最終同期コミットハッシュ・最終実行日時 |
| `.claude/upstream-sync-report.md` | 最新のレポート（毎回上書き） |
| `.claude/.env.upstream-sync` | LINE 認証情報（git 管理外） |

---

## 注意事項

- エージェントは**評価のみ**行い、マージは実行しない
- `.env.upstream-sync` をコミットしない（`.gitignore` に追加済み）
- `要確認` ファイルは必ず人間が差分を確認してから取り込む
- OSS-SYNC-CHARTER.md のチェックリストも合わせて確認すること
