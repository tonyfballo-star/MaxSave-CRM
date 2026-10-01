// Runs supabase/schema-v5-intake.sql inside PGlite (Postgres in WASM) with stand-in tables and exercises the
// vendor intake endpoints with several payload shapes. No network, no real database.
// Usage: node tools/intake-sql-test.mjs      (PGLITE=<path to @electric-sql/pglite> to override the location)
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const PGLITE = process.env.PGLITE || 'C:/Users/Tony Ballo/fulfillment-ims/node_modules/@electric-sql/pglite';
const { PGlite } = await import(pathToFileURL(path.join(PGLITE, 'dist/index.js')).href);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpl = readFileSync(path.join(root, 'supabase/schema-v5-intake.sql'), 'utf8');
const sql = tmpl.split('__EQ_SECRET__').join('eqtest').split('__MA_SECRET__').join('matest').split('__ST_SECRET__').join('sttest');

const db = new PGlite();
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name, extra === undefined ? '' : JSON.stringify(extra)); } };
const one = async (q, params) => (await db.query(q, params)).rows[0];

// Stand-ins for what Supabase and schema.sql already provide.
await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create schema auth; create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
  create table public.profiles (id uuid primary key default gen_random_uuid(), role text not null default 'agent', active boolean not null default true);
  create function public.is_admin() returns boolean language sql stable as $$ select false $$;
  create table public.leads (
    id uuid primary key default gen_random_uuid(), first_name text not null default '', last_name text not null default '', phone text, email text,
    status text not null default 'New Lead', disposition text, policy_type text not null default 'Auto', source text,
    agent_id uuid references public.profiles(id) on delete set null, received_at timestamptz not null default now(), fee numeric(10,2) not null default 0,
    sr22 boolean not null default false, language text not null default 'English', prior_coverage text, best_time text, lead_score int,
    do_not_call boolean not null default false, details jsonb not null default '{}'::jsonb, created_by uuid references public.profiles(id) on delete set null,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now());
`);

console.log('1. schema applies cleanly (twice: it must be re-runnable)');
try { await db.exec(sql); await db.exec(sql); ok('schema-v5-intake.sql executed twice', true); } catch (e) { ok('schema-v5-intake.sql executed', false, e.message); console.log(`\n${pass} passed, ${fail} failed`); process.exit(1); }

const hook = async (fn, payload) => (await one(`select public.${fn}($1::jsonb) as r`, [JSON.stringify(payload)])).r;

console.log('2. flat snake_case payload');
let r = await hook('hook_eq_eqtest', { lead_id: 'EQ-1001', first_name: 'maria', last_name: 'GONZALEZ', phone: '+1 (619) 555-0110', email: 'Maria@Example.com', address: '12 Main St', city: 'San Diego', state: 'CA', zip: '92101', dob: '1988-04-02', current_carrier: 'Geico', vehicle_year: 2020, vehicle_make: 'Honda', vehicle_model: 'Civic' });
ok('returns ok + lead_id', r.ok === true && !!r.lead_id, r);
let L = await one('select * from leads where id = $1', [r.lead_id]);
ok('name title-cased', L.first_name === 'Maria' && L.last_name === 'Gonzalez', [L.first_name, L.last_name]);
ok('phone formatted like the rest of the CRM', L.phone === '(619) 555-0110', L.phone);
ok('email lower-cased', L.email === 'maria@example.com', L.email);
ok('source / status / type', L.source === 'Everquote' && L.status === 'New Lead' && L.policy_type === 'Auto' && L.agent_id === null);
ok('details: address, vehicle, vendor id', L.details.city === 'San Diego' && L.details.vehicle.make === 'Honda' && L.details.vehicle.year === '2020' && L.details.vendor_lead_id === 'EQ-1001' && L.details.vendor === 'everquote', L.details);
ok('prior coverage', L.prior_coverage === 'Geico', L.prior_coverage);

console.log('3. nested camelCase payload with arrays');
r = await hook('hook_eq_eqtest', { leadId: 'EQ-1002', contact: { firstName: 'James', lastName: 'Carter', phoneNumber: '6195550111', emailAddress: 'jc@example.com', address: { street: '9 Oak Ave', city: 'Chula Vista', state: 'CA', zipCode: '91910' } }, drivers: [{ firstName: 'WrongDriverName', dateOfBirth: '1990-01-05', gender: 'M', maritalStatus: 'Single' }], vehicles: [{ year: 2018, make: 'Toyota', model: 'Camry', vin: '4T1B11HK5JU000001' }], insurance: { currentInsurer: 'Progressive', currentlyInsured: true } });
L = await one('select * from leads where id = $1', [r.lead_id]);
ok('nested contact mapped', r.ok && L.first_name === 'James' && L.last_name === 'Carter' && L.phone === '(619) 555-0111', [r, L && L.first_name, L && L.phone]);
ok('nested address + vehicle + driver fields', L.details.zip === '91910' && L.details.vehicle.vin === '4T1B11HK5JU000001' && L.details.dob === '1990-01-05' && L.details.current_carrier === 'Progressive', L.details);

console.log('4. duplicates');
r = await hook('hook_eq_eqtest', { lead_id: 'EQ-1001', first_name: 'Maria', phone: '6195550110' });
ok('same vendor lead id → duplicate, no new row', r.ok && r.duplicate === true, r);
r = await hook('hook_eq_eqtest', { first_name: 'Maria', last_name: 'Again', phone: '619-555-0110' });
ok('same phone within 12h, same vendor → duplicate', r.ok && r.duplicate === true, r);
r = await hook('hook_ma_matest', { first_name: 'Maria', last_name: 'Gonzalez', phone: '619-555-0110' });
ok('same phone from the OTHER vendor is a new lead', r.ok && !r.duplicate && !!r.lead_id, r);
ok('that lead is tagged MediaAlpha', (await one('select source from leads where id = $1', [r.lead_id])).source === 'MediaAlpha');

console.log('5. bad input never raises');
r = await hook('hook_eq_eqtest', { hello: 'world' });
ok('unmappable payload → ok:false with reason', r.ok === false && /no name, phone or email/.test(r.error), r);
r = await hook('hook_eq_eqtest', []);
ok('empty array → ok:false, no exception', r.ok === false, r);
r = await hook('hook_eq_eqtest', { Name: 'Solo Person', Phone: '(858) 555-0199' });
ok('full "Name" field split into first/last', r.ok && (await one('select first_name, last_name from leads where id = $1', [r.lead_id])).last_name === 'Person', r);

console.log('6. bookkeeping');
const counts = Object.fromEntries((await db.query('select status, count(*)::int n from lead_intake group by 1')).rows.map((x) => [x.status, x.n]));
ok('every call logged in lead_intake', counts.inserted === 4 && counts.duplicate === 2 && counts.error === 2, counts);
ok('leads table has exactly the 4 real leads', (await one('select count(*)::int n from leads')).n === 4);
const st = (await one('select public.hook_status_sttest() as r')).r;
ok('status: totals + per-vendor counts', st.total === 8 && st.last_24h['everquote:inserted'] === 3 && st.last_24h['mediaalpha:inserted'] === 1, st.last_24h);
ok('status: shape shows types only, never values', JSON.stringify(st.latest_shape).includes('"string"') && !/Maria|555|Solo/.test(JSON.stringify(st)), st.latest_shape);

console.log('7. permissions');
const priv = async (role, sig) => (await one('select has_function_privilege($1, $2, $3) as p', [role, sig, 'execute'])).p;
ok('anon may call the EverQuote hook', await priv('anon', 'public.hook_eq_eqtest(jsonb)'));
ok('anon may call the MediaAlpha hook', await priv('anon', 'public.hook_ma_matest(jsonb)'));
ok('anon may call the status hook', await priv('anon', 'public.hook_status_sttest()'));
ok('anon may NOT call intake_lead directly', !(await priv('anon', 'public.intake_lead(text,text,jsonb)')));
ok('anon may NOT call intake_flat / intake_shape', !(await priv('anon', 'public.intake_flat(jsonb,integer)')) && !(await priv('anon', 'public.intake_shape(jsonb,integer)')));
ok('row security is on for lead_intake', (await one("select relrowsecurity as r from pg_class where relname = 'lead_intake'")).r === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
