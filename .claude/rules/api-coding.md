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

### `as const` 配列から派生したリテラル型を受け取る関数のテストには `as const` が必要

本体コードで `as const` 配列を定義し、その要素型 (`typeof FOO[number]`) を引数に取る関数は、
テスト内のオブジェクトリテラルも `as const` を付けないと型が合わない。

```typescript
// 本体: PROMPT_CATEGORIES は as const → 要素型はリテラル union
const PROMPT_CATEGORIES = [
  { label: '集客・SNS投稿文', emoji: '📣' },
  ...
] as const

export function buildMessage(theme: typeof PROMPT_CATEGORIES[number]) { ... }

// ❌ 誤: as const なし → { label: string; emoji: string } に推論される → TS2345
const theme = { label: '集客・SNS投稿文', emoji: '📣' }
buildMessage(theme) // 型エラー

// ✅ 正: as const でリテラル型に揃える
const theme = { label: '集客・SNS投稿文', emoji: '📣' } as const
buildMessage(theme) // OK
```

**vitest はこの型エラーを無視して通過する。CI（tsc）で初めて落ちるため気づきにくい。**
push 前に必ず `npx tsc --noEmit` を実行すること。

### D1テーブルにカラムを追加したらテスト fixture も全件更新する
TypeScript の型インターフェースにカラムを追加した後、テスト内の定数（`BOOKING1` 等）が
型を満たさなくなり CI が型エラーで落ちる。

```typescript
// ❌ 修正漏れ: 新カラムを追加したのに fixture が古いまま
const BOOKING1: EventBookingRow = {
  id: 1, ..., stripe_session_id: null, paid_at: null, amount: null,
  // stripe_refund_id と refund_status が抜けている → TS2741
}

// ✅ 正: 新カラムを null で追加する
const BOOKING1: EventBookingRow = {
  id: 1, ..., stripe_session_id: null, paid_at: null, amount: null,
  stripe_refund_id: null, refund_status: null,
}
```

対処：`grep -r "EventBookingRow\|BOOKING1\|PENDING_BOOKING" src/` で使用箇所を全列挙し、
`services/events.test.ts` / `routes/events.test.ts` / `routes/stripe.test.ts` を一括確認する。

### LINE SDK メソッドを変えたらルートテストのモックも更新する
`pushTextMessage` → `pushMessage`（または逆方向）の変更でルートテストが落ちる。

```typescript
// ❌ 修正漏れ: routes/events.test.ts が古いモック名を参照したまま
vi.mock('@line-crm/line-sdk', () => ({ LineClient: vi.fn(() => ({ pushTextMessage: mockFn })) }))
expect(mockPushTextMessage).toHaveBeenCalled() // mockPushTextMessage が呼ばれないで素通り

// ✅ 正: ルート実装に合わせてモック名を揃える
vi.mock('@line-crm/line-sdk', () => ({ LineClient: vi.fn(() => ({ pushMessage: mockPushMessage })) }))
expect(mockPushMessage).toHaveBeenCalledWith('U123', expect.arrayContaining([...]))
```

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

## 外部SDKクライアントをサービス関数に渡す場合の型設計

**この問題は Stripe に限らず、SendGrid・Twilio・Google API クライアントなど
クラスベースの外部 SDK を `services/*.ts` に注入する際に必ず発生する。**

### 原則：SDK クラス型ではなくミニマルな構造的インターフェースを定義する

サービス関数（`services/*.ts`）が外部 SDK クライアントを引数に取るとき、
**SDK のクラス型をそのまま引数型にしてはいけない。**

理由：
1. SDK クラスは使わないプロパティを大量に持つため、テストのモックオブジェクトが型を満たせない
2. SDK の返り値には `string | null` など nullable な型が含まれることが多く、
   ad-hoc なインライン型で `string`（null 非許容）と書くと実インスタンスが代入不可になる

**解決策：そのサービス関数が実際に使うメソッドだけを宣言したインターフェースを
services/ ファイル内で定義してエクスポートする。**

TypeScript の構造的部分型により、実インスタンスもモックもどちらも代入可能になる。

```typescript
// ✅ 正: services/events.ts — 使うメソッドだけ宣言
export interface StripeRefundClient {
  checkout: {
    sessions: {
      retrieve(id: string): Promise<{ payment_intent: string | { id?: string } | null }>
    }
  }
  refunds: {
    create(params: { payment_intent: string }): Promise<{ id: string; status: string | null }>
  }
}

export async function cancelEventBooking(
  db: D1Database,
  bookingId: number,
  friendId: string | null,
  stripe: StripeRefundClient,   // ← SDK クラスではなく自前インターフェース
): Promise<...> { ... }

// routes/ 側: 実インスタンスをそのまま渡せる（構造的部分型で互換）
const stripe = new Stripe(env.STRIPE_SECRET_KEY, { ... })
await cancelEventBooking(db, id, friendId, stripe)  // OK

// テスト側: 必要プロパティだけ持つオブジェクトをモックとして渡せる
const mockStripe = {
  checkout: { sessions: { retrieve: vi.fn().mockResolvedValue({ payment_intent: 'pi_xxx' }) } },
  refunds: { create: vi.fn().mockResolvedValue({ id: 're_xxx', status: 'succeeded' }) },
}
await cancelEventBooking(db, 1, null, mockStripe)  // OK
```

### 他 SDK を追加するときも同じパターンを適用する

| SDK | 使いそうなメソッド | インターフェース名の例 |
|-----|--------------------|----------------------|
| Stripe | `checkout.sessions.retrieve` / `refunds.create` | `StripeRefundClient` |
| SendGrid | `send(msg)` | `MailSendClient` |
| Twilio | `messages.create(params)` | `SmsClient` |
| Google Calendar API | `events.insert` / `events.delete` | `CalendarEventsClient` |

### やってはいけないパターン

```typescript
// ❌ SDK クラス型を直接使う → テストモックが代入不可（プロパティが足りない）
async function doSomething(stripe: Stripe) { ... }

// ❌ ad-hoc インライン型で nullable を落とす → 実インスタンスが代入不可
async function doSomething(stripe: {
  refunds: { create(...): Promise<{ id: string; status: string }> }  // string | null が string になっている
}) { ... }

// ❌ import type SDK をそのまま引数型に → routes/ 側は OK だがテストでモックが代入不可
```

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

### Cronトリガーが複数ある場合は event.cron で必ず分岐する（2026-06-05 追記）

新しい cron を `wrangler.toml` に追加するとき、既存の `scheduled()` 処理に
そのまま追記しない。`event.cron` の値で識別し、早期 return で責務を分離する。

```typescript
// ❌ 誤: 既存処理の後ろに追記すると全 cron で実行されてしまう
async function scheduled(...) {
  await processStepDeliveries(...)  // 5分毎処理
  await processWeeklyAiNews(...)    // ← 毎5分実行されてしまう
}

// ✅ 正: cron式で分岐して早期 return
const cronExpr = (_event as unknown as { cron?: string }).cron ?? ''
if (cronExpr === '0 23 * * 0') {
  await processWeeklyAiNewsBroadcast(...)
  return  // 既存の5分毎処理をスキップ
}
// 以降は既存処理
```

### Cloudflare Workers の cron day-of-week に `0`（日曜）を使わない（2026-06-06 追記）

Cloudflare Workers API は cron の曜日フィールドで `0` を不正値として拒否する（error code 10100）。
`SUN` などの名前表記を使うこと。

```toml
# ❌ 誤: 0 = Sunday を数値で指定 → Cloudflare API が "invalid cron string" で拒否
crons = ["0 23 * * 0"]

# ✅ 正: 曜日は SUN / MON / ... の名前表記を使う
crons = ["0 23 * * SUN"]
```

### Google Calendar 連携のエラーハンドリング（2026-06-08 追記）

#### OAuth APIのエラーコードはドメインエラーに変換する

症状: `refreshAccessToken()` が `invalid_grant` を返してもルート層の
`err.message === 'REAUTH_REQUIRED'` チェックに引っかからず、管理者 LINE 通知が無音で消えた。

原因: HTTPエラー時に `res.text()` で汎用メッセージを生成していたため
`invalid_grant` という OAuth 固有のエラーコードが失われた。

```typescript
// ❌ 誤（汎用エラーで上書きする）
const err = await res.text()
throw new Error(`Token refresh failed: ${err}`)

// ✅ 正（JSONをパースして invalid_grant を REAUTH_REQUIRED に変換）
const body = await res.json<{ error?: string }>()
if (body.error === 'invalid_grant') throw new Error('REAUTH_REQUIRED')
throw new Error(`Token refresh failed: ${JSON.stringify(body)}`)
```

#### access_token 直接参照禁止はキャンセル・削除フローにも適用する

既存ルール「access_tokenの直接参照禁止」は booking（予約作成）フローで認識されていたが、
PUT .../status（キャンセル）での `deleteEvent` 呼び出しが漏れていた。

`getValidAccessToken()` を使う場所：`createEvent`・`deleteEvent`・FreeBusy 取得、
**Google Calendar API を呼ぶすべての箇所**が対象。

```typescript
// ❌ 誤（キャンセルフローで直接参照）
const gcal = new GoogleCalendarClient({ calendarId: conn.calendar_id, accessToken: conn.access_token })

// ✅ 正（getValidAccessToken() 経由）
const accessToken = await getValidAccessToken(c.env, c.env.DB, booking.connection_id)
const gcal = new GoogleCalendarClient({ calendarId: conn.calendar_id, accessToken })
```

---

### 本番機能のテストは全体配信せず送信者本人のみに返す（2026-06-05 追記）

broadcast() や全フォロワーへの pushMessage はテスト中に使わない。
キーワードで起動し `replyMessage → pushMessage(userId)` のパターンで
送信者1人にだけ届くようにする。

```typescript
// ❌ 誤: 管理APIエンドポイントで broadcast を呼ぶ（全員に届く）
app.post('/api/admin/test', async (c) => {
  await lineClient.broadcast([message])
})

// ✅ 正: キーワードトリガーで送信者本人にのみ replyMessage → pushMessage
if (incomingText === 'ニューステスト') {
  await lineClient.replyMessage(event.replyToken, [buildMessage('text', '処理中...')])
  replyTokenConsumed = true
  // ...処理...
  await lineClient.pushMessage(userId, [result])
  return
}
```
