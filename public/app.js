const $ = (selector) => document.querySelector(selector);
let currentUser = null;
let eventsCache = [];

function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.className = 'toast'; }, 4200);
}
async function api(url, options = {}) {
  const opts = { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }, credentials: 'same-origin' };
  const response = await fetch(url, opts);
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
}
function fmtDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Date to be announced' : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}
function setUser(user) {
  currentUser = user || null;
  $('#authSection').classList.toggle('hidden', Boolean(user));
  $('#logoutBtn').classList.toggle('hidden', !user);
  $('#myEventsNav').classList.toggle('hidden', !user);
  $('#accountNav').classList.toggle('hidden', !user);
  $('#adminNav').classList.toggle('hidden', user?.role !== 'admin');
  $('#userLabel').textContent = user ? `${user.name} · ${user.role}` : '';
  $('#adminSection').classList.toggle('hidden', user?.role !== 'admin');
  if (!user) {
    window.CampusScanner?.stop();
    $('#accountSection').classList.add('hidden');
    $('#myTicketsSection').classList.add('hidden');
  }
}
async function loadMe() {
  try { const data = await api('/api/me'); setUser(data.user); }
  catch { setUser(null); }
}

/* ---------- events ---------- */
function eventCard(event) {
  const remaining = Math.max(0, Number(event.capacity) - Number(event.registered_count));
  const full = remaining <= 0;
  let button;
  if (!currentUser) button = `<button class="button button-dark full need-login">Sign in to register</button>`;
  else if (event.my_registration_id) button = `<button class="button button-ghost full" disabled>✓ You're registered</button>`;
  else button = `<button class="button button-primary full register-event" data-id="${event.id}" ${full ? 'disabled' : ''}>${full ? 'Event full' : 'Register now'}</button>`;
  return `<article class="event-card">
    <div class="event-card-top"><span class="event-tag">CAMPUS EVENT</span><span class="capacity">${remaining} spots left</span></div>
    <h3>${esc(event.title)}</h3><p class="event-description">${esc(event.description)}</p>
    <div class="event-meta"><span aria-hidden="true">◷</span><span>${esc(fmtDate(event.starts_at))}</span></div>
    <div class="event-meta"><span aria-hidden="true">⌖</span><span>${esc(event.venue)}</span></div>
    <div class="event-bottom"><span class="muted">Deadline: ${esc(fmtDate(event.registration_deadline))}</span>${button}</div>
  </article>`;
}
function fillEventSelect(select, placeholder) {
  if (!select) return;
  const previous = select.value;
  select.innerHTML = `<option value="">${placeholder}</option>` + eventsCache.map(e => `<option value="${e.id}">${esc(e.title)}</option>`).join('');
  select.value = previous;
}
async function loadEvents() {
  const list = $('#eventsList');
  list.innerHTML = '<div class="empty-state">Loading events…</div>';
  try {
    const data = await api('/api/events');
    eventsCache = data.events;
    list.innerHTML = eventsCache.length
      ? eventsCache.map(eventCard).join('')
      : '<div class="empty-state">No events yet. An organizer can publish the first event after signing in as admin.</div>';
    fillEventSelect($('#reportEventSelect'), 'Select an event');
    fillEventSelect($('#checkinEventSelect'), 'Any event');
  } catch (error) {
    list.innerHTML = `<div class="empty-state">Could not load events: ${esc(error.message)}</div>`;
  }
}

/* ---------- tickets ---------- */
function ticketCard(r) {
  const cancelled = Boolean(r.cancelled_at);
  const status = cancelled
    ? '<p class="cancelled-text">Cancelled — this ticket is no longer valid</p>'
    : `<p class="${r.attended_at ? 'success-text' : 'muted'}">${r.attended_at ? 'Checked in' : 'Not checked in'}</p>`;
  const details = cancelled ? '' : `<details><summary>Show ticket token</summary><code>${esc(r.ticket_token)}</code></details>`;
  const cancelButton = r.can_cancel
    ? `<div class="ticket-actions"><button class="button button-small button-danger cancel-registration" data-id="${r.registration_id}" type="button">Cancel registration</button></div>` : '';
  const qr = cancelled ? '' : `<img class="ticket-qr" src="${r.qrDataUrl}" alt="QR ticket for ${esc(r.title)}">`;
  return `<article class="ticket-card${cancelled ? ' cancelled' : ''}">
    <div class="ticket-details"><span class="event-tag">${cancelled ? 'CANCELLED' : 'DIGITAL TICKET'}</span><h3>${esc(r.title)}</h3>
      <p>${esc(fmtDate(r.starts_at))}</p><p>${esc(r.venue)}</p>${status}${details}${cancelButton}
    </div>${qr}
  </article>`;
}
async function loadTickets(scroll = true) {
  $('#myTicketsSection').classList.remove('hidden');
  if (scroll) {
    $('#myTicketsList').innerHTML = '<div class="empty-state">Loading tickets…</div>';
    $('#myTicketsSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  try {
    const data = await api('/api/my/registrations');
    $('#myTicketsList').innerHTML = data.registrations.length
      ? data.registrations.map(ticketCard).join('')
      : '<div class="empty-state">You have not registered for any events yet.</div>';
  } catch (error) { $('#myTicketsList').innerHTML = `<div class="empty-state">${esc(error.message)}</div>`; }
}

/* ---------- forms ---------- */
async function submitForm(form, endpoint, successMessage, onSuccess) {
  const body = Object.fromEntries(new FormData(form).entries());
  if (endpoint === '/api/events') {
    // datetime-local inputs are local wall-clock values; convert them to ISO timestamps
    // in the browser so the backend stores an unambiguous instant.
    if (body.startsAt) body.startsAt = new Date(body.startsAt).toISOString();
    if (body.deadline) body.deadline = new Date(body.deadline).toISOString();
    if (body.capacity !== undefined) body.capacity = Number(body.capacity);
  }
  try {
    const data = await api(endpoint, { method: 'POST', body: JSON.stringify(body) });
    if (data.user) setUser(data.user);
    form.reset();
    toast(data.message && endpoint === '/api/me/password' ? data.message : successMessage);
    if (onSuccess) await onSuccess(data);
  } catch (error) { toast(error.message, true); }
}

$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  await submitForm(e.currentTarget, '/api/auth/login', 'Signed in successfully.', async () => {
    await loadEvents();
    if (currentUser?.role === 'admin') loadUsers(true);
  });
});
$('#registerForm').addEventListener('submit', async e => {
  e.preventDefault();
  await submitForm(e.currentTarget, '/api/auth/register', 'Account created successfully.', loadEvents);
});
$('#passwordForm').addEventListener('submit', async e => {
  e.preventDefault();
  await submitForm(e.currentTarget, '/api/me/password', 'Password updated.');
});
$('#logoutBtn').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); setUser(null); await loadEvents(); toast('You have logged out.'); }
  catch (error) { toast(error.message, true); }
});
$('#refreshEventsBtn').addEventListener('click', loadEvents);
$('#myEventsNav').addEventListener('click', () => loadTickets());
$('#accountNav').addEventListener('click', () => {
  $('#accountSection').classList.remove('hidden');
  $('#accountSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('#adminNav').addEventListener('click', () => {
  $('#adminSection').scrollIntoView({ behavior: 'smooth' });
  loadUsers(true);
});

$('#eventsList').addEventListener('click', async e => {
  const registerBtn = e.target.closest('.register-event');
  if (registerBtn) {
    registerBtn.disabled = true;
    try {
      await api(`/api/events/${registerBtn.dataset.id}/register`, { method: 'POST', body: '{}' });
      toast('Registration successful. Your QR ticket is ready and a confirmation email is on its way.');
      await loadEvents();
      await loadTickets();
    } catch (error) { toast(error.message, true); registerBtn.disabled = false; }
  }
  if (e.target.closest('.need-login')) {
    $('#authSection').scrollIntoView({ behavior: 'smooth' });
    $('#loginForm input[name="email"]').focus();
    toast('Please sign in or create an account first.');
  }
});

$('#myTicketsList').addEventListener('click', async e => {
  const btn = e.target.closest('.cancel-registration');
  if (!btn) return;
  if (!confirm('Cancel this registration? Your ticket will stop working and your seat will be released.')) return;
  btn.disabled = true;
  try {
    const data = await api(`/api/my/registrations/${btn.dataset.id}/cancel`, { method: 'POST', body: '{}' });
    toast(data.message);
    await loadEvents();
    await loadTickets(false);
  } catch (error) { toast(error.message, true); btn.disabled = false; }
});

$('#createEventForm').addEventListener('submit', async e => {
  e.preventDefault();
  await submitForm(e.currentTarget, '/api/events', 'Event published.', loadEvents);
});

$('#loadReportBtn').addEventListener('click', async () => {
  const eventId = $('#reportEventSelect').value;
  const list = $('#reportList');
  if (!eventId) { list.textContent = 'Select an event first.'; return; }
  try {
    const data = await api(`/api/admin/registrations?eventId=${encodeURIComponent(eventId)}`);
    if (!data.registrations.length) { list.textContent = 'No registrations yet.'; return; }
    const active = data.registrations.filter(r => !r.cancelled_at);
    const present = active.filter(r => r.attended_at).length;
    const state = r => r.cancelled_at ? ['Cancelled', 'cancelled-text'] : r.attended_at ? ['Present', 'success-text'] : ['Registered', 'muted'];
    list.innerHTML = `<p><strong>${active.length}</strong> active · <strong>${present}</strong> checked in · ${data.registrations.length - active.length} cancelled</p>` +
      data.registrations.map(r => {
        const [label, cls] = state(r);
        return `<div class="report-row"><span><strong>${esc(r.name)}</strong><small>${esc(r.email)}</small></span><span class="${cls}">${label}</span></div>`;
      }).join('');
  } catch (error) { list.textContent = error.message; }
});

/* ---------- admin: users ---------- */
const usersState = { q: '', offset: 0, total: 0 };
function userRow(u) {
  const self = String(u.id) === String(currentUser?.id);
  const actions = self ? '<small class="muted">This is you</small>' : `
    <button class="button button-small button-ghost user-action" data-id="${u.id}" data-field="role" data-value="${u.role === 'admin' ? 'student' : 'admin'}" type="button">${u.role === 'admin' ? 'Make student' : 'Make admin'}</button>
    <button class="button button-small ${u.is_active ? 'button-danger' : 'button-ghost'} user-action" data-id="${u.id}" data-field="isActive" data-value="${u.is_active ? 'false' : 'true'}" type="button">${u.is_active ? 'Deactivate' : 'Reactivate'}</button>`;
  return `<div class="user-row">
    <span class="user-info"><strong>${esc(u.name)}</strong><small>${esc(u.email)}</small><small>${u.active_registrations} active registration(s) · joined ${esc(fmtDate(u.created_at))}</small></span>
    <span class="user-badges"><span class="badge ${u.role === 'admin' ? 'badge-admin' : ''}">${esc(u.role)}</span>${u.is_active ? '' : '<span class="badge badge-off">deactivated</span>'}</span>
    <span class="user-actions">${actions}</span>
  </div>`;
}
async function loadUsers(reset) {
  if (currentUser?.role !== 'admin') return;
  if (reset) { usersState.offset = 0; $('#usersList').innerHTML = ''; }
  try {
    const params = new URLSearchParams({ q: usersState.q, limit: '20', offset: String(usersState.offset) });
    const data = await api(`/api/admin/users?${params}`);
    usersState.total = data.total;
    usersState.offset += data.users.length;
    const html = data.users.map(userRow).join('');
    if (reset) $('#usersList').innerHTML = html || '<p class="muted">No users match.</p>';
    else $('#usersList').insertAdjacentHTML('beforeend', html);
    $('#usersMore').classList.toggle('hidden', usersState.offset >= usersState.total);
  } catch (error) { toast(error.message, true); }
}
let searchTimer;
$('#userSearch').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { usersState.q = e.target.value.trim(); loadUsers(true); }, 300);
});
$('#usersMore').addEventListener('click', () => loadUsers(false));
$('#usersList').addEventListener('click', async e => {
  const btn = e.target.closest('.user-action');
  if (!btn) return;
  const { id, field, value } = btn.dataset;
  const prompts = {
    'role:admin': 'Give this user full administrator access?',
    'isActive:false': 'Deactivate this account? They will be signed out immediately and cannot log in.'
  };
  const prompt = prompts[`${field}:${value}`];
  if (prompt && !confirm(prompt)) return;
  btn.disabled = true;
  try {
    const body = field === 'isActive' ? { isActive: value === 'true' } : { role: value };
    await api(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    toast('User updated.');
    // Re-render from the first page up to what was already visible.
    const visible = Math.max(usersState.offset, 20);
    usersState.offset = 0;
    $('#usersList').innerHTML = '';
    const params = new URLSearchParams({ q: usersState.q, limit: String(Math.min(visible, 50)), offset: '0' });
    const data = await api(`/api/admin/users?${params}`);
    usersState.total = data.total; usersState.offset = data.users.length;
    $('#usersList').innerHTML = data.users.map(userRow).join('');
    $('#usersMore').classList.toggle('hidden', usersState.offset >= usersState.total);
  } catch (error) { toast(error.message, true); btn.disabled = false; }
});

(async function init() {
  await loadMe();
  await loadEvents();
  if (currentUser?.role === 'admin') loadUsers(true);
})();
