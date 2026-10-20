'use strict';
// Admin dashboard. Loaded after app.js and uses its helpers (api, $, summarizeDay, ...).

let adminDay = null;      // Date at local midnight of the day being viewed
let adminTimer = null;
let selectedEmployee = null;

function toDateInput(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function showAdmin(profile) {
  document.body.dataset.view = 'admin';
  $('login-view').hidden = true;
  $('home-view').hidden = true;
  $('admin-view').hidden = false;
  $('admin-name').textContent = profile.full_name || profile.username;
  const net = $('net');
  net.hidden = false;
  net.textContent = profile.network_trusted ? 'على شبكة الشركة' : 'خارج شبكة الشركة';
  net.className = `badge ${profile.network_trusted ? 'ok' : 'bad'}`;
  if (!adminDay) adminDay = startOfToday();
  $('admin-date').value = toDateInput(adminDay);
  $('admin-date').max = toDateInput(startOfToday());
  selectAdminTab(activeAdminTab);
  clearInterval(adminTimer);
  adminTimer = setInterval(() => { if (!$('admin-view').hidden && !document.hidden && activeAdminTab === 'attendance') loadBoard(); }, 60000);
}

async function loadBoard() {
  const from = adminDay;
  const to = new Date(from); to.setDate(to.getDate() + 1);
  const isToday = +from === +startOfToday();
  $('board-title').textContent = isToday ? 'حضور اليوم' : `الحضور · ${dateFmt.format(from)}`;
  showMsg($('admin-msg'), '');
  let rows;
  try {
    rows = await api(`/admin/day?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`);
  } catch (err) {
    if (err.status === 401 || err.status === 403) { clearToken(); return showLogin(); }
    return showMsg($('admin-msg'), errorText(err), 'error');
  }

  let present = 0, now = 0;
  $('board').replaceChildren(...rows.map((emp) => {
    const s = summarizeDay(emp.events, from);
    const inNow = isToday && s.checkedIn;
    if (s.worked) present++;
    if (inNow) now++;

    const tr = document.createElement('tr');
    tr.className = 'clickable' + (selectedEmployee === emp.id ? ' selected' : '');
    tr.tabIndex = 0;
    const cell = (text) => { const td = document.createElement('td'); td.textContent = text; return td; };

    const who = document.createElement('td');
    const name = document.createElement('div'); name.className = 'name'; name.textContent = emp.full_name;
    const code = document.createElement('div'); code.className = 'muted'; code.textContent = emp.employee_code;
    who.append(name, code);

    const status = document.createElement('td');
    const pill = document.createElement('span');
    if (inNow) { pill.className = 'pill in'; pill.textContent = 'على رأس العمل'; }
    else if (s.worked) { pill.className = 'pill done'; pill.textContent = 'انصرف'; }
    else { pill.className = 'pill absent'; pill.textContent = 'لم يحضر'; }
    status.append(pill);

    tr.append(
      who,
      cell(s.firstIn ? timeFmt.format(new Date(s.firstIn.event_time)) : '--:--'),
      cell(s.lastOut && !inNow ? timeFmt.format(new Date(s.lastOut.event_time)) : '--:--'),
      cell(fmtDuration(s.ms)),
      status,
    );
    const open = () => openEmployee(emp.id);
    tr.addEventListener('click', open);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    return tr;
  }));
  $('board-empty').hidden = rows.length > 0;
  $('st-total').textContent = rows.length;
  $('st-present').textContent = present;
  $('st-now').textContent = now;
  $('st-absent').textContent = rows.length - present;
}

async function openEmployee(id) {
  let data;
  try { data = await api(`/admin/employees/${id}/history`); }
  catch (err) { return showMsg($('admin-msg'), errorText(err), 'error'); }
  selectedEmployee = id;
  loadBoard();
  $('detail-name').textContent = data.employee.full_name;
  $('detail-code').textContent = data.employee.employee_code;
  $('detail-rows').replaceChildren(...data.events.map((e) => {
    const tr = document.createElement('tr');
    const d = new Date(e.event_time);
    const type = document.createElement('td');
    type.className = `ev ${e.event_type === 'CHECK_IN' ? 'in' : 'out'}`;
    type.textContent = e.event_type === 'CHECK_IN' ? 'حضور' : 'انصراف';
    const date = document.createElement('td'); date.textContent = dayFmt.format(d);
    const time = document.createElement('td'); time.textContent = timeFmt.format(d);
    const ip = document.createElement('td'); ip.dir = 'ltr'; ip.textContent = e.ip_address;
    tr.append(type, date, time, ip);
    return tr;
  }));
  $('detail-empty').hidden = data.events.length > 0;
  $('emp-detail').hidden = false;
  $('emp-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('admin-date').addEventListener('change', () => {
  const [y, m, d] = $('admin-date').value.split('-').map(Number);
  if (!y) return;
  adminDay = new Date(y, m - 1, d);
  loadBoard();
});
$('admin-refresh').addEventListener('click', () => (activeAdminTab === 'employees' ? loadEmployees() : loadBoard()));
$('detail-close').addEventListener('click', () => { selectedEmployee = null; $('emp-detail').hidden = true; loadBoard(); });
$('admin-logout').addEventListener('click', () => {
  clearInterval(adminTimer);
  adminDay = null; selectedEmployee = null;
  $('emp-detail').hidden = true;
  closeEmployeeForm();
  $('emp-msg').hidden = true;
  activeAdminTab = 'attendance';
  clearToken();
  showLogin();
});
