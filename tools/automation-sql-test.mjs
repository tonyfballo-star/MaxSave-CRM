// Runs supabase/schema-v6-automation.sql inside PGlite (Postgres in WASM) with stand-ins for the tables
// schema.sql..v5 already provide, then walks a lead, a sale and a policy through the sequence engine.
// Usage: node tools/automation-sql-test.mjs      (PGLITE=<path to @electric-sql/pglite> to override the location)
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const PGLITE = process.env.PGLITE || 'C:/Users/Tony Ballo/fulfillment-ims/node_modules/@electric-sql/pglite';
const { PGlite } = await import(pathToFileURL(path.join(PGLITE, 'dist/index.js')).href);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = readFileSync(path.join(root, 'supabase/schema-v6-automation.sql'), 'utf8');

const db = new PGlite();
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name, extra === undefined ? '' : JSON.stringify(extra)); } };
const one = async (q, params) => (await db.query(q, params)).rows[0];
const all = async (q, params) => (await db.query(q, params)).rows;

await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create schema auth; create function auth.uid() returns uuid language sql stable as $$ select '00000000-0000-0000-0000-000000000001'::uuid $$;
  create table public.profiles (id uuid primary key default gen_random_uuid(), full_name text, phone text, telnyx_number text, role text not null default 'agent', active boolean not null default true);
  create function public.is_admin() returns boolean language sql stable as $$ select true $$;
  create function public.is_active_user() returns boolean language sql stable as $$ select true $$;
  create function public.touch_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
  create table public.leads (
    id uuid primary key default gen_random_uuid(), first_name text not null default '', last_name text not null default '', phone text, email text,
    status text not null default 'New Lead', disposition text, policy_type text not null default 'Auto', source text,
    agent_id uuid references public.profiles(id) on delete set null, received_at timestamptz not null default now(), fee numeric(10,2) not null default 0,
    sr22 boolean not null default false, language text not null default 'English', prior_coverage text, best_time text, lead_score int,
    do_not_call boolean not null default false, details jsonb not null default '{}'::jsonb, created_by uuid,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now());
  create trigger leads_touch before update on public.leads for each row execute function public.touch_updated_at();
  create table public.customers (id uuid primary key default gen_random_uuid(), lead_id uuid, first_name text default '', last_name text default '', phone text, email text, dob date,
    status text not null default 'Active', agent_id uuid, created_at timestamptz default now(), updated_at timestamptz default now());
  create table public.sales (id uuid primary key default gen_random_uuid(), sale_date date default current_date, agent_id uuid, lead_id uuid, customer_id uuid, carrier text, policy_type text,
    fee_extended numeric(10,2) default 0, created_at timestamptz default now());
  create table public.policies (id uuid primary key default gen_random_uuid(), customer_id uuid not null, sale_id uuid, line text default 'Auto', carrier text, policy_number text, sold_by_id uuid,
    effective_date date, expires_date date, premium numeric(10,2) default 0, fee_extended numeric(10,2) default 0, hcc_collected boolean default false, status text default 'Active',
    created_at timestamptz default now(), updated_at timestamptz default now());
  create table public.tasks (id bigint generated always as identity primary key, label text, icon text, priority text, due_date date, due_time text, assigned_to uuid, assigned_label text,
    lead_id uuid, customer_id uuid, notes text, done boolean default false, created_by uuid, created_at timestamptz default now());
  create table public.messages (id uuid primary key default gen_random_uuid(), agent_id uuid, lead_id uuid, customer_id uuid, contact_name text, phone text, direction text default 'outbound', body text, status text, created_at timestamptz default now());
  create table public.call_log (id uuid primary key default gen_random_uuid(), agent_id uuid, lead_id uuid, customer_id uuid, phone text, direction text, missed boolean default false, duration_sec int default 0, status text, created_at timestamptz default now());
  create table public.notes (id uuid primary key default gen_random_uuid(), lead_id uuid, customer_id uuid, body text, created_at timestamptz default now());
  create table public.agency_settings (key text primary key, value jsonb, updated_by uuid, updated_at timestamptz default now());
  create table public.sms_opt_outs (phone text primary key, keyword text, created_at timestamptz default now());
`);

console.log('1. schema applies cleanly (twice: it must be re-runnable)');
try { await db.exec(sql); await db.exec(sql); ok('schema-v6-automation.sql executed twice', true); }
catch (e) { ok('schema-v6-automation.sql executed', false, e.message); console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }

const RULES = [
  { id: 1, name: 'New Lead Follow-Up', triggerLabel: 'Lead is created', active: true, steps: [
    { day: 1, time: 'Right away', action: 'Send Text', message: 'Hi {{name}}, this is {{agent}} from MaxSave.' },
    { day: 1, time: '9:00 AM', action: 'Create Task', message: 'Call {{full_name}}' },
    { day: 2, time: '10:00 AM', action: 'Send Email', subject: 'Your quote, {{name}}', message: 'Hello {{name}}' },
    { day: 5, time: '2:00 PM', action: 'Send Text', message: 'Last try {{name}}' } ] },
  { id: 2, name: 'Quote Follow-Up', triggerLabel: 'Lead is marked Quoted', active: true, steps: [ { day: 1, time: '10:00 AM', action: 'Send Text', message: 'Quote follow up' } ] },
  { id: 3, name: 'Renewal Reminder', triggerLabel: 'Policy expires in', active: true, steps: [
    { day: 30, time: '9:00 AM', action: 'Send Text', message: 'Renews in 30 days' },
    { day: 7, time: '10:00 AM', action: 'Send Text', message: 'Renews in 7 days ({{expires}}), {{carrier}} {{policy}}' },
    { day: 1, time: '9:00 AM', action: 'Create Task', message: 'Call about renewal' } ] },
  { id: 4, name: 'Extended Fee', triggerLabel: 'Extended fee unpaid for', active: true, steps: [ { day: 7, time: '10:00 AM', action: 'Send Text', message: 'Balance {{amount}} due' } ] },
  { id: 5, name: 'Birthday', triggerLabel: 'On customer birthday', active: true, steps: [ { day: 1, time: '9:00 AM', action: 'Send Text', message: 'Happy birthday {{name}}' } ] },
  { id: 6, name: 'Paused one', triggerLabel: 'Lead is created', active: false, steps: [ { day: 1, time: '9:00 AM', action: 'Send Text', message: 'never' } ] },
  { id: 7, name: 'Aged follow-up', triggerLabel: 'Lead has no contact in', active: true, steps: [ { day: 1, time: '11:00 AM', action: 'Send Text', message: 'Still shopping, {{name}}?' } ] },
  { id: 8, name: 'X-date re-quote', triggerLabel: 'Lead is recycled (X-date)', active: true, steps: [ { day: 1, time: '9:00 AM', action: 'Send Text', message: 'Renewal coming up {{name}}' } ] },
];
await db.query(`insert into agency_settings(key, value) values ('lifecycle_rules', $1::jsonb)`, [JSON.stringify(RULES)]);
const AGENT = '00000000-0000-0000-0000-000000000001';
await db.query(`insert into profiles(id, full_name, phone) values ($1, 'Dellano Soro', '(619) 555-0001')`, [AGENT]);

console.log('2. nothing happens while automation is off');
let L = await one(`insert into leads(first_name, last_name, phone, email, agent_id) values ('Maria', 'Lopez', '(619) 555-0100', 'maria@example.com', $1) returning *`, [AGENT]);
ok('no enrollment while disabled', (await one('select count(*)::int as n from automation_enrollments')).n === 0);
ok('automation_status reports disabled', (await one('select public.automation_status() as s')).s.enabled === false);

console.log('3. switch on; a new lead enrolls in every active "Lead is created" sequence');
await db.query(`insert into agency_settings(key, value) values ('automation', '{"enabled": true, "timezone": "America/Los_Angeles", "business_days": [1,2,3,4,5,6], "start": "08:00", "end": "19:00", "shot_clock_days": 45, "shot_clock_since": "2020-01-01", "xdate_lead_days": 30}'::jsonb)`);
ok('time parser', (await one(`select public.automation_parse_time('9:30 AM')::text as a, public.automation_parse_time('2:00 PM')::text as b, public.automation_parse_time('12:00 PM')::text as c, public.automation_parse_time('12:15 AM')::text as d, public.automation_parse_time('Right away') as e`)).a === '09:30:00'
  && (await one(`select public.automation_parse_time('2:00 PM')::text as b`)).b === '14:00:00' && (await one(`select public.automation_parse_time('12:00 PM')::text as c`)).c === '12:00:00' && (await one(`select public.automation_parse_time('12:15 AM')::text as d`)).d === '00:15:00' && (await one(`select public.automation_parse_time('Right away') as e`)).e === null);
L = await one(`insert into leads(first_name, last_name, phone, email, agent_id, source) values ('James', 'Carter', '619-555-0111', 'jc@example.com', $1, 'Everquote') returning *`, [AGENT]);
let E = await all('select * from automation_enrollments where lead_id = $1 order by id', [L.id]);
ok('one enrollment, in the active rule only (paused rule skipped)', E.length === 1 && E[0].rule_id === 1 && E[0].status === 'active', E.map((e) => [e.rule_id, e.status]));
ok('plan has 4 steps in time order, first is "Right away"', E[0].plan.length === 4 && E[0].plan[0].i === 0 && new Date(E[0].next_run_at) <= new Date(Date.now() + 2 * 86400e3), E[0].plan);
ok('phone digits kept for reply matching', E[0].phone_digits === '6195550111', E[0].phone_digits);
ok('enrollment logged', (await one(`select count(*)::int as n from automation_log where lead_id = $1 and status = 'enrolled'`, [L.id])).n === 1);

console.log('4. the queue hands the step to the edge function with merge fields applied');
const due = (await all('select public.automation_due(10) as d')).map((r) => r.d);
let mine = due.find((d) => d.lead_id === L.id);
ok('one due item for the lead', !!mine && due.filter((d) => d.lead_id === L.id).length === 1, due.length);
ok('merge fields: name, agent, action', mine && mine.action === 'Send Text' && mine.message === 'Hi James, this is Dellano Soro from MaxSave.' && mine.agent_id === AGENT && mine.phone === '619-555-0111' && mine.first_text === true, mine);
ok('claimed rows are not handed out twice', (await all('select public.automation_due(10) as d')).filter((r) => r.d.lead_id === L.id).length === 0);
await db.query(`select public.automation_advance($1, 'sent', 'Text sent', 'Send Text')`, [mine.enrollment_id]);
E = await all('select * from automation_enrollments where lead_id = $1', [L.id]);
ok('advanced to step 2 with the next run time, claim cleared', E[0].step_no === 1 && E[0].next_run_at !== null && E[0].claimed_at === null && E[0].status === 'active', E[0]);
ok('step result logged', (await one(`select count(*)::int as n from automation_log where enrollment_id = $1 and status = 'sent' and action = 'Send Text'`, [mine.enrollment_id])).n === 1);

console.log('5. scheduling respects business hours and business days');
const sched = await one(`select public.automation_due_at('2026-10-03 23:30:00-07'::timestamptz, 1, 'Right away', 'after', null) as a,   -- Saturday night (Sat is a business day here)
                               public.automation_due_at('2026-10-04 10:00:00-07'::timestamptz, 1, '9:00 AM', 'after', null) as b,     -- Sunday 10am, 9am passed -> now -> pushed to Monday 8am
                               public.automation_due_at('2026-10-05 07:00:00-07'::timestamptz, 1, '9:00 AM', 'after', null) as c,     -- Monday 7am -> Monday 9am
                               public.automation_due_at('2026-10-05 07:00:00-07'::timestamptz, 3, '2:00 PM', 'after', null) as d,     -- day 3 -> Wednesday 2pm
                               public.automation_due_at(now(), 30, '9:00 AM', 'before', '2026-12-01'::date) as e`);
const la = (t) => new Date(t).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric', minute: '2-digit', month: 'numeric', day: 'numeric' });
ok('late Saturday "right away" waits for Monday 8:00 AM', la(sched.a) === 'Mon, 10/5, 8:00 AM', la(sched.a));
ok('Sunday start, 9 AM already passed -> Monday 8:00 AM', la(sched.b) === 'Mon, 10/5, 8:00 AM', la(sched.b));
ok('Monday 7 AM start -> Monday 9:00 AM', la(sched.c) === 'Mon, 10/5, 9:00 AM', la(sched.c));
ok('day 3 at 2 PM -> Wednesday 2:00 PM', la(sched.d) === 'Wed, 10/7, 2:00 PM', la(sched.d));
ok('30 days before Dec 1 -> Nov 1 (Sunday) -> Monday Nov 2, 8:00 AM', la(sched.e) === 'Mon, 11/2, 8:00 AM', la(sched.e));
await db.query(`update agency_settings set value = value || '{"business_days_only": false}' where key = 'automation'`);
const s2 = await one(`select public.automation_due_at('2026-10-03 23:30:00-07'::timestamptz, 1, 'Right away', 'after', null) as a`);
ok('with business hours off, "right away" is immediate', new Date(s2.a).getTime() === new Date('2026-10-03T23:30:00-07:00').getTime(), s2.a);
await db.query(`update agency_settings set value = value || '{"business_days_only": true}' where key = 'automation'`);

console.log('6. stop conditions');
await db.query(`insert into messages(lead_id, phone, direction, body) values ($1, '(619) 555-0111', 'inbound', 'yes please call me')`, [L.id]);
E = await all('select * from automation_enrollments where lead_id = $1', [L.id]);
ok('inbound text stops the sequence', E[0].status === 'stopped' && /replied by text/.test(E[0].stop_reason), E[0].stop_reason);
let L2 = await one(`insert into leads(first_name, phone, agent_id) values ('Ana', '(619) 555-0122', $1) returning *`, [AGENT]);
await db.query(`insert into call_log(lead_id, phone, direction, duration_sec, status) values ($1, '(619) 555-0122', 'outbound', 95, 'completed')`, [L2.id]);
ok('an answered call stops it (contact made)', (await one('select status, stop_reason from automation_enrollments where lead_id = $1', [L2.id])).stop_reason === 'contact made by phone');
let L3 = await one(`insert into leads(first_name, phone, agent_id) values ('Bo', '(619) 555-0133', $1) returning *`, [AGENT]);
await db.query(`insert into call_log(lead_id, phone, direction, duration_sec) values ($1, '(619) 555-0133', 'outbound', 0)`, [L3.id]);
ok('a 0-second dial attempt does not stop it', (await one('select status from automation_enrollments where lead_id = $1', [L3.id])).status === 'active');
await db.query(`update leads set status = 'Quoted' where id = $1`, [L3.id]);
E = await all('select * from automation_enrollments where lead_id = $1 order by id', [L3.id]);
ok('stage change stops the New Lead sequence and starts the Quoted one', E.length === 2 && E[0].status === 'stopped' && E[0].stop_reason === 'stage changed to Quoted' && E[1].rule_id === 2 && E[1].status === 'active', E.map((e) => [e.rule_id, e.status, e.stop_reason]));
await db.query(`update leads set status = 'Sold' where id = $1`, [L3.id]);
ok('Sold stops everything and stamps closed_at', (await one('select count(*)::int as n from automation_enrollments where lead_id = $1 and status = $2', [L3.id, 'active'])).n === 0 && (await one('select closed_at from leads where id = $1', [L3.id])).closed_at !== null);
let L4 = await one(`insert into leads(first_name, phone, agent_id) values ('Dee', '(619) 555-0144', $1) returning *`, [AGENT]);
await db.query(`update leads set do_not_call = true where id = $1`, [L4.id]);
ok('Do Not Call stops it', (await one('select stop_reason from automation_enrollments where lead_id = $1', [L4.id])).stop_reason === 'marked Do Not Call');
let L5 = await one(`insert into leads(first_name, phone, status, loss_reason) values ('Eve', '(619) 555-0155', 'Bad Lead', 'Bad number') returning *`);
ok('a lead that starts as Bad Lead is not enrolled, closed_at set', (await one('select count(*)::int as n from automation_enrollments where lead_id = $1', [L5.id])).n === 0 && L5.closed_at !== null);
await db.query(`update leads set status = 'New Lead' where id = $1`, [L5.id]);
const L5b = await one('select * from leads where id = $1', [L5.id]);
ok('reopening clears closed_at and the loss reason', L5b.closed_at === null && L5b.loss_reason === null, L5b);

console.log('7. manual enroll / stop from the app');
const mid = (await one('select public.automation_enroll_manual(6, $1, null) as id', [L5.id])).id;
ok('manual enroll works even for a paused sequence', mid !== null && (await one('select rule_id, status from automation_enrollments where id = $1', [mid])).rule_id === 6);
let dupErr = null; try { await one('select public.automation_enroll_manual(6, $1, null)', [L5.id]); } catch (e) { dupErr = e.message; }
ok('enrolling twice is refused', /Already running/.test(dupErr || ''), dupErr);
ok('manual stop', (await one('select public.automation_stop_manual($1) as r', [mid])).r === true && (await one('select status, stop_reason from automation_enrollments where id = $1', [mid])).stop_reason.startsWith('stopped by'));

console.log('8. sales with an extended fee, policies, renewals, birthdays (daily job)');
const C = await one(`insert into customers(first_name, last_name, phone, email, dob, agent_id) values ('Sam', 'Customer', '(619) 555-0200', 'sam@example.com', current_date - interval '30 years', $1) returning *`, [AGENT]);
const S = await one(`insert into sales(customer_id, agent_id, carrier, policy_type, fee_extended) values ($1, $2, 'Progressive', 'Auto', 150) returning *`, [C.id, AGENT]);
E = await all('select * from automation_enrollments where customer_id = $1 and sale_id = $2', [C.id, S.id]);
ok('sale with extended fee enrolls the customer', E.length === 1 && E[0].rule_id === 4, E.length);
const P = await one(`insert into policies(customer_id, sale_id, line, carrier, policy_number, sold_by_id, effective_date, expires_date, fee_extended) values ($1, $2, 'Auto', 'Progressive', 'PRG-9', $3, current_date, current_date + 20, 150) returning *`, [C.id, S.id, AGENT]);
await db.query(`update policies set hcc_collected = true where id = $1`, [P.id]);
ok('collecting the fee stops the fee sequence', (await one('select stop_reason from automation_enrollments where id = $1', [E[0].id])).stop_reason === 'extended fee collected');
let d = (await one('select public.automation_daily(true) as r')).r;
ok('daily: renewal enrolled for a policy expiring in 20 days', d.renewals === 1 && d.birthdays === 1, d);
E = await all('select * from automation_enrollments where policy_id = $1', [P.id]);
ok('renewal plan skips the 30-day step already in the past, keeps 7-day and 1-day', E.length === 1 && E[0].plan.length === 2 && E[0].plan[0].i === 1 && E[0].plan[1].i === 2 && new Date(E[0].anchor_date).getTime() === new Date(P.expires_date).getTime(), E[0] && E[0].plan);
d = (await one('select public.automation_daily(false) as r')).r;
ok('daily is idempotent per day', d.skipped === 'already ran today', d);
d = (await one('select public.automation_daily(true) as r')).r;
ok('forcing it again does not double-enroll', d.renewals === 0 && d.birthdays === 0, d);
await db.query(`update automation_enrollments set next_run_at = now() - interval '1 minute' where policy_id = $1`, [P.id]);
const rdue = (await all('select public.automation_due(10) as d')).map((r) => r.d).find((x) => x.policy_id === P.id);
ok('renewal merge fields: carrier, policy, expiration', rdue && /Progressive Auto/.test(rdue.message) && rdue.message.includes(new Date(P.expires_date).toLocaleDateString('en-US', { timeZone: 'UTC', month: '2-digit', day: '2-digit', year: 'numeric' })), rdue && rdue.message);
await db.query(`update policies set status = 'Cancelled' where id = $1`, [P.id]);
ok('cancelling the policy stops its renewal sequence', (await one('select status from automation_enrollments where policy_id = $1', [P.id])).status === 'stopped');

console.log('9. shot clock and X-date recycling');
const old = await one(`insert into leads(first_name, last_name, phone, agent_id, received_at) values ('Old', 'Lead', '(619) 555-0300', $1, now() - interval '60 days') returning *`, [AGENT]);
await db.query(`update leads set updated_at = now() - interval '60 days' where id = $1`, [old.id]);
await db.query(`alter table leads disable trigger leads_touch`); await db.query(`update leads set updated_at = now() - interval '60 days' where id = $1`, [old.id]); await db.query(`alter table leads enable trigger leads_touch`);
const fresh = await one(`insert into leads(first_name, phone, agent_id, received_at) values ('Fresh', '(619) 555-0301', $1, now() - interval '60 days') returning *`, [AGENT]);
await db.query(`insert into notes(lead_id, body) values ($1, 'spoke yesterday')`, [fresh.id]);
await db.query(`alter table leads disable trigger leads_touch`); await db.query(`update leads set updated_at = now() - interval '60 days' where id = $1`, [fresh.id]); await db.query(`alter table leads enable trigger leads_touch`);
d = (await one('select public.automation_daily(true) as r')).r;
const aged = await one('select * from leads where id = $1', [old.id]);
ok('inactive 60-day lead is tagged Aged with Follow Up and an estimated X-date', d.aged === 1 && aged.tags.includes('Aged') && aged.disposition === 'Follow Up' && aged.x_date !== null && aged.details.x_date_estimated === true, [d, aged.tags, aged.disposition, aged.x_date]);
ok('lead with a recent note is left alone', !(await one('select tags from leads where id = $1', [fresh.id])).tags.includes('Aged'));
ok('aged lead enrolled in the "no contact" sequence', (await one(`select count(*)::int as n from automation_enrollments where lead_id = $1 and rule_id = 7 and status = 'active'`, [old.id])).n === 1);
await db.query(`update leads set x_date = current_date + 10 where id = $1`, [old.id]);
d = (await one('select public.automation_daily(true) as r')).r;
const rec = await one('select * from leads where id = $1', [old.id]);
ok('X-date within 30 days: recycled to New Lead with X-Date tag, next x_date pushed a term ahead', d.recycled === 1 && rec.status === 'New Lead' && rec.tags.includes('X-Date') && !rec.tags.includes('Aged') && rec.recycled_at !== null && rec.disposition === null && new Date(rec.x_date) > new Date(), [d, rec.tags, rec.status, rec.x_date]);
ok('a call task was created for the agent', (await one(`select count(*)::int as n from tasks where lead_id = $1 and source = 'automation' and label like 'X-date:%'`, [old.id])).n === 1);
ok('recycled lead enrolled in the X-date sequence; aged sequence stopped', (await one(`select count(*)::int as n from automation_enrollments where lead_id = $1 and rule_id = 8 and status = 'active'`, [old.id])).n === 1 && (await one(`select status from automation_enrollments where lead_id = $1 and rule_id = 7`, [old.id])).status === 'stopped');
d = (await one('select public.automation_daily(true) as r')).r;
ok('not recycled twice', d.recycled === 0, d);

console.log('10. opt-outs are reported to the sender');
const L6 = await one(`insert into leads(first_name, phone, email, agent_id) values ('Opt', '(619) 555-0400', 'opt@example.com', $1) returning *`, [AGENT]);
await db.query(`insert into sms_opt_outs(phone) values ('+16195550400')`); await db.query(`insert into email_opt_outs(email) values ('OPT@example.com')`);
const odue = (await all('select public.automation_due(20) as d')).map((r) => r.d).find((x) => x.lead_id === L6.id);
ok('sms + email opt-out flags set', odue && odue.sms_opted_out === true && odue.email_opted_out === true, odue);
const st = (await one('select public.automation_status() as s')).s;
ok('status counts', st.enabled === true && st.active >= 1 && typeof st.sent_today === 'number' && st.state.last_daily, st);

console.log('11. a sequence deleted from Settings stops its runs gracefully');
await db.query(`update agency_settings set value = (select jsonb_agg(x) from jsonb_array_elements(value) x where (x->>'id')::int <> 8) where key = 'lifecycle_rules'`);
await db.query(`update automation_enrollments set next_run_at = now() - interval '1 minute', claimed_at = null where lead_id = $1 and rule_id = 8`, [old.id]);
const gone = (await all('select public.automation_due(20) as d')).map((r) => r.d).find((x) => x.lead_id === old.id && x.rule_id === 8);
ok('removed sequence is not sent and its run is stopped', !gone && (await one('select stop_reason from automation_enrollments where lead_id = $1 and rule_id = 8', [old.id])).stop_reason === 'sequence removed or paused');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
