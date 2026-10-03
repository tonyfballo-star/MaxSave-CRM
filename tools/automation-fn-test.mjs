// Run:  node tools/automation-fn-test.mjs      (Node 24+)
// Exercises supabase/functions/automation/index.ts — the real file — against an in-memory database (with the
// RPCs the schema provides stubbed in JS) and stand-ins for Telnyx and Brevo. Nothing leaves this machine.
import { registerHooks } from 'node:module';

registerHooks({ resolve(spec, ctx, next) {
  if (spec === 'npm:@supabase/supabase-js@2') return { url: 'data:text/javascript,export const createClient = () => globalThis.__db;', shortCircuit: true };
  return next(spec, ctx);
} });

// ---- in-memory database ----
const PK = { agency_settings: 'key', email_opt_outs: 'email', sms_opt_outs: 'phone' };
const tables = {}; let seq = 0; const rpcCalls = [];
function q(table) {
  const st = { filters: [], op: 'select' }; const rows = () => (tables[table] = tables[table] || []);
  const api = {
    select() { return api; },
    eq(k, v) { st.filters.push((r) => r[k] === v); return api; },
    in(k, vs) { st.filters.push((r) => vs.includes(r[k])); return api; },
    order() { return api; }, limit(n) { st.limit = n; return api; },
    maybeSingle() { st.single = true; return api; }, single() { st.single = true; return api; },
    insert(row) { st.op = 'insert'; st.row = row; return api; },
    update(patch) { st.op = 'update'; st.patch = patch; return api; },
    upsert(row) { st.op = 'upsert'; st.row = row; return api; },
    delete() { st.op = 'delete'; return api; },
    then(res) {
      const match = (r) => st.filters.every((f) => f(r)); let data = null, error = null;
      if (st.op === 'insert') { const r = { id: table + '-' + (++seq), created_at: new Date().toISOString(), ...st.row }; rows().push(r); data = st.single ? r : [r]; }
      else if (st.op === 'update') { const hit = rows().filter(match); hit.forEach((r) => Object.assign(r, st.patch)); data = st.single ? hit[0] || null : hit; }
      else if (st.op === 'upsert') { const pk = PK[table] || 'id'; const i = rows().findIndex((r) => r[pk] === st.row[pk]); if (i >= 0) Object.assign(rows()[i], st.row); else rows().push({ ...st.row }); }
      else if (st.op === 'delete') { tables[table] = rows().filter((r) => !match(r)); }
      else { let out = rows().filter(match); if (st.limit) out = out.slice(0, st.limit); data = st.single ? out[0] || null : out; }
      res({ data, error });
    },
  };
  return api;
}
// The schema's RPCs, in miniature: a queue of due items and the advance/daily/status calls.
let dueQueue = []; const advanced = []; let dailyResult = { renewals: 0 }; let enabledForRpc = () => (tables.agency_settings.find((r) => r.key === 'automation') || {}).value?.enabled;
const rpc = async (name, args) => {
  rpcCalls.push([name, args]);
  if (name === 'automation_due') { if (!enabledForRpc()) return { data: [], error: null }; const n = args.p_limit || 40; const out = dueQueue.slice(0, n); dueQueue = dueQueue.slice(n); return { data: out, error: null }; }
  if (name === 'automation_advance') { advanced.push(args); return { data: null, error: null }; }
  if (name === 'automation_daily') return { data: dailyResult, error: null };
  if (name === 'automation_status') return { data: { enabled: true, active: 3, due: 1, sent_today: 2, failed_today: 0, state: {} }, error: null };
  return { data: null, error: { message: 'no such rpc ' + name } };
};
const USERS = { 'jwt-admin': 'u1', 'jwt-agent': 'u2', 'jwt-off': 'u3' };
globalThis.__db = { from: q, rpc, auth: { getUser: async (jwt) => (USERS[jwt] ? { data: { user: { id: USERS[jwt] } }, error: null } : { data: { user: null }, error: { message: 'bad jwt' } }) } };

// ---- Telnyx + Brevo stand-ins ----
const sentTexts = [], sentEmails = []; let brevoFail = false;
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  url = String(url); const body = init.body ? JSON.parse(init.body) : undefined;
  if (url === 'https://api.telnyx.com/v2/messages') {
    if ((init.headers || {}).Authorization !== 'Bearer KEY_TEST') return reply(401, { errors: [{ title: 'Unauthorized' }] });
    sentTexts.push(body); if (body.to === '+16195550999') return reply(400, { errors: [{ detail: 'Invalid destination number' }] });
    return reply(200, { data: { id: 'msg-' + (++seq) } });
  }
  if (url === 'https://api.brevo.com/v3/smtp/email') {
    if ((init.headers || {})['api-key'] !== 'BREVO_TEST') return reply(401, { message: 'Key not found' });
    if (brevoFail) return reply(400, { message: 'Invalid sender' });
    sentEmails.push(body); return reply(201, { messageId: '<brevo-' + (++seq) + '@smtp-relay>' });
  }
  throw new Error('unexpected fetch ' + url);
};

const ENV = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service', AUTOMATION_SECRET: 'autosec-0123456789abcdef0123456789', BREVO_API_KEY: 'BREVO_TEST', TELNYX_API_KEY: 'KEY_TEST', TELNYX_WEBHOOK_SECRET: 'whsec-0123456789abcdef0123456789' };
let handler; globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (fn) => { handler = fn; } };
await import('../supabase/functions/automation/index.ts');

const URL_ = 'https://proj.supabase.co/functions/v1/automation';
async function act(jwt, body) { const r = await handler(new Request(URL_, { method: 'POST', headers: jwt ? { authorization: 'Bearer ' + jwt } : {}, body: JSON.stringify(body) })); return { status: r.status, body: await r.json() }; }
async function cron(k, extra = '') { const r = await handler(new Request(URL_ + '?k=' + encodeURIComponent(k) + extra, { method: 'POST', body: '{}' })); return { status: r.status, body: await r.json() }; }
async function get(qs) { const r = await handler(new Request(URL_ + qs, { method: 'GET' })); return { status: r.status, text: await r.text(), type: r.headers.get('content-type') }; }

let passed = 0; const failures = [];
async function test(name, fn) { try { await fn(); passed++; console.log('  ✓ ' + name); } catch (e) { failures.push(name); console.log('  ✗ ' + name + '\n      ' + e.message); } }
function eq(a, b, what) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((what || 'value') + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
function ok(v, what) { if (!v) throw new Error(what || 'expected truthy'); }

function reset(opts = {}) {
  for (const k of Object.keys(tables)) delete tables[k];
  sentTexts.length = 0; sentEmails.length = 0; advanced.length = 0; rpcCalls.length = 0; dueQueue = []; brevoFail = false;
  tables.profiles = [
    { id: 'u1', full_name: 'Tony Admin', email: 'tony@example.com', role: 'admin', active: true, perms: {}, telnyx_number: null },
    { id: 'u2', full_name: 'Agent Two', email: 'two@example.com', role: 'agent', active: true, perms: {}, telnyx_number: '+16195550002' },
    { id: 'u3', full_name: 'Gone', role: 'agent', active: false, perms: {} },
  ];
  tables.agency_settings = [
    { key: 'automation', value: { enabled: true, email_enabled: true, email_from: 'hello@maxsaveins.com', email_from_name: 'MaxSave Insurance', email_reply_to: 'tonyb@maxsaveins.com', email_signature: 'MaxSave Insurance\n(619) 555-0000', ...(opts.automation || {}) } },
    { key: 'telnyx', value: { sms_enabled: true, sms_number: '+16195550000', ...(opts.telnyx || {}) } },
  ];
  tables.leads = [{ id: 'L1', agent_id: 'u2', do_not_call: false }, { id: 'L9', agent_id: 'u1', do_not_call: false }];
  tables.emails = []; tables.email_opt_outs = []; tables.messages = []; tables.tasks = [];
}
const item = (o) => ({ enrollment_id: 1, rule_id: 1, rule_name: 'New Lead Follow-Up', trigger: 'Lead is created', step_no: 0, step_index: 0, steps_total: 3, action: 'Send Text', time: '9:00 AM', subject: '', message: 'Hi James, this is Agent Two.', lead_id: 'L1', customer_id: null, policy_id: null, agent_id: 'u2', agent_name: 'Agent Two', first_name: 'James', name: 'James Carter', phone: '(619) 555-0111', email: 'jc@example.com', do_not_call: false, sms_opted_out: false, email_opted_out: false, today: '2026-10-05', first_text: true, ...o });

console.log('Who may call it');
reset();
await test('no login → 401', async () => eq((await act(null, { action: 'email', to: 'a@b.co', subject: 's', body: 'b' })).status, 401));
await test('deactivated → 403', async () => eq((await act('jwt-off', { action: 'status' })).status, 403));
await test('wrong cron secret → 401', async () => eq((await cron('nope')).status, 401));
await test('status is admin-only and reports wiring', async () => { eq((await act('jwt-agent', { action: 'status' })).status, 403); const r = await act('jwt-admin', { action: 'status' }); eq(r.status, 200); ok(r.body.email.api_key && r.body.cron_secret && r.body.status.active === 3, JSON.stringify(r.body)); });

console.log('Manual email from a lead card');
await test('agent emails their own lead through Brevo and the email is saved', async () => {
  const r = await act('jwt-agent', { action: 'email', to: 'JC@Example.com', to_name: 'James Carter', subject: 'Your quote', body: 'Hi James,\n\nHere is the quote.', lead_id: 'L1' });
  eq(r.status, 200, JSON.stringify(r.body)); ok(r.body.ok && r.body.row && r.body.row.status === 'sent', JSON.stringify(r.body));
  const m = sentEmails[0]; eq(m.to[0].email, 'jc@example.com'); eq(m.sender.email, 'hello@maxsaveins.com'); eq(m.replyTo.email, 'tonyb@maxsaveins.com');
  ok(/Here is the quote/.test(m.textContent) && /\(619\) 555-0000/.test(m.textContent) && /\?u=/.test(m.textContent), 'text body has message, signature, unsubscribe link');
  ok(/<p/.test(m.htmlContent) && /Unsubscribe<\/a>/.test(m.htmlContent) && !/<script/.test(m.htmlContent), 'html body');
  ok(m.headers['List-Unsubscribe'].startsWith('<' + URL_ + '?u='), 'List-Unsubscribe header');
  const row = tables.emails[0]; eq(row.lead_id, 'L1'); eq(row.agent_id, 'u2'); eq(row.source, 'manual'); ok(row.provider_id.startsWith('<brevo-'));
});
await test('agent cannot email another agent\'s lead', async () => eq((await act('jwt-agent', { action: 'email', to: 'x@y.co', subject: 's', body: 'b', lead_id: 'L9' })).status, 403));
await test('admin can', async () => eq((await act('jwt-admin', { action: 'email', to: 'x@y.co', subject: 's', body: 'b', lead_id: 'L9' })).status, 200));
await test('bad address / empty body → 400', async () => { eq((await act('jwt-admin', { action: 'email', to: 'nope', subject: 's', body: 'b' })).status, 400); eq((await act('jwt-admin', { action: 'email', to: 'a@b.co', subject: 's', body: '  ' })).status, 400); });
await test('unsubscribed address → 409, nothing sent', async () => { tables.email_opt_outs.push({ email: 'gone@example.com' }); const n = sentEmails.length; const r = await act('jwt-admin', { action: 'email', to: 'Gone@Example.com', subject: 's', body: 'b' }); eq(r.status, 409); ok(/unsubscribed/.test(r.body.error)); eq(sentEmails.length, n); });
await test('email switched off → 409', async () => { tables.agency_settings[0].value.email_enabled = false; eq((await act('jwt-admin', { action: 'email', to: 'a@b.co', subject: 's', body: 'b' })).status, 409); tables.agency_settings[0].value.email_enabled = true; });
await test('Brevo refusal → 502 and nothing saved', async () => { brevoFail = true; const n = tables.emails.length; const r = await act('jwt-admin', { action: 'email', to: 'a@b.co', subject: 's', body: 'b' }); eq(r.status, 502); ok(/Brevo: Invalid sender/.test(r.body.error)); eq(tables.emails.length, n); brevoFail = false; });
await test('test_email goes to the admin\'s own address', async () => { const r = await act('jwt-admin', { action: 'test_email' }); eq(r.status, 200); eq(sentEmails[sentEmails.length - 1].to[0].email, 'tony@example.com'); });

console.log('Unsubscribe link');
await test('the link from a sent email records the opt-out and shows a page', async () => {
  const m = sentEmails[0]; const link = m.textContent.match(/(https:\S+\?u=\S+)/)[1]; const qs = link.slice(link.indexOf('?'));
  const r = await get(qs); eq(r.status, 200); ok(/text\/html/.test(r.type) && /unsubscribed/i.test(r.text) && /jc@example\.com/.test(r.text), r.text.slice(0, 200));
  ok(tables.email_opt_outs.find((x) => x.email === 'jc@example.com'), 'opt-out row');
});
await test('a tampered link is rejected', async () => { const r = await get('?u=' + btoa('victim@example.com').replace(/=+$/, '') + '.0000000000000000000000000000dead'); ok(/not valid/i.test(r.text)); ok(!tables.email_opt_outs.find((x) => x.email === 'victim@example.com')); });
await test('GET without a token is a harmless ping', async () => { const r = await get(''); eq(r.status, 200); ok(/"service":"automation"/.test(r.text)); });

console.log('The cron tick');
reset();
await test('automation off → tick does nothing', async () => { tables.agency_settings[0].value.enabled = false; dueQueue = [item({})]; const r = await cron(ENV.AUTOMATION_SECRET); eq(r.status, 200); eq(r.body.enabled, false); eq(sentTexts.length, 0); eq(rpcCalls.filter((c) => c[0] === 'automation_due').length, 0); });
reset();
await test('text step: sent from the agent\'s own number with the STOP footer on the first text, saved to the thread, advanced', async () => {
  dueQueue = [item({})]; const r = await cron(ENV.AUTOMATION_SECRET); eq(r.status, 200); eq(r.body.sent, 1, JSON.stringify(r.body));
  const t = sentTexts[0]; eq(t.from, '+16195550002'); eq(t.to, '+16195550111'); eq(t.text, 'Hi James, this is Agent Two. Reply STOP to opt out.'); ok(t.webhook_url.includes('/functions/v1/telnyx?k='));
  const m = tables.messages[0]; eq(m.lead_id, 'L1'); eq(m.agent_id, 'u2'); eq(m.direction, 'outbound'); eq(m.status, 'queued'); eq(m.phone, '(619) 555-0111');
  eq(advanced[0].p_status, 'sent'); eq(advanced[0].p_action, 'Send Text'); ok(/Text sent to \(619\) 555-0111/.test(advanced[0].p_detail));
  ok(rpcCalls[0][0] === 'automation_daily', 'daily job runs first');
  const st = tables.agency_settings.find((x) => x.key === 'automation_state'); ok(st && st.value.last_tick.sent === 1, 'state saved');
});
await test('later texts have no footer; agency number when the agent has none', async () => { reset(); dueQueue = [item({ first_text: false, agent_id: 'u1', message: 'Checking in.' })]; await cron(ENV.AUTOMATION_SECRET); eq(sentTexts[0].text, 'Checking in.'); eq(sentTexts[0].from, '+16195550000'); });
await test('texting off → step skipped, not failed, no Telnyx call', async () => { reset({ telnyx: { sms_enabled: false } }); dueQueue = [item({})]; const r = await cron(ENV.AUTOMATION_SECRET); eq(r.body.skipped, 1); eq(sentTexts.length, 0); eq(advanced[0].p_status, 'skipped'); ok(/switched off/.test(advanced[0].p_detail)); });
await test('do-not-call / STOP / no phone → skipped', async () => {
  reset(); dueQueue = [item({ enrollment_id: 1, do_not_call: true }), item({ enrollment_id: 2, sms_opted_out: true }), item({ enrollment_id: 3, phone: '' })];
  const r = await cron(ENV.AUTOMATION_SECRET); eq(r.body.skipped, 3); eq(sentTexts.length, 0);
  ok(/Do Not Call/.test(advanced[0].p_detail) && /STOP/.test(advanced[1].p_detail) && /no valid phone/.test(advanced[2].p_detail), advanced.map((a) => a.p_detail).join(' | '));
});
await test('Telnyx error → failed and advanced (the sequence keeps going)', async () => { reset(); dueQueue = [item({ phone: '(619) 555-0999' })]; const r = await cron(ENV.AUTOMATION_SECRET); eq(r.body.failed, 1); eq(advanced[0].p_status, 'failed'); ok(/Invalid destination/.test(advanced[0].p_detail)); eq(tables.messages.length, 0); });
await test('email step: sent through Brevo with merge-applied subject, saved with the enrollment id', async () => {
  reset(); dueQueue = [item({ action: 'Send Email', subject: 'Your quote, James', message: 'Hello James' })]; const r = await cron(ENV.AUTOMATION_SECRET); eq(r.body.sent, 1, JSON.stringify(r.body));
  eq(sentEmails[0].subject, 'Your quote, James'); const e = tables.emails[0]; eq(e.source, 'automation'); eq(e.enrollment_id, 1); eq(e.lead_id, 'L1'); eq(e.agent_id, 'u2'); eq(advanced[0].p_status, 'sent');
});
await test('email step without Brevo key / with email off / unsubscribed / no address → skipped', async () => {
  reset({ automation: { email_enabled: false } }); dueQueue = [item({ action: 'Send Email', subject: 's', message: 'm' })]; let r = await cron(ENV.AUTOMATION_SECRET); eq(r.body.skipped, 1); ok(/switched off/.test(advanced[0].p_detail), advanced[0].p_detail);
  reset(); dueQueue = [item({ enrollment_id: 5, action: 'Send Email', subject: 's', message: 'm', email_opted_out: true }), item({ enrollment_id: 6, action: 'Send Email', subject: 's', message: 'm', email: null })]; r = await cron(ENV.AUTOMATION_SECRET); eq(r.body.skipped, 2); eq(sentEmails.length, 0);
});
await test('task step: creates a task for the lead\'s agent, due today, tagged as automation', async () => {
  reset(); dueQueue = [item({ action: 'Create Task', message: 'Call James Carter about the quote', time: '2:00 PM', step_no: 1 })]; const r = await cron(ENV.AUTOMATION_SECRET); eq(r.body.tasks, 1, JSON.stringify(r.body));
  const t = tables.tasks[0]; eq(t.label, 'Call James Carter about the quote'); eq(t.icon, '📞'); eq(t.assigned_to, 'u2'); eq(t.assigned_label, 'Agent Two'); eq(t.lead_id, 'L1'); eq(t.due_date, '2026-10-05'); eq(t.due_time, '2:00 PM'); eq(t.source, 'automation'); ok(/step 2 of 3/.test(t.notes));
  eq(advanced[0].p_status, 'task');
});
await test('a batch of due items is worked through in order; the tick stops when the queue empties', async () => {
  reset(); dueQueue = Array.from({ length: 45 }, (_, i) => item({ enrollment_id: i + 1, first_text: false, action: i % 3 === 0 ? 'Create Task' : 'Send Text', message: 'm' + i }));
  const r = await cron(ENV.AUTOMATION_SECRET); eq(r.body.processed, 45); eq(r.body.sent + r.body.tasks, 45); eq(rpcCalls.filter((c) => c[0] === 'automation_due').length, 2);
});
await test('admin "run" does the same as the tick; agents may not', async () => { reset(); dueQueue = [item({})]; eq((await act('jwt-agent', { action: 'run' })).status, 403); const r = await act('jwt-admin', { action: 'run' }); eq(r.status, 200); eq(r.body.sent, 1); });

console.log('\n' + passed + ' passed, ' + failures.length + ' failed' + (failures.length ? ': ' + failures.join('; ') : ''));
process.exit(failures.length ? 1 : 0);
