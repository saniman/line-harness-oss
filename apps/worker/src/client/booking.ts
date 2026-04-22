declare const liff: {
  init(config: { liffId: string }): Promise<void>;
  isLoggedIn(): boolean;
  login(opts?: { redirectUri?: string }): void;
  getProfile(): Promise<{ userId: string; displayName: string; pictureUrl?: string }>;
  getIDToken(): string | null;
  isInClient(): boolean;
  closeWindow(): void;
};

const CONNECTION_ID = import.meta.env?.VITE_CALENDAR_CONNECTION_ID || '';
const API_BASE = import.meta.env?.VITE_API_BASE || '';

interface Slot {
  startAt: string;
  endAt: string;
}

interface State {
  selectedDate: string | null;
  selectedSlot: Slot | null;
  slots: Slot[];
  loadingSlots: boolean;
  submitting: boolean;
  done: boolean;
  error: string;
  userName: string;
  userEmail: string;
  consultation: string;
  lineUserId: string;
}

const state: State = {
  selectedDate: null,
  selectedSlot: null,
  slots: [],
  loadingSlots: false,
  submitting: false,
  done: false,
  error: '',
  userName: '',
  userEmail: '',
  consultation: '',
  lineUserId: '',
};

function jstDateLabel(iso: string): string {
  const d = new Date(iso);
  const offset = 9 * 60 * 60 * 1000;
  const jst = new Date(d.getTime() + offset);
  const mm = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(jst.getUTCDate()).padStart(2, '0');
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  const dow = weekdays[jst.getUTCDay()];
  return `${mm}/${dd}(${dow})`;
}

function jstTimeLabel(iso: string): string {
  const d = new Date(iso);
  const offset = 9 * 60 * 60 * 1000;
  const jst = new Date(d.getTime() + offset);
  const hh = String(jst.getUTCHours()).padStart(2, '0');
  const min = String(jst.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${min}`;
}

function get14Days(): string[] {
  const days: string[] = [];
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  now.setUTCHours(0, 0, 0, 0);
  for (let i = 1; i <= 14; i++) {
    const d = new Date(now.getTime() + i * 86400000);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    days.push(`${yyyy}-${mm}-${dd}`);
  }
  return days;
}

async function fetchSlots(date: string): Promise<Slot[]> {
  const url = `${API_BASE}/api/integrations/google-calendar/slots?connectionId=${CONNECTION_ID}&date=${date}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const json = await res.json() as { success: boolean; data: Slot[] };
  return json.success ? json.data.filter(s => s.available !== false) : [];
}

async function submitBooking(): Promise<void> {
  if (!state.selectedSlot || !state.userName.trim()) return;
  state.submitting = true;
  state.error = '';
  render();
  try {
    const res = await fetch(`${API_BASE}/api/integrations/google-calendar/book`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId: CONNECTION_ID,
        lineUserId: state.lineUserId || undefined,
        title: `無料相談予約`,
        startAt: state.selectedSlot.startAt,
        endAt: state.selectedSlot.endAt,
        description: state.consultation.trim() || undefined,
        metadata: {
          name: state.userName.trim(),
          email: state.userEmail.trim() || undefined,
        },
      }),
    });
    const json = await res.json() as { success: boolean; error?: string };
    if (json.success) {
      state.done = true;
      render();
      setTimeout(() => {
        if (liff.isInClient()) liff.closeWindow();
      }, 3000);
    } else {
      state.error = json.error || '予約に失敗しました。もう一度お試しください。';
    }
  } catch {
    state.error = 'ネットワークエラーが発生しました。';
  }
  state.submitting = false;
  render();
}

function render(): void {
  const root = document.getElementById('app');
  if (!root) return;

  if (state.done) {
    root.innerHTML = `
      <div style="text-align:center;padding:48px 24px;">
        <div style="font-size:48px;margin-bottom:16px;">✅</div>
        <div style="font-size:18px;font-weight:bold;color:#1e293b;margin-bottom:8px;">予約が完了しました</div>
        <div style="font-size:14px;color:#64748b;">確認メッセージをLINEにお送りします。<br>まもなくこの画面は閉じます。</div>
      </div>`;
    return;
  }

  const days = get14Days();

  const dateTabs = days.map(d => {
    const active = d === state.selectedDate;
    const label = jstDateLabel(`${d}T00:00:00+09:00`);
    return `<button
      onclick="window.__selectDate('${d}')"
      style="flex-shrink:0;padding:8px 14px;border-radius:20px;border:2px solid ${active ? '#06C755' : '#e2e8f0'};
        background:${active ? '#06C755' : '#fff'};color:${active ? '#fff' : '#334155'};
        font-size:13px;font-weight:${active ? 'bold' : 'normal'};cursor:pointer;white-space:nowrap;"
    >${label}</button>`;
  }).join('');

  let slotsHtml = '';
  if (!state.selectedDate) {
    slotsHtml = `<div style="padding:24px;text-align:center;color:#94a3b8;font-size:14px;">日付を選択してください</div>`;
  } else if (state.loadingSlots) {
    slotsHtml = `<div style="padding:24px;text-align:center;color:#94a3b8;font-size:14px;">読み込み中...</div>`;
  } else if (state.slots.length === 0) {
    slotsHtml = `<div style="padding:24px;text-align:center;color:#94a3b8;font-size:14px;">この日は空き枠がありません</div>`;
  } else {
    slotsHtml = state.slots.map(slot => {
      const active = state.selectedSlot?.startAt === slot.startAt;
      const start = jstTimeLabel(slot.startAt);
      const end = jstTimeLabel(slot.endAt);
      return `<button
        onclick="window.__selectSlot('${encodeURIComponent(JSON.stringify(slot))}')"
        style="display:block;width:100%;padding:14px 16px;border-radius:10px;border:2px solid ${active ? '#06C755' : '#e2e8f0'};
          background:${active ? '#f0fdf4' : '#fff'};color:#1e293b;font-size:15px;font-weight:${active ? 'bold' : 'normal'};
          cursor:pointer;text-align:left;margin-bottom:8px;"
      >${start} 〜 ${end}</button>`;
    }).join('');
  }

  const formHtml = state.selectedSlot ? `
    <div style="margin-top:20px;padding:16px;background:#f8fafc;border-radius:12px;">
      <div style="font-size:13px;font-weight:bold;color:#64748b;margin-bottom:12px;">お客様情報</div>
      <label style="display:block;margin-bottom:10px;">
        <span style="font-size:13px;color:#334155;font-weight:bold;">お名前 <span style="color:#ef4444">*</span></span>
        <input id="booking-name" type="text" placeholder="山田 太郎" value="${escapeHtml(state.userName)}"
          oninput="window.__setName(this.value)"
          style="display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:10px 12px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:15px;" />
      </label>
      <label style="display:block;margin-bottom:10px;">
        <span style="font-size:13px;color:#334155;font-weight:bold;">メールアドレス <span style="color:#ef4444">※</span></span>
        <input id="booking-email" type="email" placeholder="example@mail.com" value="${escapeHtml(state.userEmail)}"
          oninput="window.__setEmail(this.value)"
          style="display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:10px 12px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:15px;" />
      </label>
      <label style="display:block;margin-bottom:16px;">
        <span style="font-size:13px;color:#334155;font-weight:bold;">ご相談内容（任意）</span>
        <textarea id="booking-consultation" placeholder="ご相談したい内容をご記入ください"
          oninput="window.__setConsultation(this.value)"
          style="display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:10px 12px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:15px;resize:vertical;min-height:80px;"
        >${escapeHtml(state.consultation)}</textarea>
      </label>
      ${state.error ? `<div style="margin-bottom:12px;padding:10px;background:#fef2f2;border-radius:8px;color:#dc2626;font-size:13px;">${escapeHtml(state.error)}</div>` : ''}
      <button
        id="booking-submit"
        onclick="window.__submit()"
        ${state.submitting || !state.userName.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(state.userEmail.trim()) ? 'disabled' : ''}
        style="display:block;width:100%;padding:16px;border-radius:10px;border:none;
          background:${state.submitting || !state.userName.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(state.userEmail.trim()) ? '#94a3b8' : '#06C755'};color:#fff;
          font-size:16px;font-weight:bold;cursor:${state.submitting || !state.userName.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(state.userEmail.trim()) ? 'not-allowed' : 'pointer'};"
      >${state.submitting ? '送信中...' : 'この日時で予約する'}</button>
    </div>` : '';

  root.innerHTML = `
    <div style="padding:16px 16px 32px;font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans',sans-serif;max-width:480px;margin:0 auto;">
      <div style="font-size:18px;font-weight:bold;color:#1e293b;margin-bottom:4px;">日程を選ぶ</div>
      <div style="font-size:13px;color:#64748b;margin-bottom:16px;">ご希望の日時をお選びください</div>

      <div style="overflow-x:auto;display:flex;gap:8px;padding-bottom:8px;margin-bottom:16px;-webkit-overflow-scrolling:touch;">
        ${dateTabs}
      </div>

      <div>${slotsHtml}</div>
      ${formHtml}
    </div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function updateSubmitButton(): void {
  const btn = document.getElementById('booking-submit') as HTMLButtonElement | null;
  if (!btn) return;
  const disabled = state.submitting || !state.userName.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(state.userEmail.trim());
  btn.disabled = disabled;
  btn.style.background = disabled ? '#94a3b8' : '#06C755';
  btn.style.cursor = disabled ? 'not-allowed' : 'pointer';
}

(window as unknown as Record<string, unknown>).__selectDate = async (date: string) => {
  if (state.selectedDate === date) return;
  state.selectedDate = date;
  state.selectedSlot = null;
  state.slots = [];
  state.loadingSlots = true;
  state.error = '';
  render();
  state.slots = await fetchSlots(date);
  state.loadingSlots = false;
  render();
};

(window as unknown as Record<string, unknown>).__selectSlot = (encoded: string) => {
  state.selectedSlot = JSON.parse(decodeURIComponent(encoded)) as Slot;
  state.error = '';
  render();
};

(window as unknown as Record<string, unknown>).__setName = (v: string) => { state.userName = v; updateSubmitButton(); };
(window as unknown as Record<string, unknown>).__setEmail = (v: string) => { state.userEmail = v; updateSubmitButton(); };
(window as unknown as Record<string, unknown>).__setConsultation = (v: string) => { state.consultation = v; };
(window as unknown as Record<string, unknown>).__submit = () => { submitBooking(); };

export async function initBooking(): Promise<void> {
  try {
    const profile = await liff.getProfile();
    state.userName = profile.displayName;
    state.lineUserId = profile.userId;
  } catch { /* LIFFプロファイル取得失敗は無視 */ }

  render();
}
