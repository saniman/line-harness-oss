# AI 自己改善システム設計

> LINE Harness ハーネスが自分自身を改善し続けるための仕組み

---

## 概念

「AI 自己改善」とは、AI がタスクを実行するたびに得た知識を `.claude/` 設定へフィードバックし、
次回の自分がより賢く動けるようにすること。

```
タスク実行
    ↓
成功/失敗を観察
    ↓
パターンを抽出
    ↓
.claude/ に反映（rules / memory / agents / skills）
    ↓
次回タスクの品質向上
    ↓（ループ）
```

---

## 改善の 4 対象

```
.claude/
├── rules/          ← コーディング規約・落とし穴の蓄積
├── agents/         ← エージェント定義の精緻化
├── skills/         ← スキル手順の更新
└── memory/         ← プロジェクト文脈・フィードバックの更新
```

---

## メカニズム 1: Claude Code Hooks

hooks は `.claude/settings.json` の `hooks` セクションで設定し、
ハーネスが自動で呼び出すシェルコマンド。AI の「神経系」にあたる。

### 設計する hooks

#### A. `PostToolUse: Edit / Write` — コード変更後の自動チェック

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "cd /Users/akihisa/line-harness-oss && npx vitest run --reporter=verbose 2>&1 | tail -20"
          }
        ]
      }
    ]
  }
}
```

効果: コード変更のたびにテストを自動実行。失敗をすぐに Claude が検知できる。

#### B. `Stop` — セッション終了時の振り返り

セッション終了時に、このセッションで学んだことを memory に保存するよう Claude に促す。

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "echo '[HARNESS] セッション終了。重要な学びがあれば /Users/akihisa/.claude/projects/.../memory/ に保存してください。'"
          }
        ]
      }
    ]
  }
}
```

#### C. `PreToolUse: Bash` — 危険なコマンドの前置きチェック

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "echo '$CLAUDE_TOOL_INPUT' | grep -E 'rm -rf|DROP TABLE|--force|wrangler delete' && echo '[DANGER] 破壊的コマンドを検出。本当に実行しますか？' || true"
          }
        ]
      }
    ]
  }
}
```

---

## メカニズム 2: ルール自己更新サイクル

### トリガー条件

以下のパターンが発生したとき、rule-extractor エージェントを呼ぶ:

1. **修正が 2 回以上同じ箇所で必要だった**: git log で同一ファイルへの連続修正
2. **テストが CI で落ちた**: 症状と根本原因をルールに追加
3. **既知の落とし穴を踏んだ**: api-coding.md の「既知の落とし穴」セクションに追記

### ルール更新の書き方ガイドライン

```markdown
### [問題の概要]（YYYY-MM-DD 追記）

症状: （何が起きたか）
原因: （なぜ起きたか）

❌ 誤（アンチパターン）
```code
// 悪い例
```

✅ 正（解決策）
```code
// 良い例
```

対処: （具体的に何をすればよいか）
```

---

## メカニズム 3: スキル→エージェント昇格パターン

スキルは手順の記述。エージェントは判断の自律実行。

```
スキル（手順書）
  ↓ 同じスキルが 5 回以上呼ばれ、毎回判断が必要な場面が発生
エージェント化を検討
  ↓ エージェント定義を .claude/agents/ に追加
エージェント（自律判断）
```

### 昇格の判断基準

| スキル | 昇格するとき |
|--------|-------------|
| `/debug` | 問題の種類に応じて調査手順が分岐するようになったとき |
| `/deploy` | 環境（ステージング/本番）・対象（Worker/LIFF/Web）の組み合わせが増えたとき |
| `/migrate` | マイグレーションの安全性チェックが複雑になったとき |

---

## メカニズム 4: メモリ自動更新

### 保存すべき記憶の判断基準

| 記憶タイプ | 保存タイミング |
|-----------|--------------|
| `feedback` | 同じアドバイスを 2 回以上した | 
| `project` | 新機能フェーズが完了した |
| `user` | ユーザーの好みや作業スタイルの新しい側面を発見した |
| `reference` | 新しい外部リソースへのポインタが生まれた |

### 現在の memory と照合すべき項目（月 1 回）

```bash
# memory/ の全ファイルを確認
ls ~/.claude/projects/-Users-akihisa-line-harness-oss/memory/

# 各 memory が参照するコード・関数が現在も存在するか確認
# 例: "getValidAccessToken()" が memory に記録されている場合
grep -r "getValidAccessToken" /Users/akihisa/line-harness-oss/apps/worker/src/
```

---

## メカニズム 5: エージェント評価と改善

### 評価指標

各エージェント実行後に以下を記録:

```markdown
## エージェント実行ログ（人間が評価）

- エージェント名:
- タスク:
- 成功/失敗:
- 余分なアクションがあったか:
- 判断ミスがあったか:
- エージェント定義に追加すべき制約:
```

### 改善サイクル（月次レビュー）

1. `git log --grep="agent"` で agent 関連コミットを確認
2. 失敗したエージェント実行のパターンを特定
3. `.claude/agents/*.md` の「禁止事項」セクションに追記
4. 成功パターンは「手順」に反映

---

## 実装チェックリスト

### Phase 1 で追加すべき項目

- [ ] `settings.json` に `PostToolUse: Edit/Write` hook を追加（テスト自動実行）
- [ ] `settings.json` に `Stop` hook を追加（セッション振り返り促進）
- [ ] `memory/` に `feedback_agent_design.md` を作成（エージェント設計知見を蓄積）

### Phase 2 で追加すべき項目

- [ ] `tdd-agent` を定義・稼働（テスト自動化の核）
- [ ] `rule-extractor` をスキルとして定義（`/reflect` コマンド）
- [ ] `settings.json` に `PreToolUse: Bash` の危険コマンド検知を追加

### Phase 3 で追加すべき項目

- [ ] `memory-curator` エージェントを定義
- [ ] 月次レビュー用の Cron スケジュール設計
- [ ] エージェント評価ログのフォーマット標準化

---

## 安全性の考慮

### 自己改善の暴走を防ぐガードレール

1. **rules/ の変更は PR を通じて人間がレビュー**: 直接 commit push しない
2. **agents/ の変更は動作確認を必須**: 新エージェントはまずドライランで検証
3. **memory/ への書き込みは人間が承認**: 自動での memory 更新は「提案」にとどめる
4. **フィードバックループの可視性**: 何がどのルールを更新したかを git log で追跡可能にする

### 絶対に自動化しないこと

- 本番 LINE への broadcast 送信
- Stripe の refund 操作
- D1 の DROP TABLE
- wrangler secret の変更
- git push --force
