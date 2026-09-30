// One-shot: convert the flat-vector logo PDFs (Illustrator export) to SVG path data.
// Usage: node tools/pdf2svg.js "<in.pdf>" <out.svg>
// Fills: the PDFs use only two colours; cyan -> #09C4CD, dark -> currentColor.
const fs = require('fs'), zlib = require('zlib');
const [,, inPath, outPath] = process.argv;
const buf = fs.readFileSync(inPath), s = buf.toString('latin1');
const H = parseFloat(s.match(/MediaBox\s*\[\s*[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+([-\d.]+)/)[1]);
const mul = (m1, m2) => [
  m1[0]*m2[0] + m1[1]*m2[2], m1[0]*m2[1] + m1[1]*m2[3],
  m1[2]*m2[0] + m1[3]*m2[2], m1[2]*m2[1] + m1[3]*m2[3],
  m1[4]*m2[0] + m1[5]*m2[2] + m2[4], m1[4]*m2[1] + m1[5]*m2[3] + m2[5]];
const paths = []; const pts = [];
const r1 = (n) => Math.round(n * 10) / 10;
let re = /stream\r?\n/g, m;
while ((m = re.exec(s))) {
  const start = m.index + m[0].length, end = s.indexOf('endstream', start);
  let txt; try { txt = zlib.inflateSync(buf.slice(start, end)).toString('latin1'); } catch (e) { continue; }
  if (!/\bcm\b/.test(txt) || !/\bf\b/.test(txt)) continue;
  const toks = txt.replace(/\r?\n/g, ' ').split(/\s+/).filter(Boolean);
  let stack = [], ctm = [1,0,0,1,0,0], fill = 'currentColor', nums = [], d = '';
  const ap = (x, y) => { const p = [ctm[0]*x + ctm[2]*y + ctm[4], ctm[1]*x + ctm[3]*y + ctm[5]]; p[1] = H - p[1]; pts.push(p); return r1(p[0]) + ' ' + r1(p[1]); };
  for (const t of toks) {
    if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t)) { nums.push(parseFloat(t)); continue; }
    switch (t) {
      case 'q': stack.push(ctm.slice()); break;
      case 'Q': ctm = stack.pop() || ctm; break;
      case 'cm': ctm = mul(nums.slice(-6), ctm); break;
      case 'scn': case 'sc': case 'rg': if (nums.length >= 3) fill = nums[1] > 0.5 ? '#09C4CD' : 'currentColor'; break;
      case 'm': d += 'M' + ap(nums[0], nums[1]); break;
      case 'l': d += 'L' + ap(nums[0], nums[1]); break;
      case 'c': d += 'C' + ap(nums[0], nums[1]) + ' ' + ap(nums[2], nums[3]) + ' ' + ap(nums[4], nums[5]); break;
      case 'h': d += 'Z'; break;
      case 'f': case 'f*': if (d) paths.push({ fill, d }); d = ''; break;
      case 'n': case 'W': d = ''; break;   // clip path, discard
    }
    nums = [];
  }
}
const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
const w = maxX - minX, h = maxY - minY, pad = Math.max(w, h) * 0.02;
// Normalise so the viewBox starts at 0,0 and coordinates stay small.
const norm = (d) => d.replace(/([ML])(-?[\d.]+) (-?[\d.]+)/g, (_, op, x, y) => op + r1(x - minX + pad) + ' ' + r1(y - minY + pad))
  .replace(/C((?:-?[\d.]+ -?[\d.]+ ?){3})/g, (_, xy) => 'C' + xy.trim().split(' ').map((v, i) => r1(v - (i % 2 ? minY : minX) + pad)).join(' '));
const vb = `0 0 ${r1(w + 2*pad)} ${r1(h + 2*pad)}`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">` + paths.map(p => `<path fill="${p.fill}" d="${norm(p.d)}"/>`).join('') + '</svg>';
fs.writeFileSync(outPath, svg);
console.log(outPath, 'paths:', paths.length, 'viewBox:', vb, 'bytes:', svg.length);
