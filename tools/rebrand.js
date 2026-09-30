// Brand codemod: old navy/green palette -> MaxSaveHub black/turquoise palette.
// Usage: node tools/rebrand.js [--check] [files...]
// Preserves CRLF (files are handled as latin1 strings, never split on newlines).
const fs = require('fs');
const args = process.argv.slice(2);
const check = args.includes('--check');
const files = args.filter(a => !a.startsWith('--'));
const targets = files.length ? files : ['maxsave_crm.html', 'msihub-data.js', 'msihub-data-2.js'];

const HEX = {
  // neutrals (old navy family -> black/charcoal scale)
  '#070F1C': '#000000', '#0A1624': '#000000', '#08101A': '#000000', '#0E2340': '#000000',
  '#0C1D33': '#111111', '#1C2B4B': '#111111',
  '#122B47': '#141414', '#0E1F35': '#141414',
  '#112840': '#1F1F1F', '#163D6B': '#1F1F1F', '#182030': '#1F1F1F',
  '#163350': '#2E2E2E', '#1B3F62': '#444444', '#253659': '#262626',
  '#2E4168': '#3D3D3D', '#354868': '#3D3D3D', '#1E3A5F': '#333333', '#2A3A5C': '#333333',
  '#3A6A95': '#696969', '#9DB5CC': '#B5B5B5', '#94A3B8': '#9A9A9A', '#C3D6E8': '#CCCCCC',
  '#CCDAE8': '#D9D9D9', '#E5EEF5': '#F0F0F0', '#F2F5FB': '#F4F4F4',
  // accents (old blue/green -> turquoise scale; text-safe dark turquoise where it was used as text)
  '#1A6ED0': '#067C83', '#EFF6FF': '#E6F9FA',
  '#3BAA47': '#09C4CD', '#52BE5E': '#2ECFD7', '#33953D': '#067C83', '#15803D': '#067C83',
  '#2B8035': '#05646A', '#236B2C': '#05646A', '#1A5C22': '#044C50',
  '#7DD085': '#5FD9DF', '#B2E4B8': '#9BE6EA', '#D8F3DB': '#C6F1F3', '#EDF8EE': '#E6F9FA',
  '#1A2E1C': '#0B2A2C',
};
const RGBA = {
  '10,22,36': '0,0,0', '26,43,75': '0,0,0',
  '26,110,208': '6,124,131',
  '59,170,71': '9,196,205', '22,61,107': '9,196,205', '80,148,224': '9,196,205',
};
const NAMES = [
  ['MSIHub — Maxsave Insurance Solutions', 'MaxSaveHub — MaxSave Insurance'],
  ['MaxSave CRM', 'MaxSaveHub'],
  ['Welcome to MSIHub', 'Welcome to MaxSaveHub'],
  ['MSIHub login', 'MaxSaveHub login'],
];
const rgbaRe = (t) => new RegExp('rgba\\(\\s*' + t.split(',').join('\\s*,\\s*') + '\\s*,', 'g');

let leftovers = 0;
for (const f of targets) {
  let s = fs.readFileSync(f).toString('latin1');
  const report = [];
  if (check) {
    for (const old of Object.keys(HEX)) { const n = (s.match(new RegExp(old + '(?![0-9A-Fa-f])', 'gi')) || []).length; if (n) report.push(`${old} x${n}`); }
    for (const t of Object.keys(RGBA)) { const n = (s.match(rgbaRe(t)) || []).length; if (n) report.push(`rgba(${t}) x${n}`); }
    for (const [old] of NAMES) { const n = s.split(old).length - 1; if (n) report.push(`"${old}" x${n}`); }
    leftovers += report.length;
    console.log(f + ': ' + (report.length ? 'LEFTOVERS -> ' + report.join(', ') : 'clean'));
    continue;
  }
  for (const [old, nu] of Object.entries(HEX)) {
    const re = new RegExp(old + '(?![0-9A-Fa-f])', 'gi');
    const n = (s.match(re) || []).length; if (n) { s = s.replace(re, nu); report.push(`${old} -> ${nu}: ${n}`); }
  }
  for (const [t, nu] of Object.entries(RGBA)) {
    const re = rgbaRe(t); const n = (s.match(re) || []).length; if (n) { s = s.replace(re, 'rgba(' + nu + ','); report.push(`rgba(${t}) -> rgba(${nu}): ${n}`); }
  }
  for (const [old, nu] of NAMES) { const n = s.split(old).length - 1; if (n) { s = s.split(old).join(nu); report.push(`"${old}" -> "${nu}": ${n}`); } }
  fs.writeFileSync(f, Buffer.from(s, 'latin1'));
  console.log('== ' + f + '\n' + report.join('\n'));
}
if (check) process.exit(leftovers ? 1 : 0);
