-- =====================================================================
--  MSIHub CRM — Supabase schema  (v1, 2026-09-12)
--  Paste this whole file into Supabase > SQL Editor > New query > Run.
--  Safe to re-run: every statement is idempotent.
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- 1. PROFILES  (one row per login; mirrors auth.users)
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text unique,
  full_name   text not null default '',
  role        text not null default 'agent' check (role in ('admin','agent')),
  phone       text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Auto-create a profile whenever a user is invited / signs up.
-- The agency owner's email is bootstrapped as admin.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)),
    case when lower(new.email) = 'tonyfballo@gmail.com' then 'admin' else 'agent' end
  )
  on conflict (id) do update set email = excluded.email;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Helper used by every access rule below.
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin' and active);
$$;

-- Generic updated_at bump
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

-- ---------------------------------------------------------------------
-- 2. LEADS
-- ---------------------------------------------------------------------
create table if not exists public.leads (
  id              uuid primary key default gen_random_uuid(),
  first_name      text not null default '',
  last_name       text not null default '',
  phone           text,
  email           text,
  status          text not null default 'New Lead',   -- New Lead | Contacted | Quoted | Appointment Set | Sold | Bad Lead
  disposition     text,                               -- Quoted, Bad Lead, Do Not Call, Refund, HR, Already Sold, Spanish, Rewrite, Cancelled, Follow Up
  policy_type     text not null default 'Auto',
  source          text,                               -- Everquote, Facebook Ads, Google Ads, Referral, Cold Call, Direct Call
  agent_id        uuid references public.profiles(id) on delete set null,   -- null = Unassigned
  received_at     timestamptz not null default now(),
  fee             numeric(10,2) not null default 0,
  sr22            boolean not null default false,
  language        text not null default 'English',
  prior_coverage  text,
  best_time       text,
  lead_score      int,
  do_not_call     boolean not null default false,
  -- Everything from the profile page that isn't queried/filtered lives here:
  -- gender, dob, address, license_status, marital, lead_type, insured,
  -- requested_coverage, violations, vin, primary_use, vehicle, etc.
  details         jsonb not null default '{}'::jsonb,
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists leads_agent_idx    on public.leads(agent_id);
create index if not exists leads_status_idx   on public.leads(status);
create index if not exists leads_received_idx on public.leads(received_at desc);
create index if not exists leads_phone_idx    on public.leads(phone);
drop trigger if exists leads_touch on public.leads;
create trigger leads_touch before update on public.leads for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- 3. CUSTOMERS  (+ policies, vehicles, drivers, claims)
-- ---------------------------------------------------------------------
create sequence if not exists public.customer_no_seq start 1000;

create table if not exists public.customers (
  id                     uuid primary key default gen_random_uuid(),
  customer_no            text unique not null default ('C-' || to_char(now(),'YYYY') || '-' || lpad(nextval('public.customer_no_seq')::text, 4, '0')),
  lead_id                uuid references public.leads(id) on delete set null,
  first_name             text not null default '',
  last_name              text not null default '',
  phone                  text,
  email                  text,
  dob                    date,
  gender                 text,
  marital                text,
  license                text,
  address                text,
  city                   text,
  state                  text default 'CA',
  zip                    text,
  status                 text not null default 'Active',  -- Active | Pending Cancellation | Cancelled
  agent_id               uuid references public.profiles(id) on delete set null,   -- account agent
  sold_by_id             uuid references public.profiles(id) on delete set null,
  customer_since         date not null default current_date,
  language               text not null default 'English',
  comm_pref              text,
  preferred_contact_time text,
  payment_method         text,
  autopay                boolean not null default false,
  paperless              boolean not null default false,
  risk_score             int,
  sr22                   boolean not null default false,
  claims_last_5yr        int not null default 0,
  tickets_last_3yr       int not null default 0,
  referred_by            text,
  referrals_given        int not null default 0,
  cross_sell             text[] not null default '{}',
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index if not exists customers_agent_idx  on public.customers(agent_id);
create index if not exists customers_status_idx on public.customers(status);
create index if not exists customers_phone_idx  on public.customers(phone);
create index if not exists customers_name_idx   on public.customers(last_name, first_name);
drop trigger if exists customers_touch on public.customers;
create trigger customers_touch before update on public.customers for each row execute function public.touch_updated_at();

create table if not exists public.sales (
  id                  uuid primary key default gen_random_uuid(),
  sale_date           date not null default current_date,
  agent_id            uuid references public.profiles(id) on delete set null,
  lead_id             uuid references public.leads(id) on delete set null,
  customer_id         uuid references public.customers(id) on delete set null,
  carrier             text,
  policy_type         text,
  policy_number       text,
  fee_total           numeric(10,2) not null default 0,
  fee_collected       numeric(10,2) not null default 0,
  fee_extended        numeric(10,2) not null default 0,
  premium             numeric(10,2) not null default 0,
  towing_premium      numeric(10,2) not null default 0,
  effective_date      date,
  additional_policies jsonb not null default '[]'::jsonb,
  total_policies      int not null default 1,
  created_at          timestamptz not null default now()
);
create index if not exists sales_date_idx  on public.sales(sale_date desc);
create index if not exists sales_agent_idx on public.sales(agent_id);

create table if not exists public.policies (
  id             uuid primary key default gen_random_uuid(),
  customer_id    uuid not null references public.customers(id) on delete cascade,
  sale_id        uuid references public.sales(id) on delete set null,
  line           text not null default 'Auto',
  carrier        text,
  policy_number  text,
  sold_by_id     uuid references public.profiles(id) on delete set null,
  effective_date date,
  expires_date   date,
  premium        numeric(10,2) not null default 0,
  towing_premium numeric(10,2) not null default 0,
  fee_total      numeric(10,2) not null default 0,
  fee_collected  numeric(10,2) not null default 0,
  fee_extended   numeric(10,2) not null default 0,
  hcc_collected  boolean not null default false,
  status         text not null default 'Active',   -- Active | Cancelled | Pending Cancellation
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists policies_customer_idx on public.policies(customer_id);
create index if not exists policies_expires_idx  on public.policies(expires_date);
create index if not exists policies_number_idx   on public.policies(policy_number);
drop trigger if exists policies_touch on public.policies;
create trigger policies_touch before update on public.policies for each row execute function public.touch_updated_at();

create table if not exists public.vehicles (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  year        int,
  make        text,
  model       text,
  vin         text,
  use         text,
  garaging    text,
  value       numeric(12,2),
  lien        text,
  created_at  timestamptz not null default now()
);
create index if not exists vehicles_customer_idx on public.vehicles(customer_id);

create table if not exists public.drivers (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  name        text not null,
  dob         date,
  gender      text,
  license     text,
  violations  text,
  is_primary  boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists drivers_customer_idx on public.drivers(customer_id);

create table if not exists public.claims (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  claim_date  date,
  type        text,
  amount      numeric(12,2),
  status      text,
  description text,
  created_at  timestamptz not null default now()
);
create index if not exists claims_customer_idx on public.claims(customer_id);

-- ---------------------------------------------------------------------
-- 4. ACTIVITY  (quotes, appointments, notes, calls, texts, files)
-- ---------------------------------------------------------------------
create table if not exists public.quotes (
  id             uuid primary key default gen_random_uuid(),
  lead_id        uuid references public.leads(id) on delete cascade,
  customer_id    uuid references public.customers(id) on delete cascade,
  agent_id       uuid references public.profiles(id) on delete set null,
  carrier        text,
  premium        numeric(10,2),
  deductible     numeric(10,2),
  down_payment   numeric(10,2),
  fee            numeric(10,2),
  coverage_notes text,
  created_at     timestamptz not null default now()
);
create index if not exists quotes_lead_idx on public.quotes(lead_id);

create table if not exists public.appointments (
  id             uuid primary key default gen_random_uuid(),
  starts_at      timestamptz not null,
  duration_min   int not null default 30,
  lead_id        uuid references public.leads(id) on delete set null,
  customer_id    uuid references public.customers(id) on delete set null,
  contact_name   text,
  phone          text,
  agent_id       uuid references public.profiles(id) on delete set null,
  status         text not null default 'New',   -- New | Confirmed | Quoted | Appointment Set | No-Show | Sold | Cancelled
  type           text,                          -- Initial Call, Quote Review, Sale Close, Follow-Up, Renewal, ...
  notes          text,
  sold           boolean not null default false,
  quoted_carrier text,
  quoted_premium numeric(10,2),
  quoted_fee     numeric(10,2),
  quoted_down    numeric(10,2),
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists appointments_start_idx on public.appointments(starts_at);
create index if not exists appointments_agent_idx on public.appointments(agent_id);
drop trigger if exists appointments_touch on public.appointments;
create trigger appointments_touch before update on public.appointments for each row execute function public.touch_updated_at();

create table if not exists public.notes (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid references public.leads(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete cascade,
  author_id   uuid references public.profiles(id) on delete set null,
  body        text not null,
  created_at  timestamptz not null default now()
);
create index if not exists notes_lead_idx     on public.notes(lead_id);
create index if not exists notes_customer_idx on public.notes(customer_id);

create table if not exists public.call_log (
  id           uuid primary key default gen_random_uuid(),
  agent_id     uuid references public.profiles(id) on delete set null,
  lead_id      uuid references public.leads(id) on delete set null,
  customer_id  uuid references public.customers(id) on delete set null,
  contact_name text,
  phone        text,
  direction    text not null default 'outbound' check (direction in ('inbound','outbound')),
  missed       boolean not null default false,
  duration_sec int not null default 0,
  created_at   timestamptz not null default now()
);
create index if not exists call_log_agent_idx   on public.call_log(agent_id, created_at desc);
create index if not exists call_log_created_idx on public.call_log(created_at desc);

create table if not exists public.messages (
  id           uuid primary key default gen_random_uuid(),
  agent_id     uuid references public.profiles(id) on delete set null,
  lead_id      uuid references public.leads(id) on delete set null,
  customer_id  uuid references public.customers(id) on delete set null,
  contact_name text,
  phone        text not null,
  direction    text not null default 'outbound' check (direction in ('inbound','outbound')),
  body         text not null,
  status       text not null default 'sent',   -- queued | sent | delivered | failed | received
  provider_sid text,                           -- Twilio message id (later)
  created_at   timestamptz not null default now()
);
create index if not exists messages_phone_idx   on public.messages(phone, created_at);
create index if not exists messages_agent_idx   on public.messages(agent_id, created_at desc);
create index if not exists messages_created_idx on public.messages(created_at desc);

create table if not exists public.templates (
  id         uuid primary key default gen_random_uuid(),
  emoji      text default '💬',
  name       text not null,
  body       text not null,
  sort_order int not null default 100,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.files (
  id           uuid primary key default gen_random_uuid(),
  lead_id      uuid references public.leads(id) on delete cascade,
  customer_id  uuid references public.customers(id) on delete cascade,
  storage_path text not null,        -- path inside the 'files' bucket
  filename     text not null,
  size_bytes   bigint,
  mime_type    text,
  uploaded_by  uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists files_lead_idx     on public.files(lead_id);
create index if not exists files_customer_idx on public.files(customer_id);

-- ---------------------------------------------------------------------
-- 5. ROW LEVEL SECURITY
--    Rules: any signed-in, active user can read agency data.
--           Leads: agents see their own + unassigned; admins see all.
--           Anyone signed-in can insert/update; only admins can delete.
-- ---------------------------------------------------------------------
create or replace function public.is_active_user()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active);
$$;

-- profiles
alter table public.profiles enable row level security;
drop policy if exists "profiles read"        on public.profiles;
drop policy if exists "profiles self update" on public.profiles;
drop policy if exists "profiles admin write" on public.profiles;
create policy "profiles read"        on public.profiles for select to authenticated using (public.is_active_user());
create policy "profiles self update" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid() and role = (select role from public.profiles where id = auth.uid()));
create policy "profiles admin write" on public.profiles for all    to authenticated using (public.is_admin()) with check (public.is_admin());

-- leads (special read rule)
alter table public.leads enable row level security;
drop policy if exists "leads read"   on public.leads;
drop policy if exists "leads insert" on public.leads;
drop policy if exists "leads update" on public.leads;
drop policy if exists "leads delete" on public.leads;
create policy "leads read"   on public.leads for select to authenticated using (public.is_active_user() and (public.is_admin() or agent_id is null or agent_id = auth.uid()));
create policy "leads insert" on public.leads for insert to authenticated with check (public.is_active_user());
create policy "leads update" on public.leads for update to authenticated using (public.is_active_user() and (public.is_admin() or agent_id is null or agent_id = auth.uid()));
create policy "leads delete" on public.leads for delete to authenticated using (public.is_admin());

-- standard rule set for every other table
do $$
declare t text;
begin
  foreach t in array array['customers','sales','policies','vehicles','drivers','claims','quotes','appointments','notes','call_log','messages','templates','files']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "%s read"   on public.%I', t, t);
    execute format('drop policy if exists "%s insert" on public.%I', t, t);
    execute format('drop policy if exists "%s update" on public.%I', t, t);
    execute format('drop policy if exists "%s delete" on public.%I', t, t);
    execute format('create policy "%s read"   on public.%I for select to authenticated using (public.is_active_user())', t, t);
    execute format('create policy "%s insert" on public.%I for insert to authenticated with check (public.is_active_user())', t, t);
    execute format('create policy "%s update" on public.%I for update to authenticated using (public.is_active_user())', t, t);
    execute format('create policy "%s delete" on public.%I for delete to authenticated using (public.is_admin())', t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 6. FILE STORAGE  (private bucket; only signed-in users)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('files', 'files', false, 26214400)   -- 25 MB per file
on conflict (id) do nothing;

drop policy if exists "files bucket read"   on storage.objects;
drop policy if exists "files bucket insert" on storage.objects;
drop policy if exists "files bucket delete" on storage.objects;
create policy "files bucket read"   on storage.objects for select to authenticated using (bucket_id = 'files' and public.is_active_user());
create policy "files bucket insert" on storage.objects for insert to authenticated with check (bucket_id = 'files' and public.is_active_user());
create policy "files bucket delete" on storage.objects for delete to authenticated using (bucket_id = 'files' and public.is_admin());

-- ---------------------------------------------------------------------
-- 7. DEFAULT TEXT TEMPLATES  (same eight the app ships with)
-- ---------------------------------------------------------------------
insert into public.templates (emoji, name, body, sort_order)
select * from (values
  ('📋', 'Quote Ready',          'Hi {{name}}, this is {{agent}} at MaxSave Insurance. Your updated quote is ready — when can I give you a quick call?', 1),
  ('🔁', 'Follow-Up',            'Hi {{name}}, just following up on your auto insurance quote. Any questions I can answer?', 2),
  ('⏰', 'Renewal Reminder',     'Hi {{name}}, your policy expires soon. Let me lock in your renewal rate before it goes up — call me at (619) 555-0100.', 3),
  ('📄', 'Request Documents',    'Hi {{name}}, could you send me a photo of your driver''s license and current dec page? Thanks!', 4),
  ('📅', 'Confirm Appointment',  'Hi {{name}}, confirming your appointment with {{agent}}. Reply YES to confirm or call us to reschedule.', 5),
  ('💳', 'Payment Link',         'Hi {{name}}, your payment is ready. I''ll send you a secure payment link shortly.', 6),
  ('🇪🇸', 'Español — Cotización', 'Hola {{name}}, soy {{agent}} de MaxSave. Tengo su cotización lista — ¿cuándo puedo llamarle?', 7),
  ('🇪🇸', 'Español — Cita',       '¡Hola {{name}}! Solo para confirmar su cita. Responda SÍ para confirmar.', 8)
) as v(emoji, name, body, sort_order)
where not exists (select 1 from public.templates);

-- ---------------------------------------------------------------------
-- 8. REALTIME  (so every agent's screen updates when data changes)
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['leads','customers','policies','sales','appointments','notes','call_log','messages']
  loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- Done. Next: Authentication > Users > "Invite user" for each agent.
