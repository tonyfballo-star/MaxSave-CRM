// Talk to the lead-intake endpoints. Reads the secret function names from supabase/local-intake-secrets.json (gitignored).
// Usage: node intake-ping.js status          health check: counts, recent rows, latest payload shape per vendor
//        node intake-ping.js test [eq|ma]    post one clearly labelled test lead, then the same lead again (expect duplicate)
//        node intake-ping.js url [eq|ma]     print the URL to give the vendor
const fs = require('fs'); const path = require('path');
const sec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'local-intake-secrets.json'), 'utf8'));
const BASE = 'https://xcwkkynxgojmabxdrngm.supabase.co/rest/v1/rpc/'; const KEY = 'sb_publishable__FNJF77rVOr5kbP2grko_w_0sIz3GDM';
const url = (fn) => BASE + fn + '?apikey=' + KEY;
const fnFor = (v) => (v === 'ma' ? 'hook_ma_' + sec.ma : 'hook_eq_' + sec.eq);
async function post(fn, body) {
  const r = await fetch(url(fn), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch (_) { j = t; }
  return { http: r.status, body: j };
}
(async () => {
  const [cmd, vendor] = process.argv.slice(2);
  if (cmd === 'url') { console.log(url(fnFor(vendor))); return; }
  if (cmd === 'status') { const r = await post('hook_status_' + sec.st, {}); console.log(JSON.stringify(r, null, 1)); return; }
  if (cmd === 'test') {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
    const lead = { lead_id: 'TEST-' + stamp, first_name: 'Webhook', last_name: 'Test Delete Me', phone: '(619) 555-01' + stamp.slice(-2), email: 'webhook-test@example.com',
      address: '1 Test St', city: 'San Diego', state: 'CA', zip: '92101', current_carrier: 'None', vehicle_year: 2020, vehicle_make: 'Test', vehicle_model: 'Vehicle' };
    console.log('first post  →', JSON.stringify(await post(fnFor(vendor), lead)));
    console.log('second post →', JSON.stringify(await post(fnFor(vendor), lead)));
    return;
  }
  console.log('usage: node intake-ping.js status | test [eq|ma] | url [eq|ma]');
})().catch((e) => { console.error('PING FAILED', e.message); process.exit(1); });
