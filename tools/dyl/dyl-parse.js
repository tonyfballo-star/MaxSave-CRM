// Parse all DYL export CSVs into one lead-per-record JSON (cars/drivers stitched from continuation rows).
// Usage: node dyl-parse.js [--stats-only]   -> writes DYL Export/leads.jsonl (one JSON per line) + prints stats
const fs = require('fs'); const path = require('path'); const { parse } = require('csv-parse/sync');
const OUT = 'C:/Users/Tony Ballo/OneDrive/Desktop/DYL Export';
const STATS_ONLY = process.argv.includes('--stats-only');
const files = [];
for (const type of fs.readdirSync(OUT)) { const dir = path.join(OUT, type); if (!fs.statSync(dir).isDirectory()) continue; for (const f of fs.readdirSync(dir)) if (f.endsWith('.csv') && fs.statSync(path.join(dir, f)).size > 0) files.push({ type, month: f.replace('.csv', ''), file: path.join(dir, f) }); }
files.sort((a, b) => (a.type + a.month).localeCompare(b.type + b.month));
const redact = (s) => String(s || '').replace(/\b(?:\d[ -]?){13,16}\b/g, '[card removed]').replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[ssn removed]');
const clean = (v) => { const s = String(v == null ? '' : v).trim(); return s === '' ? null : s; };
const norm = (h) => h.trim();
let out = STATS_ONLY ? null : fs.createWriteStream(path.join(OUT, 'leads.jsonl'));
const stats = { files: 0, rows: 0, leads: 0, customers: 0, byDisposition: {}, byYear: {}, byType: {}, bySource: {}, byAssigned: {}, withEmail: 0, withNote: 0, cars: 0, drivers: 0, dupIds: 0 };
const seen = new Set();
for (const f of files) {
  let rows; try { rows = parse(fs.readFileSync(f.file, 'utf8'), { relax_column_count: true, relax_quotes: true, bom: true }); } catch (e) { console.error('parse failed', f.file, e.message); continue; }
  if (!rows.length) continue; stats.files++;
  const hdr = rows[0].map(norm); const col = {}; hdr.forEach((h, i) => { if (col[h] === undefined) col[h] = i; });   // first occurrence wins
  const carCols = hdr.map((h, i) => [h, i]).filter(([h]) => h.startsWith('Car ')); const drvCols = hdr.map((h, i) => [h, i]).filter(([h]) => h.startsWith('Driver '));
  const g = (r, name) => clean(r[col[name]]);
  const carOf = (r) => { const o = {}; for (const [h, i] of carCols) { const v = clean(r[i]); if (v) o[h.slice(4)] = v; } return Object.keys(o).length ? o : null; };
  const drvOf = (r) => { const o = {}; for (const [h, i] of drvCols) { const v = clean(r[i]); if (v) o[h.slice(7)] = v; } return Object.keys(o).length ? o : null; };
  let cur = null;
  const flush = () => { if (!cur) return; stats.leads++; if (cur.customer) stats.customers++; if (cur.email) stats.withEmail++; if (cur.note) stats.withNote++; stats.cars += cur.cars.length; stats.drivers += cur.drivers.length;
    const y = (cur.received || '').slice(0, 4); stats.byYear[y] = (stats.byYear[y] || 0) + 1; stats.byDisposition[cur.disposition || 'None'] = (stats.byDisposition[cur.disposition || 'None'] || 0) + 1; stats.byType[cur.lead_type] = (stats.byType[cur.lead_type] || 0) + 1; stats.bySource[cur.source] = (stats.bySource[cur.source] || 0) + 1; stats.byAssigned[cur.assigned] = (stats.byAssigned[cur.assigned] || 0) + 1;
    if (out) out.write(JSON.stringify(cur) + '\n'); cur = null; };
  for (const r of rows.slice(1)) {
    stats.rows++;
    const id = g(r, 'Id');
    if (id) {
      flush();
      if (seen.has(id)) { stats.dupIds++; cur = null; continue; } seen.add(id);
      cur = { dyl_id: id, first: g(r, 'FirstName'), last: g(r, 'LastName'), phone: g(r, 'Phone'), phone2: g(r, 'Phone2'), email: g(r, 'Email'), address: g(r, 'Address'), address2: g(r, 'Address2'), city: g(r, 'City'), state: g(r, 'State'), zip: g(r, 'Zip'),
        dob: g(r, 'Date of Birth'), occupation: g(r, 'Occupation'), company: g(r, 'Company'), received: g(r, 'Received'), lead_type: g(r, 'LeadType') || f.type, source: g(r, 'Source'), disposition: g(r, 'Disposition'), customer: g(r, 'Customer') === 'Yes', assigned: g(r, 'Assigned'), note: redact(g(r, 'Note')), call_result: g(r, 'Call Result'),
        credit: g(r, 'Credit History'), bodily_injury: g(r, 'Bodily Injury'), bankruptcy: g(r, 'Bankruptcy'), coverage_duration: g(r, 'Coverage Duration'), policy_expiration: g(r, 'Policy Expiration'), home_ownership: g(r, 'Home Ownership'), insured: g(r, 'Insured'), residency: g(r, 'Length of Residency'), requested_coverage: g(r, 'Requested Coverage'), current_carrier: g(r, 'Current Carrier'), deductible: g(r, 'Deductible'), um: g(r, 'Uninsured Motorist'), uim: g(r, 'Underinsured Motorist'), language: g(r, 'Preferred Language'), best_time: g(r, 'Best Time to Contact'), sr22: g(r, 'Driver SR-22 Required'),
        cars: [], drivers: [] };
    }
    if (!cur) continue;
    const car = carOf(r); if (car) cur.cars.push(car);
    const drv = drvOf(r); if (drv) cur.drivers.push(drv);
  }
  flush();
}
if (out) out.end();
console.log(JSON.stringify(stats, null, 1));
