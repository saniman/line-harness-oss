// LIFF 由来リクエストの本人確認・アカウント解決ヘルパー。
//
// salon-booking (routes/booking.ts) の同名プライベート関数と同じ挙動を、
// 他ルート（モバイルオーダー等）からも使えるよう切り出したもの。
// booking.ts 側は既存のプライベート実装を温存しているため、本モジュールの変更は
// salon-booking の挙動には影響しない。

import type { Context } from 'hono'
import { getLineAccounts } from '@line-crm/db'
import type { Env } from '../index.js'

// liffId クエリから line_account を解決する。
export async function resolveAccountIdFromLiff(c: Context<Env>): Promise<string | null> {
  const liffId = c.req.query('liffId')
  if (!liffId) return null
  const acc = await c.env.DB
    .prepare(`SELECT id FROM line_accounts WHERE liff_id = ? AND is_active = 1`)
    .bind(liffId)
    .first<{ id: string }>()
  return acc?.id ?? null
}

/** 本人確認の失敗理由。expired はクライアントが再ログインで自力復帰できる（#28）。 */
export type CallerAuthFailure = 'missing' | 'expired' | 'invalid'

export type CallerAuthResult =
  | { ok: true; lineUserId: string }
  | { ok: false; reason: CallerAuthFailure }

/** ID トークン(JWT)の exp をミリ秒で返す。読めなければ null。 */
function getIdTokenExpMs(idToken: string): number | null {
  try {
    const parts = idToken.split('.')
    if (parts.length !== 3) return null
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    const payload = JSON.parse(atob(padded)) as { exp?: unknown }
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null
  } catch {
    return null
  }
}

// Authorization: Bearer <id_token> を LINE verify API で検証し、LINE userId(sub) を返す。
// 失敗時は null（呼び出し側で 401）。
// 失敗理由まで必要な場合は verifyCaller を使う。
export async function verifyCallerLineUserId(c: Context<Env>): Promise<string | null> {
  const result = await verifyCaller(c)
  return result.ok ? result.lineUserId : null
}

/**
 * verifyCallerLineUserId と同じ検証を行い、**失敗理由まで返す**。
 *
 * ID トークンの有効期限は発行から1時間しかないため、期限切れは正常系に近い頻度で起きる。
 * これを invalid と一緒くたにすると、クライアントが「再ログインすれば直る」と判断できず、
 * ユーザーが詰む（#28 の実インシデント）。
 */
export async function verifyCaller(c: Context<Env>): Promise<CallerAuthResult> {
  const auth = c.req.header('Authorization')
  if (!auth || !auth.startsWith('Bearer ')) return { ok: false, reason: 'missing' }
  const idToken = auth.slice('Bearer '.length).trim()
  if (!idToken) return { ok: false, reason: 'missing' }

  // 期限切れは手元で判定できる。LINE に問い合わせる前に返して往復を省く。
  const expMs = getIdTokenExpMs(idToken)
  if (expMs !== null && expMs <= Date.now()) return { ok: false, reason: 'expired' }

  const candidates: string[] = []
  const push = (v: string | null | undefined) => {
    if (v && !candidates.includes(v)) candidates.push(v)
  }

  push(c.env.LINE_LOGIN_CHANNEL_ID)
  const dbAccounts = await getLineAccounts(c.env.DB)
  for (const a of dbAccounts) {
    const acc = a as unknown as {
      login_channel_id?: string | null
      channel_id?: string | null
      liff_id?: string | null
    }
    push(acc.login_channel_id)
    push(acc.channel_id)
    const liffPrefix = acc.liff_id?.split('-')[0]
    push(liffPrefix)
  }

  try {
    const parts = idToken.split('.')
    if (parts.length === 3) {
      const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
      const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
      const json = JSON.parse(atob(padded))
      if (typeof json.aud === 'string') push(json.aud)
      else if (Array.isArray(json.aud)) for (const a of json.aud) push(String(a))
    }
  } catch {
    /* decode 失敗は無視: 候補 URL のみで verify を試す */
  }

  let sawExpired = false
  for (const channelId of candidates) {
    const res = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: channelId }),
    })
    if (res.ok) {
      const verified = await res.json<{ sub?: string }>()
      if (verified.sub) return { ok: true, lineUserId: verified.sub }
    } else {
      const errBody = await res.text().catch(() => '')
      // exp が読めなかった等でローカル判定を抜けても、LINE 側が期限切れと言うなら expired にする
      if (/expired/i.test(errBody)) sawExpired = true
      console.log(
        `[verifyCaller] verify fail channel=${channelId} status=${res.status} body=${errBody.slice(0, 200)}`,
      )
    }
  }
  return { ok: false, reason: sawExpired ? 'expired' : 'invalid' }
}

// account スコープで line_user_id → friend_id を解決する。
export async function resolveFriendId(
  db: D1Database,
  lineUserId: string,
  accountId: string,
): Promise<string | null> {
  const f = await db
    .prepare(`SELECT id FROM friends WHERE line_user_id = ? AND line_account_id = ?`)
    .bind(lineUserId, accountId)
    .first<{ id: string }>()
  return f?.id ?? null
}
