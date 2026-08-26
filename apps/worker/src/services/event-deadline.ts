/**
 * イベント申込の締切判定。
 *
 * 締切時刻は start_at から導出する（DB カラムは持たない）。全イベント一律で、
 * イベントごとに変えたくなったらカラム追加＝マイグレーションが必要になる（別 Issue）。
 *
 * NOTE: services/events.ts ではなくこの独立モジュールに置いている。
 * routes/events.test.ts は services/events.js をまるごと vi.mock しているため、
 * そちら側に置くと締切判定そのものがモックされ、ルートのテストで実ロジックを検証できない。
 */

/** 申込を締め切るのは開始の何分前か */
export const APPLICATION_DEADLINE_MINUTES = 60

/**
 * 申込が締め切られているか。
 *
 * start_at は ISO 8601（UTC もしくはオフセット付き）で保存されているため、
 * **epoch 同士で比較する**。ここで JST 変換を挟むと表示側の formatJST と二重変換になる。
 *
 * @param startAt イベント開始時刻（ISO 8601）
 * @param now 比較時刻（epoch ミリ秒）。既定は現在時刻
 */
export function isApplicationClosed(startAt: string, now: number = Date.now()): boolean {
  const startMs = Date.parse(startAt)
  // 日時が壊れているイベントで全申込を止めてしまうほうが事故が大きい。締切扱いにはしない。
  if (Number.isNaN(startMs)) return false
  return now >= startMs - APPLICATION_DEADLINE_MINUTES * 60 * 1000
}
