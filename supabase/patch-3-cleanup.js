// Patch 3: remove the remaining sample data (tasks, live view, inbox, report
// charts, per-agent stats), drop the dead static lead-profile markup, fix the
// frozen dates, and load msihub-data-2.js. Idempotent.
// Run from the MSICRM folder: node supabase/patch-3-cleanup.js
const fs = require('fs'); const path = require('path');
const FILE = path.join(__dirname, '..', 'maxsave_crm.html');
let src = fs.readFileSync(FILE, 'utf8');
const CRLF = src.includes('\r\n'); if (CRLF) src = src.replace(/\r\n/g, '\n');
if (src.includes('msihub-data-2.js')) { console.log('Already patched — nothing to do.'); process.exit(0); }
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
  src = src.replace(re, () => replacement); log.push(label + ` (${all[0].length} chars)`);
}

// 1. Load part 2 of the data layer
once('<script src="msihub-data.js"></script>', '<script src="msihub-data.js"></script>\n<script src="msihub-data-2.js"></script>', 'data layer 2 script');

// 2. Sample data → empty (the data layer fills these from the database)
rx(/window\.TASKS_DATA = \[\n[\s\S]*?\n\];/, 'window.TASKS_DATA = [];', 'sample tasks', 500, 5000);
rx(/window\.AGENT_LIVE = \[\n[\s\S]*?\n\];/, 'window.AGENT_LIVE = [];', 'sample live agents', 500, 5000);
rx(/window\.CALL_HISTORY = \[\n[\s\S]*?\n\];/, 'window.CALL_HISTORY = [];', 'sample call history', 500, 6000);
rx(/window\.TEXT_HISTORY = \[\n[\s\S]*?\n\];/, 'window.TEXT_HISTORY = [];', 'sample text history', 300, 4000);
rx(/window\.EMAILS = \[\n[\s\S]*?\n\];/, 'window.EMAILS = [];', 'sample emails', 300, 6000);
rx(/const AGENT_EXTENDED_DATA = \{\n[\s\S]*?\n\};/, 'const AGENT_EXTENDED_DATA = {};   // filled per agent by msihub-data-2.js', 'sample agent stats', 500, 6000);
rx(/const CARRIER_DATA = \[\n[\s\S]*?\n\];/, 'const CARRIER_DATA = [];   // report rows, filled by msihub-data-2.js (settings list lives on window.CARRIER_DATA)', 'sample carrier report', 300, 4000);
rx(/const LEAD_SOURCE_DATA = \[\n[\s\S]*?\n\];/, 'const LEAD_SOURCE_DATA = [];', 'sample lead source report', 300, 4000);
rx(/const POLICY_TYPE_DATA = \[\n[\s\S]*?\n\];/, 'const POLICY_TYPE_DATA = [];', 'sample policy type report', 200, 3000);
rx(/const MONTHLY_REVENUE = \[\n[\s\S]*?\n\];/, 'const MONTHLY_REVENUE = [];', 'sample monthly revenue', 200, 3000);
rx(/const FEE_AGING_DATA = \[\n[\s\S]*?\n\];/, 'const FEE_AGING_DATA = [];', 'sample fee aging', 100, 2000);
rx(/const FEE_AGING_ACCOUNTS = \{\n[\s\S]*?\n\};/, 'const FEE_AGING_ACCOUNTS = {};', 'sample fee aging accounts', 500, 8000);

// 3. Dead static lead-profile markup (the page body is rendered per lead now)
rx(/<div id="leadDetailBody">\n[\s\S]*?\n<\/div>\n<!-- QUOTE EXPORT MODAL -->/, '<div id="leadDetailBody"></div>\n<!-- QUOTE EXPORT MODAL -->', 'static lead profile markup', 20000, 120000);

// 4. Frozen dates and hardcoded people
once("const TODAY_ISO = '2026-05-01';", "const TODAY_ISO = (function(){ const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); })();", 'today constant');
once("loggedInAgent:'Sarah Kim',", "loggedInAgent:'',", 'inbox logged-in agent');
once("loggedInAgent: 'Tony Ballo',", "loggedInAgent: '',", 'live view logged-in agent');
once('${today} · Sarah Kim · Real-time dialer + texting activity', '${today} · ${(window.CURRENT_USER||{}).name||\'\'} · Real-time dialer + texting activity', 'live view header');
once('  const inboundQ  = 2;', '  const inboundQ  = 0;', 'inbound queue count');
once("let lead = { name:'Maria Gonzalez', phone:'(619) 555-0124', agent:'Sarah Kim', policy:'Auto' };", "let lead = { name:'Customer', phone:'', agent:(window.CURRENT_USER||{}).name||'', policy:'Auto' };", 'bulk preview default lead');
once(".replace(/\\{\\{agent\\}\\}/g, lead.agent || 'Sarah Kim')", ".replace(/\\{\\{agent\\}\\}/g, lead.agent || (window.CURRENT_USER||{}).name || '')", 'bulk preview agent');
once(".replace(/\\{\\{agent\\}\\}/g, 'Sarah Kim')", ".replace(/\\{\\{agent\\}\\}/g, (window.CURRENT_USER||{}).name || '')", 'thread template agent');
once("todayBucket.msgs.push({ from:'us', time, author:'Sarah Kim', text });", "todayBucket.msgs.push({ from:'us', time, author:(window.CURRENT_USER||{}).name||'', text });", 'thread author');
once("call = call || { name:'Maria Gonzalez', phone:'(619) 555-0124', isCustomer:true };", "call = call || { name:'Unknown caller', phone:'', isCustomer:false };", 'inbound call default');
once("const agentOptions = ['Admin (Tony Ballo)', ...AGENTS.map(a => a.name)];", "const agentOptions = ['Admin (' + ((window.CURRENT_USER||{}).name||'Admin') + ')', ...AGENTS.map(a => a.name)];", 'task assignee options');
{ const n = src.split("n==='Admin'?'Admin (Tony Ballo)'").length - 1; if (n !== 1) throw new Error('task filter label: expected 1, found ' + n); src = src.replace("n==='Admin'?'Admin (Tony Ballo)'", "n==='Admin'?'Admin ('+((window.CURRENT_USER||{}).name||'Admin')+')'"); log.push('task filter label'); }

fs.writeFileSync(FILE, CRLF ? src.replace(/\n/g, '\r\n') : src, 'utf8');
console.log('Applied ' + log.length + ' edits:\n - ' + log.join('\n - '));
