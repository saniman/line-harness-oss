---
description: Worker APIルートのコーディングルール
globs: "apps/worker/src/**/*.ts"
---
# Worker APIコーディングルール

## ルート設計
- 認証が必要なエンドポイントは authMiddleware を必ず通す
- 公開エンドポイント（LIFF向け等）は auth.ts のスキップリストに明示的に追加する
- レスポンス形式は必ず { success: boolean, data?: any, error?: string }

## エラーハンドリング
- try/catch で握りつぶさない
- console.error でログを残す
- LINEへの通知はベストエフォート（失敗しても予約自体は成功させる）

## D1操作
- スキーマ変更時は schema.sql を更新してからマイグレーション実行
- IDは必ず crypto.randomUUID() を使う
- 日時は全て ISO 8601 形式で保存（JST変換はクライアント側で行う）

## テストルール
- src/services/*.ts を変更したら src/services/*.test.ts も更新する
- テストファイルの命名：対象ファイルと同名で .test.ts 拡張子
- describe名：機能名（日本語OK）
- it名：「〜の場合〜になる」形式で日本語で書く

### beforeEach/afterEachの返り値に注意
- vi.useFakeTimers()などをアロー関数で直接returnするとTypeScriptの型エラーになる

  ❌ 誤（VitestUtils が返される）
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  ✅ 正（波括弧で囲んでvoidにする）
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

- 症状：CI で以下のエラーが出る
  Type 'VitestUtils' is not assignable to type 'Awaitable<HookCleanupCallback>'

## Stripe Webhook

- rawボディは必ず `req.text()` で取得してから `constructEventAsync()` に渡す
  ❌ 誤: req.json() → 署名検証が失敗する
  ✅ 正: const rawBody = await c.req.text(); await stripe.webhooks.constructEventAsync(rawBody, sig, secret)

- Cloudflare Workers では `Stripe.createFetchHttpClient()` を渡す（Node.js の http モジュール非対応のため）
  ```ts
  new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2026-04-22.dahlia', httpClient: Stripe.createFetchHttpClient() })
  ```

- 以下のエンドポイントは LIFF / Stripe から直接呼ばれるため auth skipリストに追加必須：
  - `/api/events/:id/checkout-session`（LIFF → Stripe）
  - `/api/stripe/webhook`（Stripe → Worker）
  追加忘れると LIFF ユーザーが 401 を受け取る（症状が分かりにくい）

- 決済完了時のname/emailは `session.customer_details` から取得する
  ```ts
  session.customer_details?.name ?? null
  session.customer_details?.email ?? null
  ```
  Checkout Session の metadata には含まれないため `confirmEventBooking` に引数として渡す

## イベント価格・決済フロー設計

- `price` が null または 0 → 無料フロー: `POST /api/events/:id/join`（name/email で即確定）
- `price` が 1 以上 → 有料フロー: `POST /api/events/:id/checkout-session` → Stripe Checkout
- 定員カウント（`participant_count`）は `status = 'confirmed'` のみ集計する
  - `pending`（仮登録）は Stripe セッション期限（30分）でexpireするため含めない
  - 含めると「仮登録が多いと残席0になる」問題が発生する
- `GET /api/events/public` は `GET /api/events/:id` より前に登録すること
  - Hono のルートマッチは登録順優先のため、後ろに置くと `/public` が `:id` に吸収される

## 日時フォーマット

D1 に保存される日時は UTC の ISO 8601 形式（例: `2026-06-13T05:00:00.000Z`）。
**LINE push メッセージなど人目に触れる場所では必ず JST に変換すること。**

❌ 誤（DB の値をそのまま埋め込む）
```ts
text: `日時：${eventRow?.start_at ?? ''}`
// → 日時：2026-06-13T05:00:00.000Z
```

✅ 正（`formatJST()` で変換する）
```ts
text: `日時：${eventRow?.start_at ? formatJST(eventRow.start_at) : ''}`
// → 日時：06/13(土) 14:00
```

Worker 内で使う `formatJST()` は `stripe.ts` に定義済み。
LIFF クライアント側の同名関数は `event-booking.ts` にある（共有はしていない）。

## 既知の落とし穴
- friends テーブルに line_account_id カラムは存在しない（JOIN不可）
- LINE push のトークンは line_accounts テーブルが空のため env.LINE_CHANNEL_ACCESS_TOKEN を使う
- Google Calendar のアクセストークンは conn.access_token を直接使わず getValidAccessToken() を使う

### access_tokenの直接参照禁止
- conn.access_tokenを直接使うとトークン期限切れで無言で失敗する
- 必ずgetValidAccessToken(env, db, connectionId)を経由すること
- FreeBusy取得には getFreeBusyWithRefresh(env, db, connectionId, calendarId, timeMin, timeMax) を使う
- 対象：createEvent・deleteEvent・FreeBusy・全てのGoogle Calendar API呼び出し

### Google Calendar OAuth
- sendUpdates は URLクエリパラメータで渡す（ボディに入れても無視される）
  ✅ 正: POST .../events?sendUpdates=all
  ❌ 誤: body に sendUpdates: 'all' を含める

- refresh_tokenを確実に取得するには認証URLに以下が必須：
  access_type: 'offline'
  prompt: 'consent'
  どちらか欠けるとrefresh_tokenが返ってこない

- getValidAccessToken()を使わずaccess_tokenを直接使うと
  1時間でトークンが切れてAPIが動かなくなる

- /auth と /callback は認証スキップリストに入れること
  入れないと再認証時に {"error":"Unauthorized"} になる

### トークン期限切れの症状と対処
症状: Google Calendar APIが invalid_grant を返す
原因: refresh_tokenが未保存 or 期限切れ
対処:
  1. https://api.walover-co.work/api/integrations/google-calendar/auth にアクセス
  2. Googleアカウントで再認証
  3. D1のrefresh_tokenが更新されたことを確認：
     npx wrangler d1 execute line-harness --remote \
       --command="SELECT refresh_token IS NOT NULL as has_refresh, token_expires_at FROM google_calendar_connections"

### テスト実行時のBunクラッシュ
- ローカルで pnpm --filter worker test を実行すると
  BunがSegmentation faultでクラッシュする場合がある
- 症状：ターミナルが固まりCtrl+Cも効かなくなる
- 対処：ターミナルを強制終了して npx vitest run で実行する
- 根本原因：Claude CodeがデフォルトでBunを使おうとするため
- 恒久対策：package.jsonのtestスクリプトをnpx vitest runに変更済み
