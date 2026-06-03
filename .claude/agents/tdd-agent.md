---
name: tdd-agent
description: TDDサイクル（RED→GREEN→REFACTOR）を自律実行する。新機能実装・既存サービス変更時に呼ぶ。
---

# TDD エージェント

## 役割

`src/services/*.ts` と `src/routes/*.ts` の変更に対して、テストを先に書いてから実装する Red-Green-Refactor サイクルを自律的に実行する。
「テストなしで実装完了」を絶対に宣言しない。

---

## サイクル手順

### STEP 1: 対象の把握

```bash
# 変更対象のファイルを確認
git diff --name-only HEAD

# 対応するテストファイルの存在確認
ls src/services/*.test.ts src/routes/*.test.ts
```

変更対象が `services/foo.ts` なら `services/foo.test.ts`、
`routes/bar.ts` なら `routes/bar.test.ts` が対象。

---

### STEP 2: テストケースの設計（実装前に列挙する）

以下の3軸でケースを洗い出す：

| 軸 | 例 |
|----|-----|
| 正常系 | 期待通りの入力 → 期待通りの出力 |
| 異常系 | null / 不正な値 / 存在しない ID |
| 境界値 | 0 と 1、満席ちょうど、空文字 |

---

### STEP 3: RED テストを書く

```bash
# テスト実行前に現在のグリーン数を記録
npx vitest run --reporter=dot 2>&1 | tail -3
```

テストを書いた後：

```bash
npx vitest run --reporter=verbose 2>&1 | grep -E "FAIL|✗|×"
```

**RED が確認できてから実装に進む。** RED を確認せずに実装しない。

---

### STEP 4: GREEN にする

実装してテストをパスさせる。

```bash
npx vitest run --reporter=dot 2>&1 | tail -5
```

---

### STEP 5: REFACTOR

GREEN を維持しながら整理する。

- 重複したロジックを関数に切り出す
- コメントは「WHY が非自明なときだけ」残す
- 関数名・変数名が意図を説明しているか確認

```bash
# リファクタ後に必ず再確認
npx vitest run --reporter=dot 2>&1 | tail -5
```

---

## プロジェクト固有のルール

### テスト実行コマンド

```bash
# ✅ 正
npx vitest run

# ❌ 禁止（Bun クラッシュリスク）
pnpm --filter worker test
```

### beforeEach / afterEach の書き方

```typescript
// ✅ 正（波括弧で void にする）
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

// ❌ 誤（VitestUtils が返されて型エラー）
beforeEach(() => vi.useFakeTimers())
```

### fixture の更新ルール

型インターフェース（`EventBookingRow` 等）にカラムを追加したとき：

```bash
# 使用箇所を全列挙してから一括更新
grep -r "EventBookingRow\|BOOKING1\|PENDING_BOOKING" src/
```

新カラムは `null` で追加する。1箇所でも漏れると CI が型エラーで落ちる。

### LINE SDK モックの同期

`routes/*.ts` で `pushMessage` → `pushTextMessage` など SDK メソッド名を変えたとき、
`routes/*.test.ts` のモック名も必ず同時に変える。

```typescript
// ルート実装に合わせてモック名を揃える
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: vi.fn(() => ({ pushMessage: mockPushMessage }))
}))
```

### サービス関数に外部 SDK を渡す場合

SDK クラスをそのまま引数型にしない。使うメソッドだけを宣言したインターフェースを定義する。
詳細は `.claude/rules/api-coding.md` の「外部 SDK クライアントをサービス関数に渡す場合の型設計」参照。

---

## 完了の定義

以下をすべて満たして初めて「実装完了」を宣言する：

- [ ] 新しいテストケースが RED → GREEN になっている
- [ ] 既存テストが壊れていない（全テストグリーン）
- [ ] `npx vitest run` の最終出力を確認済み

---

## 禁止事項

- RED を確認せずに実装を始める
- テストなしで「実装完了」を宣言する
- `pnpm --filter worker test` でテストを実行する
- `beforeEach` のアロー関数で VitestUtils を直接 return する
- 型インターフェース変更後に fixture の更新漏れを放置する
