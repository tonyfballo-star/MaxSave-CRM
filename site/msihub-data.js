/* =====================================================================
   MSIHub — Supabase data layer
   Loaded after the main CRM script. Handles login, loads every table into
   the CRM's existing in-memory arrays, and overrides the write paths so
   changes are saved to the database and shared across every agent.
   ===================================================================== */
(function () {
  'use strict';

  const SUPABASE_URL = 'https://xcwkkynxgojmabxdrngm.supabase.co';
  const SUPABASE_KEY = 'sb_publishable__FNJF77rVOr5kbP2grko_w_0sIz3GDM';

  const M = window.MSIHub = {
    sb: null, user: null, profile: null, ready: false,
    currentLeadId: null,
    hooks: { remap: [] },
    missingTables: new Set(),
    data: { profiles: [], leads: [], customers: [], policies: [], vehicles: [], drivers: [], claims: [],
            sales: [], appointments: [], notes: [], quotes: [], calls: [], messages: [], templates: [], files: [], tasks: [], agency_settings: [] },
  };

  // ------------------------------------------------------------------
  // Small helpers
  // ------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const num = (v) => parseFloat(String(v == null ? '' : v).replace(/[$,]/g, '')) || 0;
  const todayISO = () => localISODate(new Date());
  function localISODate(d) { const x = new Date(d); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); }
  function fmt12(hhmm) { if (!hhmm) return ''; const [h, m] = hhmm.split(':').map(Number); const ap = h >= 12 ? 'PM' : 'AM'; const hr = h % 12 === 0 ? 12 : h % 12; return hr + ':' + String(m).padStart(2, '0') + ' ' + ap; }
  function fmtTime(ts) { return ts ? new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : ''; }
  function fmtStamp(ts) { return ts ? new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''; }
  function fmtDay(ts) { const d = new Date(ts); const t = new Date(); if (localISODate(d) === localISODate(t)) return 'Today'; t.setDate(t.getDate() - 1); if (localISODate(d) === localISODate(t)) return 'Yesterday'; return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
  function isoToUS(iso) { if (!iso) return ''; const [y, m, d] = String(iso).slice(0, 10).split('-'); return (m && d && y) ? m + '/' + d + '/' + y : ''; }
  function usToISO(us) { if (!us) return null; const s = String(us).trim(); if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0') : null; }
  function ageFrom(iso) { if (!iso) return 0; const b = new Date(iso); const t = new Date(); let a = t.getFullYear() - b.getFullYear(); if (t < new Date(t.getFullYear(), b.getMonth(), b.getDate())) a--; return a > 0 ? a : 0; }
  function fmtPhone(p) { const d = String(p || '').replace(/\D/g, ''); if (d.length === 10) return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6); if (d.length === 11 && d[0] === '1') return fmtPhone(d.slice(1)); return p || ''; }
  const fullName = (r) => ((r.first_name || '') + ' ' + (r.last_name || '')).trim();
  const initials = (n) => String(n || '').split(' ').filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  M.toast = function (msg, kind) {
    let c = $('msihubToasts');
    if (!c) { c = document.createElement('div'); c.id = 'msihubToasts'; c.style.cssText = 'position:fixed;bottom:22px;left:50%;transform:translateX(-50%);z-index:30000;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none'; document.body.appendChild(c); }
    const t = document.createElement('div');
    const bg = kind === 'error' ? '#DC2626' : kind === 'warn' ? '#D97706' : '#1C2B4B';
    t.style.cssText = 'background:' + bg + ';color:#fff;padding:11px 18px;border-radius:10px;font-family:var(--font-body,sans-serif);font-size:13.5px;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,0.25);max-width:520px;text-align:center;opacity:0;transition:opacity .2s';
    t.textContent = msg;
    c.appendChild(t);
    requestAnimationFrame(() => { t.style.opacity = '1'; });
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 250); }, kind === 'error' ? 6000 : 3200);
  };
  function fail(where, err) { console.error('[MSIHub] ' + where, err); M.toast((where ? where + ': ' : '') + (err && err.message ? err.message : String(err)), 'error'); }

  // The original app used browser alert() pop-ups for feedback. Show them as toasts instead
  // (validation messages in amber, everything else in navy). confirm() is left alone: it needs a yes/no.
  window.alert = function (msg) {
    const text = String(msg == null ? '' : msg).replace(/\s*\n+\s*/g, ' · ').trim();
    if (!text) return;
    M.toast(text, /^(please|enter|select|pick|type|choose)\b|required|first\.?$|invalid|missing/i.test(text) ? 'warn' : 'info');
  };

  const me = () => M.profile || {};
  const myId = () => (M.user && M.user.id) || null;
  const isAdmin = () => me().role === 'admin';
  const profileById = (id) => M.data.profiles.find((p) => p.id === id);
  const agentName = (id) => { const p = profileById(id); return p ? p.full_name : 'Unassigned'; };
  const profileByName = (name) => M.data.profiles.find((p) => p.full_name === name);
  const leadById = (id) => LEADS.find((l) => l.id === id);
  const customerById = (id) => CUSTOMERS.find((c) => c.id === id);
  M.currentLead = () => leadById(M.currentLeadId) || null;
  M.agents = () => M.data.profiles.filter((p) => p.active);

  // ------------------------------------------------------------------
  // Auth screens
  // ------------------------------------------------------------------
  function authShell(inner) {
    let o = $('msihubAuth');
    if (!o) { o = document.createElement('div'); o.id = 'msihubAuth'; document.body.appendChild(o); }
    o.style.cssText = 'position:fixed;inset:0;z-index:25000;background:linear-gradient(160deg,#0A1624 0%,#122B47 60%,#1C2B4B 100%);display:flex;align-items:center;justify-content:center;font-family:var(--font-body,Outfit,sans-serif)';
    o.innerHTML = '<div style="width:400px;max-width:92vw;background:#fff;border-radius:18px;padding:34px 36px;box-shadow:0 24px 60px rgba(0,0,0,0.45)">' +
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:22px">' +
        '<div style="width:44px;height:44px;border-radius:12px;background:#1C2B4B;display:flex;align-items:center;justify-content:center;color:#3BAA47;font-family:var(--font-display,Sora,sans-serif);font-weight:800;font-size:15px">M|H</div>' +
        '<div><div style="font-family:var(--font-display,Sora,sans-serif);font-weight:800;font-size:20px;color:#1C2B4B;line-height:1.1">MSIHub</div><div style="font-size:11.5px;color:#6B7280;font-weight:600;letter-spacing:.3px">Maxsave · Powered Up</div></div>' +
      '</div>' + inner + '</div>';
    o.style.display = 'flex';
  }
  const inputCss = 'width:100%;padding:11px 13px;border:1px solid #D1D5DB;border-radius:9px;font-size:14px;font-family:inherit;margin-bottom:12px;box-sizing:border-box;color:#1C2B4B';
  const btnCss = 'width:100%;padding:12px;border:none;border-radius:9px;background:#3BAA47;color:#fff;font-weight:700;font-size:14px;cursor:pointer;font-family:inherit';

  function showLogin(msg) {
    authShell(
      '<div style="font-size:15px;font-weight:700;color:#1C2B4B;margin-bottom:14px">Sign in to your agency</div>' +
      '<form id="msihubLoginForm" autocomplete="on">' +
      '<input id="authEmail" type="email" placeholder="Email" autocomplete="username" required style="' + inputCss + '">' +
      '<input id="authPassword" type="password" placeholder="Password" autocomplete="current-password" required style="' + inputCss + '">' +
      '<div id="authMsg" style="min-height:18px;font-size:12.5px;color:#DC2626;margin-bottom:8px">' + esc(msg || '') + '</div>' +
      '<button id="authSubmit" type="submit" style="' + btnCss + '">Sign In</button>' +
      '</form>' +
      '<div style="text-align:center;margin-top:14px"><a href="#" id="authForgot" style="font-size:12.5px;color:#1C2B4B;font-weight:600">Forgot password?</a></div>'
    );
    $('msihubLoginForm').onsubmit = async (e) => {
      e.preventDefault();
      const email = $('authEmail').value.trim(), password = $('authPassword').value;
      const b = $('authSubmit'); b.disabled = true; b.textContent = 'Signing in…';
      const { data, error } = await M.sb.auth.signInWithPassword({ email, password });
      if (error) { $('authMsg').textContent = error.message; b.disabled = false; b.textContent = 'Sign In'; return; }
      await startApp(data.session);
    };
    $('authForgot').onclick = async (e) => {
      e.preventDefault();
      const email = $('authEmail').value.trim();
      if (!email) { $('authMsg').textContent = 'Type your email first, then click Forgot password.'; return; }
      const { error } = await M.sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      $('authMsg').style.color = error ? '#DC2626' : '#15803D';
      $('authMsg').textContent = error ? error.message : 'Check your email for a reset link.';
    };
    setTimeout(() => { const el = $('authEmail'); if (el) el.focus(); }, 50);
  }

  function showSetPassword() {
    authShell(
      '<div style="font-size:15px;font-weight:700;color:#1C2B4B;margin-bottom:6px">Welcome! Set your password</div>' +
      '<div style="font-size:12.5px;color:#6B7280;margin-bottom:14px">Choose a password to finish setting up your MSIHub login.</div>' +
      '<form id="msihubPwForm">' +
      '<input id="pwName" type="text" placeholder="Your full name (as agents will see it)" autocomplete="name" required style="' + inputCss + '">' +
      '<input id="pw1" type="password" placeholder="New password (8+ characters)" autocomplete="new-password" required minlength="8" style="' + inputCss + '">' +
      '<input id="pw2" type="password" placeholder="Confirm password" autocomplete="new-password" required style="' + inputCss + '">' +
      '<div id="authMsg" style="min-height:18px;font-size:12.5px;color:#DC2626;margin-bottom:8px"></div>' +
      '<button id="authSubmit" type="submit" style="' + btnCss + '">Save &amp; Continue</button></form>'
    );
    $('msihubPwForm').onsubmit = async (e) => {
      e.preventDefault();
      if ($('pw1').value !== $('pw2').value) { $('authMsg').textContent = 'Passwords do not match.'; return; }
      const name = $('pwName').value.trim();
      if (name.split(' ').length < 2) { $('authMsg').textContent = 'Please enter your first and last name.'; return; }
      const b = $('authSubmit'); b.disabled = true;
      const { data: upd, error } = await M.sb.auth.updateUser({ password: $('pw1').value, data: { full_name: name } });
      if (error) { $('authMsg').textContent = error.message; b.disabled = false; return; }
      try { await M.sb.from('profiles').update({ full_name: name }).eq('id', upd.user.id); } catch (e2) { console.warn('[MSIHub] name not saved', e2); }
      history.replaceState(null, '', location.pathname + location.search);
      const { data: { session } } = await M.sb.auth.getSession();
      await startApp(session);
    };
  }

  function showBlocked(title, text) {
    authShell('<div style="font-size:15px;font-weight:700;color:#1C2B4B;margin-bottom:8px">' + esc(title) + '</div><div style="font-size:13px;color:#6B7280;margin-bottom:16px">' + esc(text) + '</div><button id="authBack" style="' + btnCss + '">Back to sign in</button>');
    $('authBack').onclick = async () => { await M.sb.auth.signOut(); showLogin(); };
  }
  function hideAuth() { const o = $('msihubAuth'); if (o) o.style.display = 'none'; }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  M.boot = async function () {
    if (!window.supabase || !window.supabase.createClient) { M.toast('Could not load the database library. Check your internet connection and reload.', 'error'); return; }
    M.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    const inviteFlow = /type=(invite|recovery|magiclink|signup)/.test(location.hash);
    M.sb.auth.onAuthStateChange((evt) => { if (evt === 'PASSWORD_RECOVERY') showSetPassword(); });
    try {
      const { data: { session } } = await M.sb.auth.getSession();
      if (!session) { showLogin(); return; }
      if (inviteFlow) { showSetPassword(); return; }
      await startApp(session);
    } catch (e) { fail('Startup', e); showLogin(e.message); }
  };

  async function startApp(session) {
    M.user = session.user;
    const { data: prof, error } = await M.sb.from('profiles').select('*').eq('id', M.user.id).maybeSingle();
    if (error) { fail('Loading your profile', error); return; }
    if (!prof) { showBlocked('Profile not found', 'Your login exists but has no agency profile yet. Ask your admin to check the Supabase Users list.'); return; }
    if (!prof.active) { showBlocked('Account disabled', 'This account has been deactivated. Contact your agency admin.'); return; }
    M.profile = prof;
    window.CURRENT_USER = { id: prof.id, name: prof.full_name, role: prof.role === 'admin' ? 'Admin' : 'Agent', email: prof.email };
    paintUser();
    await M.loadAll();
    hideAuth();
    M.ready = true;
    nav('dashboard', document.querySelector('.nav-item'));
    subscribeRealtime();
  }

  function paintUser() {
    const p = me(); const ini = initials(p.full_name);
    [['sidebarAvatar', ini], ['topbarAvatar', ini], ['sidebarUserName', p.full_name], ['sidebarUserRole', p.role === 'admin' ? 'Admin' : 'Agent']].forEach(([id, v]) => { const el = $(id); if (el) el.textContent = v; });
  }

  window.confirmLogout = async function () {
    const o = $('logoutOverlay'); if (o) o.style.display = 'none';
    try { await M.sb.auth.signOut(); } catch (e) { /* ignore */ }
    location.reload();
  };

  // ------------------------------------------------------------------
  // Loading + mapping into the CRM's arrays
  // ------------------------------------------------------------------
  // What loads at sign-in. Big tables load a "working set" (recent + open records); older leads and
  // per-lead history are fetched on demand (search box, opening a profile). Rows are pulled in pages of 1000.
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
  const TABLES = {
    profiles:     (q) => q.order('full_name'),
    leads:        (q) => q.or('received_at.gte.' + daysAgo(90) + ',status.in.("New Lead","Quoted","Appointment Set")').order('received_at', { ascending: false }),
    customers:    (q) => q.order('created_at', { ascending: false }),
    policies:     (q) => q.order('effective_date', { ascending: false }),
    vehicles:     (q) => q.order('created_at'),
    drivers:      (q) => q.order('is_primary', { ascending: false }),
    claims:       (q) => q.order('claim_date', { ascending: false }),
    sales:        (q) => q.order('created_at', { ascending: false }),
    appointments: (q) => q.gte('starts_at', daysAgo(365)).order('starts_at'),
    notes:        (q) => q.gte('created_at', daysAgo(90)).order('created_at', { ascending: false }),
    quotes:       (q) => q.gte('created_at', daysAgo(180)).order('created_at', { ascending: false }),
    calls:        (q) => q.gte('created_at', daysAgo(90)).order('created_at', { ascending: false }),
    messages:     (q) => q.gte('created_at', daysAgo(90)).order('created_at'),
    templates:    (q) => q.order('sort_order'),
    files:        (q) => q.order('created_at', { ascending: false }),
    tasks:        (q) => q.order('due_date').order('id'),
    agency_settings: (q) => q,
  };
  const CAPS = { leads: 20000, customers: 30000, policies: 40000, vehicles: 40000, drivers: 40000, claims: 10000, files: 10000, sales: 20000, appointments: 10000, notes: 10000, quotes: 10000, calls: 10000, messages: 10000, templates: 500, tasks: 5000, agency_settings: 100, profiles: 500 };
  const TABLE_NAME = { calls: 'call_log' };
  const OPTIONAL = new Set(['tasks', 'agency_settings']);   // added by schema-v2.sql
  const PAGE = 1000;
  M.extra = { leads: new Map() };   // leads pulled in by search / direct open, kept across reloads

  async function fetchTable(key) {
    const name = TABLE_NAME[key] || key; const cap = CAPS[key] || 5000; const out = [];
    for (let from = 0; from < cap; from += PAGE) {
      const { data, error } = await TABLES[key](M.sb.from(name).select('*')).range(from, Math.min(from + PAGE - 1, cap - 1));
      if (error) {
        if (OPTIONAL.has(key) && /does not exist|schema cache|not found/i.test(error.message)) { M.missingTables.add(name); return []; }
        throw new Error(name + ': ' + error.message);
      }
      (data || []).forEach((r) => out.push(r));
      if (!data || data.length < PAGE) break;
    }
    return out;
  }
  function mergeExtras(key, rows) {
    const extra = M.extra[key]; if (!extra || !extra.size) return rows;
    const ids = new Set(rows.map((r) => r.id)); extra.forEach((r, id) => { if (!ids.has(id)) rows.push(r); }); return rows;
  }

  M.loadAll = async function () {
    const keys = Object.keys(TABLES);
    try {
      const results = await Promise.all(keys.map(fetchTable));
      keys.forEach((k, i) => { M.data[k] = mergeExtras(k, results[i]); });
    } catch (e) { fail('Loading data', e); }
    remapAll();
    if (M.missingTables.size && isAdmin()) M.toast('Tasks & Settings are not synced yet — run supabase/schema-v2.sql in the Supabase SQL Editor.', 'warn');
  };

  M.reload = async function (keys) {
    try {
      const results = await Promise.all(keys.map(fetchTable));
      keys.forEach((k, i) => { M.data[k] = mergeExtras(k, results[i]); });
    } catch (e) { fail('Refreshing data', e); }
    remapAll();
  };

  // ---- On-demand: search older leads in the database, open a lead that is not in the working set,
  //      and pull a lead's full history when its profile opens.
  const searched = new Set();
  M.searchLeads = async function (q) {
    const term = String(q || '').trim(); if (term.length < 3) return 0;
    const key = term.toLowerCase(); if (searched.has(key)) return 0; searched.add(key);
    const digits = term.replace(/\D/g, ''); const like = '%' + term.replace(/[%_,()]/g, ' ') + '%';
    const ors = ['first_name.ilike.' + like, 'last_name.ilike.' + like, 'email.ilike.' + like];
    if (digits.length >= 4) ors.push('phone.ilike.%' + digits.slice(0, 3) + '%' + digits.slice(3, 6) + '%' + digits.slice(6) + '%');
    if (term.includes(' ')) { const [a, b] = term.split(/\s+/); ors.push('and(first_name.ilike.' + a + '%,last_name.ilike.' + b + '%)'); }
    const { data, error } = await M.sb.from('leads').select('*').or(ors.join(',')).order('received_at', { ascending: false }).limit(200);
    if (error) { console.warn('[MSIHub] search', error); return 0; }
    let added = 0; const have = new Set(M.data.leads.map((l) => l.id));
    (data || []).forEach((r) => { if (!have.has(r.id)) { M.extra.leads.set(r.id, r); M.data.leads.push(r); added++; } });
    if (added) mapLeads();
    return added;
  };
  const _refreshLeads = window.refreshLeads;
  const searchLater = debounce(async () => { const q = (window.LEADS_STATE || {}).search || ''; const n = await M.searchLeads(q); if (n && window.CURRENT_PAGE === 'leads') _refreshLeads(); }, 450);
  window.refreshLeads = function () { const r = _refreshLeads.apply(this, arguments); const q = (window.LEADS_STATE || {}).search || ''; if (q.trim().length >= 3) searchLater(); return r; };

  M.fetchLead = async function (id) {
    const { data, error } = await M.sb.from('leads').select('*').eq('id', id).maybeSingle();
    if (error || !data) return null;
    if (!M.data.leads.find((l) => l.id === id)) { M.extra.leads.set(id, data); M.data.leads.push(data); mapLeads(); }
    return leadById(id);
  };
  const historyLoaded = new Set();
  M.ensureLeadHistory = async function (id) {
    if (historyLoaded.has(id)) return false; historyLoaded.add(id);
    const pull = (key, table) => M.sb.from(table).select('*').eq('lead_id', id).order('created_at').then(({ data }) => { const have = new Set(M.data[key].map((r) => r.id)); let n = 0; (data || []).forEach((r) => { if (!have.has(r.id)) { M.data[key].push(r); n++; } }); return n; });
    const counts = await Promise.all([pull('notes', 'notes'), pull('quotes', 'quotes'), pull('files', 'files'), pull('calls', 'call_log'), pull('messages', 'messages')]);
    const added = counts.reduce((a, b) => a + b, 0);
    if (added) { M.data.notes.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)); mapActivity(); }
    return added > 0;
  };

  function remapAll() {
    mapAgents(); mapLeads(); mapCustomers(); mapSales(); mapAppointments(); mapActivity(); mapTemplates();
    (M.hooks.remap || []).forEach((fn) => { try { fn(); } catch (e) { console.warn('[MSIHub] remap hook failed', e); } });
  }

  function mapAgents() {
    const D = M.data;
    const bySales = {};
    D.sales.forEach((s) => { const a = bySales[s.agent_id] || (bySales[s.agent_id] = { apps: 0, fee: 0, premium: 0 }); a.apps += s.total_policies || 1; a.fee += num(s.fee_collected); a.premium += num(s.premium) + num(s.towing_premium); });
    const leadsBy = {};
    D.leads.forEach((l) => { if (l.agent_id) leadsBy[l.agent_id] = (leadsBy[l.agent_id] || 0) + 1; });
    const soldBy = {};
    D.leads.forEach((l) => { if (l.agent_id && l.status === 'Sold') soldBy[l.agent_id] = (soldBy[l.agent_id] || 0) + 1; });
    const active = D.profiles.filter((p) => p.active);
    const g = (p, k, d) => (p[k] == null ? d : p[k]);
    const rows = active.map((p) => {
      const s = bySales[p.id] || { apps: 0, fee: 0, premium: 0 };
      const lc = leadsBy[p.id] || 0;
      const perms = p.perms || {};
      return { id: p.id, name: p.full_name, email: p.email, role: p.role, apps: s.apps, goal: g(p, 'goal_apps', 15), fee: s.fee, feeGoal: g(p, 'goal_fee', 6000), premium: s.premium,
        tier: p.tier || 'Tier 4', close: (lc ? Math.round((soldBy[p.id] || 0) / lc * 100) : 0) + '%', contact: '0%', leads: lc, rank: 0,
        _role: p.role === 'admin' ? 'Admin' : 'Agent', _agentType: p.agent_type || 'Licensed Producer', _archived: false, _email: p.email, _phone: p.phone || '', _team: p.team || '',
        _startDate: p.start_date || (p.created_at || '').slice(0, 10), _2fa: !!perms.twoFa, _inboundDisabled: !!perms.inboundDisabled, _onboarded: (p.created_at || '').slice(0, 10) };
    }).sort((a, b) => b.apps - a.apps || b.fee - a.fee);
    rows.forEach((r, i) => { r.rank = i + 1; });
    if (typeof AGENTS !== 'undefined') { AGENTS.length = 0; rows.forEach((r) => AGENTS.push(r)); }
    window.AGENT_GOALS = {};
    window.TEAM_MEMBERS = D.profiles.map((p) => {
      const parts = (p.full_name || '').split(' ');
      const perms = p.perms || {};
      window.AGENT_GOALS[p.full_name] = { apps: g(p, 'goal_apps', 15), fee: g(p, 'goal_fee', 6000), premium: g(p, 'goal_premium', 20000), close: g(p, 'goal_close', 25), contact: g(p, 'goal_contact', 55) };
      return { id: p.id, name: p.full_name, first: parts[0] || '', last: parts.slice(1).join(' '), email: p.email, phone: p.phone || '', ext: p.ext || '', role: p.role === 'admin' ? 'Admin' : 'Agent', tier: p.tier || 'Tier 4', team: p.team || '',
        status: p.active ? 'Active' : 'Inactive', startDate: p.start_date || (p.created_at || '').slice(0, 10),
        goalApps: g(p, 'goal_apps', 15), goalFee: g(p, 'goal_fee', 6000), goalPremium: g(p, 'goal_premium', 20000), goalClose: g(p, 'goal_close', 25), goalContact: g(p, 'goal_contact', 55),
        permViewAll: perms.viewAll != null ? !!perms.viewAll : p.role === 'admin', permReports: perms.reports != null ? !!perms.reports : p.role === 'admin', permPayments: perms.payments != null ? !!perms.payments : true,
        permManage: perms.manage != null ? !!perms.manage : p.role === 'admin', permAddRemove: perms.addRemove != null ? !!perms.addRemove : p.role === 'admin' };
    });
  }

  function mapLeads() {
    const D = M.data;
    const calls = {}, texts = {};
    D.calls.forEach((c) => { if (c.lead_id) calls[c.lead_id] = (calls[c.lead_id] || 0) + 1; });
    D.messages.forEach((m) => { if (m.lead_id && m.direction === 'outbound') texts[m.lead_id] = (texts[m.lead_id] || 0) + 1; });
    const rows = D.leads.map((r) => ({
      id: r.id, first: r.first_name || '', last: r.last_name || '', name: fullName(r) || '(no name)',
      phone: fmtPhone(r.phone), email: r.email || '', status: r.status || 'New Lead', disposition: r.disposition || '',
      policy: r.policy_type || 'Auto', source: r.source || '', agent: r.agent_id ? agentName(r.agent_id) : 'Unassigned', agent_id: r.agent_id,
      received: (r.received_at || r.created_at || '').slice(0, 10), receivedAt: r.received_at, fee: num(r.fee),
      attempts: { calls: calls[r.id] || 0, texts: texts[r.id] || 0 },
      sr22: !!r.sr22, language: r.language || 'English', priorCoverage: r.prior_coverage || '', bestTime: r.best_time || '',
      leadScore: r.lead_score == null ? 70 : r.lead_score, doNotCall: !!r.do_not_call, details: r.details || {}, createdAt: r.created_at,
    }));
    LEADS.length = 0; rows.forEach((l) => LEADS.push(l));
  }

  function mapPolicy(p) {
    return { id: p.id, line: p.line || 'Auto', carrier: p.carrier || '', number: p.policy_number || '', soldBy: agentName(p.sold_by_id), sold_by_id: p.sold_by_id,
      effective: p.effective_date || '', expires: p.expires_date || '', premium: num(p.premium), towingPremium: num(p.towing_premium),
      feeTotal: num(p.fee_total), feeCollected: num(p.fee_collected), feeExtended: num(p.fee_extended), hccCollected: !!p.hcc_collected,
      status: p.status || 'Active', saleId: p.sale_id, customer_id: p.customer_id };
  }

  function mapCustomers() {
    const D = M.data;
    const group = (arr, key) => { const o = {}; arr.forEach((x) => { (o[x[key]] || (o[x[key]] = [])).push(x); }); return o; };
    const pol = group(D.policies, 'customer_id'), veh = group(D.vehicles, 'customer_id'), drv = group(D.drivers, 'customer_id'), clm = group(D.claims, 'customer_id'), fil = group(D.files, 'customer_id');
    const rows = D.customers.map((r) => {
      const policies = (pol[r.id] || []).map(mapPolicy);
      const activePol = policies.find((p) => p.status === 'Active') || policies[0] || {};
      const dobUS = isoToUS(r.dob);
      return {
        id: r.id, custNo: r.customer_no, lead_id: r.lead_id, first: r.first_name || '', last: r.last_name || '',
        phone: fmtPhone(r.phone), email: r.email || '', dob: dobUS, age: ageFrom(r.dob), gender: r.gender || '', marital: r.marital || '', license: r.license || '',
        address: r.address || '', city: r.city || '', state: r.state || 'CA', zip: r.zip || '',
        status: r.status || 'Active', carrier: activePol.carrier || '', policyNumber: activePol.number || '',
        agent: agentName(r.agent_id), agent_id: r.agent_id, soldBy: agentName(r.sold_by_id), sold_by_id: r.sold_by_id,
        customerSince: r.customer_since || '', language: r.language || 'English', commPref: r.comm_pref || '', preferredContactTime: r.preferred_contact_time || '',
        paymentMethod: r.payment_method || '', autopay: !!r.autopay, paperless: !!r.paperless,
        riskScore: r.risk_score == null ? 70 : r.risk_score, sr22: !!r.sr22, claimsLast5yr: r.claims_last_5yr || 0, ticketsLast3yr: r.tickets_last_3yr || 0,
        referredBy: r.referred_by || '', referralsGiven: r.referrals_given || 0, crossSell: r.cross_sell || [],
        birthday: dobUS ? dobUS.slice(0, 5) : '', anniversary: r.customer_since || '',
        vehicles: (veh[r.id] || []).map((v) => ({ id: v.id, year: v.year, make: v.make || '', model: v.model || '', vin: v.vin || '', use: v.use || '', garaging: v.garaging || '', value: num(v.value), lien: v.lien || '' })),
        drivers: (drv[r.id] || []).map((d) => ({ id: d.id, name: d.name, dob: isoToUS(d.dob), gender: d.gender || '', license: d.license || '', violations: d.violations || '', primary: !!d.is_primary })),
        files: (fil[r.id] || []).map((f) => f.filename),
        claims: (clm[r.id] || []).map((c) => ({ id: c.id, date: c.claim_date || '', type: c.type || '', amount: num(c.amount), status: c.status || '', desc: c.description || '' })),
        policies,
      };
    });
    CUSTOMERS.length = 0; rows.forEach((c) => CUSTOMERS.push(c));
  }

  function mapSales() {
    window.SALES = M.data.sales.map((s) => {
      const lead = M.data.leads.find((l) => l.id === s.lead_id);
      const cust = M.data.customers.find((c) => c.id === s.customer_id);
      return { id: s.id, date: s.sale_date, timestamp: s.created_at, agentName: agentName(s.agent_id), agent_id: s.agent_id,
        carrier: s.carrier || '', policyType: s.policy_type || '', policyNum: s.policy_number || '',
        feeTotal: num(s.fee_total), feeCollected: num(s.fee_collected), feeExtended: num(s.fee_extended), premium: num(s.premium), towingPremium: num(s.towing_premium), towingPrem: num(s.towing_premium),
        effDate: s.effective_date || '', additionalPolicies: s.additional_policies || [], totalPolicies: s.total_policies || 1,
        leadName: lead ? fullName(lead) : (cust ? fullName(cust) : ''), lead_id: s.lead_id, customer_id: s.customer_id };
    });
  }

  function mapAppointments() {
    const rows = M.data.appointments.map((a) => {
      const d = new Date(a.starts_at);
      const lead = M.data.leads.find((l) => l.id === a.lead_id);
      const calls = lead ? M.data.calls.filter((c) => c.lead_id === lead.id).length : 0;
      const texts = lead ? M.data.messages.filter((m) => m.lead_id === lead.id).length : 0;
      const lastTouch = lead ? [...M.data.calls.filter((c) => c.lead_id === lead.id), ...M.data.messages.filter((m) => m.lead_id === lead.id)].map((x) => new Date(x.created_at)).sort((x, y) => y - x)[0] : null;
      return { id: a.id, date: localISODate(d), time: fmt12(String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')), startsAt: a.starts_at, dur: a.duration_min || 30,
        lead: a.contact_name || (lead ? fullName(lead) : ''), phone: fmtPhone(a.phone), agent: agentName(a.agent_id), agent_id: a.agent_id,
        status: a.status || 'New', calls, texts, daysSinceContact: lastTouch ? Math.floor((Date.now() - lastTouch) / 86400000) : 0,
        sold: !!a.sold, type: a.type || '', notes: a.notes || '', quotedCarrier: a.quoted_carrier || '', quotedPremium: num(a.quoted_premium), quotedFee: num(a.quoted_fee), quotedDown: num(a.quoted_down),
        lead_id: a.lead_id, customer_id: a.customer_id };
    });
    APPOINTMENTS.length = 0; rows.forEach((a) => APPOINTMENTS.push(a));
  }

  function mapActivity() {
    const D = M.data;
    window.CALL_LOG = D.calls.map((c) => ({ id: c.id, date: (c.created_at || '').slice(0, 10), timestamp: c.created_at, agentName: agentName(c.agent_id), agent_id: c.agent_id,
      leadName: c.contact_name || '', phone: fmtPhone(c.phone), direction: c.direction, missed: !!c.missed, duration: c.duration_sec || 0, lead_id: c.lead_id, customer_id: c.customer_id }));
    window.TEXT_LOG = D.messages.map((m) => ({ id: m.id, date: (m.created_at || '').slice(0, 10), timestamp: m.created_at, agentName: agentName(m.agent_id), agent_id: m.agent_id,
      leadName: m.contact_name || '', phone: fmtPhone(m.phone), direction: m.direction, content: m.body, lead_id: m.lead_id, customer_id: m.customer_id }));
    const conv = {}, threads = {};
    D.messages.forEach((m) => {
      const phone = fmtPhone(m.phone);
      const day = fmtDay(m.created_at);
      const days = conv[phone] || (conv[phone] = []);
      let bucket = days.find((d) => d.date === day);
      if (!bucket) { bucket = { date: day, msgs: [] }; days.push(bucket); }
      bucket.msgs.push({ from: m.direction === 'outbound' ? 'us' : 'them', time: fmtTime(m.created_at), author: m.direction === 'outbound' ? agentName(m.agent_id) : '', text: m.body });
      const t = threads[phone] || (threads[phone] = { contact: m.contact_name || phone, phone, agent: agentName(m.agent_id), messages: [] });
      if (m.contact_name) t.contact = m.contact_name;
      t.messages.push({ direction: m.direction, text: m.body, time: fmtTime(m.created_at), read: true });
    });
    window.CONVERSATIONS = conv; window.TEXT_THREADS = threads;
  }

  function mapTemplates() {
    window.TEMPLATES = M.data.templates.map((t) => ({ id: t.id, emoji: t.emoji || '💬', name: t.name, text: t.body }));
  }

  // ------------------------------------------------------------------
  // Realtime: keep every agent's screen current
  // ------------------------------------------------------------------
  const RT = { leads: ['leads'], customers: ['customers'], policies: ['policies'], sales: ['sales'], appointments: ['appointments'], notes: ['notes'], call_log: ['calls'], messages: ['messages'], tasks: ['tasks'], agency_settings: ['agency_settings'], profiles: ['profiles'] };
  const pending = new Set();
  const flush = debounce(async () => {
    const keys = [...pending]; pending.clear();
    await M.reload(keys);
    refreshCurrentPage();
  }, 500);

  function subscribeRealtime() {
    try {
      const ch = M.sb.channel('msihub-live');
      Object.keys(RT).forEach((table) => {
        ch.on('postgres_changes', { event: '*', schema: 'public', table }, (payload) => {
          RT[table].forEach((k) => pending.add(k));
          if (table === 'leads') pending.add('leads');
          if (table === 'leads' && payload.eventType === 'INSERT' && payload.new && payload.new.created_by !== myId() && typeof showNewLeadAlert === 'function') {
            showNewLeadAlert({ name: fullName(payload.new), phone: fmtPhone(payload.new.phone), source: payload.new.source || '—', type: 'New Lead', coverage: payload.new.policy_type || 'Auto' });
          }
          if (table === 'messages' && payload.eventType === 'INSERT' && payload.new && payload.new.direction === 'inbound' && typeof showTextPopup === 'function') {
            showTextPopup(payload.new.contact_name || fmtPhone(payload.new.phone), fmtPhone(payload.new.phone), payload.new.body);
          }
          flush();
        });
      });
      ch.subscribe();
    } catch (e) { console.warn('[MSIHub] realtime unavailable', e); }
  }

  function refreshCurrentPage() {
    const p = window.CURRENT_PAGE;
    try {
      if (p === 'leads' && typeof refreshLeads === 'function') refreshLeads();
      else if (p === 'customers' && typeof refreshCustomers === 'function') refreshCustomers();
      else if (p === 'dashboard' && typeof refreshDashboard === 'function') refreshDashboard();
      else if (p === 'calendar' && typeof refreshCalendar === 'function') refreshCalendar();
      else if (p === 'leaddetail' && window.PAGE_INIT && PAGE_INIT.leaddetail) PAGE_INIT.leaddetail();
      else if (p === 'customerdetail' && window.PAGE_INIT && PAGE_INIT.customerdetail) PAGE_INIT.customerdetail();
      else if (p === 'tasks' && typeof refreshTasksPage === 'function') refreshTasksPage();
      else if (p === 'admin' && typeof refreshAdminPage === 'function') refreshAdminPage();
      else if (p === 'agency' && typeof renderAgencyPage === 'function') renderAgencyPage();
      else if (p === 'reports' && typeof refreshReports === 'function') refreshReports();
      else if (p === 'liveview' && typeof refreshLiveView === 'function') refreshLiveView();
      else if (p === 'inbox' && typeof refreshInbox === 'function') refreshInbox();
    } catch (e) { console.warn('[MSIHub] refresh failed', e); }
  }
  M.refreshCurrentPage = refreshCurrentPage;

  // ------------------------------------------------------------------
  // Generic DB write helpers
  // ------------------------------------------------------------------
  async function insert(table, row) { const { data, error } = await M.sb.from(table).insert(row).select().single(); if (error) throw error; return data; }
  async function update(table, id, patch) { const { data, error } = await M.sb.from(table).update(patch).eq('id', id).select().single(); if (error) throw error; return data; }
  async function remove(table, id) { const { error } = await M.sb.from(table).delete().eq('id', id); if (error) throw error; }

  // ------------------------------------------------------------------
  // LEADS
  // ------------------------------------------------------------------
  window.openLeadDetail = async function (id) {
    let l = leadById(id);
    if (!l) { l = await M.fetchLead(id); }
    if (!l) { M.toast('Lead not found', 'error'); return; }
    M.currentLeadId = id; window._currentLeadName = l.name;
    nav('leaddetail', document.querySelector('.nav-item[onclick*="leads"]'));
  };
  window.leadCall = function (id) { const l = leadById(id); if (l) doCall(l.name, l.phone, l); };
  window.leadText = function (id) { const l = leadById(id); if (l) { M.currentLeadId = id; window._currentLeadName = l.name; openTextThread(l.name, l.phone); } };

  window.onColDrop = async function (ev, newStatus) {
    ev.preventDefault();
    const phone = window._dragPhone || (ev.dataTransfer && ev.dataTransfer.getData('text/plain'));
    window._dragPhone = null;
    if (!phone) return;
    const lead = LEADS.find((l) => l.phone === phone);
    if (!lead || lead.status === newStatus) { refreshLeads(); return; }
    const prev = lead.status; lead.status = newStatus; refreshLeads();
    try { await update('leads', lead.id, { status: newStatus }); } catch (e) { lead.status = prev; refreshLeads(); fail('Updating lead', e); }
  };

  window.setDisposition = async function (value) {
    if (!value) return;
    const lead = M.currentLead(); if (!lead) return;
    const patch = { disposition: value };
    if (value === 'Bad Lead') patch.status = 'Bad Lead';
    if (value === 'Already Sold') patch.status = 'Sold';
    if (value === 'Quoted' && lead.status === 'New Lead') patch.status = 'Quoted';
    if (value === 'Do Not Call') patch.do_not_call = true;
    try {
      await update('leads', lead.id, patch);
      Object.assign(lead, { disposition: value }, patch.status ? { status: patch.status } : {}, patch.do_not_call ? { doNotCall: true } : {});
      M.toast('Disposition set to ' + value + ((patch.status === 'Bad Lead' || patch.status === 'Sold') ? ' — removed from the lead list' : ''));
      if (patch.status === 'Bad Lead' || patch.status === 'Sold') setTimeout(() => nav('leads', document.querySelector('[onclick*="leads"]')), 250);
      else PAGE_INIT.leaddetail();
    } catch (e) { fail('Saving disposition', e); }
  };

  M.assignLead = async function (leadId, agentId) {
    const lead = leadById(leadId); if (!lead) return;
    try {
      await update('leads', leadId, { agent_id: agentId || null });
      lead.agent_id = agentId || null; lead.agent = agentId ? agentName(agentId) : 'Unassigned';
      M.toast(agentId ? 'Assigned to ' + lead.agent : 'Lead unassigned');
      if (window.CURRENT_PAGE === 'leaddetail') PAGE_INIT.leaddetail();
    } catch (e) { fail('Assigning lead', e); }
  };

  // ---- Add / edit lead form ----
  const LEAD_SOURCES = ['Everquote', 'Facebook Ads', 'Google Ads', 'Referral', 'Direct Call', 'Cold Call', 'Walk-In', 'Website', 'Other'];
  const LEAD_STATUSES = ['New Lead', 'Contacted', 'Quoted', 'Appointment Set', 'Sold', 'Bad Lead'];
  function opt(list, sel) { return list.map((x) => '<option' + (x === sel ? ' selected' : '') + '>' + esc(x) + '</option>').join(''); }
  function fg(label, inner, span) { return '<div class="form-group"' + (span ? ' style="grid-column:span 2"' : '') + '><div class="form-label">' + label + '</div>' + inner + '</div>'; }
  function inp(id, val, ph, type) { return '<input id="' + id + '" type="' + (type || 'text') + '" class="form-control" value="' + esc(val || '') + '" placeholder="' + esc(ph || '') + '">'; }

  window.openLeadForm = function (id) {
    const L = id ? leadById(id) : null; const d = (L && L.details) || {}; const v = d.vehicle || {}; const cov = d.coverage || {};
    let o = $('leadFormOverlay');
    if (!o) { o = document.createElement('div'); o.id = 'leadFormOverlay'; o.className = 'logout-overlay'; o.style.zIndex = '10002'; o.onclick = (e) => { if (e.target === o) o.style.display = 'none'; }; document.body.appendChild(o); }
    const agentOpts = '<option value="">Unassigned</option>' + M.agents().map((p) => '<option value="' + p.id + '"' + (L && L.agent_id === p.id ? ' selected' : '') + '>' + esc(p.full_name) + '</option>').join('');
    o.innerHTML = '<div class="logout-modal" style="width:720px;max-width:96vw;text-align:left;max-height:92vh;overflow-y:auto" onclick="event.stopPropagation()">' +
      '<h2 style="margin:0 0 4px">' + (L ? 'Edit Lead' : 'New Lead') + '</h2><p style="margin:0 0 14px;font-size:12.5px;color:var(--gray-500)">' + (L ? 'Update the lead record. Changes save for the whole team.' : 'Enter what you have — you can fill in the rest later.') + '</p>' +
      '<div class="form-grid" style="grid-template-columns:1fr 1fr;gap:10px 14px">' +
      fg('First Name *', inp('lf_first', L && L.first)) + fg('Last Name', inp('lf_last', L && L.last)) +
      fg('Phone *', inp('lf_phone', L && L.phone, '(619) 555-0100', 'tel')) + fg('Email', inp('lf_email', L && L.email, '', 'email')) +
      fg('Source', '<select id="lf_source" class="form-control">' + opt(LEAD_SOURCES, L ? L.source || 'Other' : 'Everquote') + '</select>') +
      fg('Policy Type', '<select id="lf_policy" class="form-control">' + opt(['Auto', 'Home', 'Renters', 'Commercial', 'Motorcycle', 'Life', 'Bundle'], L ? L.policy : 'Auto') + '</select>') +
      fg('Status', '<select id="lf_status" class="form-control">' + opt(LEAD_STATUSES, L ? L.status : 'New Lead') + '</select>') +
      fg('Assigned Agent', '<select id="lf_agent" class="form-control">' + agentOpts + '</select>') +
      fg('Language', '<select id="lf_lang" class="form-control">' + opt(['English', 'Spanish', 'Other'], L ? L.language : 'English') + '</select>') +
      fg('Best Time to Call', '<select id="lf_best" class="form-control">' + opt(['', 'Mornings', 'Afternoons', 'Evenings', 'Anytime'], L ? L.bestTime : '') + '</select>') +
      fg('SR-22 Required', '<select id="lf_sr22" class="form-control"><option value="no"' + (L && L.sr22 ? '' : ' selected') + '>No</option><option value="yes"' + (L && L.sr22 ? ' selected' : '') + '>Yes</option></select>') +
      fg('Prior Coverage', inp('lf_prior', L && L.priorCoverage, 'e.g. Geico — current, or None')) +
      fg('Date of Birth', inp('lf_dob', d.dob || '', 'MM/DD/YYYY')) + fg('Gender', '<select id="lf_gender" class="form-control">' + opt(['', 'Female', 'Male', 'Other'], d.gender || '') + '</select>') +
      fg('Marital Status', '<select id="lf_marital" class="form-control">' + opt(['', 'Single', 'Married', 'Divorced', 'Widowed'], d.marital || '') + '</select>') + fg('License #', inp('lf_license', d.license || '')) +
      fg('Address', inp('lf_address', d.address || '', 'Street'), true) +
      fg('City', inp('lf_city', d.city || '')) + fg('ZIP', inp('lf_zip', d.zip || '')) +
      fg('Vehicle Year', inp('lf_vyear', v.year || '')) + fg('Make', inp('lf_vmake', v.make || '')) + fg('Model', inp('lf_vmodel', v.model || '')) + fg('VIN', inp('lf_vin', v.vin || '')) +
      fg('Coverage Requested', inp('lf_covtype', cov.type || '', 'e.g. Liability + UM/UIM')) + fg('Limits', inp('lf_covlimits', cov.limits || '', 'e.g. 50/100')) +
      fg('Violations', inp('lf_violations', d.violations || '', 'e.g. None'), true) +
      (L ? '' : fg('First Note (optional)', '<textarea id="lf_note" class="form-control" rows="2"></textarea>', true)) +
      '</div><div style="display:flex;gap:8px;margin-top:16px"><button class="btn btn-primary" style="flex:1;justify-content:center" onclick="saveLeadForm(' + (L ? "'" + L.id + "'" : 'null') + ')">' + (L ? 'Save Changes' : 'Create Lead') + '</button><button class="btn btn-ghost" style="flex:1;justify-content:center" onclick="document.getElementById(\'leadFormOverlay\').style.display=\'none\'">Cancel</button></div></div>';
    o.style.display = 'flex';
    setTimeout(() => { const el = $('lf_first'); if (el) el.focus(); }, 40);
  };

  window.saveLeadForm = async function (id) {
    const g = (i) => { const el = $(i); return el ? el.value.trim() : ''; };
    if (!g('lf_first')) { M.toast('First name is required', 'warn'); return; }
    if (!g('lf_phone')) { M.toast('Phone is required', 'warn'); return; }
    const existing = id ? leadById(id) : null;
    const details = Object.assign({}, existing ? existing.details : {}, {
      dob: g('lf_dob'), gender: g('lf_gender'), marital: g('lf_marital'), license: g('lf_license'), address: g('lf_address'), city: g('lf_city'), state: 'CA', zip: g('lf_zip'), violations: g('lf_violations'),
      vehicle: Object.assign({}, existing && existing.details.vehicle, { year: g('lf_vyear'), make: g('lf_vmake'), model: g('lf_vmodel'), vin: g('lf_vin') }),
      coverage: Object.assign({}, existing && existing.details.coverage, { type: g('lf_covtype'), limits: g('lf_covlimits') }),
    });
    const row = { first_name: g('lf_first'), last_name: g('lf_last'), phone: fmtPhone(g('lf_phone')), email: g('lf_email') || null, source: g('lf_source'), policy_type: g('lf_policy'), status: g('lf_status'),
      agent_id: g('lf_agent') || null, language: g('lf_lang'), best_time: g('lf_best') || null, sr22: g('lf_sr22') === 'yes', prior_coverage: g('lf_prior') || null, details };
    try {
      let saved;
      if (id) saved = await update('leads', id, row);
      else { row.created_by = myId(); saved = await insert('leads', row); if (g('lf_note')) await insert('notes', { lead_id: saved.id, author_id: myId(), body: g('lf_note') }); }
      $('leadFormOverlay').style.display = 'none';
      await M.reload(['leads', 'notes']);
      M.toast(id ? 'Lead updated' : 'Lead created');
      if (id) PAGE_INIT.leaddetail(); else openLeadDetail(saved.id);
    } catch (e) { fail('Saving lead', e); }
  };

  // ---- Lead detail page (data-driven) ----
  const field = (label, value, color, mono) => {
    const v = (value == null || value === '') ? '—' : String(value);
    return '<div style="padding:10px 0;border-bottom:1px solid #E5E7EB"><div style="font-size:11.5px;color:#6B7280;font-weight:500;margin-bottom:4px">' + label + '</div><div style="display:flex;align-items:center;gap:8px"><span style="font-size:' + (mono ? '15' : '16') + 'px;font-weight:600;color:' + (color || '#1C2B4B') + (mono ? ';font-family:monospace' : '') + '">' + esc(v) + '</span>' + (v !== '—' ? '<button onclick="copyToClipboard(' + JSON.stringify(v).replace(/"/g, '&quot;') + ',this)" style="background:#F3F4F6;border:1px solid #E5E7EB;border-radius:5px;color:#9CA3AF;cursor:pointer;padding:2px 8px;font-size:11px;font-family:var(--font-body)">📋</button>' : '') + '</div></div>';
  };
  const secHdr = (t) => '<div style="font-size:11px;font-weight:800;color:#fff;text-transform:uppercase;letter-spacing:1px;background:#1C2B4B;padding:9px 14px;border-radius:6px;margin-bottom:14px;margin-top:20px">' + t + '</div>';
  const grid = (inner) => '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 36px;margin-bottom:10px">' + inner + '</div>';
  const barBtn = (onclick, label, style) => '<button onclick="' + onclick + '" style="display:flex;align-items:center;gap:5px;' + (style || 'background:rgba(255,255,255,0.18);color:#fff;border:1px solid rgba(255,255,255,0.28)') + ';border-radius:8px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;font-family:var(--font-body)">' + label + '</button>';

  function leadNotes(L) { return M.data.notes.filter((n) => n.lead_id === L.id); }
  function leadQuotes(L) { return M.data.quotes.filter((q) => q.lead_id === L.id); }
  function leadFiles(L) { return M.data.files.filter((f) => f.lead_id === L.id); }
  function leadCalls(L) { return M.data.calls.filter((c) => c.lead_id === L.id); }
  function leadTexts(L) { return M.data.messages.filter((m) => m.lead_id === L.id || (L.phone && fmtPhone(m.phone) === L.phone)); }

  function notesHTML(list) {
    if (!list.length) return '<div style="font-size:12.5px;color:var(--gray-400);padding:6px 0">No notes yet.</div>';
    return list.map((n) => '<div style="padding:11px 14px;background:var(--gray-50);border-radius:var(--radius-md);border-left:3px solid var(--green-500);margin-bottom:8px"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px"><div style="font-size:12px;font-weight:600;color:var(--navy-900)">' + esc(agentName(n.author_id)) + '</div><div style="font-size:10.5px;color:var(--gray-400)">' + fmtStamp(n.created_at) + '</div></div><div style="font-size:12.5px;color:var(--gray-700);line-height:1.5;white-space:pre-wrap">' + esc(n.body) + '</div></div>').join('');
  }

  function timelineHTML(L) {
    const items = [];
    leadCalls(L).forEach((c) => items.push({ ts: c.created_at, icon: '📞', cls: 'tl-call', title: (c.direction === 'inbound' ? 'Inbound' : 'Outbound') + ' Call — ' + (c.missed ? 'No Answer' : 'Completed') + (c.duration_sec ? ' <span style="font-size:10.5px;font-weight:600;color:var(--green-700);background:var(--green-50);padding:1px 7px;border-radius:var(--radius-full);margin-left:4px">' + Math.floor(c.duration_sec / 60) + 'm ' + (c.duration_sec % 60) + 's</span>' : ''), who: agentName(c.agent_id), text: '' }));
    leadTexts(L).forEach((m) => items.push({ ts: m.created_at, icon: '💬', cls: '', style: 'background:var(--blue-light);border-color:#C3D6E8', title: (m.direction === 'inbound' ? 'Inbound Text — Received' : 'Outbound Text — ' + (m.status === 'failed' ? 'Failed' : 'Sent')), who: m.direction === 'inbound' ? L.name : agentName(m.agent_id), text: '"' + m.body + '"' }));
    leadNotes(L).forEach((n) => items.push({ ts: n.created_at, icon: '📝', cls: 'tl-sys', title: 'Note added', who: agentName(n.author_id), text: n.body }));
    leadQuotes(L).forEach((q) => items.push({ ts: q.created_at, icon: '🧾', cls: 'tl-sys', title: 'Quote — ' + (q.carrier || '') + ' ' + money(q.premium), who: agentName(q.agent_id), text: q.coverage_notes || '' }));
    items.push({ ts: L.createdAt || L.receivedAt, icon: '🔔', cls: 'tl-sys', title: 'Lead Created' + (L.agent_id ? ' &amp; Assigned to ' + esc(L.agent) : ''), who: 'System', text: '' });
    items.sort((a, b) => new Date(b.ts) - new Date(a.ts));
    const calls = leadCalls(L).length, texts = leadTexts(L).filter((m) => m.direction === 'outbound').length;
    const stat = (bg, bd, col, n, label) => '<div style="background:' + bg + ';border:1px solid ' + bd + ';border-radius:var(--radius-md);padding:9px 12px;text-align:center"><div style="font-size:22px;font-weight:800;font-family:var(--font-display);color:' + col + '">' + n + '</div><div style="font-size:11px;font-weight:700;color:' + col + ';margin-top:1px">' + label + '</div></div>';
    return '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px">' + stat('var(--green-50)', 'var(--green-200)', 'var(--green-700)', calls, '📞 Calls') + stat('var(--blue-light)', '#C3D6E8', '#0E2340', texts, '💬 Texts') + stat('var(--gray-50)', 'var(--border)', 'var(--gray-500)', leadNotes(L).length, '📝 Notes') + '</div>' +
      items.map((it) => '<div class="tl-item"><div class="tl-icon ' + it.cls + '"' + (it.style ? ' style="' + it.style + '"' : '') + '>' + it.icon + '</div><div class="tl-body"><div class="tl-title">' + it.title + '</div><div class="tl-meta">' + fmtStamp(it.ts) + ' · <strong>' + esc(it.who) + '</strong></div>' + (it.text ? '<div class="tl-text">' + esc(it.text) + '</div>' : '') + '</div></div>').join('');
  }

  function quotesHTML(L) {
    const qs = leadQuotes(L);
    const list = qs.length ? qs.map((q, i) => '<div style="border:1px solid var(--border);border-radius:var(--radius-md);padding:12px;margin-bottom:10px"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px"><div style="font-weight:700;color:var(--navy-900);font-size:13px">' + esc(q.carrier || 'Quote') + '</div><span class="badge b-quoted" style="font-size:10.5px">Quote #' + (qs.length - i) + '</span></div>' +
      '<div class="fee-row" style="padding:6px 0"><div class="fee-label" style="font-size:12px">Premium</div><div class="fee-val" style="font-size:13px">' + money(q.premium) + '</div></div>' +
      '<div class="fee-row" style="padding:6px 0"><div class="fee-label" style="font-size:12px">Down Payment</div><div class="fee-val" style="font-size:13px">' + money(q.down_payment) + '</div></div>' +
      '<div class="fee-row" style="padding:6px 0"><div class="fee-label" style="font-size:12px">Broker Fee</div><div class="fee-val" style="font-size:13px;color:var(--green-700)">' + money(q.fee) + '</div></div>' +
      (q.coverage_notes ? '<div class="fee-row" style="padding:6px 0"><div class="fee-label" style="font-size:12px">Notes</div><div class="fee-val" style="font-size:12px;font-weight:500">' + esc(q.coverage_notes) + '</div></div>' : '') +
      '<div class="fee-row" style="padding:6px 0;border-bottom:none"><div class="fee-label" style="font-size:12px">Quoted On</div><div class="fee-val" style="font-size:12px;font-weight:500;color:var(--gray-500)">' + fmtStamp(q.created_at) + ' · ' + esc(agentName(q.agent_id)) + '</div></div></div>').join('')
      : '<div style="font-size:12.5px;color:var(--gray-400);padding:4px 0 10px">No quotes yet.</div>';
    const carriers = (window.CARRIER_DATA && window.CARRIER_DATA.length ? window.CARRIER_DATA.map((c) => c.name) : ['Progressive', 'National General', 'Bristol West', 'Mercury', 'Kemper', 'InsureMax']).concat(['Other']);
    return list + '<div id="quoteForm" style="display:none;border:1px dashed var(--border-strong);border-radius:var(--radius-md);padding:14px;background:var(--gray-50)"><div style="font-weight:700;font-size:12px;color:var(--navy-900);margin-bottom:10px">Add Quote Details</div><div class="form-grid" style="grid-template-columns:1fr;gap:10px;margin-bottom:10px">' +
      fg('Carrier', '<select id="q_carrier" class="form-control">' + opt(carriers) + '</select>') + fg('Term', '<select id="q_term" class="form-control"><option>6 Months</option><option>12 Months</option></select>') +
      fg('Total Premium', inp('q_premium', '', '$0.00')) + fg('Down Payment', inp('q_down', '', '$0.00')) + fg('Broker Fee', inp('q_fee', '', '$0.00')) + fg('Deductible', inp('q_deductible', '', '$0.00')) +
      fg('Notes', '<textarea id="q_notes" class="form-control" rows="2" placeholder="Coverage, discounts, etc."></textarea>') +
      '</div><div style="display:flex;gap:8px"><button class="btn btn-primary" style="flex:1;justify-content:center" onclick="saveQuote()">Save Quote</button><button class="btn btn-ghost" style="flex:1;justify-content:center" onclick="document.getElementById(\'quoteForm\').style.display=\'none\'">Cancel</button></div></div>';
  }

  function filesHTML(list) {
    if (!list.length) return '<div style="font-size:12.5px;color:var(--gray-400);padding:4px 0 8px">No files yet.</div>';
    return list.map((f) => '<div class="customer-file" style="display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:var(--radius-md);background:var(--gray-50);border:1px solid var(--border);margin-bottom:7px"><div style="font-size:18px">' + fileIcon(f.filename) + '</div><div style="flex:1;min-width:0"><div style="font-size:12px;font-weight:600;color:var(--navy-900);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(f.filename) + '</div><div style="font-size:10.5px;color:var(--gray-400)">' + (f.size_bytes ? fileSize(f.size_bytes) + ' · ' : '') + fmtStamp(f.created_at) + '</div></div><div class="tbl-icon-btn" title="Download" style="cursor:pointer" onclick="MSIHub.openFile(\'' + f.id + '\')">⬇</div></div>').join('');
  }

  function renderLeadDetailBody(L) {
    const d = L.details || {}, v = d.vehicle || {}, cov = d.coverage || {}, d2 = d.driver2 || null;
    const temp = typeof leadTemperature === 'function' ? leadTemperature(L) : '';
    const tempBadge = temp === 'Hot' ? '<span style="background:rgba(239,68,68,0.30);color:#FCA5A5;border:1px solid rgba(252,165,165,0.40);padding:2px 9px;border-radius:var(--radius-full);font-size:10px;font-weight:800;letter-spacing:0.4px">🔥 HOT LEAD</span>' : temp === 'Warm' ? '<span style="background:rgba(245,158,11,0.28);color:#FCD34D;border:1px solid rgba(252,211,77,0.4);padding:2px 9px;border-radius:var(--radius-full);font-size:10px;font-weight:800">🌤 WARM</span>' : '<span style="background:rgba(148,163,184,0.25);color:#CBD5E1;border:1px solid rgba(203,213,225,0.35);padding:2px 9px;border-radius:var(--radius-full);font-size:10px;font-weight:800">❄️ COLD</span>';
    const age = typeof leadAgeDays === 'function' ? leadAgeDays(L) : 0;
    const dispOpts = ['Quoted', 'Bad Lead', 'Do Not Call', 'Refund', 'HR', 'Already Sold', 'Spanish', 'Rewrite', 'Cancelled', 'Follow Up'];
    const agentOpts = '<option value="" style="color:#1C2B4B"' + (!L.agent_id ? ' selected' : '') + '>Unassigned</option>' + M.agents().map((p) => '<option value="' + p.id + '" style="color:#1C2B4B"' + (L.agent_id === p.id ? ' selected' : '') + '>' + esc(p.full_name) + '</option>').join('');
    const addr = [d.address, d.city, (d.state || 'CA') + (d.zip ? ' ' + d.zip : '')].filter(Boolean).join(', ');
    const stages = ['New Lead', 'Quoted', 'Appointment Set', 'Sold'];
    const idx = Math.max(0, stages.indexOf(L.status === 'Contacted' ? 'New Lead' : L.status));
    const stageHTML = stages.map((st, i) => { const done = i < idx, curr = i === idx; return '<div class="stage-step ' + (done ? 'done' : curr ? 'current' : 'future') + '"><div class="stage-dot" style="background:' + (done ? 'var(--green-500)' : curr ? 'var(--navy-600)' : 'var(--gray-300)') + '"></div><div class="stage-label" style="color:' + (done ? 'var(--green-700)' : curr ? 'var(--navy-900)' : 'var(--gray-400)') + ';font-weight:' + (curr ? '600' : '400') + '">' + st + '</div>' + (curr ? '<span style="margin-left:auto;font-size:10px;background:var(--navy-50);color:var(--navy-600);padding:1px 7px;border-radius:var(--radius-full);font-weight:700">Current</span>' : '') + '</div>'; }).join('');
    const selCss = 'background:transparent;color:#fff;border:none;font-family:var(--font-body);font-size:13px;font-weight:600;cursor:pointer;outline:none;min-width:110px';

    return '<div style="background:linear-gradient(175deg,#0A1624 0%,#122B47 100%);border-radius:var(--radius-xl);padding:16px 24px;display:flex;align-items:center;gap:14px;margin-bottom:14px;flex-wrap:wrap">' +
      '<button onclick="nav(\'leads\',document.querySelector(\'[onclick*=leads]\'))" style="background:rgba(255,255,255,0.15);color:#fff;border:1px solid rgba(255,255,255,0.28);border-radius:var(--radius-md);padding:7px 13px;font-size:12px;font-weight:600;cursor:pointer;font-family:var(--font-body);white-space:nowrap;flex-shrink:0">← All Leads</button>' +
      '<div style="flex:1;min-width:180px"><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span style="font-size:20px;font-weight:700;color:#fff">' + esc(L.name) + '</span>' + tempBadge + '<span class="badge ' + (typeof statusBadge === 'function' ? statusBadge(L.status) : '') + '" style="font-size:11px;padding:3px 11px">' + esc(L.status) + '</span>' + (L.doNotCall ? '<span style="background:#DC2626;color:#fff;padding:2px 9px;border-radius:var(--radius-full);font-size:10px;font-weight:800">DO NOT CALL</span>' : '') + '</div>' +
      '<div style="font-size:11px;color:rgba(255,255,255,0.55);margin-top:3px">Source: ' + esc(L.source || '—') + ' &middot; Received ' + (age === 0 ? 'today' : age + ' day' + (age === 1 ? '' : 's') + ' ago') + ' &middot; ' + esc(L.policy) + ' &middot; ' + esc(L.phone) + (L.email ? ' &middot; ' + esc(L.email) : '') + '</div></div>' +
      '<div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;flex-shrink:0">' +
      barBtn('leadCall(\'' + L.id + '\')', '📞 Call', 'background:#2563EB;color:#fff;border:none') +
      barBtn('leadText(\'' + L.id + '\')', '💬 Text') +
      (L.email ? barBtn('window.location.href=\'mailto:' + esc(L.email) + '\'', '✉️ Email') : '') +
      barBtn('openAppointment()', '📅 Appt') +
      barBtn('openNewSale()', '🎉 Sale', 'background:linear-gradient(135deg,var(--green-500),var(--green-700));color:#fff;border:none;font-weight:700') +
      barBtn('openQuoteExport(\'lead\')', '📤 Export') +
      barBtn('openLeadForm(\'' + L.id + '\')', '✏️ Edit') +
      '<div style="display:flex;align-items:center;gap:6px;background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.22);border-radius:8px;padding:5px 10px"><span style="font-size:10px;font-weight:700;color:rgba(255,255,255,0.65);text-transform:uppercase;letter-spacing:0.5px">Agent</span><select style="' + selCss + '" onchange="MSIHub.assignLead(\'' + L.id + '\',this.value)">' + agentOpts + '</select></div>' +
      '<div style="display:flex;align-items:center;gap:6px;background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.22);border-radius:8px;padding:5px 10px"><span style="font-size:10px;font-weight:700;color:rgba(255,255,255,0.65);text-transform:uppercase;letter-spacing:0.5px">Disp</span><select id="dispositionSelect" style="' + selCss + '" onchange="setDisposition(this.value)"><option value="" style="color:#1C2B4B">— Select —</option>' + dispOpts.map((x) => '<option style="color:#1C2B4B"' + (L.disposition === x ? ' selected' : '') + '>' + x + '</option>').join('') + '</select></div>' +
      '</div></div>' +

      '<div style="background:#fff;border-radius:var(--radius-xl);padding:22px 28px;margin-bottom:14px;border:1px solid #E5E7EB;box-shadow:0 1px 4px rgba(0,0,0,0.05)">' +
      secHdr('Primary Driver').replace('margin-top:20px', 'margin-top:0') +
      grid(field('First Name', L.first) + field('Last Name', L.last) + field('Date of Birth', d.dob) + field('Gender', d.gender) + field('Phone', L.phone) + field('Email', L.email) + field('Marital Status', d.marital) + field('Language', L.language) + field('License #', d.license) + field('Violations', d.violations, d.violations && !/none|clean/i.test(d.violations) ? '#B45309' : '#16A34A') + field('SR-22 Required', L.sr22 ? 'Yes' : 'No', L.sr22 ? '#DC2626' : '#16A34A') + field('Best Time to Call', L.bestTime) + '<div style="grid-column:span 2">' + field('Address', addr) + '</div>') +
      (d2 ? secHdr('Driver 2 — Additional') + grid(field('Name', d2.name) + field('Date of Birth', d2.dob) + field('Gender', d2.gender) + field('License #', d2.license) + field('Violations', d2.violations) + field('SR-22 Required', d2.sr22 ? 'Yes' : 'No')) : '') +
      secHdr('Vehicle') + grid(field('Year', v.year) + field('Make', v.make) + field('Model', v.model) + field('VIN', v.vin, null, true) + field('Annual Mileage', v.mileage) + field('Primary Use', v.use)) +
      secHdr('Coverage Requested') + grid(field('Policy Type', L.policy) + field('Coverage Type', cov.type) + field('Limits', cov.limits) + field('Prior Coverage', L.priorCoverage) + field('Lead Score', L.leadScore) + field('Disposition', L.disposition)) +
      '</div>' +

      '<div class="ld-layout"><div>' +
      '<div class="card" style="margin-bottom:14px"><div class="card-header"><div class="card-title">Notes</div><button class="btn btn-primary" style="font-size:11.5px" onclick="addNote()">+ Add Note</button></div><div class="card-body"><textarea id="noteInput" class="form-control" placeholder="Add a quick note about this lead… (visible to the team)" rows="3" style="width:100%;resize:vertical;font-family:var(--font-body);font-size:13px;margin-bottom:12px"></textarea><div id="notesList">' + notesHTML(leadNotes(L)) + '</div></div></div>' +
      '<div class="card"><div class="card-header"><div class="card-title">Activity Timeline</div></div><div class="card-body" id="leadTimeline">' + timelineHTML(L) + '</div></div>' +
      '</div><div>' +
      '<div class="card" style="margin-bottom:14px"><div class="card-header"><div class="card-title">Pipeline Stage</div></div><div class="card-body">' + stageHTML + '</div></div>' +
      '<div class="card" style="margin-bottom:14px"><div class="card-header"><div class="card-title">Quoted</div><button class="btn btn-ghost" style="font-size:11.5px" onclick="addQuote()">+ Add Quote</button></div><div class="card-body" id="quotesList">' + quotesHTML(L) + '</div></div>' +
      '<div class="card"><div class="card-header" style="background:#1C2B4B;border-radius:var(--radius-lg) var(--radius-lg) 0 0"><div class="card-title" style="color:#fff">Customer Files</div></div><div class="card-body"><div id="customerFilesList">' + filesHTML(leadFiles(L)) + '</div>' +
      '<div id="customerFileDrop" style="border:2px dashed var(--border-strong);border-radius:var(--radius-md);padding:14px;text-align:center;cursor:pointer;margin-top:10px;transition:all 0.15s" onclick="document.getElementById(\'customerFileInput\').click()" ondragover="event.preventDefault();this.style.borderColor=\'var(--green-500)\';this.style.background=\'var(--green-50)\'" ondragleave="this.style.borderColor=\'var(--border-strong)\';this.style.background=\'\'" ondrop="event.preventDefault();this.style.borderColor=\'var(--border-strong)\';this.style.background=\'\';handleCustomerFiles(event.dataTransfer.files)"><div style="font-size:20px;margin-bottom:2px">📎</div><div style="font-size:12px;font-weight:600;color:var(--navy-900)">Add Files</div><div style="font-size:10.5px;color:var(--gray-400);margin-top:2px">Click or drag &amp; drop · saved securely to the agency file store</div></div>' +
      '<input id="customerFileInput" type="file" multiple style="display:none" onchange="handleCustomerFiles(this.files)"></div></div>' +
      '</div></div>';
  }

  window.PAGE_INIT = window.PAGE_INIT || {};
  PAGE_INIT.leaddetail = function () {
    const L = M.currentLead();
    const body = $('leadDetailBody');
    if (!L) { nav('leads', document.querySelector('[onclick*="leads"]')); return; }
    if (!body) return;
    window._currentLeadName = L.name;
    body.innerHTML = renderLeadDetailBody(L);
    const t = $('page-title'); if (t) t.textContent = 'Lead Detail — ' + L.name;
    const lbl = $('apptLeadNameLabel'); if (lbl) lbl.textContent = L.name;
    const prod = $('nsProd');
    if (prod) { const cur = prod.value; prod.innerHTML = M.agents().map((p) => '<option' + (p.full_name === (cur || me().full_name) ? ' selected' : '') + '>' + esc(p.full_name) + '</option>').join(''); }
    // Older notes/quotes/files/calls/texts are not in the sign-in working set: fetch this lead's history and re-render once.
    M.ensureLeadHistory(L.id).then((added) => { if (added && M.currentLeadId === L.id && window.CURRENT_PAGE === 'leaddetail') PAGE_INIT.leaddetail(); });
  };

  // ---- Notes / quotes / files on the lead page ----
  window.addNote = async function () {
    const input = $('noteInput'); const L = M.currentLead();
    if (!input || !input.value.trim()) { M.toast('Type a note first.', 'warn'); return; }
    if (!L) return;
    try {
      const n = await insert('notes', { lead_id: L.id, author_id: myId(), body: input.value.trim() });
      M.data.notes.unshift(n); input.value = '';
      const list = $('notesList'); if (list) list.innerHTML = notesHTML(leadNotes(L));
      const tl = $('leadTimeline'); if (tl) tl.innerHTML = timelineHTML(L);
    } catch (e) { fail('Saving note', e); }
  };

  window.saveQuote = async function () {
    const L = M.currentLead(); if (!L) return;
    const g = (i) => { const el = $(i); return el ? el.value.trim() : ''; };
    if (!num(g('q_premium'))) { M.toast('Enter the total premium.', 'warn'); return; }
    try {
      const q = await insert('quotes', { lead_id: L.id, agent_id: myId(), carrier: g('q_carrier'), premium: num(g('q_premium')), down_payment: num(g('q_down')), fee: num(g('q_fee')), deductible: num(g('q_deductible')), coverage_notes: [g('q_term'), g('q_notes')].filter(Boolean).join(' · ') });
      M.data.quotes.unshift(q);
      if (L.status === 'New Lead' || L.status === 'Contacted') { await update('leads', L.id, { status: 'Quoted', fee: num(g('q_fee')) }); L.status = 'Quoted'; L.fee = num(g('q_fee')); }
      M.toast('Quote saved');
      PAGE_INIT.leaddetail();
    } catch (e) { fail('Saving quote', e); }
  };

  window.handleCustomerFiles = async function (files) {
    const L = M.currentLead(); if (!L) return;
    const list = Array.from(files || []); if (!list.length) return;
    M.toast('Uploading ' + list.length + ' file' + (list.length === 1 ? '' : 's') + '…');
    for (const f of list) {
      try {
        const safe = f.name.replace(/[^A-Za-z0-9._-]/g, '_');
        const path = 'leads/' + L.id + '/' + Date.now() + '_' + safe;
        const { error } = await M.sb.storage.from('files').upload(path, f, { contentType: f.type || undefined });
        if (error) throw error;
        const row = await insert('files', { lead_id: L.id, storage_path: path, filename: f.name, size_bytes: f.size, mime_type: f.type || null, uploaded_by: myId() });
        M.data.files.unshift(row);
      } catch (e) { fail('Uploading ' + f.name, e); }
    }
    const el = $('customerFilesList'); if (el) el.innerHTML = filesHTML(leadFiles(L));
    const inp = $('customerFileInput'); if (inp) inp.value = '';
  };

  M.openFile = async function (id) {
    const f = M.data.files.find((x) => x.id === id); if (!f) return;
    try {
      const { data, error } = await M.sb.storage.from('files').createSignedUrl(f.storage_path, 120);
      if (error) throw error;
      window.open(data.signedUrl, '_blank');
    } catch (e) { fail('Opening file', e); }
  };

  M.leadExportFields = function () {
    const L = M.currentLead(); if (!L) return null;
    const d = L.details || {}, v = d.vehicle || {}, cov = d.coverage || {};
    return { label: L.name, fields: [
      ['Lead Name', esc(L.name)], ['Date of Birth', esc(d.dob || '—')], ['Gender / Marital', esc((d.gender || '—') + ' · ' + (d.marital || '—'))],
      ['Address', esc([d.address, d.city, (d.state || 'CA') + ' ' + (d.zip || '')].filter(Boolean).join(', ') || '—')], ['Phone / Email', esc(L.phone + (L.email ? ' · ' + L.email : ''))],
      ['License', esc(d.license || '—')], ['Vehicle', esc([v.year, v.make, v.model].filter(Boolean).join(' ') || '—')], ['VIN', esc(v.vin || '—')],
      ['Violations', esc(d.violations || '—')], ['Prior Coverage', esc(L.priorCoverage || '—')], ['Requested Coverage', esc([cov.type, cov.limits].filter(Boolean).join(' · ') || L.policy)],
      ['SR-22 Required', L.sr22 ? 'Yes' : 'No'], ['Language', esc(L.language)] ] };
  };

  // ------------------------------------------------------------------
  // CALLS + TEXTS
  // ------------------------------------------------------------------
  function matchLead(name, phone) { return LEADS.find((l) => (phone && l.phone === fmtPhone(phone)) || (name && l.name === name)) || null; }
  function matchCustomer(name, phone) { return CUSTOMERS.find((c) => (phone && c.phone === fmtPhone(phone)) || (name && (c.first + ' ' + c.last) === name)) || null; }

  window.logCall = function (opts) {
    opts = opts || {};
    const lead = opts.lead || matchLead(opts.leadName || window._currentLeadName, opts.phone);
    const cust = opts.customer || (lead ? null : matchCustomer(opts.leadName, opts.phone));
    const name = opts.leadName || (lead && lead.name) || (cust && cust.first + ' ' + cust.last) || window._currentLeadName || '';
    const phone = fmtPhone(opts.phone || (lead && lead.phone) || (cust && cust.phone) || '');
    const now = new Date();
    window.CALL_LOG.unshift({ id: 'tmp' + Date.now(), date: localISODate(now), timestamp: now.toISOString(), agentName: me().full_name, agent_id: myId(), leadName: name, phone, direction: opts.direction || 'outbound', missed: !!opts.missed, duration: opts.duration || 0, lead_id: lead && lead.id, customer_id: cust && cust.id });
    if (lead) lead.attempts.calls++;
    insert('call_log', { agent_id: myId(), lead_id: lead ? lead.id : null, customer_id: cust ? cust.id : null, contact_name: name, phone, direction: opts.direction || 'outbound', missed: !!opts.missed, duration_sec: opts.duration || 0 })
      .then((row) => { M.data.calls.unshift(row); }).catch((e) => fail('Logging call', e));
  };

  window.doCall = function (leadName, phone, leadObj) {
    const lead = leadObj || matchLead(leadName, phone);
    const p = phone || (lead && lead.phone) || '';
    if (lead && lead.doNotCall) { M.toast('This lead is marked DO NOT CALL', 'error'); return; }
    logCall({ leadName: leadName || (lead && lead.name), phone: p, lead, direction: 'outbound' });
    const digits = String(p).replace(/\D/g, '');
    if (digits) { try { window.location.href = 'tel:' + digits; } catch (e) { /* ignore */ } }
    M.toast('Call logged' + (leadName ? ' — ' + leadName : '') + (p ? ' · ' + p : ''));
    const L = M.currentLead(); if (window.CURRENT_PAGE === 'leaddetail' && L && lead && lead.id === L.id) { const tl = $('leadTimeline'); if (tl) tl.innerHTML = timelineHTML(L); }
  };

  M.recordText = function (o) {
    const phone = fmtPhone(o.phone); if (!phone) { M.toast('No phone number on file', 'warn'); return Promise.resolve(); }
    const lead = o.lead || matchLead(o.name, phone);
    const cust = o.customer || (lead ? null : matchCustomer(o.name, phone));
    const name = o.name || (lead && lead.name) || (cust && cust.first + ' ' + cust.last) || phone;
    const now = new Date(); const dir = o.direction || 'outbound';
    window.TEXT_LOG.push({ id: 'tmp' + Date.now(), date: localISODate(now), timestamp: now.toISOString(), agentName: me().full_name, agent_id: myId(), leadName: name, phone, direction: dir, content: o.text, lead_id: lead && lead.id, customer_id: cust && cust.id });
    const days = window.CONVERSATIONS[phone] || (window.CONVERSATIONS[phone] = []);
    let b = days.find((d) => d.date === 'Today'); if (!b) { b = { date: 'Today', msgs: [] }; days.push(b); }
    b.msgs.push({ from: dir === 'outbound' ? 'us' : 'them', time: fmtTime(now), author: me().full_name, text: o.text });
    const t = window.TEXT_THREADS[phone] || (window.TEXT_THREADS[phone] = { contact: name, phone, agent: me().full_name, messages: [] });
    t.messages.push({ direction: dir, text: o.text, time: fmtTime(now), read: true });
    if (lead && dir === 'outbound') lead.attempts.texts++;
    return insert('messages', { agent_id: myId(), lead_id: lead ? lead.id : null, customer_id: cust ? cust.id : null, contact_name: name, phone, direction: dir, body: o.text, status: 'sent' })
      .then((row) => { M.data.messages.push(row); }).catch((e) => fail('Saving text', e));
  };
  window.logText = function (opts) { opts = opts || {}; const lead = matchLead(opts.leadName || window._currentLeadName, opts.phone); return M.recordText({ phone: opts.phone || (lead && lead.phone), name: opts.leadName || (lead && lead.name), text: opts.content || '', direction: opts.direction || 'outbound', lead }); };

  const _openTextThread = window.openTextThread;
  window.openTextThread = function (name, phone) {
    if (!name && !phone) { const L = M.currentLead(); if (L) { name = L.name; phone = L.phone; } else if (window.CURRENT_THREAD_CONTACT) { name = window.CURRENT_THREAD_CONTACT.name; phone = window.CURRENT_THREAD_CONTACT.phone; } else { M.toast('Open a lead or customer first', 'warn'); return; } }
    return _openTextThread(name, phone);
  };

  window.applyThreadTemplate = function (value) {
    if (!value) return;
    const input = $('textThreadInput'); const c = window.CURRENT_THREAD_CONTACT || {};
    if (input) { input.value = value.replace(/\{\{name\}\}/g, (c.name || 'there').split(' ')[0]).replace(/\{\{phone\}\}/g, c.phone || '').replace(/\{\{agent\}\}/g, (me().full_name || '').split(' ')[0]).replace(/\{\{policy\}\}/g, (M.currentLead() || {}).policy || 'Auto'); input.focus(); }
  };

  window.sendTextReply = function () {
    const input = $('textThreadInput'); const text = (input && input.value.trim()) || '';
    const atts = window.THREAD_ATTACHMENTS || [];
    if (!text && !atts.length) return;
    const c = window.CURRENT_THREAD_CONTACT; if (!c || !c.phone) { M.toast('No contact selected', 'warn'); return; }
    const thread = $('textThread'); const time = fmtTime(new Date());
    if (text) M.recordText({ phone: c.phone, name: c.name, text });
    let attachHTML = atts.map((f) => '<div class="text-bubble us" style="display:flex;align-items:center;gap:8px;background:rgba(255,255,255,0.20);border:1px solid rgba(255,255,255,0.30)"><span style="font-size:18px">' + fileIcon(f.name) + '</span><span>' + esc(f.name) + '</span></div>').join('');
    if (thread) { const w = document.createElement('div'); w.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;gap:4px'; w.innerHTML = attachHTML + (text ? '<div class="text-bubble us">' + esc(text) + '</div>' : '') + '<div class="text-bubble-time us">' + time + ' · You</div>'; thread.appendChild(w); thread.scrollTop = thread.scrollHeight; }
    if (input) { input.value = ''; input.focus(); }
    window.THREAD_ATTACHMENTS = []; if (typeof renderThreadAttachments === 'function') renderThreadAttachments();
    if (atts.length) M.toast('Attachments are not sent yet — texting goes live with the Twilio step.', 'warn');
  };

  window.sendBulkText = async function () {
    const ta = $('bulkTextMessage'); const msg = (ta ? ta.value : '').trim();
    if (!msg) { M.toast('Type a message before sending.', 'warn'); return; }
    const leadPhones = [...(window.LEADS_SELECTED || [])]; const custIds = [...(window.CUSTOMERS_SELECTED || [])];
    const schTog = $('bulkScheduleToggle'); const scheduled = schTog && schTog.checked;
    const skipDnc = $('bulkSkipDNC'); const skip = !skipDnc || skipDnc.checked;
    closeBulkText();
    if (scheduled) { M.toast('Scheduled sending will be available once texting is connected (Twilio step).', 'warn'); return; }
    const targets = [];
    leadPhones.forEach((p) => { const l = LEADS.find((x) => x.phone === p); if (l && !(skip && l.doNotCall)) targets.push({ phone: l.phone, name: l.name, lead: l, policy: l.policy }); });
    custIds.forEach((id) => { const c = customerById(id); if (c) targets.push({ phone: c.phone, name: c.first + ' ' + c.last, customer: c, policy: (c.policies[0] || {}).line || 'Auto' }); });
    const agentFirst = (me().full_name || '').split(' ')[0];
    for (const t of targets) {
      const text = msg.replace(/\{\{name\}\}/g, t.name.split(' ')[0]).replace(/\{\{phone\}\}/g, t.phone).replace(/\{\{agent\}\}/g, agentFirst).replace(/\{\{policy\}\}/g, t.policy || 'Auto');
      await M.recordText({ phone: t.phone, name: t.name, text, lead: t.lead, customer: t.customer });
    }
    M.toast('Logged ' + targets.length + ' text' + (targets.length === 1 ? '' : 's') + '. (Messages actually send once Twilio is connected.)');
    if (leadPhones.length && typeof clearSelection === 'function') clearSelection();
    if (custIds.length && typeof clearCustomerSelection === 'function') clearCustomerSelection();
  };

  // ---- Templates ----
  window.newTemplate = async function () {
    try { const t = await insert('templates', { emoji: '✏️', name: 'New Template', body: 'Hi {{name}}, ', sort_order: 100 + M.data.templates.length, created_by: myId() }); M.data.templates.push(t); mapTemplates(); renderTemplateEditor(); }
    catch (e) { fail('Creating template', e); }
  };
  window.saveTemplateRow = async function (id, btn) {
    const row = btn.closest('[data-tid]'); const next = {};
    row.querySelectorAll('[data-field]').forEach((el) => { next[el.dataset.field] = el.value; });
    try {
      const saved = await update('templates', id, { emoji: next.emoji, name: next.name, body: next.text });
      const i = M.data.templates.findIndex((t) => t.id === id); if (i >= 0) M.data.templates[i] = saved; mapTemplates();
      const orig = btn.textContent; btn.textContent = '✓ Saved'; btn.style.background = 'var(--green-700)'; setTimeout(() => { btn.textContent = 'Save'; btn.style.background = 'var(--green-500)'; }, 1200);
    } catch (e) { fail('Saving template', e); }
  };
  window.deleteTemplate = async function (id) {
    if (!confirm('Delete this template?')) return;
    try { await remove('templates', id); M.data.templates = M.data.templates.filter((t) => t.id !== id); mapTemplates(); renderTemplateEditor(); }
    catch (e) { fail('Deleting template', e); }
  };

  // ------------------------------------------------------------------
  // APPOINTMENTS
  // ------------------------------------------------------------------
  async function createAppointment(o) {
    const starts = new Date(o.date + 'T' + o.time);
    if (isNaN(starts)) { M.toast('Pick a valid date and time', 'warn'); return null; }
    const row = await insert('appointments', { starts_at: starts.toISOString(), duration_min: 30, lead_id: o.lead ? o.lead.id : null, customer_id: o.customer ? o.customer.id : null,
      contact_name: o.name, phone: fmtPhone(o.phone), agent_id: (o.lead && o.lead.agent_id) || myId(), status: 'New', type: o.type || 'Follow-Up', notes: o.notes || '', created_by: myId() });
    await M.reload(['appointments']);
    return row;
  }
  window.confirmAppointment = async function () {
    const L = M.currentLead(); if (!L) return;
    const date = $('apptDate').value, time = $('apptTime').value, notes = ($('apptNote') || {}).value || '';
    if (!date || !time) { M.toast('Pick a date and time.', 'warn'); return; }
    try {
      const a = await createAppointment({ date, time, lead: L, name: L.name, phone: L.phone, type: 'Follow-Up', notes });
      if (!a) return;
      $('apptOverlay').style.display = 'none';
      if (L.status === 'New Lead' || L.status === 'Contacted') { await update('leads', L.id, { status: 'Appointment Set' }); L.status = 'Appointment Set'; }
      M.toast('Appointment added — ' + isoToUS(date) + ' at ' + fmt12(time));
      PAGE_INIT.leaddetail();
    } catch (e) { fail('Saving appointment', e); }
  };
  window.confirmAddAppt = async function () {
    const l = window._apptSelectedLead; if (!l) { M.toast('Search for and select a lead first.', 'warn'); return; }
    const date = $('addApptDate').value, time = $('addApptTime').value, type = ($('addApptType') || {}).value || 'Follow-Up', notes = ($('addApptNotes') || {}).value || '';
    if (!date || !time) { M.toast('Select a date and time.', 'warn'); return; }
    try {
      const a = await createAppointment({ date, time, lead: l, name: l.name, phone: l.phone, type, notes }); if (!a) return;
      closeAddApptModal(); window.CALENDAR_STATE.selectedDate = date; refreshCalendar(); M.toast('Appointment added');
    } catch (e) { fail('Saving appointment', e); }
  };

  // ------------------------------------------------------------------
  // NEW SALE  (creates the customer, the sale, and the policy rows)
  // ------------------------------------------------------------------
  window.submitNewSale = async function () {
    const g = (id) => { const el = $(id); return el ? el.value.trim() : ''; };
    const agent = profileByName(g('nsProd')) || me();
    const carrier = g('nsCarrier'), policyType = g('nsPolicyType') || 'Auto', policyNum = g('nsPolicyNum');
    const feeTotal = num(g('nsFeeTotal')), feeCollected = num(g('nsFeeCollected')), feeExtended = num(g('nsFeeExtended')), premium = num(g('nsPremium')), towing = num(g('nsTowingPrem'));
    const effDate = g('newSaleEffDate') || todayISO();
    const addl = JSON.parse(JSON.stringify(window.ADDITIONAL_POLICIES || []));
    if (!carrier) { M.toast('Select a carrier.', 'warn'); return; }
    const L = M.currentLead() || matchLead(window._preSaleLeadName || window._currentLeadName);
    const name = (L && L.name) || window._preSaleLeadName || window._currentLeadName || '';
    if (!name) { M.toast('Open the lead first, then record the sale.', 'warn'); return; }
    const btn = document.querySelector('#newSaleOverlay .btn-primary'); if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      let cust = (L && CUSTOMERS.find((c) => c.lead_id === L.id)) || matchCustomer(name, L && L.phone);
      const d = (L && L.details) || {};
      if (!cust) {
        const parts = name.split(' ');
        const row = await insert('customers', { lead_id: L ? L.id : null, first_name: (L && L.first) || parts[0] || 'New', last_name: (L && L.last) || parts.slice(1).join(' ') || 'Customer',
          phone: L ? L.phone : null, email: (L && L.email) || null, dob: usToISO(d.dob), gender: d.gender || null, marital: d.marital || null, license: d.license || null,
          address: d.address || null, city: d.city || null, state: d.state || 'CA', zip: d.zip || null, status: 'Active', agent_id: agent.id, sold_by_id: agent.id,
          customer_since: todayISO(), language: (L && L.language) || 'English', risk_score: L ? L.leadScore : 70, sr22: !!(L && L.sr22), referred_by: (L && L.source) || null });
        const v = d.vehicle || {};
        if (v.make || v.vin) await insert('vehicles', { customer_id: row.id, year: parseInt(v.year) || null, make: v.make || null, model: v.model || null, vin: v.vin || null, use: v.use || null });
        await insert('drivers', { customer_id: row.id, name, dob: usToISO(d.dob), gender: d.gender || null, license: d.license || null, violations: d.violations || null, is_primary: true });
        cust = { id: row.id };
      }
      const expires = (() => { const x = new Date(effDate); x.setFullYear(x.getFullYear() + 1); return localISODate(x); })();
      const sale = await insert('sales', { sale_date: todayISO(), agent_id: agent.id, lead_id: L ? L.id : null, customer_id: cust.id, carrier, policy_type: policyType, policy_number: policyNum,
        fee_total: feeTotal, fee_collected: feeCollected, fee_extended: feeExtended, premium, towing_premium: towing, effective_date: effDate, additional_policies: addl, total_policies: 1 + addl.length });
      await insert('policies', { customer_id: cust.id, sale_id: sale.id, line: policyType, carrier, policy_number: policyNum, sold_by_id: agent.id, effective_date: effDate, expires_date: expires,
        premium, towing_premium: towing, fee_total: feeTotal, fee_collected: feeCollected, fee_extended: feeExtended, hcc_collected: false, status: 'Active' });
      for (const p of addl) {
        await insert('policies', { customer_id: cust.id, sale_id: sale.id, line: p.type || p.line || 'Auto', carrier: p.carrier || carrier, policy_number: p.number || '', sold_by_id: agent.id, effective_date: effDate, expires_date: expires,
          premium: num(p.premium), fee_total: num(p.fee || 0), fee_collected: num(p.down || 0), fee_extended: 0, hcc_collected: false, status: 'Active' });
      }
      if (L) await update('leads', L.id, { status: 'Sold', disposition: L.disposition || 'Already Sold', fee: feeTotal || L.fee });
      closeNewSale();
      ['nsProd', 'nsCarrier', 'nsPolicyType', 'nsPolicyNum', 'nsFeeTotal', 'nsFeeCollected', 'nsFeeExtended', 'nsPremium', 'nsTowingPrem'].forEach((id) => { const el = $(id); if (el && el.tagName === 'INPUT') el.value = ''; });
      window.ADDITIONAL_POLICIES = [];
      await M.reload(['leads', 'customers', 'policies', 'sales', 'vehicles', 'drivers']);
      M.toast('🎉 Sale recorded — ' + name + ' is now a customer');
      openCustomerDetail(cust.id);
    } catch (e) { fail('Recording sale', e); }
    finally { if (btn) { btn.disabled = false; btn.textContent = 'Save Sale'; } }
  };

  const _voidPolicy = window.voidPolicy;
  window.voidPolicy = async function (custId, policyNum) {
    if (!confirm('VOID this policy? This will reverse the sale and cannot be undone.')) return;
    const c = customerById(custId); const pol = c && c.policies.find((p) => p.number === policyNum); if (!pol) return;
    try {
      await update('policies', pol.id, { status: 'Voided' });
      if (pol.saleId) { try { await remove('sales', pol.saleId); } catch (e) { /* agents cannot delete sales; policy is still voided */ } }
      await M.reload(['policies', 'sales', 'customers']);
      M.toast('Policy voided'); nav('customerdetail', null);
    } catch (e) { fail('Voiding policy', e); }
  };
  void _voidPolicy;

  // ------------------------------------------------------------------
  // CUSTOMER DETAIL helpers (used by the customer page template)
  // ------------------------------------------------------------------
  function custMatch(c, x) { return x.customer_id === c.id || (c.lead_id && x.lead_id === c.lead_id) || (x.phone && fmtPhone(x.phone) === c.phone); }
  M.customerCallLog = function (c) {
    return M.data.calls.filter((x) => custMatch(c, x)).slice(0, 25).map((x) => ({ disp: x.missed ? 'No Answer' : (x.direction === 'inbound' ? 'Inbound Call' : 'Completed'), dc: x.missed ? '#6b7280' : '#15803d', db: x.missed ? '#f3f4f6' : '#dcfce7', agent: agentName(x.agent_id), dur: Math.floor((x.duration_sec || 0) / 60) + ':' + String((x.duration_sec || 0) % 60).padStart(2, '0'), ts: new Date(x.created_at).toLocaleString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' }), ok: !x.missed }));
  };
  M.customerTextBubbles = function (c) {
    const msgs = M.data.messages.filter((x) => custMatch(c, x));
    if (!msgs.length) return '<div style="text-align:center;color:var(--gray-400);font-size:12.5px;padding:20px 0">No text history yet.</div>';
    return msgs.map((m) => m.direction === 'inbound'
      ? '<div style="display:flex;justify-content:flex-start"><div style="max-width:60%;background:var(--gray-100);border-radius:14px 14px 14px 3px;padding:11px 15px"><div style="font-size:10.5px;font-weight:700;color:var(--gray-400);margin-bottom:4px">' + esc(c.first) + ' · ' + fmtStamp(m.created_at) + '</div><div style="font-size:13.5px;color:var(--navy-900);line-height:1.5">' + esc(m.body) + '</div></div></div>'
      : '<div style="display:flex;justify-content:flex-end"><div style="max-width:60%;background:var(--blue);border-radius:14px 14px 3px 14px;padding:11px 15px"><div style="font-size:10.5px;font-weight:700;color:rgba(255,255,255,0.55);margin-bottom:4px">' + esc(agentName(m.agent_id)) + ' · ' + fmtStamp(m.created_at) + '</div><div style="font-size:13.5px;color:#fff;line-height:1.5">' + esc(m.body) + '</div></div></div>').join('');
  };
  M.sendCustomerText = async function () {
    const c = customerById(window._currentCustomerId); const input = $('cdTextInput'); if (!c || !input || !input.value.trim()) return;
    await M.recordText({ phone: c.phone, name: c.first + ' ' + c.last, text: input.value.trim(), customer: c });
    input.value = ''; const box = $('cdTextThread'); if (box) { box.innerHTML = M.customerTextBubbles(c); box.scrollTop = box.scrollHeight; }
  };
  M.customerNotesHTML = function (c) {
    const list = M.data.notes.filter((n) => n.customer_id === c.id || (c.lead_id && n.lead_id === c.lead_id));
    if (!list.length) return '<div style="font-size:12.5px;color:var(--gray-400)">No notes yet.</div>';
    return list.map((n) => '<div style="padding:13px 15px;background:var(--gray-50);border-radius:var(--radius-md);border-left:3px solid var(--green-500)"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px"><div style="font-size:13px;font-weight:700;color:var(--navy-900)">' + esc(agentName(n.author_id)) + '</div><div style="font-size:11px;color:var(--gray-400)">' + fmtStamp(n.created_at) + '</div></div><div style="font-size:13px;color:var(--gray-700);line-height:1.55;white-space:pre-wrap">' + esc(n.body) + '</div></div>').join('');
  };
  M.saveCustomerNote = async function () {
    const c = customerById(window._currentCustomerId); const input = $('cdNoteInput'); if (!c || !input || !input.value.trim()) { M.toast('Type a note first.', 'warn'); return; }
    try { const n = await insert('notes', { customer_id: c.id, author_id: myId(), body: input.value.trim() }); M.data.notes.unshift(n); input.value = ''; const el = $('cdNotesList'); if (el) el.innerHTML = M.customerNotesHTML(c); M.toast('Note saved'); }
    catch (e) { fail('Saving note', e); }
  };

  // Shared helpers for msihub-data-2.js (settings, tasks, live view, reports)
  M._h = { insert, update, remove, esc, num, money, fmtPhone, fmtTime, fmtDay, fmtStamp, localISODate, todayISO, isoToUS, usToISO, fmt12, agentName, profileById, profileByName, me, myId, isAdmin, fail, debounce };
})();
