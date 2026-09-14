// Patch 2: move the five embedded e-sign PDFs out of maxsave_crm.html into docs/*.pdf
// (page weight 4.9 MB -> ~0.9 MB). Idempotent. Run from the MSICRM folder: node supabase/patch-2-pdfs.js
const fs = require('fs'); const path = require('path');
const ROOT = path.join(__dirname, '..'); const FILE = path.join(ROOT, 'maxsave_crm.html');
let src = fs.readFileSync(FILE, 'utf8');
const CRLF = src.includes('\r\n'); if (CRLF) src = src.replace(/\r\n/g, '\n');
const m = src.match(/const ESIGN_DOC_FILES = \{\n([\s\S]*?)\n\};/);
if (!m) throw new Error('ESIGN_DOC_FILES block not found');
if (!m[1].includes('base64,')) { console.log('Already patched — nothing to do.'); process.exit(0); }
fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
const entries = [];
for (const line of m[1].split('\n')) {
  const mm = line.match(/^\s*(\w+):\s*'data:application\/pdf;base64,([A-Za-z0-9+/=]+)'/);
  if (!mm) throw new Error('unexpected line: ' + line.slice(0, 60));
  const buf = Buffer.from(mm[2], 'base64');
  if (buf.slice(0, 4).toString() !== '%PDF') throw new Error(mm[1] + ' is not a PDF');
  fs.writeFileSync(path.join(ROOT, 'docs', mm[1] + '.pdf'), buf);
  entries.push(`  ${mm[1]}: 'docs/${mm[1]}.pdf',`);
  console.log(`${mm[1]}.pdf  ${(buf.length / 1024).toFixed(0)} KB`);
}
src = src.replace(m[0], '// Standard e-sign documents live in docs/ (served next to this page) instead of being embedded as base64.\nconst ESIGN_DOC_FILES = {\n' + entries.join('\n') + '\n};');
fs.writeFileSync(FILE, CRLF ? src.replace(/\n/g, '\r\n') : src, 'utf8');
console.log('Patched. New size: ' + (fs.statSync(FILE).size / 1024).toFixed(0) + ' KB');
