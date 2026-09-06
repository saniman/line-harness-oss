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
  failCheckoutBooking,
  cancelEventBooking,
  linkBookingToFriend,
  markCashReceived,
} from '../services/events.js';
import { enrollEventFollowupScenarios, enrollEventParticipants } from '../services/event-followup.js';
import { issueReceiptForBooking } from '../services/freee-receipt.js';
import { saveReceiptShareUrl, revokeReceiptShare } from '../services/receipt-share.js';
import { sendReceiptToParticipant } from '../services/receipt-notify.js';
import { notifyBookingCancelled } from '../services/booking-cancel-notify.js';
import { requireRole } from '../middleware/role-guard.js';
import type { IssueReceiptResult, ReceiptIssueCode } from '../services/freee-receipt.js';
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

/** 管理画面のフォームは未入力を '' で送ってくる。DB では「未設定」= NULL に寄せる。 */
function emptyToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
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
      reminder_at?: string | null;
      reminder_message_extra?: string | null;
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
      // 空文字は「未設定」。そのまま入れると reminder_at IS NOT NULL に引っかかり、
      // 日時として読めない行が cron の候補に混ざる（#67）
      reminder_at: emptyToNull(body.reminder_at),
      reminder_message_extra: emptyToNull(body.reminder_message_extra),
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
      reminder_at?: string | null;
      reminder_message_extra?: string | null;
    }>();
    const event = await updateEvent(c.env.DB, id, {
      ...body,
      // undefined（未指定＝変更しない）と '' （クリア＝NULL）を区別する
      ...(body.reminder_at !== undefined ? { reminder_at: emptyToNull(body.reminder_at) } : {}),
      ...(body.reminder_message_extra !== undefined
        ? { reminder_message_extra: emptyToNull(body.reminder_message_extra) }
        : {}),
    });
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
    const body = await c.req.json<{
      name?: string;
      paymentMethod?: string;
      receiptName?: string;
      /** 領収書が必要か（#80）。未指定＝この機能より前のクライアント */
      receiptRequested?: boolean;
    }>();
    const isCash = body.paymentMethod === 'cash';

    // 領収書の要否（#80）。boolean 以外（未指定・古いバンドル）は **null＝未回答**。
    // ⚠️ ここを 0（不要）に倒すと、古い画面を開いたままの人の領収書が黙って出なくなる。
    const receiptRequested = typeof body.receiptRequested === 'boolean'
      ? (body.receiptRequested ? 1 : 0)
      : null;
    const receiptName = body.receiptName?.trim() || null;

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

    // 「必要」と答えたのに宛名が無ければ断る。画面では押せないが、直接叩かれる経路を塞ぐ。
    // 通すと宛名の無い領収書ができて freee 側で作り直しになる。
    //
    // ⚠️ 本人確認・締切・満席・友だちゲートの**後**に置く。前に出すと、未認証の相手に
    //    401 ではなく 400 を返し、締切のイベントでも 409 application_closed ではなく
    //    400 を返してしまう（クライアントの締切ハンドリングを迂回する）。
    if (receiptRequested === 1 && !receiptName) {
      return c.json({ success: false, error: 'receipt_name_required' }, 400);
    }

    const booking = await createEventBooking(c.env.DB, {
      event_id: id,
      friend_id: friendId,
      name: body.name ?? '',
      // 領収書の宛名。正規化は createEventBooking の中で行う。
      // ⚠️ 「不要」と答えた人の宛名は保存しない。残すと、後から発行されたときに
      //    「頼んでいない領収書」が届く
      receipt_name: receiptRequested === 0 ? null : receiptName,
      receipt_requested: receiptRequested,
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
      // 作りかけの pending を後始末する。ここで放置すると stripe_session_id が NULL のまま
      // 名前が空の行が残り、Stripe 側にセッションが無いので expired webhook も届かない。
      // ベストエフォート（失敗しても 6h cron の掃除ネットが拾う）。
      try {
        await failCheckoutBooking(c.env.DB, booking.id);
      } catch (cleanupErr) {
        console.error('[checkout-session] pending cleanup failed:', cleanupErr);
      }
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
      // ⚠️ 文言ではなく code で分岐できるようにする（LIFF 側で案内を変えられる）。
      //    現金受領済み（cash_received）は「主催者へご連絡ください」を出す
      return c.json({ success: false, error: result.error, code: result.code }, 400);
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

/**
 * 運営者が予約を取り消す（Issue #65）。
 *
 * 現金受領済みの予約は参加者から取り消せないようにしたので、**その誘導先**として要る。
 * 「現金を返した」という現実の行為を、運営者がここで記録する。
 *
 * ⚠️ **認証必須**。公開すると第三者が他人の予約を取り消せる。
 */
events.post('/api/events/:id/bookings/:bookingId/admin-cancel', requireRole('owner'), async (c) => {
  try {
    const eventId = Number(c.req.param('id'));
    const bookingId = Number(c.req.param('bookingId'));
    if (!Number.isInteger(eventId) || !Number.isInteger(bookingId)) {
      return c.json({ success: false, error: 'Invalid id' }, 400);
    }

    // ⚠️ キー未設定でも落とさない。stripe@22 は key が無いと **コンストラクタで例外**を
    //    投げるため、Stripe を使っていない現金運用では**唯一の取り消し導線が常時 500**になる。
    //    現金・無料の取り消しは Stripe を使わないので、無くても成立する。
    const stripe = c.env.STRIPE_SECRET_KEY
      ? new Stripe(c.env.STRIPE_SECRET_KEY, {
          apiVersion: '2026-04-22.dahlia',
          httpClient: Stripe.createFetchHttpClient(),
        })
      : null;

    // friendId は渡さない（管理画面は本人確認を持たない）。byAdmin で免除する。
    // ⚠️ eventId は必ず渡す。渡さないと別イベントの予約を取り消せて Stripe 返金まで走る
    const result = await cancelEventBooking(c.env.DB, bookingId, null, stripe, {
      byAdmin: true,
      eventId,
    });
    if (!result.success) {
      const status = result.code === 'not_found' ? 404
        : result.code === 'already_cancelled' ? 409
        : 400;
      return c.json({ success: false, error: result.error, code: result.code }, status);
    }

    // ⚠️ キャンセルが**成功したときだけ**リンクを止める。順序を逆にすると、
    //    キャンセルに失敗したのに参加者が領収書を開けなくなる。
    //    無効化の失敗でキャンセルまで失敗にはしない（現金はもう返している）。
    //
    // ⚠️ 3状態で返す。true/false の2値だと「そもそもリンクが無い」と
    //    「無効化に失敗した」が区別できず、失敗が画面で無音になる。
    let receiptRevoked: 'revoked' | 'none' | 'failed' = 'none';
    try {
      const revoked = await revokeReceiptShare(c.env.DB, eventId, bookingId);
      receiptRevoked = revoked.ok ? 'revoked' : 'none';
    } catch (err) {
      console.error('[events] キャンセル後の共有リンク無効化に失敗:', bookingId, err);
      receiptRevoked = 'failed';
    }

    // 取り消したことを参加者にも伝える（ベストエフォート）。
    // 「主催者へご連絡ください」で止められた後なので、処理されたことが分かる方が親切。
    // ⚠️ 結果を捨てない。friend_id が無い参加者には**何も届かない**ので、
    //    「取り消しました」だけ出すと運営者は伝わったと思い込む
    // ⚠️ 3状態にする。boolean だと「LINE が未設定」でも「友だち未連携」と表示され、
    //    運営者が存在しない紐付け問題を追いかけることになる
    let notified: 'sent' | 'no_friend' | 'line_unavailable' = 'line_unavailable';
    if (c.env.LINE_CHANNEL_ACCESS_TOKEN) {
      try {
        const ok = await notifyBookingCancelled(
          c.env.DB, new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN), bookingId,
          result.refundResult === 'refunded',
        );
        notified = ok ? 'sent' : 'no_friend';
      } catch (err) {
        console.error('[events] キャンセル通知に失敗:', bookingId, err);
        notified = 'line_unavailable';
      }
    }

    console.log(
      '[events] 運営者が予約を取り消しました:', bookingId,
      `(返金: ${result.refundResult} / 領収書リンク: ${receiptRevoked} / 通知: ${notified})`,
    );
    return c.json({
      success: true,
      data: { refundResult: result.refundResult, receiptRevoked, notified },
    });
  } catch (err) {
    console.error('POST /api/events/:id/bookings/:bookingId/admin-cancel error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * 領収書の共有リンクを登録する（Issue #47）。
 *
 * ⚠️ **認証必須**。スキップリストに入れてはいけない。
 *    公開すると、第三者が任意の参加者に任意の URL を仕込めるようになる。
 */
events.put('/api/events/:id/bookings/:bookingId/receipt-share', async (c) => {
  try {
    const eventId = Number(c.req.param('id'));
    const bookingId = Number(c.req.param('bookingId'));
    if (!Number.isInteger(eventId) || !Number.isInteger(bookingId)) {
      return c.json({ success: false, error: 'Invalid id' }, 400);
    }

    const body = await c.req.json<{ url?: unknown }>().catch(() => ({} as { url?: unknown }));
    if (typeof body.url !== 'string') {
      return c.json({ success: false, error: 'url が必要です', code: 'invalid_url' }, 400);
    }

    const result = await saveReceiptShareUrl(c.env.DB, eventId, bookingId, body.url);
    if (!result.ok) {
      // 文言ではなく code で分岐する（文言を直した瞬間にステータスが変わる壊れ方を防ぐ）
      const status = result.code === 'not_found' ? 404
        : result.code === 'duplicate' ? 409
        : 400;
      return c.json({ success: false, error: result.error, code: result.code }, status);
    }

    // ⚠️ 共有 URL・トークンをログに出さない
    console.log('[receipt] 共有リンクを登録:', bookingId, result.verified ? '(照合済み)' : '(未照合)');
    return c.json({ success: true, data: { verified: result.verified } });
  } catch (err) {
    console.error('PUT /api/events/:id/bookings/:bookingId/receipt-share error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * 登録済みの共有リンクを LINE で参加者に送る（Issue #47）。
 *
 * ⚠️ **認証必須**。公開すると第三者が任意の参加者へ送信を起こせる。
 */
events.post('/api/events/:id/bookings/:bookingId/send-receipt', async (c) => {
  try {
    const eventId = Number(c.req.param('id'));
    const bookingId = Number(c.req.param('bookingId'));
    if (!Number.isInteger(eventId) || !Number.isInteger(bookingId)) {
      return c.json({ success: false, error: 'Invalid id' }, 400);
    }

    // 未照合のまま送るには、運営者の明示的な確認が要る（サーバー側で検査する）
    const body = await c.req
      .json<{ confirmed?: unknown }>()
      .catch(() => ({} as { confirmed?: unknown }));
    // ⚠️ 厳密に true だけを確認とみなす。'true' や 1 を通すと、
    //    意図しない値で「運営者が確認済み」扱いになる
    const confirmed = body.confirmed === true;

    const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
    const result = await sendReceiptToParticipant(
      c.env.DB,
      lineClient,
      // ⚠️ WORKER_URL は本番で未設定。無いと undefined.replace で 500 になり、
      //    運営者には原因不明のエラーしか出ない。repo の既存パターンに合わせて
      //    リクエストの origin にフォールバックする（tracked-links.ts と同じ）
      c.env.WORKER_URL || new URL(c.req.url).origin,
      eventId,
      bookingId,
      confirmed,
    );

    if (!result.ok) {
      const status = result.code === 'not_found' ? 404
        : result.code === 'already_sent' ? 409
        : result.code === 'send_failed' ? 502
        : 400;
      return c.json({ success: false, error: result.error, code: result.code }, status);
    }

    return c.json({ success: true });
  } catch (err) {
    console.error('POST /api/events/:id/bookings/:bookingId/send-receipt error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * 誤配に気づいたときに共有リンクを無効化する（Issue #47 第2層）。
 *
 * ⚠️ **認証必須**。ここが公開されると、第三者が正常な領収書を止められる。
 */
events.post('/api/events/:id/bookings/:bookingId/revoke-receipt', async (c) => {
  try {
    const eventId = Number(c.req.param('id'));
    const bookingId = Number(c.req.param('bookingId'));
    if (!Number.isInteger(eventId) || !Number.isInteger(bookingId)) {
      return c.json({ success: false, error: 'Invalid id' }, 400);
    }

    const result = await revokeReceiptShare(c.env.DB, eventId, bookingId);
    if (!result.ok) return c.json({ success: false, error: result.error }, 404);

    return c.json({ success: true });
  } catch (err) {
    console.error('POST /api/events/:id/bookings/:bookingId/revoke-receipt error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * 発行できなかった理由 → HTTP ステータス。
 *
 * ⚠️ **文言ではなくコードで対応づける**（`.claude/rules/api-coding.md`）。
 *    それぞれ「誰が何をすれば直るか」が違うので、まとめて 502 にしない。
 *      404 = 対象がそもそも違う（探し直す）
 *      409 = いまは無理だが状態が変われば通る（待つ・受領する）
 *      400 = 送った内容が足りない（入力を直す）
 *      502 = freee 側の問題（時間をおく・再認可する）
 */
const ISSUE_FAILURE_STATUS: Record<ReceiptIssueCode, 400 | 404 | 409 | 502> = {
  not_found: 404,
  event_mismatch: 404,
  cancelled: 409,
  not_received: 409,
  issue_in_progress: 409,
  no_payee: 400,
  no_amount: 400,
  bad_date: 400,
  freee_unavailable: 502,
  freee_reauth_required: 502,
  issue_failed: 502,
  // 明示指示（forceIssue）で呼ぶのでここには来ないが、型の網羅性のために置く
  not_requested: 409,
};

/**
 * 「領収書は不要」と答えられた予約を、あとから発行する（Issue #82・管理画面の導線）。
 *
 * 当日その場で「やっぱり領収書ください」と言われたときの唯一の経路。
 * これが無いと、`receipt_requested = 0` の予約は**システム内では二度と発行できない**
 * （現金受領ボタンは受領後に消えるため、発行を呼ぶ入口がなくなる）。
 *
 * ⚠️ 認証必須。公開すると第三者に領収書を発行させられる。
 *    ロールは絞らない（受付業務のため。cash-received と同じ扱い）。
 *
 * ⚠️ **参加者の回答（receipt_requested）は書き換えない。** 今回だけ上書きして発行する。
 */
events.post('/api/events/:id/bookings/:bookingId/issue-receipt', async (c) => {
  try {
    const eventId = Number(c.req.param('id'));
    const bookingId = Number(c.req.param('bookingId'));
    if (!Number.isInteger(eventId) || !Number.isInteger(bookingId)) {
      return c.json({ success: false, error: 'Invalid id' }, 400);
    }

    const body = await c.req.json<{ payeeName?: string }>().catch(() => ({} as { payeeName?: string }));
    const payeeName = body.payeeName?.trim() || null;
    // ⚠️ 宛名は必須。「いいえ」と答えた人は receipt_name が NULL なので、
    //    ここを通すと LINE の表示名（ニックネームのことがある）で発行されてしまう。
    if (!payeeName) {
      return c.json({ success: false, error: 'receipt_name_required' }, 400);
    }

    const event = await getEventById(c.env.DB, eventId);
    const receipt = await issueReceiptForBooking(
      c.env,
      c.env.DB,
      eventId,
      bookingId,
      undefined,
      { eventTitle: event?.title, forceIssue: true, payeeName },
    );

    if (!receipt.issued) {
      // ⚠️ 成功に見せない。運営者は「発行した」と思って参加者に伝えてしまう。
      //    文言ではなくコードで分岐できるよう code も返す。
      //
      // ⚠️ **残り全部を 502 にまとめない。** 502 は「上流（freee）が壊れている」の意味なので、
      //    データ側の問題やイベント指定違いまで 502 にすると、運営者もログ監視も
      //    freee を疑って原因を追うことになる。
      const status = ISSUE_FAILURE_STATUS[receipt.code ?? 'issue_failed'] ?? 502;
      return c.json({
        success: false,
        error: receipt.error ?? '領収書を発行できませんでした。',
        code: receipt.code ?? null,
      }, status);
    }

    console.log('[freee] 領収書をあとから発行しました:', bookingId);

    return c.json({
      success: true,
      data: {
        receiptIssued: true,
        receiptUrl: receipt.receiptUrl ?? null,
        alreadyIssued: receipt.alreadyIssued ?? false,
        receiptWarning: receipt.warning ?? null,
      },
    });
  } catch (err) {
    console.error('POST /api/events/:id/bookings/:bookingId/issue-receipt error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/**
 * 当日現金の受領を記録する（管理画面の「現金受領」ボタン）。
 *
 * 現金は受け取ったというデジタルな信号が無いので、人間が押す。
 * ここで記録した cash_received_at を起点に領収書を発行する（#46）。
 *
 * ⚠️ 認証必須。公開すると第三者が勝手に受領済みにして領収書を発行させられる。
 *    ロールは絞らない（受付での現金受領はスタッフの通常業務のため）。
 */
events.post('/api/events/:id/bookings/:bookingId/cash-received', async (c) => {
  try {
    const eventId = Number(c.req.param('id'));
    const bookingId = Number(c.req.param('bookingId'));
    if (!Number.isInteger(eventId) || !Number.isInteger(bookingId)) {
      return c.json({ success: false, error: 'Invalid id' }, 400);
    }

    const result = await markCashReceived(c.env.DB, eventId, bookingId);

    if (!result.success) {
      // ⚠️ 日本語の文言で分岐しない。文言を直した瞬間にステータスが変わってしまう。
      //    404 = そもそも無い / 409 = 状態が変わって記録できない / 400 = 対象外
      const status = result.code === 'not_found' ? 404
        : result.code === 'state_changed' ? 409
        : 400;
      return c.json({ success: false, error: result.error, code: result.code }, status);
    }

    console.log('[events] 現金受領を記録:', bookingId, result.alreadyReceived ? '(既に受領済み)' : '');

    // 領収書の発行はベストエフォート。ここで失敗しても現金受領は成功として返す。
    // 現金は物理的に受け取っているので、記録を巻き戻すと経理が合わなくなる（#46）。
    // 未発行分の再送は #48 で扱う。
    //
    // ⚠️ issueReceiptForBooking は「投げない」設計だが、ここでも囲う。
    //    外側の catch に流すと 500 になり、記録済みの現金受領まで失敗として返ってしまう。
    let receipt: IssueReceiptResult;
    try {
      const event = await getEventById(c.env.DB, eventId);
      receipt = await issueReceiptForBooking(
        c.env,
        c.env.DB,
        eventId,
        bookingId,
        undefined,
        { eventTitle: event?.title },
      );
    } catch (err) {
      console.error('[freee] 領収書の発行で想定外のエラー:', bookingId, err);
      receipt = { issued: false, code: 'issue_failed', error: '領収書を発行できませんでした。' };
    }

    return c.json({
      success: true,
      data: {
        alreadyReceived: result.alreadyReceived,
        cashReceivedAt: result.booking?.cash_received_at ?? null,
        receiptIssued: receipt.issued,
        receiptUrl: receipt.receiptUrl ?? null,
        // 未発行の理由は管理画面にだけ出す（参加者には見せない）
        receiptError: receipt.issued ? null : (receipt.error ?? null),
        // ⚠️ 文言ではなくコードで分岐させる。「不要と答えられた（not_requested）」は
        //    失敗ではないので、管理画面が警告ではなく事実として出せるようにする
        receiptCode: receipt.code ?? null,
        // ⚠️ 発行できたときも出す。二重発行の疑いはここでしか伝わらない
        receiptWarning: receipt.warning ?? null,
      },
    });
  } catch (err) {
    console.error('POST /api/events/:id/bookings/:bookingId/cash-received error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { events };
