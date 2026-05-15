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
}

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
    const full = !ev.available || ev.remaining === 0
    return `
      <div class="event-card" data-id="${ev.id}">
        <h3 class="event-title">${escapeHtml(ev.title)}</h3>
        <p class="event-date">${formatJST(ev.start_at)} 〜 ${formatJST(ev.end_at)}</p>
        <p class="event-remaining">残席: ${ev.remaining}名</p>
        <button
          class="event-join-btn"
          data-event-id="${ev.id}"
          ${full ? 'disabled' : ''}
        >${full ? '満席' : '申し込む'}</button>
      </div>
    `
  }).join('')
}

export function buildEventDetailHtml(event: EventPublic): string {
  const full = !event.available || event.remaining === 0
  const isPaid = event.price != null && event.price > 0
  const priceHtml = isPaid
    ? `<p class="event-price">参加費: ¥${event.price!.toLocaleString()}</p>`
    : `<p class="event-price">参加費: 無料</p>`
  const actionHtml = isPaid
    ? `<button id="checkout-btn" class="checkout-btn" ${full ? 'disabled' : ''}>
        ${full ? '満席' : '申込・決済へ進む 💳'}
       </button>`
    : `<form id="free-join-form">
        <input id="join-name" type="text" placeholder="お名前" required class="join-input" />
        <input id="join-email" type="email" placeholder="メールアドレス" required class="join-input" />
        <button type="submit" ${full ? 'disabled' : ''}>
          ${full ? '満席' : '申し込む（無料）'}
        </button>
       </form>`
  return `
    <div class="event-detail">
      <h2 class="event-title">${escapeHtml(event.title)}</h2>
      <p class="event-date">${formatJST(event.start_at)} 〜 ${formatJST(event.end_at)}</p>
      ${event.description ? `<p class="event-description">${escapeHtml(event.description)}</p>` : ''}
      <p class="event-remaining">残席: ${event.remaining}名</p>
      ${priceHtml}
      ${actionHtml}
    </div>
  `
}

export async function joinFreeEvent(
  eventId: number,
  lineUserId: string,
  name: string,
  email: string,
): Promise<{ success: boolean; error?: string }> {
  const res = await fetch(`${API_BASE}/api/events/${eventId}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, lineUserId: lineUserId || undefined }),
  })

  if (!res.ok) {
    if (res.status === 409) return { success: false, error: 'このイベントは満席です' }
    return { success: false, error: '申し込みに失敗しました' }
  }
  return { success: true }
}

export async function startCheckoutSession(
  eventId: number,
  lineUserId: string,
  openWindow: (params: { url: string; external: boolean }) => void,
): Promise<{ success: boolean; error?: string }> {
  const res = await fetch(`${API_BASE}/api/events/${eventId}/checkout-session`, {
    method: 'POST',
    headers: { 'x-line-user-id': lineUserId },
  })

  if (!res.ok) {
    if (res.status === 409) {
      return { success: false, error: 'このイベントは満席です' }
    }
    return { success: false, error: '申し込みに失敗しました' }
  }

  const json = await res.json() as { success: boolean; data: { url: string } }
  openWindow({ url: json.data.url, external: true })
  return { success: true }
}

export async function initEventBooking(options: {
  lineUserId?: string
  payment?: string | null
  openWindow?: (params: { url: string; external: boolean }) => void
} = {}): Promise<void> {
  const { lineUserId, payment, openWindow = () => {} } = options
  const app = document.getElementById('app')
  if (!app) return

  // 決済結果画面
  if (payment === 'success') {
    app.innerHTML = `
      <div class="done-card">
        <div class="check-icon">✓</div>
        <h2>申込が完了しました！</h2>
        <p>決済確認後にLINEにご連絡します。</p>
      </div>
    `
    return
  }

  if (payment === 'cancel') {
    app.innerHTML = `
      <div class="cancel-card">
        <h2>お申込みをキャンセルしました。</h2>
        <button id="back-to-list-btn">イベント一覧に戻る</button>
      </div>
    `
    document.getElementById('back-to-list-btn')?.addEventListener('click', () => {
      initEventBooking({ lineUserId, openWindow })
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

  const renderDetail = (event: EventPublic) => {
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
      const result = await startCheckoutSession(event.id, lineUserId ?? '', openWindow)
      if (!result.success) {
        checkoutBtn.disabled = false
        checkoutBtn.textContent = '申込・決済へ進む 💳'
        showError(checkoutBtn, result.error || 'エラーが発生しました')
      }
    })

    // 無料フロー
    const freeForm = document.getElementById('free-join-form') as HTMLFormElement | null
    freeForm?.addEventListener('submit', async (e) => {
      e.preventDefault()
      const submitBtn = freeForm.querySelector('button[type="submit"]') as HTMLButtonElement
      const name = (document.getElementById('join-name') as HTMLInputElement)?.value.trim()
      const email = (document.getElementById('join-email') as HTMLInputElement)?.value.trim()
      if (!name || !email) return
      submitBtn.disabled = true
      submitBtn.textContent = '処理中...'
      const result = await joinFreeEvent(event.id, lineUserId ?? '', name, email)
      if (result.success) {
        app.innerHTML = `
          <div class="done-card">
            <div class="check-icon">✓</div>
            <h2>申込が完了しました！</h2>
            <p>ご登録のメールアドレスにご連絡します。</p>
          </div>
        `
      } else {
        submitBtn.disabled = false
        submitBtn.textContent = '申し込む（無料）'
        showError(submitBtn, result.error || 'エラーが発生しました')
      }
    })
  }

  renderList()
}
