// Bulk-pull DYL leads: for each lead type and month, run the Browse Leads filter, then export CSV
// with Latest Note + Lead Details + Call Results. Resumable (skips files that already exist).
// Usage: node dyl-pull.js <fromYYYY-MM> <toYYYY-MM> [typeName|all]
const puppeteer = require('puppeteer-core'); const http = require('http'); const fs = require('fs'); const path = require('path');
const PORT = 9371; const OUT = 'C:/Users/Tony Ballo/OneDrive/Desktop/DYL Export';
const TYPES = { Auto: '195798', Life: '196167', Contact: '', Health: '195966', Home: '196056' };
const [FROM, TO, ONLY] = process.argv.slice(2);
if (!FROM || !TO) { console.error('usage: node dyl-pull.js 2019-01 2026-09 [Auto|Life|Contact|Health|Home|all]'); process.exit(2); }
const months = []; { let [y, m] = FROM.split('-').map(Number); const [ty, tm] = TO.split('-').map(Number); while (y < ty || (y === ty && m <= tm)) { months.push(y + '-' + String(m).padStart(2, '0')); m++; if (m > 12) { m = 1; y++; } } }
const lastDay = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(y, m, 0).getDate(); };
const log = (s) => { const line = new Date().toISOString().slice(11, 19) + ' ' + s; console.log(line); fs.appendFileSync(path.join(OUT, 'pull.log'), line + '\n'); };

(async () => {
  const v = await new Promise((res) => { http.get({ host: '127.0.0.1', port: PORT, path: '/json/version' }, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => res(d)); }).on('error', () => res(null)); });
  if (!v) throw new Error('DYL browser not running (node dyl.js login ...)');
  const b = await puppeteer.connect({ browserWSEndpoint: JSON.parse(v).webSocketDebuggerUrl });
  const p = (await b.pages()).find((x) => !x.url().startsWith('devtools')); p.setDefaultTimeout(240000);
  if (!/reports\/browse/.test(p.url())) await p.goto('https://my.dyl.com/user/reports/browse', { waitUntil: 'networkidle2', timeout: 60000 });
  const summary = [];
  for (const [tname, tval] of Object.entries(TYPES)) {
    if (ONLY && ONLY !== 'all' && ONLY.toLowerCase() !== tname.toLowerCase()) continue;
    fs.mkdirSync(path.join(OUT, tname), { recursive: true });
    for (const ym of months) {
      const file = path.join(OUT, tname, ym + '.csv');
      if (fs.existsSync(file)) { continue; }
      const start = ym + '-01', end = ym + '-' + String(lastDay(ym)).padStart(2, '0');
      let res;
      for (let attempt = 1; attempt <= 3 && !res; attempt++) {
        try {
          res = await p.evaluate(async (tval, start, end) => {
            const base = { timeframe: 'spc', campaign: '*', folder: '*', start_date: start, start_date_submit: start, end_date: end, end_date_submit: end, type: tval, source: '*', disp: '*', assign: '*', notes: '*', cust: '*', del: '*', show: '25' };
            const fd = new FormData(); fd.append('do-1_2', '1'); fd.append('cmd-1_2', 'filter'); for (const [k, val] of Object.entries(base)) fd.append('d2-' + k, val);
            const fr = await fetch('/user/reports/browse', { method: 'POST', body: fd, headers: { 'X-Requested-With': 'XMLHttpRequest' }, credentials: 'include' });
            const ft = await fr.text(); const count = parseInt(((ft.match(/Leads:\s*([\d,]+)/) || [])[1] || '0').replace(/,/g, ''), 10);
            if (!count) return { count: 0 };
            const f = new URLSearchParams(Object.assign({}, base, { 'd1-format': 'csv', 'd1-applyto': 'allpages', 'cmd-1_1': 'action', 'a0-1_1': 'export', 'do-1_1': '1' }));
            (tval === '' ? ['notes', 'call_result'] : ['notes', 'details', 'call_result']).forEach((o) => f.append('d1-options', o));
            const r = await fetch('/user/reports/browse', { method: 'POST', body: f, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, credentials: 'include' });
            const t = await r.text(); const html = /^\s*<!doctype|<html/i.test(t);
            if (html) return { count, error: ((t.match(/toastr\["error"\]\("([^"]+)"\)/g) || []).filter((s) => !/Error Calling/.test(s)).join(' | ') || 'html response') };
            return { count, csv: t };
          }, tval, start, end);
        } catch (e) { log(`${tname} ${ym} attempt ${attempt} failed: ${e.message}`); await new Promise((r) => setTimeout(r, 3000 * attempt)); }
      }
      if (!res) { summary.push([tname, ym, 'FAILED']); continue; }
      if (res.error) { log(`${tname} ${ym}: ${res.count} leads but export error: ${res.error}`); summary.push([tname, ym, 'ERROR ' + res.error]); continue; }
      if (!res.count) { fs.writeFileSync(file, ''); continue; }
      const rows = res.csv.split(/\r?\n/).filter(Boolean).length - 1;
      fs.writeFileSync(file, res.csv);
      log(`${tname} ${ym}: ${res.count} leads -> ${rows} rows (${(res.csv.length / 1024).toFixed(0)} KB)`);
      summary.push([tname, ym, rows]);
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  log('DONE ' + JSON.stringify(summary.filter((s) => typeof s[2] !== 'number')));
  b.disconnect();
})().catch((e) => { log('PULL FAILED ' + e.message); process.exit(1); });
