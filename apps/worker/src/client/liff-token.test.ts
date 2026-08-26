import { describe, it, expect, vi } from 'vitest'
import {
  getIdTokenExpMs,
  isIdTokenExpired,
  recoverLiffSession,
  markLiffSessionHealthy,
  RECOVERY_STORAGE_KEY,
} from './liff-token.js'

/** exp（秒）だけを持つダミーの ID トークン（JWT 形式）を作る */
function makeIdToken(expSeconds: number): string {
  const b64url = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${b64url({ alg: 'HS256' })}.${b64url({ exp: expSeconds, sub: 'U1' })}.sig`
}

function makeStorage(initial: Record<string, string> = {}) {
  const data = { ...initial }
  return {
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => { data[k] = v },
    data,
  }
}

const NOW = 1_700_000_000_000 // 2023-11-14T22:13:20Z 相当

describe('ID トークンの有効期限', () => {
  it('exp をミリ秒で取り出せる', () => {
    const token = makeIdToken(1_700_000_600)
    expect(getIdTokenExpMs(token)).toBe(1_700_000_600_000)
  })

  it('JWT 形式でない文字列からは exp を取り出せない', () => {
    expect(getIdTokenExpMs('not-a-jwt')).toBeNull()
  })

  it('期限が切れているトークンは期限切れと判定される', () => {
    const token = makeIdToken(NOW / 1000 - 10)
    expect(isIdTokenExpired(token, NOW)).toBe(true)
  })

  it('期限まで十分あるトークンは期限切れと判定されない', () => {
    const token = makeIdToken(NOW / 1000 + 3600)
    expect(isIdTokenExpired(token, NOW)).toBe(false)
  })

  it('期限まで数秒しかないトークンは期限切れ扱いにする（通信中に切れるため）', () => {
    const token = makeIdToken(NOW / 1000 + 5)
    expect(isIdTokenExpired(token, NOW)).toBe(true)
  })

  it('トークンが無い場合はサーバー判断に委ね、期限切れ扱いにしない', () => {
    expect(isIdTokenExpired(null, NOW)).toBe(false)
    expect(isIdTokenExpired(undefined, NOW)).toBe(false)
  })

  it('exp を読めないトークンはサーバー判断に委ね、期限切れ扱いにしない', () => {
    expect(isIdTokenExpired('not-a-jwt', NOW)).toBe(false)
  })
})

describe('LIFF セッションの復帰', () => {
  it('LINE アプリ内ではリロードして liff.init() を走らせ直す', () => {
    // liff.login() は LIFF ブラウザでは使えない（init 時に自動実行されるため）
    const reload = vi.fn()
    const login = vi.fn()
    const logout = vi.fn()
    const storage = makeStorage()

    const recovered = recoverLiffSession({
      isInClient: true, reload, login, logout, href: 'https://liff.example/?page=event', storage,
    })

    expect(recovered).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(login).not.toHaveBeenCalled()
    expect(logout).not.toHaveBeenCalled()
  })

  it('外部ブラウザでは liff.login() で再ログインさせる', () => {
    const reload = vi.fn()
    const login = vi.fn()
    const logout = vi.fn()
    const storage = makeStorage()

    const recovered = recoverLiffSession({
      isInClient: false, reload, login, logout, href: 'https://liff.example/?page=event', storage,
    })

    expect(recovered).toBe(true)
    expect(login).toHaveBeenCalledWith({ redirectUri: 'https://liff.example/?page=event' })
    expect(reload).not.toHaveBeenCalled()
  })

  it('外部ブラウザでは login の前に logout してログイン状態を捨てる', () => {
    // liff.login() は「ログイン済み」だと何もしない。ID トークンだけ期限切れのときは
    // SDK 上はログイン済みのままなので、logout しないと復帰が無言で失敗する。
    const calls: string[] = []
    const logout = vi.fn(() => { calls.push('logout') })
    const login = vi.fn(() => { calls.push('login') })
    const storage = makeStorage()

    const recovered = recoverLiffSession({
      isInClient: false, reload: vi.fn(), login, logout, href: 'https://liff.example/', storage,
    })

    expect(recovered).toBe(true)
    expect(calls).toEqual(['logout', 'login'])
  })

  it('復帰を1回試したあとは再試行せず false を返す（リロード地獄の防止）', () => {
    const reload = vi.fn()
    const storage = makeStorage()
    const deps = { isInClient: true, reload, login: vi.fn(), logout: vi.fn(), href: 'https://liff.example/', storage }

    expect(recoverLiffSession(deps)).toBe(true)
    expect(recoverLiffSession(deps)).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('sessionStorage が使えない場合は自動復帰しない（試行回数を数えられずループするため）', () => {
    const reload = vi.fn()
    const recovered = recoverLiffSession({
      isInClient: true, reload, login: vi.fn(), logout: vi.fn(), href: 'https://liff.example/', storage: null,
    })

    expect(recovered).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('API 呼び出しが成功したら試行回数をリセットし、次回また復帰できる', () => {
    const reload = vi.fn()
    const storage = makeStorage()
    const deps = { isInClient: true, reload, login: vi.fn(), logout: vi.fn(), href: 'https://liff.example/', storage }

    expect(recoverLiffSession(deps)).toBe(true)
    markLiffSessionHealthy(storage)
    expect(storage.getItem(RECOVERY_STORAGE_KEY)).toBe('0')
    expect(recoverLiffSession(deps)).toBe(true)
    expect(reload).toHaveBeenCalledTimes(2)
  })
})
