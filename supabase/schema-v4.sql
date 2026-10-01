-- =====================================================================
-- MSIHub — schema v4: Telnyx (real texting + browser calling)
-- Run once in the Supabase SQL Editor after schema.sql / v2 / v3.
-- Safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. MESSAGES: delivery tracking + picture messages
--    status: queued | sent | delivered | failed | received
--    provider_sid = Telnyx message id
-- ---------------------------------------------------------------------
alter table public.messages add column if not exists from_number text;
alter table public.messages add column if not exists to_number   text;
alter table public.messages add column if not exists error       text;
alter table public.messages add column if not exists media       jsonb;
create unique index if not exists messages_provider_sid_uidx on public.messages(provider_sid) where provider_sid is not null;

-- ---------------------------------------------------------------------
-- 2. CALL LOG: real call details
--    status: dialing | ringing | active | completed | no-answer | missed
--    provider_call_id = Telnyx call session id
-- ---------------------------------------------------------------------
alter table public.call_log add column if not exists provider_call_id text;
alter table public.call_log add column if not exists status           text;
alter table public.call_log add column if not exists from_number      text;
alter table public.call_log add column if not exists to_number        text;
alter table public.call_log add column if not exists answered_at      timestamptz;
alter table public.call_log add column if not exists ended_at         timestamptz;
create index if not exists call_log_provider_idx on public.call_log(provider_call_id) where provider_call_id is not null;

-- ---------------------------------------------------------------------
-- 3. PROFILES: each agent's phone identity
--    telnyx_number        = the agent's own direct line (optional, +1XXXXXXXXXX)
--    telnyx_credential_id = browser-phone login, created by the telnyx function
--    telnyx_sip_username  = where inbound calls are sent to reach this agent's browser
--    Only admins (and the server function) may change these.
-- ---------------------------------------------------------------------
alter table public.profiles add column if not exists telnyx_number        text;
alter table public.profiles add column if not exists telnyx_credential_id text;
alter table public.profiles add column if not exists telnyx_sip_username  text;

create or replace function public.guard_profile_phone()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_admin()
     and (new.telnyx_number is distinct from old.telnyx_number
       or new.telnyx_credential_id is distinct from old.telnyx_credential_id
       or new.telnyx_sip_username is distinct from old.telnyx_sip_username) then
    raise exception 'Only an admin can change phone assignments';
  end if;
  return new;
end $$;
drop trigger if exists profiles_guard_phone on public.profiles;
create trigger profiles_guard_phone before update on public.profiles
  for each row execute function public.guard_profile_phone();

-- ---------------------------------------------------------------------
-- 4. PHONE PRESENCE: which agents have their browser phone open right now.
--    The app refreshes its own row every ~40 seconds; inbound calls only ring
--    agents seen in the last 90 seconds with status 'available'.
--    Deliberately NOT in the realtime publication (it changes constantly).
-- ---------------------------------------------------------------------
create table if not exists public.phone_presence (
  agent_id uuid primary key references public.profiles(id) on delete cascade,
  status   text not null default 'available',   -- available | on-call | dnd | offline
  seen_at  timestamptz not null default now()
);
create or replace function public.touch_phone_presence()
returns trigger language plpgsql as $$
begin new.seen_at = now(); return new; end $$;   -- server clock, never the browser's
drop trigger if exists phone_presence_touch on public.phone_presence;
create trigger phone_presence_touch before insert or update on public.phone_presence
  for each row execute function public.touch_phone_presence();

alter table public.phone_presence enable row level security;
drop policy if exists "presence read"   on public.phone_presence;
drop policy if exists "presence insert" on public.phone_presence;
drop policy if exists "presence update" on public.phone_presence;
drop policy if exists "presence delete" on public.phone_presence;
create policy "presence read"   on public.phone_presence for select to authenticated using (public.is_active_user());
create policy "presence insert" on public.phone_presence for insert to authenticated with check (agent_id = auth.uid() and public.is_active_user());
create policy "presence update" on public.phone_presence for update to authenticated using (agent_id = auth.uid()) with check (agent_id = auth.uid());
create policy "presence delete" on public.phone_presence for delete to authenticated using (agent_id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------------
-- 5. TEXT OPT-OUTS: numbers that replied STOP. The server refuses to text them.
--    Written only by the telnyx function; an admin can delete a row to re-allow.
-- ---------------------------------------------------------------------
create table if not exists public.sms_opt_outs (
  phone      text primary key,                  -- +1XXXXXXXXXX
  keyword    text,
  created_at timestamptz not null default now()
);
alter table public.sms_opt_outs enable row level security;
drop policy if exists "optouts read"   on public.sms_opt_outs;
drop policy if exists "optouts delete" on public.sms_opt_outs;
create policy "optouts read"   on public.sms_opt_outs for select to authenticated using (public.is_active_user());
create policy "optouts delete" on public.sms_opt_outs for delete to authenticated using (public.is_admin());

-- Done. Next: deploy supabase/functions/telnyx and set its secrets (see HANDOFF.md > Telnyx).
