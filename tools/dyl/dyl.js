// DYL browser driver: keeps one Edge instance alive across commands (persistent profile).
// Usage: node dyl.js <command> [args]
//   inspect            -> load login page, list inputs/buttons, screenshot
//   login <user> <pw>  -> sign in, screenshot, list nav links
//   goto <url>         -> navigate, screenshot, dump links/buttons
//   eval "<js>"        -> run JS in page, print result
//   shot               -> screenshot current page
const puppeteer = require('puppeteer-core');
const path = require('path'); const fs = require('fs');
const { spawn } = require('child_process'); const http = require('http');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9371; const PROFILE = path.join(__dirname, 'prof-dyl');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function version() { return new Promise((res) => { http.get({ host: '127.0.0.1', port: PORT, path: '/json/version' }, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => res(d)); }).on('error', () => res(null)); }); }
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
async function page(b) { const pages = await b.pages(); const p = pages.find((x) => !x.url().startsWith('devtools')) || await b.newPage(); await p.setViewport({ width: 1500, height: 1000 }); return p; }
async function dump(p, label) {
  const info = await p.evaluate(() => ({
    url: location.href, title: document.title,
    inputs: [...document.querySelectorAll('input,select,textarea')].map((i) => ({ tag: i.tagName, type: i.type, name: i.name, id: i.id, placeholder: i.placeholder })).slice(0, 40),
    buttons: [...document.querySelectorAll('button,[role=button],input[type=submit]')].map((b) => (b.innerText || b.value || '').trim()).filter(Boolean).slice(0, 60),
    links: [...document.querySelectorAll('a[href]')].map((a) => (a.innerText || '').trim().replace(/\s+/g, ' ') + ' -> ' + a.getAttribute('href')).filter((t) => t.length > 4).slice(0, 120),
    text: document.body.innerText.slice(0, 1500),
  }));
  const shot = path.join(__dirname, 'dyl-' + label + '.png');
  await p.screenshot({ path: shot, fullPage: false });
  console.log(JSON.stringify(info, null, 1)); console.log('screenshot:', shot);
}
(async () => {
  const [cmd, a1, a2] = process.argv.slice(2);
  const b = await browser(); const p = await page(b);
  if (cmd === 'inspect') { await p.goto('https://my.dyl.com/login', { waitUntil: 'networkidle2', timeout: 60000 }); await wait(1500); await dump(p, 'login'); }
  else if (cmd === 'login') {
    await p.goto('https://my.dyl.com/login', { waitUntil: 'networkidle2', timeout: 60000 }); await wait(1500);
    const sel = await p.evaluate(() => { const u = document.querySelector('input[type=email],input[name*=user],input[name*=email],input[id*=user],input[id*=email],input[type=text]'); const pw = document.querySelector('input[type=password]'); return { u: u && (u.id ? '#' + u.id : 'input[name="' + u.name + '"]'), pw: pw && (pw.id ? '#' + pw.id : 'input[type=password]') }; });
    console.log('selectors:', sel);
    await p.type(sel.u, a1); await p.type(sel.pw, a2);
    await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {}), p.keyboard.press('Enter')]);
    await wait(3000); await dump(p, 'after-login');
  }
  else if (cmd === 'goto') { await p.goto(a1, { waitUntil: 'networkidle2', timeout: 60000 }); await wait(2000); await dump(p, 'goto'); }
  else if (cmd === 'eval') { const r = await p.evaluate(a1); console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 1)); }
  else if (cmd === 'shot') { await dump(p, 'shot'); }
  else if (cmd === 'close') { await b.close(); console.log('closed'); }
  else console.log('unknown command');
  b.disconnect();
})().catch((e) => { console.error('DYL FAILED', e.message); process.exit(1); });
