-- =====================================================================
-- MaxSaveHub schema v6: follow-up automation, policies/renewals, loss reasons, tags, email.
-- Re-runnable. Needs schema.sql .. schema-v5. Run in the Supabase SQL editor (or via tools/automation-go-live.mjs).
--
-- What it adds
--   leads:      tags[], loss_reason, closed_at, x_date (current policy renewal date), recycled_at
--   customers:  tags[]
--   policies:   term_months, csr_id, cancel_reason, cancelled_at, renewed_from, notes
--   emails, email_opt_outs                       outbound (and later inbound) email per lead/customer
--   automation_enrollments, automation_log       a lead/customer/policy running through one Settings → Lifecycle sequence
--   triggers on leads / messages / call_log / sales / policies / customers / emails that start and stop sequences
--   automation_daily()  renewals, birthdays, shot clock (aged leads), X-date recycling
--   automation_due() / automation_advance()  consumed by the "automation" edge function every 5 minutes
--
-- Sequences themselves stay where the admin edits them: agency_settings key 'lifecycle_rules'
--   [{id, name, triggerLabel, active, steps:[{day, time:'9:00 AM'|'Right away', action:'Send Text'|'Send Email'|'Create Task', subject, message}]}]
-- Engine settings: agency_settings key 'automation'
--   {enabled, timezone, business_days:[1..7 ISO], start:'08:00', end:'19:00', holidays:['2026-12-25'], business_days_only,
--    stop_on_reply, stop_on_contact, shot_clock_days, shot_clock_since:'YYYY-MM-DD', xdate_lead_days, policy_term_months,
--    email_enabled, email_from_name, email_from, email_reply_to, email_signature, sms_optout_footer}
-- Nothing runs while automation.enabled is false.
-- =====================================================================

-- 1. Columns ------------------------------------------------------------
alter table public.leads add column if not exists tags        text[] not null default '{}';
alter table public.leads add column if not exists loss_reason text;
alter table public.leads add column if not exists closed_at   timestamptz;
alter table public.leads add column if not exists x_date      date;
alter table public.leads add column if not exists recycled_at timestamptz;
create index if not exists leads_recycled_idx on public.leads(recycled_at desc) where recycled_at is not null;
create index if not exists leads_xdate_idx    on public.leads(x_date) where x_date is not null;
create index if not exists leads_tags_idx     on public.leads using gin(tags);
create index if not exists leads_email_idx    on public.leads(lower(email)) where email is not null;

alter table public.customers add column if not exists tags text[] not null default '{}';
create index if not exists customers_tags_idx on public.customers using gin(tags);

alter table public.policies add column if not exists term_months   int not null default 6;
alter table public.policies add column if not exists csr_id        uuid references public.profiles(id) on delete set null;
alter table public.policies add column if not exists cancel_reason text;
alter table public.policies add column if not exists cancelled_at  date;
alter table public.policies add column if not exists renewed_from  uuid references public.policies(id) on delete set null;
alter table public.policies add column if not exists notes         text;
create index if not exists policies_status_expires_idx on public.policies(status, expires_date);

alter table public.tasks add column if not exists source text;   -- 'automation' when a sequence created it
-- policies written before v6 were one-year terms (New Sale used effective + 1 year); keep their term honest
update public.policies set term_months = 12 where term_months = 6 and effective_date is not null and expires_date is not null and (expires_date - effective_date) between 330 and 400;

-- 2. Email --------------------------------------------------------------
create table if not exists public.emails (
  id            uuid primary key default gen_random_uuid(),
  direction     text not null default 'outbound' check (direction in ('inbound','outbound')),
  agent_id      uuid references public.profiles(id) on delete set null,
  lead_id       uuid references public.leads(id) on delete set null,
  customer_id   uuid references public.customers(id) on delete set null,
  to_email      text not null,
  from_email    text,
  subject       text not null default '',
  body          text not null default '',
  status        text not null default 'queued',      -- queued | sent | delivered | failed | skipped | received
  provider_id   text,
  error         text,
  source        text not null default 'manual',      -- manual | automation
  enrollment_id bigint,
  created_at    timestamptz not null default now()
);
create index if not exists emails_lead_idx     on public.emails(lead_id);
create index if not exists emails_customer_idx on public.emails(customer_id);
create index if not exists emails_created_idx  on public.emails(created_at desc);
create index if not exists emails_to_idx       on public.emails(lower(to_email), created_at desc);

create table if not exists public.email_opt_outs (
  email      text primary key,
  source     text,
  created_at timestamptz not null default now()
);

alter table public.emails enable row level security;
alter table public.email_opt_outs enable row level security;
drop policy if exists "emails read"   on public.emails;
drop policy if exists "emails insert" on public.emails;
drop policy if exists "emails update" on public.emails;
drop policy if exists "emails delete" on public.emails;
create policy "emails read"   on public.emails for select to authenticated using ((select public.is_active_user()));
create policy "emails insert" on public.emails for insert to authenticated with check ((select public.is_active_user()));
create policy "emails update" on public.emails for update to authenticated using ((select public.is_active_user()));
create policy "emails delete" on public.emails for delete to authenticated using ((select public.is_admin()));
drop policy if exists "email optouts read"   on public.email_opt_outs;
drop policy if exists "email optouts insert" on public.email_opt_outs;
drop policy if exists "email optouts delete" on public.email_opt_outs;
create policy "email optouts read"   on public.email_opt_outs for select to authenticated using ((select public.is_active_user()));
create policy "email optouts insert" on public.email_opt_outs for insert to authenticated with check ((select public.is_active_user()));
create policy "email optouts delete" on public.email_opt_outs for delete to authenticated using ((select public.is_admin()));

-- 3. Automation tables --------------------------------------------------
create table if not exists public.automation_enrollments (
  id           bigint generated always as identity primary key,
  rule_id      int not null,
  rule_name    text not null default '',
  trigger      text not null default '',
  lead_id      uuid references public.leads(id) on delete cascade,
  customer_id  uuid references public.customers(id) on delete cascade,
  policy_id    uuid references public.policies(id) on delete cascade,
  sale_id      uuid references public.sales(id) on delete set null,
  agent_id     uuid references public.profiles(id) on delete set null,
  phone_digits text,
  anchor_at    timestamptz not null default now(),
  anchor_date  date,
  plan         jsonb not null default '[]'::jsonb,   -- [{i: step index in the rule, due: timestamptz}] in run order
  step_no      int not null default 0,               -- index into plan
  next_run_at  timestamptz,
  claimed_at   timestamptz,
  status       text not null default 'active',       -- active | done | stopped
  stop_reason  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists automation_enrollments_due_idx      on public.automation_enrollments(next_run_at) where status = 'active';
create index if not exists automation_enrollments_lead_idx     on public.automation_enrollments(lead_id);
create index if not exists automation_enrollments_customer_idx on public.automation_enrollments(customer_id);
create index if not exists automation_enrollments_policy_idx   on public.automation_enrollments(policy_id);
create index if not exists automation_enrollments_phone_idx    on public.automation_enrollments(phone_digits) where status = 'active';
create index if not exists automation_enrollments_updated_idx  on public.automation_enrollments(updated_at desc);
drop trigger if exists automation_enrollments_touch on public.automation_enrollments;
create trigger automation_enrollments_touch before update on public.automation_enrollments for each row execute function public.touch_updated_at();

create table if not exists public.automation_log (
  id            bigint generated always as identity primary key,
  enrollment_id bigint references public.automation_enrollments(id) on delete cascade,
  rule_name     text,
  step_no       int,
  action        text,
  lead_id       uuid,
  customer_id   uuid,
  status        text not null default 'info',   -- enrolled | sent | task | skipped | failed | stopped | done | info
  detail        text,
  created_at    timestamptz not null default now()
);
create index if not exists automation_log_created_idx on public.automation_log(created_at desc);
create index if not exists automation_log_lead_idx    on public.automation_log(lead_id);
create index if not exists automation_log_enroll_idx  on public.automation_log(enrollment_id);

alter table public.automation_enrollments enable row level security;
alter table public.automation_log enable row level security;
drop policy if exists "enrollments read"  on public.automation_enrollments;
drop policy if exists "enrollments admin" on public.automation_enrollments;
create policy "enrollments read"  on public.automation_enrollments for select to authenticated using ((select public.is_active_user()));
create policy "enrollments admin" on public.automation_enrollments for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists "automation log read"  on public.automation_log;
drop policy if exists "automation log admin" on public.automation_log;
create policy "automation log read"  on public.automation_log for select to authenticated using ((select public.is_active_user()));
create policy "automation log admin" on public.automation_log for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- 4. Settings helpers ---------------------------------------------------
create or replace function public.automation_cfg() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'enabled', false, 'timezone', 'America/Los_Angeles', 'business_days', '[1,2,3,4,5]'::jsonb, 'start', '08:00', 'end', '19:00',
    'holidays', '[]'::jsonb, 'business_days_only', true, 'stop_on_reply', true, 'stop_on_contact', true,
    'shot_clock_days', 45, 'xdate_lead_days', 30, 'policy_term_months', 6, 'email_enabled', false, 'sms_optout_footer', true)
  || coalesce((select value from agency_settings where key = 'automation'), '{}'::jsonb);
$$;

create or replace function public.automation_enabled() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((public.automation_cfg() ->> 'enabled')::boolean, false);
$$;

create or replace function public.automation_rules() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select value from agency_settings where key = 'lifecycle_rules'), '[]'::jsonb);
$$;

create or replace function public.automation_tz() returns text
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(public.automation_cfg() ->> 'timezone', ''), 'America/Los_Angeles');
$$;

create or replace function public.automation_today() returns date
language sql stable security definer set search_path = public as $$
  select (now() at time zone public.automation_tz())::date;
$$;

-- "9:30 AM" -> 09:30. Anything unparseable -> null (treated as "right away").
create or replace function public.automation_parse_time(p text) returns time
language plpgsql immutable as $$
declare m text[]; h int;
begin
  m := regexp_match(coalesce(p, ''), '^\s*(\d{1,2})(?::(\d{2}))?\s*([AaPp])?[Mm]?\s*$');
  if m is null then return null; end if;
  h := m[1]::int;
  if m[3] is not null then
    if upper(m[3]) = 'P' and h < 12 then h := h + 12; end if;
    if upper(m[3]) = 'A' and h = 12 then h := 0; end if;
  end if;
  if h > 23 then return null; end if;
  return make_time(h, coalesce(m[2], '0')::int, 0);
end $$;

-- Push a moment forward until it falls inside business hours on a business day (when that setting is on).
create or replace function public.automation_business(p timestamptz) returns timestamptz
language plpgsql stable security definer set search_path = public as $$
declare cfg jsonb; tz text; days int[]; hols date[]; t_start time; t_end time; loc timestamp; d date; i int := 0;
begin
  cfg := public.automation_cfg();
  if not coalesce((cfg ->> 'business_days_only')::boolean, true) then return p; end if;
  tz := coalesce(nullif(cfg ->> 'timezone', ''), 'America/Los_Angeles');
  select coalesce(array_agg(x::int), '{1,2,3,4,5}') into days from jsonb_array_elements_text(coalesce(cfg -> 'business_days', '[1,2,3,4,5]'::jsonb)) x;
  select coalesce(array_agg(x::date), '{}') into hols from jsonb_array_elements_text(coalesce(cfg -> 'holidays', '[]'::jsonb)) x where x ~ '^\d{4}-\d{2}-\d{2}$';
  t_start := coalesce(public.automation_parse_time(cfg ->> 'start'), time '08:00');
  t_end   := coalesce(public.automation_parse_time(cfg ->> 'end'),   time '19:00');
  if t_end <= t_start then t_end := time '23:59'; end if;
  loc := p at time zone tz;
  loop
    d := loc::date;
    if not (extract(isodow from d)::int = any(days)) or d = any(hols) then
      loc := (d + 1) + t_start;
    elsif loc::time < t_start then
      loc := d + t_start;
    elsif loc::time > t_end then
      loc := (d + 1) + t_start;
    else
      exit;
    end if;
    i := i + 1; if i > 60 then exit; end if;
  end loop;
  return loc at time zone tz;
end $$;

-- When does one step run?  mode 'after': day 1 = the trigger day.  mode 'before': day N = N days before p_expires.
create or replace function public.automation_due_at(p_anchor timestamptz, p_day int, p_time text, p_mode text, p_expires date) returns timestamptz
language plpgsql stable security definer set search_path = public as $$
declare tz text; d date; t time; due timestamptz;
begin
  tz := public.automation_tz();
  t := public.automation_parse_time(p_time);
  if p_mode = 'before' then
    d := coalesce(p_expires, (p_anchor at time zone tz)::date) - greatest(coalesce(p_day, 0), 0);
    due := (d + coalesce(t, time '09:00')) at time zone tz;
  else
    d := (p_anchor at time zone tz)::date + greatest(coalesce(p_day, 1), 1) - 1;
    if t is null then due := p_anchor; else due := (d + t) at time zone tz; end if;
  end if;
  if p_mode <> 'before' and due < p_anchor then due := p_anchor; end if;   -- a step whose time already passed today goes out now
  return public.automation_business(due);
end $$;

create or replace function public.automation_log_add(p_enrollment bigint, p_rule text, p_step int, p_action text, p_lead uuid, p_customer uuid, p_status text, p_detail text) returns void
language sql security definer set search_path = public as $$
  insert into automation_log(enrollment_id, rule_name, step_no, action, lead_id, customer_id, status, detail)
  values (p_enrollment, p_rule, p_step, p_action, p_lead, p_customer, p_status, left(p_detail, 500));
$$;

-- 5. Enroll / stop ------------------------------------------------------
create or replace function public.automation_enroll(p_rule jsonb, p_lead uuid, p_customer uuid, p_policy uuid, p_sale uuid, p_anchor timestamptz, p_expires date, p_agent uuid, p_phone text) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_mode text; v_plan jsonb; v_id bigint; v_rule_id int; v_name text; v_trigger text; v_first timestamptz;
begin
  if p_rule is null or coalesce((p_rule ->> 'active')::boolean, false) = false then return null; end if;
  v_rule_id := (p_rule ->> 'id')::int; v_name := coalesce(p_rule ->> 'name', ''); v_trigger := coalesce(p_rule ->> 'triggerLabel', '');
  if p_lead is null and p_customer is null then return null; end if;
  -- one active run per rule per lead / customer / policy
  if exists (select 1 from automation_enrollments e where e.status = 'active' and e.rule_id = v_rule_id
               and ((p_policy is not null and e.policy_id = p_policy)
                 or (p_policy is null and p_lead is not null and e.lead_id = p_lead)
                 or (p_policy is null and p_lead is null and e.customer_id = p_customer))) then
    return null;
  end if;
  v_mode := case when v_trigger = 'Policy expires in' then 'before' else 'after' end;
  select coalesce(jsonb_agg(jsonb_build_object('i', s.i - 1, 'due', s.due) order by s.due, s.i), '[]'::jsonb)
    into v_plan
    from (select t.i, public.automation_due_at(p_anchor, nullif(t.s ->> 'day', '')::int, t.s ->> 'time', v_mode, p_expires) as due
            from jsonb_array_elements(coalesce(p_rule -> 'steps', '[]'::jsonb)) with ordinality as t(s, i)) s
   where v_mode = 'after' or s.due >= now() - interval '1 hour';   -- a renewal step already in the past is skipped, not blasted out
  if jsonb_array_length(v_plan) = 0 then return null; end if;
  v_first := (v_plan -> 0 ->> 'due')::timestamptz;
  insert into automation_enrollments(rule_id, rule_name, trigger, lead_id, customer_id, policy_id, sale_id, agent_id, phone_digits, anchor_at, anchor_date, plan, step_no, next_run_at)
  values (v_rule_id, v_name, v_trigger, p_lead, p_customer, p_policy, p_sale, p_agent, right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10),
          p_anchor, coalesce(p_expires, (p_anchor at time zone public.automation_tz())::date), v_plan, 0, v_first)
  returning id into v_id;
  perform public.automation_log_add(v_id, v_name, null, null, p_lead, p_customer, 'enrolled', 'Enrolled in "' || v_name || '" (' || v_trigger || '), ' || jsonb_array_length(v_plan) || ' step(s), first ' || to_char(v_first at time zone public.automation_tz(), 'Mon DD HH12:MI AM'));
  return v_id;
end $$;

-- Every active rule with this trigger label, for one lead.
create or replace function public.automation_enroll_lead_trigger(p_trigger text, p_lead uuid) returns int
language plpgsql security definer set search_path = public as $$
declare L leads%rowtype; r jsonb; n int := 0;
begin
  select * into L from leads where id = p_lead; if not found then return 0; end if;
  if L.do_not_call then return 0; end if;
  for r in select x from jsonb_array_elements(public.automation_rules()) x where x ->> 'triggerLabel' = p_trigger and coalesce((x ->> 'active')::boolean, false) loop
    if public.automation_enroll(r, L.id, null, null, null, now(), null, L.agent_id, L.phone) is not null then n := n + 1; end if;
  end loop;
  return n;
end $$;

create or replace function public.automation_stop_for(p_lead uuid, p_customer uuid, p_reason text, p_triggers text[] default null) returns int
language plpgsql security definer set search_path = public as $$
declare n int := 0; e record;
begin
  for e in update automation_enrollments set status = 'stopped', stop_reason = p_reason, next_run_at = null
            where status = 'active'
              and ((p_lead is not null and lead_id = p_lead) or (p_customer is not null and customer_id = p_customer))
              and (p_triggers is null or trigger = any(p_triggers))
          returning id, rule_name, lead_id, customer_id loop
    perform public.automation_log_add(e.id, e.rule_name, null, null, e.lead_id, e.customer_id, 'stopped', 'Stopped: ' || p_reason);
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.automation_stop_phone(p_phone text, p_reason text) returns int
language plpgsql security definer set search_path = public as $$
declare d text; n int := 0; e record;
begin
  d := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10);
  if length(d) < 10 then return 0; end if;
  for e in update automation_enrollments set status = 'stopped', stop_reason = p_reason, next_run_at = null
            where status = 'active' and phone_digits = d returning id, rule_name, lead_id, customer_id loop
    perform public.automation_log_add(e.id, e.rule_name, null, null, e.lead_id, e.customer_id, 'stopped', 'Stopped: ' || p_reason);
    n := n + 1;
  end loop;
  return n;
end $$;

-- Called from the app (any active user): put a lead or customer into a sequence by hand, or stop one run.
create or replace function public.automation_enroll_manual(p_rule_id int, p_lead uuid default null, p_customer uuid default null) returns bigint
language plpgsql security definer set search_path = public as $$
declare r jsonb; L leads%rowtype; C customers%rowtype; v_id bigint;
begin
  if not public.is_active_user() then raise exception 'not allowed'; end if;
  select x into r from jsonb_array_elements(public.automation_rules()) x where (x ->> 'id')::int = p_rule_id;
  if r is null then raise exception 'That sequence no longer exists'; end if;
  r := r || '{"active":true}'::jsonb;   -- a manual enrollment may use a paused sequence
  if p_lead is not null then
    select * into L from leads where id = p_lead; if not found then raise exception 'Lead not found'; end if;
    if L.do_not_call then raise exception 'This lead is marked Do Not Call'; end if;
    v_id := public.automation_enroll(r, L.id, null, null, null, now(), null, L.agent_id, L.phone);
  elsif p_customer is not null then
    select * into C from customers where id = p_customer; if not found then raise exception 'Customer not found'; end if;
    v_id := public.automation_enroll(r, null, C.id, null, null, now(), null, C.agent_id, C.phone);
  end if;
  if v_id is null then raise exception 'Already running this sequence (or it has no steps)'; end if;
  return v_id;
end $$;

create or replace function public.automation_stop_manual(p_id bigint) returns boolean
language plpgsql security definer set search_path = public as $$
declare e record;
begin
  if not public.is_active_user() then raise exception 'not allowed'; end if;
  update automation_enrollments set status = 'stopped', stop_reason = 'stopped by ' || coalesce((select full_name from profiles where id = auth.uid()), 'agent'), next_run_at = null
   where id = p_id and status = 'active' returning * into e;
  if not found then return false; end if;
  perform public.automation_log_add(e.id, e.rule_name, null, null, e.lead_id, e.customer_id, 'stopped', 'Stopped: ' || e.stop_reason);
  return true;
end $$;

-- 6. Triggers that start and stop sequences -------------------------------
create or replace function public.automation_on_lead() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if TG_OP = 'INSERT' then
    if new.status = 'Bad Lead' or new.status = 'Sold' then
      new.closed_at := coalesce(new.closed_at, now());
    end if;
    return new;
  end if;
  if new.status is distinct from old.status then
    if new.status in ('Bad Lead', 'Sold') then new.closed_at := coalesce(new.closed_at, now());
    else new.closed_at := null; new.loss_reason := case when old.status = 'Bad Lead' then null else new.loss_reason end;
    end if;
  end if;
  return new;
end $$;

create or replace function public.automation_after_lead() returns trigger
language plpgsql security definer set search_path = public as $$
declare stage_triggers text[] := array['Lead is created','Lead is marked Quoted','Lead is marked Appointment Set','Lead has no contact in','Lead is marked Bad Lead','Lead is recycled (X-date)'];
begin
  if not public.automation_enabled() then return null; end if;
  if TG_OP = 'INSERT' then
    if new.status = 'New Lead' and not new.do_not_call then perform public.automation_enroll_lead_trigger('Lead is created', new.id); end if;
    return null;
  end if;
  if new.do_not_call and not old.do_not_call then
    perform public.automation_stop_for(new.id, null, 'marked Do Not Call'); return null;
  end if;
  if new.recycled_at is distinct from old.recycled_at and new.recycled_at is not null then
    perform public.automation_stop_for(new.id, null, 'recycled (X-date)', stage_triggers);
    if not new.do_not_call then perform public.automation_enroll_lead_trigger('Lead is recycled (X-date)', new.id); end if;
    return null;
  end if;
  if new.status is distinct from old.status then
    perform public.automation_stop_for(new.id, null, 'stage changed to ' || new.status, stage_triggers);
    if new.status = 'Sold' then perform public.automation_stop_for(new.id, null, 'sold');
    elsif new.status = 'Quoted' then perform public.automation_enroll_lead_trigger('Lead is marked Quoted', new.id);
    elsif new.status = 'Appointment Set' then perform public.automation_enroll_lead_trigger('Lead is marked Appointment Set', new.id);
    elsif new.status = 'Bad Lead' then perform public.automation_enroll_lead_trigger('Lead is marked Bad Lead', new.id);
    end if;
  end if;
  return null;
end $$;

drop trigger if exists leads_automation_before on public.leads;
create trigger leads_automation_before before insert or update of status on public.leads for each row execute function public.automation_on_lead();
drop trigger if exists leads_automation_after on public.leads;
create trigger leads_automation_after after insert or update of status, do_not_call, recycled_at on public.leads for each row execute function public.automation_after_lead();

-- An inbound text or email means they replied: stop the lead's sequences.
create or replace function public.automation_after_message() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.direction <> 'inbound' or not public.automation_enabled() then return null; end if;
  if not coalesce((public.automation_cfg() ->> 'stop_on_reply')::boolean, true) then return null; end if;
  if new.lead_id is not null or new.customer_id is not null then perform public.automation_stop_for(new.lead_id, new.customer_id, 'they replied by text'); end if;
  perform public.automation_stop_phone(new.phone, 'they replied by text');
  return null;
end $$;
drop trigger if exists messages_automation on public.messages;
create trigger messages_automation after insert on public.messages for each row execute function public.automation_after_message();

create or replace function public.automation_after_email() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.direction <> 'inbound' or not public.automation_enabled() then return null; end if;
  if not coalesce((public.automation_cfg() ->> 'stop_on_reply')::boolean, true) then return null; end if;
  if new.lead_id is not null or new.customer_id is not null then perform public.automation_stop_for(new.lead_id, new.customer_id, 'they replied by email'); end if;
  return null;
end $$;
drop trigger if exists emails_automation on public.emails;
create trigger emails_automation after insert on public.emails for each row execute function public.automation_after_email();

-- A real conversation (answered call of 20 s or more, or an inbound call that was picked up) means contact was made.
create or replace function public.automation_after_call() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.automation_enabled() then return null; end if;
  if not coalesce((public.automation_cfg() ->> 'stop_on_contact')::boolean, true) then return null; end if;
  if coalesce(new.duration_sec, 0) >= 20 or (new.direction = 'inbound' and coalesce(new.missed, false) = false and coalesce(new.status, '') = 'completed') then
    if new.lead_id is not null or new.customer_id is not null then perform public.automation_stop_for(new.lead_id, new.customer_id, 'contact made by phone'); end if;
    perform public.automation_stop_phone(new.phone, 'contact made by phone');
  end if;
  return null;
end $$;
drop trigger if exists call_log_automation on public.call_log;
create trigger call_log_automation after insert or update of duration_sec, status on public.call_log for each row execute function public.automation_after_call();

-- A sale with an extended fee starts the "Extended fee unpaid for" sequence; collecting it stops it.
create or replace function public.automation_after_sale() returns trigger
language plpgsql security definer set search_path = public as $$
declare r jsonb; C customers%rowtype;
begin
  if not public.automation_enabled() or coalesce(new.fee_extended, 0) <= 0 or new.customer_id is null then return null; end if;
  select * into C from customers where id = new.customer_id; if not found then return null; end if;
  for r in select x from jsonb_array_elements(public.automation_rules()) x where x ->> 'triggerLabel' = 'Extended fee unpaid for' and coalesce((x ->> 'active')::boolean, false) loop
    perform public.automation_enroll(r, null, C.id, null, new.id, now(), null, coalesce(new.agent_id, C.agent_id), C.phone);
  end loop;
  return null;
end $$;
drop trigger if exists sales_automation on public.sales;
create trigger sales_automation after insert on public.sales for each row execute function public.automation_after_sale();

create or replace function public.automation_after_policy() returns trigger
language plpgsql security definer set search_path = public as $$
declare e record;
begin
  if TG_OP = 'UPDATE' and ((new.hcc_collected and not old.hcc_collected) or (coalesce(new.fee_extended, 0) = 0 and coalesce(old.fee_extended, 0) > 0)) and new.sale_id is not null then
    for e in update automation_enrollments set status = 'stopped', stop_reason = 'extended fee collected', next_run_at = null
              where status = 'active' and sale_id = new.sale_id and trigger = 'Extended fee unpaid for' returning id, rule_name, lead_id, customer_id loop
      perform public.automation_log_add(e.id, e.rule_name, null, null, e.lead_id, e.customer_id, 'stopped', 'Stopped: extended fee collected');
    end loop;
  end if;
  if new.status is distinct from old.status and new.status in ('Cancelled', 'Voided', 'Renewed', 'Expired') then
    for e in update automation_enrollments set status = 'stopped', stop_reason = 'policy ' || lower(new.status), next_run_at = null
              where status = 'active' and policy_id = new.id returning id, rule_name, lead_id, customer_id loop
      perform public.automation_log_add(e.id, e.rule_name, null, null, e.lead_id, e.customer_id, 'stopped', 'Stopped: policy ' || lower(new.status));
    end loop;
  end if;
  return null;
end $$;
drop trigger if exists policies_automation on public.policies;
create trigger policies_automation after update of hcc_collected, fee_extended, status on public.policies for each row execute function public.automation_after_policy();

create or replace function public.automation_after_customer() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status and new.status = 'Cancelled' then perform public.automation_stop_for(null, new.id, 'customer cancelled'); end if;
  return null;
end $$;
drop trigger if exists customers_automation on public.customers;
create trigger customers_automation after update of status on public.customers for each row execute function public.automation_after_customer();

-- 7. Daily jobs: renewals, birthdays, shot clock, X-date recycling ------------------
create or replace function public.automation_daily(p_force boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cfg jsonb; today date; st jsonb; r jsonb; maxday int; p record; rec record; n_ren int := 0; n_bd int := 0; n_aged int := 0; n_x int := 0;
        sc_days int; sc_since date; x_lead int; term int; v_agent_label text;
begin
  cfg := public.automation_cfg(); today := public.automation_today();
  if not coalesce((cfg ->> 'enabled')::boolean, false) then return jsonb_build_object('skipped', 'automation is off'); end if;
  st := coalesce((select value from agency_settings where key = 'automation_state'), '{}'::jsonb);
  if not p_force and (st ->> 'last_daily')::date = today then return jsonb_build_object('skipped', 'already ran today'); end if;

  -- a) renewals: "Policy expires in" sequences, days counted back from the expiration date
  for r in select x from jsonb_array_elements(public.automation_rules()) x where x ->> 'triggerLabel' = 'Policy expires in' and coalesce((x ->> 'active')::boolean, false) loop
    select coalesce(max(nullif(s ->> 'day', '')::int), 0) into maxday from jsonb_array_elements(coalesce(r -> 'steps', '[]'::jsonb)) s;
    for p in select po.id, po.customer_id, po.expires_date, po.sale_id, coalesce(po.csr_id, po.sold_by_id, c.agent_id) as agent_id, c.phone
               from policies po join customers c on c.id = po.customer_id
              where po.status = 'Active' and po.expires_date is not null and po.expires_date between today and today + maxday
                and c.status <> 'Cancelled'
                and not exists (select 1 from automation_enrollments e where e.policy_id = po.id and e.rule_id = (r ->> 'id')::int and e.anchor_date = po.expires_date)
              order by po.expires_date limit 500 loop
      if public.automation_enroll(r, null, p.customer_id, p.id, p.sale_id, now(), p.expires_date, p.agent_id, p.phone) is not null then n_ren := n_ren + 1; end if;
    end loop;
  end loop;

  -- b) birthdays
  for r in select x from jsonb_array_elements(public.automation_rules()) x where x ->> 'triggerLabel' = 'On customer birthday' and coalesce((x ->> 'active')::boolean, false) loop
    for p in select c.id, c.agent_id, c.phone from customers c
              where c.dob is not null and c.status = 'Active'
                and extract(month from c.dob) = extract(month from today) and extract(day from c.dob) = extract(day from today)
                and not exists (select 1 from automation_enrollments e where e.customer_id = c.id and e.rule_id = (r ->> 'id')::int and e.anchor_date = today)
              limit 500 loop
      if public.automation_enroll(r, null, p.id, null, null, now(), null, p.agent_id, p.phone) is not null then n_bd := n_bd + 1; end if;
    end loop;
  end loop;

  -- c) shot clock: open leads with no activity for N days are tagged Aged, given a Follow Up disposition and an estimated X-date
  sc_days := coalesce(nullif(cfg ->> 'shot_clock_days', '')::int, 45);
  sc_since := coalesce(nullif(cfg ->> 'shot_clock_since', '')::date, today);
  term := coalesce(nullif(cfg ->> 'policy_term_months', '')::int, 6);
  if sc_days > 0 then
    for rec in select l.id, l.agent_id, l.received_at, l.x_date, l.details from leads l
              where l.status in ('New Lead', 'Contacted', 'Quoted', 'Appointment Set') and not l.do_not_call
                and not ('Aged' = any(l.tags))
                and coalesce(l.recycled_at, l.received_at) >= sc_since
                and coalesce(l.recycled_at, l.received_at) < now() - make_interval(days => sc_days)
                and l.updated_at < now() - make_interval(days => sc_days)
                and not exists (select 1 from call_log k where k.lead_id = l.id and k.created_at > now() - make_interval(days => sc_days))
                and not exists (select 1 from messages m where m.lead_id = l.id and m.created_at > now() - make_interval(days => sc_days))
                and not exists (select 1 from notes n where n.lead_id = l.id and n.created_at > now() - make_interval(days => sc_days))
              order by l.received_at limit 500 loop
      update leads set tags = array_append(tags, 'Aged'), disposition = coalesce(disposition, 'Follow Up'),
             x_date = coalesce(x_date, ((received_at at time zone public.automation_tz())::date + make_interval(months => term))::date),
             details = case when x_date is null then details || '{"x_date_estimated": true}'::jsonb else details end
       where id = rec.id;
      perform public.automation_log_add(null, 'Shot clock', null, null, rec.id, null, 'info', 'No activity for ' || sc_days || ' days: tagged Aged, disposition Follow Up' || case when rec.x_date is null then ', X-date estimated' else '' end);
      perform public.automation_enroll_lead_trigger('Lead has no contact in', rec.id);
      n_aged := n_aged + 1;
    end loop;
  end if;

  -- d) X-date recycling: when the current policy is about to renew, the lead comes back as New with an X-Date tag
  x_lead := coalesce(nullif(cfg ->> 'xdate_lead_days', '')::int, 30);
  for rec in select l.id, l.agent_id, l.x_date, l.first_name, l.last_name from leads l
            where l.x_date is not null and l.x_date - x_lead <= today and l.x_date >= today - 7
              and l.status not in ('Sold', 'Bad Lead') and not l.do_not_call
              and (l.recycled_at is null or l.recycled_at < now() - interval '60 days')
            order by l.x_date limit 300 loop
    update leads set status = 'New Lead', recycled_at = now(), disposition = null,
           tags = array_append(array_remove(array_remove(tags, 'Aged'), 'X-Date'), 'X-Date'),
           details = details || jsonb_build_object('x_date_prev', rec.x_date, 'recycle_count', coalesce((details ->> 'recycle_count')::int, 0) + 1),
           x_date = (rec.x_date + make_interval(months => term))::date
     where id = rec.id;
    select coalesce(full_name, 'Unassigned') into v_agent_label from profiles where id = rec.agent_id;
    insert into tasks(label, icon, priority, due_date, due_time, assigned_to, assigned_label, lead_id, notes, done, source)
    values ('X-date: ' || trim(rec.first_name || ' ' || rec.last_name) || ' renews ' || to_char(rec.x_date, 'MM/DD'), '📞', 'high', today, '9:00 AM', rec.agent_id, coalesce(v_agent_label, 'Unassigned'), rec.id,
            'Their current policy renews on ' || to_char(rec.x_date, 'MM/DD/YYYY') || '. Good time to re-quote.', false, 'automation');
    perform public.automation_log_add(null, 'X-date', null, null, rec.id, null, 'info', 'Recycled: current policy renews ' || to_char(rec.x_date, 'MM/DD/YYYY'));
    n_x := n_x + 1;
  end loop;

  insert into agency_settings(key, value, updated_at) values ('automation_state', jsonb_build_object('last_daily', today, 'last_daily_at', now(), 'renewals', n_ren, 'birthdays', n_bd, 'aged', n_aged, 'recycled', n_x), now())
  on conflict (key) do update set value = agency_settings.value || excluded.value, updated_at = now();
  return jsonb_build_object('renewals', n_ren, 'birthdays', n_bd, 'aged', n_aged, 'recycled', n_x);
end $$;

-- 8. Work queue for the edge function ----------------------------------------
-- Claims up to p_limit due steps and returns everything needed to send them (merge fields already applied).
create or replace function public.automation_due(p_limit int default 40) returns setof jsonb
language plpgsql security definer set search_path = public as $$
declare e record; rule jsonb; step jsonb; L record; C record; P record; A record; S record; msg text; subj text;
        v_first text; v_name text; v_phone text; v_email text; v_dnc boolean; v_policy text; v_carrier text; v_expires date; v_amount numeric; v_agent text; v_agent_phone text; v_lead_id uuid; v_cust_id uuid; v_agent_id uuid;
        tz text; i int;
begin
  if not public.automation_enabled() then return; end if;
  tz := public.automation_tz();
  for e in update automation_enrollments x set claimed_at = now()
            where x.id in (select id from automation_enrollments
                            where status = 'active' and next_run_at <= now() and (claimed_at is null or claimed_at < now() - interval '15 minutes')
                            order by next_run_at limit greatest(p_limit, 1) for update skip locked)
          returning x.* loop
    select r into rule from jsonb_array_elements(public.automation_rules()) r where (r ->> 'id')::int = e.rule_id;
    if rule is null or not coalesce((rule ->> 'active')::boolean, false) then
      update automation_enrollments set status = 'stopped', stop_reason = 'sequence removed or paused', next_run_at = null, claimed_at = null where id = e.id;
      perform public.automation_log_add(e.id, e.rule_name, null, null, e.lead_id, e.customer_id, 'stopped', 'Stopped: sequence removed or paused');
      continue;
    end if;
    i := (e.plan -> e.step_no ->> 'i')::int;
    step := rule -> 'steps' -> i;
    if step is null then
      update automation_enrollments set status = 'done', next_run_at = null, claimed_at = null where id = e.id;
      perform public.automation_log_add(e.id, e.rule_name, e.step_no, null, e.lead_id, e.customer_id, 'done', 'Finished');
      continue;
    end if;
    v_lead_id := e.lead_id; v_cust_id := e.customer_id; v_agent_id := e.agent_id;
    v_first := null; v_name := null; v_phone := null; v_email := null; v_dnc := false; v_policy := null; v_carrier := null; v_expires := null; v_amount := null;
    if e.lead_id is not null then
      select * into L from leads where id = e.lead_id;
      if found then v_first := L.first_name; v_name := trim(L.first_name || ' ' || L.last_name); v_phone := L.phone; v_email := L.email; v_dnc := L.do_not_call; v_policy := L.policy_type; v_agent_id := coalesce(L.agent_id, v_agent_id); v_expires := L.x_date; v_carrier := L.prior_coverage; end if;
    elsif e.customer_id is not null then
      select * into C from customers where id = e.customer_id;
      if found then v_first := C.first_name; v_name := trim(C.first_name || ' ' || C.last_name); v_phone := C.phone; v_email := C.email; v_agent_id := coalesce(C.agent_id, v_agent_id); end if;
    end if;
    if e.policy_id is not null then
      select * into P from policies where id = e.policy_id;
      if found then v_policy := P.line; v_carrier := P.carrier; v_expires := P.expires_date; v_amount := P.fee_extended; v_agent_id := coalesce(P.csr_id, P.sold_by_id, v_agent_id); end if;
    end if;
    if e.sale_id is not null and v_amount is null then
      select * into S from sales where id = e.sale_id; if found then v_amount := S.fee_extended; v_policy := coalesce(v_policy, S.policy_type); v_carrier := coalesce(v_carrier, S.carrier); end if;
    end if;
    v_agent := null; v_agent_phone := null;
    if v_agent_id is not null then
      select * into A from profiles where id = v_agent_id;
      if found then v_agent := A.full_name; v_agent_phone := coalesce(A.telnyx_number, A.phone); end if;
    end if;
    msg := coalesce(step ->> 'message', ''); subj := coalesce(step ->> 'subject', '');
    msg := replace(replace(replace(replace(replace(replace(replace(replace(replace(msg,
            '{{name}}', coalesce(nullif(v_first, ''), 'there')), '{{first}}', coalesce(nullif(v_first, ''), 'there')), '{{full_name}}', coalesce(v_name, '')),
            '{{agent}}', coalesce(v_agent, 'MaxSave Insurance')), '{{agent_phone}}', coalesce(v_agent_phone, '')),
            '{{amount}}', case when v_amount is null then '' else '$' || to_char(v_amount, 'FM999,999,990.00') end),
            '{{policy}}', coalesce(v_policy, 'auto')), '{{carrier}}', coalesce(v_carrier, '')), '{{expires}}', case when v_expires is null then '' else to_char(v_expires, 'MM/DD/YYYY') end);
    subj := replace(replace(replace(replace(replace(subj, '{{name}}', coalesce(nullif(v_first, ''), 'there')), '{{agent}}', coalesce(v_agent, 'MaxSave Insurance')), '{{policy}}', coalesce(v_policy, 'auto')),
            '{{amount}}', case when v_amount is null then '' else '$' || to_char(v_amount, 'FM999,999,990.00') end), '{{expires}}', case when v_expires is null then '' else to_char(v_expires, 'MM/DD/YYYY') end);
    return next jsonb_build_object(
      'enrollment_id', e.id, 'rule_id', e.rule_id, 'rule_name', e.rule_name, 'trigger', e.trigger, 'step_no', e.step_no, 'step_index', i, 'steps_total', jsonb_array_length(e.plan),
      'action', step ->> 'action', 'time', step ->> 'time', 'subject', subj, 'message', msg,
      'lead_id', v_lead_id, 'customer_id', v_cust_id, 'policy_id', e.policy_id, 'agent_id', v_agent_id, 'agent_name', v_agent,
      'first_name', v_first, 'name', v_name, 'phone', v_phone, 'email', v_email, 'do_not_call', v_dnc,
      'sms_opted_out', exists (select 1 from sms_opt_outs o where right(regexp_replace(o.phone, '\D', '', 'g'), 10) = right(regexp_replace(coalesce(v_phone, ''), '\D', '', 'g'), 10) and v_phone is not null),
      'email_opted_out', exists (select 1 from email_opt_outs o where lower(o.email) = lower(coalesce(v_email, '')) and v_email is not null),
      'today', (now() at time zone tz)::date,
      'first_text', not exists (select 1 from messages m where m.direction = 'outbound' and ((v_lead_id is not null and m.lead_id = v_lead_id) or (v_lead_id is null and v_cust_id is not null and m.customer_id = v_cust_id))));
  end loop;
end $$;

create or replace function public.automation_advance(p_id bigint, p_status text, p_detail text, p_action text default null) returns void
language plpgsql security definer set search_path = public as $$
declare e record; nxt timestamptz;
begin
  select * into e from automation_enrollments where id = p_id; if not found then return; end if;
  perform public.automation_log_add(e.id, e.rule_name, e.step_no, p_action, e.lead_id, e.customer_id, p_status, p_detail);
  if e.step_no + 1 >= jsonb_array_length(e.plan) then
    update automation_enrollments set status = 'done', step_no = e.step_no + 1, next_run_at = null, claimed_at = null where id = p_id;
    perform public.automation_log_add(e.id, e.rule_name, e.step_no + 1, null, e.lead_id, e.customer_id, 'done', 'Finished');
  else
    nxt := (e.plan -> (e.step_no + 1) ->> 'due')::timestamptz;
    if nxt < now() then nxt := public.automation_business(now()); end if;
    update automation_enrollments set step_no = e.step_no + 1, next_run_at = nxt, claimed_at = null where id = p_id;
  end if;
end $$;

-- Health numbers for the Settings page (any active user may read).
create or replace function public.automation_status() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'enabled', public.automation_enabled(),
    'active', (select count(*) from automation_enrollments where status = 'active'),
    'due', (select count(*) from automation_enrollments where status = 'active' and next_run_at <= now()),
    'next_run_at', (select min(next_run_at) from automation_enrollments where status = 'active'),
    'sent_today', (select count(*) from automation_log where status in ('sent','task') and created_at >= (public.automation_today())::timestamp at time zone public.automation_tz()),
    'failed_today', (select count(*) from automation_log where status = 'failed' and created_at >= (public.automation_today())::timestamp at time zone public.automation_tz()),
    'state', coalesce((select value from agency_settings where key = 'automation_state'), '{}'::jsonb));
$$;

-- 9. Who may call what ------------------------------------------------------
revoke execute on function public.automation_enroll(jsonb, uuid, uuid, uuid, uuid, timestamptz, date, uuid, text) from public, anon, authenticated;
revoke execute on function public.automation_enroll_lead_trigger(text, uuid) from public, anon, authenticated;
revoke execute on function public.automation_stop_for(uuid, uuid, text, text[]) from public, anon, authenticated;
revoke execute on function public.automation_stop_phone(text, text) from public, anon, authenticated;
revoke execute on function public.automation_daily(boolean) from public, anon, authenticated;
revoke execute on function public.automation_due(int) from public, anon, authenticated;
revoke execute on function public.automation_advance(bigint, text, text, text) from public, anon, authenticated;
revoke execute on function public.automation_log_add(bigint, text, int, text, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.automation_enroll_manual(int, uuid, uuid) to authenticated;
grant execute on function public.automation_stop_manual(bigint) to authenticated;
grant execute on function public.automation_status() to authenticated;
grant execute on function public.automation_cfg() to authenticated;

-- 10. Realtime for the new tables (ignore if the publication already has them)
do $$ begin
  begin alter publication supabase_realtime add table public.emails; exception when duplicate_object then null; when undefined_object then null; end;
  begin alter publication supabase_realtime add table public.automation_enrollments; exception when duplicate_object then null; when undefined_object then null; end;
  begin alter publication supabase_realtime add table public.automation_log; exception when duplicate_object then null; when undefined_object then null; end;
end $$;

notify pgrst, 'reload schema';
select 'automation schema v6 ready' as result;
