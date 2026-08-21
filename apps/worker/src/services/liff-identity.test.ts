import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@line-crm/db', () => ({
  getLineAccounts: vi.fn().mockResolvedValue([]),
}))

import { verifyCaller, verifyCallerLineUserId } from './liff-identity.js'

const NOW = 1_700_000_000_000

function makeIdToken(expSeconds: number): string {
  const b64url = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${b64url({ alg: 'HS256' })}.${b64url({ exp: expSeconds, aud: '1661159603', sub: 'U1' })}.sig`
}

/** verifyCaller が使う最小限の Context スタブ */
function makeCtx(authHeader: string | null) {
  return {
    req: { header: (name: string) => (name === 'Authorization' ? authHeader ?? undefined : undefined) },
    env: { LINE_LOGIN_CHANNEL_ID: '1661159603', DB: {} as D1Database },
  } as never
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
})

describe('verifyCaller（LIFF 本人確認の失敗理由の切り分け）', () => {
  it('Authorization ヘッダが無い場合は missing を返す', async () => {
    const result = await verifyCaller(makeCtx(null))
    expect(result).toEqual({ ok: false, reason: 'missing' })
  })

  it('Bearer 形式でない場合は missing を返す', async () => {
    const result = await verifyCaller(makeCtx('Basic xxx'))
    expect(result).toEqual({ ok: false, reason: 'missing' })
  })

  it('exp が過去のトークンは expired を返し、LINE の verify API を呼ばない', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const expired = makeIdToken(NOW / 1000 - 60)

    const result = await verifyCaller(makeCtx(`Bearer ${expired}`))

    expect(result).toEqual({ ok: false, reason: 'expired' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('有効なトークンで verify が成功したら sub を返す', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ sub: 'U-valid' }),
    } as unknown as Response)

    const result = await verifyCaller(makeCtx(`Bearer ${makeIdToken(NOW / 1000 + 3600)}`))

    expect(result).toEqual({ ok: true, lineUserId: 'U-valid' })
  })

  it('verify が失敗したら invalid を返す', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid_request"}',
    } as unknown as Response)

    const result = await verifyCaller(makeCtx(`Bearer ${makeIdToken(NOW / 1000 + 3600)}`))

    expect(result).toEqual({ ok: false, reason: 'invalid' })
  })

  it('LINE が期限切れを理由に拒否した場合も expired として扱う', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid_request","error_description":"IdToken expired."}',
    } as unknown as Response)

    const result = await verifyCaller(makeCtx(`Bearer ${makeIdToken(NOW / 1000 + 3600)}`))

    expect(result).toEqual({ ok: false, reason: 'expired' })
  })
})

describe('verifyCallerLineUserId（既存の呼び出し元向けラッパー）', () => {
  it('成功時は lineUserId を返す', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ sub: 'U-valid' }),
    } as unknown as Response)

    expect(await verifyCallerLineUserId(makeCtx(`Bearer ${makeIdToken(NOW / 1000 + 3600)}`))).toBe('U-valid')
  })

  it('失敗時は理由によらず null を返す（既存の挙動を変えない）', async () => {
    expect(await verifyCallerLineUserId(makeCtx(null))).toBeNull()
    expect(await verifyCallerLineUserId(makeCtx(`Bearer ${makeIdToken(NOW / 1000 - 60)}`))).toBeNull()
  })
})
