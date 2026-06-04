# エージェント協議：WALOVER LINE 次のアクション決定（2026-06-04）

## 背景・問いかけ

「オーケストラとエージェントで話し合って、WALOVERがLINEで次にやるべきアクションを決めることはできますか？」という問いに対し、orchestrator が crm-analyst・event-manager を並列召喚して実データを分析、message-optimizer まで連鎖させて集客メッセージ文案まで生成した。

---

## orchestrator の判断

- モード A（ドメイン直接対応）× 2 エージェント並列
- crm-analyst → 友だち・配信・コンバージョンの現状把握
- event-manager → イベント・予約・キャンセルの現状把握
- orchestrator（Claude）が両レポートを統合して優先順位付け

---

## crm-analyst レポート（要約）

### 現状
| 指標 | 状態 |
|------|------|
| 友だち数 | 少数・直近1ヶ月の新規登録ゼロ |
| 配信ログ | sent 済みでも messages_log が空（到達確認不可） |
| スコアリング | 未設定・全員スコア 0 |
| ドラフト配信 | 2件放置（「プロンプト紹介」target:all、「AIざっくばらん会フォローメール 2」target:tag） |
| シナリオ | 未設定 |

### crm-analyst が提案した次のアクション
1. messages_log の記録が機能しているか調査・修正
2. スコアリングルールを設定して lead_scores を有効化
3. ドラフト配信を完成・送信してエンゲージメント測定
4. 新規友だち獲得施策の設計（月次目標設定）
5. pending 予約の離脱原因調査と決済完了率改善

---

## event-manager レポート（要約）

### 現状
| 指標 | 状態 |
|------|------|
| 公開中イベント | 1件（Claude Code もくもく会 / 06/13(土) 14:00〜17:00 / ¥1,000） |
| 確定参加者 | 定員に対して少数・残席あり |
| pending 予約 | 多数・最古は約19日前（Stripe Session 失効済み） |
| 直近キャンセル | オーナーによるテスト操作（実態ではない） |

### event-manager が提案した次のアクション
1. **pending 予約のクリーンアップ**（優先度: 高）
   - Stripe Session 失効済みの pending を `cancelled` に一括更新
   - 根本対策: `checkout.session.expired` Webhook を `stripe.ts` に追加
2. **「Claude Code もくもく会」の集客強化**（優先度: 中）
   - 開催10日前・残席あり → ブロードキャストで告知
3. キャンセルポリシーの整備・フィードバック収集フローの検討

---

## orchestrator 統合：優先アクション

### 🔴 今すぐ
| # | アクション | 担当エージェント |
|---|-----------|----------------|
| 1 | pending 予約クリーンアップ | event-manager |
| 2 | 「Claude Code もくもく会」集客ブロードキャスト送信 | message-optimizer |

### 🟡 今週中
| # | アクション | 担当エージェント |
|---|-----------|----------------|
| 3 | messages_log 記録の調査・修正 | booking-debugger |
| 4 | 返金済み予約の通知確認（id:21・22） | event-manager |

### 🟢 来週以降
| # | アクション | 担当エージェント |
|---|-----------|----------------|
| 5 | スコアリングルール設定 | crm-analyst |
| 6 | 新規友だち獲得施策の設計 | crm-analyst |
| 7 | Stripe checkout.session.expired Webhook 追加 | event-manager |

---

## message-optimizer 出力：集客メッセージ文案

### パターン1：テキストメッセージ

```
message_type: text
target_type: all
```

```
Claude Code もくもく会 開催します！ 🛠️

先日の AIざっくばらん会 に続き、今度は手を動かす回です。
Claude Code を使ってそれぞれの作業を進めながら、気になったことを共有し合いましょう。

◾ 日時：6月13日(土) 14:00〜17:00
◾ 参加費：¥1,000
◾ 残席わずか

▼ お申込みはこちら
https://liff.line.me/1661159603-5qlDj5wV?page=event&id=2

ご参加お待ちしています！
```

### パターン2：Flex メッセージ

```
message_type: flex
target_type: all
alt_text: Claude Code もくもく会 6/13(土)14:00〜 残席わずか 参加費¥1,000
```

```json
{
  "type": "bubble",
  "header": {
    "type": "box", "layout": "vertical", "paddingAll": "16px",
    "backgroundColor": "#06C755",
    "contents": [{ "type": "text", "text": "Claude Code もくもく会",
      "color": "#ffffff", "weight": "bold", "size": "md", "wrap": true }]
  },
  "body": {
    "type": "box", "layout": "vertical", "paddingAll": "16px", "spacing": "sm",
    "contents": [
      { "type": "text", "text": "AIざっくばらん会の続きで、今度は手を動かす回です。",
        "size": "sm", "color": "#333333", "wrap": true },
      { "type": "separator", "margin": "md" },
      { "type": "box", "layout": "vertical", "margin": "md", "spacing": "sm",
        "contents": [
          { "type": "box", "layout": "horizontal", "contents": [
            { "type": "text", "text": "日時", "size": "sm", "color": "#999999", "flex": 2 },
            { "type": "text", "text": "6/13(土) 14:00〜17:00", "size": "sm", "color": "#333333", "flex": 5, "wrap": true }
          ]},
          { "type": "box", "layout": "horizontal", "contents": [
            { "type": "text", "text": "参加費", "size": "sm", "color": "#999999", "flex": 2 },
            { "type": "text", "text": "¥1,000", "size": "sm", "color": "#333333", "flex": 5 }
          ]},
          { "type": "box", "layout": "horizontal", "contents": [
            { "type": "text", "text": "残席", "size": "sm", "color": "#999999", "flex": 2 },
            { "type": "text", "text": "残席わずか", "size": "sm", "color": "#06C755", "flex": 5, "weight": "bold" }
          ]}
        ]
      }
    ]
  },
  "footer": {
    "type": "box", "layout": "vertical", "paddingAll": "12px",
    "contents": [{
      "type": "button",
      "action": { "type": "uri", "label": "申込む（¥1,000）",
        "uri": "https://liff.line.me/1661159603-5qlDj5wV?page=event&id=2" },
      "style": "primary", "height": "sm", "color": "#06C755"
    }]
  }
}
```

### optimizer の推奨戦略
- 初回告知（今すぐ）→ Flex メッセージ
- 前日リマインド（6/12）→ テキストメッセージ
- 「プロンプト紹介」ドラフトとは別便で送る（同時送信は避ける）

---

## Note 記事ドラフト

タイトル案：
1. 「LINE、次に何をすればいい？」AIに聞いたら、データを見て全部答えてくれた話
2. AIエージェントに会社のLINEを分析させたら、集客メッセージまで出てきた
3. 「次の投稿どうしよう」を卒業した日 ーAIエージェントとLINE運用の話

対象読者：沖縄の中小企業経営者・20代女性含む一般ユーザー
公開範囲：全ユーザー（実数値は非掲載）

本文（ドラフト）→ 別途 Word / Google ドキュメント等で編集推奨

---

## この協議から得られた知見

1. **エージェント並列召喚の有効性**
   crm-analyst と event-manager を同時起動することで、マーケティング視点とオペレーション視点を同時に取得できた。逐次実行より文脈が分散せず、統合もしやすかった。

2. **「データに基づく提案」の信頼性**
   D1 の実データを直接クエリするため、推測ではなく事実ベースのアクションが出る。「友だちが増えていない」「ログが取れていない」といった見落としがちな問題も検出できた。

3. **messages_log の空問題は要調査**
   sent 済み配信にもかかわらず messages_log が空。これは配信効果の永続的な計測不能につながるため、優先度高で対処が必要。

4. **message-optimizer の出力品質**
   既存の関係性（AIざっくばらん会参加者）を文脈として与えることで、ブランドトーンと一致した文案が一発で出た。ボタンラベルへの価格埋め込みなど、LINEの UX 固有の配慮も自動でされていた。
