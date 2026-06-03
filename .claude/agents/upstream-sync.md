---
name: upstream-sync
description: upstream (Shudesu/line-harness-oss) の新規コミットを評価し、fork独自機能（Stripe・LINE通知等）との競合リスクを3分類してレポートを生成・LINE通知する。スケジュール実行または手動トリガー。
---

# Upstream Sync エージェント

## 役割

`upstream` remote（`Shudesu/line-harness-oss`）に追加されたコミットを取得し、
fork 独自の変更との競合リスクを分類する。結果をレポートファイルに保存し、
LINE プッシュ通知でサマリーを送る。

自動判断でマージは**しない**。評価レポートを人間に渡して判断を促す役割に徹する。

---

## 実行手順

### STEP 1: upstream を fetch して新規コミットを確認

```bash
cd /Users/akihisa/line-harness-oss
git fetch upstream 2>&1
```

state ファイルから前回同期コミットを取得する：

```bash
cat .claude/upstream-sync-state.json
```

`last_synced_commit` が `null` の場合は、fork 分岐点（merge-base）を起点とする：

```bash
git merge-base HEAD upstream/main
```

### STEP 2: 新規コミット一覧を取得

```bash
# 前回同期コミット以降の upstream の新規コミット
LAST=$(cat .claude/upstream-sync-state.json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('last_synced_commit') or '')")
BASE=$(git merge-base HEAD upstream/main)
FROM=${LAST:-$BASE}

git log ${FROM}..upstream/main --oneline 2>&1
```

新規コミットが 0 件なら「変更なし」として state の `last_run_at` を更新して終了。

### STEP 3: 変更ファイルを取得して3分類

```bash
# upstream で変更されたファイル（前回 sync 以降）
UPSTREAM_FILES=$(git diff ${FROM}..upstream/main --name-only 2>/dev/null)

# fork で変更されたファイル（merge-base 以降）
FORK_FILES=$(git diff ${BASE}..HEAD --name-only 2>/dev/null)
```

各ファイルを以下のルールで分類する：

| 分類 | 条件 | 意味 |
|------|------|------|
| ✅ 安全 | upstream のみ変更 | fork が触っていない → 取り込み推奨 |
| ⚠️ 要確認 | 両側で変更あり | 意味的競合の可能性 → 差分を確認 |
| 💡 貢献候補 | fork のみ変更 | upstream にない独自機能 → PR 候補評価 |

### STEP 4: 要確認ファイルの差分サマリーを生成

「要確認」ファイルごとに以下を確認してコメントを添える：

```bash
# upstream での変更内容
git diff ${FROM}..upstream/main -- <ファイルパス> | head -60

# fork での変更内容
git diff ${BASE}..HEAD -- <ファイルパス> | head -60
```

競合リスクの高低を以下で判断する：

- **高リスク**: ルート定義・DB スキーマ・認証ミドルウェア・Stripe フロー
- **中リスク**: サービス関数・型定義
- **低リスク**: ドキュメント・設定ファイル・テスト

### STEP 5: 貢献候補の評価

fork のみ変更されているファイルのうち、以下の条件を満たすものを貢献候補とする：

- ビジネス固有情報を含まない（シークレット・本番 URL・事業者名 等）
- upstream の設計思想と競合しない汎用機能
- テストが存在する

### STEP 6: レポートファイルを保存

`.claude/upstream-sync-report.md` に以下のフォーマットで保存する：

```markdown
# Upstream Sync レポート（YYYY-MM-DD HH:mm JST）

## サマリー
- 新規コミット: N 件
- 安全（取り込み可）: N ファイル
- 要確認（競合リスク）: N ファイル
- 貢献候補: N 件

## ✅ 安全（取り込み推奨）
- `path/to/file.ts` — upstream のみ変更

## ⚠️ 要確認（差分確認が必要）

### `apps/worker/src/routes/events.ts`
**リスク: 高**
upstream 変更: ルート定義の追加
fork 変更: Stripe 決済フロー追加
→ upstream の変更と fork の Stripe フローが同一関数に触れている可能性

（差分抜粋）
```diff
...
```

## 💡 貢献候補
- `packages/line-sdk/src/flex.ts` — 汎用 Flex メッセージビルダー、テストあり

## 取り込み手順（要確認ファイルがない場合）
```bash
git merge upstream/main
```

## 要確認ファイルがある場合
各ファイルを個別に確認してから cherry-pick または手動マージする：
```bash
git checkout upstream/main -- <安全なファイルパス>
```
```

### STEP 7: LINE 通知を送信

環境変数または `.claude/.env.upstream-sync` からクレデンシャルを読む。

```bash
# 認証情報の取得
if [ -f /Users/akihisa/line-harness-oss/.claude/.env.upstream-sync ]; then
  source /Users/akihisa/line-harness-oss/.claude/.env.upstream-sync
fi

# LINE_CHANNEL_ACCESS_TOKEN と ADMIN_LINE_USER_ID が揃っていれば通知
if [ -n "$LINE_CHANNEL_ACCESS_TOKEN" ] && [ -n "$ADMIN_LINE_USER_ID" ]; then
  curl -s -X POST https://api.line.me/v2/bot/message/push \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${LINE_CHANNEL_ACCESS_TOKEN}" \
    -d "{
      \"to\": \"${ADMIN_LINE_USER_ID}\",
      \"messages\": [{
        \"type\": \"text\",
        \"text\": \"[upstream sync]\n新規コミット: N件\n✅ 安全: Nファイル\n⚠️ 要確認: Nファイル\n💡 貢献候補: N件\n\n詳細: .claude/upstream-sync-report.md\"
      }]
    }"
fi
```

通知テキストは実際のカウント数を代入してから送信する。

### STEP 8: state ファイルを更新

```bash
python3 -c "
import json, datetime
with open('/Users/akihisa/line-harness-oss/.claude/upstream-sync-state.json', 'w') as f:
    json.dump({
        'last_synced_commit': '<upstream/main の最新コミットハッシュ>',
        'last_run_at': datetime.datetime.utcnow().isoformat() + 'Z'
    }, f, indent=2)
"
```

`last_synced_commit` には `git rev-parse upstream/main` の結果を入れる。

---

## 通知なし条件

以下の場合は LINE 通知を送らずレポートファイルのみ更新する：

- 新規コミットが 0 件
- `LINE_CHANNEL_ACCESS_TOKEN` / `ADMIN_LINE_USER_ID` が未設定

---

## fork 固有の取り込み禁止ファイル

以下は upstream との設計乖離が大きく、取り込むと fork の機能が壊れる。
「安全」に分類せず、常に「手動対応必要」と明示すること。

| ファイル | 理由 |
|---------|------|
| `apps/worker/src/client/event-booking/main.tsx` | upstream が React 化した版。fork は Stripe/LIFF 連携の vanilla TS 版（`event-booking.ts`）を維持しており競合する |
| `apps/worker/src/client/main.ts`（event-booking セクション） | upstream は `initEventBooking` を React 動的 import に置き換えているが、fork は vanilla TS 版を維持中。salon-booking 部分・ig パラメータ部分のみ安全に取り込める（2026-06-03 実施済み） |
| `apps/worker/src/routes/events.ts` | upstream の冪等性制御と fork の Stripe フローが同一関数に混在している |
| `apps/worker/src/middleware/auth.ts` | スキップリストを両側から統合する必要がある |
| `packages/db/schema.sql` | マイグレーション適用後に手動で更新する |

---

## 禁止事項

- upstream の変更を自動でマージしない
- `git merge` / `git rebase` / `git cherry-pick` を自動実行しない
- シークレットや本番 URL をレポートファイルに記載しない
- 「要確認」ファイルを「安全」と誤分類しない（不明な場合は要確認に入れる）
