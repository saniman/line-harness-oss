# AI アーキテクチャ実装ロードマップ

---

## フェーズ概要

```
Phase 1 (今すぐ)    → フック基盤と TDD エージェント
Phase 2 (〜1 week)  → ドメイン専門エージェント群
Phase 3 (〜2 week)  → 開発支援エージェント
Phase 4 (〜1 month) → 自己改善ループの自動化
Phase 5 (継続)      → エージェント評価と精緻化
```

---

## Phase 1: フック基盤と TDD エージェント（高 ROI・即日開始可）

### 目標

- テスト自動実行フックを設置してコード品質の底上げ
- TDD エージェントを追加して Red-Green-Refactor を自律実行

### タスク

#### 1-1. `settings.json` にフックを追加

**変更先**: `.claude/settings.json`

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "cd /Users/akihisa/line-harness-oss/apps/worker && npx vitest run --reporter=dot 2>&1 | tail -5"
          }
        ]
      }
    ]
  }
}
```

**期待効果**: コード変更のたびにテスト結果が context に流れ込み、赤を即検知できる

#### 1-2. `tdd-agent` を `.claude/agents/` に追加

`agents/` に `tdd-agent.md` を作成（詳細は agents.md 参照）

#### 1-3. memory に設計知見を記録

`memory/feedback_agent_design.md` を作成し、今後のエージェント改善の出発点とする

### 完了条件

- [ ] `settings.json` のフックが動作している（Edit 後にテスト結果が表示される）
- [ ] `tdd-agent` が起動して Red テストを書ける
- [ ] memory に初期エントリが作成されている

---

## Phase 2: ドメイン専門エージェント群（〜1 week）

### 目標

LINE Harness の主要ドメインをカバーするエージェントを配置

### タスク

#### 2-1. `event-manager` エージェント

担当: イベント作成・Stripe 決済・参加者管理  
理由: 現在最も複雑なフロー（SP6 相当）。手順書が長大なためエージェント化の恩恵が大きい

**作成ファイル**: `.claude/agents/event-manager.md`

**コアロジック**（agents.md の「event-manager」セクション参照）:
- price 判定による有料/無料フロー分岐
- participant_count は confirmed のみカウント
- JST フォーマット強制

#### 2-2. `crm-analyst` エージェント

担当: 友だち・コンバージョン分析  
理由: D1 クエリの知識が必要で毎回調べている

**作成ファイル**: `.claude/agents/crm-analyst.md`

#### 2-3. 既存スキルの強化

`/debug` スキルに Google Calendar 再認証の手順を追記（現在 debug エージェントにあるが skills にはない）

### 完了条件

- [ ] `event-manager` が「イベントを作成して」に対して適切なクエリを実行できる
- [ ] `crm-analyst` が「先週の配信効果を教えて」に対してレポートを返せる
- [ ] `/debug` スキルで Google Calendar 再認証まで完結できる

---

## Phase 3: 開発支援エージェント（〜2 week）

### 目標

コード品質・セキュリティ・マイグレーション安全性を AI が担保

### タスク

#### 3-1. `security-auditor` エージェント

担当: 新ルート追加時のセキュリティチェック  
トリガー: `routes/` 以下に新ファイル追加時

チェック項目:
- authMiddleware スキップリスト漏れ
- SQL インジェクション（パラメータバインド未使用）
- XSS（テンプレートリテラルへの直接埋め込み）
- Stripe webhook 署名検証の存在

#### 3-2. `migration-planner` エージェント

担当: スキーマ変更の安全計画  
既存の `/migrate` スキルをエージェント化

追加する判断ロジック:
- CHECK 制約変更の自動検出 → テーブル再作成フローへの自動分岐
- ローカル/リモート両方への適用確認

#### 3-3. `/reflect` スキルの追加

セッション終了時に呼ぶ振り返りスキル  
`rule-extractor` エージェントの軽量版として実装

```markdown
# SKILL.md

## 使い方
セッション終了時に「/reflect」と呼ぶ

## 手順
1. git log --oneline -10 で今日の変更を確認
2. 修正が必要だったパターンを特定
3. .claude/rules/ の既存ルールを確認
4. 新パターンがあれば rules/ に追記案を提示
5. memory/ のフィードバックエントリを更新
```

### 完了条件

- [ ] `security-auditor` が新ルートのスキップリスト漏れを検出できる
- [ ] `migration-planner` が CHECK 制約変更を検出してテーブル再作成フローを提案できる
- [ ] `/reflect` スキルが rules/ への追記案を生成できる

---

## Phase 4: 自己改善ループの自動化（〜1 month）

### 目標

学習フィードバックループを半自動化。人間の介入を「承認」だけにする。

### タスク

#### 4-1. `memory-curator` エージェントの実装

月次で `memory/` の整合性チェックを実行するエージェント

#### 4-2. エージェント評価ログの導入

各エージェント実行後に評価コメントを残すフォーマットを定義し、
`.claude/agents/<name>.md` の「改善履歴」セクションに蓄積

#### 4-3. `rule-extractor` エージェントの実装

CI 失敗ログ → 根本原因分析 → rules/ 更新案の生成を自動化

**依存**: Phase 3 の `/reflect` スキルが安定稼働していること

#### 4-4. Cron スケジュールの設計

`/schedule` スキルを使って月次レビューをスケジュール

### 完了条件

- [ ] `memory-curator` が古いエントリを検出できる
- [ ] `rule-extractor` が CI 失敗から rules/ 更新案を生成できる
- [ ] 自己改善サイクルが 1 ヶ月以上継続している

---

## Phase 5: 評価と精緻化（継続）

### KPI

| 指標 | 計測方法 | 目標 |
|------|----------|------|
| CI 失敗率 | GitHub Actions の成功率 | 95% 以上 |
| 同一バグの再発率 | git log で同一ファイルの連続修正 | 0 件/月 |
| エージェント精度 | 人間介入が必要だった割合 | 20% 以下 |
| rules/ 更新頻度 | git log で rules/ の変更数 | 月 2 件以上 |

### 継続的な改善

- 毎月末に memory-curator を実行
- 四半期ごとにエージェント定義を見直し
- 新機能追加時に対応するエージェント/スキルを同時に計画

---

## 全フェーズのファイル変更サマリー

### 新規作成

```
.claude/
├── agents/
│   ├── tdd-agent.md              (Phase 1)
│   ├── event-manager.md          (Phase 2)
│   ├── crm-analyst.md            (Phase 2)
│   ├── security-auditor.md       (Phase 3)
│   ├── migration-planner.md      (Phase 3)
│   ├── rule-extractor.md         (Phase 4)
│   └── memory-curator.md         (Phase 4)
├── skills/
│   └── reflect/
│       └── SKILL.md              (Phase 3)
└── settings.json                 (Phase 1 で hooks を追記)

memory/
└── feedback_agent_design.md      (Phase 1)
```

### 既存ファイルの更新

```
.claude/
├── skills/debug/SKILL.md         (Phase 2: Google Calendar 再認証手順追記)
├── agents/booking-debugger.md    (Phase 5: 評価後に改善)
└── settings.json                 (Phase 1: hooks 追記)
```
