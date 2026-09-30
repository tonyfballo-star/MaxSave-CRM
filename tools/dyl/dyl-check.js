// Read-only check after a failed dyl-import run: which leads did the first batch insert, and how many
// of them duplicate leads the signed-in user cannot see (leads assigned to another agent are hidden by RLS).
// Usage: node dyl-check.js --email=<login> --password=<pw> [--months=24] [--batch=400]
const fs = require('fs'); const readline = require('readline');
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true]; }));
const MONTHS = parseInt(args.months || '24', 10); const BATCH = parseInt(args.batch || '400', 10);
const URL = 'https://xcwkkynxgojmabxdrngm.supabase.co'; const KEY = 'sb_publishable__FNJF77rVOr5kbP2grko_w_0sIz3GDM';
const IN = 'C:/Users/Tony Ballo/OneDrive/Desktop/DYL Export/leads.jsonl';
const REAL_DISP = new Set(['New Sale', 'New Sale - Chula Vista', 'Already Sold', 'Quoted', 'Do Not Call', 'REFUND', 'Rewrite', 'Follow Up', 'HR', 'SPANISH', 'Referral', 'Walk in - Chula Vista']);
const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - MONTHS); const CUTOFF = cutoff.toISOString().slice(0, 10);
const inScope = (L) => L.customer || REAL_DISP.has(L.disposition) || (L.received || '') >= CUTOFF;
let TOKEN = null;
async function api(path) { const r = await fetch(URL + path, { headers: { apikey: KEY, Authorization: 'Bearer ' + TOKEN } }); const t = await r.text(); if (!r.ok) throw new Error(path + ' → ' + r.status + ' ' + t.slice(0, 200)); return JSON.parse(t); }
async function scanLeads(select) { const out = []; let last = null; for (;;) { const filter = last ? '&or=(received_at.lt.' + encodeURIComponent(last.received_at) + ',and(received_at.eq.' + encodeURIComponent(last.received_at) + ',id.gt.' + last.id + '))' : ''; const rows = await api('/rest/v1/leads?select=id,received_at,' + select + '&order=received_at.desc,id.asc&limit=1000' + filter); rows.forEach((r) => out.push(r)); if (rows.length < 1000) break; last = rows[rows.length - 1]; } return out; }
(async () => {
  const r = await fetch(URL + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: args.email, password: args.password }) });
  const j = await r.json(); if (!j.access_token) throw new Error('login failed'); TOKEN = j.access_token;
  const me = await api('/rest/v1/profiles?select=id,full_name,role&id=eq.' + j.user.id); console.log('signed in as', me[0].full_name, '(' + me[0].role + ')');
  const picked = []; const rl = readline.createInterface({ input: fs.createReadStream(IN) });
  for await (const line of rl) { if (!line) continue; const L = JSON.parse(line); if (inScope(L)) picked.push(L); }
  const visible = await scanLeads('agent_id,dyl_id:details->>dyl_id,created_by');
  const visibleIds = new Set(visible.filter((v) => v.dyl_id).map((v) => v.dyl_id));
  const todo = picked.filter((L) => !visibleIds.has(L.dyl_id));
  const notNew = todo.filter((L) => (L.received || '') < '2026-09-15');
  const byAssigned = {}; notNew.forEach((L) => { byAssigned[L.assigned || 'Unassigned'] = (byAssigned[L.assigned || 'Unassigned'] || 0) + 1; });
  console.log('in scope', picked.length, '| visible in DB', visibleIds.size, '| would insert', todo.length, '| of which received before 09/15 (suspect hidden duplicates)', notNew.length, JSON.stringify(byAssigned));
  // What did the failed run insert? Its first batch = the first BATCH of "todo" as computed at that time.
  // Those rows are now visible (agent_id null), so they are in visibleIds; recompute the batch from the ORIGINAL todo = picked minus (visible minus rows created in the failed run).
  // Approach: the failed run's inserted rows are exactly the visible rows whose dyl_id is assigned to someone else in DYL and received before 09/15.
  const byDyl = new Map(picked.map((L) => [L.dyl_id, L]));
  const suspects = visible.filter((v) => v.dyl_id && byDyl.has(v.dyl_id)).filter((v) => { const L = byDyl.get(v.dyl_id); return v.agent_id === null && L.assigned && L.assigned !== 'Unassigned' && (L.received || '') < '2026-09-15'; });
  const sa = {}; suspects.forEach((v) => { const a = byDyl.get(v.dyl_id).assigned; sa[a] = (sa[a] || 0) + 1; });
  console.log('visible unassigned leads that DYL says were assigned (pre-09/15):', suspects.length, JSON.stringify(sa));
  const ids = suspects.map((v) => v.id);
  let notes = 0; for (let i = 0; i < ids.length; i += 200) { const rows = await api('/rest/v1/notes?select=id&lead_id=in.(' + ids.slice(i, i + 200).join(',') + ')'); notes += rows.length; }
  console.log('notes attached to those leads:', notes);
  const recv = suspects.map((v) => v.received_at).sort(); console.log('received range of suspects:', recv[0], '→', recv[recv.length - 1]);
  fs.writeFileSync(__dirname + '/dup-suspects.json', JSON.stringify(suspects.map((v) => ({ id: v.id, dyl_id: v.dyl_id, received_at: v.received_at, assigned: byDyl.get(v.dyl_id).assigned })), null, 1));
  console.log('wrote dup-suspects.json');
})().catch((e) => { console.error('CHECK FAILED', e.message); process.exit(1); });
