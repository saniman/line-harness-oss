import { describe, it, expect, vi } from 'vitest'
import {
  getIdTokenExpMs,
  isIdTokenExpired,
  recoverLiffSession,
  markLiffSessionHealthy,
  RECOVERY_STORAGE_KEY,
  buildLiffUrl,
  shouldReopenInLiff,
  buildAuthErrorMessage,
  readLiffParam,
  markLiffReopenResolved,
  REOPEN_STORAGE_KEY,
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

// ─── #84: Pages の URL を直接開いたときの行き止まり ───────────

describe('buildLiffUrl（LIFF として開き直す URL）', () => {
  it('クエリをそのまま引き継ぐ', () => {
    expect(buildLiffUrl('1661159603-5qlDj5wV', '?page=event'))
      .toBe('https://liff.line.me/1661159603-5qlDj5wV?page=event')
  })

  it('クエリが無ければ付けない', () => {
    expect(buildLiffUrl('1661159603-5qlDj5wV', ''))
      .toBe('https://liff.line.me/1661159603-5qlDj5wV')
  })

  it('複数のパラメータも保つ（どのイベントを見ていたかを失わない）', () => {
    const url = buildLiffUrl('1661159603-5qlDj5wV', '?page=event&eventId=12')
    expect(url).toContain('page=event')
    expect(url).toContain('eventId=12')
  })

  it('【重要】LIFF ID の形が違えば組み立てない', () => {
    // liffId は ?liffId= から読むためユーザーが自由に入れられる。
    // 素通しすると、こちらが作ったリンクで別の場所へ送ることになる
    expect(buildLiffUrl('https://evil.example.com', '?page=event')).toBeNull()
    expect(buildLiffUrl('../../evil', '')).toBeNull()
    expect(buildLiffUrl('//evil.example.com', '')).toBeNull()
    expect(buildLiffUrl('', '?page=event')).toBeNull()
  })
})

describe('shouldReopenInLiff（LIFF へ開き直すか）', () => {
  const makeStorage = (init: Record<string, string> = {}) => {
    const m = new Map(Object.entries(init))
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => { m.set(k, v) },
      dump: () => Object.fromEntries(m),
    }
  }

  it('LIFF の外なら開き直す', () => {
    expect(shouldReopenInLiff({ isInClient: false, storage: makeStorage(), liffIdIsTrusted: true })).toBe(true)
  })

  it('【重要】すでに LIFF の中なら開き直さない', () => {
    // 同じ場所へ送り直すだけで何も変わらない。ループになる
    expect(shouldReopenInLiff({ isInClient: true, storage: makeStorage(), liffIdIsTrusted: true })).toBe(false)
  })

  it('【重要】一度試したら二度目はしない（リダイレクトの無限ループ防止）', () => {
    const storage = makeStorage()

    expect(shouldReopenInLiff({ isInClient: false, storage, liffIdIsTrusted: true })).toBe(true)
    expect(shouldReopenInLiff({ isInClient: false, storage, liffIdIsTrusted: true })).toBe(false)
  })

  it('【重要】sessionStorage が使えなければ開き直さない', () => {
    // 回数を数えられない＝ループを止められない。行き止まりのほうがまだマシ
    expect(shouldReopenInLiff({ isInClient: false, storage: null, liffIdIsTrusted: true })).toBe(false)
  })

  it('セッション復帰の回数とは別に数える', () => {
    // 期限切れ復帰（RECOVERY_STORAGE_KEY）と混ぜると、片方が他方を消してしまう
    const storage = makeStorage({ [RECOVERY_STORAGE_KEY]: '1' })

    expect(shouldReopenInLiff({ isInClient: false, storage, liffIdIsTrusted: true })).toBe(true)
    expect(storage.dump()[RECOVERY_STORAGE_KEY]).toBe('1')
  })
})

describe('buildAuthErrorMessage（認証できなかったときの案内）', () => {
  it('【重要】LINE の中にいる人に「LINE アプリ内で開け」と言わない', () => {
    // すでにアプリの中にいるので、何をすればいいのか分からない案内になる（実際に混乱した）
    const msg = buildAuthErrorMessage({ isInClient: true, canReopen: false })
    expect(msg).not.toContain('LINE アプリ内で再度開いて')
    expect(msg).toContain('閉じて')
  })

  it('LIFF の外なら、開き直す導線に触れる', () => {
    const msg = buildAuthErrorMessage({ isInClient: false, canReopen: true })
    expect(msg).toContain('開き直す')
  })
})

describe('readLiffParam（liff.state に畳まれたクエリも見る・#85 レビュー④）', () => {
  it('通常のクエリから読める', () => {
    expect(readLiffParam('?page=order&table=abc', 'table')).toBe('abc')
  })

  it('【重要】liff.state に畳まれていても読める', () => {
    // liff.line.me を経由すると LINE がクエリを liff.state にまとめることがある。
    // getPage() だけが展開していて、table / id / payment は生の search を見ていた
    expect(readLiffParam('?liff.state=%3Fpage%3Dorder%26table%3Dabc', 'table')).toBe('abc')
  })

  it('先頭の ? が無い liff.state でも読める', () => {
    expect(readLiffParam('?liff.state=page%3Devent%26id%3D12', 'id')).toBe('12')
  })

  it('【重要】通常のクエリを liff.state より優先する', () => {
    // 両方にあるなら、いま開いている URL のほうが新しい
    const search = '?table=direct&liff.state=%3Ftable%3Dfolded'
    expect(readLiffParam(search, 'table')).toBe('direct')
  })

  it('どちらにも無ければ null', () => {
    expect(readLiffParam('?page=order', 'table')).toBeNull()
    expect(readLiffParam('', 'table')).toBeNull()
  })

  it('壊れた liff.state でも落ちない', () => {
    expect(readLiffParam('?liff.state=%%%', 'table')).toBeNull()
  })
})

describe('shouldReopenInLiff（LIFF ID の出どころ・#85 レビュー②）', () => {
  const makeStorage = () => {
    const m = new Map<string, string>()
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } }
  }

  it('【重要】LIFF ID が ?liffId= 由来なら自動で飛ばさない', () => {
    // ?liffId= はユーザーが自由に入れられる。攻撃者の LIFF ID を入れた URL を送られると、
    // 正規のドメインから攻撃者の LIFF へ自動遷移させられる
    expect(shouldReopenInLiff({
      isInClient: false, storage: makeStorage(), liffIdIsTrusted: false,
    })).toBe(false)
  })

  it('ビルド時の値（信頼できる）なら飛ばす', () => {
    expect(shouldReopenInLiff({
      isInClient: false, storage: makeStorage(), liffIdIsTrusted: true,
    })).toBe(true)
  })

  it('信頼できない場合はフラグも消費しない', () => {
    // 消費すると、あとで正しい経路で開いたときに自動復帰できなくなる
    const storage = makeStorage()
    shouldReopenInLiff({ isInClient: false, storage, liffIdIsTrusted: false })
    expect(storage.getItem(REOPEN_STORAGE_KEY)).toBeNull()
  })
})

describe('buildAuthErrorMessage（ボタンの有無と揃える・#85 レビュー①）', () => {
  it('【重要】ボタンを出せないときに「下のボタン」と言わない', () => {
    // 存在しないボタンを押せと言うのは、この PR が直そうとした失敗そのもの
    const msg = buildAuthErrorMessage({ isInClient: false, canReopen: false })
    expect(msg).not.toContain('ボタン')
    expect(msg).toContain('トーク')
  })

  it('ボタンを出せるときだけ「下のボタン」と言う', () => {
    const msg = buildAuthErrorMessage({ isInClient: false, canReopen: true })
    expect(msg).toContain('ボタン')
  })

  it('LIFF の中ならボタンの有無に関わらず「閉じて開き直す」', () => {
    for (const canReopen of [true, false]) {
      const msg = buildAuthErrorMessage({ isInClient: true, canReopen })
      expect(msg).toContain('閉じて')
      expect(msg).not.toContain('ボタン')
    }
  })

  it('どの組み合わせでも旧文言は出さない', () => {
    for (const isInClient of [true, false]) {
      for (const canReopen of [true, false]) {
        expect(buildAuthErrorMessage({ isInClient, canReopen }))
          .not.toContain('LINE アプリ内で再度開いて')
      }
    }
  })
})

describe('markLiffReopenResolved（#85 レビュー⑤）', () => {
  it('【重要】無事に入れたら開き直しのフラグを戻す', () => {
    // 戻さないと、そのセッション中は二度目の救済が効かない
    const m = new Map<string, string>([[REOPEN_STORAGE_KEY, '1']])
    const storage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } }

    markLiffReopenResolved(storage)

    expect(shouldReopenInLiff({ isInClient: false, storage, liffIdIsTrusted: true })).toBe(true)
  })

  it('storage が無くても落ちない', () => {
    expect(() => markLiffReopenResolved(null)).not.toThrow()
  })
})
