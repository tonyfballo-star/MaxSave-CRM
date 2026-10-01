// Run:  node tools/telnyx-fn-test.mjs      (Node 24+)
// Exercises supabase/functions/telnyx/index.ts — the real file — against an in-memory database
// and a stand-in for the Telnyx API. Nothing leaves this machine. Webhooks are signed with a
// throwaway Ed25519 key, so the signature check is tested for real.
import { registerHooks } from 'node:module';
import { webcrypto as crypto } from 'node:crypto';

registerHooks({ resolve(spec, ctx, next) {
  if (spec === 'npm:@supabase/supabase-js@2') return { url: 'data:text/javascript,export const createClient = () => globalThis.__db;', shortCircuit: true };
  return next(spec, ctx);
} });

// ---- in-memory database ----
const PK = { sms_opt_outs: 'phone', phone_presence: 'agent_id', agency_settings: 'key' };
const tables = {}; const storage = []; let seq = 0;
function q(table) {
  const st = { filters: [], op: 'select' }; const rows = () => (tables[table] = tables[table] || []);
  const api = {
    select() { return api; },
    eq(k, v) { st.filters.push((r) => r[k] === v); return api; },
    in(k, vs) { st.filters.push((r) => vs.includes(r[k])); return api; },
    is(k, v) { st.filters.push((r) => (r[k] ?? null) === v); return api; },
    not(k, _op, v) { st.filters.push((r) => (r[k] ?? null) !== v); return api; },
    gte(k, v) { st.filters.push((r) => r[k] >= v); return api; },
    order(k, o) { st.order = [k, o && o.ascending === false ? -1 : 1]; return api; },
    limit(n) { st.limit = n; return api; },
    maybeSingle() { st.single = true; return api; }, single() { st.single = true; return api; },
    insert(row) { st.op = 'insert'; st.row = row; return api; },
    update(patch) { st.op = 'update'; st.patch = patch; return api; },
    upsert(row) { st.op = 'upsert'; st.row = row; return api; },
    delete() { st.op = 'delete'; return api; },
    then(res) {
      const match = (r) => st.filters.every((f) => f(r)); let data, error = null;
      if (st.op === 'insert') {
        if (table === 'messages' && st.row.provider_sid && rows().find((r) => r.provider_sid === st.row.provider_sid)) { error = { code: '23505', message: 'duplicate key' }; data = null; }
        else { const r = { id: table + '-' + (++seq), created_at: new Date().toISOString(), ...st.row }; rows().push(r); data = st.single ? r : [r]; }
      } else if (st.op === 'update') { const hit = rows().filter(match); hit.forEach((r) => Object.assign(r, st.patch)); data = st.single ? hit[0] || null : hit; }
      else if (st.op === 'upsert') { const pk = PK[table] || 'id'; const i = rows().findIndex((r) => r[pk] === st.row[pk]); if (i >= 0) Object.assign(rows()[i], st.row); else rows().push({ ...st.row }); data = null; }
      else if (st.op === 'delete') { tables[table] = rows().filter((r) => !match(r)); data = null; }
      else { let out = rows().filter(match); if (st.order) out = out.slice().sort((a, b) => (a[st.order[0]] > b[st.order[0]] ? 1 : -1) * st.order[1]); if (st.limit) out = out.slice(0, st.limit); data = st.single ? out[0] || null : out; }
      res({ data, error });
    },
  };
  return api;
}
const USERS = { 'jwt-admin': 'u1', 'jwt-agent': 'u2', 'jwt-off': 'u3' };
globalThis.__db = {
  from: q,
  auth: { getUser: async (jwt) => (USERS[jwt] ? { data: { user: { id: USERS[jwt] } }, error: null } : { data: { user: null }, error: { message: 'bad jwt' } }) },
  storage: { from: () => ({ upload: async (path, buf, opts) => { storage.push({ path, bytes: buf.length, type: opts && opts.contentType }); return { error: null }; }, createSignedUrl: async (path) => ({ data: { signedUrl: 'https://storage.test/' + path }, error: null }) }) },
};

// ---- Telnyx stand-in ----
const sentToTelnyx = []; let credSeq = 0;
const reply = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  url = String(url); const method = init.method || 'GET'; const body = init.body ? JSON.parse(init.body) : undefined;
  if (url === 'https://media.test/pic.jpg') return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
  if (!url.startsWith('https://api.telnyx.com/v2')) throw new Error('unexpected fetch ' + url);
  if ((init.headers || {}).Authorization !== 'Bearer KEY_TEST') return reply(401, { errors: [{ title: 'Unauthorized' }] });
  const path = url.slice('https://api.telnyx.com/v2'.length); sentToTelnyx.push({ method, path, body });
  if (method === 'POST' && path === '/messages') return body.to === '+16195550999' ? reply(400, { errors: [{ code: '40310', title: 'Invalid', detail: 'Invalid destination number' }] }) : reply(200, { data: { id: 'msg-' + (++seq), to: [{ phone_number: body.to, status: 'queued' }] } });
  if (method === 'POST' && path === '/telephony_credentials') { const n = ++credSeq; return reply(201, { data: { id: 'cred-' + n, sip_username: 'gencred' + n } }); }
  const tok = path.match(/^\/telephony_credentials\/(.+)\/token$/);
  if (method === 'POST' && tok) return tok[1] === 'cred-stale' ? reply(404, { errors: [{ title: 'Not found' }] }) : reply(201, 'jwt.for.' + tok[1]);
  if (method === 'GET' && path.startsWith('/phone_numbers')) return reply(200, { data: [{ phone_number: '+16195550000', status: 'active', messaging_profile_id: 'mp1', connection_id: 'app1', connection_name: 'Inbound app' }] });
  if (method === 'POST' && /^\/calls\/.+\/actions\/(transfer|answer|speak|hangup)$/.test(path)) return reply(200, { data: { result: 'ok' } });
  return reply(404, { errors: [{ title: 'No such route in the stand-in: ' + method + ' ' + path }] });
};

// ---- environment + load the function ----
const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const pub = Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('base64');
const ENV = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service', TELNYX_API_KEY: 'KEY_TEST', TELNYX_PUBLIC_KEY: pub, TELNYX_CONNECTION_ID: 'sipconn1', TELNYX_WEBHOOK_SECRET: 'whsec-0123456789abcdef0123456789' };
let handler; globalThis.Deno = { env: { get: (k) => ENV[k] }, serve: (fn) => { handler = fn; } };
await import('../supabase/functions/telnyx/index.ts');

const URL_ = 'https://proj.supabase.co/functions/v1/telnyx';
async function act(jwt, body) { const r = await handler(new Request(URL_, { method: 'POST', headers: jwt ? { authorization: 'Bearer ' + jwt } : {}, body: JSON.stringify(body) })); return { status: r.status, body: await r.json() }; }
async function hook(type, payload, opts = {}) {
  const raw = JSON.stringify({ data: { event_type: type, occurred_at: opts.at || new Date().toISOString(), payload } });
  const ts = String(Math.floor(Date.now() / 1000) - (opts.ageSecs || 0));
  const sig = opts.badSig ? Buffer.from(new Uint8Array(64)).toString('base64') : Buffer.from(await crypto.subtle.sign({ name: 'Ed25519' }, keys.privateKey, new TextEncoder().encode(ts + '|' + raw))).toString('base64');
  const r = await handler(new Request(URL_ + (opts.k ? '?k=' + opts.k : ''), { method: 'POST', headers: opts.noSig ? {} : { 'telnyx-signature-ed25519': sig, 'telnyx-timestamp': ts }, body: raw }));
  return { status: r.status, body: await r.json() };
}
const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const dec = (s) => JSON.parse(Buffer.from(s, 'base64').toString());
const last = (re) => [...sentToTelnyx].reverse().find((x) => re.test(x.path));

let passed = 0; const failures = [];
async function test(name, fn) { try { await fn(); passed++; console.log('  ✓ ' + name); } catch (e) { failures.push(name); console.log('  ✗ ' + name + '\n      ' + e.message); } }
function eq(a, b, what) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((what || 'value') + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); }
function ok(v, what) { if (!v) throw new Error(what || 'expected truthy'); }

function reset() {
  for (const k of Object.keys(tables)) delete tables[k];
  storage.length = 0; sentToTelnyx.length = 0;
  tables.profiles = [
    { id: 'u1', full_name: 'Tony Admin', role: 'admin', active: true, perms: {}, telnyx_number: null, telnyx_credential_id: null, telnyx_sip_username: null },
    { id: 'u2', full_name: 'Agent Two', role: 'agent', active: true, perms: {}, telnyx_number: null, telnyx_credential_id: 'cred-a2', telnyx_sip_username: 'gencredA2' },
    { id: 'u3', full_name: 'Gone', role: 'agent', active: false, perms: {} },
    { id: 'u4', full_name: 'Agent Four', role: 'agent', active: true, perms: {}, telnyx_number: null, telnyx_credential_id: 'cred-a4', telnyx_sip_username: 'gencredA4' },
  ];
  tables.agency_settings = [{ key: 'telnyx', value: { sms_enabled: true, voice_enabled: true, sms_number: '+16195550000', caller_id: '+16195550000' } }];
  tables.leads = [{ id: 'L1', first_name: 'Maria', last_name: 'Lopez', phone: '(619) 555-0100', agent_id: 'u2', received_at: '2026-09-01T00:00:00Z' }];
  tables.customers = [{ id: 'C1', first_name: 'Sam', last_name: 'Customer', phone: '6195550101', agent_id: 'u4', created_at: '2026-08-01T00:00:00Z' }];
  tables.messages = []; tables.call_log = []; tables.sms_opt_outs = []; tables.files = [];
  tables.phone_presence = [{ agent_id: 'u2', status: 'available', seen_at: new Date().toISOString() }, { agent_id: 'u4', status: 'available', seen_at: new Date().toISOString() }];
}
const settings = () => tables.agency_settings[0].value;

console.log('Who may call it');
reset();
await test('no login → 401', async () => eq((await act(null, { action: 'sms', to: '6195550100', text: 'hi' })).status, 401));
await test('bad login → 401', async () => eq((await act('nope', { action: 'sms', to: '6195550100', text: 'hi' })).status, 401));
await test('deactivated agent → 403', async () => eq((await act('jwt-off', { action: 'sms', to: '6195550100', text: 'hi' })).status, 403));
await test('status is admin-only', async () => { eq((await act('jwt-agent', { action: 'status' })).status, 403); const r = await act('jwt-admin', { action: 'status' }); eq(r.status, 200); eq(r.body.numbers[0].number, '+16195550000'); ok(r.body.api_key && r.body.public_key && r.body.connection_id && r.body.schema, 'flags'); eq(r.body.webhook_url, URL_); });

console.log('Sending texts');
await test('sends from the agency number and records the row', async () => {
  reset(); const r = await act('jwt-agent', { action: 'sms', to: '(619) 555-0100', text: 'Hello Maria', lead_id: 'L1', contact_name: 'Maria Lopez' });
  eq(r.status, 200); const m = last(/^\/messages$/).body;
  eq([m.from, m.to, m.text, m.webhook_url], ['+16195550000', '+16195550100', 'Hello Maria', URL_ + '?k=whsec-0123456789abcdef0123456789']);
  const row = tables.messages[0]; eq([row.agent_id, row.lead_id, row.phone, row.direction, row.status, row.body], ['u2', 'L1', '(619) 555-0100', 'outbound', 'queued', 'Hello Maria']);
  ok(row.provider_sid && r.body.row.id === row.id, 'row returned');
});
await test('an agent with a direct number texts from it', async () => { reset(); tables.profiles[1].telnyx_number = '+16195550222'; await act('jwt-agent', { action: 'sms', to: '6195550100', text: 'x' }); eq(last(/^\/messages$/).body.from, '+16195550222'); });
await test('refuses a number that replied STOP, without contacting Telnyx', async () => { reset(); tables.sms_opt_outs.push({ phone: '+16195550100' }); const r = await act('jwt-agent', { action: 'sms', to: '6195550100', text: 'x' }); eq(r.status, 409); ok(/opted out/.test(r.body.error)); eq(sentToTelnyx.length, 0); eq(tables.messages.length, 0); });
await test('refuses when texting is switched off', async () => { reset(); settings().sms_enabled = false; const r = await act('jwt-agent', { action: 'sms', to: '6195550100', text: 'x' }); eq(r.status, 409); eq(sentToTelnyx.length, 0); });
await test('refuses a bad number / empty message', async () => { reset(); eq((await act('jwt-agent', { action: 'sms', to: '555-0100', text: 'x' })).status, 400); eq((await act('jwt-agent', { action: 'sms', to: '6195550100', text: '  ' })).status, 400); eq(sentToTelnyx.length, 0); });
await test('a Telnyx rejection comes back as a readable error and nothing is recorded', async () => { reset(); const r = await act('jwt-agent', { action: 'sms', to: '6195550999', text: 'x' }); eq(r.status, 502); ok(/Invalid destination number/.test(r.body.error), r.body.error); eq(tables.messages.length, 0); });
await test('picture message: attachment becomes a signed link; paths outside mms/ are refused', async () => {
  reset(); const r = await act('jwt-agent', { action: 'sms', to: '6195550100', text: '', media: [{ path: 'mms/u2/1_pic.jpg', name: 'pic.jpg' }] });
  eq(r.status, 200); eq(last(/^\/messages$/).body.media_urls, ['https://storage.test/mms/u2/1_pic.jpg']); ok(/Picture/.test(tables.messages[0].body));
  eq((await act('jwt-agent', { action: 'sms', to: '6195550100', text: 'x', media: [{ path: 'leads/L1/secret.pdf' }] })).status, 400);
});

console.log('Browser phone login');
await test('first time: creates a phone login, saves it on the profile, flags it fresh', async () => {
  reset(); const r = await act('jwt-admin', { action: 'token' }); eq(r.status, 200);
  eq(last(/^\/telephony_credentials$/).body.connection_id, 'sipconn1'); ok(r.body.fresh, 'fresh'); ok(/^jwt\.for\.cred-/.test(r.body.token), r.body.token);
  eq(tables.profiles[0].telnyx_sip_username, r.body.sip_username); eq(r.body.caller_id, '+16195550000');
});
await test('afterwards: reuses the saved login', async () => { reset(); const r = await act('jwt-agent', { action: 'token' }); eq([r.body.token, r.body.fresh, r.body.sip_username], ['jwt.for.cred-a2', false, 'gencredA2']); ok(!last(/^\/telephony_credentials$/), 'no new credential'); });
await test('a login deleted in Telnyx is recreated', async () => { reset(); tables.profiles[1].telnyx_credential_id = 'cred-stale'; const r = await act('jwt-agent', { action: 'token' }); eq(r.status, 200); ok(r.body.fresh && tables.profiles[1].telnyx_credential_id !== 'cred-stale', 'recreated'); });
await test('refused when calling is switched off', async () => { reset(); settings().voice_enabled = false; eq((await act('jwt-agent', { action: 'token' })).status, 409); });

console.log('Webhook security');
await test('forged signature → 401, nothing saved', async () => { reset(); eq((await hook('message.received', { id: 'x1', from: { phone_number: '+16195550100' }, to: [{ phone_number: '+16195550000' }], text: 'hi' }, { badSig: true })).status, 401); eq(tables.messages.length, 0); });
await test('old (replayed) webhook → 401', async () => { reset(); eq((await hook('message.received', { id: 'x2', from: { phone_number: '+16195550100' }, to: [{ phone_number: '+16195550000' }], text: 'hi' }, { ageSecs: 900 })).status, 401); });

await test('the secret in the URL is accepted without a signature; a wrong or missing one is not', async () => {
  reset(); const p = { id: 'k1', from: { phone_number: '+16195550100' }, to: [{ phone_number: '+16195550000' }], text: 'via url secret' };
  eq((await hook('message.received', p, { k: 'whsec-0123456789abcdef0123456789', noSig: true })).status, 200); eq(tables.messages.length, 1);
  eq((await hook('message.received', { ...p, id: 'k2' }, { k: 'whsec-0123456789abcdef012345678X', noSig: true })).status, 401);
  eq((await hook('message.received', { ...p, id: 'k3' }, { k: 'whsec-0123456789abcdef012345678X', badSig: true })).status, 401);
  eq(tables.messages.length, 1);
});

console.log('Incoming texts');
const inbound = (id, from, text, extra = {}) => hook('message.received', { id, from: { phone_number: from }, to: [{ phone_number: '+16195550000' }], text, ...extra });
await test('a reply from a lead lands on the lead, assigned to its agent', async () => { reset(); eq((await inbound('in1', '+16195550100', 'Yes please call me')).status, 200); const m = tables.messages[0]; eq([m.direction, m.status, m.lead_id, m.agent_id, m.contact_name, m.phone, m.body], ['inbound', 'received', 'L1', 'u2', 'Maria Lopez', '(619) 555-0100', 'Yes please call me']); });
await test('goes to whoever texted them last', async () => { reset(); tables.messages.push({ id: 'old', agent_id: 'u1', lead_id: 'L1', contact_name: 'Maria Lopez', phone: '(619) 555-0100', direction: 'outbound', created_at: '2026-09-30T00:00:00Z' }); await inbound('in2', '+16195550100', 'ok'); eq(tables.messages[1].agent_id, 'u1'); });
await test('customer stored as bare digits is still matched', async () => { reset(); await inbound('in3', '+16195550101', 'hi'); eq([tables.messages[0].customer_id, tables.messages[0].agent_id, tables.messages[0].contact_name], ['C1', 'u4', 'Sam Customer']); });
await test('unknown number is kept, unassigned', async () => { reset(); await inbound('in4', '+16195550555', 'who dis'); eq([tables.messages[0].agent_id, tables.messages[0].lead_id, tables.messages[0].contact_name], [null, null, '(619) 555-0555']); });
await test('a retried webhook does not duplicate', async () => { reset(); await inbound('in5', '+16195550100', 'once'); await inbound('in5', '+16195550100', 'once'); eq(tables.messages.length, 1); });
await test('STOP opts the number out; START opts back in', async () => { reset(); await inbound('in6', '+16195550100', 'Stop.'); eq(tables.sms_opt_outs.map((r) => r.phone), ['+16195550100']); eq((await act('jwt-agent', { action: 'sms', to: '6195550100', text: 'x' })).status, 409); await inbound('in7', '+16195550100', 'START'); eq(tables.sms_opt_outs.length, 0); });
await test('a texted photo is copied into storage and attached to the lead’s Files', async () => {
  reset(); await inbound('in8', '+16195550100', '', { media: [{ url: 'https://media.test/pic.jpg', content_type: 'image/jpeg', size: 4 }] });
  eq(storage.length, 1); ok(/^leads\/L1\/.+\.jpg$/.test(storage[0].path), storage[0].path); eq([tables.files[0].lead_id, tables.files[0].size_bytes, tables.files[0].mime_type], ['L1', 4, 'image/jpeg']);
  ok(/Picture received — saved to Files/.test(tables.messages[0].body), tables.messages[0].body);
});

console.log('Delivery receipts');
await test('delivered / failed update the row; a late "sent" never downgrades it', async () => {
  reset(); await act('jwt-agent', { action: 'sms', to: '6195550100', text: 'a' }); const sid = tables.messages[0].provider_sid;
  await hook('message.sent', { id: sid, to: [{ status: 'sent' }] }); eq(tables.messages[0].status, 'sent');
  await hook('message.finalized', { id: sid, to: [{ status: 'delivered' }] }); eq(tables.messages[0].status, 'delivered');
  await hook('message.sent', { id: sid, to: [{ status: 'sent' }] }); eq(tables.messages[0].status, 'delivered');
  await act('jwt-agent', { action: 'sms', to: '6195550100', text: 'b' }); const sid2 = tables.messages[1].provider_sid;
  await hook('message.finalized', { id: sid2, to: [{ status: 'delivery_failed' }], errors: [{ code: '40300', title: 'Blocked', detail: 'Blocked due to STOP message' }] });
  eq([tables.messages[1].status, tables.messages[1].error], ['failed', 'Blocked due to STOP message']);
});

console.log('Incoming calls');
const A = 'v3:legA', S = 'sess-1';
const initiated = (from = '+16195550100') => hook('call.initiated', { call_control_id: A, call_session_id: S, connection_id: 'app1', direction: 'incoming', from, to: '+16195550000', state: 'parked' });
await test('rings the lead’s own agent first, with the caller’s number showing', async () => {
  reset(); await initiated(); const t = last(/transfer$/);
  eq(t.path, '/calls/' + encodeURIComponent(A) + '/actions/transfer'); eq([t.body.to, t.body.from], ['sip:gencredA2@sip.telnyx.com', '+16195550100']);
  const b = dec(t.body.target_leg_client_state); eq([b.k, b.a, b.s, b.g, b.q.map((x) => x.id)], ['b', A, S, 'u2', ['u4']]);
  const row = tables.call_log[0]; eq([row.direction, row.missed, row.status, row.lead_id, row.agent_id, row.contact_name, row.provider_call_id], ['inbound', true, 'ringing', 'L1', 'u2', 'Maria Lopez', S]);
});
await test('no answer → next agent → forwarding number → spoken message; logged as missed', async () => {
  reset(); settings().fallback_number = '+16195559000'; await initiated();
  let b = dec(last(/transfer$/).body.target_leg_client_state);
  await hook('call.hangup', { call_control_id: 'v3:legB1', call_session_id: S, client_state: enc(b), hangup_cause: 'timeout' });
  let t = last(/transfer$/); eq(t.body.to, 'sip:gencredA4@sip.telnyx.com'); eq(tables.call_log[0].agent_id, 'u4'); b = dec(t.body.target_leg_client_state);
  await hook('call.hangup', { call_control_id: 'v3:legB2', call_session_id: S, client_state: enc(b), hangup_cause: 'call_rejected' });
  t = last(/transfer$/); eq([t.body.to, t.body.from], ['+16195559000', undefined]); b = dec(t.body.target_leg_client_state); ok(b.fb, 'fallback flagged');
  await hook('call.hangup', { call_control_id: 'v3:legB3', call_session_id: S, client_state: enc(b), hangup_cause: 'no_answer' });
  const ans = last(/answer$/); ok(ans, 'answered to speak'); const a = dec(ans.body.client_state);
  await hook('call.answered', { call_control_id: A, call_session_id: S, client_state: enc(a) }); ok(/call you back/.test(last(/speak$/).body.payload), 'spoke');
  await hook('call.speak.ended', { call_control_id: A, call_session_id: S, client_state: last(/speak$/).body.client_state }); ok(last(/hangup$/), 'hung up');
  await hook('call.hangup', { call_control_id: A, call_session_id: S, client_state: last(/speak$/).body.client_state, hangup_cause: 'normal_clearing' });
  eq([tables.call_log[0].missed, tables.call_log[0].status, tables.call_log[0].duration_sec], [true, 'missed', 0]);
});
await test('answered call: logged to the agent who picked up, with the real duration; no more ringing afterwards', async () => {
  reset(); await initiated(); const b = dec(last(/transfer$/).body.target_leg_client_state);
  await hook('call.answered', { call_control_id: 'v3:legB1', call_session_id: S, client_state: enc(b) }, { at: '2026-10-01T18:00:00Z' });
  eq([tables.call_log[0].missed, tables.call_log[0].status, tables.call_log[0].agent_id], [false, 'active', 'u2']);
  const n = sentToTelnyx.length;
  await hook('call.hangup', { call_control_id: 'v3:legB1', call_session_id: S, client_state: enc(b), hangup_cause: 'normal_clearing' }, { at: '2026-10-01T18:02:05Z' });
  eq(sentToTelnyx.length, n, 'no further commands');
  await hook('call.hangup', { call_control_id: A, call_session_id: S, client_state: enc({ k: 'a' }), hangup_cause: 'normal_clearing' }, { at: '2026-10-01T18:02:05Z' });
  eq([tables.call_log[0].status, tables.call_log[0].duration_sec, tables.call_log[0].missed], ['completed', 125, false]);
});
await test('skips agents who are away, on a call, or have inbound switched off', async () => {
  reset(); tables.phone_presence[0].seen_at = new Date(Date.now() - 600000).toISOString(); tables.profiles[3].perms = { inboundDisabled: true }; await initiated();
  ok(!last(/transfer$/), 'nobody to ring'); ok(last(/answer$/), 'goes to the spoken message');
  reset(); tables.phone_presence[0].status = 'on-call'; await initiated(); eq(last(/transfer$/).body.to, 'sip:gencredA4@sip.telnyx.com');
});
await test('caller hangs up while ringing → missed, and the late agent-leg event is harmless', async () => {
  reset(); await initiated(); const b = dec(last(/transfer$/).body.target_leg_client_state);
  await hook('call.hangup', { call_control_id: A, call_session_id: S, client_state: enc({ k: 'a' }), hangup_cause: 'originator_cancel' });
  eq([tables.call_log[0].status, tables.call_log[0].missed], ['missed', true]); const n = sentToTelnyx.length;
  eq((await hook('call.hangup', { call_control_id: 'v3:legB1', call_session_id: S, client_state: enc(b), hangup_cause: 'originator_cancel' })).status, 200); eq(sentToTelnyx.length, n);
});
await test('an agent’s own outbound browser call is ignored; a retried call.initiated does not double-log', async () => {
  reset(); await hook('call.initiated', { call_control_id: 'v3:out', call_session_id: 'sess-out', connection_id: 'sipconn1', direction: 'incoming', from: 'gencredA2', to: '+16195550100' });
  eq([tables.call_log.length, sentToTelnyx.length], [0, 0]);
  await initiated(); await initiated(); eq(tables.call_log.length, 1); eq(sentToTelnyx.filter((x) => /transfer$/.test(x.path)).length, 1);
});
await test('unknown events are acknowledged', async () => eq((await hook('call.dtmf.received', { call_control_id: A })).status, 200));

console.log('\n' + passed + ' passed, ' + failures.length + ' failed' + (failures.length ? ': ' + failures.join(' | ') : ''));
process.exit(failures.length ? 1 : 0);
