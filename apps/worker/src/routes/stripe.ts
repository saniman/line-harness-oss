import { Hono } from 'hono';
import Stripe from 'stripe';
import { LineClient } from '@line-crm/line-sdk';
import {
  getStripeEvents,
  getStripeEventByStripeId,
  createStripeEvent,
  jstNow,
} from '@line-crm/db';
import {
  getEventById,
  getEventBookingById,
  confirmEventBooking,
} from '../services/events.js';
import type { Env } from '../index.js';

const stripe = new Hono<Env>();

interface StripeWebhookBody {
  id: string;
  type: string;
  data: {
    object: {
      id: string;
      amount?: number;
      currency?: string;
      metadata?: Record<string, string>;
      customer?: string;
      status?: string;
    };
  };
}

// ========== Stripeイベント一覧 ==========

stripe.get('/api/integrations/stripe/events', async (c) => {
  try {
    const friendId = c.req.query('friendId') ?? undefined;
    const eventType = c.req.query('eventType') ?? undefined;
    const limit = Number(c.req.query('limit') ?? '100');
    const items = await getStripeEvents(c.env.DB, { friendId, eventType, limit });
    return c.json({
      success: true,
      data: items.map((e) => ({
        id: e.id,
        stripeEventId: e.stripe_event_id,
        eventType: e.event_type,
        friendId: e.friend_id,
        amount: e.amount,
        currency: e.currency,
        metadata: e.metadata ? JSON.parse(e.metadata) : null,
        processedAt: e.processed_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/integrations/stripe/events error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== Stripe Webhookレシーバー ==========

/** Stripe署名検証 */
async function verifyStripeSignature(secret: string, rawBody: string, sigHeader: string): Promise<boolean> {
  // Stripe署名形式: t=timestamp,v1=signature
  const parts = Object.fromEntries(
    sigHeader.split(',').map((p) => {
      const [k, ...v] = p.split('=');
      return [k, v.join('=')];
    }),
  );
  const timestamp = parts.t;
  const expectedSig = parts.v1;
  if (!timestamp || !expectedSig) return false;

  const encoder = new TextEncoder();
  const signedPayload = `${timestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload));
  const computedSig = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return computedSig === expectedSig;
}

stripe.post('/api/integrations/stripe/webhook', async (c) => {
  try {
    const stripeSecret = (c.env as unknown as Record<string, string | undefined>).STRIPE_WEBHOOK_SECRET;
    let body: StripeWebhookBody;

    if (stripeSecret) {
      // 署名検証モード（本番環境）
      const sigHeader = c.req.header('Stripe-Signature') ?? '';
      const rawBody = await c.req.text();

      const valid = await verifyStripeSignature(stripeSecret, rawBody, sigHeader);
      if (!valid) {
        return c.json({ success: false, error: 'Stripe signature verification failed' }, 401);
      }
      body = JSON.parse(rawBody) as StripeWebhookBody;
    } else {
      // シークレット未設定（開発環境向け）
      body = await c.req.json<StripeWebhookBody>();
    }

    // 冪等性チェック
    const existing = await getStripeEventByStripeId(c.env.DB, body.id);
    if (existing) {
      return c.json({ success: true, data: { message: 'Already processed' } });
    }

    const obj = body.data.object;
    const db = c.env.DB;

    // メタデータからfriendIdを取得（Stripeのメタデータにline_friend_idを設定している想定）
    const friendId = obj.metadata?.line_friend_id ?? null;

    // イベントを記録
    const event = await createStripeEvent(db, {
      stripeEventId: body.id,
      eventType: body.type,
      friendId: friendId ?? undefined,
      amount: obj.amount,
      currency: obj.currency,
      metadata: JSON.stringify(obj.metadata ?? {}),
    });

    // 決済成功時の自動処理
    if (body.type === 'payment_intent.succeeded' && friendId) {
      const { applyScoring } = await import('@line-crm/db');
      await applyScoring(db, friendId, 'purchase');

      // 自動タグ付け（product_idベース）
      const productId = obj.metadata?.product_id;
      if (productId) {
        const tag = await db
          .prepare(`SELECT id FROM tags WHERE name = ?`)
          .bind(`purchased_${productId}`)
          .first<{ id: string }>();
        if (tag) {
          await db
            .prepare(`INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, ?)`)
            .bind(friendId, tag.id, jstNow())
            .run();
        }
      }

      // イベントバスに発火（自動化ルール用）
      const { fireEvent } = await import('../services/event-bus.js');
      await fireEvent(db, 'cv_fire', { friendId, eventData: { type: 'purchase', amount: obj.amount, stripeEventId: body.id } });
    }

    // サブスクリプションイベント処理
    if (body.type === 'customer.subscription.deleted' && friendId) {
      const cancelledTag = await db
        .prepare(`SELECT id FROM tags WHERE name = 'subscription_cancelled'`)
        .first<{ id: string }>();
      if (cancelledTag) {
        await db
          .prepare(`INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at) VALUES (?, ?, ?)`)
          .bind(friendId, cancelledTag.id, jstNow())
          .run();
      }
    }

    return c.json({
      success: true,
      data: { id: event.id, stripeEventId: event.stripe_event_id, eventType: event.event_type, processedAt: event.processed_at },
    });
  } catch (err) {
    console.error('POST /api/integrations/stripe/webhook error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// ========== Stripe Checkout Webhook（イベント決済確定） ==========

stripe.post('/api/stripe/webhook', async (c) => {
  // 1. rawボディ取得（署名検証前に text() で読む）
  const rawBody = await c.req.text();
  const signature = c.req.header('stripe-signature') ?? '';

  const stripeClient = new Stripe(c.env.STRIPE_SECRET_KEY, {
    apiVersion: '2026-04-22.dahlia',
    httpClient: Stripe.createFetchHttpClient(),
  });

  // 2. 署名検証
  let event: Stripe.Event;
  try {
    event = await stripeClient.webhooks.constructEventAsync(
      rawBody,
      signature,
      c.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err);
    return c.json({ success: false, error: 'Invalid signature' }, 400);
  }

  // 3. checkout.session.completed のみ処理
  if (event.type !== 'checkout.session.completed') {
    return c.json({ received: true });
  }

  const session = event.data.object as Stripe.Checkout.Session;
  const bookingId = Number(session.metadata?.bookingId);
  const lineUserId = session.metadata?.lineUserId ?? '';
  const eventId = Number(session.metadata?.eventId);

  // 4. booking 取得（冪等性: 存在しなければ無視）
  const booking = await getEventBookingById(c.env.DB, bookingId);
  if (!booking) {
    return c.json({ received: true });
  }

  // 5. booking 確定
  await confirmEventBooking(c.env.DB, bookingId, session.amount_total);

  // 6. LINE Push通知（ベストエフォート）
  if (lineUserId) {
    try {
      const eventRow = await getEventById(c.env.DB, eventId);
      const lineClient = new LineClient(c.env.LINE_CHANNEL_ACCESS_TOKEN);
      const liffBase = c.env.LIFF_BASE_URL ?? '';

      const flex = {
        type: 'bubble',
        header: {
          type: 'box', layout: 'vertical', paddingAll: '16px',
          backgroundColor: '#2DD4BF',
          contents: [{
            type: 'text', text: '✅ お申込みが確定しました',
            color: '#ffffff', weight: 'bold', size: 'md',
          }],
        },
        body: {
          type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'sm',
          contents: [
            {
              type: 'text',
              text: eventRow?.title ?? 'イベント',
              weight: 'bold', size: 'md', wrap: true,
            },
            {
              type: 'text',
              text: `日時：${eventRow?.start_at ?? ''}`,
              size: 'sm', color: '#666666', wrap: true,
            },
          ],
        },
        footer: {
          type: 'box', layout: 'vertical', paddingAll: '12px',
          contents: [{
            type: 'button',
            action: {
              type: 'uri',
              label: 'キャンセルはこちら',
              uri: `${liffBase}?page=event&payment=cancel&bookingId=${bookingId}`,
            },
            style: 'secondary', height: 'sm',
          }],
        },
      };

      await lineClient.pushMessage(lineUserId, [
        { type: 'flex', altText: '✅ お申込みが確定しました', contents: flex as never },
      ]);
    } catch (e) {
      console.error('LINE push notification failed:', e);
    }
  }

  return c.json({ received: true });
});

export { stripe };
