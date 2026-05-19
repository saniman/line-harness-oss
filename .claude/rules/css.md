# CSSコーディングルール（index.html）

## DRY原則

同じスタイルが **3箇所以上** 登場したら共通クラスとして `index.html` に定義する。
共通クラスの名前は「共通スタイルだと一目でわかる名前」にする（`btn-pink`、`panel` など）。
TypeScript で生成する HTML テンプレートにも必ず共通クラスを付与すること。

---

## 共通ユーティリティクラス一覧

### `.btn-pink` — ピンクグラデーション CTA ボタン（全幅）

| プロパティ | 値 |
|-----------|-----|
| background | `linear-gradient(135deg, #ff6b9d 0%, #ff4176 100%)` |
| box-shadow | `0 6px 20px rgba(255, 65, 118, 0.4)` |
| border-radius | `12px` |
| padding | `16px` |
| font-size | `17px` |
| color | `#fff` |

**使用箇所（class 属性に必ず含める）:**
- `.event-join-btn` — イベント一覧の申し込みボタン（追加で padding/size を上書き）
- `#checkout-btn` — 有料イベントの決済ボタン
- `#free-join-btn` — 無料イベントのワンクリック申し込みボタン

**個別クラスで上書きするプロパティ:**
```css
/* リスト用（小さめサイズ） */
.event-join-btn {
  padding: 14px;
  border-radius: 10px;
  font-size: 16px;
  box-shadow: 0 4px 12px rgba(255, 65, 118, 0.35);
}
```

---

### `.panel` — 白カードコンテナ

| プロパティ | 値 |
|-----------|-----|
| background | `#fff` |
| border-radius | `12px` |
| box-shadow | `0 2px 8px rgba(0,0,0,0.08)` |

**使用箇所（class 属性に必ず含める）:**
- `.event-card` — イベント一覧カード
- `.event-detail` — イベント詳細カード（border-radius は 16px に上書き）
- `.done-card` — 申し込み完了カード（border-radius は 16px に上書き）
- `.cancel-card` — キャンセルカード（border-radius は 16px に上書き）

---

## カラーパレット

| 用途 | 値 |
|-----|-----|
| LINE 公式グリーン | `#06C755` |
| ピンクグラデーション（開始） | `#ff6b9d` |
| ピンクグラデーション（終了） | `#ff4176` |
| テキスト（主） | `#222` / `#333` |
| テキスト（補足） | `#666` |
| テキスト（薄め） | `#999` / `#bbb` |
| ボーダー | `#e0e0e0` / `#f0f0f0` |
| 入力背景 | `#fafafa` / `#f8f8f8` |

---

## HTML テンプレート（TypeScript 生成）のルール

- **JS フック用 `id` は変えない**（`id="checkout-btn"`, `id="free-join-btn"` など）
- **CSS クラスは「共通クラス＋固有クラス」の組み合わせにする**
  ```html
  <!-- ○ 共通クラスが先、固有クラスが後 -->
  <div class="event-card panel">
  <button class="event-join-btn btn-pink">
  ```
- **固有クラスだけで共通スタイルを重複定義しない**（`.btn-pink` が担う部分を再定義しない）
- **削除した UI 要素の CSS はデッドコードとして即削除する**
  （例: フォームを削除したら `#free-join-form`、`.join-input` の CSS も同時に消す）

---

## 禁止パターン（共通クラスで代替すること）

```css
/* ✗ 直接書かない → .btn-pink を使う */
background: linear-gradient(135deg, #ff6b9d 0%, #ff4176 100%);

/* ✗ 直接書かない → .panel を使う */
background: #fff;
border-radius: 12px;
box-shadow: 0 2px 8px rgba(0,0,0,0.08);
```
