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
  return `
    <div class="event-detail">
      <h2 class="event-title">${escapeHtml(event.title)}</h2>
      <p class="event-date">${formatJST(event.start_at)} 〜 ${formatJST(event.end_at)}</p>
      ${event.description ? `<p class="event-description">${escapeHtml(event.description)}</p>` : ''}
      <p class="event-remaining">残席: ${event.remaining}名</p>
      <form class="join-form">
        <div class="form-field">
          <label for="join-name">お名前</label>
          <input type="text" id="join-name" name="name" placeholder="山田太郎" />
        </div>
        <div class="form-field">
          <label for="join-email">メールアドレス</label>
          <input type="email" id="join-email" name="email" placeholder="you@example.com" />
        </div>
        <button type="submit" id="join-submit">申し込む</button>
      </form>
    </div>
  `
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

export async function submitJoin(
  eventId: number,
  name: string,
  email: string,
  lineUserId?: string,
): Promise<{ success: boolean; error?: string }> {
  if (!name.trim()) {
    return { success: false, error: 'お名前を入力してください' }
  }
  if (!isValidEmail(email)) {
    return { success: false, error: '正しいメールアドレスを入力してください' }
  }

  const res = await fetch(`${API_BASE}/api/events/${eventId}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name.trim(), email, lineUserId }),
  })

  if (!res.ok) {
    if (res.status === 409) {
      return { success: false, error: 'このイベントは満席です' }
    }
    return { success: false, error: '申し込みに失敗しました' }
  }

  return { success: true }
}

export async function initEventBooking(): Promise<void> {
  const app = document.getElementById('app')
  if (!app) return

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

  const renderDetail = (event: EventPublic) => {
    app.innerHTML = `
      <div>
        <button id="back-btn">← 一覧に戻る</button>
        ${buildEventDetailHtml(event)}
      </div>
    `
    document.getElementById('back-btn')?.addEventListener('click', renderList)

    const form = app.querySelector('.join-form')
    form?.addEventListener('submit', async (e) => {
      e.preventDefault()
      const nameEl = document.getElementById('join-name') as HTMLInputElement
      const emailEl = document.getElementById('join-email') as HTMLInputElement
      const submitBtn = document.getElementById('join-submit') as HTMLButtonElement
      submitBtn.disabled = true
      submitBtn.textContent = '送信中...'

      const result = await submitJoin(event.id, nameEl.value, emailEl.value)
      if (result.success) {
        app.innerHTML = `
          <div class="done-card">
            <div class="check-icon">✓</div>
            <h2>申し込み完了！</h2>
            <p>ご登録のメールアドレスに確認メールをお送りします。</p>
          </div>
        `
      } else {
        submitBtn.disabled = false
        submitBtn.textContent = '申し込む'
        const errEl = document.createElement('p')
        errEl.className = 'form-error'
        errEl.textContent = result.error || 'エラーが発生しました'
        form.insertBefore(errEl, form.firstChild)
      }
    })
  }

  renderList()
}
