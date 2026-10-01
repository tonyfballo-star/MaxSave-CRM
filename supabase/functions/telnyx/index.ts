// =====================================================================
// MSIHub ⇄ Telnyx bridge  (Supabase Edge Function: "telnyx")
//
// One URL does two jobs:
//   1. Signed-in CRM users POST { action: 'sms' | 'token' | 'status', ... }
//   2. Telnyx POSTs webhooks here (inbound texts, delivery receipts, inbound calls).
//      A webhook is accepted when its Ed25519 signature checks out against TELNYX_PUBLIC_KEY,
//      or when the URL carries ?k=<TELNYX_WEBHOOK_SECRET>. At least one of the two must be set.
//
// Deploy with JWT verification OFF (Telnyx cannot send a Supabase token); every
// request is authenticated in code instead.
//
// Secrets (Edge Functions > Secrets):
//   TELNYX_API_KEY        API key (KEY...) from Telnyx > Account > Keys & Credentials
//   TELNYX_WEBHOOK_SECRET Long random string; the webhook URLs saved in Telnyx end with ?k=<this>
//   TELNYX_PUBLIC_KEY     Optional. Public key from the same Telnyx page (signature check)
//   TELNYX_CONNECTION_ID  ID of the SIP "Credentials" connection the browser phones log in to
// Requires supabase/schema-v4.sql.
// =====================================================================
import { createClient } from 'npm:@supabase/supabase-js@2';

const env = (k: string) => Deno.env.get(k) ?? '';
const SUPABASE_URL = env('SUPABASE_URL');
const TELNYX_API_KEY = env('TELNYX_API_KEY');
const TELNYX_PUBLIC_KEY = env('TELNYX_PUBLIC_KEY');
const TELNYX_CONNECTION_ID = env('TELNYX_CONNECTION_ID');
const TELNYX_WEBHOOK_SECRET = env('TELNYX_WEBHOOK_SECRET');
const SELF_URL = SUPABASE_URL + '/functions/v1/telnyx';
const HOOK_URL = SELF_URL + (TELNYX_WEBHOOK_SECRET ? '?k=' + encodeURIComponent(TELNYX_WEBHOOK_SECRET) : '');   // where Telnyx reports back
const API = 'https://api.telnyx.com/v2';

// Service-role client: bypasses row level security, so every path below checks who is calling first.
const db = createClient(SUPABASE_URL, env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

// ---------------------------------------------------------------------
// Phone number helpers (US/Canada). The CRM stores "(619) 555-0100"; Telnyx speaks "+16195550100".
// ---------------------------------------------------------------------
const digits = (p: unknown) => String(p ?? '').replace(/\D/g, '');
function national(p: unknown) { const d = digits(p); return d.length === 11 && d[0] === '1' ? d.slice(1) : d; }
function e164(p: unknown): string | null { const n = national(p); return n.length === 10 ? '+1' + n : null; }
function display(p: unknown) { const n = national(p); return n.length === 10 ? '(' + n.slice(0, 3) + ') ' + n.slice(3, 6) + '-' + n.slice(6) : String(p ?? ''); }
function variants(p: unknown) { const n = national(p); return n.length === 10 ? [display(n), n, '1' + n, '+1' + n, n.slice(0, 3) + '-' + n.slice(3, 6) + '-' + n.slice(6)] : [String(p ?? '')]; }

// ---------------------------------------------------------------------
// Telnyx REST
// ---------------------------------------------------------------------
async function telnyx(method: string, path: string, body?: unknown) {
  if (!TELNYX_API_KEY) throw new HttpError(503, 'Telnyx is not connected yet (TELNYX_API_KEY is missing)');
  const res = await fetch(API + path, { method, headers: { Authorization: 'Bearer ' + TELNYX_API_KEY, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed: any = null; try { parsed = JSON.parse(text); } catch { /* the token endpoint answers in plain text */ }
  if (!res.ok) { const e = parsed?.errors?.[0]; throw new HttpError(res.status === 401 ? 503 : 502, 'Telnyx: ' + (e?.detail || e?.title || text.slice(0, 200) || res.statusText)); }
  return parsed ?? text;
}
const state = (o: unknown) => btoa(JSON.stringify(o));
function readState(s: unknown): any { if (!s) return {}; try { return JSON.parse(atob(String(s))); } catch { return {}; } }

async function settings(): Promise<any> {
  const { data } = await db.from('agency_settings').select('value').eq('key', 'telnyx').maybeSingle();
  return data?.value ?? {};
}

// ---------------------------------------------------------------------
// Who is calling this function?
// ---------------------------------------------------------------------
async function requireUser(req: Request) {
  const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) throw new HttpError(401, 'Sign in first');
  const { data, error } = await db.auth.getUser(jwt);
  if (error || !data?.user) throw new HttpError(401, 'Your session expired — sign in again');
  const { data: profile } = await db.from('profiles').select('*').eq('id', data.user.id).maybeSingle();
  if (!profile || !profile.active) throw new HttpError(403, 'This account is not active');
  return profile;
}

// ---------------------------------------------------------------------
// action: status  (admin) — is everything wired up, and which numbers do we own?
// ---------------------------------------------------------------------
async function actionStatus(profile: any) {
  if (profile.role !== 'admin') throw new HttpError(403, 'Admins only');
  const out: any = { api_key: !!TELNYX_API_KEY, public_key: !!TELNYX_PUBLIC_KEY || !!TELNYX_WEBHOOK_SECRET, connection_id: !!TELNYX_CONNECTION_ID, schema: true, webhook_url: SELF_URL, numbers: [], error: null };
  const probe = await db.from('phone_presence').select('agent_id').limit(1);
  const cols = await db.from('profiles').select('telnyx_number').limit(1);
  if (probe.error || cols.error) out.schema = false;
  if (TELNYX_API_KEY) {
    try {
      const r = await telnyx('GET', '/phone_numbers?page[size]=100');
      out.numbers = (r.data || []).map((n: any) => ({ number: n.phone_number, status: n.status, texting: !!n.messaging_profile_id, connection_id: n.connection_id || null, connection_name: n.connection_name || null }));
    } catch (e) { out.error = (e as Error).message; }
  }
  return out;
}

// ---------------------------------------------------------------------
// action: sms — send one text (or picture message) and record it
// ---------------------------------------------------------------------
async function actionSms(profile: any, body: any) {
  const to = e164(body.to);
  if (!to) throw new HttpError(400, 'That phone number does not look valid');
  const text = String(body.text ?? '').trim();
  const media: any[] = Array.isArray(body.media) ? body.media.slice(0, 5) : [];
  if (!text && !media.length) throw new HttpError(400, 'Message is empty');
  if (text.length > 1600) throw new HttpError(400, 'Message is too long (1,600 characters max)');

  const s = await settings();
  if (!s.sms_enabled) throw new HttpError(409, 'Texting is turned off in Settings → Call & Text');
  const from = e164(profile.telnyx_number) || e164(s.sms_number);
  if (!from) throw new HttpError(409, 'No text number is set — an admin can pick one in Settings → Call & Text');

  const { data: opted } = await db.from('sms_opt_outs').select('phone').eq('phone', to).maybeSingle();
  if (opted) throw new HttpError(409, 'This number opted out of texts (they replied STOP)');

  // Attachments were uploaded by the app to the private "files" bucket under mms/; Telnyx fetches them through short-lived links.
  const mediaUrls: string[] = [];
  for (const m of media) {
    const path = String(m?.path ?? '');
    if (!path.startsWith('mms/')) throw new HttpError(400, 'Bad attachment path');
    const { data, error } = await db.storage.from('files').createSignedUrl(path, 3600);
    if (error || !data?.signedUrl) throw new HttpError(400, 'Could not read attachment ' + (m?.name || path));
    mediaUrls.push(data.signedUrl);
  }

  const sent = await telnyx('POST', '/messages', { from, to, text: text || undefined, media_urls: mediaUrls.length ? mediaUrls : undefined, webhook_url: HOOK_URL });
  const row = {
    agent_id: profile.id, lead_id: body.lead_id || null, customer_id: body.customer_id || null,
    contact_name: String(body.contact_name || '').slice(0, 200) || display(to), phone: display(to), direction: 'outbound',
    body: text || '📎 ' + (media.length === 1 ? 'Picture' : media.length + ' pictures'), status: 'queued',
    provider_sid: sent?.data?.id ?? null, from_number: from, to_number: to,
    media: media.length ? media.map((m) => ({ storage_path: m.path, name: m.name || null })) : null,
  };
  const { data: saved, error } = await db.from('messages').insert(row).select().single();
  if (error) { console.error('[telnyx] text sent but not saved', error); return { ok: true, row: null, warning: 'Sent, but could not be saved to the conversation: ' + error.message }; }
  return { ok: true, row: saved };
}

// ---------------------------------------------------------------------
// action: token — a 24-hour login for this agent's browser phone
// ---------------------------------------------------------------------
async function actionToken(profile: any) {
  if (!TELNYX_CONNECTION_ID) throw new HttpError(503, 'Calling is not connected yet (TELNYX_CONNECTION_ID is missing)');
  const s = await settings();
  if (!s.voice_enabled) throw new HttpError(409, 'Calling is turned off in Settings → Call & Text');
  let credId: string | null = profile.telnyx_credential_id || null, sip: string | null = profile.telnyx_sip_username || null, fresh = false;

  const create = async () => {
    const r = await telnyx('POST', '/telephony_credentials', { connection_id: TELNYX_CONNECTION_ID, name: 'MaxSaveHub — ' + (profile.full_name || profile.email || profile.id), tag: 'maxsavehub' });
    credId = r.data.id; sip = r.data.sip_username; fresh = true;
    const { error } = await db.from('profiles').update({ telnyx_credential_id: credId, telnyx_sip_username: sip }).eq('id', profile.id);
    if (error) throw new HttpError(500, 'Could not save the phone login: ' + error.message);
  };
  if (!credId || !sip) await create();
  let token: string;
  try { token = await telnyx('POST', '/telephony_credentials/' + credId + '/token'); }
  catch (_e) { await create(); token = await telnyx('POST', '/telephony_credentials/' + credId + '/token'); }   // credential was deleted or expired in Telnyx
  if (typeof token !== 'string') token = (token as any)?.data ?? '';
  if (!token) throw new HttpError(502, 'Telnyx did not return a phone login');
  // "fresh": Telnyx needs a few seconds before a brand-new credential can register.
  return { token: String(token).trim(), sip_username: sip, caller_id: e164(profile.telnyx_number) || e164(s.caller_id) || e164(s.sms_number), fresh };
}

// ---------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------
function b64(s: string) { const bin = atob(s.replace(/\s+/g, '')); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
async function verifySignature(req: Request, raw: string) {
  const sig = req.headers.get('telnyx-signature-ed25519'), ts = req.headers.get('telnyx-timestamp');
  if (!sig || !ts || !TELNYX_PUBLIC_KEY) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;   // stale or replayed
  try {
    const key = await crypto.subtle.importKey('raw', b64(TELNYX_PUBLIC_KEY), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, b64(sig), new TextEncoder().encode(ts + '|' + raw));
  } catch (e) { console.error('[telnyx] signature check failed', e); return false; }
}

// Who is this number? Prefer the conversation we already have with them, then customers, then leads.
async function findContact(phone: string) {
  const v = variants(phone);
  const out: any = { lead_id: null, customer_id: null, name: null, agent_id: null, thread_agent: null };
  const { data: last } = await db.from('messages').select('agent_id, lead_id, customer_id, contact_name').in('phone', v).eq('direction', 'outbound').order('created_at', { ascending: false }).limit(1);
  if (last?.[0]) { out.thread_agent = last[0].agent_id; out.lead_id = last[0].lead_id; out.customer_id = last[0].customer_id; out.name = last[0].contact_name; }
  if (!out.lead_id && !out.customer_id) {
    const { data: cust } = await db.from('customers').select('id, first_name, last_name, agent_id').in('phone', v).order('created_at', { ascending: false }).limit(1);
    if (cust?.[0]) { out.customer_id = cust[0].id; out.agent_id = cust[0].agent_id; out.name = ((cust[0].first_name || '') + ' ' + (cust[0].last_name || '')).trim() || out.name; }
    else {
      const { data: lead } = await db.from('leads').select('id, first_name, last_name, agent_id').in('phone', v).order('received_at', { ascending: false }).limit(1);
      if (lead?.[0]) { out.lead_id = lead[0].id; out.agent_id = lead[0].agent_id; out.name = ((lead[0].first_name || '') + ' ' + (lead[0].last_name || '')).trim() || out.name; }
    }
  }
  return out;
}
async function numberOwner(to: string): Promise<string | null> {
  const { data } = await db.from('profiles').select('id').in('telnyx_number', variants(to)).eq('active', true).limit(1);
  return data?.[0]?.id ?? null;
}

const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'optout', 'revoke']);
const START_WORDS = new Set(['start', 'unstop', 'optin']);
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic', 'application/pdf': 'pdf', 'video/mp4': 'mp4', 'video/3gpp': '3gp', 'audio/mpeg': 'mp3', 'text/vcard': 'vcf', 'text/x-vcard': 'vcf' };

// Copy inbound pictures into the CRM's own storage (Telnyx links expire) and attach them to the contact's Files.
async function saveMedia(p: any, c: any) {
  const out: any[] = []; let saved = 0;
  const list: any[] = Array.isArray(p.media) ? p.media.slice(0, 10) : [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i]; const item: any = { url: m.url, content_type: m.content_type || null, size: m.size || null };
    try {
      if (m.size && m.size > 25 * 1024 * 1024) throw new Error('larger than 25 MB');
      const res = await fetch(m.url); if (!res.ok) throw new Error('download failed (' + res.status + ')');
      const buf = new Uint8Array(await res.arrayBuffer());
      const ext = EXT[String(m.content_type || '').toLowerCase()] || (String(m.url).split('?')[0].match(/\.([A-Za-z0-9]{2,5})$/)?.[1] ?? 'bin');
      const folder = c.lead_id ? 'leads/' + c.lead_id : c.customer_id ? 'customers/' + c.customer_id : 'mms/inbound';
      const path = folder + '/' + Date.now() + '_text_' + (i + 1) + '.' + ext;
      const up = await db.storage.from('files').upload(path, buf, { contentType: m.content_type || undefined, upsert: true });
      if (up.error) throw new Error(up.error.message);
      item.storage_path = path;
      if (c.lead_id || c.customer_id) {
        const filename = 'Texted ' + new Date().toISOString().slice(0, 10) + (list.length > 1 ? ' (' + (i + 1) + ')' : '') + '.' + ext;
        const ins = await db.from('files').insert({ lead_id: c.lead_id || null, customer_id: c.lead_id ? null : c.customer_id, storage_path: path, filename, size_bytes: buf.length, mime_type: m.content_type || null });
        if (!ins.error) saved++;
      }
    } catch (e) { item.error = (e as Error).message; console.error('[telnyx] inbound media', e); }
    out.push(item);
  }
  return { media: out, saved };
}

async function onMessageReceived(p: any) {
  const from = p.from?.phone_number, to = p.to?.[0]?.phone_number;
  if (!from || !p.id) return;
  const { data: dup } = await db.from('messages').select('id').eq('provider_sid', p.id).limit(1);
  if (dup?.length) return;   // Telnyx retried a webhook we already handled

  const text = String(p.text ?? '').trim();
  const word = text.toLowerCase().replace(/[^a-z]/g, '');
  const fromE164 = e164(from) || from;
  if (STOP_WORDS.has(word)) await db.from('sms_opt_outs').upsert({ phone: fromE164, keyword: text.slice(0, 40) });
  else if (START_WORDS.has(word)) await db.from('sms_opt_outs').delete().eq('phone', fromE164);

  const c = await findContact(from);
  const owner = to ? await numberOwner(to) : null;
  const { media, saved } = await saveMedia(p, c);
  const note = media.length ? '📎 ' + (media.length === 1 ? 'Picture' : media.length + ' pictures') + ' received' + (saved ? ' — saved to Files' : '') : '';
  const { error } = await db.from('messages').insert({
    agent_id: c.thread_agent ?? owner ?? c.agent_id ?? null, lead_id: c.lead_id, customer_id: c.customer_id,
    contact_name: c.name || display(from), phone: display(from), direction: 'inbound',
    body: [text, note].filter(Boolean).join('\n') || '(empty message)', status: 'received',
    provider_sid: p.id, from_number: fromE164, to_number: to || null, media: media.length ? media : null,
  });
  if (error && error.code !== '23505') throw new Error('saving inbound text: ' + error.message);
}

// Delivery receipts for texts we sent.
async function onMessageStatus(p: any) {
  if (!p.id) return;
  const st = String(p.to?.[0]?.status ?? '');
  const failed = ['sending_failed', 'delivery_failed', 'expired'].includes(st);
  const status = st === 'delivered' ? 'delivered' : failed ? 'failed' : (st === 'sent' || st === 'delivery_unconfirmed') ? 'sent' : null;
  if (!status) return;
  const patch: any = { status };
  if (failed) { const e = p.errors?.[0]; patch.error = (e?.detail || e?.title || st).slice(0, 300); }
  const apply = () => {
    let q = db.from('messages').update(patch).eq('provider_sid', p.id);
    if (status === 'sent') q = q.eq('status', 'queued');   // never step back from delivered/failed
    return q.select('id');
  };
  const first = await apply();
  if (!first.data?.length && status !== 'sent') {   // receipt beat our own insert: give it a moment
    await new Promise((r) => setTimeout(r, 1500));
    await apply();
  }
}

// ---- Inbound calls (numbers pointed at a Voice API application whose webhook is this URL) ----
// Leg A = the caller. We ring agents' browser phones one at a time (leg B); first to answer is bridged.
async function pickAgents(to: string, c: any, s: any) {
  const since = new Date(Date.now() - 90_000).toISOString();
  const { data: pres } = await db.from('phone_presence').select('agent_id, status, seen_at').gte('seen_at', since);
  const online = new Set((pres || []).filter((x: any) => x.status === 'available').map((x: any) => x.agent_id));
  const { data: profs } = await db.from('profiles').select('id, telnyx_sip_username, perms').eq('active', true).not('telnyx_sip_username', 'is', null);
  const ok = new Map<string, string>();
  (profs || []).forEach((p: any) => { if (online.has(p.id) && !(p.perms || {}).inboundDisabled) ok.set(p.id, p.telnyx_sip_username); });
  const owner = await numberOwner(to);
  const order = [owner, c.thread_agent, c.agent_id, s.inbound_agent_id, ...ok.keys()].filter(Boolean) as string[];
  const out: { id: string; sip: string }[] = [];
  for (const id of order) { if (ok.has(id) && !out.find((x) => x.id === id)) out.push({ id, sip: ok.get(id)! }); }
  return out.slice(0, 3);
}

async function ring(aLeg: string, session: string, from: string, queue: { id: string; sip: string }[], s: any, triedFallback = false) {
  const act = '/calls/' + encodeURIComponent(aLeg) + '/actions/';
  if (queue.length) {
    const [t, ...rest] = queue;
    await telnyx('POST', act + 'transfer', { to: 'sip:' + t.sip + '@sip.telnyx.com', from, timeout_secs: Number(s.ring_secs) || 20,
      client_state: state({ k: 'a' }), target_leg_client_state: state({ k: 'b', a: aLeg, s: session, g: t.id, q: rest, f: from }) });
    await db.from('call_log').update({ agent_id: t.id }).eq('provider_call_id', session).is('answered_at', null);
    return;
  }
  const fallback = e164(s.fallback_number);
  if (fallback && !triedFallback) {
    await telnyx('POST', act + 'transfer', { to: fallback, timeout_secs: 30, client_state: state({ k: 'a' }), target_leg_client_state: state({ k: 'b', a: aLeg, s: session, g: null, q: [], f: from, fb: 1 }) });
    return;
  }
  await telnyx('POST', act + 'answer', { client_state: state({ k: 'a', vm: 1 }) });   // nobody available: say so, then hang up
}

async function onCallInitiated(p: any) {
  if (p.direction !== 'incoming' || p.client_state) return;                      // legs we created carry our state
  if (TELNYX_CONNECTION_ID && p.connection_id === TELNYX_CONNECTION_ID) return;  // an agent's own outbound call from the browser phone
  const session = p.call_session_id;
  const { data: dup } = await db.from('call_log').select('id').eq('provider_call_id', session).limit(1);
  if (dup?.length) return;
  const s = await settings();
  const c = await findContact(p.from);
  const queue = s.voice_enabled ? await pickAgents(p.to, c, s) : [];
  const { error } = await db.from('call_log').insert({
    agent_id: queue[0]?.id ?? c.thread_agent ?? c.agent_id ?? null, lead_id: c.lead_id, customer_id: c.customer_id,
    contact_name: c.name || display(p.from), phone: display(p.from), direction: 'inbound', missed: true, duration_sec: 0,
    provider_call_id: session, status: 'ringing', from_number: p.from, to_number: p.to,
  });
  if (error) console.error('[telnyx] logging inbound call', error);
  await ring(p.call_control_id, session, p.from, queue, s);
}

async function onCallAnswered(p: any, at: string) {
  const st = readState(p.client_state);
  if (st.k === 'b') {   // an agent (or the fallback line) picked up
    const patch: any = { missed: false, answered_at: at, status: 'active' };
    if (st.g) patch.agent_id = st.g;
    await db.from('call_log').update(patch).eq('provider_call_id', st.s);
  } else if (st.k === 'a' && st.vm) {
    const s = await settings();
    await telnyx('POST', '/calls/' + encodeURIComponent(p.call_control_id) + '/actions/speak', {
      payload: s.unavailable_message || 'Thank you for calling Max Save Insurance. All of our agents are helping other customers right now. We have your number and will call you back shortly.',
      voice: 'female', language: 'en-US', client_state: state({ k: 'a', vm: 2 }) });
  }
}

async function onCallHangup(p: any, at: string) {
  const st = readState(p.client_state);
  if (st.k === 'b') {   // an agent leg ended; if nobody has answered yet, try the next one
    const { data: rows } = await db.from('call_log').select('id, answered_at, ended_at').eq('provider_call_id', st.s).limit(1);
    const row = rows?.[0];
    if (row && !row.answered_at && !row.ended_at) {
      try { await ring(st.a, st.s, st.f, st.q || [], await settings(), !!st.fb); }
      catch (e) { console.log('[telnyx] caller already gone:', (e as Error).message); }
    }
    return;
  }
  // Leg A: the caller's side ended — close out the log row.
  const { data: rows } = await db.from('call_log').select('id, answered_at').eq('provider_call_id', p.call_session_id).limit(1);
  const row = rows?.[0]; if (!row) return;
  const secs = row.answered_at ? Math.max(0, Math.round((new Date(at).getTime() - new Date(row.answered_at).getTime()) / 1000)) : 0;
  await db.from('call_log').update({ ended_at: at, duration_sec: secs, missed: !row.answered_at, status: row.answered_at ? 'completed' : 'missed' }).eq('id', row.id);
}

function sameText(a: string, b: string) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
function hasUrlSecret(req: Request) { const k = new URL(req.url).searchParams.get('k') || ''; return TELNYX_WEBHOOK_SECRET.length >= 24 && sameText(k, TELNYX_WEBHOOK_SECRET); }

async function webhook(req: Request, raw: string) {
  if (!hasUrlSecret(req) && !(await verifySignature(req, raw))) return json({ error: 'not from Telnyx' }, 401);
  let evt: any; try { evt = JSON.parse(raw).data; } catch { return json({ error: 'bad json' }, 400); }
  const type = String(evt?.event_type ?? ''), p = evt?.payload ?? {}, at = evt?.occurred_at || new Date().toISOString();
  try {
    if (type === 'message.received') await onMessageReceived(p);
    else if (type === 'message.sent' || type === 'message.finalized') await onMessageStatus(p);
    else if (type === 'call.initiated') await onCallInitiated(p);
    else if (type === 'call.answered') await onCallAnswered(p, at);
    else if (type === 'call.hangup') await onCallHangup(p, at);
    else if (type === 'call.speak.ended' && readState(p.client_state).vm) await telnyx('POST', '/calls/' + encodeURIComponent(p.call_control_id) + '/actions/hangup', {});
  } catch (e) {
    console.error('[telnyx] webhook ' + type, e);
    // A failed text is worth a retry from Telnyx; a call has moved on by the time a retry would arrive.
    return json({ error: (e as Error).message }, type.startsWith('message.') ? 500 : 200);
  }
  return json({ ok: true });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const raw = await req.text();
  if (req.headers.get('telnyx-signature-ed25519') || new URL(req.url).searchParams.has('k')) return webhook(req, raw);
  try {
    const profile = await requireUser(req);
    let body: any; try { body = JSON.parse(raw || '{}'); } catch { throw new HttpError(400, 'Bad request'); }
    if (body.action === 'sms') return json(await actionSms(profile, body));
    if (body.action === 'token') return json(await actionToken(profile));
    if (body.action === 'status') return json(await actionStatus(profile));
    throw new HttpError(400, 'Unknown action');
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error('[telnyx]', e);
    return json({ error: 'Something went wrong on the server' }, 500);
  }
});
