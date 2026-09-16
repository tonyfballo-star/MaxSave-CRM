// Live verification: signs into the real site with a test agent login, walks every page
// with the real database, does a few reversible writes, and reports JS errors.
// Usage: node live.js <url> <email> <password>
const puppeteer = require('puppeteer-core');
const path = require('path');
const { spawn } = require('child_process'); const http = require('http');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const [URL, EMAIL, PASS, LOCAL_DATA] = process.argv.slice(2);
if (!URL || !EMAIL || !PASS) { console.error('usage: node live.js <url> <email> <password>'); process.exit(2); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const port = 9361;
  const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-sandbox', '--window-size=1500,1000', '--remote-debugging-port=' + port, '--user-data-dir=' + path.join(__dirname, 'prof-live-' + Date.now()), 'about:blank'], { stdio: 'ignore', detached: true });
  proc.unref();
  let ver = null;
  for (let i = 0; i < 80 && !ver; i++) { await wait(500); ver = await new Promise((res) => { http.get({ host: '127.0.0.1', port, path: '/json/version' }, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => res(d)); }).on('error', () => res(null)); }); }
  if (!ver) throw new Error('Edge did not start');
  const browser = await puppeteer.connect({ browserWSEndpoint: JSON.parse(ver).webSocketDebuggerUrl });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 1000 });
  const errors = [], toasts = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { const t = m.text(); if (m.type() === 'error' && !/favicon|Tracking Prevention/.test(t)) errors.push('console: ' + t); });
  page.on('dialog', async (d) => { toasts.push('DIALOG: ' + d.message()); await d.accept(); });

  if (LOCAL_DATA) { await page.setRequestInterception(true); page.on('request', (r) => { const u = r.url(); if (/msihub-data(-2)?.js/.test(u)) { const f = LOCAL_DATA + '/' + u.split('/').pop().split('?')[0]; r.respond({ status: 200, contentType: 'application/javascript', body: require('fs').readFileSync(f, 'utf8') }); } else r.continue(); }); }
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForSelector('#authEmail', { timeout: 20000 });
  await page.type('#authEmail', EMAIL); await page.type('#authPassword', PASS);
  await page.click('#authSubmit');
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) { await wait(500); ready = await page.evaluate(() => !!(window.MSIHub && MSIHub.ready)); }
  const out = { url: URL, signedIn: ready, errors, steps: [] };
  if (!ready) { out.authMsg = await page.evaluate(() => (document.getElementById('authMsg') || {}).textContent); console.log(JSON.stringify(out, null, 2)); await browser.close(); return; }
  // Capture toasts (the app's own feedback messages)
  await page.evaluate(() => { window.__toasts = []; const o = MSIHub.toast; MSIHub.toast = function (m, k) { window.__toasts.push((k || 'info') + ': ' + m); return o.apply(this, arguments); }; });

  out.user = await page.evaluate(() => ({ name: MSIHub.profile.full_name, role: MSIHub.profile.role, missingTables: [...MSIHub.missingTables] }));
  out.counts = await page.evaluate(() => ({ leads: LEADS.length, customers: CUSTOMERS.length, sales: window.SALES.length, tasks: window.TASKS_DATA.length, agents: AGENTS.length, settingsRows: MSIHub.data.agency_settings.map((r) => r.key), tiers: (window.TIER_DATA || []).length, carriers: (window.CARRIER_DATA || []).length }));

  const TAG = 'ZZ QA ' + Date.now().toString().slice(-5);
  const steps = [
    ['dashboard', () => nav('dashboard', document.querySelector('.nav-item'))],
    ['leads', () => nav('leads', null)],
    ['leads-board', () => setLeadsView('board')],
    ['leads-table', () => setLeadsView('table')],
    ['lead-create', async (tag) => { openLeadForm(); await new Promise((r) => setTimeout(r, 100)); document.getElementById('lf_first').value = tag; document.getElementById('lf_last').value = 'Test'; document.getElementById('lf_phone').value = '6195550199'; await saveLeadForm(null); await new Promise((r) => setTimeout(r, 800)); if (!LEADS.find((l) => l.first === tag)) throw new Error('lead not created'); }],
    ['lead-detail-name', (tag) => { const L = LEADS.find((l) => l.first === tag); openLeadDetail(L.id); return new Promise((r) => setTimeout(() => { if (!document.getElementById('leadDetailBody').textContent.includes(tag)) throw new Error('detail missing'); r(); }, 400)); }],
    ['lead-note', async () => { document.getElementById('noteInput').value = 'QA note'; await addNote(); if (!document.getElementById('notesList').textContent.includes('QA note')) throw new Error('note missing'); }],
    ['lead-quote', async () => { addQuote(); document.getElementById('q_premium').value = '999'; await saveQuote(); await new Promise((r) => setTimeout(r, 400)); }],
    ['lead-appt', async () => { openAppointment(); document.getElementById('apptTime').value = '14:00'; await confirmAppointment(); }],
    ['lead-text', async (tag) => { const L = LEADS.find((l) => l.first === tag); leadText(L.id); document.getElementById('textThreadInput').value = 'QA text (not delivered — no carrier yet)'; sendTextReply(); await new Promise((r) => setTimeout(r, 500)); closeTextThread(); }],
    ['lead-hide', async (tag) => { const L = LEADS.find((l) => l.first === tag); MSIHub.currentLeadId = L.id; await setDisposition('Bad Lead'); await new Promise((r) => setTimeout(r, 600)); }],
    ['customers', () => nav('customers', null)],
    ['customer-detail', () => { if (CUSTOMERS.length) openCustomerDetail(CUSTOMERS[0].id); }],
    ['calendar', () => nav('calendar', null)],
    ['tasks', () => nav('tasks', null)],
    ['task-add', async () => { openTaskModal(); await new Promise((r) => setTimeout(r, 100)); document.getElementById('tm_label').value = 'QA task'; document.getElementById('tm_date').value = new Date().toISOString().slice(0, 10); await submitTaskModal(); await new Promise((r) => setTimeout(r, 500)); if (!window.TASKS_DATA.find((t) => t.label === 'QA task')) throw new Error('task not saved'); }],
    ['task-toggle', async () => { const t = window.TASKS_DATA.find((x) => x.label === 'QA task'); await toggleTaskDone(t.id); }],
    ['task-delete', async () => { const t = window.TASKS_DATA.find((x) => x.label === 'QA task'); await deleteTask(t.id); await new Promise((r) => setTimeout(r, 500)); if (window.TASKS_DATA.find((x) => x.label === 'QA task')) throw new Error('task not deleted'); }],
    ['reports', async () => { nav('reports', null); await new Promise((r) => setTimeout(r, 300)); for (const t of ['overview', 'agents', 'carriers', 'leads', 'timeclock']) { window.REPORTS_STATE.tab = t; refreshReports(); } for (const m of ['payperiod', 'thismonth', 'lastmonth', 'ytd']) { window.REPORTS_STATE.dateMode = m; refreshReports(); } window.REPORTS_STATE.tab = 'overview'; window.REPORTS_STATE.dateMode = 'payperiod'; }],
    ['goals', () => nav('goals', null)],
    ['liveview', () => nav('liveview', null)],
    ['inbox', () => nav('inbox', null)],
    ['agency', () => nav('agency', null)],
    ['agentprofile', () => nav('agentprofile', null)],
    ['admin-panels', async () => { nav('admin', null); await new Promise((r) => setTimeout(r, 300)); for (const p of ['agents', 'tiers', 'carriers', 'leadsources', 'lifecycle', 'goals', 'payperiods', 'pipelines', 'statuses', 'callsettings', 'integrations', 'dataexport']) { window.ADMIN_STATE.panel = p; refreshAdminPage(); await new Promise((r) => setTimeout(r, 120)); const txt = document.getElementById('content').textContent; if (txt.trim().length < 50) throw new Error('panel ' + p + ' empty'); } }],
    ['esignatures', () => nav('esignatures', null)],
    ['payment', () => nav('payment', null)],
    ['finance', () => nav('finance', null)],
    ['dashboard-again', () => nav('dashboard', document.querySelector('.nav-item'))],
  ];
  for (const [name, fn] of steps) {
    const before = errors.length;
    try { await page.evaluate(fn, TAG); } catch (e) { errors.push('step ' + name + ': ' + e.message); }
    await wait(400);
    out.steps.push(name + (errors.length > before ? ' ✗' : ' ✓'));
  }
  // Clean up what we can as an agent: cancel the test appointment (deletes are admin-only by design)
  out.cleanup = await page.evaluate(async (tag) => { const L = LEADS.find((l) => l.first === tag); if (!L) return 'no test lead'; const { error } = await MSIHub.sb.from('appointments').update({ status: 'Cancelled', notes: 'QA test — safe to delete' }).eq('lead_id', L.id); return error ? 'appointment cancel failed: ' + error.message : 'test appointment cancelled; test lead hidden as Bad Lead (admin can purge with: delete from leads where first_name like \'ZZ QA%\')'; }, TAG);
  out.toasts = await page.evaluate(() => window.__toasts);
  out.pageTitle = await page.evaluate(() => document.getElementById('page-title').textContent);
  await page.screenshot({ path: path.join(__dirname, 'live-dashboard.png') });
  console.log(JSON.stringify(out, null, 2));
  await browser.close(); try { proc.kill(); } catch (e) { /* ignore */ }
})().catch((e) => { console.error('LIVE FAILED', e); process.exit(1); });
