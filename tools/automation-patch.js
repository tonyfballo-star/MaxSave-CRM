// One-time codemod for the automation / policies / loss-reason / tags / email work (2026-10-02).
// Edits msihub-data.js and maxsave_crm.html in place (CRLF preserved). Every edit must match exactly once.
// Usage: node tools/automation-patch.js [--check]
const fs = require('fs'); const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const CHECK = process.argv.includes('--check');
let fails = 0;
function patch(file, edits) {
  const f = path.join(ROOT, file); const raw = fs.readFileSync(f, 'utf8'); const crlf = /\r\n/.test(raw);
  let s = raw.replace(/\r\n/g, '\n');
  for (const [label, from, to] of edits) {
    const n = s.split(from).length - 1;
    if (n !== 1) { console.log('FAIL ' + file + ' · ' + label + ' · matches: ' + n); fails++; continue; }
    s = s.split(from).join(to);
  }
  if (!CHECK && !fails) fs.writeFileSync(f, crlf ? s.replace(/\n/g, '\r\n') : s);
}

patch('msihub-data.js', [
  ['data keys', `sales: [], appointments: [], notes: [], quotes: [], calls: [], messages: [], templates: [], files: [], tasks: [], agency_settings: [] },`,
    `sales: [], appointments: [], notes: [], quotes: [], calls: [], messages: [], templates: [], files: [], tasks: [], agency_settings: [],
            emails: [], enrollments: [], automation_log: [] },`],
  ['leads loader', `    leads:        (q) => q.or('received_at.gte.' + daysAgo(90) + ',status.in.("Quoted","Appointment Set")'),`,
    `    leads:        (q) => q.or('received_at.gte.' + daysAgo(90) + ',status.in.("Quoted","Appointment Set")' + (M.v6 ? ',recycled_at.gte.' + daysAgo(90) : '')),`],
  ['new tables', `    tasks:        (q) => q.order('due_date').order('id'),
    agency_settings: (q) => q,
  };`, `    tasks:        (q) => q.order('due_date').order('id'),
    agency_settings: (q) => q,
    emails:         (q) => q.gte('created_at', daysAgo(90)),                                   // schema-v6
    enrollments:    (q) => q.or('status.eq.active,updated_at.gte.' + daysAgo(30)),
    automation_log: (q) => q.gte('created_at', daysAgo(30)),
  };`],
  ['table names', `  const TABLE_NAME = { calls: 'call_log' };
  const OPTIONAL = new Set(['tasks', 'agency_settings']);   // added by schema-v2.sql`,
    `  const TABLE_NAME = { calls: 'call_log', enrollments: 'automation_enrollments' };
  const OPTIONAL = new Set(['tasks', 'agency_settings', 'emails', 'enrollments', 'automation_log']);   // schema-v2 / schema-v6`],
  ['v6 probe', `  M.loadAll = async function () {
    await loadKeys(Object.keys(TABLES), 'Loading data');`, `  // schema-v6 (automation) present? Decides whether the leads query may mention recycled_at.
  async function probeV6() {
    try { const { error } = await M.sb.from('automation_enrollments').select('id').limit(1); M.v6 = !error; } catch (_e) { M.v6 = false; }
    if (!M.v6) M.missingTables.add('automation_enrollments');
  }
  M.loadAll = async function () {
    await probeV6();
    await loadKeys(Object.keys(TABLES), 'Loading data');`],
  ['realtime list', `  const RT = { leads: ['leads'], customers: ['customers'], policies: ['policies'], sales: ['sales'], appointments: ['appointments'], notes: ['notes'], call_log: ['calls'], messages: ['messages'],`,
    `  const RT = { emails: ['emails'], automation_enrollments: ['enrollments'], automation_log: ['automation_log'], leads: ['leads'], customers: ['customers'], policies: ['policies'], sales: ['sales'], appointments: ['appointments'], notes: ['notes'], call_log: ['calls'], messages: ['messages'],`],
  ['mapLeads fields', `      leadScore: r.lead_score == null ? 70 : r.lead_score, doNotCall: !!r.do_not_call, details: r.details || {}, createdAt: r.created_at,
    }));`, `      leadScore: r.lead_score == null ? 70 : r.lead_score, doNotCall: !!r.do_not_call, details: r.details || {}, createdAt: r.created_at,
      tags: Array.isArray(r.tags) ? r.tags : [], lossReason: r.loss_reason || '', closedAt: r.closed_at || null, xDate: r.x_date || '', recycledAt: r.recycled_at || null,
    }));`],
  ['mapPolicy fields', `      status: p.status || 'Active', saleId: p.sale_id, customer_id: p.customer_id };`,
    `      status: p.status || 'Active', saleId: p.sale_id, customer_id: p.customer_id,
      termMonths: p.term_months || 6, csr_id: p.csr_id || null, csr: p.csr_id ? agentName(p.csr_id) : '', cancelReason: p.cancel_reason || '', cancelledAt: p.cancelled_at || '', notes: p.notes || '', renewedFrom: p.renewed_from || null };`],

  // ---- Bad Lead needs a reason (board drop, disposition, header update) ----
  ['board drop reason', `    const lead = LEADS.find((l) => l.phone === phone);
    if (!lead || lead.status === newStatus) { refreshLeads(); return; }
    const prev = lead.status; lead.status = newStatus; refreshLeads();
    try { await update('leads', lead.id, { status: newStatus }); } catch (e) { lead.status = prev; refreshLeads(); fail('Updating lead', e); }`,
    `    const lead = LEADS.find((l) => l.phone === phone);
    if (!lead || lead.status === newStatus) { refreshLeads(); return; }
    const patch = { status: newStatus };
    if (newStatus === 'Bad Lead' && M.askLossReason) { const r = await M.askLossReason(lead); if (!r) { refreshLeads(); return; } patch.loss_reason = r.reason; if (r.note) insert('notes', { lead_id: lead.id, author_id: myId(), body: 'Lost: ' + r.reason + ' — ' + r.note }).catch(() => {}); }
    const prev = lead.status; lead.status = newStatus; if (patch.loss_reason) lead.lossReason = patch.loss_reason; refreshLeads();
    try { await update('leads', lead.id, patch); } catch (e) { lead.status = prev; refreshLeads(); fail('Updating lead', e); }`],
  ['disposition reason', `    if (value === 'Do Not Call') patch.do_not_call = true;
    try {
      await update('leads', lead.id, patch);
      Object.assign(lead, { disposition: value }, patch.status ? { status: patch.status } : {}, patch.do_not_call ? { doNotCall: true } : {});`,
    `    if (value === 'Do Not Call') patch.do_not_call = true;
    if (patch.status === 'Bad Lead' && lead.status !== 'Bad Lead' && M.askLossReason) {
      const r = await M.askLossReason(lead); if (!r) return;
      patch.loss_reason = r.reason; if (r.note) insert('notes', { lead_id: lead.id, author_id: myId(), body: 'Lost: ' + r.reason + ' — ' + r.note }).catch(() => {});
    }
    try {
      await update('leads', lead.id, patch);
      Object.assign(lead, { disposition: value }, patch.status ? { status: patch.status } : {}, patch.do_not_call ? { doNotCall: true } : {}, patch.loss_reason ? { lossReason: patch.loss_reason } : {});`],
  ['header reason', `    if (patch.disposition === 'Do Not Call') patch.do_not_call = true;
    try {
      await update('leads', L.id, patch);
      Object.assign(L, { status: patch.status, disposition: patch.disposition || '', agent_id: patch.agent_id, agent: patch.agent_id ? agentName(patch.agent_id) : 'Unassigned' }, patch.do_not_call ? { doNotCall: true } : {});`,
    `    if (patch.disposition === 'Do Not Call') patch.do_not_call = true;
    if (patch.status === 'Bad Lead' && L.status !== 'Bad Lead' && M.askLossReason) {
      const r = await M.askLossReason(L); if (!r) { PAGE_INIT.leaddetail(); return; }
      patch.loss_reason = r.reason; if (r.note) insert('notes', { lead_id: L.id, author_id: myId(), body: 'Lost: ' + r.reason + ' — ' + r.note }).catch(() => {});
    }
    try {
      await update('leads', L.id, patch);
      Object.assign(L, { status: patch.status, disposition: patch.disposition || '', agent_id: patch.agent_id, agent: patch.agent_id ? agentName(patch.agent_id) : 'Unassigned' }, patch.do_not_call ? { doNotCall: true } : {}, patch.loss_reason ? { lossReason: patch.loss_reason } : {});`],

  // ---- Lead form: sources from Settings, X-date, required fields, duplicate check ----
  ['form source list', `      fg('Source', '<select id="lf_source" class="form-control">' + opt(LEAD_SOURCES, L ? L.source || 'Other' : 'Everquote') + '</select>') +`,
    `      fg('Source', '<select id="lf_source" class="form-control">' + opt(M.sourceNames ? M.sourceNames(L && L.source) : LEAD_SOURCES, L ? L.source || 'Other' : (M.sourceNames ? M.sourceNames()[0] : 'Everquote')) + '</select>') +`],
  ['form xdate field', `      fg('Violations', inp('lf_violations', d.violations || '', 'e.g. None'), true) +`,
    `      fg('Violations', inp('lf_violations', d.violations || '', 'e.g. None')) +
      fg('Current policy renews (X-date)', inp('lf_xdate', L && L.xDate ? String(L.xDate).slice(0, 10) : '', '', 'date')) +`],
  ['form required + duplicate', `    const g = (i) => { const el = $(i); return el ? el.value.trim() : ''; };
    if (!g('lf_first')) { M.toast('First name is required', 'warn'); return; }
    if (!g('lf_phone')) { M.toast('Phone is required', 'warn'); return; }
    const existing = id ? leadById(id) : null;`,
    `    const g = (i) => { const el = $(i); return el ? el.value.trim() : ''; };
    if (!g('lf_first')) { M.toast('First name is required', 'warn'); return; }
    if (!g('lf_phone')) { M.toast('Phone is required', 'warn'); return; }
    if (M.checkRequiredLeadFields && !M.checkRequiredLeadFields(g)) return;
    if (!id && M.findDuplicateLead) {
      const dup = await M.findDuplicateLead(g('lf_phone'), g('lf_email'));
      if (dup) { const choice = await M.confirmDuplicate(dup); if (choice === 'open') { $('leadFormOverlay').style.display = 'none'; openLeadDetail(dup.id); return; } if (choice !== 'create') return; }
    }
    const existing = id ? leadById(id) : null;`],
  ['form xdate save', `      agent_id: g('lf_agent') || null, language: g('lf_lang'), best_time: g('lf_best') || null, sr22: g('lf_sr22') === 'yes', prior_coverage: g('lf_prior') || null, details };`,
    `      agent_id: g('lf_agent') || null, language: g('lf_lang'), best_time: g('lf_best') || null, sr22: g('lf_sr22') === 'yes', prior_coverage: g('lf_prior') || null, details };
    if (M.v6) row.x_date = g('lf_xdate') || null;`],

  // ---- Lead card: Email tab, tags + sequences strip, X-date row, lost reason ----
  ['card tabs', `    const tabs = [['sms', 'Text', '✉'], ['comments', 'Notes', '📝'], ['appointments', 'Appointment', '📅'], ['task', 'Task', '☑'], ['files', 'Files', '📎'], ['activities', 'History', '☰'], ['applications', 'Quotes', '📄']];`,
    `    const tabs = [['sms', 'Text', '✉'], ['email', 'Email', '📧'], ['comments', 'Notes', '📝'], ['appointments', 'Appointment', '📅'], ['task', 'Task', '☑'], ['files', 'Files', '📎'], ['activities', 'History', '☰'], ['applications', 'Quotes', '📄']];`],
  ['card extras', `        (L.doNotCall ? '<div style="margin-top:8px;font-size:13px;color:#DC2626">Do Not Call: this lead asked not to be contacted</div>' : '') +`,
    `        (L.doNotCall ? '<div style="margin-top:8px;font-size:13px;color:#DC2626">Do Not Call: this lead asked not to be contacted</div>' : '') +
        (M.leadExtrasHTML ? M.leadExtrasHTML(L) : '') +`],
  ['card xdate row', `        row('Gender', d.gender) + row('Marital Status', d.marital) + row('License Status', myLic.status) + row('License State', myLic.state) + row('Violations', d.violations || 'None reported') +`,
    `        row('Gender', d.gender) + row('Marital Status', d.marital) + row('License Status', myLic.status) + row('License State', myLic.state) + row('Violations', d.violations || 'None reported') +
        (M.leadXDateRow ? M.leadXDateRow(L) : '') +`],
  ['card email panel', `        panel('task', actionRow(pill('openTaskModal()', '＋ Add Task', true)) + taskRows) +`,
    `        panel('email', M.emailPanelHTML ? M.emailPanelHTML({ lead: L }) : emptyBox('Email is not set up yet')) +
        panel('task', actionRow(pill('openTaskModal()', '＋ Add Task', true)) + taskRows) +`],

  // ---- New Sale: policy term from Settings (6-month auto by default), expiration follows the term ----
  ['sale term', `      const expires = (() => { const x = new Date(effDate); x.setFullYear(x.getFullYear() + 1); return localISODate(x); })();`,
    `      const term = M.policyTerm ? M.policyTerm(policyType) : 12;
      const expires = (() => { const x = new Date(effDate + 'T00:00:00'); x.setMonth(x.getMonth() + term); return localISODate(x); })();`],
  ['sale policy row', `      await insert('policies', { customer_id: cust.id, sale_id: sale.id, line: policyType, carrier, policy_number: policyNum, sold_by_id: agent.id, effective_date: effDate, expires_date: expires,
        premium, towing_premium: towing, fee_total: feeTotal, fee_collected: feeCollected, fee_extended: feeExtended, hcc_collected: false, status: 'Active' });`,
    `      await insert('policies', Object.assign({ customer_id: cust.id, sale_id: sale.id, line: policyType, carrier, policy_number: policyNum, sold_by_id: agent.id, effective_date: effDate, expires_date: expires,
        premium, towing_premium: towing, fee_total: feeTotal, fee_collected: feeCollected, fee_extended: feeExtended, hcc_collected: false, status: 'Active' }, M.v6 ? { term_months: term } : {}));`],
]);

patch('maxsave_crm.html', [
  // sidebar: Renewals under Customers
  ['nav renewals', `      Customers
    </div>
    <div class="nav-item" onclick="nav('calendar',this)">`,
    `      Customers
    </div>
    <div class="nav-item" onclick="nav('renewals',this)">
      <svg class="nav-ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M13.5 8a5.5 5.5 0 11-1.6-3.9" stroke-linecap="round"/><path d="M13.5 1.5v3h-3" stroke-linecap="round" stroke-linejoin="round"/></svg>
      Renewals
    </div>
    <div class="nav-item" onclick="nav('calendar',this)">`],
  ['page title', `    agency:'Teams & Agents', admin:'Settings', agentprofile:'Agent Profile'
  };`, `    agency:'Teams & Agents', admin:'Settings', agentprofile:'Agent Profile', renewals:'Renewals & X-Dates'
  };`],
  // leads list: sources from Settings, tag filter, tag chips
  ['leads tag filter state', `  if (s.dispositionFilter !== 'All') filtered = filtered.filter(l => (l.disposition || 'None') === s.dispositionFilter);`,
    `  if (s.dispositionFilter !== 'All') filtered = filtered.filter(l => (l.disposition || 'None') === s.dispositionFilter);
  if (s.tagFilter && s.tagFilter !== 'All') filtered = filtered.filter(l => (l.tags || []).includes(s.tagFilter));`],
  ['leads source list', `  const sources = ['All','Everquote','Facebook Ads','Google Ads','Referral','Direct Call','Cold Call'];`,
    `  const sources = ['All', ...new Set([...((window.LEAD_SOURCES || []).filter(x => x.active !== false).map(x => x.name)), ...LEADS.map(l => l.source).filter(Boolean)])];
  const tagNames = ['All', ...new Set([...((window.TAG_LIST || []).map(t => t.name)), ...LEADS.flatMap(l => l.tags || [])])];`],
  ['leads tag select', `    <span class="filter-label">Disposition:</span>
    <select class="filter-select" onchange="window.LEADS_STATE.dispositionFilter=this.value;window.LEADS_STATE.page=1;refreshLeads()">
      \${dispositions.map(x=>\`<option \${s.dispositionFilter===x?'selected':''}>\${x}</option>\`).join('')}
    </select>`,
    `    <span class="filter-label">Disposition:</span>
    <select class="filter-select" onchange="window.LEADS_STATE.dispositionFilter=this.value;window.LEADS_STATE.page=1;refreshLeads()">
      \${dispositions.map(x=>\`<option \${s.dispositionFilter===x?'selected':''}>\${x}</option>\`).join('')}
    </select>
    <span class="filter-label">Tag:</span>
    <select class="filter-select" onchange="window.LEADS_STATE.tagFilter=this.value;window.LEADS_STATE.page=1;refreshLeads()">
      \${tagNames.map(x=>\`<option \${(s.tagFilter||'All')===x?'selected':''}>\${x}</option>\`).join('')}
    </select>`],
  ['leads row chips', `              <div class="lead-name-link" onclick="openLeadDetail('\${l.id}')" style="font-weight:500;color:var(--navy-900);cursor:pointer;font-size:18px">\${l.name}</div>
`, `              <div class="lead-name-link" onclick="openLeadDetail('\${l.id}')" style="font-weight:500;color:var(--navy-900);cursor:pointer;font-size:18px">\${l.name}</div>
              \${window.MSIHub && MSIHub.tagChips ? MSIHub.tagChips(l.tags) : ''}
`],
  // lifecycle editor: new trigger, "Right away" send time
  ['lifecycle triggers', `  const triggers = ['Lead is created','Lead is marked Quoted','Lead is marked Appointment Set','Lead has no contact in','Lead is marked Bad Lead','Policy expires in','Extended fee unpaid for','On customer birthday'];`,
    `  const triggers = ['Lead is created','Lead is marked Quoted','Lead is marked Appointment Set','Lead has no contact in','Lead is recycled (X-date)','Lead is marked Bad Lead','Policy expires in','Extended fee unpaid for','On customer birthday'];`],
  ['lifecycle times', `  const times = ['6:00 AM','7:00 AM','8:00 AM','9:00 AM','9:30 AM','10:00 AM','10:30 AM','11:00 AM','12:00 PM','1:00 PM','2:00 PM','3:00 PM','4:00 PM','5:00 PM','6:00 PM','7:00 PM','8:00 PM'];`,
    `  const times = ['Right away','6:00 AM','7:00 AM','8:00 AM','9:00 AM','9:30 AM','10:00 AM','10:30 AM','11:00 AM','12:00 PM','1:00 PM','2:00 PM','3:00 PM','4:00 PM','5:00 PM','6:00 PM','7:00 PM','8:00 PM'];`],
  ['lifecycle tip', `      <strong>Tip:</strong> Day 1 = the day the trigger fires. Day 2 = next day. Texts go at the send time you choose. Emails can include a subject line and a longer body.
      Available tokens: <strong>{{name}}</strong> · <strong>{{agent}}</strong> · <strong>{{amount}}</strong> · <strong>{{policy}}</strong>`,
    `      <strong>Tip:</strong> Day 1 = the day the trigger fires, Day 2 = the next day ("Right away" sends the moment the lead comes in, inside business hours). For <strong>Policy expires in</strong>, the day number means <em>days before</em> the expiration date. Steps wait for business hours and skip non-business days (Settings below). A sequence stops on its own when the lead replies, a call connects, the stage changes, or the lead is sold or marked Do Not Call.
      Tokens: <strong>{{name}}</strong> · <strong>{{full_name}}</strong> · <strong>{{agent}}</strong> · <strong>{{agent_phone}}</strong> · <strong>{{policy}}</strong> · <strong>{{carrier}}</strong> · <strong>{{expires}}</strong> · <strong>{{amount}}</strong>`],
  // customer page: email tab, policy actions, placeholders for tags + sequences
  ['customer tabs list', `  ['cd-calls','cd-text','cd-notes'].forEach(function(t) {`, `  ['cd-calls','cd-text','cd-email','cd-notes'].forEach(function(t) {`],
  ['customer tab button', `        <button id="cdBtn-cd-notes" onclick="cdTab('cd-notes')"`, `        <button id="cdBtn-cd-email" onclick="cdTab('cd-email')" style="padding:12px 18px;border:none;background:transparent;cursor:pointer;font-size:13.5px;font-weight:500;color:var(--gray-500);border-bottom:2.5px solid transparent;font-family:var(--font-body)">
          Email <span style="font-size:11px;background:var(--gray-100);color:var(--gray-500);padding:1px 7px;border-radius:var(--radius-full);margin-left:5px;font-weight:500">\${window.MSIHub && MSIHub.emailCount ? MSIHub.emailCount({ customer: c }) : 0}</span>
        </button>
        <button id="cdBtn-cd-notes" onclick="cdTab('cd-notes')"`],
  ['customer email panel', `      <!-- NOTES -->
      <div id="cd-notes" style="display:none;padding:16px 20px">`, `      <!-- EMAIL -->
      <div id="cd-email" style="display:none;padding:16px 20px">\${window.MSIHub && MSIHub.emailPanelHTML ? MSIHub.emailPanelHTML({ customer: c }) : ''}</div>

      <!-- NOTES -->
      <div id="cd-notes" style="display:none;padding:16px 20px">`],
  ['customer email button', `        <button onclick="alert('Email: \${c.email||'—'}')"`, `        <button onclick="cdTab('cd-email');var _i=document.getElementById('cdEmailSubject');if(_i)_i.focus()"`],
  ['customer extras slot', `    <!-- DISPOSITION BAR -->`, `    <div id="cdExtras">\${window.MSIHub && MSIHub.customerExtrasHTML ? MSIHub.customerExtrasHTML(c) : ''}</div>

    <!-- DISPOSITION BAR -->`],
  ['policies header', `          \${secHdr('Policies ('+c.policies.length+')','<span style="font-size:11px;color:var(--gray-400)">All-time</span>')}`,
    `          \${secHdr('Policies ('+c.policies.length+')','<button class="btn btn-ghost" style="font-size:11px;padding:4px 10px" onclick="MSIHub.openPolicyForm(\\''+c.id+'\\')">+ Add Policy</button>')}`],
  ['policy rows', `              \${infoRow('Period',p.effective+' &rarr; '+p.expires)}`,
    `              \${infoRow('Period',p.effective+' &rarr; '+p.expires+(p.termMonths?' <span style="color:var(--gray-400);font-size:11px">('+p.termMonths+' mo)</span>':''))}
              \${infoRow('Producer / CSR',(p.soldBy||'&mdash;')+(p.csr?' / '+p.csr:''))}
              \${p.status==='Cancelled'&&p.cancelReason?infoRow('Cancelled',escAttr(p.cancelReason)+(p.cancelledAt?' &middot; '+p.cancelledAt:'')):''}`],
  ['policy actions', `                <button onclick="cancelPolicy('\${escAttr(c.id)}','\${escAttr(p.number)}')" style="flex:1;padding:7px 0;font-size:11.5px;font-weight:500;font-family:var(--font-body);background:#F7F7F7;color:#2E2E2E;border:1.5px solid #D9D9D9;`,
    `                <button onclick="MSIHub.openPolicyForm('\${escAttr(c.id)}','\${escAttr(p.id)}')" style="flex:1;padding:7px 0;font-size:11.5px;font-weight:500;font-family:var(--font-body);background:#F7F7F7;color:#2E2E2E;border:1.5px solid #D9D9D9;border-radius:var(--radius-md);cursor:pointer">&#9998; Edit</button>
                <button onclick="MSIHub.renewPolicy('\${escAttr(p.id)}')" style="flex:1;padding:7px 0;font-size:11.5px;font-weight:500;font-family:var(--font-body);background:#E6F9FA;color:#067C83;border:1.5px solid #5FD9DF;border-radius:var(--radius-md);cursor:pointer">&#8635; Renew</button>
                <button onclick="MSIHub.cancelPolicyDb('\${escAttr(p.id)}')" style="flex:1;padding:7px 0;font-size:11.5px;font-weight:500;font-family:var(--font-body);background:#F7F7F7;color:#2E2E2E;border:1.5px solid #D9D9D9;`],
  // script tag
  ['script tag', `<script src="msihub-telnyx.js"></script>`, `<script src="msihub-telnyx.js"></script>
<script src="msihub-automation.js"></script>`],
]);

if (fails) { console.log('FAILURES: ' + fails + (CHECK ? '' : ' — nothing written')); process.exit(1); }
console.log(CHECK ? 'all edits match' : 'patched msihub-data.js and maxsave_crm.html');
