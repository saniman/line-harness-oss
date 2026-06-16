# セキュリティ調査レポート（2026-06-11）

LINE Harness OSS（Cloudflare Workers + D1 + Next.js）の Worker 層を対象に、
認証・Webhook 検証・公開エンドポイント・データ層を中心としたセキュリティ調査を実施した。

- **調査範囲**: `apps/worker/src/`（routes / middleware / services）、`packages/line-sdk/src/webhook.ts`、`packages/db/src/staff.ts`
- **調査日**: 2026-06-11
- **手法**: 静的コードレビュー（認証フロー・署名検証・IDOR・SQLi・XSS・認可・秘密情報管理の観点）
- **未対応**: 本レポートは調査結果のドキュメント化のみ。コード修正は未着手。

深刻度の凡例: 🔴 High（実害・金銭被害） / 🟠 Medium（認証・認可設計） / 🟡 Low（堅牢化推奨）

---

## サマリ（対応優先順）

| # | 深刻度 | 概要 | 対象 |
|---|--------|------|------|
| 1 | 🔴 High | イベント予約キャンセルの IDOR（他人の予約を強制キャンセル＆返金） | `services/events.ts` `cancelEventBooking` |
| 2 | 🔴 High | Stripe Webhook が secret 未設定でフェイルオープン | `routes/stripe.ts` |
| 3 | 🔴 High | Stripe 署名のタイムスタンプ検証なし（リプレイ可能） | `routes/stripe.ts` `verifyStripeSignature` |
| 4 | 🟠 Medium | クライアント申告の `lineUserId` を未検証（なりすまし） | `routes/events.ts` / `routes/forms.ts` |
| 5 | 🟠 Medium | ロール認可がほぼ無い（最小権限違反） | `middleware/auth.ts` |
| 6 | 🟠 Medium | スタッフ API キーが平文保存 | `packages/db/src/staff.ts` |
| 7 | 🟡 Low | CORS が全ルート `origin: '*'` | `index.ts` |
| 8 | 🟡 Low | レート制限がアイソレートごとのインメモリ | `middleware/rate-limit.ts` |
| 9 | 🟡 Low | LINE 署名比較が非定数時間 | `packages/line-sdk/src/webhook.ts` |
| 10 | 🟡 Low | 画像管理にオーナーシップなし | `routes/images.ts` |

---

## 🔴 High

### 1. イベント予約キャンセルの IDOR（強制返金が可能）

**対象**: `apps/worker/src/services/events.ts` `cancelEventBooking` / `apps/worker/src/routes/events.ts` `POST /api/events/bookings/:id/cancel`

`cancelEventBooking` の所有者チェックは `booking.friend_id` が `null` のとき素通りする。

```ts
if (booking.friend_id !== null && booking.friend_id !== friendId) {
  return { success: false, refunded: false, error: '予約が見つかりませんでした。' }
}
// friend_id が null の予約は誰でも通過する
```

`/api/events/bookings/:id/cancel` は認証スキップ対象（公開エンドポイント）で、`:id` は**連番の整数**。
LINE 未連携で作成された予約（`lineUserId` を渡さず `join` / `checkout-session` した予約は `friend_id = null`）は、
ID を総当たりするだけで第三者がキャンセル可能。さらに `payment_status === 'paid'` なら
**元の支払者に対して Stripe 返金（`refunds.create`）が発火**する。

**影響**: 第三者が `1, 2, 3...` と ID を投げるだけで他人の予約を取り消し＆強制返金できる。金銭被害・予約妨害。

**推奨対処**:
- `friend_id === null` の予約のキャンセル可否ポリシーを明確化する（原則、本人確認できない予約はキャンセル不可にする）。
- 後述 #4 と合わせて `idToken` 検証で「呼び出し元が本当にその LINE ユーザーか」を保証してから friend を解決する。
- 連番整数 ID ではなく推測困難なキャンセルトークン（UUID）を予約に付与し、それを照合する。

---

### 2. Stripe Webhook が secret 未設定でフェイルオープン

**対象**: `apps/worker/src/routes/stripe.ts`（`POST /api/integrations/stripe/webhook`）

```ts
if (stripeSecret) {
  // 署名検証モード（本番環境）
  const valid = await verifyStripeSignature(stripeSecret, rawBody, sigHeader);
  if (!valid) return c.json({ ... }, 401);
} else {
  // シークレット未設定（開発環境向け）
  body = await c.req.json<StripeWebhookBody>();  // ← 検証なしで信用する
}
```

`STRIPE_WEBHOOK_SECRET` が未設定だと署名検証を丸ごとスキップしてボディをそのまま信用する。
本番で secret 設定を忘れる／消える／環境変数が空になると、誰でも `payment_intent.succeeded` を偽造でき、
`applyScoring`・購入タグ付与・`fireEvent('cv_fire')` を発火させられる。

> 補足: もう一方の Stripe Webhook（`routes/stripe.ts` 後半の `constructEventAsync` を使う実装）は
> 署名必須。フェイルオープンするのは `verifyStripeSignature` を使う自前実装の方。

**推奨対処**: 本番では secret 未設定なら **401 で拒否（フェイルクローズ）** にする。
「開発環境はスキップ」を残すなら、明示的な環境フラグ（例: `ENVIRONMENT === 'development'`）でガードし、
本番バインディングでは必ず secret 必須にする。

---

### 3. Stripe 署名のタイムスタンプ検証なし（リプレイ）

**対象**: `apps/worker/src/routes/stripe.ts` `verifyStripeSignature`

```ts
const timestamp = parts.t;
const expectedSig = parts.v1;
if (!timestamp || !expectedSig) return false;
// timestamp は読むだけで現在時刻との差分を検証していない
```

`t=`（タイムスタンプ）をパースするが現在時刻との許容差をチェックしていないため、
過去にキャプチャした正規 Webhook をそのまま再送できる。
`getStripeEventByStripeId` による冪等チェックが同一 `event.id` の再処理は防ぐが、
防御は署名検証側（タイムスタンプ許容ウィンドウ）でも行うべき。

**推奨対処**: Stripe 公式に倣い、`Math.abs(now - timestamp) > 300`（5分）なら拒否する。

---

## 🟠 Medium

### 4. クライアント申告の `lineUserId` を未検証（なりすまし）

**対象**: `routes/events.ts`（`join` / `checkout-session` / `cancel`）、`routes/forms.ts`（`submit`）

これらの公開エンドポイントは、リクエストボディ/ヘッダの `lineUserId` を**そのまま** friend 解決に使う。

```ts
// routes/events.ts
const body = await c.req.json<{ lineUserId?: string; ... }>();
// → friends WHERE line_user_id = ? で friend を解決（本人確認なし）
```

**正しい実装の参考**: `/api/liff/link`・`/api/liff/send-form-link`（`routes/liff.ts:850` 付近）は
`idToken` を LINE の検証エンドポイント（`https://api.line.me/oauth2/v2.1/verify`）に投げて検証している。

**影響**: 他人の LINE ユーザー ID を知っていれば、その人として予約・申込・（#1 と組み合わせて）キャンセルが可能。

**推奨対処**: イベント・フォーム系も `idToken` 検証を必須化し、`liff.getIDToken()` の値を
サーバ側で検証してから friend を解決する。`routes/liff.ts` の既存実装を共通化して流用する。

---

### 5. ロールによる認可がほぼ無い（最小権限違反）

**対象**: `apps/worker/src/middleware/auth.ts`

`authMiddleware` は「有効な API キーが存在するか」だけを検証し、ロール（owner/admin/staff）を区別しない。
`role-guard.ts`（`requireRole` 系）は `routes/staff.ts`・`routes/line-accounts.ts` の2ファイルでしか使われておらず、
`DELETE /api/events`・`broadcasts`・`friends` 削除などの破壊的操作は**最下位の staff ロールでも実行可能**。

**推奨対処**: 破壊的・全体配信系のルート（削除・broadcast・アカウント設定変更）に
`requireRole('admin')` 相当のガードを付与する。

---

### 6. スタッフ API キーが平文保存

**対象**: `packages/db/src/staff.ts`

```ts
.prepare('SELECT * FROM staff_members WHERE api_key = ? AND is_active = 1')
.bind(apiKey)
```

API キーは平文で D1 に保存され、平文比較される。env オーナーキー（`API_KEY`）も
`token === c.env.API_KEY` の平文比較。D1 のバックアップ／ダンプが流出すると全キーが即利用可能になる。

**推奨対処**: キーは SHA-256 等でハッシュ化して保存し、検証時はハッシュ照合＋定数時間比較にする。
キー本体は発行時に一度だけ平文表示し、DB には保持しない。

---

## 🟡 Low

### 7. CORS が全ルート `origin: '*'`

**対象**: `apps/worker/src/index.ts`

```ts
app.use('*', cors({ origin: '*' }));  // 認証ルートを含む全ルートで全オリジン許可
```

現状は Bearer トークン認証（Cookie 非依存）のため即時被害は小さいが、認証ルートまで全オリジン許可になっている。
将来 Cookie 認証を導入すると CSRF 面で危険。

**推奨対処**: `/api/*`（管理画面用）は管理画面オリジンに限定し、
LIFF 向け公開エンドポイントのみ広いオリジンを許可する、とポリシーを分ける。

### 8. レート制限がアイソレートごとのインメモリ

**対象**: `apps/worker/src/middleware/rate-limit.ts`（冒頭コメントで自認済み）

カウンタは Worker アイソレートのメモリに保持され、複数アイソレート／コールドスタートで分散する。
実効上限が設定値より大きくなり、本気の DoS・総当たり（#1 の ID 総当たり等）には弱い。

**推奨対処**: Cloudflare Rate Limiting Rules、または KV / Durable Objects ベースの分散カウンタを検討。

### 9. LINE 署名比較が非定数時間

**対象**: `packages/line-sdk/src/webhook.ts`（コメントで自認済み）

```ts
return computedBase64 === signature;  // 早期 exit する文字列比較
```

同一長の base64 同士の比較で実害は低いが、`crypto.subtle` を使った定数時間比較に寄せると堅牢。

### 10. 画像管理にオーナーシップなし

**対象**: `apps/worker/src/routes/images.ts`

`DELETE /api/images/:key` は認証は必要だが、任意のスタッフが任意キーを削除できる（所有者・参照整合チェックなし）。

---

## 確認した結果、問題なかった点

- **SQL インジェクション**: routes / services 層は全てプリペアドステートメント（`.bind()`）。
  テンプレートリテラルでの SQL 直挿しは検出されず。
- **`/r/:ref` ランディング HTML**: `ref` 等は `URLSearchParams` 経由でエンコードしてから埋め込まれており、反射 XSS は回避。
- **`/api/qr` プロキシ**: 転送先ホストはハードコード（`api.qrserver.com`）で SSRF にはならない。
- **LINE Webhook**: 署名前の長さ事前チェック・1 MiB ボディ上限により DoS 対策あり（`routes/webhook.ts`）。
- **Stripe Webhook（`constructEventAsync` 版）**: raw ボディ取得＋署名検証＋冪等チェックが適切。

---

## 対応ロードマップ（推奨）

1. **#1 / #4** — 公開エンドポイントの IDOR・なりすまし。`idToken` 検証導入と
   `friend_id === null` 予約のキャンセルポリシー明確化（金銭被害＋なりすまし、最優先）。
2. **#2 / #3** — Stripe Webhook のフェイルクローズ化＋タイムスタンプ許容チェック。
3. **#5 / #6** — 破壊的ルートへの `requireRole` 付与、API キーのハッシュ化。
4. **#7〜#10** — CORS ポリシー分離・分散レート制限・定数時間比較などの堅牢化。
