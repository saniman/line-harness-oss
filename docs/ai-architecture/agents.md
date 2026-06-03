# エージェントカタログ

> `.claude/agents/` に配置するサブエージェントの設計仕様

---

## 設計原則

### エージェントと人間の違い

エージェントは「複数ツールを組み合わせた反復タスク」に適している。
単純な 1 回の操作はスキルかインライン処理で十分。

| 向いているタスク | 向いていないタスク |
|-----------------|-------------------|
| 5 ステップ以上の調査・修正 | 単一コマンドの実行 |
| 複数ファイルの横断分析 | 既知のパスへの書き込み |
| 反復的な確認ループ | 一行の変更 |
| ドメイン知識が必要な判断 | 手順が完全に決まっている作業 |

### エージェント定義のフォーマット

```markdown
---
name: agent-name
description: 1行の説明（FleetView の表示文言）
---

# エージェント名

## 役割
何をするエージェントか（1–3文）

## ツールアクセス
必要なツールの一覧（不要なツールは列挙しない）

## 手順
1. 最初にやること
2. 次にやること
...

## 判断基準
エージェントが自律判断すべき場合の基準

## 禁止事項
絶対にやらないこと
```

---

## 現状

### booking-debugger（稼働中）

**目的**: 予約・通知の不具合調査  
**ファイル**: `.claude/agents/booking-debugger.md`  
**状態**: 本番稼働中

---

## 追加予定エージェント

### Tier A: 高優先度（Phase 2 で実装）

#### `event-manager`

**目的**: イベント作成〜決済〜参加者管理の一連フローを担当

```
担当範囲:
- events テーブルの CRUD
- event_bookings の状態管理
- Stripe Checkout セッション作成・確認
- 参加者向け LINE 通知（JST フォーマット必須）
- 満席チェックと waitlist 対応

判断基準:
- price > 0 → 有料フロー（Stripe 経由）
- price = 0 or null → 無料フロー（直接 confirmed）
- participant_count は status='confirmed' のみカウント

禁止:
- 本番の Stripe データを手動操作しない
- 参加者個人情報（email/name）をログに出力しない
```

---

#### `crm-analyst`

**目的**: 友だち・タグ・コンバージョンデータの分析とレポート生成

```
担当範囲:
- friends / friend_tags / conversion_events の集計クエリ
- セグメント条件の設計と検証
- スコア分布分析（lead_scores テーブル）
- 配信効果レポート（broadcasts + messages_log）

出力形式:
- Markdown テーブル形式でサマリー
- actionable な next step を必ず含める

禁止:
- 個人を特定できる情報（LINE user ID + 氏名の組み合わせ）を Claude context に置かない
```

---

#### `tdd-agent`

**目的**: TDD サイクル（RED → GREEN → REFACTOR）の自律実行

```
担当範囲:
- 新機能の実装前にテストを書く
- src/services/*.ts の変更に対応する *.test.ts を更新
- npx vitest run でグリーンを確認してから実装完了とする

手順:
1. 実装対象の関数シグネチャを確認
2. テストケースを列挙（正常系 / 異常系 / 境界値）
3. *.test.ts に RED テストを書く
4. vitest run で RED を確認
5. 実装して GREEN にする
6. REFACTOR（不要なコメント削除、重複排除）
7. vitest run で最終確認

fixture 更新ルール:
- 型インターフェースにカラムを追加したら全 fixture を同時更新
- grep で使用箇所を全列挙してから更新

禁止:
- pnpm --filter worker test（Bun クラッシュリスク）→ npx vitest run を使う
- beforeEach/afterEach でアロー関数の return に VitestUtils を返す
```

---

### Tier B: 中優先度（Phase 3 で実装）

#### `campaign-orchestrator`

**目的**: 一斉配信キャンペーンの企画→実行→効果測定を一連で担当

```
担当範囲:
- セグメント条件の設計（タグ組み合わせ）
- メッセージ草案の生成（ルール: 日本語、親しみやすいトーン）
- 配信スケジュールの提案
- 配信後 24h 以内の効果測定レポート

フロー:
企画立案 → 人間承認 → broadcasts テーブル作成 → 人間の最終確認 → 送信

禁止:
- 人間の承認なしに broadcast/send を実行しない（OSS-SYNC-CHARTER §9）
```

---

#### `security-auditor`

**目的**: セキュリティレビュー（新ルート・新スキーマ変更時に起動）

```
担当範囲:
- OWASP Top 10 チェック（SQLi, XSS, IDOR, auth bypass）
- authMiddleware のスキップリスト漏れチェック
- Stripe webhook 署名検証の存在確認
- D1 クエリのパラメータバインド確認
- wrangler secret で管理すべきキーの平文混入チェック

出力形式:
- 重大度: HIGH / MEDIUM / LOW
- 該当コード行番号
- 修正方法の具体例
```

---

#### `migration-planner`

**目的**: DB スキーマ変更の安全な計画と実行

```
担当範囲:
- schema.sql の差分確認
- ALTER TABLE の制約チェック（SQLite: CHECK 制約は変更不可）
- テーブル再作成が必要なケースの自動検出
- ローカル → リモートの順序で適用
- 適用後の SELECT で確認

CHECK 制約変更の手順（自動実行）:
1. 新テーブル作成（_v2）
2. INSERT INTO v2 SELECT * FROM 旧テーブル
3. DROP TABLE 旧テーブル
4. ALTER TABLE v2 RENAME TO 旧テーブル名

禁止:
- --remote への適用はローカル成功を確認してから
- 本番データを DROP せずにマイグレーション完了と宣言しない
```

---

### Tier C: 自己改善系（Phase 4 で実装）

#### `rule-extractor`

**目的**: タスク完了後に成功・失敗パターンを `rules/` に反映する

```
トリガー: セッション終了 or 明示的な `/reflect` コール

手順:
1. 直近の変更コミット（git log -10）を確認
2. 修正が必要だったパターンを特定
3. `.claude/rules/` の既存ルールと照合
4. 新しいパターンなら rules/ に追記を提案
5. 人間の承認後に commit

ルールの書き方:
- アンチパターン（❌ 誤）と正解（✅ 正）のペアで記述
- 症状と原因を必ず書く
```

---

#### `memory-curator`

**目的**: `memory/` の整合性チェックと古い記憶の更新

```
トリガー: 月 1 回 or 明示的なコール

手順:
1. MEMORY.md のインデックスと実ファイルの整合確認
2. 各 memory ファイルの内容を現在のコードと照合
3. 古くなった記憶（削除された関数・移動したファイル等）を特定
4. 更新案を提示 → 人間承認 → 適用

禁止:
- 記憶を無断で削除しない（必ず提案→承認）
```

---

## エージェント間の連携パターン

### パターン 1: 直列委譲（シンプル）

```
人間: 「新しいイベント機能をテスト込みで実装して」
  ↓
tdd-agent → テスト作成 (RED)
  ↓
[人間またはメインClaude] → 実装
  ↓
tdd-agent → グリーン確認
  ↓
security-auditor → 新ルートのセキュリティチェック
  ↓
rule-extractor → 学んだパターンをルールに反映
```

### パターン 2: 並列調査（独立タスク）

```
人間: 「先週のキャンペーンを振り返って次の施策を提案して」
  ↓ (並列)
crm-analyst → 配信効果データ収集
campaign-orchestrator → 次回キャンペーン草案
  ↓ (合流)
メインClaude → 統合レポート作成
```

### パターン 3: 障害対応（反応型）

```
人間: 「予約が動かない」
  ↓
booking-debugger → 調査・特定
  ↓ (問題によって分岐)
├─ DB 問題 → migration-planner
├─ コード問題 → tdd-agent (回帰テスト追加)
└─ 設定問題 → rule-extractor (再発防止ルール追加)
```
