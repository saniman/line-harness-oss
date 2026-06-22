---
description: LIFFアプリのルール
globs: "apps/worker/src/client/**/*.ts"
---
# LIFFコーディングルール

## ソースの場所
- LIFFクライアントは apps/worker/src/client/ にある（apps/liff/ は存在しない）
- ビルド出力: apps/worker/dist/client/
- Pagesデプロイ: npx wrangler pages deploy apps/worker/dist/client --project-name=line-harness-liff

## LIFFクライアントのTSはCIのtscで型チェックされない（2026-06-23 追記）

症状: `apps/worker/src/client/**`（order/ の .tsx 含む）の型エラーが CI をすり抜け、実行時まで露見しない。
原因: `apps/worker/tsconfig.json` が `"exclude": ["src/client"]`。CI（test.yml）の
`pnpm --filter worker exec tsc --noEmit` はこの除外に従うため client を見ない。
deploy-liff / deploy-worker は `vite build`（esbuild）で型を剥がすだけで型検査しない。
→ つまり LIFF クライアントの型は **どのCIジョブでも検査されない**（vitest も型は見ない）。

✅ 対処: `apps/worker/src/client/**`（特に .tsx）を変更したら push 前に手動で型検査する:
```bash
npx tsc --noEmit --skipLibCheck --jsx react-jsx --jsxImportSource react \
  --module esnext --moduleResolution bundler --target es2022 --strict \
  --types react,vite/client --lib es2022,dom,dom.iterable \
  apps/worker/src/client/order/main.tsx apps/worker/src/client/order/lib/*.ts
```
（`import.meta.env` を使うため `--types vite/client` が必須。無いと `Property 'env' does not exist on type 'ImportMeta'` を誤検出する）

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

### LINE Login チャネルの bot リンク / openid スコープ（2026-06-16 追記）

`liff.getFriendship()` と `liff.getIDToken()` を使うフロー（サロン予約など）では、
LINE Login チャネル側の設定が2つ必要。**開発者アカウントや既存フローでは顕在化せず、
該当フローを実機で通して初めてエラーになる**種類の落とし穴。

| 症状 | 原因 | 対処 |
|---|---|---|
| `There is no login bot linked to this channel.` | LINE Login チャネルに公式アカウント(bot)が未リンク | チャネル基本設定 → 「リンクされた LINE 公式アカウント」を設定。Login と Messaging が同一プロバイダーである必要あり |
| `LINE 認証情報の取得に失敗しました。` | LIFF アプリのスコープに `openid` が無く `getIDToken()` が null | LIFF 設定 → Scopes で `openid` を有効化 → LIFF 開き直し |

### LIFF 新規リリース前チェックリスト

- [ ] LINE Login チャンネルのステータスが **Published** であること
- [ ] `getFriendship()` を使うなら **公式アカウント(bot)が Login チャネルにリンク**済み
- [ ] `getIDToken()` を使うなら **LIFF スコープに `openid`** が入っている
- [ ] API 呼び出しが **VITE_API_BASE 経由の絶対URL**になっている（相対パスは Pages に飛ぶ）
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

### LIFFクライアントのfetchは必ず VITE_API_BASE 経由の絶対URLにする（2026-06-16 追記）

症状: サロン予約で `メニュー情報の取得に失敗しました。The string did not match the expected pattern.`
原因: LIFF は Pages（line-harness-liff）、API は別ドメインの Worker（api.walover-co.work）に
ホストされている。`window.location.origin` ベースの相対パスで叩くと**リクエストが Pages に飛び**、
返ってきた HTML を `res.json()` がパースできず WebKit が上記エラーを出す。

❌ 誤（相対パス → Pages に飛ぶ）
```typescript
const u = new URL(path, window.location.origin);
return u.pathname + u.search; // /api/... を同一オリジン(Pages)に投げてしまう
```

✅ 正（VITE_API_BASE 優先で絶対URL）
```typescript
const API_BASE = import.meta.env?.VITE_API_BASE || '';
const u = new URL(path, API_BASE || window.location.origin);
if (API_BASE) return u.toString(); // Worker への絶対URL
return u.pathname + u.search;       // 同一オリジン時のフォールバック
```

対処: `apps/worker/src/client/**` で新しく API を叩くときは `VITE_API_BASE` を使う。
`main.ts` の link/affiliate 系は best-effort で握りつぶしているため失敗が見えにくいが、
取得結果が必須のフロー（メニュー/空き枠など）では絶対URL必須。

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
