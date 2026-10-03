// =====================================================================
// MaxSaveHub automation runner + email sender  (Supabase Edge Function: "automation")
//
// One URL, three jobs:
//   1. POST ?k=<AUTOMATION_SECRET>        the 5-minute tick from pg_cron: runs the daily jobs once a day, then sends
//                                         every due sequence step (text via Telnyx, email via Brevo, or creates a task).
//   2. POST with a signed-in user's JWT   { action: 'email' | 'run' | 'status' | 'test_email' }
//        email      send one email from a lead/customer card   { to, subject, body, lead_id?, customer_id? }
//        run        (admin) process due steps right now
//        status     (admin) is email wired up, counts, last tick
//        test_email (admin) send a test email to yourself
//   3. GET ?u=<token>                     one-click unsubscribe link from the footer of every email we send.
//
// Deploy with JWT verification OFF (cron and the unsubscribe link carry no Supabase token); every request is checked in code.
//
// Secrets (Edge Functions > Secrets):
//   AUTOMATION_SECRET      long random string; the cron job's URL ends with ?k=<this>; also signs unsubscribe links
//   BREVO_API_KEY          optional, from app.brevo.com > SMTP & API > API keys. Without it email steps are logged as skipped.
//   TELNYX_API_KEY         already set for the "telnyx" function; reused here to send automated texts
//   TELNYX_WEBHOOK_SECRET  already set; delivery receipts for automated texts go to the "telnyx" function like any other text
// Requires supabase/schema-v6-automation.sql.
// =====================================================================
import { createClient } from 'npm:@supabase/supabase-js@2';

const env = (k: string) => Deno.env.get(k) ?? '';
const SUPABASE_URL = env('SUPABASE_URL');
const SECRET = env('AUTOMATION_SECRET');
const BREVO_API_KEY = env('BREVO_API_KEY');
const TELNYX_API_KEY = env('TELNYX_API_KEY');
const TELNYX_WEBHOOK_SECRET = env('TELNYX_WEBHOOK_SECRET');
const SELF_URL = SUPABASE_URL + '/functions/v1/automation';
const TELNYX_HOOK = SUPABASE_URL + '/functions/v1/telnyx' + (TELNYX_WEBHOOK_SECRET ? '?k=' + encodeURIComponent(TELNYX_WEBHOOK_SECRET) : '');
const BATCH = 40, MAX_BATCHES = 5;

const db = createClient(SUPABASE_URL, env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8' } });
class HttpError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }

// ---- phone helpers (same rules as the telnyx function) ----
const digits = (p: unknown) => String(p ?? '').replace(/\D/g, '');
function national(p: unknown) { const d = digits(p); return d.length === 11 && d[0] === '1' ? d.slice(1) : d; }
function e164(p: unknown): string | null { const n = national(p); return n.length === 10 ? '+1' + n : null; }
function display(p: unknown) { const n = national(p); return n.length === 10 ? '(' + n.slice(0, 3) + ') ' + n.slice(3, 6) + '-' + n.slice(6) : String(p ?? ''); }
const validEmail = (e: unknown) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e ?? '').trim());
const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function setting(key: string): Promise<any> {
  const { data } = await db.from('agency_settings').select('value').eq('key', key).maybeSingle();
  return data?.value ?? {};
}
const sameText = (a: string, b: string) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
function hasSecret(req: Request) { const k = new URL(req.url).searchParams.get('k') || ''; return SECRET.length >= 24 && sameText(k, SECRET); }

async function requireUser(req: Request) {
  const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!jwt) throw new HttpError(401, 'Sign in first');
  const { data, error } = await db.auth.getUser(jwt);
  if (error || !data?.user) throw new HttpError(401, 'Your session expired — sign in again');
  const { data: profile } = await db.from('profiles').select('*').eq('id', data.user.id).maybeSingle();
  if (!profile || !profile.active) throw new HttpError(403, 'This account is not active');
  return profile;
}

// ---- unsubscribe tokens: base64url(email) . first 32 hex chars of HMAC-SHA256(secret, email) ----
const b64u = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4))));
async function hmac(text: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET || 'unset'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));
  return Array.from(sig).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
async function unsubToken(email: string) { const e = email.trim().toLowerCase(); return b64u(e) + '.' + await hmac(e); }
async function unsubEmail(token: string): Promise<string | null> {
  const [enc, sig] = String(token || '').split('.');
  if (!enc || !sig) return null;
  let e = ''; try { e = unb64u(enc); } catch { return null; }
  return sameText(sig, await hmac(e)) ? e : null;
}

// ---- Brevo ----
async function brevoSend(o: { to: string; toName?: string; subject: string; text: string; cfg: any }) {
  if (!BREVO_API_KEY) throw new HttpError(503, 'Email is not connected yet (BREVO_API_KEY is missing)');
  const from = String(o.cfg.email_from || '').trim();
  if (!validEmail(from)) throw new HttpError(409, 'No sender address is set — an admin can add one in Settings → Lifecycle Automation');
  const unsub = SELF_URL + '?u=' + encodeURIComponent(await unsubToken(o.to));
  const sig = String(o.cfg.email_signature || '').trim();
  const text = o.text + (sig ? '\n\n' + sig : '') + '\n\n--\nTo stop receiving emails from us, open: ' + unsub;
  const paragraphs = (o.text + (sig ? '\n\n' + sig : '')).split(/\n{2,}/).map((p) => '<p style="margin:0 0 14px">' + escHtml(p).replace(/\n/g, '<br>') + '</p>').join('');
  const htmlBody = '<!doctype html><html><body style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.5;color:#111;max-width:640px;margin:0 auto;padding:24px">' + paragraphs
    + '<p style="margin-top:28px;font-size:12px;color:#696969;border-top:1px solid #e2e2e2;padding-top:12px">' + escHtml(o.cfg.email_from_name || 'MaxSave Insurance')
    + (o.cfg.email_footer ? ' &middot; ' + escHtml(String(o.cfg.email_footer)) : '') + '<br><a href="' + unsub + '" style="color:#696969">Unsubscribe</a></p></body></html>';
  const payload: any = {
    sender: { name: o.cfg.email_from_name || 'MaxSave Insurance', email: from },
    to: [{ email: o.to, name: o.toName || undefined }],
    subject: o.subject || '(no subject)', textContent: text, htmlContent: htmlBody,
    headers: { 'List-Unsubscribe': '<' + unsub + '>' },
  };
  if (validEmail(o.cfg.email_reply_to)) payload.replyTo = { email: String(o.cfg.email_reply_to).trim() };
  const res = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload) });
  const t = await res.text(); let j: any = null; try { j = JSON.parse(t); } catch { /* text */ }
  if (!res.ok) throw new HttpError(res.status === 401 ? 503 : 502, 'Brevo: ' + (j?.message || t.slice(0, 200) || res.statusText));
  return String(j?.messageId || '');
}

async function emailOptedOut(email: string) {
  const { data } = await db.from('email_opt_outs').select('email').eq('email', email.trim().toLowerCase()).maybeSingle();
  return !!data;
}

// Send one email and record it. Throws on a refusal; the caller decides whether that is "skipped" or "failed".
async function sendEmail(o: { to: string; toName?: string; subject: string; body: string; agent_id?: string | null; lead_id?: string | null; customer_id?: string | null; source: string; enrollment_id?: number | null }) {
  const to = String(o.to || '').trim().toLowerCase();
  if (!validEmail(to)) throw new HttpError(400, 'That email address does not look valid');
  const subject = String(o.subject || '').trim(), body = String(o.body || '').trim();
  if (!body) throw new HttpError(400, 'Message is empty');
  if (body.length > 20000) throw new HttpError(400, 'Message is too long');
  const cfg = await setting('automation');
  if (!cfg.email_enabled) throw new HttpError(409, 'Email sending is switched off in Settings → Lifecycle Automation');
  if (await emailOptedOut(to)) throw new HttpError(409, 'This address unsubscribed from our emails');
  const providerId = await brevoSend({ to, toName: o.toName, subject, text: body, cfg });
  const row = { direction: 'outbound', agent_id: o.agent_id || null, lead_id: o.lead_id || null, customer_id: o.customer_id || null, to_email: to, from_email: String(cfg.email_from || '').trim().toLowerCase(), subject, body, status: 'sent', provider_id: providerId || null, source: o.source, enrollment_id: o.enrollment_id || null };
  const { data: saved, error } = await db.from('emails').insert(row).select().single();
  if (error) { console.error('[automation] email sent but not saved', error); return { ok: true, row: null, warning: 'Sent, but could not be saved: ' + error.message }; }
  return { ok: true, row: saved };
}

// ---- texts for sequence steps (same Telnyx call the "telnyx" function makes) ----
async function sendText(item: any, telnyxCfg: any) {
  const to = e164(item.phone);
  if (!to) throw new HttpError(400, 'no valid phone number');
  if (!TELNYX_API_KEY) throw new HttpError(503, 'Telnyx is not connected (TELNYX_API_KEY missing)');
  let from: string | null = null;
  if (item.agent_id) { const { data: a } = await db.from('profiles').select('telnyx_number').eq('id', item.agent_id).maybeSingle(); from = e164(a?.telnyx_number); }
  from = from || e164(telnyxCfg.sms_number);
  if (!from) throw new HttpError(409, 'no text number is set in Settings → Call & Text');
  let text = String(item.message || '').trim();
  if (!text) throw new HttpError(400, 'empty message');
  const cfg = await setting('automation');
  if (item.first_text && cfg.sms_optout_footer !== false && !/\bSTOP\b/.test(text)) text += ' Reply STOP to opt out.';
  if (text.length > 1600) text = text.slice(0, 1600);
  const res = await fetch('https://api.telnyx.com/v2/messages', { method: 'POST', headers: { Authorization: 'Bearer ' + TELNYX_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to, text, webhook_url: TELNYX_HOOK }) });
  const t = await res.text(); let j: any = null; try { j = JSON.parse(t); } catch { /* text */ }
  if (!res.ok) { const e = j?.errors?.[0]; throw new HttpError(502, 'Telnyx: ' + (e?.detail || e?.title || t.slice(0, 200))); }
  const { error } = await db.from('messages').insert({
    agent_id: item.agent_id || null, lead_id: item.lead_id || null, customer_id: item.customer_id || null, contact_name: item.name || display(to), phone: display(to),
    direction: 'outbound', body: text, status: 'queued', provider_sid: j?.data?.id ?? null, from_number: from, to_number: to,
  });
  if (error) console.error('[automation] text sent but not saved', error);
  return j?.data?.id ?? null;
}

async function createTask(item: any) {
  const label = String(item.message || '').trim().split('\n')[0].slice(0, 160) || 'Follow up with ' + (item.name || 'lead');
  const icon = /\bcall|phone|dial\b/i.test(label) ? '📞' : /\bemail\b/i.test(label) ? '📧' : '✅';
  const row = {
    label, icon, priority: 'med', due_date: item.today, due_time: /right away/i.test(item.time || '') ? null : (item.time || null),
    assigned_to: item.agent_id || null, assigned_label: item.agent_name || 'Unassigned', lead_id: item.lead_id || null, customer_id: item.customer_id || null,
    notes: 'From sequence "' + item.rule_name + '" (step ' + (item.step_no + 1) + ' of ' + item.steps_total + ')', done: false, source: 'automation',
  };
  const { error } = await db.from('tasks').insert(row);
  if (error) throw new HttpError(500, 'task not saved: ' + error.message);
  return label;
}

async function advance(id: number, status: string, detail: string, action: string) {
  const { error } = await db.rpc('automation_advance', { p_id: id, p_status: status, p_detail: detail.slice(0, 500), p_action: action });
  if (error) console.error('[automation] advance failed', id, error);
}

async function runStep(item: any, telnyxCfg: any, counts: any) {
  const action = String(item.action || '');
  try {
    if (action === 'Send Text') {
      if (item.do_not_call) { await advance(item.enrollment_id, 'skipped', 'Text skipped: lead is marked Do Not Call', action); counts.skipped++; return; }
      if (item.sms_opted_out) { await advance(item.enrollment_id, 'skipped', 'Text skipped: they replied STOP', action); counts.skipped++; return; }
      if (!e164(item.phone)) { await advance(item.enrollment_id, 'skipped', 'Text skipped: no valid phone number', action); counts.skipped++; return; }
      if (!telnyxCfg.sms_enabled) { await advance(item.enrollment_id, 'skipped', 'Text skipped: texting is switched off in Settings → Call & Text', action); counts.skipped++; return; }
      const sid = await sendText(item, telnyxCfg);
      await advance(item.enrollment_id, 'sent', 'Text sent to ' + display(item.phone) + (sid ? ' (' + sid + ')' : ''), action); counts.sent++;
    } else if (action === 'Send Email') {
      if (!validEmail(item.email)) { await advance(item.enrollment_id, 'skipped', 'Email skipped: no email address on file', action); counts.skipped++; return; }
      if (item.email_opted_out) { await advance(item.enrollment_id, 'skipped', 'Email skipped: they unsubscribed', action); counts.skipped++; return; }
      try {
        await sendEmail({ to: item.email, toName: item.name, subject: item.subject, body: item.message, agent_id: item.agent_id, lead_id: item.lead_id, customer_id: item.customer_id, source: 'automation', enrollment_id: item.enrollment_id });
      } catch (e) {
        if (e instanceof HttpError && (e.status === 409 || e.status === 503)) { await advance(item.enrollment_id, 'skipped', 'Email skipped: ' + e.message, action); counts.skipped++; return; }
        throw e;
      }
      await advance(item.enrollment_id, 'sent', 'Email sent to ' + String(item.email).toLowerCase() + ': ' + (item.subject || '(no subject)'), action); counts.sent++;
    } else if (action === 'Create Task') {
      const label = await createTask(item);
      await advance(item.enrollment_id, 'task', 'Task created for ' + (item.agent_name || 'Unassigned') + ': ' + label, action); counts.tasks++;
    } else {
      await advance(item.enrollment_id, 'skipped', 'Unknown step type "' + action + '"', action); counts.skipped++;
    }
  } catch (e) {
    const msg = (e as Error).message || String(e);
    console.error('[automation] step failed', item.enrollment_id, msg);
    await advance(item.enrollment_id, 'failed', action + ' failed: ' + msg, action); counts.failed++;
  }
}

async function tick(force = false) {
  const cfg = await setting('automation');
  const out: any = { enabled: !!cfg.enabled, daily: null, sent: 0, tasks: 0, skipped: 0, failed: 0, processed: 0 };
  if (!cfg.enabled) return out;
  const daily = await db.rpc('automation_daily', { p_force: !!force });
  out.daily = daily.error ? { error: daily.error.message } : daily.data;
  const telnyxCfg = await setting('telnyx');
  for (let b = 0; b < MAX_BATCHES; b++) {
    const { data, error } = await db.rpc('automation_due', { p_limit: BATCH });
    if (error) { out.error = error.message; console.error('[automation] due', error); break; }
    const items: any[] = (data || []).map((r: any) => (r && typeof r === 'object' && 'automation_due' in r) ? r.automation_due : r);
    if (!items.length) break;
    for (const item of items) { await runStep(item, telnyxCfg, out); out.processed++; }
    if (items.length < BATCH) break;
  }
  const { data: cur } = await db.from('agency_settings').select('value').eq('key', 'automation_state').maybeSingle();
  const state = { ...((cur && cur.value) || {}), last_tick_at: new Date().toISOString(), last_tick: { sent: out.sent, tasks: out.tasks, skipped: out.skipped, failed: out.failed, processed: out.processed } };
  await db.from('agency_settings').upsert({ key: 'automation_state', value: state, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  return out;
}

async function actionStatus(profile: any) {
  if (profile.role !== 'admin') throw new HttpError(403, 'Admins only');
  const { data: st } = await db.rpc('automation_status');
  const cfg = await setting('automation');
  return { ok: true, email: { api_key: !!BREVO_API_KEY, enabled: !!cfg.email_enabled, from: cfg.email_from || null }, cron_secret: SECRET.length >= 24, telnyx_key: !!TELNYX_API_KEY, status: st || null, self_url: SELF_URL };
}

const page = (title: string, body: string) => html('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + escHtml(title) + '</title></head><body style="font-family:Segoe UI,Arial,sans-serif;background:#f4f4f4;margin:0;padding:40px 16px"><div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;padding:32px;box-shadow:0 2px 12px rgba(0,0,0,.08)"><div style="font-size:22px;font-weight:600;margin-bottom:10px">' + escHtml(title) + '</div><div style="color:#444;font-size:15px;line-height:1.5">' + body + '</div></div></body></html>');

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const url = new URL(req.url);
  if (req.method === 'GET') {
    const u = url.searchParams.get('u');
    if (!u) return json({ ok: true, service: 'automation' });
    const email = await unsubEmail(u);
    if (!email) return page('This link is not valid', 'The unsubscribe link is incomplete or expired. Reply to any of our emails with the word UNSUBSCRIBE instead.');
    await db.from('email_opt_outs').upsert({ email, source: 'link' }, { onConflict: 'email' });
    return page('You have been unsubscribed', escHtml(email) + ' will not receive any more emails from MaxSave Insurance. If this was a mistake, reply to one of our earlier emails and we will add you back.');
  }
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (url.searchParams.has('k')) {
    if (!hasSecret(req)) return json({ error: 'bad secret' }, 401);
    try { return json(await tick(url.searchParams.get('force') === '1')); }
    catch (e) { console.error('[automation] tick', e); return json({ error: (e as Error).message }, 500); }
  }
  const raw = await req.text();
  try {
    const profile = await requireUser(req);
    let body: any; try { body = JSON.parse(raw || '{}'); } catch { throw new HttpError(400, 'Bad request'); }
    if (body.action === 'email') {
      if (body.lead_id) {
        const { data: L } = await db.from('leads').select('id, agent_id, do_not_call').eq('id', body.lead_id).maybeSingle();
        if (!L) throw new HttpError(404, 'Lead not found');
        if (profile.role !== 'admin' && L.agent_id && L.agent_id !== profile.id && !(profile.perms || {}).viewAll) throw new HttpError(403, 'This lead belongs to another agent');
      }
      return json(await sendEmail({ to: body.to, toName: body.to_name, subject: body.subject, body: body.body, agent_id: profile.id, lead_id: body.lead_id || null, customer_id: body.customer_id || null, source: 'manual' }));
    }
    if (body.action === 'run') { if (profile.role !== 'admin') throw new HttpError(403, 'Admins only'); return json(await tick(body.force === true)); }
    if (body.action === 'status') return json(await actionStatus(profile));
    if (body.action === 'test_email') {
      if (profile.role !== 'admin') throw new HttpError(403, 'Admins only');
      const to = validEmail(body.to) ? body.to : profile.email;
      if (!validEmail(to)) throw new HttpError(400, 'No email address to send the test to');
      return json(await sendEmail({ to, toName: profile.full_name, subject: 'MaxSaveHub test email', body: 'This is a test email from MaxSaveHub. If you can read this, email sending works.', agent_id: profile.id, source: 'manual' }));
    }
    throw new HttpError(400, 'Unknown action');
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error('[automation]', e);
    return json({ error: 'Something went wrong on the server' }, 500);
  }
});
