# 飲食店モバイルオーダー セットアップ手順書

店内テーブルオーダー（QR読取 → LIFF注文 → 厨房ディスプレイ）の構成・API・運用設定をまとめる。
決済は **店頭/現金併用**（Stripe 非依存）。

## 全体フロー

```
お客様: 卓上QR読取 → LIFF起動(?page=order&table=<qr_token>) → 友だち追加(必須)
        → メニュー → オプション → カート → 注文確定
                              ↓ POST /api/liff/order/orders（id_token 認証・冪等）
厨房:   管理画面「厨房ディスプレイ」が5秒ポーリング → 新規/調理中/提供済み
        → 調理開始 → 提供完了 → 会計完了（served→closed で payment=paid）
会計:   レジ（店頭）で精算
```

## アーキテクチャ / 実装場所

| レイヤ | 場所 |
|--------|------|
| DBスキーマ | `packages/db/migrations/809_mobile_order.sql`（schema.sql 同期済み） |
| サービス（純粋ロジック+DB） | `apps/worker/src/services/orders.ts` |
| 本人確認/friend解決（共有） | `apps/worker/src/services/liff-identity.ts` |
| API ルート | `apps/worker/src/routes/orders.ts` |
| 厨房ディスプレイ（管理画面） | `apps/web/src/app/orders/page.tsx` ＋ `apps/web/src/lib/orders.ts` |
| LIFF注文クライアント | `apps/worker/src/client/order/`（React, `?page=order` で main.ts が dispatch） |
| 営業デモ（自己完結） | `demo/mobile-order/index.html` |

設計方針: 既存の `menus` テーブルを**商品マスタとして再利用**（飲食では `duration_minutes=0`）。
salon-booking と同じ LIFF パターン（`/api/liff/` で auth スキップ・id_token verify・friend ゲート）。
menus は salon と共用のため `menu_type`（'salon'/'food', migration 810）で分離。
注文側は `'food'`、サロン予約側（booking.ts の LIFF/admin）は `'salon'` で必ず絞る。

## データモデル（migration 809 / 810）

- `dining_tables` … テーブル登録。`qr_token`（推測困難）を QR/LIFF URL に埋め込む
- `menu_options` … サイズ・トッピング等（`menus` を親に FK）
- `menus.menu_type` … 'salon' / 'food' の判別列（810。既存は 'salon' 既定）
- `orders` … 注文ヘッダ。`status`(new/preparing/served/closed/cancelled) / `payment_status`(unpaid/paid)
- `order_items` … 注文時点の商品名・単価・オプションをスナップショット保存

注文ステータス遷移: `new → preparing → served → closed`（+ `cancelled`）。
**価格はクライアント申告を信用せず、サーバーが menus/menu_options から再計算する**。

## API エンドポイント

### LIFF（公開・`/api/liff/` で auth スキップ）
| メソッド | パス | 認証 | 備考 |
|---|---|---|---|
| GET | `/api/liff/order/menu?liffId=` | なし | オプション込みメニュー（`menu_type='food'` のみ） |
| POST | `/api/liff/order/orders?liffId=` | `Authorization: Bearer <id_token>` | **友だち登録必須**(403 friend_required) / `Idempotency-Key` / body `{table_token, items, customer_note}` |
| GET | `/api/liff/order/me?liffId=&table=` | `Authorization: Bearer <id_token>` | 自分の注文履歴（現在のテーブル分）。友だち未登録は空配列 |

### 管理（staff/owner 認証）
| メソッド | パス | 備考 |
|---|---|---|
| GET | `/api/order/admin/orders?status=active｜all｜new,preparing` | 厨房一覧（既定 active=new+preparing） |
| PUT | `/api/order/admin/orders/:id/status` | body `{status}`。遷移可否をサーバー検証。served→closed で paid 記録 |
| GET/POST | `/api/order/admin/tables` | テーブル一覧 / 追加（qr_token 自動採番） |
| DELETE | `/api/order/admin/tables/:id` | テーブル削除（account スコープ） |
| GET | `/api/order/admin/tables/:id/orders` | 伝票確認: そのテーブルの注文一覧（キャンセル除く・新しい順） |

### UI 機能
- 厨房ディスプレイ（管理画面 `/orders`）: 5秒ポーリングの3カラム（新規/調理中/提供済み）。
  テーブル管理パネルで QR発行・**LIFF注文URL表示/コピー・削除・伝票確認**。
- LIFF注文クライアント: メニュー→カート→注文。ヘッダの**注文履歴ボタンでこれまでの合計と状況**を確認可能。

## デプロイ

`git push origin main` で CI が自動デプロイ（Worker / Web / LIFF が path filter で発火）。
- **CI のマイグレーション自動適用**: `deploy-worker.yml` が deploy 前に `d1 migrations apply --remote` を実行。
  これには `CLOUDFLARE_API_TOKEN` に **D1:Edit 権限**が必要（無いと `code: 7403` で deploy がブロックされる）。

## 運用に必要なセットアップ（コード実装後に必要）

1. **メニュー投入** — 管理画面「メニュー」or `menus` に商品（飲食は `duration_minutes=0`）。
   オプションは `menu_options`（現状 admin UI 未実装＝SQL直）。
2. **テーブル登録** — 厨房ディスプレイ画面の「テーブル管理（QR発行）」で卓を追加。
   発行された `qr_token` を `https://liff.line.me/<LIFF_ID>?page=order&table=<qr_token>` の QR にして卓上へ。
3. **LINE Login 設定** — 注文LIFFは `getFriendship()` / `getIDToken()` を使うため、
   Login チャネルに **bot リンク** と LIFF に **`openid` スコープ**が必要（`.claude/rules/liff.md` 参照）。

## 未実装（今後）
- 注文確定時の LINE push 通知（顧客/店舗）
- `menu_options` の管理 UI
- 厨房のリアルタイム化（現状ポーリング → 必要なら Durable Objects + WebSocket）
