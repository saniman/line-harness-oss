import { Hono } from 'hono';
import { verifySignature, LineClient } from '@line-crm/line-sdk';
import type { WebhookRequestBody, WebhookEvent, TextEventMessage } from '@line-crm/line-sdk';
import {
  upsertFriend,
  updateFriendFollowStatus,
  getFriendByLineUserId,
  getScenarios,
  enrollFriendInScenario,
  getScenarioSteps,
  advanceFriendScenario,
  completeFriendScenario,
  upsertChatOnMessage,
  getLineAccounts,
  jstNow,
} from '@line-crm/db';
import { fireEvent } from '../services/event-bus.js';
import { buildMessage, expandVariables } from '../services/step-delivery.js';
import { getValidAccessToken, GoogleCalendarClient } from '../services/google-calendar.js';
import { toJstString } from '@line-crm/db';
import type { Env } from '../index.js';

const webhook = new Hono<Env>();

webhook.post('/webhook', async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header('X-Line-Signature') ?? '';
  const db = c.env.DB;

  let body: WebhookRequestBody;
  try {
    body = JSON.parse(rawBody) as WebhookRequestBody;
  } catch {
    console.error('Failed to parse webhook body');
    return c.json({ status: 'ok' }, 200);
  }

  // Multi-account: resolve credentials from DB by destination (channel user ID)
  // or fall back to environment variables (default account)
  let channelSecret = c.env.LINE_CHANNEL_SECRET;
  let channelAccessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
  let matchedAccountId: string | null = null;

  if ((body as { destination?: string }).destination) {
    const accounts = await getLineAccounts(db);
    for (const account of accounts) {
      if (!account.is_active) continue;
      const isValid = await verifySignature(account.channel_secret, rawBody, signature);
      if (isValid) {
        channelSecret = account.channel_secret;
        channelAccessToken = account.channel_access_token;
        matchedAccountId = account.id;
        break;
      }
    }
  }

  // Verify with resolved secret
  const valid = await verifySignature(channelSecret, rawBody, signature);
  if (!valid) {
    console.error('Invalid LINE signature');
    return c.json({ status: 'ok' }, 200);
  }

  const lineClient = new LineClient(channelAccessToken);

  // 非同期処理 — LINE は ~1s 以内のレスポンスを要求
  const processingPromise = (async () => {
    for (const event of body.events) {
      try {
        await handleEvent(db, lineClient, event, channelAccessToken, matchedAccountId, c.env.WORKER_URL || new URL(c.req.url).origin, c.env);
      } catch (err) {
        console.error('Error handling webhook event:', err);
      }
    }
  })();

  c.executionCtx.waitUntil(processingPromise);

  return c.json({ status: 'ok' }, 200);
});

async function handleEvent(
  db: D1Database,
  lineClient: LineClient,
  event: WebhookEvent,
  lineAccessToken: string,
  lineAccountId: string | null = null,
  workerUrl?: string,
  env?: Env['Bindings'],
): Promise<void> {
  if (event.type === 'follow') {
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    console.log(`[follow] userId=${userId} lineAccountId=${lineAccountId}`);

    // プロフィール取得 & 友だち登録/更新
    let profile;
    try {
      profile = await lineClient.getProfile(userId);
    } catch (err) {
      console.error('Failed to get profile for', userId, err);
    }

    console.log(`[follow] profile=${profile?.displayName ?? 'null'}`);

    const friend = await upsertFriend(db, {
      lineUserId: userId,
      displayName: profile?.displayName ?? null,
      pictureUrl: profile?.pictureUrl ?? null,
      statusMessage: profile?.statusMessage ?? null,
    });

    console.log(`[follow] friend.id=${friend.id} friend.line_account_id=${(friend as any).line_account_id}`);

    // Set line_account_id for multi-account tracking (always update on follow)
    if (lineAccountId) {
      await db.prepare('UPDATE friends SET line_account_id = ?, updated_at = ? WHERE id = ?')
        .bind(lineAccountId, jstNow(), friend.id).run();
      console.log(`[follow] line_account_id set to ${lineAccountId} for friend ${friend.id}`);
    }

    // friend_add シナリオに登録（このアカウントのシナリオのみ）
    const scenarios = await getScenarios(db);
    for (const scenario of scenarios) {
      // Only trigger scenarios belonging to this account (or unassigned for backward compat)
      const scenarioAccountMatch = !scenario.line_account_id || !lineAccountId || scenario.line_account_id === lineAccountId;
      if (scenario.trigger_type === 'friend_add' && scenario.is_active && scenarioAccountMatch) {
        try {
          // INSERT OR IGNORE handles dedup via UNIQUE(friend_id, scenario_id)
          const friendScenario = await enrollFriendInScenario(db, friend.id, scenario.id);
          if (!friendScenario) continue; // already enrolled

            // Immediate delivery: if the first step has delay=0, send it now via replyMessage (free)
            const steps = await getScenarioSteps(db, scenario.id);
            const firstStep = steps[0];
            if (firstStep && firstStep.delay_minutes === 0 && friendScenario.status === 'active') {
              try {
                const { resolveMetadata } = await import('../services/step-delivery.js');
                const resolvedMeta = await resolveMetadata(db, { user_id: (friend as unknown as Record<string, string | null>).user_id, metadata: (friend as unknown as Record<string, string | null>).metadata });
                const expandedContent = expandVariables(firstStep.message_content, { ...friend, metadata: resolvedMeta } as Parameters<typeof expandVariables>[1]);
                const message = buildMessage(firstStep.message_type, expandedContent);
                await lineClient.replyMessage(event.replyToken, [message]);
                console.log(`Immediate delivery: sent step ${firstStep.id} to ${userId}`);

                // Log outgoing message (replyMessage = 無料)
                const logId = crypto.randomUUID();
                await db
                  .prepare(
                    `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, created_at)
                     VALUES (?, ?, 'outgoing', ?, ?, NULL, ?, 'reply', ?)`,
                  )
                  .bind(logId, friend.id, firstStep.message_type, firstStep.message_content, firstStep.id, jstNow())
                  .run();

                // Advance or complete the friend_scenario
                const secondStep = steps[1] ?? null;
                if (secondStep) {
                  const nextDeliveryDate = new Date(Date.now() + 9 * 60 * 60_000);
                  nextDeliveryDate.setMinutes(nextDeliveryDate.getMinutes() + secondStep.delay_minutes);
                  // Enforce 9:00-21:00 JST delivery window
                  const h = nextDeliveryDate.getUTCHours();
                  if (h < 9 || h >= 21) {
                    if (h >= 21) nextDeliveryDate.setUTCDate(nextDeliveryDate.getUTCDate() + 1);
                    nextDeliveryDate.setUTCHours(9, 0, 0, 0);
                  }
                  await advanceFriendScenario(db, friendScenario.id, firstStep.step_order, nextDeliveryDate.toISOString().slice(0, -1) + '+09:00');
                } else {
                  await completeFriendScenario(db, friendScenario.id);
                }
              } catch (err) {
                console.error('Failed immediate delivery for scenario', scenario.id, err);
              }
            }
        } catch (err) {
          console.error('Failed to enroll friend in scenario', scenario.id, err);
        }
      }
    }

    // イベントバス発火: friend_add（replyToken は Step 0 で使用済みの可能性あり）
    await fireEvent(db, 'friend_add', { friendId: friend.id, eventData: { displayName: friend.display_name } }, lineAccessToken, lineAccountId);
    return;
  }

  if (event.type === 'unfollow') {
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    await updateFriendFollowStatus(db, userId, false);
    return;
  }

  // Postback events — triggered by Flex buttons with action.type: "postback"
  // Uses the same auto_replies matching but without displaying text in chat
  if (event.type === 'postback') {
    const userId = event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    let friend = await getFriendByLineUserId(db, userId);
    if (!friend) {
      let profile;
      try { profile = await lineClient.getProfile(userId); } catch {}
      friend = await upsertFriend(db, {
        lineUserId: userId,
        displayName: profile?.displayName ?? null,
        pictureUrl: profile?.pictureUrl ?? null,
        statusMessage: profile?.statusMessage ?? null,
      });
    }

    const postbackData = (event as unknown as { postback: { data: string } }).postback.data;

    // 予約確定 postback: "book:{connectionId}:{startAt}:{endAt}"
    if (postbackData.startsWith('book:') && env) {
      const parts = postbackData.split(':');
      // parts: ['book', connectionId, date, 'T', time, offset] — reassemble ISO strings
      // Format: book:{connectionId}:{startISO}:{endISO}
      // We encode as: book:{connId}|{startAt}|{endAt}
      const payload = postbackData.slice('book:'.length);
      const [connId, startAt, endAt] = payload.split('|');
      if (connId && startAt && endAt) {
        try {
          const accessToken = await getValidAccessToken(env, db, connId);
          const conn = await db.prepare('SELECT calendar_id FROM google_calendar_connections WHERE id = ?')
            .bind(connId).first<{ calendar_id: string }>();
          const gcal = new GoogleCalendarClient({ calendarId: conn?.calendar_id ?? 'primary', accessToken });

          const bookingId = crypto.randomUUID();
          const startDate = new Date(startAt);
          const mm = String(startDate.getMonth() + 1).padStart(2, '0');
          const dd = String(startDate.getDate()).padStart(2, '0');
          const hh = String(startDate.getHours()).padStart(2, '0');
          const title = `${friend.display_name ?? 'LINE予約'} ${mm}/${dd} ${hh}:00`;

          await db.prepare(
            `INSERT INTO calendar_bookings (id, connection_id, friend_id, title, start_at, end_at, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'confirmed', datetime('now'), datetime('now'))`
          ).bind(bookingId, connId, friend.id, title, startAt, endAt).run();

          let eventId: string | null = null;
          try {
            const result = await gcal.createEvent({ summary: title, start: startAt, end: endAt });
            eventId = result.eventId;
            await db.prepare('UPDATE calendar_bookings SET event_id = ? WHERE id = ?').bind(eventId, bookingId).run();
          } catch (err) {
            console.warn('Google Calendar createEvent failed (booking saved in D1):', err);
          }

          const startDt = new Date(startAt);
          const dateLabel = `${startDt.getFullYear()}年${startDt.getMonth() + 1}月${startDt.getDate()}日`;
          const timeLabel = `${String(startDt.getHours()).padStart(2, '0')}:00〜${String(new Date(endAt).getHours()).padStart(2, '0')}:00`;

          await lineClient.replyMessage(event.replyToken, [buildMessage('flex', JSON.stringify({
            type: 'bubble',
            header: { type: 'box', layout: 'vertical', backgroundColor: '#06C755', paddingAll: '20px',
              contents: [{ type: 'text', text: '✅ 予約が確定しました', color: '#ffffff', weight: 'bold', size: 'lg' }],
            },
            body: { type: 'box', layout: 'vertical', paddingAll: '20px', spacing: 'md',
              contents: [
                { type: 'box', layout: 'horizontal', contents: [
                  { type: 'text', text: '日時', size: 'sm', color: '#8b8b8b', flex: 2 },
                  { type: 'text', text: `${dateLabel} ${timeLabel}`, size: 'sm', color: '#1e293b', weight: 'bold', flex: 5, wrap: true },
                ]},
                { type: 'separator' },
                { type: 'text', text: '予約をキャンセルする場合は下のボタンを押してください。', size: 'xs', color: '#8b8b8b', wrap: true },
              ],
            },
            footer: { type: 'box', layout: 'vertical', paddingAll: '12px',
              contents: [{
                type: 'button',
                action: {
                  type: 'postback',
                  label: '予約をキャンセル',
                  data: `cancel:${bookingId}`,
                  displayText: '予約をキャンセルします',
                },
                style: 'secondary',
                color: '#ef4444',
                height: 'sm',
              }],
            },
          }))]);
        } catch (err) {
          console.error('Booking postback error:', err);
          await lineClient.replyMessage(event.replyToken, [buildMessage('text', '予約処理中にエラーが発生しました。もう一度お試しください。')]);
        }
        return;
      }
    }

    // キャンセル postback: "cancel:{bookingId}"
    if (postbackData.startsWith('cancel:') && env) {
      const bookingId = postbackData.slice('cancel:'.length);
      try {
        const booking = await db
          .prepare("SELECT * FROM calendar_bookings WHERE id = ? AND friend_id = ? AND status = 'confirmed'")
          .bind(bookingId, friend.id)
          .first<{ id: string; connection_id: string; event_id: string | null; start_at: string; end_at: string }>();

        if (!booking) {
          await lineClient.replyMessage(event.replyToken, [buildMessage('text', '予約が見つかりませんでした。すでにキャンセル済みの可能性があります。')]);
          return;
        }

        // D1 のステータスを cancelled に更新
        await db
          .prepare("UPDATE calendar_bookings SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?")
          .bind(bookingId).run();

        // Google Calendar のイベントを削除（ベストエフォート）
        if (booking.event_id && booking.connection_id) {
          try {
            const accessToken = await getValidAccessToken(env, db, booking.connection_id);
            const conn = await db
              .prepare('SELECT calendar_id FROM google_calendar_connections WHERE id = ?')
              .bind(booking.connection_id).first<{ calendar_id: string }>();
            const gcal = new GoogleCalendarClient({ calendarId: conn?.calendar_id ?? 'primary', accessToken });
            await gcal.deleteEvent(booking.event_id);
          } catch (err) {
            console.warn('Google Calendar deleteEvent failed (D1 status still cancelled):', err);
          }
        }

        const startDt = new Date(booking.start_at);
        const dateLabel = `${startDt.getFullYear()}年${startDt.getMonth() + 1}月${startDt.getDate()}日`;
        const timeLabel = `${String(startDt.getHours()).padStart(2, '0')}:00〜${String(new Date(booking.end_at).getHours()).padStart(2, '0')}:00`;

        await lineClient.replyMessage(event.replyToken, [buildMessage('flex', JSON.stringify({
          type: 'bubble',
          header: { type: 'box', layout: 'vertical', backgroundColor: '#6b7280', paddingAll: '20px',
            contents: [{ type: 'text', text: '🗑️ 予約をキャンセルしました', color: '#ffffff', weight: 'bold', size: 'md' }],
          },
          body: { type: 'box', layout: 'vertical', paddingAll: '20px', spacing: 'md',
            contents: [
              { type: 'box', layout: 'horizontal', contents: [
                { type: 'text', text: '日時', size: 'sm', color: '#8b8b8b', flex: 2 },
                { type: 'text', text: `${dateLabel} ${timeLabel}`, size: 'sm', color: '#6b7280', flex: 5, wrap: true },
              ]},
              { type: 'separator' },
              { type: 'text', text: '再度ご予約を希望される場合は「予約」とお送りください。', size: 'xs', color: '#8b8b8b', wrap: true },
            ],
          },
        }))]);
      } catch (err) {
        console.error('Cancel postback error:', err);
        await lineClient.replyMessage(event.replyToken, [buildMessage('text', 'キャンセル処理中にエラーが発生しました。')]);
      }
      return;
    }

    // Match postback data against auto_replies (exact match on keyword)
    const autoReplyQuery = lineAccountId
      ? `SELECT * FROM auto_replies WHERE is_active = 1 AND (line_account_id IS NULL OR line_account_id = ?) ORDER BY created_at ASC`
      : `SELECT * FROM auto_replies WHERE is_active = 1 AND line_account_id IS NULL ORDER BY created_at ASC`;
    const autoReplyStmt = db.prepare(autoReplyQuery);
    const autoReplies = await (lineAccountId ? autoReplyStmt.bind(lineAccountId) : autoReplyStmt)
      .all<{
        id: string;
        keyword: string;
        match_type: 'exact' | 'contains';
        response_type: string;
        response_content: string;
      }>();

    for (const rule of autoReplies.results) {
      const isMatch = rule.match_type === 'exact'
        ? postbackData === rule.keyword
        : postbackData.includes(rule.keyword);

      if (isMatch) {
        try {
          const { resolveMetadata } = await import('../services/step-delivery.js');
          const resolvedMeta = await resolveMetadata(db, { user_id: (friend as unknown as Record<string, string | null>).user_id, metadata: (friend as unknown as Record<string, string | null>).metadata });
          const expandedContent = expandVariables(rule.response_content, { ...friend, metadata: resolvedMeta } as Parameters<typeof expandVariables>[1], workerUrl);
          const replyMsg = buildMessage(rule.response_type, expandedContent);
          await lineClient.replyMessage(event.replyToken, [replyMsg]);
        } catch (err) {
          console.error('Failed to send postback reply', err);
        }
        break;
      }
    }
    return;
  }

  if (event.type === 'message' && event.message.type === 'text') {
    const textMessage = event.message as TextEventMessage;
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    let friend = await getFriendByLineUserId(db, userId);
    if (!friend) {
      let profile;
      try { profile = await lineClient.getProfile(userId); } catch {}
      friend = await upsertFriend(db, {
        lineUserId: userId,
        displayName: profile?.displayName ?? null,
        pictureUrl: profile?.pictureUrl ?? null,
        statusMessage: profile?.statusMessage ?? null,
      });
    }

    const incomingText = textMessage.text;
    const now = jstNow();
    const logId = crypto.randomUUID();

    // 受信メッセージをログに記録
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, created_at)
         VALUES (?, ?, 'incoming', 'text', ?, NULL, NULL, ?)`,
      )
      .bind(logId, friend.id, incomingText, now)
      .run();

    // チャットを作成/更新（ユーザーの自発的メッセージのみ unread にする）
    // ボタンタップ等の自動応答キーワードは除外
    const autoKeywords = ['料金', '機能', 'API', 'フォーム', 'ヘルプ', 'UUID', 'UUID連携について教えて', 'UUID連携を確認', '配信時間', '導入支援を希望します', 'アカウント連携を見る', '体験を完了する', 'BAN対策を見る', '連携確認'];
    const isAutoKeyword = autoKeywords.some(k => incomingText === k);
    const isTimeCommand = /(?:配信時間|配信|届けて|通知)[はを]?\s*\d{1,2}\s*時/.test(incomingText);
    if (!isAutoKeyword && !isTimeCommand) {
      await upsertChatOnMessage(db, friend.id);
    }

    // 配信時間設定: 「配信時間は○時」「○時に届けて」等のパターンを検出
    const timeMatch = incomingText.match(/(?:配信時間|配信|届けて|通知)[はを]?\s*(\d{1,2})\s*時/);
    if (timeMatch) {
      const hour = parseInt(timeMatch[1], 10);
      if (hour >= 6 && hour <= 22) {
        // Save preferred_hour to friend metadata
        const existing = await db.prepare('SELECT metadata FROM friends WHERE id = ?').bind(friend.id).first<{ metadata: string }>();
        const meta = JSON.parse(existing?.metadata || '{}');
        meta.preferred_hour = hour;
        await db.prepare('UPDATE friends SET metadata = ?, updated_at = ? WHERE id = ?')
          .bind(JSON.stringify(meta), jstNow(), friend.id).run();

        // Reply with confirmation
        try {
          const period = hour < 12 ? '午前' : '午後';
          const displayHour = hour <= 12 ? hour : hour - 12;
          await lineClient.replyMessage(event.replyToken, [
            buildMessage('flex', JSON.stringify({
              type: 'bubble',
              body: { type: 'box', layout: 'vertical', contents: [
                { type: 'text', text: '配信時間を設定しました', size: 'lg', weight: 'bold', color: '#1e293b' },
                { type: 'box', layout: 'vertical', contents: [
                  { type: 'text', text: `${period} ${displayHour}:00`, size: 'xxl', weight: 'bold', color: '#f59e0b', align: 'center' },
                  { type: 'text', text: `（${hour}:00〜）`, size: 'sm', color: '#64748b', align: 'center', margin: 'sm' },
                ], backgroundColor: '#fffbeb', cornerRadius: 'md', paddingAll: '20px', margin: 'lg' },
                { type: 'text', text: '今後のステップ配信はこの時間以降にお届けします。', size: 'xs', color: '#64748b', wrap: true, margin: 'lg' },
              ], paddingAll: '20px' },
            })),
          ]);
        } catch (err) {
          console.error('Failed to reply for time setting', err);
        }
        return;
      }
    }

    // Cross-account trigger: send message from another account via UUID
    if (incomingText === '体験を完了する' && lineAccountId) {
      try {
        const friendRecord = await db.prepare('SELECT user_id FROM friends WHERE id = ?').bind(friend.id).first<{ user_id: string | null }>();
        if (friendRecord?.user_id) {
          // Find the same user on other accounts
          const otherFriends = await db.prepare(
            'SELECT f.line_user_id, la.channel_access_token FROM friends f INNER JOIN line_accounts la ON la.id = f.line_account_id WHERE f.user_id = ? AND f.line_account_id != ? AND f.is_following = 1'
          ).bind(friendRecord.user_id, lineAccountId).all<{ line_user_id: string; channel_access_token: string }>();

          for (const other of otherFriends.results) {
            const otherClient = new LineClient(other.channel_access_token);
            const { buildMessage: bm } = await import('../services/step-delivery.js');
            await otherClient.pushMessage(other.line_user_id, [bm('flex', JSON.stringify({
              type: 'bubble', size: 'giga',
              header: { type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: '#fffbeb',
                contents: [{ type: 'text', text: `${friend.display_name || ''}さんへ`, size: 'lg', weight: 'bold', color: '#1e293b' }],
              },
              body: { type: 'box', layout: 'vertical', paddingAll: '20px',
                contents: [
                  { type: 'text', text: '別アカウントからのアクションを検知しました。', size: 'sm', color: '#06C755', weight: 'bold', wrap: true },
                  { type: 'text', text: 'アカウント連携が正常に動作しています。体験ありがとうございました。', size: 'sm', color: '#1e293b', wrap: true, margin: 'md' },
                  { type: 'separator', margin: 'lg' },
                  { type: 'text', text: 'ステップ配信・フォーム即返信・アカウント連携・リッチメニュー・自動返信 — 全て無料、全てOSS。', size: 'xs', color: '#64748b', wrap: true, margin: 'lg' },
                ],
              },
              footer: { type: 'box', layout: 'vertical', paddingAll: '16px',
                contents: [
                  { type: 'button', action: { type: 'message', label: '導入について相談する', text: '導入支援を希望します' }, style: 'primary', color: '#06C755' },
                  ...(c.env.LIFF_URL ? [{ type: 'button', action: { type: 'uri', label: 'フィードバックを送る', uri: `${c.env.LIFF_URL}?page=form` }, style: 'secondary', margin: 'sm' }] : []),
                ],
              },
            }))]);
          }

          // Reply on Account ② confirming
          await lineClient.replyMessage(event.replyToken, [buildMessage('flex', JSON.stringify({
            type: 'bubble',
            body: { type: 'box', layout: 'vertical', paddingAll: '20px',
              contents: [
                { type: 'text', text: 'Account ① にメッセージを送りました', size: 'sm', color: '#06C755', weight: 'bold', align: 'center' },
                { type: 'text', text: 'Account ① のトーク画面を確認してください', size: 'xs', color: '#64748b', align: 'center', margin: 'md' },
              ],
            },
          }))]);
          return;
        }
      } catch (err) {
        console.error('Cross-account trigger error:', err);
      }
    }

    let matched = false;
    let replyTokenConsumed = false;

    // 予約キーワード検出 → LIFFページへ誘導
    if (incomingText.includes('予約') && env) {
      const liffUrl = env.LIFF_URL ?? 'https://liff.line.me/dummy';
      try {
        await lineClient.replyMessage(event.replyToken, [buildMessage('flex', JSON.stringify({
          type: 'bubble',
          body: {
            type: 'box', layout: 'vertical', paddingAll: '20px',
            contents: [
              { type: 'text', text: 'ご予約はこちらから日程をお選びください 📅', size: 'sm', color: '#1e293b', wrap: true },
            ],
          },
          footer: {
            type: 'box', layout: 'vertical', paddingAll: '16px',
            contents: [
              { type: 'button', action: { type: 'uri', label: '日程を選ぶ', uri: `${liffUrl}?page=book` }, style: 'primary', color: '#06C755' },
            ],
          },
        }))]);
        replyTokenConsumed = true;
      } catch (err) {
        console.error('Failed to send booking LIFF button:', err);
      }
      if (replyTokenConsumed) {
        await fireEvent(db, 'message_received', { friendId: friend.id, eventData: { text: incomingText, matched: true } }, lineAccessToken, lineAccountId);
        return;
      }
    }

    // 自動返信チェック（このアカウントのルール + グローバルルールのみ）
    // NOTE: Auto-replies use replyMessage (free, no quota) instead of pushMessage
    // The replyToken is only valid for ~1 minute after the message event
    const autoReplyQuery = lineAccountId
      ? `SELECT * FROM auto_replies WHERE is_active = 1 AND (line_account_id IS NULL OR line_account_id = ?) ORDER BY created_at ASC`
      : `SELECT * FROM auto_replies WHERE is_active = 1 AND line_account_id IS NULL ORDER BY created_at ASC`;
    const autoReplyStmt = db.prepare(autoReplyQuery);
    const autoReplies = await (lineAccountId ? autoReplyStmt.bind(lineAccountId) : autoReplyStmt)
      .all<{
        id: string;
        keyword: string;
        match_type: 'exact' | 'contains';
        response_type: string;
        response_content: string;
        is_active: number;
        created_at: string;
      }>();

    for (const rule of autoReplies.results) {
      const isMatch =
        rule.match_type === 'exact'
          ? incomingText === rule.keyword
          : incomingText.includes(rule.keyword);

      if (isMatch) {
        try {
          // Expand template variables ({{name}}, {{uid}}, {{auth_url:CHANNEL_ID}})
          const { resolveMetadata: resolveMeta2 } = await import('../services/step-delivery.js');
          const resolvedMeta2 = await resolveMeta2(db, { user_id: (friend as unknown as Record<string, string | null>).user_id, metadata: (friend as unknown as Record<string, string | null>).metadata });
          const expandedContent = expandVariables(rule.response_content, { ...friend, metadata: resolvedMeta2 } as Parameters<typeof expandVariables>[1], workerUrl);
          const replyMsg = buildMessage(rule.response_type, expandedContent);
          await lineClient.replyMessage(event.replyToken, [replyMsg]);
          replyTokenConsumed = true;

          // 送信ログ（replyMessage = 無料）
          const outLogId = crypto.randomUUID();
          await db
            .prepare(
              `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, created_at)
               VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, 'reply', ?)`,
            )
            .bind(outLogId, friend.id, rule.response_type, rule.response_content, jstNow())
            .run();
        } catch (err) {
          console.error('Failed to send auto-reply', err);
          // replyToken may still be unused if replyMessage threw before LINE accepted it
        }

        matched = true;
        break;
      }
    }

    // イベントバス発火: message_received
    // Pass replyToken only when auto_reply didn't actually consume it
    await fireEvent(db, 'message_received', {
      friendId: friend.id,
      eventData: { text: incomingText, matched },
      replyToken: replyTokenConsumed ? undefined : event.replyToken,
    }, lineAccessToken, lineAccountId);

    return;
  }
}

export { webhook };
