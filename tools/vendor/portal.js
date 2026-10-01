// Generic headless-browser driver for lead-vendor portals. One persistent Edge profile per vendor name,
// so a session survives between commands. Credentials are passed on the command line, never stored.
// Usage: node portal.js <vendor> <command> [args]
//   goto <url>              navigate, then dump
//   dump                    print url, title, inputs, buttons, links, visible text
//   fill <selector> <text>  type into a field
//   click <selector>        click (CSS selector, or text=Visible Label)
//   press <key>             keyboard key (Enter, Tab, ...)
//   eval "<js>"             run JS in the page and print the result
//   shot [name]             screenshot to SHOT_DIR
//   net <seconds>           log XHR/fetch requests seen during the next N seconds (method, url, status)
//   close                   close the browser
const puppeteer = require('puppeteer-core');
const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawn } = require('child_process'); const http = require('http');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORTS = { everquote: 9381, mediaalpha: 9382, usmg: 9383 };
const [vendor, cmd, a1, a2] = process.argv.slice(2);
if (!PORTS[vendor]) { console.error('vendor must be one of: ' + Object.keys(PORTS).join(', ')); process.exit(2); }
const PORT = PORTS[vendor]; const PROFILE = path.join(__dirname, 'prof-' + vendor);
const SHOT_DIR = process.env.SHOT_DIR || os.tmpdir();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const version = () => new Promise((res) => { http.get({ host: '127.0.0.1', port: PORT, path: '/json/version' }, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => res(d)); }).on('error', () => res(null)); });
async function browser() {
  let v = await version();
  if (!v) {
    const proc = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-sandbox', '--window-size=1500,1000', '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE, 'about:blank'], { stdio: 'ignore', detached: true });
    proc.unref();
    for (let i = 0; i < 80 && !v; i++) { await wait(500); v = await version(); }
    if (!v) throw new Error('Edge did not start');
  }
  return puppeteer.connect({ browserWSEndpoint: JSON.parse(v).webSocketDebuggerUrl });
}
async function page(b) {
  const pages = await b.pages(); const p = pages.find((x) => !x.url().startsWith('devtools')) || await b.newPage();
  // A JS dialog (alert / 'Leave site?') freezes every later command, so dismiss any that is open and auto-accept new ones.
  try { const cdp = await p.createCDPSession(); await Promise.race([cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}), wait(1500)]); } catch (_) {}
  p.on('dialog', (d) => { console.log('[dialog] ' + d.type() + ': ' + d.message().slice(0, 120)); d.accept().catch(() => {}); });
  await Promise.race([p.setViewport({ width: 1500, height: 1000 }), wait(5000)]);
  return p;
}
async function dump(p) {
  const info = await p.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return {
      url: location.href, title: document.title,
      inputs: [...document.querySelectorAll('input,select,textarea')].filter(vis).map((i) => ({ tag: i.tagName, type: i.type, name: i.name, id: i.id, placeholder: i.placeholder })).slice(0, 40),
      buttons: [...new Set([...document.querySelectorAll('button,[role=button],input[type=submit],[role=tab],[role=menuitem]')].filter(vis).map((b) => (b.innerText || b.value || b.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ')).filter(Boolean))].slice(0, 80),
      links: [...new Set([...document.querySelectorAll('a[href]')].filter(vis).map((a) => (a.innerText || a.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ') + ' -> ' + a.getAttribute('href')).filter((t) => t.length > 4))].slice(0, 120),
      text: document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 2500),
    };
  });
  console.log(JSON.stringify(info, null, 1));
}
(async () => {
  const b = await browser(); const p = await page(b);
  if (cmd === 'goto') { await p.goto(a1, { waitUntil: 'networkidle2', timeout: 90000 }).catch((e) => console.log('goto:', e.message)); await wait(2500); await dump(p); }
  else if (cmd === 'dump') { await dump(p); }
  else if (cmd === 'fill') { await p.waitForSelector(a1, { timeout: 20000 }); await p.click(a1, { clickCount: 3 }); await p.type(a1, a2, { delay: 25 }); console.log('filled', a1); }
  else if (cmd === 'click') {
    if (a1.startsWith('text=')) { const t = a1.slice(5); const ok = await p.evaluate((t) => { const els = [...document.querySelectorAll('button,a,[role=button],[role=tab],[role=menuitem],input[type=submit],span,div,li')].filter((e) => (e.innerText || e.value || '').trim() === t); const el = els[els.length - 1]; if (!el) return false; el.click(); return true; }, t); console.log(ok ? 'clicked ' + a1 : 'NOT FOUND ' + a1); }
    else { await p.waitForSelector(a1, { timeout: 20000 }); await p.click(a1); console.log('clicked', a1); }
    await wait(2500);
  }
  else if (cmd === 'press') { await p.keyboard.press(a1); await wait(3000); console.log('pressed', a1, '→', p.url()); }
  else if (cmd === 'eval') { const r = await p.evaluate(a1); console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 1)); }
  else if (cmd === 'shot') { const f = path.join(SHOT_DIR, vendor + '-' + (a1 || 'shot') + '.png'); await p.screenshot({ path: f }); console.log('screenshot:', f); }
  else if (cmd === 'net') { const seen = []; p.on('response', (r) => { const q = r.request(); if (['xhr', 'fetch'].includes(q.resourceType())) seen.push(q.method() + ' ' + r.status() + ' ' + r.url().slice(0, 200)); }); await wait((+a1 || 5) * 1000); console.log(seen.join('\n') || '(no requests)'); }
  else if (cmd === 'close') { await b.close(); console.log('closed'); return; }
  else console.log('unknown command');
  b.disconnect();
})().catch((e) => { console.error('PORTAL FAILED', e.message); process.exit(1); });
// Never hang: give up after 2 minutes so the caller gets control back.
setTimeout(() => { console.error('PORTAL TIMEOUT after 120s (' + cmd + ')'); process.exit(3); }, 120000).unref();
