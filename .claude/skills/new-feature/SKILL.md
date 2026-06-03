# 新機能実装スキル（モード B）

## 使い方

新しいエンドポイント・テーブル・フロー全体を追加するときに使う。
既存コードの修正・バグ修正には使わない（それはドメインエージェントが直接対応）。

```
「〇〇機能を新しく追加したい」
「△△テーブルを追加して API を作りたい」
「新しいフローを設計してほしい」
```

---

## プロセス（必ずこの順番で進める）

### STEP 1: 影響範囲の整理

以下を明確にしてから次に進む。

```
[ ] 新しく作るファイル（routes / services / migrations / client）
[ ] 変更する既存ファイル
[ ] 追加・変更するテーブル・カラム
[ ] 認証が必要か（LIFF から呼ばれるか、管理者専用か）
[ ] Stripe / LINE / Google Calendar と連携するか
```

---

### STEP 2: security-auditor に確認を依頼

新しいルートを追加する場合は security-auditor エージェントを呼ぶ。

確認してもらう内容：
- 新ルートの認証スキップリストへの追加要否
- SQL クエリのパラメータバインド確認
- 外部サービス（Stripe 等）との接点のセキュリティ

HIGH 判定が出た場合は、修正してから STEP 3 に進む。

---

### STEP 3: DB スキーマ変更がある場合は migration-planner に依頼

テーブル追加・カラム追加・CHECK 制約変更がある場合は migration-planner エージェントを呼ぶ。

- CHECK 制約変更はテーブル再作成フローが必要かを自動判断させる
- ローカル適用後の確認クエリを必ず実行させる

---

### STEP 4: tdd-agent にテストを先に書かせる

実装の前にテストを書く（TDD）。

```
tdd-agent に依頼：
「src/services/〇〇.ts の〇〇関数のテストを書いてほしい。
 正常系・異常系・境界値を含めて、まず RED の状態にして」
```

---

### STEP 5: 実装

テストが RED になっていることを確認してから実装する。

実装完了の条件：
```
[ ] npx vitest run が全テストグリーン
[ ] TypeScript のエラーがない（tsc --noEmit）
[ ] 新ルートが auth.ts のスキップリストに正しく設定されている
[ ] schema.sql が更新されている（DB 変更がある場合）
```

---

### STEP 6: 動作確認

```bash
# TypeScript チェック
npx tsc --noEmit -p apps/worker/tsconfig.json

# テスト
npx vitest run --reporter=dot
```

---

## 完了の定義

以下をすべて満たして「実装完了」を宣言する：

- [ ] security-auditor の審査が全 PASS
- [ ] テストが全グリーン
- [ ] TypeScript エラーがない
- [ ] DB 変更がある場合、ローカル・リモート両方に適用済み
- [ ] schema.sql が更新済み
