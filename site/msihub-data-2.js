/* =====================================================================
   MSIHub — data layer, part 2
   Settings lists (tiers, carriers, vendors, lead sources, lifecycle rules),
   agent profiles edited from the Admin/Teams pages, Tasks, Live View and
   Inbox history, and the Reports page numbers — all from the database.
   Requires msihub-data.js (loaded first) and supabase/schema-v2.sql.
   ===================================================================== */
(function () {
  'use strict';
  const M = window.MSIHub; if (!M || !M._h) return;
  const H = M._h;
  const $ = (id) => document.getElementById(id);
  const AG = () => (typeof AGENTS !== 'undefined' ? AGENTS : []);
  const v2Ready = () => !M.missingTables.has('agency_settings');
  const tasksReady = () => !M.missingTables.has('tasks');
  const uniq = (a) => [...new Set(a)];
  const fillArr = (arr, rows) => { if (!arr) return; arr.length = 0; rows.forEach((r) => arr.push(r)); };
  const fillObj = (obj, o) => { if (!obj) return; Object.keys(obj).forEach((k) => delete obj[k]); Object.assign(obj, o); };
  // Wrap an existing global function: run it, then run `after` with the same arguments.
  function wrapAfter(name, after) { const o = window[name]; if (typeof o !== 'function') return; window[name] = function () { const r = o.apply(this, arguments); try { after.apply(this, arguments); } catch (e) { H.fail(name, e); } return r; }; }
  function wrapBefore(name, before) { const o = window[name]; if (typeof o !== 'function') return; window[name] = function () { try { before.apply(this, arguments); } catch (e) { console.warn('[MSIHub] ' + name, e); } return o.apply(this, arguments); }; }
  const NEED_V2 = 'This setting is not synced yet — run supabase/schema-v2.sql in the Supabase SQL Editor.';

  // ------------------------------------------------------------------
  // SETTINGS LISTS  (agency_settings key/value store)
  // ------------------------------------------------------------------
  const SETTINGS = { tiers: 'TIER_DATA', carriers: 'CARRIER_DATA', lead_vendors: 'LEAD_VENDORS', lead_sources: 'LEAD_SOURCES', lifecycle_rules: 'LIFECYCLE_RULES', goal_period: 'GOAL_PERIOD' };
  const seeded = new Set();

  function applySettings() {
    Object.keys(SETTINGS).forEach((key) => {
      const row = M.data.agency_settings.find((r) => r.key === key);
      if (row && row.value != null) window[SETTINGS[key]] = row.value;
      else if (v2Ready() && H.isAdmin() && !seeded.has(key) && window[SETTINGS[key]] != null) { seeded.add(key); persist(key, true); }
    });
  }

  async function persist(key, quiet) {
    if (!v2Ready()) { if (!quiet) M.toast(NEED_V2, 'warn'); return; }
    const value = window[SETTINGS[key]];
    const clean = value == null ? null : JSON.parse(JSON.stringify(value));
    const { error } = await M.sb.from('agency_settings').upsert({ key, value: clean, updated_by: H.myId(), updated_at: new Date().toISOString() });
    if (error) { H.fail('Saving settings', error); return; }
    const i = M.data.agency_settings.findIndex((r) => r.key === key);
    const row = { key, value: clean };
    if (i >= 0) M.data.agency_settings[i] = row; else M.data.agency_settings.push(row);
    if (!quiet) M.toast('Saved');
  }
  M.persistSetting = persist;

  [['saveTierData', 'tiers'], ['saveCarrier', 'carriers'], ['deleteCarrier', 'carriers'],
   ['saveVendor', 'lead_vendors'], ['removeVendor', 'lead_vendors'],
   ['toggleLeadSource', 'lead_sources'], ['addLeadSource', 'lead_sources'], ['removeLeadSource', 'lead_sources'],
   ['toggleLifecycleRule', 'lifecycle_rules'], ['saveLifecycleRule', 'lifecycle_rules'], ['deleteLifecycleRule', 'lifecycle_rules']]
    .forEach(([fn, key]) => wrapAfter(fn, () => persist(key)));

  // ------------------------------------------------------------------
  // AGENT PROFILES  (Admin > Agents, Teams & Agents, Goals)
  // ------------------------------------------------------------------
  function patchFromTeam(name) {
    const t = (window.TEAM_MEMBERS || []).find((m) => m.name === name) || {};
    const a = AG().find((x) => x.name === name) || {};
    const pick = (x, y, d) => (x != null ? x : (y != null ? y : d));
    const base = { full_name: name, phone: pick(t.phone, a._phone, null) || null, role: (t.role === 'Admin' || a._role === 'Admin') ? 'admin' : 'agent', active: t.status ? t.status !== 'Inactive' : true };
    if (!v2Ready()) return base;
    return Object.assign(base, {
      ext: t.ext || null, tier: pick(t.tier, a.tier, null), team: pick(t.team, a._team, null) || null, start_date: t.startDate || a._startDate || null, agent_type: a._agentType || null,
      goal_apps: pick(t.goalApps, a.goal, 15), goal_fee: pick(t.goalFee, a.feeGoal, 6000), goal_premium: pick(t.goalPremium, null, 20000), goal_close: pick(t.goalClose, null, 25), goal_contact: pick(t.goalContact, null, 55),
      perms: { viewAll: !!t.permViewAll, reports: !!t.permReports, payments: !!t.permPayments, manage: !!t.permManage, addRemove: !!t.permAddRemove, twoFa: !!a._2fa, inboundDisabled: !!a._inboundDisabled },
    });
  }
  async function saveProfile(id, patch, label) {
    if (!id) { M.toast('Could not find that agent in the database', 'error'); return; }
    if (patch.role === 'admin' && !H.isAdmin()) delete patch.role;   // only admins may promote
    try { await H.update('profiles', id, patch); await M.reload(['profiles']); M.refreshCurrentPage(); M.toast(label || 'Agent saved'); }
    catch (e) { H.fail('Saving agent', e); }
  }
  const NO_CREATE = 'Agent logins are created in Supabase: Authentication → Users → Add user → Create new user (turn on Auto Confirm). The agent appears here automatically once the login exists.';

  { const o = window.saveEditedAgent; if (o) window.saveEditedAgent = function (idx) { const id = (AG()[idx] || {}).id; const r = o.apply(this, arguments); const name = (AG()[idx] || {}).name; if (name) saveProfile(id, patchFromTeam(name)); return r; }; }
  { const o = window.saveAgent; if (o) window.saveAgent = function () {
      const oldName = window._editingAgent; const g = (i) => { const el = $(i); return el ? el.value.trim() : ''; }; const newName = (g('am_first') + ' ' + g('am_last')).trim();
      const r = o.apply(this, arguments);
      if (!oldName) { M.toast(NO_CREATE, 'warn'); M.reload(['profiles']).then(() => M.refreshCurrentPage()); return r; }
      const p = H.profileByName(oldName); saveProfile(p && p.id, patchFromTeam(newName)); return r; }; }
  { const o = window.confirmRemoveAgent; if (o) window.confirmRemoveAgent = function (name) { const before = (window.TEAM_MEMBERS || []).length; const r = o.apply(this, arguments); if ((window.TEAM_MEMBERS || []).length < before) { const p = H.profileByName(name); saveProfile(p && p.id, { active: false }, name + ' deactivated'); } return r; }; }
  ['archiveAgent', 'deleteAgent'].forEach((fn) => { const o = window[fn]; if (!o) return; window[fn] = function (idx) { const a = AG()[idx] || {}; const r = o.apply(this, arguments); saveProfile(a.id, { active: false }, (a.name || 'Agent') + ' deactivated — their login stays in Supabase but they can no longer sign in'); return r; }; });
  { const o = window.restoreAgent; if (o) window.restoreAgent = function (idx) { const a = AG()[idx] || {}; const r = o.apply(this, arguments); saveProfile(a.id, { active: true }, (a.name || 'Agent') + ' restored'); return r; }; }
  wrapAfter('saveAgentGoals', async () => {
    if (!v2Ready()) { M.toast(NEED_V2, 'warn'); return; }
    const jobs = AG().filter((a) => a.id && !a._archived).map((a) => { const gl = (window.AGENT_GOALS || {})[a.name] || {}; return M.sb.from('profiles').update({ goal_apps: gl.apps || 0, goal_fee: gl.fee || 0, goal_premium: gl.premium || 0, goal_close: gl.close || 0, goal_contact: gl.contact || 0 }).eq('id', a.id); });
    const results = await Promise.all(jobs); const bad = results.find((x) => x.error); if (bad) H.fail('Saving goals', bad.error);
    await persist('goal_period', true); await M.reload(['profiles']); M.toast('Goals saved');
  });
  window.submitAddAgent = function () {
    const g = (i) => { const el = $(i); return el ? el.value.trim() : ''; };
    const err = $('agentAddError') || null;
    M.toast(NO_CREATE, 'warn');
    if (window.ADMIN_STATE) { window.ADMIN_STATE.agentError = 'To add ' + ((g('af_first') + ' ' + g('af_last')).trim() || 'an agent') + ', create their login in Supabase (Authentication → Users → Add user). They will appear here automatically.'; }
    if (typeof refreshAdminPage === 'function') refreshAdminPage();
    void err;
  };

  // ------------------------------------------------------------------
  // TASKS
  // ------------------------------------------------------------------
  function mapTasks() {
    window.TASKS_DATA = M.data.tasks.map((t) => ({ id: t.id, icon: t.icon || '✅', label: t.label, dueDate: t.due_date || '', dueTime: t.due_time || '', priority: t.priority || 'med', assignedTo: t.assigned_label || 'Admin', assigned_to: t.assigned_to, notes: t.notes || '', done: !!t.done, created_by: t.created_by }));
  }
  function refreshTaskPanels() { if ($('focusTasks') && typeof renderFocusTasks === 'function') renderFocusTasks(); if ($('tasksPageWrap') && typeof refreshTasksPage === 'function') refreshTasksPage(); }

  window.submitTaskModal = async function () {
    const g = (i) => { const el = $(i); return el ? el.value : ''; };
    const label = g('tm_label').trim(), icon = g('tm_type'), priority = g('tm_priority'), dueDate = g('tm_date'), rawTime = g('tm_time'), assignTo = g('tm_assign'), related = g('tm_related').trim(), notes = g('tm_notes').trim();
    const errEl = $('tm_error');
    const showErr = (m) => { if (errEl) { errEl.textContent = m; errEl.style.display = 'block'; } else M.toast(m, 'warn'); };
    if (!label) { showErr('Task description is required.'); return; }
    if (!dueDate) { showErr('Due date is required.'); return; }
    const dueTime = rawTime ? H.fmt12(rawTime) : '';
    const assignLabel = assignTo.startsWith('Admin') ? 'Admin' : assignTo;
    const p = H.profileByName(assignLabel);
    const row = { label: label + (related ? ' — ' + related : ''), icon, priority, due_date: dueDate, due_time: dueTime, assigned_label: assignLabel, assigned_to: p ? p.id : (assignLabel === 'Admin' ? H.myId() : null), notes, done: false, created_by: H.myId() };
    if (!tasksReady()) {
      window.TASKS_DATA.push({ id: window._nextTaskId++, icon, label: row.label, dueDate, dueTime, priority, assignedTo: assignLabel, notes, done: false });
      M.toast(NEED_V2, 'warn');
    } else {
      try { const saved = await H.insert('tasks', row); M.data.tasks.push(saved); mapTasks(); }
      catch (e) { H.fail('Saving task', e); return; }
    }
    if (typeof closeTaskModal === 'function') closeTaskModal();
    refreshTaskPanels();
  };
  window.toggleTaskDone = async function (id) {
    const t = (window.TASKS_DATA || []).find((x) => x.id === id); if (!t) return;
    t.done = !t.done; refreshTaskPanels();
    if (!tasksReady()) return;
    try { await H.update('tasks', id, { done: t.done }); const d = M.data.tasks.find((x) => x.id === id); if (d) d.done = t.done; }
    catch (e) { t.done = !t.done; refreshTaskPanels(); H.fail('Updating task', e); }
  };
  window.deleteTask = async function (id) {
    window.TASKS_DATA = (window.TASKS_DATA || []).filter((x) => x.id !== id); refreshTaskPanels();
    if (!tasksReady()) return;
    try { await H.remove('tasks', id); M.data.tasks = M.data.tasks.filter((x) => x.id !== id); }
    catch (e) { H.fail('Deleting task', e); M.reload(['tasks']).then(refreshTaskPanels); }
  };

  // ------------------------------------------------------------------
  // LIVE VIEW + INBOX  (derived from real call and text logs)
  // ------------------------------------------------------------------
  function mapLive() {
    const me = H.me();
    window.AGENT_LIVE = M.data.profiles.filter((p) => p.active).map((p) => ({ name: p.full_name, ext: p.ext || '', status: p.id === H.myId() ? 'available' : 'offline', callDuration: 0, callDirection: null, leadName: null, leadPhone: null, team: p.team || '' }));
    window.CALL_HISTORY = M.data.calls.map((c) => ({ id: c.id, agent: H.agentName(c.agent_id), time: H.fmtTime(c.created_at), date: H.fmtDay(c.created_at), contact: c.contact_name || 'Unknown', phone: H.fmtPhone(c.phone), direction: c.direction, duration: c.duration_sec || 0, status: c.missed ? 'missed' : 'connected', recording: false, outcome: c.missed ? 'Missed' : '' }));
    window.TEXT_HISTORY = M.data.messages.slice().reverse().map((m) => ({ id: m.id, agent: H.agentName(m.agent_id), time: H.fmtDay(m.created_at) === 'Today' ? H.fmtTime(m.created_at) : H.fmtDay(m.created_at), contact: m.contact_name || H.fmtPhone(m.phone), phone: H.fmtPhone(m.phone), direction: m.direction, preview: (m.body || '').slice(0, 70) }));
    window.EMAILS = [];
    if (window.LIVEVIEW_STATE) window.LIVEVIEW_STATE.loggedInAgent = me.full_name;
    if (window.INBOX_STATE) window.INBOX_STATE.loggedInAgent = me.full_name;
  }

  // ------------------------------------------------------------------
  // REPORTS  (fill the report tables from real data for the chosen range)
  // ------------------------------------------------------------------
  const MOS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const RPT = {
    carriers: typeof CARRIER_DATA !== 'undefined' ? CARRIER_DATA : null,       // the report table (not the settings list on window)
    sources: typeof LEAD_SOURCE_DATA !== 'undefined' ? LEAD_SOURCE_DATA : null,
    types: typeof POLICY_TYPE_DATA !== 'undefined' ? POLICY_TYPE_DATA : null,
    months: typeof MONTHLY_REVENUE !== 'undefined' ? MONTHLY_REVENUE : null,
    aging: typeof FEE_AGING_DATA !== 'undefined' ? FEE_AGING_DATA : null,
    agingAccounts: typeof FEE_AGING_ACCOUNTS !== 'undefined' ? FEE_AGING_ACCOUNTS : null,
    agents: typeof AGENT_EXTENDED_DATA !== 'undefined' ? AGENT_EXTENDED_DATA : null,
  };
  function payPeriod(d) { const y = d.getFullYear(), m = d.getMonth(); return d.getDate() <= 15 ? [new Date(y, m, 1), new Date(y, m, 15)] : [new Date(y, m, 16), new Date(y, m + 1, 0)]; }
  function rangeFor(s) {
    const t = new Date(); let a, b;
    switch ((s || {}).dateMode) {
      case 'thismonth': a = new Date(t.getFullYear(), t.getMonth(), 1); b = new Date(t.getFullYear(), t.getMonth() + 1, 0); break;
      case 'lastmonth': a = new Date(t.getFullYear(), t.getMonth() - 1, 1); b = new Date(t.getFullYear(), t.getMonth(), 0); break;
      case 'ytd': a = new Date(t.getFullYear(), 0, 1); b = t; break;
      case 'payperiod': [a, b] = payPeriod(t); break;
      default: a = s && s.startDate ? new Date(s.startDate + 'T00:00') : payPeriod(t)[0]; b = s && s.endDate ? new Date(s.endDate + 'T00:00') : t;
    }
    return [H.localISODate(a), H.localISODate(b)];
  }
  M.reportRange = rangeFor;
  window.rptScale = function () { return 1; };
  window.rptDateLabel = function (s) {
    const [a, b] = rangeFor(s); const f = (iso) => { const [y, m, d] = iso.split('-'); return MOS[+m - 1] + ' ' + (+d) + ', ' + y; };
    const names = { payperiod: 'Current Pay Period', thismonth: 'This Month', lastmonth: 'Last Month', ytd: 'Year to Date' };
    return f(a) + ' – ' + f(b) + (names[(s || {}).dateMode] ? ' (' + names[s.dateMode] + ')' : '');
  };
  const inRange = (iso, a, b) => { const d = (iso || '').slice(0, 10); return !!d && d >= a && d <= b; };

  function computeReports() {
    const s = window.REPORTS_STATE || {};
    if (!M._rptInit && window.REPORTS_STATE) { M._rptInit = true; const [a0, b0] = rangeFor({ dateMode: 'payperiod' }); s.dateMode = s.dateMode || 'payperiod'; s.startDate = a0; s.endDate = b0; }
    const [a, b] = rangeFor(s); const D = M.data; const n = H.num;
    const sales = D.sales.filter((x) => inRange(x.sale_date || x.created_at, a, b));
    const leads = D.leads.filter((x) => inRange(x.received_at || x.created_at, a, b));
    const calls = D.calls.filter((x) => inRange(x.created_at, a, b));
    const msgs = D.messages.filter((x) => inRange(x.created_at, a, b));
    const quotes = D.quotes.filter((x) => inRange(x.created_at, a, b));
    const pols = D.policies.filter((x) => inRange(x.effective_date || x.created_at, a, b));
    const custById = {}; D.customers.forEach((c) => { custById[c.id] = c; });

    // Carriers
    const carrierNames = uniq([...(window.CARRIER_DATA || []).filter((c) => c.active !== false).map((c) => c.name), ...sales.map((x) => x.carrier), ...pols.map((p) => p.carrier)].filter(Boolean));
    fillArr(RPT.carriers, carrierNames.map((name) => {
      const ps = pols.filter((p) => p.carrier === name), ss = sales.filter((x) => x.carrier === name), qs = quotes.filter((q) => q.carrier === name).length;
      return { name, policies: ps.length || ss.reduce((t, x) => t + (x.total_policies || 1), 0), premium: Math.round(ps.reduce((t, p) => t + n(p.premium), 0) || ss.reduce((t, x) => t + n(x.premium), 0)),
        bindRate: qs ? Math.min(100, Math.round(ss.length / qs * 100)) + '%' : '—', cancels: D.policies.filter((p) => p.carrier === name && p.status === 'Cancelled' && inRange(p.updated_at, a, b)).length,
        newClients: new Set(ss.map((x) => x.customer_id).filter(Boolean)).size, renewals: 0 };
    }));

    // Lead sources
    const vendors = window.LEAD_VENDORS || [];
    const touched = new Set([...D.calls.map((c) => c.lead_id), ...D.messages.map((m) => m.lead_id)].filter(Boolean));
    const quotedLead = new Set(D.quotes.map((q) => q.lead_id).filter(Boolean));
    const sourceNames = uniq([...(window.LEAD_SOURCES || []).filter((x) => x.active !== false).map((x) => x.name), ...leads.map((l) => l.source)].filter(Boolean));
    fillArr(RPT.sources, sourceNames.map((source) => {
      const ls = leads.filter((l) => (l.source || '').toLowerCase() === source.toLowerCase());
      const vendor = vendors.find((v) => (v.name || '').toLowerCase() === source.toLowerCase());
      return { source, leads: ls.length, contacted: ls.filter((l) => l.status !== 'New Lead' || touched.has(l.id)).length,
        quoted: ls.filter((l) => ['Quoted', 'Appointment Set', 'Sold'].includes(l.status) || quotedLead.has(l.id)).length,
        apps: ls.filter((l) => l.status === 'Sold').length, cost: vendor ? Math.round(n(vendor.ppl) * ls.length) : 0 };
    }));

    // Policy types
    const typeNames = uniq(['Auto', 'Home', 'Renters', 'Commercial', 'Motorcycle', 'Life', ...pols.map((p) => p.line)].filter(Boolean));
    fillArr(RPT.types, typeNames.map((type) => {
      const ps = pols.filter((p) => (p.line || 'Auto') === type);
      return { type, policies: ps.length, premium: Math.round(ps.reduce((t, p) => t + n(p.premium), 0)), newClients: new Set(ps.map((p) => p.customer_id).filter((id) => custById[id] && inRange(custById[id].customer_since, a, b))).size, renewals: 0 };
    }));

    // Monthly broker fees (7 months ending with the range end)
    const end = new Date(b + 'T00:00'); const months = [];
    for (let i = 6; i >= 0; i--) { const d = new Date(end.getFullYear(), end.getMonth() - i, 1); const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); const ms = D.sales.filter((x) => (x.sale_date || x.created_at || '').slice(0, 7) === key); months.push({ month: MOS[d.getMonth()], key, collected: Math.round(ms.reduce((t, x) => t + n(x.fee_collected), 0)), extended: Math.round(ms.reduce((t, x) => t + n(x.fee_extended), 0)) }); }
    fillArr(RPT.months, months);

    // Fee aging (open extended broker fees, all time)
    const today = new Date(); const buckets = ['0–30 days', '31–60 days', '61–90 days', '90+ days']; const acc = {}; buckets.forEach((k) => { acc[k] = []; });
    D.policies.filter((p) => p.status === 'Active' && !p.hcc_collected && n(p.fee_extended) > 0).forEach((p) => {
      const days = Math.max(0, Math.floor((today - new Date((p.effective_date || p.created_at || '').slice(0, 10) + 'T00:00')) / 86400000));
      const k = days <= 30 ? buckets[0] : days <= 60 ? buckets[1] : days <= 90 ? buckets[2] : buckets[3];
      const c = custById[p.customer_id] || {};
      acc[k].push({ name: ((c.first_name || '') + ' ' + (c.last_name || '')).trim() || 'Customer', agent: H.agentName(p.sold_by_id), carrier: p.carrier || '', days, amount: n(p.fee_extended) });
    });
    fillArr(RPT.aging, buckets.map((k) => ({ bucket: k, amount: Math.round(acc[k].reduce((t, x) => t + x.amount, 0)), count: acc[k].length })));
    fillObj(RPT.agingAccounts, acc);

    // Per-agent extended metrics
    const ext = {};
    M.data.profiles.filter((p) => p.active).forEach((p) => {
      const ac = calls.filter((c) => c.agent_id === p.id), inb = ac.filter((c) => c.direction === 'inbound'), outb = ac.filter((c) => c.direction === 'outbound'), missed = ac.filter((c) => c.missed);
      const connected = ac.filter((c) => !c.missed && c.duration_sec > 0);
      const myLeads = leads.filter((l) => l.agent_id === p.id); const mySales = sales.filter((x) => x.agent_id === p.id);
      const myLeadIds = new Set(D.leads.filter((l) => l.agent_id === p.id).map((l) => l.id));
      const sold = myLeads.filter((l) => l.status === 'Sold').length;
      const feeCollected = mySales.reduce((t, x) => t + n(x.fee_collected), 0);
      const pct = (num, den) => (den ? Math.round(num / den * 100) + '%' : '—');
      ext[p.full_name] = { feeExtended: Math.round(mySales.reduce((t, x) => t + n(x.fee_extended), 0)), inboundClose: pct(sold, inb.length), outboundClose: pct(sold, outb.length),
        totalCalls: ac.length, inboundCalls: inb.length, outboundCalls: outb.length, missedCalls: missed.length, avgCallDur: connected.length ? Math.round(connected.reduce((t, c) => t + c.duration_sec, 0) / connected.length) : 0,
        dials: outb.length, textsSent: msgs.filter((m) => m.agent_id === p.id && m.direction === 'outbound').length, textsRecv: msgs.filter((m) => m.direction === 'inbound' && myLeadIds.has(m.lead_id)).length,
        avgResponse: '—', revenuePerLead: myLeads.length ? Math.round(feeCollected / myLeads.length) : 0, refunds: 0, retention: '—', newLeads: myLeads.length,
        leadsMissed: myLeads.filter((l) => !touched.has(l.id) && (Date.now() - new Date(l.received_at || l.created_at)) > 86400000).length };
    });
    fillObj(RPT.agents, ext);
  }
  wrapBefore('refreshReports', computeReports);
  wrapBefore('renderReportsPage', computeReports);
  M.computeReports = computeReports;

  // Month fee breakdown drill-down: who / which source / which carrier produced the month's broker fees
  M.monthShares = function (r) {
    const key = r && r.key; const n = H.num;
    const ms = key ? M.data.sales.filter((x) => (x.sale_date || x.created_at || '').slice(0, 7) === key) : [];
    const totC = ms.reduce((t, x) => t + n(x.fee_collected), 0) || 0, totE = ms.reduce((t, x) => t + n(x.fee_extended), 0) || 0;
    const share = (list, keyFn, label) => { const g = {}; list.forEach((x) => { const k = keyFn(x) || 'Other'; const o = g[k] || (g[k] = { c: 0, e: 0 }); o.c += n(x.fee_collected); o.e += n(x.fee_extended); }); return Object.keys(g).map((k) => ({ [label]: k, cS: totC ? g[k].c / totC : 0, eS: totE ? g[k].e / totE : 0 })).sort((a, b) => b.cS - a.cS); };
    const leadSource = {}; M.data.leads.forEach((l) => { leadSource[l.id] = l.source; });
    return { agentShares: share(ms, (x) => H.agentName(x.agent_id), 'name'), sourceShares: share(ms, (x) => leadSource[x.lead_id], 'source'), carrierShares: share(ms, (x) => x.carrier, 'carrier') };
  };

  // Recent activity feed rows: [icon, title, subtitle, time, css class]
  M.activityFeed = function (limit) {
    const rows = [];
    M.data.calls.forEach((c) => rows.push({ ts: c.created_at, row: [c.direction === 'inbound' ? '📲' : '📞', (c.direction === 'inbound' ? 'Inbound ' : 'Outbound ') + (c.missed ? 'missed' : 'call'), (c.contact_name || 'Unknown') + (c.duration_sec ? ' · ' + Math.floor(c.duration_sec / 60) + ' min ' + String(c.duration_sec % 60).padStart(2, '0') + ' sec' : '') + ' · ' + H.agentName(c.agent_id), H.fmtTime(c.created_at), c.missed ? 'tl-status' : 'tl-call'] }));
    M.data.messages.forEach((m) => rows.push({ ts: m.created_at, row: ['💬', m.direction === 'inbound' ? 'Text received' : 'Text sent', (m.contact_name || H.fmtPhone(m.phone)) + ' · "' + (m.body || '').slice(0, 60) + (m.body && m.body.length > 60 ? '…' : '') + '"', H.fmtTime(m.created_at), 'tl-note'] }));
    M.data.sales.forEach((s) => rows.push({ ts: s.created_at, row: ['🎉', 'Sale recorded', (s.carrier || '') + ' · ' + H.money(n2(s.premium)) + ' premium · ' + H.agentName(s.agent_id), H.fmtTime(s.created_at), 'tl-call'] }));
    function n2(v) { return H.num(v); }
    return rows.sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, limit || 8).map((x) => x.row);
  };

  // ------------------------------------------------------------------
  // Register: run after every data load / reload
  // ------------------------------------------------------------------
  M.hooks.remap.push(applySettings, mapTasks, mapLive, computeReports);
})();
