// Run:  cd tools && npm init -y && npm i puppeteer-core@23 && node smoke.js real|fake [url]
// Requires Microsoft Edge. "real" expects the login screen; "fake" injects an in-memory Supabase stub and walks every page + write path.
// Headless smoke test for MSIHub using Edge.
// Mode A: real page load -> expect login overlay, no JS errors.
// Mode B: fake Supabase client injected -> walk through pages, expect no JS errors.
const puppeteer = require('puppeteer-core');
const path = require('path');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const FILE = process.argv[3] || 'file:///C:/Users/Tony%20Ballo/OneDrive/Desktop/MSICRM/maxsave_crm.html';

const FAKE_CLIENT = `
(function(){
  const rows = { profiles: [{ id:'u1', email:'qa@test', full_name:'QA Admin', role:'admin', active:true, created_at:'2026-09-01T00:00:00Z', tier:'Tier 1', team:'Alpha', goal_apps:15, goal_fee:6000, goal_premium:20000, goal_close:25, goal_contact:55, perms:{} }, { id:'u2', email:'solo@test', full_name:'Solo', role:'agent', active:true, created_at:'2026-09-02T00:00:00Z', perms:{} }],
    leads: [{ id:'L1', first_name:'Test', last_name:'Lead', phone:'6195550100', status:'New Lead', policy_type:'Auto', source:'Everquote', agent_id:null, received_at:'2026-09-10T10:00:00Z', created_at:'2026-09-10T10:00:00Z', fee:0, sr22:false, language:'English', details:{ vehicle:{year:'2020',make:'Honda',model:'Civic'} } }],
    customers: [{ id:'C1', customer_no:'C-2026-1000', first_name:'Test', last_name:'Customer', phone:'6195550101', status:'Active', dob:'1990-01-01', agent_id:'u1', sold_by_id:'u1', customer_since:'2026-09-01', created_at:'2026-09-01T00:00:00Z' }],
    policies: [{ id:'P1', customer_id:'C1', line:'Auto', carrier:'Progressive', policy_number:'PRG-1', sold_by_id:'u1', effective_date:'2026-09-01', expires_date:'2027-09-01', premium:1200, fee_total:300, fee_collected:150, fee_extended:150, hcc_collected:false, status:'Active' }],
    vehicles: [], drivers: [], claims: [], sales: [{ id:'S1', sale_date:'2026-09-01', agent_id:'u1', customer_id:'C1', carrier:'Progressive', policy_type:'Auto', policy_number:'PRG-1', fee_total:300, fee_collected:150, fee_extended:150, premium:1200, towing_premium:0, effective_date:'2026-09-01', additional_policies:[], total_policies:1, created_at:'2026-09-01T00:00:00Z' }],
    appointments: [{ id:'A1', starts_at:new Date().toISOString(), duration_min:30, lead_id:'L1', contact_name:'Test Lead', phone:'6195550100', agent_id:'u1', status:'New', type:'Follow-Up', notes:'' }],
    notes: [{ id:'N1', lead_id:'L1', author_id:'u1', body:'hello', created_at:'2026-09-10T11:00:00Z' }], quotes: [], call_log: [], messages: [{ id:'M1', agent_id:'u1', lead_id:'L1', contact_name:'Test Lead', phone:'6195550100', direction:'outbound', body:'hi', status:'sent', created_at:'2026-09-10T12:00:00Z' }],
    templates: [{ id:'T1', emoji:'📋', name:'Quote Ready', body:'Hi {{name}}', sort_order:1 }], files: [] };
  window.__writes = [];
  function q(table){ const st={table, filters:[]}; const api={
    select(){return api;}, order(){return api;}, limit(){return api;}, range(){return api;}, or(){return api;}, gte(){return api;}, lte(){return api;}, in(){return api;}, ilike(){return api;}, not(){return api;}, is(){return api;}, neq(){return api;}, eq(k,v){st.filters.push([k,v]);return api;}, maybeSingle(){st.single=true;return api;}, single(){st.single=true;return api;},
    insert(row){ st.op='insert'; window.__writes.push([table,'insert',row]); const r=Object.assign({id:'new'+Date.now(), created_at:new Date().toISOString()}, row); (rows[table]=rows[table]||[]).push(r); st.result=r; return api; },
    update(patch){ st.op='update'; window.__writes.push([table,'update',patch]); st.patch=patch; return api; },
    delete(){ st.op='delete'; window.__writes.push([table,'delete']); return api; },
    upsert(row){ st.op='insert'; window.__writes.push([table,'upsert',row]); const list=(rows[table]=rows[table]||[]); const i=list.findIndex(x=>x.key!==undefined && x.key===row.key); if(i>=0) list[i]=Object.assign(list[i],row); else list.push(Object.assign({id:'up'+Math.random().toString(36).slice(2,8)},row)); st.result=row; return api; },
    then(res){ let data;
      if(st.op==='insert') data=st.result;
      else if(st.op==='update'){ const id=(st.filters.find(f=>f[0]==='id')||[])[1]; const r=(rows[table]||[]).find(x=>x.id===id); if(r) Object.assign(r,st.patch); data=r||st.patch; }
      else if(st.op==='delete'){ data=null; }
      else { data=(rows[table]||[]).filter(r=>st.filters.every(([k,v])=>r[k]===v)); if(st.single) data=data[0]||null; }
      res({data, error:null}); } };
    return api; }
  window.supabase = { createClient(){ return {
    from: q,
    auth: { getSession: async()=>({data:{session:{user:{id:'u1',email:'qa@test'}}}}), onAuthStateChange(){}, signOut: async()=>({}), signInWithPassword: async()=>({data:{},error:null}) },
    storage: { from(){ return { upload: async()=>({error:null}), createSignedUrl: async()=>({data:{signedUrl:'about:blank'},error:null}) }; } },
    channel(){ const c={ on(ev, filter, cb){ (window.__rt=window.__rt||[]).push([filter, cb]); return c; }, subscribe(){return c;} }; return c; },
    // "telnyx" edge function stand-in: records every call; set window.__smsFail to make the next text fail
    functions: { invoke: async (name, opts) => { const b=(opts&&opts.body)||{}; (window.__invokes=window.__invokes||[]).push([name,b]);
      if(b.action==='token') return {data:{token:'tok',sip_username:'gencredX',caller_id:'+16195550000',fresh:false},error:null};
      if(b.action==='status') return {data:{api_key:true,public_key:true,connection_id:true,schema:true,webhook_url:'https://x/functions/v1/telnyx',numbers:[{number:'+16195550000',status:'active',texting:true}],error:null},error:null};
      if(b.action==='sms'){ if(window.__smsFail){ window.__smsFail=false; return {data:{error:'This number opted out of texts (they replied STOP)'},error:null}; }
        const r={id:'tx'+Date.now()+Math.random().toString(36).slice(2,6),agent_id:'u1',lead_id:b.lead_id,customer_id:b.customer_id,contact_name:b.contact_name,phone:b.to,direction:'outbound',body:b.text,status:'queued',provider_sid:'sid'+Date.now(),created_at:new Date().toISOString()}; (rows.messages=rows.messages||[]).push(r); return {data:{ok:true,row:r},error:null}; }
      return {data:{error:'Unknown action'},error:null}; } },
  }; } };
})();`;

async function run(mode) {
  const { spawn } = require('child_process'); const http = require('http');
  const port = mode === 'real' ? 9351 : 9352;
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-sandbox', '--allow-file-access-from-files', '--remote-debugging-port=' + port, '--user-data-dir=' + path.join(__dirname, 'prof-' + mode + '-' + Date.now()), 'about:blank'], { stdio: 'ignore', detached: true });
  proc.unref();
  let ver = null;
  for (let i = 0; i < 80 && !ver; i++) { await new Promise((r) => setTimeout(r, 500)); ver = await new Promise((res) => { http.get({ host: '127.0.0.1', port, path: '/json/version' }, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => res(d)); }).on('error', () => res(null)); }); }
  if (!ver) { try { proc.kill(); } catch (e) {} throw new Error('Edge did not open port ' + port); }
  const browser = await puppeteer.connect({ browserWSEndpoint: JSON.parse(ver).webSocketDebuggerUrl });
  const page = await browser.newPage();
  const errors = [], logs = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); else logs.push(m.text()); });
  page.on('dialog', async (d) => { logs.push('DIALOG: ' + d.message()); await d.accept(); });
  if (mode === 'fake') { await page.setRequestInterception(true); page.on('request', (r) => { if (r.url().includes('cdn.jsdelivr.net') || r.url().includes('supabase.co')) r.abort(); else r.continue(); }); await page.evaluateOnNewDocument(FAKE_CLIENT); }
  await page.goto(FILE, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 1500));
  const out = { mode, errors, logs: logs.slice(-10) };
  if (mode === 'real') {
    out.loginVisible = await page.evaluate(() => { const o = document.getElementById('msihubAuth'); return !!o && o.style.display !== 'none' && !!document.getElementById('authEmail'); });
    out.supabaseLoaded = await page.evaluate(() => !!(window.supabase && window.supabase.createClient));
  } else {
    out.ready = await page.evaluate(() => window.MSIHub && MSIHub.ready);
    out.user = await page.evaluate(() => document.getElementById('sidebarUserName').textContent);
    const steps = [
      ['dashboard', () => nav('dashboard', document.querySelector('.nav-item'))],
      ['leads', () => nav('leads', null)],
      ['leads-board', () => setLeadsView('board')],
      ['leads-table', () => setLeadsView('table')],
      ['lead-detail', () => openLeadDetail('L1')],
      ['add-note', () => { document.getElementById('noteInput').value = 'smoke note'; return addNote(); }],
      ['add-quote-form', () => { addQuote(); document.getElementById('q_premium').value = '1200'; return saveQuote(); }],
      ['set-appt', () => { openAppointment(); document.getElementById('apptTime').value = '14:00'; return confirmAppointment(); }],
      ['text-thread', () => { leadText('L1'); document.getElementById('textThreadInput').value = 'smoke text'; sendTextReply(); closeTextThread(); }],
      ['lead-form-open', () => openLeadForm()],
      ['lead-form-save', () => { document.getElementById('lf_first').value = 'New'; document.getElementById('lf_phone').value = '6195550199'; return saveLeadForm(null); }],
      ['edit-form', () => { openLeadForm('L1'); document.getElementById('leadFormOverlay').style.display = 'none'; }],
      ['disposition', () => setDisposition('Follow Up')],
      ['assign', () => MSIHub.assignLead('L1', 'u1')],
      ['bulk-text', () => { nav('leads', null); return new Promise(r => setTimeout(r, 200)).then(() => { toggleSelectLead('(619) 555-0100', true); openBulkText(); document.getElementById('bulkTextMessage').value = 'bulk hi {{name}}'; return sendBulkText(); }); }],
      ['template-editor', () => { openTemplateEditor(); return newTemplate(); }],
      ['customers', () => nav('customers', null)],
      ['customer-detail', () => openCustomerDetail('C1')],
      ['customer-note', () => { cdTab('cd-notes'); document.getElementById('cdNoteInput').value = 'cust note'; return MSIHub.saveCustomerNote(); }],
      ['customer-text', () => { cdTab('cd-text'); document.getElementById('cdTextInput').value = 'cust text'; return MSIHub.sendCustomerText(); }],
      ['quote-export', () => { openLeadDetail('L1'); return new Promise(r => setTimeout(r, 200)).then(() => { openQuoteExport('lead'); closeQuoteExport(); }); }],
      ['new-sale', () => { openNewSale(); return new Promise(r => setTimeout(r, 300)).then(() => completeNewSaleDetails()).then(() => new Promise(r => setTimeout(r, 700))).then(() => { document.getElementById('nsCarrier').value = document.getElementById('nsCarrier').options[0].value; document.getElementById('nsPolicyNum').value = 'X1'; document.getElementById('nsPremium').value = '900'; return submitNewSale(); }); }],
      ['esignatures', () => nav('esignatures', null)],
      ['esign-preview', () => { openESignDocPreview('doc_std_payauth'); const ok = !!document.querySelector('#esignPreviewOverlay embed[src^="docs/"]'); closeESignPreview(); if (!ok) throw new Error('preview embed missing'); }],
      ['payment', () => nav('payment', null)],
      ['calendar', () => nav('calendar', null)],
      ['reports', () => nav('reports', null)],
      ['inbox', () => nav('inbox', null)],
      ['tasks', () => nav('tasks', null)],
      ['tasks-add', async () => { openTaskModal(); await new Promise(r=>setTimeout(r,100)); document.getElementById('tm_label').value='Smoke task'; document.getElementById('tm_date').value='2026-09-14'; await submitTaskModal(); if (!window.TASKS_DATA.length) throw new Error('task not added'); }],
      ['tasks-toggle', () => toggleTaskDone(window.TASKS_DATA[0].id)],
      ['tasks-delete', () => deleteTask(window.TASKS_DATA[0].id)],
      ['goals', () => nav('goals', null)],
      ['liveview', () => nav('liveview', null)],
      ['reports-tabs', async () => { nav('reports', null); await new Promise(r=>setTimeout(r,200)); for (const t of ['overview','agents','carriers','leads','timeclock']) { window.REPORTS_STATE.tab=t; refreshReports(); } for (const m of ['payperiod','thismonth','lastmonth','ytd','custom']) { window.REPORTS_STATE.dateMode=m; refreshReports(); } window.REPORTS_STATE.tab='overview'; window.REPORTS_STATE.dateMode='payperiod'; }],
      ['admin-panels', async () => { nav('admin', null); await new Promise(r=>setTimeout(r,200)); for (const p of ['agents','tiers','carriers','leadsources','lifecycle','goals','payperiods','pipelines','statuses','callsettings','dataexport']) { window.ADMIN_STATE.panel=p; refreshAdminPage(); } }],
      ['admin-after-reload', async () => { await MSIHub.reload(['agency_settings','profiles','tasks']); for (const p of ['agents','tiers','carriers','leadsources','lifecycle','goals']) { window.ADMIN_STATE.panel=p; refreshAdminPage(); await new Promise(r=>setTimeout(r,120)); const txt=(document.getElementById('content')||{}).textContent||''; if (txt.trim().length < 50) throw new Error('admin panel '+p+' rendered empty'); if (p==='tiers' && !txt.includes('Tier 1')) throw new Error('tiers list empty: '+JSON.stringify(window.TIER_DATA).slice(0,80)); if (p==='carriers' && !txt.includes('National General')) throw new Error('carriers list empty: '+JSON.stringify(window.CARRIER_DATA).slice(0,80)); if (p==='leadsources' && !txt.includes('EverQuote')) throw new Error('lead sources empty'); if (p==='lifecycle' && !txt.includes('Follow-Up Sequence')) throw new Error('lifecycle empty'); } }],
      ['admin-save-tiers', () => { window.ADMIN_STATE.panel='tiers'; refreshAdminPage(); return saveTierData(); }],
      ['admin-save-goals', () => { window.ADMIN_STATE.panel='goals'; refreshAdminPage(); return saveAgentGoals(); }],
      ['admin-lead-source', () => { window.ADMIN_STATE.panel='leadsources'; refreshAdminPage(); return toggleLeadSource(0); }],
      ['agency', () => nav('agency', null)],
      ['agentprofile', () => nav('agentprofile', null)],
      ['finance', () => nav('finance', null)],
      ['admin', () => nav('admin', null)],
      // ---- Telnyx (msihub-telnyx.js): everything above ran with it switched off; now switch it on against stand-ins ----
      ['telnyx-off', () => { if ((window.__invokes || []).length) throw new Error('edge function was called while Telnyx is off'); if (document.querySelector('#msihubPhone .mph-pill')) throw new Error('phone widget visible while calling is off'); }],
      ['telnyx-on', async () => {
        window.TelnyxWebRTC = { TelnyxRTC: class { constructor(o) { this.o = o; this.h = {}; window.__rtc = this; } on(e, f) { (this.h[e] = this.h[e] || []).push(f); return this; } off(e) { delete this.h[e]; } emit(e, a) { (this.h[e] || []).slice().forEach((f) => f(a)); } connect() { setTimeout(() => this.emit('telnyx.ready'), 10); } disconnect() {}
          newCall(opts) { const self = this; const call = { direction: 'outbound', state: 'new', options: opts, telnyxIDs: { telnyxSessionId: 'sess-out' }, hangup() { call.state = 'hangup'; self.emit('telnyx.notification', { type: 'callUpdate', call }); }, toggleAudioMute() {}, toggleHold() {}, dtmf(d) { (window.__dtmf = window.__dtmf || []).push(d); } }; window.__call = call; return call; } } };
        MSIHub.data.agency_settings.push({ key: 'telnyx', value: { sms_enabled: true, voice_enabled: true, sms_number: '+16195550000', caller_id: '+16195550000' } });
        await MSIHub.reload([]); await new Promise((r) => setTimeout(r, 300));
        if (MSIHub.telnyx.phone.state !== 'ready') throw new Error('phone state ' + MSIHub.telnyx.phone.state + ' ' + MSIHub.telnyx.phone.error);
        if (!/Phone ready/.test(document.getElementById('msihubPhone').textContent)) throw new Error('no ready pill');
      }],
      ['telnyx-text', async () => {
        leadText('L1'); document.getElementById('textThreadInput').value = 'real text'; await sendTextReply();
        const sms = window.__invokes.filter((x) => x[1].action === 'sms'); const last = sms[sms.length - 1][1];
        if (last.to !== '(619) 555-0100' || last.text !== 'real text' || last.lead_id !== 'L1') throw new Error('bad sms payload ' + JSON.stringify(last));
        if (!MSIHub.data.messages.find((m) => m.body === 'real text' && m.provider_sid)) throw new Error('sent row not in memory');
        if (!/real text/.test(document.getElementById('textThread').textContent) || !/Sending…/.test(document.getElementById('textThread').textContent)) throw new Error('thread not showing the queued text');
        if (window.__writes.find((w) => w[0] === 'messages' && w[1] === 'insert' && w[2].body === 'real text')) throw new Error('browser also inserted the message');
      }],
      ['telnyx-text-fail', async () => {
        window.__smsFail = true; document.getElementById('textThreadInput').value = 'blocked text'; await sendTextReply();
        if (!/Not sent — This number opted out/.test(document.getElementById('textThread').textContent)) throw new Error('failure not shown in thread');
        if (MSIHub.data.messages.find((m) => m.body === 'blocked text')) throw new Error('failed text was recorded');
        closeTextThread();
      }],
      ['telnyx-inbox-send', async () => { nav('inbox', null); await new Promise((r) => setTimeout(r, 200)); window.INBOX_STATE.tab = 'Texts'; window.INBOX_STATE.textThread = '(619) 555-0100'; refreshInbox(); document.getElementById('inboxTextInput_6195550100').value = 'inbox text'; await inboxSendText('(619) 555-0100'); if (!MSIHub.data.messages.find((m) => m.body === 'inbox text')) throw new Error('inbox text not sent'); }],
      ['telnyx-customer-text', async () => { openCustomerDetail('C1'); await new Promise((r) => setTimeout(r, 200)); cdTab('cd-text'); document.getElementById('cdTextInput').value = 'cust real'; await MSIHub.sendCustomerText(); const s = window.__invokes.filter((x) => x[1].action === 'sms').pop()[1]; if (s.text !== 'cust real' || s.customer_id !== 'C1') throw new Error('bad customer sms ' + JSON.stringify(s)); }],
      ['telnyx-bulk', async () => { nav('leads', null); await new Promise((r) => setTimeout(r, 200)); const before = window.__invokes.length; toggleSelectLead('(619) 555-0100', true); openBulkText(); document.getElementById('bulkTextMessage').value = 'bulk real {{name}}'; await sendBulkText(); const s = window.__invokes.slice(before).filter((x) => x[1].action === 'sms'); if (s.length !== 1 || s[0][1].text !== 'bulk real Test') throw new Error('bulk sent ' + JSON.stringify(s)); }],
      ['telnyx-status-labels', async () => {
        const m = MSIHub.data.messages.find((x) => x.body === 'real text'); m.status = 'delivered'; await MSIHub.reload([]);
        leadText('L1'); const t = document.getElementById('textThread').textContent; closeTextThread();
        if (!/Delivered/.test(t)) throw new Error('no Delivered label: ' + t.slice(-200));
      }],
      ['telnyx-inbound-text', async () => {
        const cbs = (window.__rt || []).filter((x) => x[0] && x[0].table === 'messages'); if (cbs.length < 2) throw new Error('telnyx realtime handler not subscribed');
        const fire = (row) => cbs.forEach((x) => x[1]({ eventType: 'INSERT', new: row }));
        fire({ id: 'in1', agent_id: 'u2', direction: 'inbound', phone: '(619) 555-0177', contact_name: 'Other Agent Lead', body: 'not mine', created_at: new Date().toISOString() });
        if (document.getElementById('textNotifPopup')) throw new Error('popup shown for another agent’s text');
        fire({ id: 'in2', agent_id: null, direction: 'inbound', phone: '(619) 555-0100', contact_name: 'Test Lead', body: '<img src=x onerror="window.__xss=1"> hi', created_at: new Date().toISOString() });
        await new Promise((r) => setTimeout(r, 150));
        const p = document.getElementById('textNotifPopup'); if (!p) throw new Error('no popup for my inbound text');
        if (p.querySelector('img') || window.__xss) throw new Error('inbound text was rendered as HTML');
        if (!/<img src=x/.test(p.textContent)) throw new Error('popup text missing');
        p.remove();
      }],
      ['telnyx-call', async () => {
        const before = window.__writes.length;
        doCall('Test Lead', '(619) 555-0100');
        const c = window.__call; if (!c) throw new Error('no call placed');
        if (c.options.destinationNumber !== '+16195550100' || c.options.callerNumber !== '+16195550000') throw new Error('bad dial ' + JSON.stringify(c.options));
        const up = (s) => { c.state = s; window.__rtc.emit('telnyx.notification', { type: 'callUpdate', call: c }); };
        up('trying'); up('early'); if (!/Ringing/.test(document.getElementById('msihubPhone').textContent)) throw new Error('not ringing');
        up('active'); await new Promise((r) => setTimeout(r, 1100));
        if (!/0:0[01]/.test(document.getElementById('mphStatus').textContent)) throw new Error('no timer: ' + document.getElementById('mphStatus').textContent);
        MSIHub.telnyx.keypad(); MSIHub.telnyx.key('5'); MSIHub.telnyx.mute(); MSIHub.telnyx.hold();
        if ((window.__dtmf || [])[0] !== '5') throw new Error('dtmf not sent');
        MSIHub.telnyx.hangup(); await new Promise((r) => setTimeout(r, 300));
        if (MSIHub.telnyx.phone.call) throw new Error('call still open');
        const w = window.__writes.slice(before).filter((x) => x[0] === 'call_log');
        const ins = w.find((x) => x[1] === 'insert'), upd = w.find((x) => x[1] === 'update');
        if (!ins || ins[2].direction !== 'outbound' || ins[2].lead_id !== 'L1' || ins[2].to_number !== '+16195550100') throw new Error('bad call insert ' + JSON.stringify(ins));
        if (!upd || upd[2].status !== 'completed' || !(upd[2].duration_sec >= 1) || upd[2].provider_call_id !== 'sess-out') throw new Error('bad call update ' + JSON.stringify(upd));
      }],
      ['telnyx-call-inbound', async () => {
        const before = window.__writes.length;
        const call = { direction: 'inbound', state: 'ringing', options: { remoteCallerNumber: '+16195550101' }, answer() { call.state = 'active'; window.__rtc.emit('telnyx.notification', { type: 'callUpdate', call }); }, hangup() { call.state = 'hangup'; window.__rtc.emit('telnyx.notification', { type: 'callUpdate', call }); } };
        window.__rtc.emit('telnyx.notification', { type: 'callUpdate', call });
        const txt = document.getElementById('msihubPhone').textContent;
        if (!/Incoming call/.test(txt) || !/Test Customer/.test(txt) || !/Answer/.test(txt)) throw new Error('inbound not shown: ' + txt);
        const second = { direction: 'inbound', state: 'ringing', options: { remoteCallerNumber: '+16195550188' }, hangup() { second.declined = true; } };
        window.__rtc.emit('telnyx.notification', { type: 'callUpdate', call: second }); if (!second.declined) throw new Error('second inbound call not declined while busy');
        MSIHub.telnyx.answer(); if (!/Hang up/.test(document.getElementById('msihubPhone').textContent)) throw new Error('not connected after answer');
        MSIHub.telnyx.hangup(); await new Promise((r) => setTimeout(r, 200));
        if (MSIHub.telnyx.phone.call) throw new Error('inbound call still open');
        if (window.__writes.slice(before).find((x) => x[0] === 'call_log')) throw new Error('browser logged an inbound call (the server does that)');
      }],
      ['telnyx-dnc', () => { const l = LEADS.find((x) => x.id === 'L1'); l.doNotCall = true; window.__call = null; doCall('Test Lead', '(619) 555-0100'); l.doNotCall = false; if (window.__call) throw new Error('called a DO NOT CALL lead'); }],
      ['telnyx-settings', async () => {
        nav('admin', null); await new Promise((r) => setTimeout(r, 200)); window.ADMIN_STATE.panel = 'callsettings'; refreshAdminPage();
        await MSIHub.telnyx.check(); const txt = document.getElementById('content').textContent;
        if (!/Telnyx account linked/.test(txt) || !/1 phone number on the account/.test(txt)) throw new Error('status not shown');
        if (document.getElementById('tx_sms_number').value !== '+16195550000') throw new Error('number not preselected');
        document.getElementById('tx_fallback').value = '619-555-0142';
        const before = window.__writes.length; await MSIHub.telnyx.save();
        const w = window.__writes.slice(before).find((x) => x[0] === 'agency_settings' && x[1] === 'upsert');
        if (!w || w[2].key !== 'telnyx' || w[2].value.fallback_number !== '+16195550142' || !w[2].value.sms_enabled) throw new Error('settings not saved ' + JSON.stringify(w));
      }],
      ['telnyx-switch-off', async () => {
        document.getElementById('tx_sms_on').checked = false; document.getElementById('tx_voice_on').checked = false; await MSIHub.telnyx.save();
        if (MSIHub.telnyx.phone.state !== 'off' || document.querySelector('#msihubPhone .mph-pill')) throw new Error('phone still on');
        const n = window.__invokes.length; leadText('L1'); document.getElementById('textThreadInput').value = 'logged only'; sendTextReply(); closeTextThread();
        if (window.__invokes.length !== n) throw new Error('text went to Telnyx while switched off');
      }],
    ];
    out.steps = [];
    for (const [name, fn] of steps) {
      const before = errors.length;
      try { await page.evaluate(fn); } catch (e) { errors.push('step ' + name + ': ' + e.message); }
      await new Promise((r) => setTimeout(r, 350));
      out.steps.push(name + (errors.length > before ? ' ✗' : ' ✓'));
    }
    out.writes = await page.evaluate(() => window.__writes.map((w) => w[0] + ':' + w[1]));
    out.leadDetailHasName = await page.evaluate(() => { openLeadDetail('L1'); return new Promise((r) => setTimeout(() => r(((document.getElementById('leadDetailBody') || {}).textContent || '').includes('Test Lead')), 300)); });
  }
  await browser.close(); try { proc.kill(); } catch (e) {}
  return out;
}

(async () => {
  const mode = process.argv[2] || 'real';
  const out = await run(mode);
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error('SMOKE FAILED', e); process.exit(1); });
