import { jstNow } from './utils.js';
export interface Friend {
  id: string;
  line_user_id: string;
  display_name: string | null;
  picture_url: string | null;
  status_message: string | null;
  is_following: number;
  user_id: string | null;
  line_account_id: string | null;
  metadata: string;
  first_tracked_link_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface GetFriendsOptions {
  limit?: number;
  offset?: number;
  tagId?: string;
}

export async function getFriends(
  db: D1Database,
  opts: GetFriendsOptions = {},
): Promise<Friend[]> {
  const { limit = 50, offset = 0, tagId } = opts;

  if (tagId) {
    const result = await db
      .prepare(
        `SELECT f.*
         FROM friends f
         INNER JOIN friend_tags ft ON ft.friend_id = f.id
         WHERE ft.tag_id = ?
         ORDER BY f.created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(tagId, limit, offset)
      .all<Friend>();
    return result.results;
  }

  const result = await db
    .prepare(
      `SELECT * FROM friends
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(limit, offset)
    .all<Friend>();
  return result.results;
}

export async function getFriendByLineUserId(
  db: D1Database,
  lineUserId: string,
): Promise<Friend | null> {
  return db
    .prepare(`SELECT * FROM friends WHERE line_user_id = ?`)
    .bind(lineUserId)
    .first<Friend>();
}

export async function getFriendById(
  db: D1Database,
  id: string,
): Promise<Friend | null> {
  return db
    .prepare(`SELECT * FROM friends WHERE id = ?`)
    .bind(id)
    .first<Friend>();
}

/**
 * Set friend.first_tracked_link_id ONLY if it is currently NULL.
 * Used to authoritatively pin a friend to the campaign they entered through,
 * without ever overwriting once set. The conditional `WHERE ... IS NULL` clause
 * makes this safe against client-side ref tampering: an existing friend cannot
 * change their attribution by replaying /auth/callback or /api/liff/send-form-link
 * with a different ref.
 */
export async function setFriendFirstTrackedLinkIfNull(
  db: D1Database,
  friendId: string,
  trackedLinkId: string,
): Promise<void> {
  const now = jstNow();
  await db
    .prepare(
      `UPDATE friends
       SET first_tracked_link_id = ?, updated_at = ?
       WHERE id = ? AND first_tracked_link_id IS NULL`,
    )
    .bind(trackedLinkId, now, friendId)
    .run();
}

export interface UpsertFriendInput {
  lineUserId: string;
  displayName?: string | null;
  pictureUrl?: string | null;
  statusMessage?: string | null;
  /**
   * フォロー状態。省略時は true（follow イベント由来の従来動作）。
   * false は「LINE 上は未友だちだが CRM には載せたい」ケース専用（イベント申込の遡及復元など）。
   * 既存行に対しては 1 → 0 への引き下げは行わない（復元処理が誤ってフォロー中の人を
   * 未フォロー扱いにする事故を防ぐ）。フォロー解除は updateFriendFollowStatus() が担う。
   */
  isFollowing?: boolean;
  /**
   * 所属 LINE アカウント。省略時は既存値を維持する。
   * 既に値がある行は上書きしない（先に紐づいたアカウントを正とする）。
   */
  lineAccountId?: string | null;
}

export async function upsertFriend(
  db: D1Database,
  input: UpsertFriendInput,
): Promise<Friend> {
  const now = jstNow();
  const existing = await getFriendByLineUserId(db, input.lineUserId);
  const isFollowing = input.isFollowing === false ? 0 : 1;
  const lineAccountId = input.lineAccountId ?? null;

  if (existing) {
    await db
      .prepare(
        `UPDATE friends
         SET display_name = ?,
             picture_url = ?,
             status_message = ?,
             is_following = CASE WHEN ? = 1 THEN 1 ELSE is_following END,
             line_account_id = COALESCE(line_account_id, ?),
             updated_at = ?
         WHERE line_user_id = ?`,
      )
      .bind(
        'displayName' in input ? (input.displayName ?? null) : existing.display_name,
        'pictureUrl' in input ? (input.pictureUrl ?? null) : existing.picture_url,
        'statusMessage' in input ? (input.statusMessage ?? null) : existing.status_message,
        isFollowing,
        lineAccountId,
        now,
        input.lineUserId,
      )
      .run();

    return (await getFriendByLineUserId(db, input.lineUserId))!;
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO friends (id, line_user_id, display_name, picture_url, status_message, is_following, line_account_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.lineUserId,
      input.displayName ?? null,
      input.pictureUrl ?? null,
      input.statusMessage ?? null,
      isFollowing,
      lineAccountId,
      now,
      now,
    )
    .run();

  return (await getFriendById(db, id))!;
}

export async function updateFriendFollowStatus(
  db: D1Database,
  lineUserId: string,
  isFollowing: boolean,
): Promise<void> {
  await db
    .prepare(
      `UPDATE friends
       SET is_following = ?, updated_at = ?
       WHERE line_user_id = ?`,
    )
    .bind(isFollowing ? 1 : 0, jstNow(), lineUserId)
    .run();
}

/** Get merged metadata across all friend records sharing the same user_id (UUID). */
export async function getMergedMetadataByUserId(
  db: D1Database,
  userId: string,
): Promise<Record<string, unknown>> {
  const result = await db
    .prepare(`SELECT metadata FROM friends WHERE user_id = ? AND metadata IS NOT NULL AND metadata != '{}'`)
    .bind(userId)
    .all<{ metadata: string }>();
  const merged: Record<string, unknown> = {};
  for (const row of result.results) {
    try {
      const meta = JSON.parse(row.metadata);
      for (const [k, v] of Object.entries(meta)) {
        if (v != null && v !== '' && !(merged[k] != null && merged[k] !== '')) {
          merged[k] = v;
        }
      }
    } catch { /* skip invalid JSON */ }
  }
  return merged;
}

export async function getFriendCount(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) as count FROM friends`)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

/**
 * フォロー中（is_following = 1）の友だち数を返す。
 * 全員配信（LINE broadcast API）は配信数を返さないため、配信対象数の概算として使う。
 *
 * NOTE: アカウント別に数えたくなるが、`friends.line_account_id` はカラムこそ存在するものの
 * 現状どのコードからも書き込まれておらず全行 NULL のため、絞り込むと必ず 0 件になる。
 * マルチアカウント対応する際は friends 側のバックフィルとセットで引数を追加すること。
 */
export async function getFollowingFriendCount(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) as count FROM friends WHERE is_following = 1`)
    .first<{ count: number }>();
  return row?.count ?? 0;
}
