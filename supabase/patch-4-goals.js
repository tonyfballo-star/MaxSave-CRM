// Patch 4: make the Goals & Tiers page, the lead-profile activity feed, and the
// monthly fee drill-down render from live data instead of baked-in samples. Idempotent.
// Run from the MSICRM folder: node supabase/patch-4-goals.js
const fs = require('fs'); const path = require('path');
const FILE = path.join(__dirname, '..', 'maxsave_crm.html');
let src = fs.readFileSync(FILE, 'utf8');
const CRLF = src.includes('\r\n'); if (CRLF) src = src.replace(/\r\n/g, '\n');
if (src.includes('function renderGoalsPage()')) { console.log('Already patched — nothing to do.'); process.exit(0); }
const log = [];
function once(anchor, replacement, label) {
  const n = src.split(anchor).length - 1;
  if (n !== 1) throw new Error(`[${label}] expected exactly 1 match, found ${n}: ${anchor.slice(0, 80)}`);
  src = src.replace(anchor, () => replacement); log.push(label);
}
function rx(re, replacement, label, min, max) {
  const all = src.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
  if (!all) throw new Error(`[${label}] regex did not match`);
  if (all.length !== 1) throw new Error(`[${label}] regex matched ${all.length} times`);
  if (min != null && (all[0].length < min || all[0].length > max)) throw new Error(`[${label}] match length ${all[0].length} outside ${min}-${max}`);
  src = src.replace(re, (...m) => (typeof replacement === 'function' ? replacement(...m) : replacement)); log.push(label + ` (${all[0].length} chars)`);
}

// 1. Goals & Tiers: a static template evaluated once at load -> a render function + page init
rx(/PAGES\.goals = `\n([\s\S]*?)\n`;/, function (_m, body) {
  return "function renderGoalsPage() {\n" +
    "  const _g = AGENTS.map(a => pct(a.apps, a.goal));\n" +
    "  const _avg = _g.length ? Math.round(_g.reduce((s, x) => s + x, 0) / _g.length) : 0;\n" +
    "  const _above = AGENTS.filter((a, i) => _g[i] >= 100);\n" +
    "  const _mid = _g.filter(p => p >= 50 && p < 100).length;\n" +
    "  const _low = _g.filter(p => p < 50).length;\n" +
    "  const _label = (typeof rptDateLabel === 'function') ? rptDateLabel({ dateMode: 'payperiod' }) : '';\n" +
    "  return `\n" + body + "\n`;\n}\n" +
    "PAGES.goals = '';\n" +
    "window.PAGE_INIT = window.PAGE_INIT || {};\n" +
    "window.PAGE_INIT.goals = function () { const c = document.getElementById('content'); if (!c) return; c.innerHTML = ''; const d = document.createElement('div'); d.className = 'page-content'; d.innerHTML = renderGoalsPage(); c.appendChild(d); };";
}, 'goals page function', 1500, 6000);
once('<h1>Goals & Tiers</h1><p>April 1–30, 2026</p>', '<h1>Goals & Tiers</h1><p>${_label}</p>', 'goals date label');
once('<div class="kpi-label">Team Avg % to Goal</div><div class="kpi-value">82%</div>', '<div class="kpi-label">Team Avg % to Goal</div><div class="kpi-value">${_avg}%</div>', 'goals avg');
once('<div class="kpi-label">At or Above Goal</div><div class="kpi-value green">2</div><div class="kpi-sub">Sarah Kim · Marcus Rivera</div>', '<div class="kpi-label">At or Above Goal</div><div class="kpi-value green">${_above.length}</div><div class="kpi-sub">${_above.map(a => a.name).join(\' · \') || \'—\'}</div>', 'goals above');
once('<div class="kpi-label">50–99% to Goal</div><div class="kpi-value amber">2</div>', '<div class="kpi-label">50–99% to Goal</div><div class="kpi-value amber">${_mid}</div>', 'goals mid');
once('<div class="kpi-label">Below 50% to Goal</div><div class="kpi-value red">3</div>', '<div class="kpi-label">Below 50% to Goal</div><div class="kpi-value red">${_low}</div>', 'goals low');

// 2. Lead profile activity feed -> real calls/texts/sales
rx(/\$\{\[\n\s+\['📞','Outbound call','Maria Gonzalez · 8 min 14 sec · Quoted'[\s\S]*?\n\s+\]\.map\(\(\[ico,title,sub,time,cls\]\)=>`/, '${(window.MSIHub && MSIHub.activityFeed ? MSIHub.activityFeed(8) : []).map(([ico,title,sub,time,cls])=>`', 'activity feed', 500, 2000);

// 3. Monthly fee drill-down shares -> computed from that month's sales
rx(/  const agentShares  = \[\n[\s\S]*?\n  \];\n  const sourceShares = \[\n[\s\S]*?\n  \];\n  const carrierShares= \[\n[\s\S]*?\n  \];/,
   "  const { agentShares, sourceShares, carrierShares } = (window.MSIHub && MSIHub.monthShares) ? MSIHub.monthShares(r) : { agentShares: [], sourceShares: [], carrierShares: [] };", 'month shares', 500, 2000);

fs.writeFileSync(FILE, CRLF ? src.replace(/\n/g, '\r\n') : src, 'utf8');
console.log('Applied ' + log.length + ' edits:\n - ' + log.join('\n - '));
