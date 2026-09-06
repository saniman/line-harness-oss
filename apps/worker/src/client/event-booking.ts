import { isIdTokenExpired } from './liff-token.js'

const API_BASE = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE) || '';

export interface EventPublic {
  id: number
  title: string
  description: string | null
  start_at: string
  end_at: string
  capacity: number
  participant_count: number
  remaining: number
  available: boolean
  price?: number | null
  /**
   * 申込締切（開始1時間前）を過ぎているか。満席（available）とは別の状態として扱う。
   * 古いバンドルがキャッシュされていても落ちないよう optional にし、true のときだけ締切扱いにする。
   */
  application_closed?: boolean
}

/** 締切表示（一覧・詳細で同じ文言を使う） */
const CLOSED_MESSAGE = 'このイベントの申し込みは締めきられました'
/** 締切時のボタン文言。ボタンに入る長さに詰める（文言本体は CLOSED_MESSAGE で別途出す） */
const CLOSED_LABEL = '申込締切'

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatJST(iso: string): string {
  const d = new Date(iso)
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000)
  const mm = String(jst.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(jst.getUTCDate()).padStart(2, '0')
  const hh = String(jst.getUTCHours()).padStart(2, '0')
  const min = String(jst.getUTCMinutes()).padStart(2, '0')
  const weekdays = ['日', '月', '火', '水', '木', '金', '土']
  const dow = weekdays[jst.getUTCDay()]
  return `${mm}/${dd}(${dow}) ${hh}:${min}`
}

export function buildEventListHtml(events: EventPublic[]): string {
  if (events.length === 0) {
    return '<p class="no-events">現在募集中のイベントはありません</p>'
  }
  return events.map((ev) => {
    const closed = ev.application_closed === true
    const full = !ev.available || ev.remaining === 0
    // 締切は満席より優先する。満席は「空きが出るかも」と待たせるが、締切は最終状態。
    const label = closed ? CLOSED_LABEL : full ? '満席' : '申し込む'
    return `
      <div class="event-card panel" data-id="${ev.id}">
        <h3 class="event-title">${escapeHtml(ev.title)}</h3>
        <p class="event-date">${formatJST(ev.start_at)} 〜 ${formatJST(ev.end_at)}</p>
        ${closed ? `<p class="event-closed">${CLOSED_MESSAGE}</p>` : `<p class="event-remaining">残席: ${ev.remaining}名</p>`}
        <button
          class="event-join-btn btn-pink"
          data-event-id="${ev.id}"
          ${closed || full ? 'disabled' : ''}
        >${label}</button>
      </div>
    `
  }).join('')
}

export function buildEventDetailHtml(event: EventPublic): string {
  const closed = event.application_closed === true
  const full = !event.available || event.remaining === 0
  // 締切なら有料の2経路（決済・当日現金）と無料申込の全てを止める。
  // 片方だけ塞ぐと同じ経路の裏口が残る（#28 で判明）。
  const blocked = closed || full
  const isPaid = event.price != null && event.price > 0
  const priceHtml = isPaid
    ? `<p class="event-price">参加費: ¥${event.price!.toLocaleString()}</p>`
    : `<p class="event-price">参加費: 無料</p>`
  const label = (normal: string) => (closed ? CLOSED_LABEL : full ? '満席' : normal)

  const actionHtml = isPaid
    ? `<button id="checkout-btn" class="btn-pink" ${blocked ? 'disabled' : ''}>
        ${label('申込・決済へ進む 💳')}
       </button>
       <button id="cash-join-btn" ${blocked ? 'disabled' : ''}>
        ${closed ? CLOSED_LABEL : '当日現金の方はこちら 💴'}
       </button>`
    : `<button id="free-join-btn" class="btn-pink" ${blocked ? 'disabled' : ''}>
        ${label('申し込む（無料）')}
       </button>`
  return `
    <div class="event-detail panel">
      <h2 class="event-title">${escapeHtml(event.title)}</h2>
      <p class="event-date">${formatJST(event.start_at)} 〜 ${formatJST(event.end_at)}</p>
      ${event.description ? `<p class="event-description">${escapeHtml(event.description)}</p>` : ''}
      ${closed ? `<p class="event-closed">${CLOSED_MESSAGE}</p>` : `<p class="event-remaining">残席: ${event.remaining}名</p>`}
      ${priceHtml}
      ${actionHtml}
    </div>
  `
}

/**
 * 当日現金の申込画面（#80）。
 *
 * イベント詳細に宛名の入力欄を置いていたが、**決済で払う人には無関係な欄が
 * 支払い方法を選ぶ途中に割り込む**状態だった。選択を済ませてから詳細を聞く。
 *
 * ⚠️ 要否を選ぶまで申し込ませない（`disabled` で出す）。未選択のまま通せるようにすると
 *    「聞いた意味」が無くなり、領収書が要る人が黙って不要側に倒れる。
 *
 * ⚠️ 宛名欄は最初隠す。「いいえ」の人に見せると、この画面でも判断の邪魔になる。
 */
export function buildCashFormHtml(event: EventPublic): string {
  const price = event.price ?? 0
  return `
    <div class="cash-form panel">
      <h2 class="cash-form-title">当日現金でのお申込</h2>
      <p class="event-title">${escapeHtml(event.title)}</p>
      <p class="event-date">${formatJST(event.start_at)} 〜 ${formatJST(event.end_at)}</p>
      <p class="event-price">参加費: ¥${price.toLocaleString()}（当日現金）</p>

      <fieldset class="receipt-choice">
        <legend>領収書は必要ですか？</legend>
        <label class="receipt-choice-option">
          <input type="radio" name="receipt-wanted" id="receipt-yes" value="yes" /> はい
        </label>
        <label class="receipt-choice-option">
          <input type="radio" name="receipt-wanted" id="receipt-no" value="no" /> いいえ
        </label>
      </fieldset>

      <div id="receipt-name-field" class="receipt-name-field" hidden>
        <label for="receipt-name-input">領収書の宛名（必須・60文字まで）</label>
        <!-- maxlength は UTF-16 コードユニット単位。サーバーは60コードポイントで切るので、
             サロゲートペアでも手前で切られないよう 4 倍を確保する（実際の上限はサーバー側） -->
        <input id="receipt-name-input" type="text" maxlength="240"
               placeholder="例）株式会社サンプル" />
      </div>

      <button id="cash-submit-btn" class="btn-pink" disabled>この内容で申し込む</button>
      <button id="cash-back-btn" class="cash-back-btn">← 戻る</button>
    </div>
  `
}

export interface EventActionResult {
  success: boolean
  error?: string
  /** 友だち登録必須ゲートで弾かれた（403 friend_required）。呼び出し側は友だち追加画面へ誘導する。 */
  friendRequired?: boolean
  /**
   * LINE 認証の期限切れ（401 id_token_expired、または送信前の exp チェック）。
   * 呼び出し側は文言を出すのではなく **セッション復帰処理**へ流す（#28）。
   */
  sessionExpired?: boolean
  /**
   * 申込締切で弾かれた（409 application_closed）。
   * 締切は最終状態なので、呼び出し側はボタンを元に戻さず締切済みとして描き直す。
   */
  applicationClosed?: boolean
}

/** 申込系エンドポイントの共通ヘッダ。本人確認は LIFF の idToken で行う。 */
function authHeaders(idToken: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (idToken) headers['Authorization'] = `Bearer ${idToken}`
  return headers
}

/** LINE 認証が切れているときの共通結果。呼び出し側が復帰処理へ流す。 */
const SESSION_EXPIRED_RESULT: EventActionResult = {
  success: false,
  sessionExpired: true,
  // 自動復帰できなかったときだけ表示される文言。実際に効く操作だけを案内する。
  error: 'LINE 認証の期限が切れました。画面を閉じて開き直してください。',
}

/**
 * 送信前に ID トークンの期限を確認する。切れていれば往復せずに復帰へ回す。
 * exp を読めないトークンは false（サーバーの判断に委ねる）。
 */
function checkTokenFreshness(idToken: string): EventActionResult | null {
  return isIdTokenExpired(idToken, Date.now()) ? SESSION_EXPIRED_RESULT : null
}

/** 失敗レスポンスのボディから error コードを読む。ボディが無くても落ちない。 */
async function readErrorCode(res: { json?: () => Promise<unknown> }): Promise<string | undefined> {
  try {
    const body = await res.json?.() as { error?: unknown } | null
    return typeof body?.error === 'string' ? body.error : undefined
  } catch {
    return undefined
  }
}

/** 申込系エンドポイントの失敗レスポンスを共通のメッセージに変換する。 */
function toActionError(status: number, code?: string): EventActionResult {
  if (status === 409) {
    // 409 は満席と締切の2つある。ステータスだけで判断すると締切なのに「満席」と出る。
    if (code === 'application_closed') {
      return { success: false, applicationClosed: true, error: CLOSED_MESSAGE }
    }
    return { success: false, error: 'このイベントは満席です' }
  }
  if (status === 403) {
    return { success: false, friendRequired: true, error: 'お申し込みには友だち追加が必要です' }
  }
  if (status === 401) {
    // 期限切れは復帰できる。それ以外の 401 は復帰しても直らないので区別する。
    if (code === 'id_token_expired') return SESSION_EXPIRED_RESULT
    return { success: false, error: 'LINE 認証に失敗しました。画面を閉じて開き直してください。' }
  }
  if (status === 503) {
    // 友だち判定ができなかった（LINE API 障害等）。友だち追加を促しても解決しないため
    // friendRequired にはせず、時間をおいて再試行してもらう。
    return { success: false, error: '通信が混み合っています。しばらくしてから再度お試しください。' }
  }
  return { success: false, error: '申し込みに失敗しました' }
}

export async function joinFreeEvent(
  eventId: number,
  idToken: string,
  name: string,
): Promise<EventActionResult> {
  const stale = checkTokenFreshness(idToken)
  if (stale) return stale

  const res = await fetch(`${API_BASE}/api/events/${eventId}/join`, {
    method: 'POST',
    headers: authHeaders(idToken),
    body: JSON.stringify({ name }),
  })

  if (!res.ok) return toActionError(res.status, await readErrorCode(res))
  return { success: true }
}

/** 領収書の要否と宛名（#80。画面で必ず選ばせる） */
export interface CashReceiptChoice {
  /** 参加者が「領収書が必要」と答えたか */
  requested: boolean
  /** 宛名。requested のときだけ意味がある */
  name?: string
}

export async function joinCashEvent(
  eventId: number,
  idToken: string,
  name: string,
  receipt: CashReceiptChoice,
): Promise<EventActionResult> {
  const stale = checkTokenFreshness(idToken)
  if (stale) return stale

  const res = await fetch(`${API_BASE}/api/events/${eventId}/join`, {
    method: 'POST',
    headers: authHeaders(idToken),
    body: JSON.stringify({
      name,
      paymentMethod: 'cash',
      // ⚠️ false でも必ず送る。省略するとサーバー側で「未回答」と区別できず、
      //    不要と答えた人にも領収書が発行されてしまう
      receiptRequested: receipt.requested,
      ...(receipt.requested && receipt.name ? { receiptName: receipt.name } : {}),
    }),
  })

  if (!res.ok) return toActionError(res.status, await readErrorCode(res))
  return { success: true }
}

export async function startCheckoutSession(
  eventId: number,
  idToken: string,
  openWindow: (params: { url: string; external: boolean }) => void,
): Promise<EventActionResult> {
  const stale = checkTokenFreshness(idToken)
  if (stale) return stale

  const res = await fetch(`${API_BASE}/api/events/${eventId}/checkout-session`, {
    method: 'POST',
    headers: authHeaders(idToken),
  })

  if (!res.ok) return toActionError(res.status, await readErrorCode(res))

  const json = await res.json() as { success: boolean; data: { url: string } }
  openWindow({ url: json.data.url, external: true })
  return { success: true }
}

export async function initEventBooking(options: {
  lineUserId?: string
  displayName?: string
  /** LIFF の idToken。申込系エンドポイントの本人確認に使う。 */
  idToken?: string
  payment?: string | null
  eventId?: number
  openWindow?: (params: { url: string; external: boolean }) => void
  /**
   * 403 friend_required のときに呼ばれる（呼び出し側で友だち追加画面を出す）。
   * 誘導しなかった場合は false を返すと、通常どおりエラー文言を表示する。
   */
  onFriendRequired?: () => boolean | void
  /**
   * LINE 認証が期限切れのときに呼ばれる（呼び出し側でセッション復帰を行う）。
   * 復帰を開始したら true を返す。false なら通常どおりエラー文言を表示する。
   */
  onSessionExpired?: () => boolean | void
} = {}): Promise<void> {
  const {
    lineUserId, displayName, idToken, payment, eventId,
    openWindow = () => {}, onFriendRequired, onSessionExpired,
  } = options
  const app = document.getElementById('app')
  if (!app) return

  // 決済結果画面
  if (payment === 'success') {
    app.innerHTML = `
      <div class="done-card panel">
        <div class="check-icon">✓</div>
        <h2>申込が完了しました！</h2>
        <p>決済確認後にLINEにご連絡します。</p>
      </div>
    `
    return
  }

  if (payment === 'cancel') {
    // URLから bookingId を取得（?bookingId=N 形式）
    const urlParams = new URLSearchParams(window.location.search)
    const bookingId = urlParams.get('bookingId')

    // bookingId が無いのは、決済セッションを作らずにキャンセル画面へ来たケース。
    // 取り消す対象が無いので表示だけして戻る。
    if (!bookingId) {
      app.innerHTML = `
        <div class="cancel-card panel">
          <h2>お申込みをキャンセルしました。</h2>
          <button id="back-to-list-btn">イベント一覧に戻る</button>
        </div>
      `
      document.getElementById('back-to-list-btn')?.addEventListener('click', () => {
        initEventBooking({ lineUserId, displayName, idToken, openWindow, onFriendRequired })
      })
      return
    }

    // ここに来るのは主に「Stripe 決済画面で戻るを押した」ケース。
    // checkout-session が cancel_url に bookingId を載せているため、離脱でも bookingId が付く。
    // サーバ側は pending からの遷移を cancel_reason='checkout_abandoned' として記録し、
    // 本人都合のキャンセルと区別する（Issue #56）。
    app.innerHTML = '<p class="loading">キャンセル処理中...</p>'
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (lineUserId) headers['x-line-user-id'] = lineUserId
      const res = await fetch(`${API_BASE}/api/events/bookings/${bookingId}/cancel`, {
        method: 'POST',
        headers,
      })
      const json = await res.json() as { success: boolean; data?: { refunded: boolean }; error?: string }
      if (json.success) {
        const refundMsg = json.data?.refunded
          ? '<p>返金処理を開始しました。数営業日以内に元の支払い方法へ返金されます。</p>'
          : ''
        app.innerHTML = `
          <div class="cancel-card panel">
            <h2>✅ 予約をキャンセルしました。</h2>
            ${refundMsg}
            <button id="back-to-list-btn">イベント一覧に戻る</button>
          </div>
        `
      } else {
        app.innerHTML = `
          <div class="cancel-card panel">
            <h2>キャンセルできませんでした</h2>
            <p>${json.error ?? 'しばらくしてから再度お試しください。'}</p>
            <button id="back-to-list-btn">イベント一覧に戻る</button>
          </div>
        `
      }
    } catch {
      app.innerHTML = `
        <div class="cancel-card panel">
          <h2>エラーが発生しました</h2>
          <p>通信に失敗しました。しばらくしてから再度お試しください。</p>
          <button id="back-to-list-btn">イベント一覧に戻る</button>
        </div>
      `
    }
    document.getElementById('back-to-list-btn')?.addEventListener('click', () => {
      initEventBooking({ lineUserId, displayName, idToken, openWindow, onFriendRequired })
    })
    return
  }

  // 通常フロー: イベント一覧
  app.innerHTML = '<p class="loading">読み込み中...</p>'

  let events: EventPublic[] = []
  try {
    const res = await fetch(`${API_BASE}/api/events/public`)
    if (res.ok) {
      const json = await res.json() as { success: boolean; data: EventPublic[] }
      if (json.success) events = json.data
    }
  } catch {
    // show empty list on error
  }

  const renderList = () => {
    app.innerHTML = `
      <div class="event-list">
        <h1>イベント一覧</h1>
        ${buildEventListHtml(events)}
      </div>
    `
    app.querySelectorAll('.event-join-btn:not([disabled])').forEach((btn) => {
      btn.addEventListener('click', () => {
        const eventId = Number((btn as HTMLElement).dataset.eventId)
        const event = events.find((e) => e.id === eventId)
        if (event) renderDetail(event)
      })
    })
  }

  const showError = (anchor: Element | null, message: string) => {
    const existing = app.querySelector('.form-error')
    existing?.remove()
    const errEl = document.createElement('p')
    errEl.className = 'form-error'
    errEl.textContent = message
    anchor?.parentElement?.insertBefore(errEl, anchor)
  }

  /**
   * 申込失敗の共通処理。友だち未登録（403）なら友だち追加画面へ誘導する。
   * @returns 友だち追加画面へ遷移したら true（呼び出し側はボタン復帰処理を行わない）
   */
  const handleActionFailure = (result: EventActionResult): boolean => {
    // 期限切れは「案内を出す」のではなく復帰させる。復帰できたときだけ文言を出さない。
    if (result.sessionExpired && onSessionExpired) {
      if (onSessionExpired() !== false) return true
    }
    if (result.friendRequired && onFriendRequired) {
      // false を返されたら誘導しなかったということ → エラー文言の表示にフォールバックする
      return onFriendRequired() !== false
    }
    return false
  }

  /**
   * 締切で弾かれたときの共通処理。ボタンを元に戻すと押し続けられてしまうため、
   * **締切済みの状態でイベント詳細ごと描き直す**（有料は決済・当日現金の2経路があるので、
   * 押されたボタンだけ止めても、もう一方から申し込めてしまう）。
   *
   * 現金の申込画面から呼ばれたときも詳細に戻す。その画面に留まると
   * 締切後もそこから何度も申し込みを試せてしまう。
   *
   * @returns 締切だったら true（呼び出し側はボタン復帰処理を行わない）
   */
  const renderClosedDetail = (event: EventPublic, result: EventActionResult): boolean => {
    if (!result.applicationClosed) return false
    renderDetail({ ...event, application_closed: true })
    return true
  }

  /**
   * 当日現金の申込画面（#80）。要否 → 宛名 → 申込の順に進む。
   *
   * ⚠️ 画面が1枚増える＝**選んでから申し込むまでに時間が空く**。その間に締切・満席に
   *    なりうるので、締切が返ったら**この画面に留めず**詳細を締切状態で描き直す。
   *    留まると、そこから何度も申し込みを試せてしまう。
   */
  const renderCashForm = (event: EventPublic) => {
    app.innerHTML = buildCashFormHtml(event)

    const submitBtn = document.getElementById('cash-submit-btn') as HTMLButtonElement
    const nameField = document.getElementById('receipt-name-field') as HTMLElement
    const nameInput = document.getElementById('receipt-name-input') as HTMLInputElement
    const yes = document.getElementById('receipt-yes') as HTMLInputElement
    const no = document.getElementById('receipt-no') as HTMLInputElement

    /** 「必要」を選んだか。未選択と「いいえ」を区別するため null を持つ */
    const wanted = () => (yes.checked ? true : no.checked ? false : null)

    /**
     * ⚠️ 画面を描き直さず、ボタンの状態だけ更新する。
     *    入力のたびに innerHTML を差し替えるとフォーカスが飛ぶ（`.claude/rules/liff.md`）。
     */
    const updateSubmitState = () => {
      const w = wanted()
      // 未選択では進ませない。必要なら宛名が空では進ませない
      submitBtn.disabled = w === null || (w === true && nameInput.value.trim() === '')
    }

    const onChoice = () => {
      nameField.hidden = wanted() !== true
      updateSubmitState()
    }
    yes.addEventListener('change', onChoice)
    no.addEventListener('change', onChoice)
    nameInput.addEventListener('input', updateSubmitState)

    document.getElementById('cash-back-btn')?.addEventListener('click', () => { renderDetail(event) })

    submitBtn.addEventListener('click', async () => {
      const requested = wanted()
      // 押せない状態のはずだが、直接呼ばれても進ませない
      if (requested === null) return
      submitBtn.disabled = true
      submitBtn.textContent = '処理中...'

      const result = await joinCashEvent(event.id, idToken ?? '', displayName ?? '', {
        requested,
        name: requested ? nameInput.value.trim() : undefined,
      })

      if (result.success) {
        app.innerHTML = `
          <div class="done-card panel">
            <div class="check-icon">✓</div>
            <h2>申込が完了しました！</h2>
            <p>当日スタッフにお支払いください。</p>
          </div>
        `
        return
      }
      // 締切・満席はこの画面に留めず、詳細を締切状態で描き直す
      if (renderClosedDetail(event, result)) return
      if (handleActionFailure(result)) return
      submitBtn.disabled = false
      submitBtn.textContent = 'この内容で申し込む'
      showError(submitBtn, result.error || 'エラーが発生しました')
    })
  }

  const renderDetail = (event: EventPublic) => {
    const handleClosed = (result: EventActionResult): boolean => renderClosedDetail(event, result)

    app.innerHTML = `
      <div>
        <button id="back-btn">← 一覧に戻る</button>
        ${buildEventDetailHtml(event)}
      </div>
    `
    document.getElementById('back-btn')?.addEventListener('click', renderList)

    // 有料フロー
    const checkoutBtn = document.getElementById('checkout-btn') as HTMLButtonElement | null
    checkoutBtn?.addEventListener('click', async () => {
      if (!checkoutBtn) return
      checkoutBtn.disabled = true
      checkoutBtn.textContent = '処理中...'
      const result = await startCheckoutSession(event.id, idToken ?? '', openWindow)
      if (!result.success) {
        if (handleClosed(result)) return
        if (handleActionFailure(result)) return
        checkoutBtn.disabled = false
        checkoutBtn.textContent = '申込・決済へ進む 💳'
        showError(checkoutBtn, result.error || 'エラーが発生しました')
      }
    })

    // 当日現金フロー: ここでは申し込まない。宛名を聞く画面へ移るだけ（#80）
    const cashBtn = document.getElementById('cash-join-btn') as HTMLButtonElement | null
    cashBtn?.addEventListener('click', () => { renderCashForm(event) })

    // 無料フロー
    const freeBtn = document.getElementById('free-join-btn') as HTMLButtonElement | null
    freeBtn?.addEventListener('click', async () => {
      if (!freeBtn) return
      freeBtn.disabled = true
      freeBtn.textContent = '処理中...'
      const result = await joinFreeEvent(event.id, idToken ?? '', displayName ?? '')
      if (result.success) {
        app.innerHTML = `
          <div class="done-card panel">
            <div class="check-icon">✓</div>
            <h2>申込が完了しました！</h2>
            <p>LINEにご連絡します。</p>
          </div>
        `
      } else {
        if (handleClosed(result)) return
        if (handleActionFailure(result)) return
        freeBtn.disabled = false
        freeBtn.textContent = '申し込む（無料）'
        showError(freeBtn, result.error || 'エラーが発生しました')
      }
    })
  }

  if (eventId != null) {
    const target = events.find((e) => e.id === eventId)
    if (target) {
      renderDetail(target)
    } else {
      renderList()
    }
  } else {
    renderList()
  }
}
