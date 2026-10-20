'use strict';
// Employee portal: talks to the same-origin API at /api/v1.
const API = '/api/v1';
const TOKEN_KEY = 'attendance.token';
const $ = (id) => document.getElementById(id);

const timeFmt = new Intl.DateTimeFormat('ar', { hour: '2-digit', minute: '2-digit', numberingSystem: 'latn' });
const dateFmt = new Intl.DateTimeFormat('ar', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', numberingSystem: 'latn' });
const dayFmt = new Intl.DateTimeFormat('ar', { weekday: 'short', day: 'numeric', month: 'short', numberingSystem: 'latn' });

let me = null;
let events = [];           // newest first, as returned by the API
let pending = null;        // { type, key } kept across retries of a failed network request
let busy = false;

// --- token storage (wrapped: storage can be unavailable) ---
function getToken() {
  try {
    const raw = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
    return raw && raw.exp > Date.now() ? raw.token : null;
  } catch { return null; }
}
function setToken(token, expiresIn) {
  try { localStorage.setItem(TOKEN_KEY, JSON.stringify({ token, exp: Date.now() + expiresIn * 1000 })); } catch {}
}
function clearToken() { try { localStorage.removeItem(TOKEN_KEY); } catch {} }

// crypto.randomUUID only exists on HTTPS/localhost; LAN over HTTP needs a fallback.
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API + path, { ...options, headers, cache: 'no-store' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.message || res.statusText);
  return body;
}

// --- views ---
function showLogin() {
  me = null;
  document.body.dataset.view = 'login';
  $('home-view').hidden = true;
  $('admin-view').hidden = true;
  $('net').hidden = true;
  $('login-view').hidden = false;
  $('username').focus();
}
function showHome() {
  document.body.dataset.view = 'employee';
  $('admin-view').hidden = true;
  $('login-view').hidden = true;
  $('home-view').hidden = false;
}

function showMsg(el, text, kind) {
  el.textContent = text;
  el.className = `msg ${kind || ''}`;
  el.hidden = !text;
}

function errorText(err) {
  if (!(err instanceof ApiError)) return 'تعذّر الاتصال بالخادم. تحقق من الشبكة وحاول مرة أخرى.';
  if (err.status === 403 && /LAN/i.test(err.message)) return 'أنت خارج شبكة الشركة. اتصل بشبكة الموظفين لتسجيل الحضور أو الانصراف.';
  if (err.status === 409) return 'لا يمكن تنفيذ هذه العملية الآن. حدّث الصفحة وحاول مجددًا.';
  if (err.status === 401) return 'انتهت الجلسة. سجّل الدخول من جديد.';
  return `حدث خطأ (${err.status}).`;
}

// --- login ---
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('login-btn');
  btn.disabled = true;
  showMsg($('login-error'), '');
  try {
    const r = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('username').value.trim(), password: $('password').value }),
    });
    setToken(r.access_token, r.expires_in);
    $('password').value = '';
    await loadAll();
  } catch (err) {
    showMsg($('login-error'), err.status === 401 ? 'اسم المستخدم أو كلمة المرور غير صحيحة.' : errorText(err), 'error');
  } finally {
    btn.disabled = false;
  }
});

// Demo quick login: the server only answers when DEMO_MODE=true.
async function loadDemoAccounts() {
  let accounts;
  try { accounts = await api('/auth/demo/accounts'); } catch { return; }
  if (!accounts.length) return;
  $('demo-list').replaceChildren(...accounts.map((a) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn ghost';
    const name = document.createElement('span');
    name.textContent = a.full_name;
    const code = document.createElement('span');
    code.className = 'muted';
    if (a.role === 'ADMIN') code.textContent = 'مدير';
    else { code.dir = 'ltr'; code.textContent = a.employee_code; }
    btn.append(name, code);
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      showMsg($('login-error'), '');
      try {
        const r = await api('/auth/demo/login', { method: 'POST', body: JSON.stringify({ username: a.username }) });
        setToken(r.access_token, r.expires_in);
        await loadAll();
      } catch (err) {
        showMsg($('login-error'), errorText(err), 'error');
      } finally {
        btn.disabled = false;
      }
    });
    return btn;
  }));
  $('demo').hidden = false;
}

$('logout').addEventListener('click', () => { clearToken(); showLogin(); });
$('refresh').addEventListener('click', () => loadAll());

// --- data ---
async function loadAll() {
  if (!getToken()) return showLogin();
  try {
    const profile = await api('/me');
    if (profile.role === 'ADMIN') { me = null; return showAdmin(profile); }
    events = await api('/attendance/history');
    me = profile;
    showHome();
    render();
  } catch (err) {
    if (err.status === 401) { clearToken(); return showLogin(); }
    if (err.status === 403 && me === null) {
      // Account without an employee record (e.g. admin)
      clearToken();
      showLogin();
      return showMsg($('login-error'), 'هذا الحساب ليس حساب موظف.', 'error');
    }
    showMsg($('action-msg'), errorText(err), 'error');
  }
}

// Day summary from events (newest first) that cover the day plus the last event before it.
// Worked time pairs each CHECK_IN with the next CHECK_OUT; an open session counts until now (or the day's end).
function summarizeDay(evts, dayStart) {
  const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
  const last = evts[0];
  const checkedIn = last?.event_type === 'CHECK_IN';
  const day = evts.filter((e) => { const t = new Date(e.event_time); return t >= dayStart && t < dayEnd; }).reverse(); // oldest first
  const before = evts.find((e) => new Date(e.event_time) < dayStart);
  const firstIn = day.find((e) => e.event_type === 'CHECK_IN');
  const lastOut = [...day].reverse().find((e) => e.event_type === 'CHECK_OUT');
  let ms = 0, openSince = before?.event_type === 'CHECK_IN' ? dayStart : null; // shift crossed midnight
  for (const e of day) {
    const t = new Date(e.event_time);
    if (e.event_type === 'CHECK_IN') openSince = t;
    else if (openSince) { ms += t - openSince; openSince = null; }
  }
  if (openSince) ms += Math.min(Date.now(), +dayEnd) - openSince;
  return { last, checkedIn, firstIn, lastOut, ms, worked: day.length > 0 || openSince !== null };
}

function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
function summary() { return summarizeDay(events, startOfToday()); }

function fmtDuration(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

function render() {
  if (!me) return;
  $('emp-name').textContent = me.full_name || me.username;
  $('emp-code').textContent = me.employee_code || '—';

  const net = $('net');
  net.hidden = false;
  net.textContent = me.network_trusted ? 'على شبكة الشركة' : 'خارج شبكة الشركة';
  net.className = `badge ${me.network_trusted ? 'ok' : 'bad'}`;

  const s = summary();
  const status = $('status');
  if (s.checkedIn) {
    const since = new Date(s.last.event_time);
    const sinceText = since >= startOfToday() ? timeFmt.format(since) : `${dayFmt.format(since)} ${timeFmt.format(since)}`;
    status.textContent = `على رأس العمل منذ ${sinceText}`;
    status.className = 'status in';
  } else if (s.lastOut) {
    status.textContent = 'انتهى دوامك اليوم';
    status.className = 'status done';
  } else {
    status.textContent = 'لم تسجّل حضورك بعد';
    status.className = 'status';
  }
  $('t-in').textContent = s.firstIn ? timeFmt.format(new Date(s.firstIn.event_time)) : '--:--';
  $('t-out').textContent = s.lastOut && !s.checkedIn ? timeFmt.format(new Date(s.lastOut.event_time)) : '--:--';
  $('t-dur').textContent = fmtDuration(s.ms);

  const action = $('action');
  action.textContent = s.checkedIn ? 'تسجيل انصراف' : 'تسجيل حضور';
  action.className = `btn big ${s.checkedIn ? 'out' : 'primary'}`;
  action.disabled = busy || !me.network_trusted;
  action.title = me.network_trusted ? '' : 'متاح فقط من شبكة الشركة';

  const list = $('history');
  list.replaceChildren(...events.slice(0, 10).map((e) => {
    const li = document.createElement('li');
    const d = new Date(e.event_time);
    const ev = document.createElement('span');
    ev.className = `ev ${e.event_type === 'CHECK_IN' ? 'in' : 'out'}`;
    ev.textContent = e.event_type === 'CHECK_IN' ? 'حضور' : 'انصراف';
    const when = document.createElement('span');
    when.className = 'muted';
    when.textContent = `${dayFmt.format(d)} · ${timeFmt.format(d)}`;
    li.append(ev, when);
    return li;
  }));
  $('history-empty').hidden = events.length > 0;
}

// --- check in / out ---
$('action').addEventListener('click', async () => {
  if (busy) return;
  const type = summary().checkedIn ? 'check-out' : 'check-in';
  if (!pending || pending.type !== type) pending = { type, key: uuid() };
  busy = true;
  render();
  showMsg($('action-msg'), '');
  try {
    const ev = await api(`/attendance/${type}`, { method: 'POST', body: JSON.stringify({ idempotency_key: pending.key }) });
    pending = null;
    showMsg($('action-msg'), `${type === 'check-in' ? 'تم تسجيل الحضور' : 'تم تسجيل الانصراف'} الساعة ${timeFmt.format(new Date(ev.event_time))}`, 'success');
    await loadAll();
  } catch (err) {
    if (err instanceof ApiError) pending = null; // server answered: a retry should be a new event
    if (err.status === 401) { clearToken(); return showLogin(); }
    showMsg($('action-msg'), errorText(err), 'error');
    if (err.status === 403 || err.status === 409) loadAll();
  } finally {
    busy = false;
    render();
  }
});

// --- clock ---
function tick() {
  const now = new Date();
  $('clock').textContent = timeFmt.format(now);
  $('today').textContent = dateFmt.format(now);
  if (me && summary().checkedIn) $('t-dur').textContent = fmtDuration(summary().ms);
}
setInterval(tick, 1000);
tick();

// Re-check network status and records when the app comes back to the foreground.
document.addEventListener('visibilitychange', () => { if (!document.hidden && getToken()) loadAll(); });

// PWA: service worker needs HTTPS or localhost.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// Start once admin.js and employees.js (loaded after this file) have run.
document.addEventListener('DOMContentLoaded', () => { loadDemoAccounts(); loadAll(); });
