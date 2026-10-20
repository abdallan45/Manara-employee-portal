'use strict';
// Admin: employee management tab (add, edit, deactivate/activate). Loaded after app.js and admin.js.

let activeAdminTab = 'attendance';
let editingEmployee = null;   // employee object being edited, or null when adding
let employeesList = [];

function selectAdminTab(name) {
  activeAdminTab = name;
  for (const t of ['attendance', 'employees']) {
    $(`tab-btn-${t}`).setAttribute('aria-selected', String(t === name));
    $(`tab-${t}`).hidden = t !== name;
  }
  $('admin-date').hidden = name !== 'attendance';
  showMsg($('emp-msg'), '');
  if (name === 'employees') loadEmployees(); else loadBoard();
}
$('tab-btn-attendance').addEventListener('click', () => selectAdminTab('attendance'));
$('tab-btn-employees').addEventListener('click', () => selectAdminTab('employees'));

const EMP_ERRORS = {
  employee_code_taken: 'الرقم الوظيفي مستخدم لموظف آخر.',
  username_taken: 'اسم المستخدم مستخدم لحساب آخر.',
};
function empErrorText(err) {
  if (err instanceof ApiError && EMP_ERRORS[err.message]) return EMP_ERRORS[err.message];
  if (err instanceof ApiError && err.status === 400) return 'تحقق من الحقول: بعض القيم غير صالحة.';
  return errorText(err);
}

async function loadEmployees() {
  try {
    employeesList = await api('/admin/employees');
  } catch (err) {
    if (err.status === 401 || err.status === 403) { clearToken(); return showLogin(); }
    return showMsg($('emp-msg'), errorText(err), 'error');
  }
  $('emp-rows').replaceChildren(...employeesList.map(employeeRow));
  $('emp-empty').hidden = employeesList.length > 0;
}

function employeeRow(emp) {
  const tr = document.createElement('tr');
  if (!emp.active) tr.className = 'inactive';

  const who = document.createElement('td');
  const name = document.createElement('div'); name.className = 'name'; name.textContent = emp.full_name;
  const code = document.createElement('div'); code.className = 'muted'; code.textContent = emp.employee_code;
  who.append(name, code);

  const user = document.createElement('td'); user.dir = 'ltr'; user.style.textAlign = 'right'; user.textContent = emp.username || '—';

  const status = document.createElement('td');
  const pill = document.createElement('span');
  pill.className = emp.active ? 'pill in' : 'pill off';
  pill.textContent = emp.active ? 'نشط' : 'معطّل';
  status.append(pill);

  const actions = document.createElement('td');
  const wrap = document.createElement('div'); wrap.className = 'row-actions';
  const edit = document.createElement('button');
  edit.className = 'btn ghost small'; edit.textContent = 'تعديل';
  edit.addEventListener('click', () => openEmployeeForm(emp));
  const toggle = document.createElement('button');
  toggle.className = `btn ghost small${emp.active ? ' danger' : ''}`;
  toggle.textContent = emp.active ? 'تعطيل' : 'تفعيل';
  toggle.addEventListener('click', () => toggleEmployee(emp, toggle));
  wrap.append(edit, toggle);
  actions.append(wrap);

  tr.append(who, user, status, actions);
  return tr;
}

// Deactivation needs a second click within 4 seconds, so a stray tap cannot lock someone out.
async function toggleEmployee(emp, btn) {
  if (emp.active && btn.dataset.confirm !== '1') {
    btn.dataset.confirm = '1';
    btn.textContent = 'تأكيد التعطيل؟';
    setTimeout(() => { if (btn.isConnected) { btn.dataset.confirm = ''; btn.textContent = 'تعطيل'; } }, 4000);
    return;
  }
  btn.disabled = true;
  try {
    await api(`/admin/employees/${emp.id}/${emp.active ? 'deactivate' : 'activate'}`, { method: 'POST' });
    showMsg($('emp-msg'), emp.active ? `تم تعطيل حساب ${emp.full_name}. لن يستطيع تسجيل الدخول.` : `تم تفعيل حساب ${emp.full_name}.`, 'success');
    await loadEmployees();
  } catch (err) {
    btn.disabled = false;
    showMsg($('emp-msg'), empErrorText(err), 'error');
  }
}

function openEmployeeForm(emp) {
  editingEmployee = emp || null;
  $('emp-form-title').textContent = emp ? `تعديل: ${emp.full_name}` : 'موظف جديد';
  $('f-name').value = emp ? emp.full_name : '';
  $('f-code').value = emp ? emp.employee_code : '';
  $('f-username').value = emp ? emp.username || '' : '';
  $('f-password').value = '';
  $('f-password').required = !emp;
  $('f-password-hint').textContent = emp ? 'اتركها فارغة للإبقاء على كلمة المرور الحالية' : '8 أحرف على الأقل';
  showMsg($('emp-form-msg'), '');
  $('emp-form-card').hidden = false;
  $('emp-form-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  $('f-name').focus();
}
function closeEmployeeForm() {
  editingEmployee = null;
  $('emp-form-card').hidden = true;
  $('f-password').value = '';
}

$('emp-add').addEventListener('click', () => openEmployeeForm(null));
$('emp-cancel').addEventListener('click', closeEmployeeForm);
$('f-username').addEventListener('input', (e) => { e.target.value = e.target.value.toLowerCase(); });

$('emp-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const values = {
    full_name: $('f-name').value.trim(),
    employee_code: $('f-code').value.trim(),
    username: $('f-username').value.trim(),
    password: $('f-password').value,
  };
  let body = values;
  if (editingEmployee) {
    // Send only what changed.
    body = {};
    for (const k of ['full_name', 'employee_code', 'username']) if (values[k] !== (editingEmployee[k] || '')) body[k] = values[k];
    if (values.password) body.password = values.password;
    if (!Object.keys(body).length) return closeEmployeeForm();
  }
  const btn = $('emp-save');
  btn.disabled = true;
  showMsg($('emp-form-msg'), '');
  try {
    const saved = await api(editingEmployee ? `/admin/employees/${editingEmployee.id}` : '/admin/employees', {
      method: editingEmployee ? 'PATCH' : 'POST',
      body: JSON.stringify(body),
    });
    showMsg($('emp-msg'), editingEmployee ? `تم حفظ بيانات ${saved.full_name}.` : `تمت إضافة ${saved.full_name}. يستطيع الدخول باسم المستخدم ${saved.username}.`, 'success');
    closeEmployeeForm();
    await loadEmployees();
  } catch (err) {
    showMsg($('emp-form-msg'), empErrorText(err), 'error');
  } finally {
    btn.disabled = false;
  }
});
