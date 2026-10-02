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
ok('nested address + vehicle + driver fields', L.details.zip === '91910' && L.details.vehicle.vin === '4T1B11HK5JU000001' && L.details.dob === '01/05/1990' && L.details.current_carrier === 'Progressive', L.details);

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

console.log('5b. real EverQuote webhook structure');
const EQ = { lead: { contact: { firstName: 'dana', lastName: 'whitfield', primaryPhone: '6195550177', email: 'Dana.W@Example.com', addressLine1: '77 Palm Ave', city: 'El Cajon', state: 'CA', zipCode: '92020' },
    eqLeadId: 'EQL-778899', products: 'auto', AAAMember: 'No', deviceType: 'mobile', traffic_tier: 'A', militaryService: 'No', everquote_source_id: 'src-1',
    customAttributes: { url: 'https://example.invalid/hook', data_format: 'JSON' },
    autoInsurance: {
      drivers: [{ driverId: 1, firstName: 'dana', lastName: 'whitfield', gender: 'Female', dateOfBirth: '1985-07-19', maritalStatus: 'Married', licenseStatus: 'Valid', occupation: 'Nurse', educationLevel: 'Bachelors', sr22Required: 'No', licenseObtainedAge: 16, relationshipToContact: 'Self', licenseEverSuspendedOrRevoked: 'No' },
                { driverId: 2, firstName: 'omar', lastName: 'whitfield', gender: 'Male', dateOfBirth: '1983-02-03', maritalStatus: 'Married', licenseStatus: 'Valid', occupation: 'Driver', sr22Required: 'Yes', relationshipToContact: 'Spouse', licenseEverSuspendedOrRevoked: 'Yes' }],
      vehicles: [{ vehicleId: 1, year: '2019', make: 'TOYOTA', model: 'Camry', submodel: 'SE', vin: '4T1B11HK5KU000001', ownership: 'Financed', garageType: 'Garage', garageZipCode: '92020', vehicleType: 'Sedan', oneWayDistance: 12, primaryUse: 'Commute', annualMileage: 12000, coveragePackage: 'Standard', primaryDriverId: 1 },
                 { vehicleId: 2, year: '2015', make: 'HONDA', model: 'CR-V', vin: '2HKRM3H50FH000002', ownership: 'Owned', primaryUse: 'Pleasure', annualMileage: 6000, coveragePackage: 'Standard', primaryDriverId: 2 }],
      customerProfile: { gender: 'Female', dateOfBirth: '1985-07-19', maritalStatus: 'Married', credit: { rating: 'Good', bankruptcy: 'No' }, residence: { own: 'Own', years: 4 } } } },
  consent: { universal_lead_id: 'ULID-ABC-123', tcpa_disclosure_text: 'By clicking…', trusted_form_cert_url: 'https://cert.trustedform.com/abc' },
  leadSource: { name: 'EverQuote', version: '1' } };
r = await hook('hook_eq_eqtest', EQ);
L = await one('select * from leads where id = $1', [r.lead_id]);
ok('contact mapped (contact wins over driver names)', r.ok && L.first_name === 'Dana' && L.last_name === 'Whitfield' && L.phone === '(619) 555-0177' && L.email === 'dana.w@example.com', [r, L && L.first_name, L && L.phone]);
ok('vendor id is the EverQuote lead id, not the consent token', L.details.vendor_lead_id === 'EQL-778899', L.details.vendor_lead_id);
ok('address', L.details.address === '77 Palm Ave' && L.details.city === 'El Cajon' && L.details.zip === '92020', L.details);
ok('both vehicles, year as a number, make title-cased', L.details.vehicles.length === 2 && L.details.vehicles[0].year === 2019 && L.details.vehicles[0].make === 'Toyota' && L.details.vehicles[0].trim === 'SE' && L.details.vehicles[1].model === 'CR-V' && L.details.vehicles[0].mileage === '12000 mi/yr', L.details.vehicles);
ok('first vehicle summarised for the profile header', L.details.vehicle.year === 2019 && L.details.vehicle.vin === '4T1B11HK5KU000001' && L.details.vehicle.use === 'Commute', L.details.vehicle);
ok('both drivers with DOB in MM/DD/YYYY', L.details.drivers.length === 2 && L.details.drivers[0].name === 'Dana Whitfield' && L.details.drivers[0].dob === '07/19/1985' && L.details.drivers[0].primary === true && L.details.drivers[1].relationship === 'Spouse', L.details.drivers);
ok('vehicle specs: body type, commute, garaging ZIP, primary driver per vehicle', L.details.vehicles[0].type === 'Sedan' && L.details.vehicles[0].commute === '12 mi one way' && L.details.vehicles[0].garage_zip === '92020' && L.details.vehicles[0].primary_driver === 'Dana Whitfield' && L.details.vehicles[1].primary_driver === 'Omar Whitfield' && !('commute' in L.details.vehicles[1]), L.details.vehicles);
ok('drivers carry first and last name separately', L.details.drivers[1].first === 'Omar' && L.details.drivers[1].last === 'Whitfield' && L.details.drivers[0].age_licensed === '16', L.details.drivers);
ok('second driver exposed as driver2', L.details.driver2 && L.details.driver2.name === 'Omar Whitfield' && L.details.driver2.violations === 'Suspension', L.details.driver2);
ok('profile fields: dob, gender, marital, license, occupation', L.details.dob === '07/19/1985' && L.details.gender === 'Female' && L.details.marital === 'Married' && L.details.license === 'Valid' && L.details.occupation === 'Nurse', L.details);
ok('coverage, credit, home ownership, residency', L.details.coverage.type === 'Standard' && L.details.credit === 'Good' && L.details.home_ownership === 'Own' && L.details.residency_years === '4', L.details);
ok('SR-22 flag set because one driver needs it', L.sr22 === true, L.sr22);
ok('TCPA consent proof kept', L.details.consent.trusted_form_cert_url === 'https://cert.trustedform.com/abc' && L.details.consent.universal_lead_id === 'ULID-ABC-123', L.details.consent);
ok('webhook config echoed by EverQuote is not mistaken for lead data', !JSON.stringify(L.details).includes('example.invalid'), L.details);
r = await hook('hook_eq_eqtest', EQ);
ok('same EverQuote lead id again → duplicate', r.ok && r.duplicate === true, r);
await db.query("delete from lead_intake where id = (select max(id) from lead_intake)");   // keep the bookkeeping counts below simple

console.log('5c. backfill re-maps leads that arrived under the older, thinner mapping');
await db.query("update leads set details = jsonb_build_object('vendor', 'everquote', 'vendor_lead_id', 'ULID-ABC-123', 'agent_note', 'keep me'), sr22 = false where id = $1", [L.id]);
await db.exec(sql);
L = await one('select * from leads where id = $1', [L.id]);
ok('backfill restored vehicles/drivers and the right vendor id', L.details.vehicles.length === 2 && L.details.drivers.length === 2 && L.details.vendor_lead_id === 'EQL-778899' && L.sr22 === true, L.details);
ok('backfill kept keys it does not own', L.details.agent_note === 'keep me', L.details);

console.log('6. bookkeeping');
const counts = Object.fromEntries((await db.query('select status, count(*)::int n from lead_intake group by 1')).rows.map((x) => [x.status, x.n]));
ok('every call logged in lead_intake', counts.inserted === 5 && counts.duplicate === 2 && counts.error === 2, counts);
ok('leads table has exactly the 5 real leads', (await one('select count(*)::int n from leads')).n === 5);
const st = (await one('select public.hook_status_sttest() as r')).r;
ok('status: totals + per-vendor counts', st.total === 9 && st.last_24h['everquote:inserted'] === 4 && st.last_24h['mediaalpha:inserted'] === 1, st.last_24h);
ok('status: shape shows types only, never values', JSON.stringify(st.latest_shape).includes('"string"') && !/Maria|555|Solo|Dana|4T1B/.test(JSON.stringify(st)), st.latest_shape);

console.log('7. production-sized table: lookups stay indexed and fast');
await db.exec(`
  insert into public.leads (first_name, last_name, phone, source, received_at, details)
  select 'Bulk', 'Lead ' || g, '(619) ' || lpad((g % 900 + 100)::text, 3, '0') || '-' || lpad((g % 10000)::text, 4, '0'),
         case when g % 3 = 0 then 'Everquote' else 'usmg' end, now() - (g || ' minutes')::interval,
         case when g % 2 = 0 then jsonb_build_object('dyl_id', g::text) else '{}'::jsonb end
  from generate_series(1, 150000) g;
  analyze public.leads;
`);
const plan = async (q) => (await db.query('explain ' + q)).rows.map((r) => r['QUERY PLAN']).join(' ');
const p1 = await plan("select id from leads where details ->> 'vendor_lead_id' = 'EQ-1001' and source = 'Everquote' limit 1");
ok('vendor-lead-id lookup uses its index, no full scan', /leads_vendor_lead_id_idx/.test(p1) && !/Seq Scan/.test(p1), p1);
const p2 = await plan("select id from leads where phone = '(619) 555-0110' and source = 'Everquote' and received_at > now() - interval '12 hours' limit 1");
ok('phone lookup uses an index, no full scan', /Index/.test(p2) && !/Seq Scan/.test(p2), p2);
let t0 = Date.now();
r = await hook('hook_eq_eqtest', { lead_id: 'EQ-BIG-1', first_name: 'After', last_name: 'Seeding', phone: '858-555-0142' });
let ms = Date.now() - t0;
ok('new lead on 150k rows inserts quickly (' + ms + ' ms)', r.ok && !!r.lead_id && ms < 1500, [r, ms]);
t0 = Date.now(); r = await hook('hook_eq_eqtest', { lead_id: 'EQ-BIG-1', first_name: 'After', phone: '858-555-0142' }); ms = Date.now() - t0;
ok('duplicate on 150k rows detected quickly (' + ms + ' ms)', r.ok && r.duplicate === true && ms < 1500, [r, ms]);

console.log('8. permissions');
const priv = async (role, sig) => (await one('select has_function_privilege($1, $2, $3) as p', [role, sig, 'execute'])).p;
ok('anon may call the EverQuote hook', await priv('anon', 'public.hook_eq_eqtest(jsonb)'));
ok('anon may call the MediaAlpha hook', await priv('anon', 'public.hook_ma_matest(jsonb)'));
ok('anon may call the status hook', await priv('anon', 'public.hook_status_sttest()'));
ok('anon may NOT call intake_lead directly', !(await priv('anon', 'public.intake_lead(text,text,jsonb)')));
ok('anon may NOT call intake_flat / intake_shape / intake_map', !(await priv('anon', 'public.intake_flat(jsonb,integer)')) && !(await priv('anon', 'public.intake_shape(jsonb,integer)')) && !(await priv('anon', 'public.intake_map(text,jsonb)')));
ok('row security is on for lead_intake', (await one("select relrowsecurity as r from pg_class where relname = 'lead_intake'")).r === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
