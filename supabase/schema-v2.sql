-- =====================================================================
--  MSIHub CRM — schema v2  (2026-09-14)
--  Adds: agent settings on profiles, tasks, and a key/value store for
--  agency settings (tiers, carriers, lead vendors, lead sources,
--  lifecycle rules, goal period).
--  Paste into Supabase > SQL Editor > New query > Run. Safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. PROFILES: agent configuration the Admin / Teams pages edit
-- ---------------------------------------------------------------------
alter table public.profiles
  add column if not exists ext          text,
  add column if not exists tier         text,
  add column if not exists team         text,
  add column if not exists agent_type   text,
  add column if not exists start_date   date,
  add column if not exists goal_apps    int  not null default 15,
  add column if not exists goal_fee     int  not null default 6000,
  add column if not exists goal_premium int  not null default 20000,
  add column if not exists goal_close   int  not null default 25,
  add column if not exists goal_contact int  not null default 55,
  add column if not exists perms        jsonb not null default '{}'::jsonb;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- 2. TASKS  (Tasks & Follow-Ups page + dashboard focus list)
-- ---------------------------------------------------------------------
create table if not exists public.tasks (
  id             bigint generated always as identity primary key,
  label          text not null,
  icon           text not null default '✅',
  priority       text not null default 'med' check (priority in ('high','med','low')),
  due_date       date,
  due_time       text,                                   -- display string, e.g. "3:00 PM"
  assigned_to    uuid references public.profiles(id) on delete set null,
  assigned_label text,                                   -- 'Admin' or the agent's name (what the UI shows)
  lead_id        uuid references public.leads(id) on delete set null,
  customer_id    uuid references public.customers(id) on delete set null,
  notes          text,
  done           boolean not null default false,
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists tasks_due_idx      on public.tasks(due_date);
create index if not exists tasks_assigned_idx on public.tasks(assigned_to);
drop trigger if exists tasks_touch on public.tasks;
create trigger tasks_touch before update on public.tasks for each row execute function public.touch_updated_at();

alter table public.tasks enable row level security;
drop policy if exists "tasks read"   on public.tasks;
drop policy if exists "tasks insert" on public.tasks;
drop policy if exists "tasks update" on public.tasks;
drop policy if exists "tasks delete" on public.tasks;
create policy "tasks read"   on public.tasks for select to authenticated using (public.is_active_user());
create policy "tasks insert" on public.tasks for insert to authenticated with check (public.is_active_user());
create policy "tasks update" on public.tasks for update to authenticated using (public.is_active_user());
create policy "tasks delete" on public.tasks for delete to authenticated using (public.is_admin() or created_by = auth.uid());

-- ---------------------------------------------------------------------
-- 3. AGENCY SETTINGS  (key/value; one row per settings list)
--    keys: tiers, carriers, lead_vendors, lead_sources, lifecycle_rules, goal_period
-- ---------------------------------------------------------------------
create table if not exists public.agency_settings (
  key        text primary key,
  value      jsonb,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.agency_settings enable row level security;
drop policy if exists "settings read"  on public.agency_settings;
drop policy if exists "settings write" on public.agency_settings;
create policy "settings read"  on public.agency_settings for select to authenticated using (public.is_active_user());
create policy "settings write" on public.agency_settings for all    to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------
-- 4. REALTIME
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['tasks','agency_settings','profiles']
  loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- Done. The app seeds the settings lists with the built-in defaults the
-- first time an admin signs in after this runs.
