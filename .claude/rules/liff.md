---
description: LIFFアプリのルール
globs: "apps/worker/src/client/**/*.ts"
---
# LIFFコーディングルール

## ソースの場所
- LIFFクライアントは apps/worker/src/client/ にある（apps/liff/ は存在しない）
- ビルド出力: apps/worker/dist/client/
- Pagesデプロイ: npx wrangler pages deploy apps/worker/dist/client --project-name=line-harness-liff

## 環境変数
- VITE_LIFF_ID: LIFFアプリID（1661159603-5qlDj5wV）
- VITE_API_BASE: Worker URL（https://api.walover-co.work）
- VITE_CALENDAR_CONNECTION_ID: Google Calendar接続ID（0ba404af-3184-4640-bb56-d24c37c1f230）
- GitHub Actions の vars に設定が必要（未設定だと空文字でビルドされる）

## liff.init() の扱い
- 必ずtry/catchで囲む
- LINE外ブラウザでもエラーにならないよう続行させる
- liff.isInClient() で分岐する

## ルーティング
- ?page=book → initBooking()
- liff.state=%3Fpage%3Dbook の形式でも届く → getPage() で liff.state を展開して取得
- レンダリング先は document.getElementById('app')（#booking-root は存在しない）

## 既知の落とし穴

### LINE Login チャンネルの Developing ステータス問題（2026-06-08 インシデント）

症状: 一般ユーザーが LIFF を開くと `400 This channel is now developing status. User need to have developer role.` が出る。
原因: LINE Login チャンネル（LIFF の親チャンネル）が Developing のまま公開されていない。

**盲点**: 開発者アカウントは Developing 状態でも LIFF にアクセスできる。
開発者だけでテストすると本番ユーザーのエラーが発覚しない。

❌ 罠: Messaging API チャンネルが Published でも LINE Login チャンネルが Developing なら一般ユーザーは弾かれる。

✅ 対処: LINE Developers Console → LINE Login チャンネル → Publishing タブ → **Publish**

コード側の対策として、`main.ts` の `liff.init()` catch ブロックでこのエラーを検出し
ユーザー向けの日本語メッセージを表示する（生のエラー文字列を出さない）：

```typescript
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('[LIFF] init error:', msg);
  if (msg.includes('developing') || msg.includes('developer role')) {
    showError('現在このサービスはメンテナンス中です。しばらく時間をおいてから再度お試しください。');
  } else {
    showError(msg || 'LIFF初期化エラー');
  }
}
```

### LIFF 新規リリース前チェックリスト

- [ ] LINE Login チャンネルのステータスが **Published** であること
- [ ] **開発者ロールを持たない** LINE アカウント（友人・テスト用サブアカウント）でエンドツーエンドを通す
- [ ] LIFF から始まる全フロー（診断完了 → 予約ボタン → LIFF 起動 → 予約完了）を非開発者で確認する

### フォームのボタンstate管理
- `__setName` / `__setEmail` は state を更新するだけでなく `updateSubmitButton()` を必ず呼ぶこと
- `render()` で全体を差し替えるとフォーカスが飛ぶため、ボタン状態の更新は `updateSubmitButton()` で個別に行う
- バリデーション条件（`isDisabled` ロジック）は `render()` と `updateSubmitButton()` で同じ式を使う
- 回帰テスト: `src/client/booking.test.ts` の「__setNameを呼んだ後にボタン状態が更新される」を参照

## API呼び出し
- slots と book エンドポイントは認証不要（Bearer トークン不要）
- エラー時はユーザーに分かりやすいメッセージを表示する
- booking リクエストには lineUserId（liff.getProfile().userId）を含める

## `declare const liff` の型宣言に openWindow を維持する

`main.ts` の `declare const liff` には `openWindow` を必ず含めること。

```typescript
declare const liff: {
  // ... 他のメソッド ...
  openWindow(params: { url: string; external?: boolean }): void;
};
```

upstream は event-booking を React 化したため `openWindow` の宣言を削除しているが、
fork の vanilla TS 版 `event-booking.ts` が `liff.openWindow()` を使っている。
upstream の main.ts を cherry-pick する際に `openWindow` 宣言を誤って消さないこと。
