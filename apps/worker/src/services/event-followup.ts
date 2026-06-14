/**
 * イベント参加者アフターフォロー自動シナリオ
 *
 * イベントの参加/決済が確定したタイミングで、`trigger_type = 'event_booking'` の
 * アクティブなシナリオに友だちを自動登録する。
 * 「翌日お礼 → 3日後アンケート → 7日後 関連イベント/相談案内」のような
 * ステップ配信を、既存の friend_scenarios 配信エンジンに載せる起点となる。
 *
 * 設計はフォロー時の friend_add 自動登録（routes/webhook.ts）と同じ方針:
 * - is_active なシナリオのみ対象
 * - line_account_id が一致（またはどちらか未設定）のシナリオのみ対象
 * - enrollFriendInScenario の INSERT OR IGNORE で重複登録を防止
 */

import { getScenarios, enrollFriendInScenario } from '@line-crm/db';

/**
 * イベント確定時にアフターフォローシナリオへ登録する。
 *
 * @param db        D1
 * @param friendId  対象の友だちID（null の場合は何もしない）
 * @param eventStartAt イベントの開催日時(start_at, ISO)。開催日アンカー配信の起点になる。
 *                     null の場合はステップの相対遅延(delay_minutes)で配信される。
 * @param lineAccountId 確定が起きた LINE アカウントID（マルチアカウント絞り込み用）
 * @returns 新規に登録できたシナリオ数
 */
export async function enrollEventFollowupScenarios(
  db: D1Database,
  friendId: string | null,
  eventStartAt: string | null,
  lineAccountId?: string | null,
): Promise<number> {
  // friend_id が紐付かない予約（LIFF外決済など）はフォロー対象にできない
  if (!friendId) return 0;

  const scenarios = await getScenarios(db);
  let enrolled = 0;

  for (const scenario of scenarios) {
    // このアカウントのシナリオのみ起動（未割り当てシナリオは後方互換で全アカウント対象）
    const accountMatch =
      !scenario.line_account_id || !lineAccountId || scenario.line_account_id === lineAccountId;

    if (scenario.trigger_type !== 'event_booking' || !scenario.is_active || !accountMatch) {
      continue;
    }

    // INSERT OR IGNORE が UNIQUE(friend_id, scenario_id) で重複を弾く。
    // 既に登録済みなら null が返るのでカウントしない。
    // eventStartAt を渡すと、開催日アンカー設定のステップが開催日基準で配信される。
    const friendScenario = await enrollFriendInScenario(db, friendId, scenario.id, eventStartAt);
    if (friendScenario) enrolled++;
  }

  return enrolled;
}

/**
 * 特定イベントの確定参加者全員を、指定シナリオへ開催日アンカーで一括登録する。
 *
 * 自動登録（予約確定時）と違い、すでに申込済みの既存参加者を後から登録できる。
 * 管理画面の「参加者を一括登録」ボタンから呼ばれる。
 *
 * @returns eventFound: イベントが存在したか / total: 確定参加者数 / enrolled: 新規登録できた数
 */
export async function enrollEventParticipants(
  db: D1Database,
  eventId: number,
  scenarioId: string,
): Promise<{ eventFound: boolean; total: number; enrolled: number }> {
  const event = await db
    .prepare('SELECT start_at FROM events WHERE id = ?')
    .bind(eventId)
    .first<{ start_at: string }>();
  if (!event) return { eventFound: false, total: 0, enrolled: 0 };

  // 確定参加者（friend_id 紐付きのみ）を重複排除して取得。participant_count と同じ status='confirmed' 基準。
  const rows = await db
    .prepare(
      "SELECT DISTINCT friend_id FROM event_bookings WHERE event_id = ? AND status = 'confirmed' AND friend_id IS NOT NULL",
    )
    .bind(eventId)
    .all<{ friend_id: string }>();

  let enrolled = 0;
  for (const row of rows.results) {
    // INSERT OR IGNORE が重複登録を弾く。既に登録済みなら null が返る。
    const friendScenario = await enrollFriendInScenario(db, row.friend_id, scenarioId, event.start_at);
    if (friendScenario) enrolled++;
  }

  return { eventFound: true, total: rows.results.length, enrolled };
}
