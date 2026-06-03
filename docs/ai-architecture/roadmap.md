# AI アーキテクチャ実装ロードマップ

> ハイブリッド設計（ドメイン指向 + プロセス指向）の段階的な実装計画
> 詳細な設計方針は [hybrid-design.md](./hybrid-design.md) を参照

---

## 全体構造

ハイブリッド設計の「3段階」に対応させて、フェーズを組む。

```
段階 1（ドメインエージェントのみ）   → Phase 1 〜 Phase 2
段階 2（プロセスをスキルで半自動化） → Phase 3
段階 3（オーケストレーターで自動化） → Phase 4
自己改善ループ                       → Phase 5
評価・精緻化                         → Phase 6（継続）
```

```
Phase 1 (今すぐ)     → フック基盤 + tdd-agent（モード A の土台）
Phase 2 (〜1 week)   → ドメインエージェント群（モード A 本格稼働）
Phase 3 (〜2 week)   → /new-feature スキル + 開発支援エージェント（モード B の入口）
Phase 4 (〜1 month)  → オーケストレーター（モード自動ルーティング）
Phase 5 (〜2 month)  → 自己改善ループの自動化
Phase 6 (継続)       → 評価・精緻化・方向転換の判断
```

---

## Phase 1: フック基盤と tdd-agent（モード A の土台）

### 目標

コード変更のたびにテストが自動実行される環境を作る。
ドメインエージェントが動く前に、品質の下限を保証する仕組みを置く。

### タスク

#### 1-1. `settings.json` に PostToolUse フックを追加

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

**期待効果**: Edit/Write のたびにテスト結果が context に流れ込み、赤を即検知できる

#### 1-2. `tdd-agent` を `.claude/agents/` に追加

Red-Green-Refactor を自律実行するエージェント。  
詳細は [agents.md](./agents.md) の「tdd-agent」セクション参照。

### 完了条件

- [ ] Edit/Write 後にテスト結果が自動表示される
- [ ] `tdd-agent` が起動して Red テストを書ける

---

## Phase 2: ドメインエージェント群（モード A 本格稼働）

### 目標

LINE Harness の主要ドメインをカバーするエージェントを配置。
**モード A**（ドメインエージェントが直接対応）が機能する状態にする。

### タスク

#### 2-1. `event-manager` エージェント

担当: イベント作成・Stripe 決済・参加者管理  
理由: 現在最も複雑なフロー。手順書が長大なためエージェント化の恩恵が大きい

コアロジック:
- price 判定による有料/無料フロー分岐
- participant_count は confirmed のみカウント
- 返金通知は「処理を開始しました + 5〜10 営業日」
- JST フォーマット強制

#### 2-2. `crm-analyst` エージェント

担当: 友だち・コンバージョンデータの分析・レポート生成  
理由: D1 クエリの知識が必要で毎回調べている

#### 2-3. `message-optimizer` エージェント

担当: LINE メッセージの文言・トーン・Flex レイアウトの最適化  
理由: メッセージ品質の判断基準をエージェントに持たせることで一貫性が出る

コアロジック:
- 確認系（✅ グリーン #06C755）/ 警告系（グレー #999999）のカラー基準
- altText は必ず日本語・内容を要約
- 5 文字以内の単語は wrap: true 不要

#### 2-4. 既存スキルの強化

`/debug` スキルに Google Calendar 再認証の手順を追記

### 完了条件

- [ ] `event-manager` が「イベントを作成して」に完結して対応できる
- [ ] `crm-analyst` が「先週の配信効果を教えて」にレポートを返せる
- [ ] `message-optimizer` が既存通知と一貫したトーンで文言を提案できる

---

## Phase 3: /new-feature スキル + 開発支援エージェント（モード B の入口）

### 目標

新機能・スキーマ変更・セキュリティに触れる変更に**モード B**（プロセスパイプライン）を導入する。
ただしこの段階では「自動」ではなく、人間が `/new-feature` を明示的に呼ぶ形にする。

### タスク

#### 3-1. `/new-feature` スキルの追加

新機能実装時に計画→レビュー→委譲の手順を呼び出すスキル

```markdown
## 手順
1. 実装範囲の整理（影響ファイル・テーブル・エンドポイント）
2. security-auditor に新ルートのセキュリティチェックを依頼
3. migration-planner にスキーマ変更の安全計画を依頼（ある場合）
4. 計画を人間に提示し承認を得る
5. tdd-agent に Red テストを先に書かせる
6. 実装
7. テスト GREEN を確認してから完了とする
```

#### 3-2. `security-auditor` エージェント

担当: 新ルート追加時の OWASP チェック（モード B の計画レビュー担当）

チェック項目:
- authMiddleware スキップリスト漏れ
- SQL インジェクション（パラメータバインド未使用）
- Stripe webhook 署名検証の存在

#### 3-3. `migration-planner` エージェント

担当: スキーマ変更の安全計画・実行（モード B の計画レビュー担当）

判断ロジック:
- CHECK 制約変更の自動検出 → テーブル再作成フローへの自動分岐
- ローカル → リモートの順序強制

#### 3-4. `/reflect` スキルの追加

セッション終了時に呼ぶ振り返りスキル。

```markdown
## 手順
1. git log --oneline -10 で今日の変更を確認
2. 修正が必要だったパターンを特定
3. .claude/rules/ の既存ルールを照合
4. 新パターンがあれば rules/ に追記案を提示
5. memory/ のフィードバックエントリを更新
```

### 完了条件

- [ ] `/new-feature` を呼ぶと計画フェーズが起動する
- [ ] `security-auditor` が新ルートのスキップリスト漏れを検出できる
- [ ] `migration-planner` が CHECK 制約変更を検出してテーブル再作成フローを提案できる
- [ ] `/reflect` を呼ぶと rules/ への追記案が生成される

---

## Phase 4: オーケストレーター（モード自動ルーティング）

### 目標

モード A / B / C の切り替えを人間が意識しなくても動く状態にする。
オーケストレーターエージェントがトリガー条件を見て自動でルーティングする。

### タスク

#### 4-1. オーケストレーターエージェントの実装

[hybrid-design.md](./hybrid-design.md) の「モード切り替えのトリガー基準」をロジックとして持つ

```markdown
## 判断ロジック（モード切り替えのトリガー）
- 既存ファイルの修正 → モード A
- 新ファイルの作成 → モード B
- DB スキーマ変更 → モード B
- 3 ドメイン以上またがる → モード B
- セキュリティ・決済に触れる → モード B
- 判断が不明確な場合 → モード C（ドメインエージェントに内部判断を委ねる）
```

#### 4-2. ドメインエージェントへのモード C ゲート追加

各ドメインエージェントの定義に「複雑かどうかを自己判断する基準」を追記

### 完了条件

- [ ] 「新機能を追加して」という依頼が自動でモード B に入る
- [ ] 「文言を直して」という依頼が自動でモード A に入る
- [ ] モードの判断が間違えた場合に人間が修正できる

---

## Phase 5: 自己改善ループの自動化（〜2 month）

### 目標

エージェントの実行経験が `.claude/` 設定に自動的にフィードバックされる状態にする。

### タスク

#### 5-1. `rule-extractor` エージェント

CI 失敗ログ・同一バグ再発 → 根本原因分析 → rules/ 更新案の生成  
依存: Phase 3 の `/reflect` が安定稼働していること

#### 5-2. `memory-curator` エージェント

月次で `memory/` の整合性チェック。古いエントリの更新・削除案を提示

#### 5-3. エージェント評価ログの導入

`.claude/agents/<name>.md` の末尾に「改善履歴」セクションを定義し、
実行後の気づきを蓄積する運用ルールを確立

### 完了条件

- [ ] `rule-extractor` が CI 失敗から rules/ 更新案を生成できる
- [ ] `memory-curator` が古いエントリを検出できる
- [ ] 自己改善サイクルが 1 ヶ月以上継続している

---

## Phase 6: 評価・精緻化（継続）

### KPI

| 指標 | 計測方法 | 目標 |
|------|----------|------|
| CI 失敗率 | GitHub Actions の成功率 | 95% 以上 |
| 同一バグの再発率 | git log で同一ファイルの連続修正 | 0 件/月 |
| モード A の割合 | 依頼件数のうちドメイン直接対応 | 70% 以上（運用が定常化している証拠） |
| rules/ 更新頻度 | git log で rules/ の変更数 | 月 2 件以上 |

### 方向転換の判断基準

以下の3つが重なったときは、プロセス指向への部分的な転換を検討する（詳細は [hybrid-design.md](./hybrid-design.md) 参照）：

1. ドメインエージェントが「自分の担当外」の判断を頻繁に求めてくる
2. オーケストレーターが複雑になりすぎる
3. エージェント定義の維持コストが実装コストを上回る

---

## ファイル変更サマリー

### 新規作成

```
.claude/
├── agents/
│   ├── tdd-agent.md              (Phase 1)
│   ├── event-manager.md          (Phase 2)
│   ├── crm-analyst.md            (Phase 2)
│   ├── message-optimizer.md      (Phase 2)
│   ├── security-auditor.md       (Phase 3)
│   ├── migration-planner.md      (Phase 3)
│   ├── orchestrator.md           (Phase 4)
│   ├── rule-extractor.md         (Phase 5)
│   └── memory-curator.md         (Phase 5)
└── skills/
    ├── new-feature/
    │   └── SKILL.md              (Phase 3)
    └── reflect/
        └── SKILL.md              (Phase 3)

settings.json                     (Phase 1: hooks 追記)
```

### 既存ファイルの更新

```
.claude/
├── skills/debug/SKILL.md         (Phase 2: Google Calendar 再認証手順追記)
├── agents/booking-debugger.md    (Phase 6: 評価後に改善)
└── settings.json                 (Phase 1: hooks 追記)
```
