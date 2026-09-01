/**
 * BAN検知モニター — cronトリガーで定期実行
 *
 * LINE APIのエラー率を監視し、BAN リスクを検出する
 * 403/429 エラーのパターンを分析してリスクレベルを判定
 */

import {
  getLineAccounts,
  createAccountHealthLog,
  getAccountHealthLogs,
} from '@line-crm/db';

/**
 * 状態が変わらなくても、この間隔では必ず1行記録して cron の生存を示す。
 * 正常が続くと最新行が何日も前になり、管理画面から「cron が死んでいる」のか
 * 「正常で書くことが無い」のかを見分けられなくなるため。
 */
const HEARTBEAT_HOURS = 6;

/** 直近ログが HEARTBEAT_HOURS 以内に書かれたか。解釈できない値は「古い」扱いにする。 */
function isRecent(createdAt: string): boolean {
  const at = Date.parse(createdAt);
  // パースできない値（オフセット無しの古い行など）で握りつぶすと生存確認が消える。
  // 取りこぼすより余分に1行書く方が安全なので false を返す。
  if (Number.isNaN(at)) return false;
  return Date.now() - at < HEARTBEAT_HOURS * 60 * 60 * 1000;
}

export async function checkAccountHealth(
  db: D1Database,
): Promise<void> {
  const accounts = await getLineAccounts(db);

  for (const account of accounts) {
    if (!account.is_active) continue;

    try {
      await checkSingleAccount(db, account);
    } catch (err) {
      console.error(`ヘルスチェックエラー (account ${account.id}):`, err);
    }
  }
}

async function checkSingleAccount(
  db: D1Database,
  account: { id: string; channel_access_token: string },
): Promise<void> {
  const jstMs = Date.now() + 9 * 60 * 60_000;
  const now = new Date(jstMs);
  const checkPeriod = now.toISOString().slice(0, -1) + '+09:00';

  // 直近1時間のメッセージログからエラーパターンを推定
  // (実際のLINE APIエラーはログに残らないが、送信成功率から推定)
  const oneHourAgo = new Date(jstMs - 60 * 60_000).toISOString().slice(0, -1) + '+09:00';

  const sentMessages = await db
    .prepare(
      `SELECT COUNT(*) as count FROM messages_log
       WHERE direction = 'outgoing' AND created_at >= ?`,
    )
    .bind(oneHourAgo)
    .first<{ count: number }>();

  const totalSent = sentMessages?.count ?? 0;

  // LINE APIにヘルスチェックリクエスト
  let errorCode: number | null = null;
  let errorCount = 0;

  try {
    const response = await fetch('https://api.line.me/v2/bot/info', {
      headers: { Authorization: `Bearer ${account.channel_access_token}` },
    });

    if (!response.ok) {
      errorCode = response.status;
      errorCount = 1;
    }
  } catch {
    errorCode = 0; // ネットワークエラー
    errorCount = 1;
  }

  // リスクレベル判定
  let riskLevel = 'normal';
  if (errorCode === 403) {
    riskLevel = 'danger'; // BAN の可能性
  } else if (errorCode === 429) {
    riskLevel = 'warning'; // レート制限
  } else if (totalSent > 5000) {
    riskLevel = 'warning'; // 大量送信の警告
  }

  // BAN の警告は書き込みの抑制より前に出す。下の重複排除で return すると、403 が
  // 続いている間は2回目以降この警告が一切出なくなる。console.error はこのアカウントが
  // BAN された唯一の通知経路なので、DB の重複排除とは別の関心事として扱う。
  if (riskLevel === 'danger') {
    console.error(`⚠️ BAN検知: アカウント ${account.id} で403エラー発生。即座に確認が必要。`);
  }

  // 直前の記録と同じ状態なら書かない。この関数は cron の tick ごとに呼ばれるので、
  // 毎回 INSERT すると異常が1件も無いアカウントでもゴミ行が積み上がる
  // （fork は */5 なので 1日288行 × アカウント数）。ヘルスログは「チェックした記録」
  // ではなく「状態が変わった履歴」で、管理画面（apps/web/src/app/health）も最新50件を
  // そのまま並べるだけなので、同じ状態の連投は異常の履歴を押し流してしまう。
  // risk_level が同じでもエラーコードが変われば別の事象なので、両方を比較する。
  const [latest] = await getAccountHealthLogs(db, account.id, 1);
  if (
    latest &&
    latest.risk_level === riskLevel &&
    (latest.error_code ?? null) === errorCode &&
    isRecent(latest.created_at)
  ) {
    return;
  }

  await createAccountHealthLog(db, {
    lineAccountId: account.id,
    errorCode: errorCode ?? undefined,
    errorCount,
    checkPeriod,
    riskLevel,
  });
}
