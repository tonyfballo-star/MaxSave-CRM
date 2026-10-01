// Puts the Telnyx integration live in one run. Safe to run again.
//
//   SUPABASE_ACCESS_TOKEN=sbp_...  NETLIFY_TOKEN=nfp_...  node tools/telnyx-go-live.mjs [--sms] [--voice] [--no-site]
//
// Needs supabase/local-telnyx.json (gitignored: Telnyx API key, webhook secret, IDs) and Node 24+.
//   1. runs supabase/schema-v4.sql
//   2. sets the function's secrets
//   3. deploys supabase/functions/telnyx (JWT verification off) and checks that it answers
//   4. points the Telnyx messaging profile + inbound-call application at it
//   5. saves the phone settings (number pre-filled; texting / calling switched on only with --sms / --voice)
//   6. builds the site from the last commit and deploys it to Netlify (skipped with --no-site or without NETLIFY_TOKEN)
// Tokens are read from the environment only and are never written anywhere.
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { execFileSync } from 'node:child_process'; import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REF = 'xcwkkynxgojmabxdrngm', NETLIFY_SITE = 'ba46785b-f37b-4cc9-80c8-b92ddc7dd684', LIVE = 'https://msihub-maxsave.netlify.app/';
const FN = 'https://' + REF + '.supabase.co/functions/v1/telnyx';
const args = new Set(process.argv.slice(2));
const SB = process.env.SUPABASE_ACCESS_TOKEN, NF = process.env.NETLIFY_TOKEN;
const L = JSON.parse(fs.readFileSync(path.join(ROOT, 'supabase/local-telnyx.json'), 'utf8'));
const HOOK = FN + '?k=' + encodeURIComponent(L.webhook_secret);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (t) => console.log('\n— ' + t);
if (!SB) { console.error('SUPABASE_ACCESS_TOKEN is not set.'); process.exit(1); }

async function sb(method, p, body, raw) {
  const r = await fetch('https://api.supabase.com' + p, { method, headers: raw ? { Authorization: 'Bearer ' + SB } : { Authorization: 'Bearer ' + SB, 'Content-Type': 'application/json' }, body: raw ? body : body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* text */ }
  if (!r.ok) throw new Error('Supabase ' + method + ' ' + p + ' → ' + r.status + ' ' + t.slice(0, 400));
  return j ?? t;
}
const sql = (query) => sb('POST', '/v1/projects/' + REF + '/database/query', { query });
async function telnyx(method, p, body) {
  const r = await fetch('https://api.telnyx.com/v2' + p, { method, headers: { Authorization: 'Bearer ' + L.api_key, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* text */ }
  return { ok: r.ok, status: r.status, j, t };
}

step('Supabase project');
const proj = await sb('GET', '/v1/projects/' + REF);
console.log('  ' + proj.name + ' (' + proj.region + ', ' + proj.status + ')');

step('Database update (schema-v4.sql)');
await sql(fs.readFileSync(path.join(ROOT, 'supabase/schema-v4.sql'), 'utf8'));
const cols = await sql("select count(*)::int as n from information_schema.columns where table_schema='public' and ((table_name='profiles' and column_name like 'telnyx_%') or table_name in ('phone_presence','sms_opt_outs'))");
console.log('  ok — ' + cols[0].n + ' new columns/table columns present');
await sql("notify pgrst, 'reload schema'");

step('Function secrets');
await sb('POST', '/v1/projects/' + REF + '/secrets', [
  { name: 'TELNYX_API_KEY', value: L.api_key }, { name: 'TELNYX_CONNECTION_ID', value: L.connection_id }, { name: 'TELNYX_WEBHOOK_SECRET', value: L.webhook_secret }]);
console.log('  ok — TELNYX_API_KEY, TELNYX_CONNECTION_ID, TELNYX_WEBHOOK_SECRET');

step('Deploy function "telnyx"');
const form = new FormData();
form.append('metadata', JSON.stringify({ name: 'telnyx', entrypoint_path: 'index.ts', verify_jwt: false }));
form.append('file', new Blob([fs.readFileSync(path.join(ROOT, 'supabase/functions/telnyx/index.ts'))], { type: 'application/typescript' }), 'index.ts');
const dep = await sb('POST', '/v1/projects/' + REF + '/functions/deploy?slug=telnyx', form, true);
console.log('  deployed — version ' + dep.version + ', verify_jwt ' + dep.verify_jwt + ', status ' + dep.status);
let alive = false;
for (let i = 0; i < 20 && !alive; i++) {
  await sleep(3000);
  const a = await fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => null);
  const body = a ? await a.text() : '';
  alive = !!a && a.status === 401 && /Sign in first/.test(body);
  if (!alive && i === 19) throw new Error('Function is not answering as expected: ' + (a ? a.status + ' ' + body.slice(0, 200) : 'no response'));
}
console.log('  answering: refuses callers who are not signed in');
const bad = await fetch(FN + '?k=wrong', { method: 'POST', body: '{"data":{"event_type":"ping","payload":{}}}' });
const good = await fetch(HOOK, { method: 'POST', body: '{"data":{"event_type":"ping","payload":{}}}' });
if (bad.status !== 401 || good.status !== 200) throw new Error('Webhook check failed: wrong secret → ' + bad.status + ', right secret → ' + good.status);
console.log('  webhook door: wrong secret refused, right secret accepted');

step('Telnyx → function');
const mp = await telnyx('PATCH', '/messaging_profiles/' + L.messaging_profile_id, { webhook_url: HOOK, webhook_api_version: '2' });
const app = await telnyx('PATCH', '/call_control_applications/' + L.voice_app_id, { application_name: L.voice_app_name, webhook_event_url: HOOK, webhook_api_version: '2', outbound: { outbound_voice_profile_id: L.outbound_voice_profile_id } });
if (!mp.ok || !app.ok) throw new Error('Could not update Telnyx webhooks: ' + mp.status + ' ' + mp.t.slice(0, 200) + ' / ' + app.status + ' ' + app.t.slice(0, 200));
const cred = await telnyx('GET', '/telephony_credentials?page[size]=1'); const brand = await telnyx('GET', '/10dlc/brand'); const bal = await telnyx('GET', '/balance');
const canCall = cred.ok, canRegister = brand.ok;
console.log('  texts + inbound calls now report to the function');
console.log('  account: balance $' + (bal.j?.data?.balance ?? '?') + ' · browser phone ' + (canCall ? 'allowed' : 'NOT allowed at this account level') + ' · 10DLC ' + (canRegister ? 'allowed' : 'NOT allowed at this account level'));

step('Phone settings');
const wantSms = args.has('--sms'), wantVoice = args.has('--voice') && canCall;
if (args.has('--voice') && !canCall) console.log('  --voice ignored: Telnyx refuses browser-phone logins until the account is upgraded');
const value = { sms_number: L.number, caller_id: L.number, ...(wantSms ? { sms_enabled: true } : {}), ...(wantVoice ? { voice_enabled: true } : {}) };
await sql("insert into public.agency_settings (key, value) values ('telnyx', '" + JSON.stringify({ sms_enabled: false, voice_enabled: false, ...value }).replace(/'/g, "''") + "'::jsonb) on conflict (key) do update set value = public.agency_settings.value || '" + JSON.stringify(value).replace(/'/g, "''") + "'::jsonb, updated_at = now()");
const saved = await sql("select value from public.agency_settings where key = 'telnyx'");
console.log('  ' + JSON.stringify(saved[0].value));

if (args.has('--no-site') || !NF) { console.log('\nSite not deployed (' + (NF ? '--no-site' : 'NETLIFY_TOKEN not set') + ').'); }
else {
  step('Site → Netlify (built from the last commit)');
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'msihub-site-'));
  fs.cpSync(path.join(ROOT, 'site'), tmp, { recursive: true });
  for (const [src, dst] of [['maxsave_crm.html', 'index.html'], ['msihub-data.js', 'msihub-data.js'], ['msihub-data-2.js', 'msihub-data-2.js'], ['msihub-telnyx.js', 'msihub-telnyx.js']]) fs.writeFileSync(path.join(tmp, dst), git('show', 'HEAD:' + src));
  fs.mkdirSync(path.join(tmp, 'fonts'), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'fonts')).filter((x) => x.endsWith('.ttf'))) fs.copyFileSync(path.join(ROOT, 'fonts', f), path.join(tmp, 'fonts', f));
  if (!fs.readFileSync(path.join(tmp, 'index.html'), 'utf8').includes('msihub-telnyx.js')) throw new Error('The last commit does not load msihub-telnyx.js — commit first.');
  const zip = path.join(os.tmpdir(), 'msihub-site-' + Date.now() + '.zip');
  execFileSync('C:/Windows/System32/tar.exe', ['-a', '-c', '-f', zip, '-C', tmp, '.']);
  const r = await fetch('https://api.netlify.com/api/v1/sites/' + NETLIFY_SITE + '/deploys', { method: 'POST', headers: { Authorization: 'Bearer ' + NF, 'Content-Type': 'application/zip' }, body: fs.readFileSync(zip) });
  const d = await r.json(); if (!r.ok) throw new Error('Netlify deploy failed: ' + r.status + ' ' + JSON.stringify(d).slice(0, 300));
  let state = d.state;
  for (let i = 0; i < 40 && state !== 'ready' && state !== 'error'; i++) { await sleep(3000); state = (await (await fetch('https://api.netlify.com/api/v1/deploys/' + d.id, { headers: { Authorization: 'Bearer ' + NF } })).json()).state; }
  const live = await (await fetch(LIVE + '?t=' + Date.now())).text(); const js = await fetch(LIVE + 'msihub-telnyx.js?t=' + Date.now());
  console.log('  deploy ' + d.id + ' → ' + state + ' · live page loads msihub-telnyx.js: ' + live.includes('msihub-telnyx.js') + ' · file served: ' + js.status);
  fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(zip, { force: true });
  if (state !== 'ready') throw new Error('Netlify deploy did not finish: ' + state);
}
console.log('\nDone.' + (wantSms || wantVoice ? '' : ' Texting and calling are still switched off in Settings → Call & Text Settings.'));
