import { Hono } from 'hono';
import Stripe from 'stripe';
import { LineClient } from '@line-crm/line-sdk';
import {
  createEvent,
  getEvents,
  getEventById,
  updateEvent,
  deleteEvent,
  getEventBookings,
  getEventBookingsAdmin,
  createEventBooking,
  createPendingBooking,
  updateBookingStripeSessionId,
  cancelEventBooking,
  linkBookingToFriend,
} from '../services/events.js';
import { enrollEventFollowupScenarios, enrollEventParticipants } from '../services/event-followup.js';
import { resolveEventApplicant } from '../services/event-friend.js';
import { isApplicationClosed } from '../services/event-deadline.js';
import { backfillEventBookingFriends } from '../services/event-friend-backfill.js';
import { resolveDefaultLineAccountId } from '../services/default-line-account.js';
import { verifyCaller } from '../services/liff-identity.js';
import type { CallerAuthFailure } from '../services/liff-identity.js';
import { notifyAdminEventBooking } from '../services/admin-notifier.js';
import { formatJST } from '../utils/format-jst.js';
import { getScenarioById } from '@line-crm/db';
import type { Env } from '../index.js';

const events = new Hono<Env>();

/**
 * 401 のエラーコード。期限切れはクライアントが再ログインで自力復帰できるため区別して返す（#28）。
 * 一律 'unauthorized' にすると「開き直してください」しか案内できず、ユーザーが詰む。
 */
function authErrorCode(reason: CallerAuthFailure): string {
  return reason === 'expired' ? 'id_token_expired' : 'unauthorized';
}

// ========== 管理API ==========

events.get('/api/events', async (c) => {
  try {
    const items = await getEvents(c.env.DB);
    return c.json({
      success: true,
      data: items.map((e) => ({
        ...e,
        remaining: e.capacity - e.participant_count,
      })),
    });
  } catch (err) {
    console.error('GET /api/events error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

events.post('/api/events', async (c) => {
  try {
    const body = await c.req.json<{
      title?: string;
      description?: string;
      start_at?: string;
      end_at?: string;
      capacity?: number;
      price?: number | null;
      is_published?: number;
    }>();
    if (!body.title || !body.start_at || !body.end_at || !body.capacity) {
      return c.json({ success: false, error: 'title, start_at, end_at, capacity are required' }, 400);
    }
    const event = await createEvent(c.env.DB, {
      title: body.title,
      description: body.description,
      start_at: body.start_at,
      end_at: body.end_at,
      capacity: body.capacity,
      price: body.price != null && body.price > 0 ? body.price : null,
      is_published: body.is_published,
    });
    return c.json({ success: true, data: { ...event, remaining: event.capacity - event.participant_count } }, 201);
  } catch (err) {
    console.error('POST /api/events error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== 公開API（LIFF向け） ==========

// NOTE: /public must be registered before /:id to avoid shadowing
events.get('/api/events/public', async (c) => {
  try {
    const items = await getEvents(c.env.DB);
    const published = items
      .filter((e) => e.is_published === 1)
      .map((e) => ({
        id: e.id,
        title: e.title,
        description: e.description,
        start_at: e.start_at,
        end_at: e.end_at,
        capacity: e.capacity,
        price: e.price,
        participant_count: e.participant_count,
        remaining: e.capacity - e.participant_count,
        available: e.participant_count < e.capacity,
        // 締切は満席とは別の状態。available に混ぜると「締切なのに満席」と表示されてしまう。
        application_closed: isApplicationClosed(e.start_at),
      }));
    return c.json({ success: true, data: published });
  } catch (err) {
    console.error('GET /api/events/public error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== 個別イベント管理 ==========

events.get('/api/events/:id', async (c) => {
  try {
    const id = Number(c.req.param('id'));
    const event = await getEventById(c.env.DB, id);
    if (!event) return c.json({ success: false, error: 'Event not found' }, 404);
    return c.json({ success: true, data: { ...event, remaining: event.capacity - event.participant_count } });
  } catch (err) {
    console.error('GET /api/events/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

events.get('/api/events/:id/bookings', async (c) => {
  try {
    const id = Number(c.req.param('id'));
    const bookings = await getEventBookingsAdmin(c.env.DB, id);
    return c.json({ success: true, data: bookings });
  } catch (err) {
    console.error('GET /api/events/:id/bookings error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

events.put('/api/events/:id', async (c) => {
  try {
    const id = Number(c.req.param('id'));
    const body = await c.req.json<{
      title?: string;
      description?: string;
      start_at?: string;
      end_at?: string;
      capacity?: number;
      price?: number | null;
      is_published?: number;
    }>();
    const event = await updateEvent(c.env.DB, id, body);
    if (!event) return c.json({ success: false, error: 'Event not found' }, 404);
    return c.json({ success: true, data: { ...event, remaining: event.capacity - event.participant_count } });
  } catch (err) {
    console.error('PUT /api/events/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

events.delete('/api/events/:id', async (c) => {
  try {
    const id = Number(c.req.param('id'));
    await deleteEvent(c.env.DB, id);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/events/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

events.post('/api/events/:id/join', async (c) => {
  try {
    const id = Number(c.req.param('id'));
    const body = await c.req.json<{ name?: string; paymentMethod?: string }>();
    const isCash = body.paymentMethod === 'cash';

    // 本人確認: Authorization: Bearer <LIFF idToken> を検証する。
    // クライアント申告の lineUserId は詐称できるため参照しない。
    const caller = await verifyCaller(c);
    if (!caller.ok) return c.json({ success: false, error: authErrorCode(caller.reason) }, 401);
    const lineUserId = caller.lineUserId;

    const event = await getEventById(c.env.DB, id);
    if (!event) return c.json({ success: false, error: 'Event not found' }, 404);
    // 締切チェックは定員チェックより前。締切のほうが利用者にとって情報量が多い
    // （満席は空きが出る可能性を想像させるが、締切は最終状態）。
    if (isApplicationClosed(event.start_at)) {
      return c.json({ success: false, error: 'application_closed' }, 409);
    }
    if (event.participant_count >= event.capacity) {
      return c.json({ success: false, error: 'Event is full' }, 409);
    }

    // 友だち登録必須ゲート（モバイルオーダー・サロン予約と同じ作法）。
    // friends 行が実態とズレていても LINE 上が友だちなら upsert して救済する。
    const lineClient = c.env.LINE_CHANNEL_ACCESS_TOKEN
      ? new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN)
      : null;
    const defaultAccountId = await resolveDefaultLineAccountId(c.env.DB, c.env);
    const applicant = await resolveEventApplicant(c.env.DB, lineUserId, lineClient, defaultAccountId);
    // 判定不能（LINE API 障害等）は 403 にしない。友だち追加を促しても解決せずループするため。
    if (applicant.status === 'unavailable') {
      return c.json({ success: false, error: 'friend_check_unavailable' }, 503);
    }
    if (applicant.status === 'not_friend') {
      return c.json({ success: false, error: 'friend_required' }, 403);
    }
    const friendId = applicant.friendId;

    const booking = await createEventBooking(c.env.DB, {
      event_id: id,
      friend_id: friendId,
      name: body.name ?? '',
      payment_status: isCash ? 'cash' : undefined,
    });

    // アフターフォローシナリオへ自動登録（ベストエフォート: 失敗しても申込は維持）
    // event.start_at を渡すと開催日アンカー設定のステップが開催日基準で配信される
    try {
      await enrollEventFollowupScenarios(c.env.DB, friendId, event.start_at);
    } catch (err) {
      console.error('[events /join] enrollEventFollowupScenarios failed:', err);
    }

    // 運営者へ LINE 通知（ベストエフォート: 未設定なら no-op・失敗しても申込は維持）
    // participant_count は申込前の値なので、この申込を含めて +1 する。
    // 支払い区分はクライアント申告（body.paymentMethod）ではなく DB の事実から導出する。
    // 有料イベントに paymentMethod なしで直接叩かれた場合を「無料」と誤通知しないため。
    const paymentKind =
      (event.price ?? 0) <= 0
        ? 'free'
        : booking.payment_status === 'cash'
          ? 'cash'
          : 'unpaid';
    await notifyAdminEventBooking({
      client: lineClient,
      adminLineUserId: c.env.ADMIN_LINE_USER_ID,
      ctx: {
        eventTitle: event.title,
        eventStartAt: event.start_at,
        applicantName: body.name ?? '',
        bookingId: booking.id,
        paymentKind,
        // 無料以外は金額を載せる（当日現金＝集金額 / 未払い＝請求額）
        amount: paymentKind === 'free' ? null : event.price,
        participantCount: event.participant_count + 1,
        capacity: event.capacity,
      },
    });

    // LINE push通知（ベストエフォート）
    if (lineClient) {
      try {
        const dateStr = formatJST(event.start_at);
        const headerText = isCash ? '✅ 当日現金払いで申込完了' : '✅ お申込みが完了しました';
        const cashNote = isCash ? [
          { type: 'text', text: '💴 当日スタッフにお支払いください', size: 'sm', color: '#e67e22', wrap: true },
        ] : [];
        await lineClient.pushMessage(lineUserId, [{
          type: 'flex',
          altText: `✅ 「${event.title}」のお申込みが完了しました`,
          contents: {
            type: 'bubble',
            header: {
              type: 'box', layout: 'vertical', paddingAll: '16px',
              backgroundColor: '#06C755',
              contents: [{ type: 'text', text: headerText, color: '#ffffff', weight: 'bold', size: 'md' }],
            },
            body: {
              type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'sm',
              contents: [
                { type: 'text', text: event.title, weight: 'bold', size: 'md', wrap: true },
                { type: 'text', text: `日時：${dateStr}`, size: 'sm', color: '#666666', wrap: true },
                ...cashNote,
              ],
            },
            footer: {
              type: 'box', layout: 'vertical', paddingAll: '12px',
              contents: [{
                type: 'button',
                action: {
                  type: 'postback',
                  label: 'キャンセルはこちら',
                  data: `event_cancel:${booking.id}`,
                  displayText: 'キャンセルを申請する',
                },
                style: 'secondary', height: 'sm',
              }],
            },
          } as never,
        }]);
      } catch {
        // ベストエフォート
      }
    }

    return c.json({ success: true, data: booking }, 201);
  } catch (err) {
    console.error('POST /api/events/:id/join error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

events.post('/api/events/:id/checkout-session', async (c) => {
  try {
    const id = Number(c.req.param('id'));

    // 0. 本人確認: Authorization: Bearer <LIFF idToken>（x-line-user-id ヘッダは詐称可能なため参照しない）
    const caller = await verifyCaller(c);
    if (!caller.ok) return c.json({ success: false, error: authErrorCode(caller.reason) }, 401);
    const lineUserId = caller.lineUserId;

    // 1. イベント取得・存在チェック・公開チェック
    const event = await getEventById(c.env.DB, id);
    if (!event || event.is_published !== 1) {
      return c.json({ success: false, error: 'Event not found' }, 404);
    }

    // 2. 申込締切チェック（定員より前。UI でボタンを消すのは導線であってゲートはここ）
    // NOTE: 締切直前に Checkout へ進んだ人の決済完了は妨げない（ここはセッション作成時の判定）。
    // 塞ぐと「支払ったのに参加できない」になるため、止めるのは新規申込だけにする。
    if (isApplicationClosed(event.start_at)) {
      return c.json({ success: false, error: 'application_closed' }, 409);
    }

    // 3. 定員チェック（participant_count は confirmed のみカウント済み）
    if (event.participant_count >= event.capacity) {
      return c.json({ success: false, error: 'Event is full' }, 409);
    }

    // 4. 友だち登録必須ゲート。pending 行を作る前に弾いてゴミ行を残さない。
    const lineClient = c.env.LINE_CHANNEL_ACCESS_TOKEN
      ? new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN)
      : null;
    const defaultAccountId = await resolveDefaultLineAccountId(c.env.DB, c.env);
    const applicant = await resolveEventApplicant(c.env.DB, lineUserId, lineClient, defaultAccountId);
    if (applicant.status === 'unavailable') {
      return c.json({ success: false, error: 'friend_check_unavailable' }, 503);
    }
    if (applicant.status === 'not_friend') {
      return c.json({ success: false, error: 'friend_required' }, 403);
    }
    const friendId = applicant.friendId;

    // 5. 仮登録（pending / unpaid）
    const booking = await createPendingBooking(c.env.DB, { event_id: id, friend_id: friendId });

    // 6. Stripe Checkout Session 作成
    const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, {
      apiVersion: '2026-04-22.dahlia',
      httpClient: Stripe.createFetchHttpClient(),
    });

    const liffBase = c.env.LIFF_BASE_URL ?? '';
    let session: { id: string; url: string | null };
    try {
      session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [{
          price_data: {
            currency: 'jpy',
            unit_amount: event.price ?? 0,
            product_data: { name: event.title },
          },
          quantity: 1,
        }],
        success_url: `${liffBase}?page=event&payment=success&bookingId=${booking.id}`,
        cancel_url:  `${liffBase}?page=event&payment=cancel&bookingId=${booking.id}`,
        metadata: {
          bookingId: String(booking.id),
          lineUserId,
          eventId: String(id),
        },
        expires_at: Math.floor(Date.now() / 1000) + 1800,
      });
    } catch (stripeErr) {
      console.error('Stripe checkout.sessions.create error:', stripeErr);
      return c.json({ success: false, error: 'Stripe API error' }, 500);
    }

    // 7. stripe_session_id を更新
    await updateBookingStripeSessionId(c.env.DB, booking.id, session.id);

    return c.json({ success: true, data: { url: session.url } });
  } catch (err) {
    console.error('POST /api/events/:id/checkout-session error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== LIFF: イベント予約キャンセル ==========

events.post('/api/events/bookings/:id/cancel', async (c) => {
  try {
    const bookingId = Number(c.req.param('id'));
    const lineUserId = c.req.header('x-line-user-id') ?? null;

    // lineUserId → friendId 解決（ベストエフォート）
    let friendId: string | null = null;
    if (lineUserId) {
      try {
        const row = await c.env.DB
          .prepare('SELECT id FROM friends WHERE line_user_id = ? LIMIT 1')
          .bind(lineUserId)
          .first<{ id: string }>();
        friendId = row?.id ?? null;
      } catch {
        // フォールバック: friend_id なしで続行
      }
    }

    const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, {
      apiVersion: '2026-04-22.dahlia',
      httpClient: Stripe.createFetchHttpClient(),
    });

    const result = await cancelEventBooking(c.env.DB, bookingId, friendId, stripe);
    if (!result.success) {
      return c.json({ success: false, error: result.error }, 400);
    }

    // LINE push通知（ベストエフォート）
    if (lineUserId && c.env.LINE_CHANNEL_ACCESS_TOKEN && result.eventId) {
      try {
        const event = await getEventById(c.env.DB, result.eventId);
        const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
        const dateStr = event?.start_at ? formatJST(event.start_at) : '';
        const bodyContents: object[] = [
          { type: 'text', text: event?.title ?? 'イベント', weight: 'bold', size: 'md', wrap: true },
          { type: 'text', text: `日時：${dateStr}`, size: 'sm', color: '#666666', wrap: true },
        ];
        if (result.refunded) {
          bodyContents.push({ type: 'text', text: '返金処理を開始しました。カードの種類や銀行によって、口座への反映まで 5〜10 営業日ほどかかる場合があります。', size: 'sm', color: '#999999', wrap: true });
        }
        await lineClient.pushMessage(lineUserId, [{
          type: 'flex',
          altText: `キャンセルが完了しました：${event?.title ?? 'イベント'}`,
          contents: {
            type: 'bubble',
            header: {
              type: 'box', layout: 'vertical', paddingAll: '16px',
              backgroundColor: '#999999',
              contents: [{ type: 'text', text: 'キャンセルが完了しました', color: '#ffffff', weight: 'bold', size: 'md' }],
            },
            body: {
              type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'sm',
              contents: bodyContents,
            },
          } as never,
        }]);
      } catch {
        // ベストエフォート
      }
    }

    return c.json({ success: true, data: { refunded: result.refunded } });
  } catch (err) {
    console.error('POST /api/events/bookings/:id/cancel error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/events/:id/enroll-participants - 確定参加者を一括でフォローシナリオに登録（管理者専用）
events.post('/api/events/:id/enroll-participants', async (c) => {
  try {
    const id = Number(c.req.param('id'));
    if (Number.isNaN(id)) {
      return c.json({ success: false, error: 'Invalid event id' }, 400);
    }
    const body = await c.req.json<{ scenarioId?: string }>();
    if (!body.scenarioId) {
      return c.json({ success: false, error: 'scenarioId is required' }, 400);
    }

    // シナリオの存在と種別を検証（event_booking 以外は誤登録防止のため拒否）
    const scenario = await getScenarioById(c.env.DB, body.scenarioId);
    if (!scenario) {
      return c.json({ success: false, error: 'Scenario not found' }, 404);
    }
    if (scenario.trigger_type !== 'event_booking') {
      return c.json(
        { success: false, error: 'トリガーが「イベント参加・決済時」のシナリオのみ登録できます' },
        400,
      );
    }

    const result = await enrollEventParticipants(c.env.DB, id, body.scenarioId);
    if (!result.eventFound) {
      return c.json({ success: false, error: 'Event not found' }, 404);
    }

    return c.json({ success: true, data: { enrolled: result.enrolled, total: result.total } });
  } catch (err) {
    console.error('POST /api/events/:id/enroll-participants error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== 管理API: friend_id 未連携の遡及復元 ==========

events.post('/api/events/:id/backfill-friends', async (c) => {
  try {
    const id = Number(c.req.param('id'));
    if (Number.isNaN(id)) {
      return c.json({ success: false, error: 'Invalid event id' }, 400);
    }
    const event = await getEventById(c.env.DB, id);
    if (!event) return c.json({ success: false, error: 'Event not found' }, 404);

    const stripe = c.env.STRIPE_SECRET_KEY
      ? new Stripe(c.env.STRIPE_SECRET_KEY, {
          apiVersion: '2026-04-22.dahlia',
          httpClient: Stripe.createFetchHttpClient(),
        })
      : null;
    const lineClient = c.env.LINE_CHANNEL_ACCESS_TOKEN
      ? new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN)
      : null;
    const lineAccountId = await resolveDefaultLineAccountId(c.env.DB, c.env);

    const result = await backfillEventBookingFriends(c.env.DB, id, stripe, lineClient, lineAccountId);
    return c.json({ success: true, data: result });
  } catch (err) {
    console.error('POST /api/events/:id/backfill-friends error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

events.post('/api/events/bookings/:id/link-friend', async (c) => {
  try {
    const bookingId = Number(c.req.param('id'));
    if (Number.isNaN(bookingId)) {
      return c.json({ success: false, error: 'Invalid booking id' }, 400);
    }
    const body = await c.req.json<{ friendId?: string }>();
    if (!body.friendId) {
      return c.json({ success: false, error: 'friendId is required' }, 400);
    }

    const result = await linkBookingToFriend(c.env.DB, bookingId, body.friendId);
    if (!result.ok) {
      const message = result.error === 'friend_not_found'
        ? '指定された友だちが見つかりません'
        : '指定された申込が見つかりません';
      return c.json({ success: false, error: message }, 404);
    }
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('POST /api/events/bookings/:id/link-friend error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { events };
