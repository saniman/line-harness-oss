---
name: feature-plan
description: 機能の説明から調査・計画を作り、GitHub Issue（本文=計画）を作成する。パイプラインの起点。
argument-hint: "<実装したい機能の説明>"
---

引数 `$ARGUMENTS` を「これから実装したい機能」として、調査と計画を行い、GitHub Issue を作成してください。
これは開発パイプラインの起点です（全体像は `docs/dev-workflow.md`）。

## 手順

### 1. 調査（推測で進めない）
- 既存コードに再利用できる関数・パターンがないか `grep`/Read で調べる（**新規より再利用を優先**）。
- 該当領域の `.claude/rules/*` を物差しにする（API=`api-coding.md`・LIFF=`liff.md`・LINE通知=`line-messaging.md`・デプロイ=`deployment.md`・CSS=`css.md`）。
- DB スキーマ変更を伴いそうなら `.claude/rules/migrations.md`（800番台の採番）と `packages/db/MIGRATIONS.md` を確認する。
- 外部SDK（Stripe・LINE・Google Calendar）連携なら `.claude/rules/api-coding.md` の該当インターフェース設計・落とし穴を確認する。

### 2. 計画ドラフト → 自己レビュー（ここで一度「確認・修正」する）
- 設計方針＋**導線（どこから来てどこへ行くか）**を書く。
- ドラフトを自分で一度レビューし、穴（エラー処理・後方互換・JST変換・auth skip リスト・LIFF クロスオリジン・テスト fixture 更新）を埋める。
- **完了条件は事業成果まで辿る**（アプリ内部のステップでなく、友だちが予約完了/決済完了する等の最終成果まで）。
- ユーザーに見える変更（LIFF UI・LINE 通知文言）なら、その更新も計画に含める。

### 3. Issue を作成
- 本文をスクラッチパッドの一時ファイルに書き、`gh issue create -R saniman/line-harness-oss --title "<簡潔なタイトル>" --body-file <一時ファイル>` で作成する。
  （**fork なので `-R saniman/line-harness-oss` 必須**。無いと upstream 側に作られる/404 になる）
- 本文は `.github/ISSUE_TEMPLATE/feature.md` と同じ構造にする：

```
## 背景・目的
（なぜ必要か）

## スコープ
（やること）

## スコープ外
（やらないこと）

## 計画（設計方針・導線）
（設計・導線・再利用する既存実装）

## 変更ファイル（見込み）
（新規/変更の見込み。DB変更ならマイグレーション番号も）

## 検証
（vitest / tsc / LIFF client 型検査・実機スモークなど）
```

### 4. 人間チェックポイントで停止（重要）
- 作成した Issue 番号と URL を出力する。
- **ここで止める。勝手に実装に進まない**（Harness Engineering＝最終判断は人間）。
- 「Issue の計画を確認・編集し、問題なければ `/feature-implement <issue#>` を実行してください」と案内する。

## 注意
- 不明点・判断が割れる点があれば、Issue を作る前に質問する（推測で本文を埋めない）。
- スコープ判断・優先度・ビジネス判断は常に人間が決める。
