// Puts the automation engine live in one run. Safe to run again.
//
//   SUPABASE_ACCESS_TOKEN=sbp_...  [NETLIFY_TOKEN=nfp_...]  node tools/automation-go-live.mjs [--site] [--no-db]
//
//   1. runs supabase/schema-v6-automation.sql (tables, triggers, daily jobs, work queue)
//   2. sets the function secrets: AUTOMATION_SECRET (generated once, kept in supabase/local-automation.json, gitignored)
//      and BREVO_API_KEY when local-automation.json has one
//   3. deploys supabase/functions/automation (JWT verification off) and checks that it answers
//   4. schedules the 5-minute tick with pg_cron → pg_net → the function (job "maxsavehub-automation")
//   5. --site: builds the site from the last commit and deploys it to Netlify (draft, checked, then published)
// Tokens come from the environment, or from the gitignored supabase/local-telnyx.json (supabase_access_token, netlify_token). Node 24+.
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process'; import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REF = 'xcwkkynxgojmabxdrngm', NETLIFY_SITE = 'ba46785b-f37b-4cc9-80c8-b92ddc7dd684', LIVE = 'https://msihub-maxsave.netlify.app/';
const FN = 'https://' + REF + '.supabase.co/functions/v1/automation';
const args = new Set(process.argv.slice(2));
const TL = fs.existsSync(path.join(ROOT, 'supabase/local-telnyx.json')) ? JSON.parse(fs.readFileSync(path.join(ROOT, 'supabase/local-telnyx.json'), 'utf8')) : {};
const SB = process.env.SUPABASE_ACCESS_TOKEN || TL.supabase_access_token, NF = process.env.NETLIFY_TOKEN || TL.netlify_token;   // env first; else the gitignored local file
const LOCAL = path.join(ROOT, 'supabase/local-automation.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (t) => console.log('\n— ' + t);
if (!SB && !args.has('--no-db')) { console.error('SUPABASE_ACCESS_TOKEN is not set.'); process.exit(1); }

let L = { note: 'Local-only secrets for the automation function (gitignored). automation_secret authenticates the cron tick and signs unsubscribe links; brevo_api_key is optional.' };
if (fs.existsSync(LOCAL)) L = JSON.parse(fs.readFileSync(LOCAL, 'utf8'));
if (!L.automation_secret) { L.automation_secret = crypto.randomBytes(32).toString('base64url'); fs.writeFileSync(LOCAL, JSON.stringify(L, null, 2)); console.log('Generated AUTOMATION_SECRET → supabase/local-automation.json'); }
const TICK = FN + '?k=' + encodeURIComponent(L.automation_secret);

async function sb(method, p, body, raw) {
  const r = await fetch('https://api.supabase.com' + p, { method, headers: raw ? { Authorization: 'Bearer ' + SB } : { Authorization: 'Bearer ' + SB, 'Content-Type': 'application/json' }, body: raw ? body : (body === undefined ? undefined : JSON.stringify(body)) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* text */ }
  if (!r.ok) throw new Error('Supabase ' + method + ' ' + p + ' → ' + r.status + ' ' + t.slice(0, 400));
  return j ?? t;
}
const sql = (query) => sb('POST', '/v1/projects/' + REF + '/database/query', { query });

if (!args.has('--no-db')) {
  step('Supabase project');
  const proj = await sb('GET', '/v1/projects/' + REF);
  console.log('  ' + proj.name + ' (' + proj.region + ', ' + proj.status + ')');

  step('Database update (schema-v6-automation.sql)');
  await sql(fs.readFileSync(path.join(ROOT, 'supabase/schema-v6-automation.sql'), 'utf8'));
  const chk = await sql("select (select count(*)::int from information_schema.tables where table_schema='public' and table_name in ('emails','email_opt_outs','automation_enrollments','automation_log')) as tables, (select count(*)::int from information_schema.columns where table_schema='public' and table_name='leads' and column_name in ('tags','loss_reason','closed_at','x_date','recycled_at')) as lead_cols, (select count(*)::int from pg_trigger where tgname in ('leads_automation_after','messages_automation','call_log_automation','sales_automation','policies_automation')) as triggers");
  if (chk[0].tables !== 4 || chk[0].lead_cols !== 5 || chk[0].triggers !== 5) throw new Error('Schema check failed: ' + JSON.stringify(chk[0]));
  await sql("notify pgrst, 'reload schema'");
  console.log('  ok — 4 tables, 5 lead columns, 5 triggers present');

  step('Function secrets');
  const secrets = [{ name: 'AUTOMATION_SECRET', value: L.automation_secret }];
  if (L.brevo_api_key) secrets.push({ name: 'BREVO_API_KEY', value: L.brevo_api_key });
  await sb('POST', '/v1/projects/' + REF + '/secrets', secrets);
  console.log('  ok — AUTOMATION_SECRET' + (L.brevo_api_key ? ', BREVO_API_KEY' : ' (no BREVO_API_KEY in local-automation.json yet — email steps will be skipped until it is added and this script is re-run)'));

  step('Deploy function "automation"');
  const form = new FormData();
  form.append('metadata', JSON.stringify({ name: 'automation', entrypoint_path: 'index.ts', verify_jwt: false }));
  form.append('file', new Blob([fs.readFileSync(path.join(ROOT, 'supabase/functions/automation/index.ts'))], { type: 'application/typescript' }), 'index.ts');
  const dep = await sb('POST', '/v1/projects/' + REF + '/functions/deploy?slug=automation', form, true);
  console.log('  deployed — version ' + dep.version + ', verify_jwt ' + dep.verify_jwt + ', status ' + dep.status);
  let alive = false;
  for (let i = 0; i < 20 && !alive; i++) {
    await sleep(3000);
    const a = await fetch(FN, { method: 'GET' }).catch(() => null);
    const body = a ? await a.text() : '';
    alive = !!a && a.status === 200 && /"service":"automation"/.test(body);
    if (!alive && i === 19) throw new Error('Function is not answering as expected: ' + (a ? a.status + ' ' + body.slice(0, 200) : 'no response'));
  }
  const bad = await fetch(FN + '?k=wrong', { method: 'POST', body: '{}' });
  const good = await fetch(TICK, { method: 'POST', body: '{}' }); const goodBody = await good.json().catch(() => ({}));
  if (bad.status !== 401 || good.status !== 200) throw new Error('Tick check failed: wrong secret → ' + bad.status + ', right secret → ' + good.status + ' ' + JSON.stringify(goodBody).slice(0, 200));
  console.log('  answering: wrong secret refused, tick accepted → ' + JSON.stringify(goodBody));

  step('Schedule the 5-minute tick (pg_cron → pg_net)');
  await sql('create extension if not exists pg_cron; create extension if not exists pg_net;');
  await sql("select cron.unschedule(jobid) from cron.job where jobname = 'maxsavehub-automation'");
  await sql("select cron.schedule('maxsavehub-automation', '*/5 * * * *', $job$select net.http_post(url := '" + TICK.replace(/'/g, "''") + "', headers := '{\"Content-Type\":\"application/json\"}'::jsonb, body := '{\"tick\":true}'::jsonb, timeout_milliseconds := 150000)$job$)");
  const job = await sql("select jobid, schedule, active from cron.job where jobname = 'maxsavehub-automation'");
  if (!job.length || !job[0].active) throw new Error('Cron job not scheduled: ' + JSON.stringify(job));
  console.log('  job ' + job[0].jobid + ' every 5 minutes, active');
}

if (!args.has('--site') || !NF) { console.log('\nSite not deployed (' + (NF ? 'pass --site' : 'NETLIFY_TOKEN not set') + ').'); }
else {
  step('Site → Netlify (built from the last commit)');
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'msihub-site-'));
  fs.cpSync(path.join(ROOT, 'site'), tmp, { recursive: true });
  const FILES = [['maxsave_crm.html', 'index.html'], ['msihub-data.js', 'msihub-data.js'], ['msihub-data-2.js', 'msihub-data-2.js'], ['msihub-telnyx.js', 'msihub-telnyx.js'], ['msihub-automation.js', 'msihub-automation.js']];
  for (const [src, dst] of FILES) fs.writeFileSync(path.join(tmp, dst), git('show', 'HEAD:' + src));
  fs.mkdirSync(path.join(tmp, 'fonts'), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'fonts')).filter((x) => x.endsWith('.ttf'))) fs.copyFileSync(path.join(ROOT, 'fonts', f), path.join(tmp, 'fonts', f));
  if (!fs.readFileSync(path.join(tmp, 'index.html'), 'utf8').includes('msihub-automation.js')) throw new Error('The last commit does not load msihub-automation.js — commit first.');
  const zip = path.join(os.tmpdir(), 'msihub-site-' + Date.now() + '.zip');
  execFileSync('C:/Windows/System32/tar.exe', ['-a', '-c', '-f', zip, ...fs.readdirSync(tmp)], { cwd: tmp });   // bare entry names, never "./x"
  const before = (await (await fetch('https://api.netlify.com/api/v1/sites/' + NETLIFY_SITE, { headers: { Authorization: 'Bearer ' + NF } })).json()).published_deploy?.id;
  const r = await fetch('https://api.netlify.com/api/v1/sites/' + NETLIFY_SITE + '/deploys?draft=true', { method: 'POST', headers: { Authorization: 'Bearer ' + NF, 'Content-Type': 'application/zip' }, body: fs.readFileSync(zip) });
  const d = await r.json(); if (!r.ok) throw new Error('Netlify deploy failed: ' + r.status + ' ' + JSON.stringify(d).slice(0, 300));
  let state = d.state;
  for (let i = 0; i < 40 && state !== 'ready' && state !== 'error'; i++) { await sleep(3000); state = (await (await fetch('https://api.netlify.com/api/v1/deploys/' + d.id, { headers: { Authorization: 'Bearer ' + NF } })).json()).state; }
  fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(zip, { force: true });
  if (state !== 'ready') throw new Error('Netlify deploy did not finish: ' + state);
  const pre = 'https://' + d.id + '--msihub-maxsave.netlify.app/';
  const check = async (base) => { const out = {}; for (const p of ['', 'msihub-data.js', 'msihub-data-2.js', 'msihub-telnyx.js', 'msihub-automation.js', 'fonts/TTHoves-Regular.ttf']) { const x = await fetch(base + p + '?t=' + Date.now()); out[p || 'index'] = x.status; if (!p) out.loadsAutomation = /msihub-automation\.js/.test(await x.text()); } return out; };
  const draft = await check(pre);
  console.log('  draft ' + d.id + ': ' + JSON.stringify(draft));
  if (Object.entries(draft).some(([k, v]) => (k === 'loadsAutomation' ? v !== true : v !== 200))) {
    const now = (await (await fetch('https://api.netlify.com/api/v1/sites/' + NETLIFY_SITE, { headers: { Authorization: 'Bearer ' + NF } })).json()).published_deploy?.id;
    if (before && now !== before) await fetch('https://api.netlify.com/api/v1/sites/' + NETLIFY_SITE + '/deploys/' + before + '/restore', { method: 'POST', headers: { Authorization: 'Bearer ' + NF } });
    throw new Error('Draft looks wrong — not published' + (before && now !== before ? ' (previous deploy ' + before + ' restored)' : '') + '.');
  }
  const pub = await fetch('https://api.netlify.com/api/v1/sites/' + NETLIFY_SITE + '/deploys/' + d.id + '/restore', { method: 'POST', headers: { Authorization: 'Bearer ' + NF } });
  if (!pub.ok) throw new Error('Could not publish the draft: ' + pub.status + ' ' + (await pub.text()).slice(0, 200));
  await sleep(4000);
  console.log('  published · live: ' + JSON.stringify(await check(LIVE)));
}
console.log('\nDone. Automation stays OFF until an admin switches it on in Settings → Lifecycle Automation.');
