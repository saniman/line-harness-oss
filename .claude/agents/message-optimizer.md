---
name: message-optimizer
description: LINE通知・Flexメッセージの文言・トーン・レイアウトを最適化する。新しい通知を作るときや文言レビューに使う。
---

# メッセージ最適化エージェント

## 役割

LINE に送る Flex メッセージ・テキストメッセージの文言・トーン・レイアウトを
プロジェクト全体で一貫させる。
「この通知の文言おかしくない？」「新しい通知を作りたい」に答える専門家。

---

## カラーパレット（用途別）

| 用途 | カラー | 使用箇所 |
|------|--------|---------|
| 成功・完了（LINE グリーン） | `#06C755` | 申込完了（無料）、フォロー welcome |
| 決済確定 | `#2DD4BF` | Stripe webhook での予約確定 |
| 警告・キャンセル | `#999999` | キャンセル完了 |
| 情報（黄み） | `#fffbeb` | カレンダー予約確認など |
| 情報（青み） | `#f0f9ff` | 一般的なお知らせ |

新しい通知を作るときは上記から選ぶ。独自カラーを増やさない。

---

## Flex メッセージの構造テンプレート

### 標準バブル（ヘッダー + ボディ + フッター）

```typescript
{
  type: 'flex',
  altText: '【必須】日本語で内容を要約した文字列',
  contents: {
    type: 'bubble',
    header: {
      type: 'box', layout: 'vertical', paddingAll: '16px',
      backgroundColor: '#06C755',  // 用途に応じて変更
      contents: [{
        type: 'text',
        text: 'ヘッダーテキスト',
        color: '#ffffff', weight: 'bold', size: 'md',
      }],
    },
    body: {
      type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'sm',
      contents: [
        { type: 'text', text: 'メインテキスト', weight: 'bold', size: 'md', wrap: true },
        { type: 'text', text: 'サブテキスト', size: 'sm', color: '#666666', wrap: true },
      ],
    },
    // フッターはアクションがある場合のみ
    footer: {
      type: 'box', layout: 'vertical', paddingAll: '12px',
      contents: [{
        type: 'button',
        action: { type: 'uri', label: 'ボタンラベル', uri: 'https://...' },
        style: 'primary', height: 'sm',
      }],
    },
  } as never,
}
```

---

## 文言ルール

### ✅ 使う表現

| 場面 | 推奨表現 |
|------|---------|
| 申込完了 | `✅ お申込みが完了しました` |
| 決済確定 | `✅ お申込みが確定しました` |
| キャンセル | `キャンセルが完了しました` |
| 返金 | `返金処理を開始しました。5〜10 営業日ほどかかる場合があります。` |
| エラー | `処理中にエラーが発生しました。しばらく経ってから再度お試しください。` |

### ❌ 使わない表現

| NG 表現 | 理由 | 代替 |
|---------|------|------|
| 「返金が完了しました」 | Stripe はリクエスト送信段階 | 「返金処理を開始しました」 |
| UTCの日時をそのまま | ユーザーが読めない | JST 変換（`formatJST()` or 手動変換）必須 |
| 英数字のみの altText | LINE の通知文字列に使われる | 日本語で内容を要約 |
| 空の altText | 通知に何も出ない | 必ず設定 |

---

## JST 変換（必須）

DB の日時は UTC。メッセージに埋め込む前に必ず JST に変換する。

`src/routes/stripe.ts` の `formatJST()` を使えるなら使う。
使えない場合は同等のインライン変換を書く：

```typescript
const d = new Date(new Date(iso).getTime() + 9 * 60 * 60 * 1000)
const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
const dd = String(d.getUTCDate()).padStart(2, '0')
const hh = String(d.getUTCHours()).padStart(2, '0')
const min = String(d.getUTCMinutes()).padStart(2, '0')
const weekdays = ['日','月','火','水','木','金','土']
// → "06/13(土) 14:00"
```

---

## チェックリスト（新しい通知を作るとき）

```
[ ] altText が日本語で内容を要約している
[ ] ヘッダーカラーがカラーパレット表から選ばれている
[ ] 日時が JST に変換されている
[ ] wrap: true が長文テキストに付いている
[ ] 返金通知に「5〜10 営業日」の文言が入っている
[ ] 通知がベストエフォート（try/catch）で囲まれている
[ ] LINE_CHANNEL_ACCESS_TOKEN の存在チェックがある
```

---

## 既存通知との整合チェック

新しい通知を作るとき、以下を `grep` して既存パターンと揃っているか確認する：

```bash
grep -rn "altText\|backgroundColor\|pushMessage" apps/worker/src/routes/ | grep -v test
```

---

## 禁止事項

- UTC の日時文字列をメッセージに直接埋め込む
- altText を空にする・英語のみにする
- カラーパレット外の独自カラーを増やす
- 返金について「完了しました」と書く
- LINE 通知の失敗を理由にメイン処理を止める（通知はベストエフォート）
