// =====================================================================
// MaxSaveHub — automation, email, policies & renewals, loss reasons, tags, required fields (2026-10-02)
// Fourth data-layer file. Loads after msihub-telnyx.js. Needs supabase/schema-v6-automation.sql and the
// "automation" edge function; without them every feature below shows a "not set up yet" note and nothing breaks.
//
// What lives here
//   Settings → Lifecycle Automation: engine switch, business hours, stop rules, shot clock, email sender, status
//   Settings → Leads: loss reasons, required fields, tags, cost per lead source, email templates
//   Lead card: tags, running sequences (stop / start), X-date, lost reason, Email tab
//   Customer page: tags, running sequences, Email tab, add / edit / renew / cancel policies
//   Renewals page (policies coming up + X-date leads), lead-source ROI + loss reasons on Reports → Leads
//   Bad Lead → reason required (M.askLossReason), New Lead → required fields + duplicate check
// =====================================================================
(function () {
  const M = window.MSIHub; if (!M || !M._h) return;
  const H = M._h; const $ = (id) => document.getElementById(id); const esc = H.esc;
  const money = (v) => '$' + (Math.round(H.num(v) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money0 = (v) => '$' + Math.round(H.num(v)).toLocaleString('en-US');
  const ready = () => !!M.v6;
  const notReady = (what) => '<div style="border:1px dashed var(--border-strong);border-radius:12px;padding:18px;text-align:center;color:var(--gray-500);font-size:13px">' + what + ' needs the database update (supabase/schema-v6-automation.sql).</div>';
  const settingRow = (key) => M.data.agency_settings.find((r) => r.key === key);
  const cfg = () => Object.assign({ enabled: false, timezone: 'America/Los_Angeles', business_days: [1, 2, 3, 4, 5], start: '08:00', end: '19:00', business_days_only: true, holidays: [],
    stop_on_reply: true, stop_on_contact: true, shot_clock_days: 45, xdate_lead_days: 30, policy_term_months: 6, email_enabled: false, sms_optout_footer: true,
    email_from_name: 'MaxSave Insurance', email_from: '', email_reply_to: '', email_signature: '' }, (settingRow('automation') || {}).value || {});
  async function saveSetting(key, value) {
    const row = { key, value, updated_by: H.myId(), updated_at: new Date().toISOString() };
    const { error } = await M.sb.from('agency_settings').upsert(row, { onConflict: 'key' });
    if (error) throw error;
    const cur = settingRow(key); if (cur) cur.value = value; else M.data.agency_settings.push(row);
  }
  const fn = async (action, body) => {
    const { data, error } = await M.sb.functions.invoke('automation', { body: Object.assign({ action }, body || {}) });
    if (error) {
      let msg = error.message || 'Request failed';
      try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch (_e) { /* no body */ }
      if (/404|not found|Failed to send a request/i.test(msg)) msg = 'The automation service is not deployed yet';
      throw new Error(msg);
    }
    if (data && data.error) throw new Error(data.error);
    return data;
  };
  const when = (iso) => { if (!iso) return ''; const d = new Date(iso); return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); };
  const today = () => H.localISODate(new Date());
  const addMonths = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setMonth(d.getMonth() + n); return H.localISODate(d); };
  const daysUntil = (iso) => iso ? Math.round((new Date(iso + 'T00:00:00') - new Date(today() + 'T00:00:00')) / 86400000) : null;

  // ---- generic modal (promise) ----
  function modal(title, inner, buttons, opts) {
    return new Promise((resolve) => {
      let o = $('msihubModal');
      if (!o) { o = document.createElement('div'); o.id = 'msihubModal'; o.className = 'logout-overlay'; o.style.zIndex = '10005'; document.body.appendChild(o); }
      o.onclick = (e) => { if (e.target === o) { o.style.display = 'none'; resolve(null); } };
      o.innerHTML = '<div class="logout-modal" style="width:' + ((opts && opts.width) || 520) + 'px;max-width:96vw;text-align:left;max-height:92vh;overflow-y:auto" onclick="event.stopPropagation()">' +
        '<h2 style="margin:0 0 6px;font-size:19px">' + title + '</h2>' + inner +
        '<div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">' + buttons.map((b, i) => '<button class="btn ' + (b.primary ? 'btn-primary' : b.danger ? '' : 'btn-ghost') + '" data-i="' + i + '" style="flex:1;justify-content:center;min-width:120px' + (b.danger ? ';background:#FEE2E2;color:#DC2626;border:1px solid #FCA5A5' : '') + '">' + b.label + '</button>').join('') + '</div></div>';
      o.querySelectorAll('button[data-i]').forEach((btn) => { btn.onclick = async () => { const b = buttons[+btn.dataset.i]; const v = b.value ? (typeof b.value === 'function' ? await b.value() : b.value) : null; if (v === false) return; o.style.display = 'none'; resolve(v); }; });
      o.style.display = 'flex';
      if (opts && opts.focus) setTimeout(() => { const el = $(opts.focus); if (el) el.focus(); }, 40);
    });
  }
  const fg = (label, inner) => '<div class="form-group" style="margin-bottom:10px"><div class="form-label">' + label + '</div>' + inner + '</div>';
  const sel = (id, list, cur, extra) => '<select id="' + id + '" class="form-control"' + (extra || '') + '>' + list.map((x) => { const v = Array.isArray(x) ? x[0] : x, l = Array.isArray(x) ? x[1] : x; return '<option value="' + esc(String(v)) + '"' + (String(v) === String(cur == null ? '' : cur) ? ' selected' : '') + '>' + esc(String(l)) + '</option>'; }).join('') + '</select>';
  const inp = (id, val, type, ph) => '<input id="' + id + '" type="' + (type || 'text') + '" class="form-control" value="' + esc(val == null ? '' : String(val)) + '"' + (ph ? ' placeholder="' + esc(ph) + '"' : '') + '>';
  const gv = (id) => { const el = $(id); return el ? (el.type === 'checkbox' ? el.checked : el.value.trim()) : ''; };

  // ------------------------------------------------------------------
  // Settings lists kept in agency_settings: loss reasons, tags, required fields, email templates
  // ------------------------------------------------------------------
  const DEFAULTS = {
    loss_reasons: ['Price too high', 'Went with another agency', 'Could not reach', 'Bad phone number', 'Not interested', 'Already insured', 'Out of state', 'Duplicate', 'Did not qualify', 'Other'],
    tags: [{ name: 'Hot', color: '#DC2626' }, { name: 'Spanish', color: '#067C83' }, { name: 'SR-22', color: '#B45309' }, { name: 'Bundle', color: '#111111' }, { name: 'VIP', color: '#09C4CD' }, { name: 'Aged', color: '#696969' }, { name: 'X-Date', color: '#05646A' }],
    required_fields: { lead: ['first', 'phone'] },
    email_templates: [
      { id: 1, name: 'Quote follow-up', subject: 'Your auto insurance quote — MaxSave', body: 'Hi {{name}},\n\nThanks for reaching out about auto insurance. I\'d love to put together the best rate for you — a quick call is all it takes.\n\nReply to this email or call me anytime.\n\n{{agent}}\nMaxSave Insurance' },
      { id: 2, name: 'Documents needed', subject: 'A couple of things we need to finish your policy', body: 'Hi {{name}},\n\nTo finish your policy we still need:\n- a photo of your driver\'s license\n- your current declarations page (if you have one)\n\nYou can reply to this email with them attached.\n\n{{agent}}\nMaxSave Insurance' },
      { id: 3, name: 'Renewal review', subject: 'Time to review your {{policy}} policy', body: 'Hi {{name}},\n\nYour {{policy}} policy renews on {{expires}}. Let\'s make sure you still have the best coverage at the best price — it takes just a few minutes.\n\n{{agent}}\nMaxSave Insurance' },
    ],
  };
  const LEAD_FIELDS = [['first', 'First name', 'lf_first'], ['last', 'Last name', 'lf_last'], ['phone', 'Phone', 'lf_phone'], ['email', 'Email', 'lf_email'], ['source', 'Lead source', 'lf_source'], ['agent', 'Assigned agent', 'lf_agent'],
    ['dob', 'Date of birth', 'lf_dob'], ['address', 'Street address', 'lf_address'], ['city', 'City', 'lf_city'], ['zip', 'ZIP code', 'lf_zip'], ['vehicle', 'Vehicle (year / make / model)', 'lf_vmake'], ['xdate', 'Current policy renews (X-date)', 'lf_xdate']];
  function applyLists() {
    const seedable = ready() && H.isAdmin();
    for (const key of Object.keys(DEFAULTS)) {
      const row = settingRow(key);
      if (row && row.value != null) window[key.toUpperCase()] = row.value;
      else { window[key.toUpperCase()] = JSON.parse(JSON.stringify(DEFAULTS[key])); if (seedable) saveSetting(key, window[key.toUpperCase()]).catch(() => {}); }
    }
    window.TAG_LIST = window.TAGS;   // the leads page reads TAG_LIST
  }
  M.sourceNames = function (cur) {
    const names = (window.LEAD_SOURCES || []).filter((x) => x.active !== false).map((x) => x.name);
    const out = names.length ? names.slice() : ['Everquote', 'Facebook Ads', 'Google Ads', 'Referral', 'Direct Call', 'Cold Call', 'Walk-In', 'Website', 'Other'];
    if (cur && !out.includes(cur)) out.push(cur);
    if (!out.includes('Other')) out.push('Other');
    return out;
  };
  M.policyTerm = function (line) {
    const c = cfg(); const l = String(line || '').toLowerCase();
    return /auto|motor|commercial/.test(l) ? (parseInt(c.policy_term_months) || 6) : 12;
  };

  // ---- required fields + duplicate check (called from saveLeadForm) ----
  M.checkRequiredLeadFields = function (g) {
    const req = ((window.REQUIRED_FIELDS || {}).lead || []);
    const missing = LEAD_FIELDS.filter((f) => req.includes(f[0]) && !g(f[2])).map((f) => f[1]);
    if (!missing.length) return true;
    M.toast('Required: ' + missing.join(', '), 'warn');
    const first = LEAD_FIELDS.find((f) => req.includes(f[0]) && !g(f[2])); const el = first && $(first[2]); if (el) { el.focus(); el.style.borderColor = '#DC2626'; }
    return false;
  };
  M.findDuplicateLead = async function (phone, email) {
    const p = H.fmtPhone(phone); const e = (email || '').trim().toLowerCase();
    const local = (typeof LEADS !== 'undefined' ? LEADS : []).find((l) => (p && l.phone === p) || (e && (l.email || '').toLowerCase() === e));
    if (local) return { id: local.id, name: local.name, phone: local.phone, email: local.email, status: local.status, agent: local.agent, received: local.received };
    try {
      let q = M.sb.from('leads').select('id, first_name, last_name, phone, email, status, agent_id, received_at').order('received_at', { ascending: false }).limit(1);
      q = e ? q.or('phone.eq.' + JSON.stringify(p) + ',email.ilike.' + JSON.stringify(e)) : q.eq('phone', p);
      const { data } = await q;
      const r = data && data[0]; if (!r) return null;
      return { id: r.id, name: ((r.first_name || '') + ' ' + (r.last_name || '')).trim() || '(no name)', phone: r.phone, email: r.email, status: r.status, agent: H.agentName(r.agent_id), received: (r.received_at || '').slice(0, 10) };
    } catch (_e) { return null; }
  };
  M.confirmDuplicate = function (dup) {
    return modal('This lead may already exist',
      '<div style="background:var(--amber-light);border:1px solid #F5D08A;border-radius:12px;padding:12px 14px;font-size:13.5px;line-height:1.6"><b>' + esc(dup.name) + '</b><br>' + esc(dup.phone || '') + (dup.email ? ' · ' + esc(dup.email) : '') + '<br>' + esc(dup.status || '') + ' · ' + esc(dup.agent || 'Unassigned') + ' · received ' + esc(dup.received || '') + '</div>' +
      '<p style="font-size:13px;color:var(--gray-500);margin:12px 0 0">Open the existing lead instead of creating a second copy, or create it anyway if this is really a different person.</p>',
      [{ label: 'Open existing lead', primary: true, value: 'open' }, { label: 'Create anyway', value: 'create' }, { label: 'Cancel', value: 'cancel' }]).then((v) => (v === 'cancel' ? null : v));
  };

  // ---- Bad Lead needs a reason ----
  M.askLossReason = function (lead) {
    const reasons = window.LOSS_REASONS || DEFAULTS.loss_reasons;
    return modal('Why was ' + esc((lead && lead.name) || 'this lead') + ' lost?',
      fg('Reason *', sel('lr_reason', [''].concat(reasons), '')) + fg('Note (optional)', '<textarea id="lr_note" class="form-control" rows="2" placeholder="Anything worth remembering"></textarea>'),
      [{ label: 'Mark as lost', primary: true, value: () => { const r = gv('lr_reason'); if (!r) { M.toast('Pick a reason', 'warn'); return false; } return { reason: r, note: gv('lr_note') }; } }, { label: 'Cancel', value: 'cancel' }],
      { focus: 'lr_reason' }).then((v) => (!v || v === 'cancel' ? null : v));
  };

  // ------------------------------------------------------------------
  // Tags
  // ------------------------------------------------------------------
  const tagColor = (name) => { const t = (window.TAGS || []).find((x) => x.name === name); return (t && t.color) || '#696969'; };
  M.tagChips = function (tags, onRemove) {
    return (tags || []).map((t) => '<span style="display:inline-flex;align-items:center;gap:4px;background:' + tagColor(t) + '18;color:' + tagColor(t) + ';border:1px solid ' + tagColor(t) + '55;padding:1px 9px;border-radius:999px;font-size:11px;font-weight:500;white-space:nowrap">' + esc(t) + (onRemove ? '<span onclick="' + onRemove.replace('%s', esc(t).replace(/'/g, '&#39;')) + '" style="cursor:pointer;opacity:.7" title="Remove">✕</span>' : '') + '</span>').join('');
  };
  async function saveTags(table, id, tags) {
    await H.update(table, id, { tags });
    const row = M.data[table].find((r) => r.id === id); if (row) row.tags = tags;
    const ui = table === 'leads' ? (typeof LEADS !== 'undefined' && LEADS.find((l) => l.id === id)) : (typeof CUSTOMERS !== 'undefined' && CUSTOMERS.find((c) => c.id === id));
    if (ui) ui.tags = tags;
  }
  M.editTags = async function (table, id) {
    if (!ready()) { M.toast('Tags need the database update first', 'warn'); return; }
    const row = M.data[table].find((r) => r.id === id); if (!row) return;
    const cur = Array.isArray(row.tags) ? row.tags : [];
    const all = [...new Set([...(window.TAGS || []).map((t) => t.name), ...cur])];
    const v = await modal('Tags', '<div style="display:flex;flex-direction:column;gap:6px;max-height:300px;overflow-y:auto">' + all.map((t, i) => '<label style="display:flex;align-items:center;gap:10px;font-size:14px;cursor:pointer"><input type="checkbox" id="tg_' + i + '" ' + (cur.includes(t) ? 'checked' : '') + ' style="width:16px;height:16px;accent-color:#067C83">' + M.tagChips([t]) + '</label>').join('') + '</div>' +
      fg('New tag', inp('tg_new', '', 'text', 'Type a new tag and save')),
      [{ label: 'Save', primary: true, value: () => { const out = all.filter((t, i) => gv('tg_' + i)); const n = gv('tg_new'); if (n && !out.includes(n)) out.push(n); return { tags: out, added: n && !all.includes(n) ? n : null }; } }, { label: 'Cancel', value: 'cancel' }]);
    if (!v || v === 'cancel') return;
    try {
      if (v.added && H.isAdmin()) { window.TAGS.push({ name: v.added, color: '#696969' }); await saveSetting('tags', window.TAGS); }
      await saveTags(table, id, v.tags); M.toast('Tags saved'); M.refreshCurrentPage();
    } catch (e) { H.fail('Saving tags', e); }
  };
  M.removeTag = async function (table, id, tag) {
    const row = M.data[table].find((r) => r.id === id); if (!row) return;
    try { await saveTags(table, id, (row.tags || []).filter((t) => t !== tag)); M.refreshCurrentPage(); } catch (e) { H.fail('Removing tag', e); }
  };

  // ------------------------------------------------------------------
  // Sequences on a lead / customer
  // ------------------------------------------------------------------
  const rules = () => window.LIFECYCLE_RULES || [];
  const enrollmentsFor = (o) => M.data.enrollments.filter((e) => (o.lead && e.lead_id === o.lead.id) || (o.customer && e.customer_id === o.customer.id));
  function sequenceStripHTML(o) {
    if (!ready()) return '';
    const active = enrollmentsFor(o).filter((e) => e.status === 'active');
    const c = cfg();
    const startable = rules().filter((r) => (r.steps || []).length && !active.some((e) => e.rule_id === r.id) && (o.lead ? !/Policy expires|birthday|Extended fee/.test(r.triggerLabel) : !/^Lead|Policy expires/.test(r.triggerLabel)));
    const idArg = o.lead ? "'" + o.lead.id + "',null" : "null,'" + o.customer.id + "'";
    const rows = active.map((e) => {
      const stepsLeft = (e.plan || []).length - (e.step_no || 0);
      return '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--border);font-size:13px"><span style="font-size:15px">⚡</span><div style="flex:1;min-width:0"><div style="font-weight:500;color:var(--navy-900)">' + esc(e.rule_name) + '</div><div style="font-size:12px;color:var(--gray-500)">Step ' + ((e.step_no || 0) + 1) + ' of ' + (e.plan || []).length + ' · next ' + esc(when(e.next_run_at) || 'soon') + (stepsLeft > 1 ? ' · ' + stepsLeft + ' steps left' : '') + '</div></div>' +
        '<button type="button" onclick="MSIHub.stopEnrollment(' + e.id + ')" style="padding:6px 12px;border-radius:8px;border:1px solid var(--border);background:#fff;font-family:var(--font-body);font-size:12px;cursor:pointer">Stop</button></div>';
    }).join('');
    const recent = enrollmentsFor(o).filter((e) => e.status !== 'active').sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)).slice(0, 2).map((e) =>
      '<div style="font-size:12px;color:var(--gray-500);padding:4px 0">' + esc(e.rule_name) + ' · ' + (e.status === 'done' ? 'finished' : 'stopped: ' + esc(e.stop_reason || '')) + ' · ' + esc(when(e.updated_at)) + '</div>').join('');
    return '<div style="margin-top:14px;background:var(--gray-50);border-radius:12px;padding:10px 14px">' +
      '<div style="display:flex;align-items:center;gap:8px"><div style="flex:1;font-size:12px;font-weight:500;color:var(--gray-500);text-transform:uppercase;letter-spacing:.5px">Sequences' + (!c.enabled ? ' <span style="text-transform:none;letter-spacing:0;font-weight:400">(automation is switched off in Settings)</span>' : '') + '</div>' +
      (startable.length ? '<select onchange="if(this.value){MSIHub.enroll(' + idArg + ',+this.value);this.value=\'\'}" style="font-size:12px;padding:5px 8px;border:1px solid var(--border);border-radius:8px;background:#fff;font-family:var(--font-body)"><option value="">Start a sequence…</option>' + startable.map((r) => '<option value="' + r.id + '">' + esc(r.name) + (r.active ? '' : ' (paused)') + '</option>').join('') + '</select>' : '') + '</div>' +
      (rows || '<div style="font-size:12.5px;color:var(--gray-400);padding:6px 0 2px">Not in a sequence' + (o.lead && o.lead.doNotCall ? ' (Do Not Call)' : '') + '</div>') + recent + '</div>';
  }
  M.enroll = async function (leadId, customerId, ruleId) {
    try {
      const { error } = await M.sb.rpc('automation_enroll_manual', { p_rule_id: ruleId, p_lead: leadId || null, p_customer: customerId || null });
      if (error) throw error;
      await M.reload(['enrollments', 'automation_log']); M.toast('Sequence started'); M.refreshCurrentPage();
    } catch (e) { H.fail('Starting sequence', e); }
  };
  M.stopEnrollment = async function (id) {
    try {
      const { error } = await M.sb.rpc('automation_stop_manual', { p_id: id }); if (error) throw error;
      await M.reload(['enrollments', 'automation_log']); M.toast('Sequence stopped'); M.refreshCurrentPage();
    } catch (e) { H.fail('Stopping sequence', e); }
  };

  // ---- lead card extras: tags + sequences + lost reason; X-date row ----
  M.leadExtrasHTML = function (L) {
    const tags = '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:12px">' + M.tagChips(L.tags, "MSIHub.removeTag('leads','" + L.id + "','%s')") +
      '<button type="button" onclick="MSIHub.editTags(\'leads\',\'' + L.id + '\')" style="border:1px dashed var(--border-strong);background:transparent;border-radius:999px;padding:1px 9px;font-size:11px;color:var(--gray-500);cursor:pointer;font-family:var(--font-body)">+ tag</button></div>';
    const lost = L.status === 'Bad Lead' ? '<div style="margin-top:10px;font-size:13px;color:#DC2626">Lost' + (L.lossReason ? ': ' + esc(L.lossReason) : '') + (L.closedAt ? ' · ' + esc(when(L.closedAt)) : '') + '</div>' : '';
    const recycled = L.recycledAt ? '<div style="margin-top:8px;font-size:12.5px;color:var(--green-700)">♻ Recycled ' + esc(when(L.recycledAt)) + ' — their policy was up for renewal' + ((L.details || {}).x_date_prev ? ' on ' + esc(H.isoToUS((L.details || {}).x_date_prev)) : '') + '</div>' : '';
    return tags + lost + recycled + sequenceStripHTML({ lead: L });
  };
  M.leadXDateRow = function (L) {
    if (!ready()) return '';
    const d = L.xDate ? String(L.xDate).slice(0, 10) : ''; const n = daysUntil(d);
    const est = (L.details || {}).x_date_estimated && d;
    const val = d ? esc(H.isoToUS(d)) + (n != null ? ' <span style="color:' + (n <= 30 ? '#B45309' : 'var(--gray-500)') + ';font-size:12px">(' + (n < 0 ? Math.abs(n) + ' days ago' : 'in ' + n + ' days') + ')</span>' : '') + (est ? ' <span title="Estimated from the lead date — confirm with the customer" style="background:var(--amber-light);color:var(--amber);font-size:10px;font-weight:500;padding:1px 6px;border-radius:999px">estimated</span>' : '') : '<span style="color:var(--gray-300)">—</span>';
    return '<div style="display:grid;grid-template-columns:118px 1fr auto;gap:12px;padding:11px 0;border-bottom:1px solid var(--border);font-size:13.5px;align-items:center"><div style="font-size:12.5px;color:var(--gray-500)">Policy renews</div><div style="color:var(--navy-900)">' + val + '</div>' +
      '<button type="button" title="Set the date their current policy renews (X-date)" onclick="MSIHub.setXDate(\'' + L.id + '\')" style="background:none;border:none;cursor:pointer;color:var(--gray-500);font-size:14px">✎</button></div>';
  };
  M.setXDate = async function (id) {
    const L = (typeof LEADS !== 'undefined' ? LEADS : []).find((l) => l.id === id); if (!L) return;
    const v = await modal('When does their current policy renew?', fg('Renewal date (X-date)', inp('xd_date', L.xDate ? String(L.xDate).slice(0, 10) : '', 'date')) +
      '<p style="font-size:12.5px;color:var(--gray-500);margin:0">About ' + (cfg().xdate_lead_days || 30) + ' days before this date the lead comes back to the top of the list with an X-Date tag and a call task.</p>',
      [{ label: 'Save', primary: true, value: () => ({ date: gv('xd_date') || null }) }, { label: 'Cancel', value: 'cancel' }], { focus: 'xd_date' });
    if (!v || v === 'cancel') return;
    try {
      await H.update('leads', id, { x_date: v.date, details: Object.assign({}, L.details, { x_date_estimated: false }) });
      L.xDate = v.date || ''; L.details = Object.assign({}, L.details, { x_date_estimated: false }); const row = M.data.leads.find((r) => r.id === id); if (row) { row.x_date = v.date; row.details = L.details; }
      M.toast('X-date saved'); M.refreshCurrentPage();
    } catch (e) { H.fail('Saving X-date', e); }
  };

  // ------------------------------------------------------------------
  // Email (lead card + customer page)
  // ------------------------------------------------------------------
  const emailsFor = (o) => M.data.emails.filter((e) => (o.lead && (e.lead_id === o.lead.id || (o.lead.email && (e.to_email || '').toLowerCase() === o.lead.email.toLowerCase()))) || (o.customer && (e.customer_id === o.customer.id || (o.customer.email && (e.to_email || '').toLowerCase() === o.customer.email.toLowerCase()))));
  M.emailCount = (o) => emailsFor(o).length;
  M.emailPanelHTML = function (o) {
    const who = o.lead || o.customer; const to = (who && who.email) || ''; const first = (who && (who.first || (who.name || '').split(' ')[0])) || '';
    const list = emailsFor(o).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const thread = list.length ? list.map((e) => '<div style="padding:10px 12px;border:1px solid var(--border);border-radius:12px;margin-bottom:8px;background:' + (e.direction === 'inbound' ? 'var(--green-50)' : '#fff') + '"><div style="display:flex;gap:8px;align-items:center;font-size:12px;color:var(--gray-500)"><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">' + (e.direction === 'inbound' ? 'From ' : 'To ') + esc(e.to_email) + (e.agent_id ? ' · ' + esc(H.agentName(e.agent_id)) : '') + (e.source === 'automation' ? ' · automated' : '') + '</span><span>' + esc(when(e.created_at)) + '</span>' +
        (e.status === 'failed' ? '<span style="color:#DC2626">Not sent' + (e.error ? ': ' + esc(e.error) : '') + '</span>' : e.status === 'skipped' ? '<span style="color:#B45309">Skipped</span>' : '') + '</div>' +
        '<div style="font-weight:500;font-size:13.5px;color:var(--navy-900);margin-top:4px">' + esc(e.subject || '(no subject)') + '</div><div style="font-size:13px;color:var(--gray-700);white-space:pre-wrap;margin-top:4px;max-height:140px;overflow:auto">' + esc(e.body || '') + '</div></div>').join('')
      : '<div style="border:1px dashed var(--border-strong);border-radius:12px;padding:22px;text-align:center;color:var(--gray-500);font-size:13px">No emails with ' + esc(first || 'this contact') + ' yet</div>';
    const c = cfg(); const tmpl = window.EMAIL_TEMPLATES || [];
    const target = o.lead ? "{lead:'" + o.lead.id + "'}" : "{customer:'" + o.customer.id + "'}";
    const composer = '<div style="background:var(--gray-50);border-radius:14px;padding:12px;margin-top:12px">' +
      (!ready() ? '<div style="font-size:12.5px;color:var(--gray-500);margin-bottom:8px">Email sending needs the database update and the automation service.</div>' : !c.email_enabled ? '<div style="font-size:12.5px;color:#B45309;margin-bottom:8px">Email sending is switched off — an admin can turn it on in Settings → Lifecycle Automation.</div>' : '') +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px"><input id="cdEmailTo" class="form-control" type="email" placeholder="To" value="' + esc(to) + '" style="font-size:13px;width:100%;box-sizing:border-box">' +
      '<select id="cdEmailTemplate" class="form-control" style="font-size:13px;width:100%;box-sizing:border-box" onchange="MSIHub.applyEmailTemplate(this,' + target + ')"><option value="">Insert a template…</option>' + tmpl.map((t) => '<option value="' + t.id + '">' + esc(t.name) + '</option>').join('') + '</select></div>' +
      '<input id="cdEmailSubject" class="form-control" placeholder="Subject" style="display:block;width:100%;box-sizing:border-box;font-size:13px;margin-bottom:8px">' +
      '<textarea id="cdEmailBody" class="form-control" rows="6" placeholder="Write to ' + esc(first || 'them') + '…" style="display:block;width:100%;box-sizing:border-box;font-family:var(--font-body);font-size:14px;line-height:1.45;resize:vertical;background:#fff;border-radius:12px;padding:10px 14px"></textarea>' +
      '<div style="display:flex;align-items:center;gap:8px;margin-top:8px"><div style="flex:1;font-size:11.5px;color:var(--gray-400)">Sent from ' + esc(c.email_from || 'the agency address') + ' · replies go to ' + esc(c.email_reply_to || c.email_from || 'the agency address') + ' · an unsubscribe link is added automatically</div>' +
      '<button type="button" id="cdEmailSend" onclick="MSIHub.sendEmail(' + target + ')" class="btn btn-primary" style="font-size:13px;padding:9px 20px">Send email</button></div></div>';
    return '<div style="max-height:340px;overflow-y:auto">' + thread + '</div>' + composer;
  };
  const merge = (text, who) => String(text || '').replace(/\{\{\s*name\s*\}\}/gi, (who.first || (who.name || '').split(' ')[0] || 'there')).replace(/\{\{\s*full_name\s*\}\}/gi, who.name || '').replace(/\{\{\s*agent\s*\}\}/gi, H.me().full_name || '').replace(/\{\{\s*agent_phone\s*\}\}/gi, H.me().telnyx_number || H.me().phone || '').replace(/\{\{\s*policy\s*\}\}/gi, who.policy || (who.policies && who.policies[0] && who.policies[0].line) || 'auto').replace(/\{\{\s*expires\s*\}\}/gi, who.policies && who.policies[0] ? H.isoToUS(who.policies[0].expires) : (who.xDate ? H.isoToUS(who.xDate) : '')).replace(/\{\{\s*carrier\s*\}\}/gi, who.carrier || (who.policies && who.policies[0] && who.policies[0].carrier) || '').replace(/\{\{\s*amount\s*\}\}/gi, '');
  const whoFor = (t) => t.lead ? (typeof LEADS !== 'undefined' ? LEADS : []).find((l) => l.id === t.lead) : (typeof CUSTOMERS !== 'undefined' ? CUSTOMERS : []).find((c) => c.id === t.customer);
  M.applyEmailTemplate = function (selEl, t) {
    const tp = (window.EMAIL_TEMPLATES || []).find((x) => String(x.id) === selEl.value); selEl.value = ''; const who = whoFor(t); if (!tp || !who) return;
    $('cdEmailSubject').value = merge(tp.subject, who); $('cdEmailBody').value = merge(tp.body, who); $('cdEmailBody').focus();
  };
  M.sendEmail = async function (t) {
    const who = whoFor(t); if (!who) return;
    const to = gv('cdEmailTo'), subject = gv('cdEmailSubject'), body = gv('cdEmailBody');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) { M.toast('Enter a valid email address', 'warn'); return; }
    if (!body) { M.toast('Write a message first', 'warn'); return; }
    const btn = $('cdEmailSend'); if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    try {
      const r = await fn('email', { to, to_name: who.name, subject, body, lead_id: t.lead || null, customer_id: t.customer || null });
      if (r && r.row) M.data.emails.push(r.row);
      if (r && r.warning) M.toast(r.warning, 'warn'); else M.toast('Email sent');
      if (who.email !== to && !who.email) { try { await H.update(t.lead ? 'leads' : 'customers', who.id, { email: to }); who.email = to; } catch (_e) { /* optional */ } }
      M.refreshCurrentPage();
    } catch (e) { M.toast(e.message || 'Email not sent', 'error'); if (btn) { btn.disabled = false; btn.textContent = 'Send email'; } }
  };

  // ------------------------------------------------------------------
  // Customer page extras + policies
  // ------------------------------------------------------------------
  M.customerExtrasHTML = function (c) {
    const tags = '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">' + M.tagChips(c.tags || [], "MSIHub.removeTag('customers','" + c.id + "','%s')") +
      '<button type="button" onclick="MSIHub.editTags(\'customers\',\'' + c.id + '\')" style="border:1px dashed var(--border-strong);background:transparent;border-radius:999px;padding:1px 9px;font-size:11px;color:var(--gray-500);cursor:pointer;font-family:var(--font-body)">+ tag</button></div>';
    const strip = sequenceStripHTML({ customer: c });
    return '<div style="background:#fff;border:1px solid var(--border);border-radius:var(--radius-xl);padding:12px 18px">' + tags + strip.replace('margin-top:14px;', 'margin-top:10px;') + '</div>';
  };
  const custById = (id) => (typeof CUSTOMERS !== 'undefined' ? CUSTOMERS : []).find((c) => c.id === id);
  M.openPolicyForm = async function (custId, policyId) {
    if (!ready()) { M.toast('Policy editing needs the database update first', 'warn'); return; }
    const c = custById(custId); if (!c) return;
    const P = policyId ? M.data.policies.find((p) => p.id === policyId) : null;
    const carriers = [...new Set([...(window.CARRIER_DATA || []).filter((x) => x.active !== false).map((x) => x.name), P && P.carrier].filter(Boolean))];
    const agents = [['', '—']].concat(M.agents().map((a) => [a.id, a.full_name]));
    const lines = ['Auto', 'Auto — Non-Standard', 'Auto — Standard', 'SR-22', 'Commercial Auto', 'Motorcycle', 'Home', 'Renters', 'Life', 'Umbrella', 'Other'];
    const eff = P ? P.effective_date : today(); const term = P ? (P.term_months || 6) : M.policyTerm('Auto');
    const v = await modal(P ? 'Edit policy' : 'Add policy for ' + esc(c.name || (c.first + ' ' + c.last)),
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 12px">' +
      fg('Line', sel('pf_line', [...new Set(lines.concat(P && P.line ? [P.line] : []))], P ? P.line : 'Auto')) + fg('Carrier', sel('pf_carrier', carriers.length ? carriers : ['Other'], P ? P.carrier : carriers[0])) +
      fg('Policy #', inp('pf_number', P ? P.policy_number : '')) + fg('Status', sel('pf_status', ['Active', 'Pending Cancellation', 'Cancelled', 'Renewed', 'Expired', 'Voided'], P ? P.status : 'Active')) +
      fg('Effective date', inp('pf_eff', eff, 'date')) + fg('Term', sel('pf_term', [[6, '6 months'], [12, '12 months'], [1, '1 month'], [3, '3 months']], term, ' onchange="var e=document.getElementById(\'pf_eff\').value;if(e){document.getElementById(\'pf_exp\').value=MSIHub.addMonths(e,+this.value)}"')) +
      fg('Expiration date', inp('pf_exp', P ? P.expires_date : addMonths(eff, term), 'date')) + fg('Premium (term)', inp('pf_premium', P ? P.premium : '', 'number')) +
      fg('Broker fee total', inp('pf_fee', P ? P.fee_total : '', 'number')) + fg('Fee collected', inp('pf_feec', P ? P.fee_collected : '', 'number')) +
      fg('Fee extended (owed)', inp('pf_feex', P ? P.fee_extended : '', 'number')) + fg('Towing premium', inp('pf_tow', P ? P.towing_premium : '', 'number')) +
      fg('Producer', sel('pf_producer', agents, P ? P.sold_by_id : H.myId())) + fg('CSR', sel('pf_csr', agents, P ? P.csr_id : '')) +
      '</div>' + fg('Notes', '<textarea id="pf_notes" class="form-control" rows="2">' + esc(P ? P.notes || '' : '') + '</textarea>'),
      [{ label: P ? 'Save changes' : 'Add policy', primary: true, value: () => { if (!gv('pf_eff')) { M.toast('Effective date is required', 'warn'); return false; } return {
        line: gv('pf_line'), carrier: gv('pf_carrier'), policy_number: gv('pf_number') || null, status: gv('pf_status'), effective_date: gv('pf_eff'), term_months: +gv('pf_term') || 6, expires_date: gv('pf_exp') || addMonths(gv('pf_eff'), +gv('pf_term') || 6),
        premium: H.num(gv('pf_premium')), fee_total: H.num(gv('pf_fee')), fee_collected: H.num(gv('pf_feec')), fee_extended: H.num(gv('pf_feex')), towing_premium: H.num(gv('pf_tow')), sold_by_id: gv('pf_producer') || null, csr_id: gv('pf_csr') || null, notes: gv('pf_notes') || null }; } }, { label: 'Cancel', value: 'cancel' }], { width: 640 });
    if (!v || v === 'cancel') return;
    try {
      if (P) await H.update('policies', P.id, v); else await H.insert('policies', Object.assign({ customer_id: c.id, hcc_collected: false }, v));
      await M.reload(['policies', 'customers']); M.toast(P ? 'Policy updated' : 'Policy added'); M.refreshCurrentPage();
    } catch (e) { H.fail('Saving policy', e); }
  };
  M.addMonths = addMonths;
  M.renewPolicy = async function (policyId) {
    const P = M.data.policies.find((p) => p.id === policyId); if (!P) return;
    const term = P.term_months || M.policyTerm(P.line); const eff = P.expires_date || today();
    const v = await modal('Renew ' + esc(P.carrier || '') + ' ' + esc(P.line || ''),
      '<p style="font-size:13px;color:var(--gray-500);margin:0 0 10px">A new term is added and the current one is marked Renewed.</p>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 12px">' + fg('New effective date', inp('rn_eff', eff, 'date')) + fg('Term', sel('rn_term', [[6, '6 months'], [12, '12 months'], [3, '3 months'], [1, '1 month']], term)) +
      fg('New policy # (if changed)', inp('rn_number', P.policy_number || '')) + fg('New term premium', inp('rn_premium', P.premium, 'number')) + fg('Carrier', inp('rn_carrier', P.carrier || '')) + fg('Broker fee collected', inp('rn_fee', 0, 'number')) + '</div>',
      [{ label: 'Renew policy', primary: true, value: () => ({ eff: gv('rn_eff'), term: +gv('rn_term') || 6, number: gv('rn_number'), premium: H.num(gv('rn_premium')), carrier: gv('rn_carrier'), fee: H.num(gv('rn_fee')) }) }, { label: 'Cancel', value: 'cancel' }]);
    if (!v || v === 'cancel' || !v.eff) return;
    try {
      await H.insert('policies', { customer_id: P.customer_id, sale_id: null, line: P.line, carrier: v.carrier || P.carrier, policy_number: v.number || P.policy_number, sold_by_id: P.sold_by_id, csr_id: P.csr_id || null, effective_date: v.eff, expires_date: addMonths(v.eff, v.term), term_months: v.term,
        premium: v.premium, towing_premium: P.towing_premium || 0, fee_total: v.fee, fee_collected: v.fee, fee_extended: 0, hcc_collected: false, status: 'Active', renewed_from: P.id });
      await H.update('policies', P.id, { status: 'Renewed' });
      await M.reload(['policies', 'customers', 'enrollments']); M.toast('Policy renewed'); M.refreshCurrentPage();
    } catch (e) { H.fail('Renewing policy', e); }
  };
  M.cancelPolicyDb = async function (policyId) {
    const P = M.data.policies.find((p) => p.id === policyId); if (!P) return;
    const reasons = ['Price', 'Non-payment', 'Switched carriers', 'Sold the vehicle', 'Moved out of state', 'Customer request', 'Underwriting', 'Other'];
    const v = await modal('Cancel ' + esc(P.carrier || '') + ' ' + esc(P.line || '') + (P.policy_number ? ' #' + esc(P.policy_number) : ''),
      fg('Reason *', sel('cp_reason', [''].concat(reasons), '')) + fg('Cancellation date', inp('cp_date', today(), 'date')) + fg('Note', '<textarea id="cp_note" class="form-control" rows="2"></textarea>'),
      [{ label: 'Cancel policy', danger: true, value: () => { if (!gv('cp_reason')) { M.toast('Pick a reason', 'warn'); return false; } return { reason: gv('cp_reason'), date: gv('cp_date') || today(), note: gv('cp_note') }; } }, { label: 'Keep it', value: 'keep' }]);
    if (!v || v === 'keep') return;
    try {
      await H.update('policies', P.id, { status: 'Cancelled', cancel_reason: v.reason + (v.note ? ' — ' + v.note : ''), cancelled_at: v.date });
      const others = M.data.policies.filter((p) => p.customer_id === P.customer_id && p.id !== P.id && p.status === 'Active');
      if (!others.length) await H.update('customers', P.customer_id, { status: 'Cancelled' });
      await M.reload(['policies', 'customers', 'enrollments']); M.toast('Policy cancelled' + (!others.length ? ' — customer marked Cancelled' : '')); M.refreshCurrentPage();
    } catch (e) { H.fail('Cancelling policy', e); }
  };

  // ------------------------------------------------------------------
  // Renewals page
  // ------------------------------------------------------------------
  window.PAGES = window.PAGES || {}; window.PAGES.renewals = '';
  window.RENEWALS_STATE = window.RENEWALS_STATE || { tab: 'policies', window: 60, agent: 'All' };
  window.PAGE_INIT = window.PAGE_INIT || {};
  PAGE_INIT.renewals = function () {
    const s = window.RENEWALS_STATE; const el = document.querySelector('#content .page-content') || $('content'); if (!el) return;
    const chip = (n) => { if (n == null) return ''; const c = n < 0 ? '#DC2626' : n <= 14 ? '#DC2626' : n <= 30 ? '#B45309' : '#067C83'; return '<span style="background:' + c + '18;color:' + c + ';border:1px solid ' + c + '55;padding:2px 9px;border-radius:999px;font-size:11.5px;font-weight:500;white-space:nowrap">' + (n < 0 ? Math.abs(n) + 'd overdue' : n === 0 ? 'today' : n + 'd') + '</span>'; };
    const agents = ['All', ...M.agents().map((a) => a.full_name)];
    const toolbar = '<div class="filter-bar"><span class="filter-label">Show:</span>' + [['policies', 'Policies renewing'], ['xdate', 'X-date leads'], ['lapsed', 'Lapsed / cancelled']].map((t) => '<button class="btn ' + (s.tab === t[0] ? 'btn-primary' : 'btn-ghost') + '" style="font-size:12px;padding:6px 14px" onclick="window.RENEWALS_STATE.tab=\'' + t[0] + '\';PAGE_INIT.renewals()">' + t[1] + '</button>').join('') +
      '<span class="filter-label" style="margin-left:10px">Next:</span><select class="filter-select" onchange="window.RENEWALS_STATE.window=+this.value;PAGE_INIT.renewals()">' + [30, 60, 90, 180].map((n) => '<option value="' + n + '"' + (s.window === n ? ' selected' : '') + '>' + n + ' days</option>').join('') + '</select>' +
      '<span class="filter-label">Agent:</span><select class="filter-select" onchange="window.RENEWALS_STATE.agent=this.value;PAGE_INIT.renewals()">' + agents.map((a) => '<option' + (s.agent === a ? ' selected' : '') + '>' + esc(a) + '</option>').join('') + '</select></div>';
    let body = '';
    const seqFor = (f) => M.data.enrollments.filter((e) => e.status === 'active' && f(e));
    if (s.tab === 'policies' || s.tab === 'lapsed') {
      const cmap = {}; (typeof CUSTOMERS !== 'undefined' ? CUSTOMERS : []).forEach((c) => { cmap[c.id] = c; });
      let rows = M.data.policies.map((p) => ({ p, c: cmap[p.customer_id], days: daysUntil(p.expires_date) })).filter((r) => r.c);
      rows = s.tab === 'policies' ? rows.filter((r) => r.p.status === 'Active' && r.days != null && r.days <= s.window && r.days >= -30)
        : rows.filter((r) => (r.p.status === 'Cancelled' || r.p.status === 'Expired' || (r.p.status === 'Active' && r.days != null && r.days < -30)) && new Date(r.p.updated_at || r.p.created_at) > new Date(Date.now() - 180 * 86400000));
      if (s.agent !== 'All') rows = rows.filter((r) => H.agentName(r.p.csr_id || r.p.sold_by_id) === s.agent || r.c.agent === s.agent);
      rows.sort((a, b) => (a.days == null ? 9e9 : a.days) - (b.days == null ? 9e9 : b.days));
      const sum = rows.reduce((t, r) => t + H.num(r.p.premium), 0);
      body = '<div class="kpi-grid" style="margin-bottom:14px;grid-template-columns:repeat(4,1fr)">' +
        '<div class="kpi-card accent"><div class="kpi-label">' + (s.tab === 'policies' ? 'Renewing in ' + s.window + ' days' : 'Lapsed / cancelled (6 mo)') + '</div><div class="kpi-value">' + rows.length + '</div><div class="kpi-sub">policies</div></div>' +
        '<div class="kpi-card accent"><div class="kpi-label">Premium at stake</div><div class="kpi-value">' + money0(sum) + '</div><div class="kpi-sub">term premium</div></div>' +
        '<div class="kpi-card accent-amber"><div class="kpi-label">Next 14 days</div><div class="kpi-value amber">' + rows.filter((r) => r.days != null && r.days >= 0 && r.days <= 14).length + '</div><div class="kpi-sub">need a call now</div></div>' +
        '<div class="kpi-card accent-red"><div class="kpi-label">Overdue</div><div class="kpi-value red">' + rows.filter((r) => r.days != null && r.days < 0).length + '</div><div class="kpi-sub">past expiration, still Active</div></div></div>' +
        '<div class="card"><div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Customer</th><th>Policy</th><th>Expires</th><th>Premium</th><th>Producer / CSR</th><th>Sequence</th><th>Actions</th></tr></thead><tbody>' +
        (rows.length ? rows.map((r) => { const seq = seqFor((e) => e.policy_id === r.p.id)[0]; return '<tr><td><div class="lead-name-link" onclick="openCustomerDetail(\'' + r.c.id + '\')" style="font-weight:500;cursor:pointer;font-size:15px">' + esc(r.c.name || (r.c.first + ' ' + r.c.last)) + '</div><div style="font-size:12.5px;color:var(--gray-500)">' + esc(r.c.phone || '') + '</div></td>' +
          '<td style="font-size:13px"><div>' + esc(r.p.carrier || '—') + ' · ' + esc(r.p.line || '') + '</div><div style="font-family:monospace;font-size:11.5px;color:var(--gray-500)">' + esc(r.p.policy_number || '') + (r.p.status !== 'Active' ? ' · ' + esc(r.p.status) : '') + '</div></td>' +
          '<td style="font-size:13px">' + esc(H.isoToUS(r.p.expires_date || '')) + ' ' + chip(r.days) + '</td><td style="font-size:13px">' + money0(r.p.premium) + '</td>' +
          '<td style="font-size:13px">' + esc(H.agentName(r.p.sold_by_id)) + (r.p.csr_id ? ' / ' + esc(H.agentName(r.p.csr_id)) : '') + '</td>' +
          '<td style="font-size:12.5px;color:var(--gray-500)">' + (seq ? '⚡ ' + esc(seq.rule_name) + '<br>step ' + ((seq.step_no || 0) + 1) + ' · ' + esc(when(seq.next_run_at)) : '—') + '</td>' +
          '<td><div style="display:flex;gap:6px;flex-wrap:wrap">' + (r.c.phone ? '<button type="button" onclick="doCall(\'' + esc(r.c.name || '').replace(/'/g, '') + '\',\'' + esc(r.c.phone) + '\')" style="background:#067C83;color:#fff;border:none;border-radius:20px;padding:6px 12px;font-size:12px;cursor:pointer;font-family:var(--font-body)">Call</button>' : '') +
          (s.tab === 'policies' ? '<button type="button" onclick="MSIHub.renewPolicy(\'' + r.p.id + '\')" style="background:#E6F9FA;color:#067C83;border:1px solid #5FD9DF;border-radius:20px;padding:6px 12px;font-size:12px;cursor:pointer;font-family:var(--font-body)">Renew</button><button type="button" onclick="MSIHub.cancelPolicyDb(\'' + r.p.id + '\')" style="background:#fff;border:1px solid var(--border);border-radius:20px;padding:6px 12px;font-size:12px;cursor:pointer;font-family:var(--font-body)">Cancel</button>' : '') + '</div></td></tr>'; }).join('')
        : '<tr><td colspan="7" style="text-align:center;padding:36px;color:var(--gray-400)">Nothing in this window.</td></tr>') + '</tbody></table></div></div>';
    } else {
      let rows = (typeof LEADS !== 'undefined' ? LEADS : []).filter((l) => l.xDate && l.status !== 'Sold' && l.status !== 'Bad Lead' && !l.doNotCall).map((l) => ({ l, days: daysUntil(String(l.xDate).slice(0, 10)) })).filter((r) => r.days != null && r.days <= s.window && r.days >= -14);
      if (s.agent !== 'All') rows = rows.filter((r) => r.l.agent === s.agent);
      rows.sort((a, b) => a.days - b.days);
      const c = cfg();
      body = '<div style="background:var(--green-50);border:1px solid var(--green-200);border-radius:12px;padding:12px 16px;font-size:13px;color:var(--gray-700);margin-bottom:14px">Unsold leads whose current policy renews soon. ' + (c.xdate_lead_days || 30) + ' days before the X-date each lead comes back to the top of the list as New with an X-Date tag, a call task and the "Lead is recycled (X-date)" sequence. Leads with no contact for ' + (c.shot_clock_days || 45) + ' days are tagged Aged and get an estimated X-date (' + (c.policy_term_months || 6) + ' months after they came in).</div>' +
        '<div class="card"><div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Lead</th><th>Status</th><th>Policy renews</th><th>Agent</th><th>Source</th><th>Sequence</th><th>Actions</th></tr></thead><tbody>' +
        (rows.length ? rows.map((r) => { const seq = seqFor((e) => e.lead_id === r.l.id)[0]; return '<tr><td><div class="lead-name-link" onclick="openLeadDetail(\'' + r.l.id + '\')" style="font-weight:500;cursor:pointer;font-size:15px">' + esc(r.l.name) + '</div><div style="font-size:12.5px;color:var(--gray-500)">' + esc(r.l.phone) + '</div>' + M.tagChips(r.l.tags) + '</td>' +
          '<td><span class="badge ' + (typeof statusBadge === 'function' ? statusBadge(r.l.status) : '') + '">' + esc(r.l.status) + '</span></td><td style="font-size:13px">' + esc(H.isoToUS(String(r.l.xDate).slice(0, 10))) + ' ' + chip(r.days) + ((r.l.details || {}).x_date_estimated ? ' <span style="font-size:10.5px;color:var(--amber)">est.</span>' : '') + '</td>' +
          '<td style="font-size:13px">' + esc(r.l.agent) + '</td><td style="font-size:13px">' + esc(r.l.source || '') + '</td><td style="font-size:12.5px;color:var(--gray-500)">' + (seq ? '⚡ ' + esc(seq.rule_name) : '—') + '</td>' +
          '<td><div style="display:flex;gap:6px"><button type="button" onclick="leadCall(\'' + r.l.id + '\')" style="background:#067C83;color:#fff;border:none;border-radius:20px;padding:6px 12px;font-size:12px;cursor:pointer;font-family:var(--font-body)">Call</button><button type="button" onclick="MSIHub.setXDate(\'' + r.l.id + '\')" style="background:#fff;border:1px solid var(--border);border-radius:20px;padding:6px 12px;font-size:12px;cursor:pointer;font-family:var(--font-body)">Edit date</button></div></td></tr>'; }).join('')
        : '<tr><td colspan="7" style="text-align:center;padding:36px;color:var(--gray-400)">No X-dates in this window. Set one on a lead card (pencil next to "Policy renews").</td></tr>') + '</tbody></table></div></div>';
    }
    el.innerHTML = '<div class="page-header"><div class="page-header-left"><h1>Renewals &amp; X-Dates</h1><p>Policies coming up for renewal, and unsold leads whose current policy is about to renew</p></div></div>' + toolbar + (ready() ? body : notReady('The renewals page'));
  };

  // ------------------------------------------------------------------
  // Settings → Lifecycle Automation: engine settings, email, status, email templates
  // ------------------------------------------------------------------
  const TZS = [['America/Los_Angeles', 'Pacific'], ['America/Denver', 'Mountain'], ['America/Phoenix', 'Arizona'], ['America/Chicago', 'Central'], ['America/New_York', 'Eastern']];
  const card = (title, sub, inner, right) => '<div class="card" style="margin-bottom:14px;overflow:visible"><div class="card-header"><div><div class="card-title">' + title + '</div>' + (sub ? '<div style="font-size:13px;color:var(--gray-500);margin-top:3px">' + sub + '</div>' : '') + '</div>' + (right || '') + '</div><div style="padding:16px 20px">' + inner + '</div></div>';
  const toggle = (id, label, on, hint) => '<label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:6px 0"><input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + ' style="width:17px;height:17px;accent-color:#067C83"><span style="font-size:14px;color:var(--navy-900)">' + label + '</span>' + (hint ? '<span style="font-size:12px;color:var(--gray-400)">' + hint + '</span>' : '') + '</label>';
  function automationSettingsHTML() {
    const c = cfg(); const st = M.autoStatus || null; const state = (settingRow('automation_state') || {}).value || {};
    if (!ready()) return card('Automation engine', '', notReady('Running sequences'));
    const status = '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px">' + [
      ['Running now', st ? st.active : (M.data.enrollments || []).filter((e) => e.status === 'active').length, 'leads & customers in a sequence'],
      ['Due', st ? st.due : '—', 'steps waiting for the next run'],
      ['Sent today', st ? st.sent_today : '—', 'texts, emails and tasks'],
      ['Failed today', st ? st.failed_today : '—', 'see the log below']].map((k) => '<div style="background:var(--gray-50);border-radius:12px;padding:12px 14px"><div style="font-size:11.5px;color:var(--gray-500);font-weight:500">' + k[0] + '</div><div style="font-size:24px;font-weight:500;font-family:var(--font-display)">' + k[1] + '</div><div style="font-size:11.5px;color:var(--gray-400)">' + k[2] + '</div></div>').join('') + '</div>' +
      '<div style="font-size:12.5px;color:var(--gray-500);margin-bottom:12px">Last run: ' + (state.last_tick_at ? esc(when(state.last_tick_at)) + (state.last_tick ? ' (' + state.last_tick.sent + ' sent, ' + state.last_tick.tasks + ' tasks, ' + state.last_tick.skipped + ' skipped, ' + state.last_tick.failed + ' failed)' : '') : 'never — the 5-minute schedule starts once the service is deployed') +
      ' · Daily jobs: ' + (state.last_daily_at ? esc(when(state.last_daily_at)) + ' (' + (state.renewals || 0) + ' renewals, ' + (state.aged || 0) + ' aged, ' + (state.recycled || 0) + ' recycled, ' + (state.birthdays || 0) + ' birthdays)' : 'not yet') +
      (st && st.email ? ' · Email service: ' + (st.email.api_key ? 'connected' : '<span style="color:#B45309">no API key set</span>') : '') + '</div>';
    const days = c.business_days || [1, 2, 3, 4, 5];
    const inner = status +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 28px">' +
      '<div>' + toggle('au_enabled', 'Automation is ON', c.enabled, 'nothing sends while this is off') +
      toggle('au_bdays', 'Only during business hours', c.business_days_only !== false) +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin:6px 0 10px 27px">' + ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d, i) => '<label style="display:flex;align-items:center;gap:4px;font-size:12.5px;cursor:pointer"><input type="checkbox" id="au_d' + (i + 1) + '"' + (days.includes(i + 1) ? ' checked' : '') + ' style="accent-color:#067C83">' + d + '</label>').join('') + '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-left:27px">' + fg('From', inp('au_start', c.start || '08:00', 'time')) + fg('To', inp('au_end', c.end || '19:00', 'time')) + fg('Time zone', sel('au_tz', TZS, c.timezone || 'America/Los_Angeles')) + '</div>' +
      fg('Skip these dates (holidays)', inp('au_holidays', (c.holidays || []).join(', '), 'text', '2026-12-25, 2027-01-01')) + '</div>' +
      '<div>' + toggle('au_reply', 'Stop when they reply', c.stop_on_reply !== false, 'inbound text or email') + toggle('au_contact', 'Stop when a call connects', c.stop_on_contact !== false, '20 seconds or more') + toggle('au_footer', 'Add "Reply STOP to opt out" to the first automated text', c.sms_optout_footer !== false) +
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:8px">' + fg('Shot clock (days)', inp('au_shot', c.shot_clock_days == null ? 45 : c.shot_clock_days, 'number')) + fg('X-date lead time (days)', inp('au_xlead', c.xdate_lead_days == null ? 30 : c.xdate_lead_days, 'number')) + fg('Auto policy term (months)', sel('au_term', [[6, '6'], [12, '12']], c.policy_term_months || 6)) + '</div>' +
      '<div style="font-size:12px;color:var(--gray-500);margin-top:-4px">Shot clock: an open lead with no activity for this many days is tagged <b>Aged</b>, set to Follow Up, given an estimated X-date and dropped into the "Lead has no contact in" sequence (0 = off). Only leads received since ' + esc(c.shot_clock_since || 'the day you switch it on') + ' count.</div></div></div>' +
      '<div style="display:flex;gap:8px;margin-top:14px;align-items:center"><button class="btn btn-primary" style="font-size:13px" onclick="MSIHub.saveAutomationSettings()">Save settings</button><button class="btn btn-ghost" style="font-size:13px" onclick="MSIHub.runAutomationNow()">Run now</button><button class="btn btn-ghost" style="font-size:13px" onclick="MSIHub.checkAutomation()">Check service</button><span id="au_msg" style="font-size:12.5px;color:var(--gray-500)"></span></div>';
    const email = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px">' + toggle('au_email', 'Email sending is ON', c.email_enabled) + '<div></div>' +
      fg('From name', inp('au_from_name', c.email_from_name || 'MaxSave Insurance')) + fg('From address (a verified Brevo sender)', inp('au_from', c.email_from || '', 'email', 'hello@maxsaveins.com')) +
      fg('Reply-to address', inp('au_reply_to', c.email_reply_to || '', 'email', 'tonyb@maxsaveins.com')) + fg('Footer line (address / license #)', inp('au_footer_line', c.email_footer || '', 'text', 'MaxSave Insurance · San Diego, CA · CA Lic #0000000')) +
      '</div>' + fg('Signature (added under every email)', '<textarea id="au_sig" class="form-control" rows="3">' + esc(c.email_signature || '') + '</textarea>') +
      '<div style="font-size:12.5px;color:var(--gray-500);margin-bottom:10px">Emails go out through Brevo. The API key is a server secret (BREVO_API_KEY on the automation service), never stored here. Every email carries a one-click unsubscribe link; unsubscribed addresses are refused automatically.</div>' +
      '<div style="display:flex;gap:8px"><button class="btn btn-primary" style="font-size:13px" onclick="MSIHub.saveAutomationSettings()">Save</button><button class="btn btn-ghost" style="font-size:13px" onclick="MSIHub.testEmail()">Send me a test email</button></div>';
    const tmpl = (window.EMAIL_TEMPLATES || []);
    const tmplRows = tmpl.map((t) => '<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--border)"><div style="flex:1;min-width:0"><div style="font-weight:500;font-size:14px">' + esc(t.name) + '</div><div style="font-size:12.5px;color:var(--gray-500);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(t.subject) + ' — ' + esc(String(t.body || '').slice(0, 90)) + '</div></div>' +
      '<button class="btn btn-ghost" style="font-size:12px;padding:5px 12px" onclick="MSIHub.editEmailTemplate(' + t.id + ')">Edit</button><button class="btn btn-ghost" style="font-size:12px;padding:5px 12px;color:#DC2626" onclick="MSIHub.deleteEmailTemplate(' + t.id + ')">Delete</button></div>').join('');
    const log = (M.data.automation_log || []).slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 40).map((l) => { const who = l.lead_id ? (typeof LEADS !== 'undefined' && LEADS.find((x) => x.id === l.lead_id)) : null; const cu = l.customer_id ? custById(l.customer_id) : null; const nm = who ? who.name : cu ? (cu.name || cu.first + ' ' + cu.last) : '';
      const color = l.status === 'failed' ? '#DC2626' : l.status === 'skipped' ? '#B45309' : l.status === 'sent' || l.status === 'task' ? '#067C83' : 'var(--gray-500)';
      return '<div style="display:flex;gap:10px;padding:7px 0;border-bottom:1px solid var(--border);font-size:12.5px"><span style="color:var(--gray-400);white-space:nowrap">' + esc(when(l.created_at)) + '</span><span style="color:' + color + ';font-weight:500;white-space:nowrap">' + esc(l.status) + '</span><span style="flex:1;min-width:0">' + (nm ? '<a style="cursor:pointer;color:var(--navy-900);font-weight:500" onclick="' + (who ? 'openLeadDetail(\'' + l.lead_id + '\')' : 'openCustomerDetail(\'' + l.customer_id + '\')') + '">' + esc(nm) + '</a> · ' : '') + esc(l.rule_name || '') + (l.detail ? ' — ' + esc(l.detail) : '') + '</span></div>'; }).join('');
    return card('Automation engine', 'Runs the sequences below every 5 minutes, plus renewals, birthdays, the shot clock and X-date recycling once a day', inner) +
      card('Email sending', 'Used by "Send Email" steps and the Email tab on lead and customer cards', email) +
      card('Email templates', 'Pick these from the Email tab. Tokens: {{name}} {{full_name}} {{agent}} {{agent_phone}} {{policy}} {{carrier}} {{expires}}', (tmplRows || '<div style="color:var(--gray-400);font-size:13px">No templates yet</div>'), '<button class="btn btn-primary" style="font-size:13px" onclick="MSIHub.editEmailTemplate(null)">+ New template</button>') +
      card('Recent activity', 'What the engine did lately (last 30 days are kept)', log || '<div style="color:var(--gray-400);font-size:13px">Nothing yet</div>');
  }
  M.saveAutomationSettings = async function () {
    if (!H.isAdmin()) { M.toast('Admins only', 'warn'); return; }
    const c = cfg(); const next = Object.assign({}, c, {
      enabled: !!gv('au_enabled'), business_days_only: !!gv('au_bdays'), business_days: [1, 2, 3, 4, 5, 6, 7].filter((i) => gv('au_d' + i)), start: gv('au_start') || '08:00', end: gv('au_end') || '19:00', timezone: gv('au_tz') || 'America/Los_Angeles',
      holidays: String(gv('au_holidays') || '').split(/[\s,]+/).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)), stop_on_reply: !!gv('au_reply'), stop_on_contact: !!gv('au_contact'), sms_optout_footer: !!gv('au_footer'),
      shot_clock_days: Math.max(0, parseInt(gv('au_shot')) || 0), xdate_lead_days: Math.max(0, parseInt(gv('au_xlead')) || 30), policy_term_months: parseInt(gv('au_term')) || 6,
      email_enabled: !!gv('au_email'), email_from_name: gv('au_from_name') || 'MaxSave Insurance', email_from: gv('au_from') || '', email_reply_to: gv('au_reply_to') || '', email_footer: gv('au_footer_line') || '', email_signature: gv('au_sig') || '' });
    if (next.enabled && !c.enabled) next.shot_clock_since = next.shot_clock_since || today();
    if (next.email_enabled && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.email_from)) { M.toast('Enter the sender address before switching email on', 'warn'); return; }
    try { await saveSetting('automation', next); M.toast('Automation settings saved' + (next.enabled && !c.enabled ? ' — new leads will start their sequences from now on' : '')); refreshAdminPage(); } catch (e) { H.fail('Saving settings', e); }
  };
  M.runAutomationNow = async function () {
    const el = $('au_msg'); if (el) el.textContent = 'Running…';
    try { const r = await fn('run'); if (!r.enabled) M.toast('Automation is switched off — turn it on and save first', 'warn'); else M.toast('Run finished: ' + r.sent + ' sent, ' + r.tasks + ' tasks, ' + r.skipped + ' skipped, ' + r.failed + ' failed'); await M.reload(['enrollments', 'automation_log', 'agency_settings', 'messages', 'emails', 'tasks']); refreshAdminPage(); }
    catch (e) { M.toast(e.message, 'error'); if (el) el.textContent = ''; }
  };
  M.checkAutomation = async function () {
    try { const r = await fn('status'); M.autoStatus = Object.assign({}, r.status || {}, { email: r.email }); M.toast('Service is up' + (r.email.api_key ? ', email connected' : ', email key not set')); refreshAdminPage(); }
    catch (e) { M.toast(e.message, 'error'); }
  };
  M.testEmail = async function () {
    try { const r = await fn('test_email'); M.toast('Test email sent to ' + (r.row ? r.row.to_email : 'you')); } catch (e) { M.toast(e.message, 'error'); }
  };
  M.editEmailTemplate = async function (id) {
    const list = window.EMAIL_TEMPLATES || (window.EMAIL_TEMPLATES = []); const t = id != null ? list.find((x) => x.id === id) : null;
    const v = await modal(t ? 'Edit email template' : 'New email template', fg('Name', inp('et_name', t ? t.name : '')) + fg('Subject', inp('et_subject', t ? t.subject : '')) + fg('Body', '<textarea id="et_body" class="form-control" rows="8">' + esc(t ? t.body : '') + '</textarea>'),
      [{ label: 'Save', primary: true, value: () => { if (!gv('et_name') || !gv('et_body')) { M.toast('Name and body are required', 'warn'); return false; } return { name: gv('et_name'), subject: gv('et_subject'), body: gv('et_body') }; } }, { label: 'Cancel', value: 'cancel' }], { width: 640 });
    if (!v || v === 'cancel') return;
    if (t) Object.assign(t, v); else list.push(Object.assign({ id: list.length ? Math.max(...list.map((x) => x.id)) + 1 : 1 }, v));
    try { await saveSetting('email_templates', list); M.toast('Template saved'); refreshAdminPage(); } catch (e) { H.fail('Saving template', e); }
  };
  M.deleteEmailTemplate = async function (id) {
    const v = await modal('Delete this template?', '', [{ label: 'Delete', danger: true, value: 'yes' }, { label: 'Keep', value: 'no' }]); if (v !== 'yes') return;
    window.EMAIL_TEMPLATES = (window.EMAIL_TEMPLATES || []).filter((x) => x.id !== id);
    try { await saveSetting('email_templates', window.EMAIL_TEMPLATES); refreshAdminPage(); } catch (e) { H.fail('Deleting template', e); }
  };
  const _renderLifecyclePanel = window.renderLifecyclePanel;
  if (_renderLifecyclePanel) window.renderLifecyclePanel = function () { return '<div>' + automationSettingsHTML() + _renderLifecyclePanel.apply(this, arguments) + '</div>'; };

  // ------------------------------------------------------------------
  // Settings → Leads: loss reasons, required fields, tags, cost per lead source
  // ------------------------------------------------------------------
  function leadsSettingsHTML() {
    const reasons = window.LOSS_REASONS || []; const req = (window.REQUIRED_FIELDS || {}).lead || []; const tags = window.TAGS || []; const sources = window.LEAD_SOURCES || [];
    const chipList = (items, onDel, render) => '<div style="display:flex;flex-wrap:wrap;gap:8px">' + items.map((x, i) => '<span style="display:inline-flex;align-items:center;gap:6px;background:var(--gray-50);border:1px solid var(--border);border-radius:999px;padding:4px 12px;font-size:13px">' + render(x) + '<span onclick="' + onDel.replace('%i', i) + '" style="cursor:pointer;color:var(--gray-400)" title="Remove">✕</span></span>').join('') + '</div>';
    const reasonsCard = card('Loss reasons', 'Marking a lead as Bad Lead asks for one of these. They feed the "Why leads were lost" report.', chipList(reasons, 'MSIHub.removeListItem(\'loss_reasons\',%i)', (x) => esc(x)) +
      '<div style="display:flex;gap:8px;margin-top:12px"><input id="ls_new_reason" class="form-control" placeholder="Add a reason…" style="max-width:320px;font-size:13px"><button class="btn btn-primary" style="font-size:13px" onclick="MSIHub.addListItem(\'loss_reasons\',\'ls_new_reason\')">Add</button></div>');
    const reqCard = card('Required fields on a new lead', 'The New Lead form will not save until these are filled. First name and phone are always required.', '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px 16px">' + LEAD_FIELDS.map((f) => toggle('rq_' + f[0], f[1], f[0] === 'first' || f[0] === 'phone' || req.includes(f[0])).replace('<input type="checkbox"', f[0] === 'first' || f[0] === 'phone' ? '<input type="checkbox" disabled' : '<input type="checkbox"')).join('') + '</div>' +
      '<div style="font-size:12.5px;color:var(--gray-500);margin:8px 0 12px">A new lead is also checked against the whole database by phone and email; a match offers to open the existing lead instead of creating a copy.</div><button class="btn btn-primary" style="font-size:13px" onclick="MSIHub.saveRequiredFields()">Save</button>');
    const tagsCard = card('Tags', 'Label leads and customers; filter the lead list by tag. "Aged" and "X-Date" are applied by the automation engine.', chipList(tags, 'MSIHub.removeListItem(\'tags\',%i)', (t) => M.tagChips([t.name])) +
      '<div style="display:flex;gap:8px;margin-top:12px;align-items:center"><input id="ls_new_tag" class="form-control" placeholder="New tag…" style="max-width:240px;font-size:13px"><input id="ls_new_tag_color" type="color" value="#067C83" style="width:40px;height:36px;border:1px solid var(--border);border-radius:8px;background:#fff"><button class="btn btn-primary" style="font-size:13px" onclick="MSIHub.addTag()">Add</button></div>');
    const costCard = card('Cost per lead by source', 'Used for the ROI report. Sources that match a vendor above use the vendor\'s price per lead; set a cost here for everything else.', '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px 16px">' + sources.map((s, i) => { const vendor = (window.LEAD_VENDORS || []).find((v) => (v.name || '').toLowerCase() === (s.name || '').toLowerCase());
      return '<div style="display:flex;align-items:center;gap:8px;font-size:13.5px"><span style="flex:1">' + esc(s.name) + (s.active === false ? ' <span style="color:var(--gray-400);font-size:11px">(off)</span>' : '') + '</span>' + (vendor ? '<span style="font-size:12.5px;color:var(--gray-500)">$' + (vendor.ppl || 0) + ' /lead (vendor)</span>' : '<span style="color:var(--gray-400)">$</span><input id="sc_' + i + '" type="number" step="0.01" class="form-control" value="' + esc(s.cost == null ? '' : s.cost) + '" style="width:90px;padding:6px 8px;font-size:13px"><span style="font-size:11.5px;color:var(--gray-400)">/lead</span>') + '</div>'; }).join('') + '</div>' +
      '<button class="btn btn-primary" style="font-size:13px;margin-top:12px" onclick="MSIHub.saveSourceCosts()">Save costs</button>');
    return reasonsCard + reqCard + tagsCard + costCard;
  }
  M.addListItem = async function (key, inputId) {
    const v = gv(inputId); if (!v) return; const list = window[key.toUpperCase()] || []; if (list.includes(v)) return;
    list.push(v); try { await saveSetting(key, list); refreshAdminPage(); } catch (e) { H.fail('Saving', e); }
  };
  M.removeListItem = async function (key, i) {
    const list = window[key.toUpperCase()] || []; list.splice(i, 1); try { await saveSetting(key, list); refreshAdminPage(); } catch (e) { H.fail('Saving', e); }
  };
  M.addTag = async function () {
    const name = gv('ls_new_tag'); if (!name) return; const list = window.TAGS || (window.TAGS = []); if (list.some((t) => t.name === name)) return;
    list.push({ name, color: gv('ls_new_tag_color') || '#696969' }); try { await saveSetting('tags', list); refreshAdminPage(); } catch (e) { H.fail('Saving tag', e); }
  };
  M.saveRequiredFields = async function () {
    const lead = LEAD_FIELDS.filter((f) => gv('rq_' + f[0])).map((f) => f[0]); if (!lead.includes('first')) lead.push('first'); if (!lead.includes('phone')) lead.push('phone');
    window.REQUIRED_FIELDS = Object.assign({}, window.REQUIRED_FIELDS, { lead });
    try { await saveSetting('required_fields', window.REQUIRED_FIELDS); M.toast('Required fields saved'); } catch (e) { H.fail('Saving', e); }
  };
  M.saveSourceCosts = async function () {
    (window.LEAD_SOURCES || []).forEach((s, i) => { const el = $('sc_' + i); if (el) s.cost = el.value === '' ? null : H.num(el.value); });
    try { await M.persistSetting('lead_sources'); M.toast('Lead costs saved'); } catch (e) { H.fail('Saving', e); }
  };
  const _renderLeadsPanel = window.renderLeadsPanel;
  if (_renderLeadsPanel) window.renderLeadsPanel = function () { return '<div>' + _renderLeadsPanel.apply(this, arguments) + leadsSettingsHTML() + '</div>'; };

  // ------------------------------------------------------------------
  // Reports → Leads: source ROI + loss reasons (for the report's date range)
  // ------------------------------------------------------------------
  function leadsReportExtraHTML() {
    const [a, b] = M.reportRange(window.REPORTS_STATE || {}); const inR = (iso) => { const d = (iso || '').slice(0, 10); return !!d && d >= a && d <= b; };
    const leads = M.data.leads.filter((l) => inR(l.received_at || l.created_at)); const sales = M.data.sales.filter((s) => inR(s.sale_date || s.created_at));
    const byLead = {}; sales.forEach((s) => { if (s.lead_id) (byLead[s.lead_id] = byLead[s.lead_id] || []).push(s); });
    const vendors = window.LEAD_VENDORS || []; const srcs = window.LEAD_SOURCES || [];
    const names = Object.values(Object.fromEntries([...leads.map((l) => l.source), ...srcs.filter((x) => x.active !== false).map((x) => x.name)].filter(Boolean).map((x) => [x.toLowerCase(), x])));
    const rows = names.map((name) => {
      const ls = leads.filter((l) => (l.source || '').toLowerCase() === name.toLowerCase()); const v = vendors.find((x) => (x.name || '').toLowerCase() === name.toLowerCase()); const sc = srcs.find((x) => (x.name || '').toLowerCase() === name.toLowerCase());
      const ppl = v ? H.num(v.ppl) : H.num(sc && sc.cost); const cost = Math.round(ppl * ls.length);
      const sold = ls.filter((l) => l.status === 'Sold'); const ss = sold.flatMap((l) => byLead[l.id] || []);
      const fees = ss.reduce((t, s) => t + H.num(s.fee_total), 0), prem = ss.reduce((t, s) => t + H.num(s.premium), 0);
      const contacted = ls.filter((l) => l.status !== 'New Lead').length, quoted = ls.filter((l) => ['Quoted', 'Appointment Set', 'Sold'].includes(l.status)).length, lost = ls.filter((l) => l.status === 'Bad Lead').length;
      return { name, n: ls.length, cost, ppl, contacted, quoted, sold: sold.length, lost, fees, prem, cps: sold.length ? Math.round(cost / sold.length) : null, roi: cost ? Math.round((fees - cost) / cost * 100) : null };
    }).filter((r) => r.n).sort((x, y) => y.n - x.n);
    const pct = (x, n) => n ? Math.round(x / n * 100) + '%' : '—';
    const roiTable = '<div class="card" style="margin-top:14px"><div class="card-header"><div><div class="card-title">Lead source ROI</div><div style="font-size:13px;color:var(--gray-500);margin-top:3px">Leads received in the period vs. broker fees on their sales · cost = leads × price per lead (Settings → Leads)</div></div></div><div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Source</th><th>Leads</th><th>Cost</th><th>Contacted</th><th>Quoted</th><th>Sold</th><th>Lost</th><th>Fees</th><th>Premium</th><th>Cost / sale</th><th>ROI</th></tr></thead><tbody>' +
      (rows.length ? rows.map((r) => '<tr><td style="font-weight:500">' + esc(r.name) + '</td><td>' + r.n + '</td><td>' + (r.cost ? money0(r.cost) + ' <span style="color:var(--gray-400);font-size:11px">($' + r.ppl + ')</span>' : '<span style="color:var(--gray-400)">organic</span>') + '</td><td>' + pct(r.contacted, r.n) + '</td><td>' + pct(r.quoted, r.n) + '</td><td style="font-weight:500">' + r.sold + ' <span style="color:var(--gray-400);font-size:11px">' + pct(r.sold, r.n) + '</span></td><td>' + r.lost + '</td><td>' + money0(r.fees) + '</td><td>' + money0(r.prem) + '</td><td>' + (r.cps == null ? '—' : money0(r.cps)) + '</td><td style="font-weight:500;color:' + (r.roi == null ? 'var(--gray-400)' : r.roi >= 0 ? '#067C83' : '#DC2626') + '">' + (r.roi == null ? '—' : r.roi + '%') + '</td></tr>').join('')
      : '<tr><td colspan="11" style="text-align:center;padding:28px;color:var(--gray-400)">No leads in this period</td></tr>') + '</tbody></table></div></div>';
    const lostLeads = M.data.leads.filter((l) => l.status === 'Bad Lead' && inR(l.closed_at || l.updated_at)); const counts = {};
    lostLeads.forEach((l) => { const k = l.loss_reason || 'No reason recorded'; counts[k] = (counts[k] || 0) + 1; });
    const lr = Object.entries(counts).sort((x, y) => y[1] - x[1]); const max = lr.length ? lr[0][1] : 1;
    const lossCard = '<div class="card" style="margin-top:14px"><div class="card-header"><div><div class="card-title">Why leads were lost</div><div style="font-size:13px;color:var(--gray-500);margin-top:3px">' + lostLeads.length + ' leads marked Bad Lead in the period</div></div></div><div style="padding:14px 20px">' +
      (lr.length ? lr.map((x) => '<div style="display:grid;grid-template-columns:220px 1fr 50px;gap:12px;align-items:center;padding:5px 0;font-size:13.5px"><div>' + esc(x[0]) + '</div><div style="background:var(--gray-100);border-radius:999px;height:10px;overflow:hidden"><div style="width:' + Math.round(x[1] / max * 100) + '%;height:100%;background:#09C4CD"></div></div><div style="text-align:right;font-weight:500">' + x[1] + '</div></div>').join('') : '<div style="color:var(--gray-400);font-size:13px">Nothing lost in this period</div>') + '</div></div>';
    return roiTable + lossCard;
  }
  const _renderRptLeads = window.renderRptLeads;
  if (_renderRptLeads) window.renderRptLeads = function () { return '<div>' + _renderRptLeads.apply(this, arguments) + (ready() ? leadsReportExtraHTML() : '') + '</div>'; };

  // ------------------------------------------------------------------
  // Inbox → Emails: show sent / received emails
  // ------------------------------------------------------------------
  function mapEmails() {
    const list = (M.data.emails || []).slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).map((e) => {
      const L = e.lead_id ? (typeof LEADS !== 'undefined' && LEADS.find((x) => x.id === e.lead_id)) : null; const C = e.customer_id ? custById(e.customer_id) : null; const d = new Date(e.created_at);
      return { id: e.id, from: (L && L.name) || (C && (C.name || C.first + ' ' + C.last)) || e.to_email, subject: (e.direction === 'outbound' ? 'To ' + e.to_email + ': ' : '') + (e.subject || '(no subject)'), preview: String(e.body || '').slice(0, 160), time: d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }), date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        read: true, starred: false, priority: e.status === 'failed' ? 'high' : 'normal', sentiment: null, attachments: 0, agent: H.agentName(e.agent_id), lead_id: e.lead_id, customer_id: e.customer_id };
    });
    window.EMAILS = list;
  }

  // ------------------------------------------------------------------
  // Boot: lists, inbox emails, periodic status for admins
  // ------------------------------------------------------------------
  M.hooks.remap.push(applyLists, mapEmails);
  if (M.ready) { applyLists(); mapEmails(); }
})();
