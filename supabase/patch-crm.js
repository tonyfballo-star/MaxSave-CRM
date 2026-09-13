// One-time patch: wires maxsave_crm.html to the Supabase data layer.
// Every edit is anchored on an exact string or regex and must match exactly once,
// so the script fails loudly instead of silently corrupting the file.
// Usage: node supabase/patch-crm.js   (run from the MSICRM folder)
const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, '..', 'maxsave_crm.html');
let src = fs.readFileSync(FILE, 'utf8');
const CRLF = src.includes('\r\n');
if (CRLF) src = src.replace(/\r\n/g, '\n');
if (src.includes('msihub-data.js')) { console.log('Already patched — nothing to do.'); process.exit(0); }
const log = [];

function once(anchor, replacement, label) {
  const n = src.split(anchor).length - 1;
  if (n !== 1) throw new Error(`[${label}] expected exactly 1 match, found ${n}: ${anchor.slice(0, 80)}`);
  src = src.replace(anchor, () => replacement);
  log.push(label);
}
function rx(re, replacement, label, min, max) {
  const m = src.match(re);
  if (!m) throw new Error(`[${label}] regex did not match`);
  if (src.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')).length !== 1) throw new Error(`[${label}] regex matched more than once`);
  if (min != null && (m[0].length < min || m[0].length > max)) throw new Error(`[${label}] match length ${m[0].length} outside ${min}-${max}`);
  src = src.replace(re, () => replacement);
  log.push(label + ` (${m[0].length} chars)`);
}

// 1. Libraries + data layer
once('<link href="https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700;800&family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">',
     '<link href="https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700;800&family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">\n<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>', 'supabase-js script');
once('</script>\n</body>', '</script>\n<script src="msihub-data.js"></script>\n</body>', 'data layer script');

// 2. Login-aware boot + page tracking
once("  nav('dashboard', document.querySelector('.nav-item'));\n  if (localStorage.getItem('maxsave-dark') === '1') {",
     "  if (window.MSIHub) MSIHub.boot(); else nav('dashboard', document.querySelector('.nav-item'));\n  if (localStorage.getItem('maxsave-dark') === '1') {", 'boot');
once('function nav(page, el) {', 'function nav(page, el) {\n  window.CURRENT_PAGE = page;', 'track current page');
once("leaddetail:'Lead Detail — Maria Gonzalez'", "leaddetail:'Lead Detail'", 'nav title');

// 3. Sidebar / topbar user identity
once('<div class="avatar av-green" style="flex-shrink:0">TB</div>', '<div class="avatar av-green" id="sidebarAvatar" style="flex-shrink:0">TB</div>', 'sidebar avatar id');
once('<div class="user-name">Tony Ballo</div>', '<div class="user-name" id="sidebarUserName">Tony Ballo</div>', 'sidebar name id');
once('<div class="user-role">Admin</div>', '<div class="user-role" id="sidebarUserRole">Admin</div>', 'sidebar role id');
once('<div class="avatar av-green" style="cursor:pointer;font-size:12px">TB</div>', '<div class="avatar av-green" id="topbarAvatar" style="cursor:pointer;font-size:12px">TB</div>', 'topbar avatar id');

// 4. Lead list + board: open the clicked lead, real call/text handlers, New Lead button
once(`onclick="nav('leaddetail',null)" style="font-weight:700;color:var(--navy-900);cursor:pointer;font-size:18px">\${l.name}</div>`,
     `onclick="openLeadDetail('\${l.id}')" style="font-weight:700;color:var(--navy-900);cursor:pointer;font-size:18px">\${l.name}</div>`, 'row name click');
once(`title="View" onclick="nav('leaddetail',null)"`, `title="View" onclick="openLeadDetail('\${l.id}')"`, 'row view button');
once(`title="Call \${l.name}" onclick="alert('Calling \${l.name} at \${l.phone}…')"`, `title="Call" onclick="leadCall('\${l.id}')"`, 'row call button');
once(`title="Text \${l.name}" onclick="openTextThread()"`, `title="Text" onclick="leadText('\${l.id}')"`, 'row text button');
once(`onclick="if(!event.target.closest('.board-card-action'))nav('leaddetail',null)"`, `onclick="if(!event.target.closest('.board-card-action'))openLeadDetail('\${l.id}')"`, 'board card click');
once(`title="Call" onclick="event.stopPropagation();alert('Calling \${l.name} at \${l.phone}…')"`, `title="Call" onclick="event.stopPropagation();leadCall('\${l.id}')"`, 'board call button');
once(`title="Text" onclick="event.stopPropagation();openTextThread()"`, `title="Text" onclick="event.stopPropagation();leadText('\${l.id}')"`, 'board text button');
rx(/<button class="btn btn-primary">(<svg[^>]*>[\s\S]*?<\/svg>) New Lead<\/button>/, '<button class="btn btn-primary" onclick="openLeadForm()">$1 New Lead</button>', 'New Lead button', 50, 400);

// 5. Lead detail template: wrap the page body so it can be re-rendered per lead
once('PAGES.leaddetail = `\n', 'PAGES.leaddetail = `\n<div id="leadDetailBody">\n', 'lead body open');
once('<!-- QUOTE EXPORT MODAL -->', '</div>\n<!-- QUOTE EXPORT MODAL -->', 'lead body close');
once('Schedule a follow-up with <strong>Maria Gonzalez</strong>', 'Schedule a follow-up with <strong id="apptLeadNameLabel">this lead</strong>', 'appointment label');

// 6. Quote export: use real records
once('recordLabel = `${c.first} ${c.last} (${c.id})`;', 'recordLabel = `${c.first} ${c.last} (${c.custNo||c.id})`;', 'customer export label');
rx(/recordLabel = 'Maria Gonzalez \(MSI-2026-04841\)';\n    fields = \[[\s\S]*?\n    \];\n  \}/,
   "const _lf = (window.MSIHub && MSIHub.leadExportFields()) || { label: window._currentLeadName || 'Lead', fields: [] };\n    recordLabel = _lf.label;\n    fields = _lf.fields;\n  }", 'lead export fields', 300, 2000);

// 7. Template editor: ids are UUIDs now, not numbers
once(`onclick="saveTemplateRow(' + t.id + ',this)"`, `onclick="saveTemplateRow(&quot;' + t.id + '&quot;,this)"`, 'template save id');
once(`onclick="deleteTemplate(' + t.id + ')"`, `onclick="deleteTemplate(&quot;' + t.id + '&quot;)"`, 'template delete id');
once('return x.id === parseInt(id);', 'return String(x.id) === String(id);', 'template lookup');

// 8. Customer detail: live call log, texts, notes
rx(/const callLog = \[\n[\s\S]*?\n  \];/, 'const callLog = (window.MSIHub ? MSIHub.customerCallLog(c) : []);', 'customer call log', 300, 2000);
rx(/<div style="padding:20px;display:flex;flex-direction:column;gap:10px;max-height:400px;overflow-y:auto">\n[\s\S]*?\n        <\/div>\n        <div style="padding:12px 20px;border-top:1px solid var\(--border\);display:flex;gap:8px;align-items:flex-end">/,
   '<div id="cdTextThread" style="padding:20px;display:flex;flex-direction:column;gap:10px;max-height:400px;overflow-y:auto">\n          ${window.MSIHub ? MSIHub.customerTextBubbles(c) : \'\'}\n        </div>\n        <div style="padding:12px 20px;border-top:1px solid var(--border);display:flex;gap:8px;align-items:flex-end">', 'customer text tab', 500, 4000);
once('placeholder="Type a message&hellip;"></textarea>\n          <button class="btn btn-primary" style="padding:10px 22px;font-weight:700;font-size:13px">Send</button>',
     'placeholder="Type a message&hellip;" id="cdTextInput"></textarea>\n          <button class="btn btn-primary" style="padding:10px 22px;font-weight:700;font-size:13px" onclick="MSIHub.sendCustomerText()">Send</button>', 'customer text send');
once(`onclick="alert('Note saved!')"`, 'onclick="MSIHub.saveCustomerNote()"', 'customer note save');
rx(/<div style="display:flex;flex-direction:column;gap:9px">\n          <div style="padding:13px 15px;background:var\(--gray-50\)[\s\S]*?\n        <\/div>\n      <\/div>\n    <\/div>\n\n    <!-- BOTTOM INFO GRID/,
   '<div style="display:flex;flex-direction:column;gap:9px" id="cdNotesList">${window.MSIHub ? MSIHub.customerNotesHTML(c) : \'\'}</div>\n      </div>\n    </div>\n\n    <!-- BOTTOM INFO GRID', 'customer notes tab', 500, 4000);

// 9. Remove sample data + demo timers (real data now comes from the database)
rx(/const LEADS = \(function\(\)\{[\s\S]*?\n\}\)\(\);/, 'const LEADS = [];', 'sample leads', 2000, 20000);
rx(/const CUSTOMERS = \[\n[\s\S]*?\n\];/, 'const CUSTOMERS = [];', 'sample customers', 5000, 40000);
rx(/const APPOINTMENTS = \[\n[\s\S]*?\n\];/, 'const APPOINTMENTS = [];', 'sample appointments', 2000, 20000);
rx(/window\.TEAM_MEMBERS = window\.TEAM_MEMBERS \|\| \[\n[\s\S]*?\n\];/, 'window.TEAM_MEMBERS = window.TEAM_MEMBERS || [];', 'sample team', 1000, 20000);
rx(/window\.CONVERSATIONS = \{\n  '\(619\) 555-0124': \[[\s\S]*?\n\};/, 'window.CONVERSATIONS = {};', 'sample conversations', 1000, 20000);
rx(/window\.TEXT_THREADS = \{\n[\s\S]*?\n\};/, 'window.TEXT_THREADS = {};', 'sample threads', 500, 20000);
rx(/\/\/ Demo: simulate notifications a few seconds after first load\n\(function\(\)\{[\s\S]*?\n\}\)\(\);\n/, '', 'demo timers', 200, 2000);
once("window.CURRENT_THREAD_CONTACT = { name:'Maria Gonzalez', phone:'(619) 555-0124' };", 'window.CURRENT_THREAD_CONTACT = null;', 'thread default');

// 10. Calendar: use the real date instead of a frozen May 2026
once("cursor: new Date(2026,4,1), selectedDate:'2026-05-02'", 'cursor: new Date(), selectedDate: new Date().toISOString().slice(0,10)', 'calendar cursor');
{ const n = src.split('new Date(2026,4,2)').length - 1; if (n !== 2) throw new Error('calendar today: expected 2, found ' + n); src = src.split('new Date(2026,4,2)').join('new Date()'); log.push('calendar today (2)'); }

fs.writeFileSync(FILE, CRLF ? src.replace(/\n/g, '\r\n') : src, 'utf8');
console.log('Applied ' + log.length + ' edits:\n - ' + log.join('\n - '));
