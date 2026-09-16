// Import DYL leads (from leads.jsonl) into the MSIHub database.
// Usage: node dyl-import.js --scope=recommended|customers|all [--months=12] [--dry-run] [--limit=N] --email=<login> --password=<pw>
// Scope "recommended": every customer + every lead with a real disposition (incl. Do Not Call) + all leads from the last N months.
const fs = require('fs'); const readline = require('readline');
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true]; }));
const SCOPE = args.scope || 'recommended'; const MONTHS = parseInt(args.months || '12', 10); const DRY = !!args['dry-run']; const LIMIT = parseInt(args.limit || '0', 10);
const URL = 'https://xcwkkynxgojmabxdrngm.supabase.co'; const KEY = 'sb_publishable__FNJF77rVOr5kbP2grko_w_0sIz3GDM';
const IN = 'C:/Users/Tony Ballo/OneDrive/Desktop/DYL Export/leads.jsonl';

const DISP = { 'New Sale': 'Already Sold', 'New Sale - Chula Vista': 'Already Sold', 'Already Sold': 'Already Sold', 'Quoted': 'Quoted', 'Bad Lead': 'Bad Lead', 'Do Not Call': 'Do Not Call', 'REFUND': 'Refund', 'Rewrite': 'Rewrite', 'Follow Up': 'Follow Up', 'HR': 'HR', 'SPANISH': 'Spanish', 'Referral': 'Referral', 'Walk in - Chula Vista': 'Referral', 'None': null };
const STATUS = (d, callResult, customer) => { if (customer || /New Sale|Already Sold/.test(d || '')) return 'Sold'; if (d === 'Quoted') return 'Quoted'; if (d === 'Bad Lead' || d === 'Do Not Call') return 'Bad Lead'; if (d && d !== 'None') return 'Contacted'; return /reached/i.test(callResult || '') ? 'Contacted' : 'New Lead'; };
const REAL_DISP = new Set(['New Sale', 'New Sale - Chula Vista', 'Already Sold', 'Quoted', 'Do Not Call', 'REFUND', 'Rewrite', 'Follow Up', 'HR', 'SPANISH', 'Referral', 'Walk in - Chula Vista']);
const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - MONTHS); const CUTOFF = cutoff.toISOString().slice(0, 10);
const fmtPhone = (p) => { const d = String(p || '').replace(/\D/g, ''); if (d.length === 11 && d[0] === '1') return fmtPhone(d.slice(1)); return d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : (p || null); };
const pacificISO = (s) => { if (!s) return null; const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/); if (!m) return null; const mo = +m[2]; return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${mo >= 4 && mo <= 10 ? '-07:00' : '-08:00'}`; };
const isoDate = (s) => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);
const title = (s) => (s ? s.replace(/\S+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()) : s);
const inScope = (L) => { if (SCOPE === 'all') return true; if (L.customer) return true; if (SCOPE === 'customers') return false; if (REAL_DISP.has(L.disposition)) return true; return (L.received || '') >= CUTOFF; };

function mapLead(L, createdBy) {
  const d1 = L.drivers[0] || {}; const c1 = L.cars[0] || {};
  const drivers = L.drivers.map((d, i) => ({ name: [d['First Name'], d['Last Name']].filter(Boolean).join(' ') || null, dob: isoDate(d['Date of Birth']), gender: d.Gender || null, marital: d['Marital Status'] || null, license: [d['License Status'], d['State Licensed']].filter(Boolean).join(' · ') || null, violations: d.Violations || (d.Suspension === 'true' ? 'Suspension' : null), relationship: d.Relationship || null, occupation: d.Occupation || null, sr22: d['SR-22 Required'] === 'true', primary: i === 0 }));
  const vehicles = L.cars.map((c) => ({ year: parseInt(c['Vehicle Model Year']) || null, make: title(c['Vehicle Make']) || null, model: c['Vehicle Model'] || null, trim: c['Vehicle Trim'] || null, vin: c['VIN Number'] || null, use: c['Primary Use'] || null, mileage: c['Annual Mileage'] ? c['Annual Mileage'] + ' mi/yr' : null, ownership: c.Ownership || null, garaging: c.Garage === 'true' ? 'Garage' : null, coverage: c['Car Coverage'] || null }));
  const disp = DISP[L.disposition] === undefined ? L.disposition : DISP[L.disposition];
  const prior = [L.current_carrier, L.insured === 'true' ? 'currently insured' : (L.insured === 'false' ? 'uninsured' : null), L.policy_expiration ? 'exp ' + L.policy_expiration : null].filter(Boolean).join(' — ') || null;
  return {
    first_name: title(L.first) || '', last_name: title(L.last) || '', phone: fmtPhone(L.phone), email: L.email ? L.email.toLowerCase() : null,
    status: STATUS(L.disposition, L.call_result, L.customer), disposition: disp, policy_type: L.lead_type === 'Contact' ? 'Auto' : (L.lead_type || 'Auto'), source: L.source || null, agent_id: null,
    received_at: pacificISO(L.received) || new Date().toISOString(), fee: 0, sr22: drivers.some((d) => d.sr22), language: L.language || (L.disposition === 'SPANISH' ? 'Spanish' : 'English'), prior_coverage: prior, best_time: L.best_time || null, lead_score: null, do_not_call: L.disposition === 'Do Not Call',
    details: { dyl_id: L.dyl_id, dyl_assigned: L.assigned && L.assigned !== 'Unassigned' ? L.assigned : null, dyl_customer: L.customer, dyl_call_result: L.call_result || null, dyl_disposition: L.disposition,
      dob: isoDate(L.dob) ? isoDate(L.dob).split('-').slice(1).concat(isoDate(L.dob).slice(0, 4)).join('/') : null, gender: d1.Gender || null, marital: d1['Marital Status'] || null, license: [d1['License Status'], d1['State Licensed']].filter(Boolean).join(' · ') || null, violations: d1.Violations || null,
      address: [L.address, L.address2].filter(Boolean).join(', ') || null, city: L.city || null, state: L.state || 'CA', zip: L.zip || null, phone2: fmtPhone(L.phone2), occupation: L.occupation || null,
      vehicle: vehicles[0] ? { year: vehicles[0].year, make: vehicles[0].make, model: vehicles[0].model, vin: vehicles[0].vin, use: vehicles[0].use, mileage: vehicles[0].mileage } : {}, vehicles, drivers, driver2: drivers[1] || null,
      coverage: { type: L.requested_coverage || null, limits: L.bodily_injury || null, deductible: L.deductible || null, um: L.um || null, uim: L.uim || null },
      credit: L.credit || null, home_ownership: L.home_ownership || null, residency_years: L.residency || null, bankruptcy: L.bankruptcy || null, insured: L.insured || null, policy_expiration: L.policy_expiration || null, current_carrier: L.current_carrier || null },
    created_by: createdBy, created_at: pacificISO(L.received) || undefined,
  };
}

async function api(path, opts) {
  const r = await fetch(URL + path, Object.assign({ headers: Object.assign({ apikey: KEY, Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, (opts && opts.headers) || {}) }, opts));
  const t = await r.text(); if (!r.ok) throw new Error(path + ' → ' + r.status + ' ' + t.slice(0, 300)); return t ? JSON.parse(t) : null;
}
let TOKEN = null, ME = null;
async function login() { const r = await fetch(URL + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: args.email, password: args.password }) }); const j = await r.json(); if (!j.access_token) throw new Error('login failed: ' + JSON.stringify(j).slice(0, 200)); TOKEN = j.access_token; ME = j.user.id; }
async function existingDylIds() { const ids = new Set(); let from = 0; for (;;) { const rows = await api(`/rest/v1/leads?select=details->>dyl_id&details->>dyl_id=not.is.null&order=created_at&offset=${from}&limit=1000`); rows.forEach((r) => ids.add(r.dyl_id)); if (rows.length < 1000) break; from += 1000; } return ids; }

(async () => {
  const stats = { read: 0, inScope: 0, customers: 0, notes: 0, vehicles: 0, drivers: 0, skippedExisting: 0, byStatus: {}, inserted: 0, custInserted: 0 };
  const picked = [];
  const rl = readline.createInterface({ input: fs.createReadStream(IN) });
  for await (const line of rl) { if (!line) continue; stats.read++; const L = JSON.parse(line); if (!inScope(L)) continue; stats.inScope++; if (L.customer) stats.customers++; if (L.note) stats.notes++; stats.vehicles += L.cars.length; stats.drivers += L.drivers.length; picked.push(L); if (LIMIT && picked.length >= LIMIT) break; }
  picked.forEach((L) => { const s = STATUS(L.disposition, L.call_result, L.customer); stats.byStatus[s] = (stats.byStatus[s] || 0) + 1; });
  console.log('scope', SCOPE, 'months', MONTHS, 'cutoff', CUTOFF, JSON.stringify(stats));
  if (DRY) return;
  await login(); console.log('signed in as', args.email);
  const existing = await existingDylIds(); console.log('already imported:', existing.size);
  const todo = picked.filter((L) => !existing.has(L.dyl_id)); stats.skippedExisting = picked.length - todo.length;
  const seenCustPhone = new Set();
  for (let i = 0; i < todo.length; i += 400) {
    const batch = todo.slice(i, i + 400);
    const rows = batch.map((L) => mapLead(L, ME));
    const inserted = await api('/rest/v1/leads?select=id,details', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(rows) });
    const idBy = {}; inserted.forEach((r) => { idBy[r.details.dyl_id] = r.id; }); stats.inserted += inserted.length;
    const notes = batch.filter((L) => L.note && idBy[L.dyl_id]).map((L) => ({ lead_id: idBy[L.dyl_id], author_id: null, body: '[DYL] ' + L.note, created_at: pacificISO(L.received) || undefined }));
    if (notes.length) await api('/rest/v1/notes', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(notes) });
    const custs = batch.filter((L) => L.customer && idBy[L.dyl_id]).filter((L) => { const k = String(L.phone || '').replace(/\D/g, '') || L.dyl_id; if (seenCustPhone.has(k)) return false; seenCustPhone.add(k); return true; });
    if (custs.length) {
      const crows = custs.map((L) => { const m = mapLead(L, ME); return { lead_id: idBy[L.dyl_id], first_name: m.first_name, last_name: m.last_name, phone: m.phone, email: m.email, dob: isoDate(L.dob), gender: m.details.gender, marital: m.details.marital, license: m.details.license, address: m.details.address, city: m.details.city, state: m.details.state, zip: m.details.zip, status: 'Active', agent_id: null, sold_by_id: null, customer_since: isoDate(L.received) || new Date().toISOString().slice(0, 10), language: m.language, sr22: m.sr22, referred_by: L.source || null, created_at: m.created_at }; });
      const cins = await api('/rest/v1/customers?select=id,lead_id', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(crows) });
      const custByLead = {}; cins.forEach((c) => { custByLead[c.lead_id] = c.id; }); stats.custInserted += cins.length;
      const veh = [], drv = [];
      custs.forEach((L) => { const cid = custByLead[idBy[L.dyl_id]]; if (!cid) return; const m = mapLead(L, ME); m.details.vehicles.forEach((v) => veh.push({ customer_id: cid, year: v.year, make: v.make, model: v.model, vin: v.vin, use: [v.use, v.mileage].filter(Boolean).join(' · ') || null, garaging: v.garaging, lien: v.ownership })); m.details.drivers.forEach((d) => drv.push({ customer_id: cid, name: d.name || (m.first_name + ' ' + m.last_name), dob: d.dob, gender: d.gender, license: d.license, violations: d.violations, is_primary: d.primary })); });
      if (veh.length) await api('/rest/v1/vehicles', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(veh) });
      if (drv.length) await api('/rest/v1/drivers', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(drv) });
    }
    if ((i / 400) % 10 === 0 || i + 400 >= todo.length) console.log(`progress ${Math.min(i + 400, todo.length)}/${todo.length} leads, ${stats.custInserted} customers`);
  }
  console.log('DONE', JSON.stringify(stats));
})().catch((e) => { console.error('IMPORT FAILED', e.message); process.exit(1); });
