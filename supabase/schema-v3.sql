-- =====================================================================
--  MSIHub — schema v3: make access rules fast at 150k+ rows (2026-09-17)
--  The v1 rules called is_active_user()/is_admin()/auth.uid() once PER ROW,
--  which times out now that the DYL history is loaded. Wrapping each call
--  in (select ...) makes Postgres evaluate it once per query instead.
--  Also adds the indexes the imported data needs.
--  Paste into Supabase > SQL Editor > New query > Run. Safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Indexes for the working-set queries and the DYL id lookups
-- ---------------------------------------------------------------------
create index if not exists leads_status_received_idx on public.leads(status, received_at desc);
create index if not exists leads_dyl_id_idx          on public.leads((details->>'dyl_id'));
create index if not exists leads_dyl_assigned_idx    on public.leads((details->>'dyl_assigned'));
create index if not exists leads_created_by_idx      on public.leads(created_by);
create index if not exists leads_name_idx            on public.leads(last_name, first_name);
create index if not exists customers_lead_idx        on public.customers(lead_id);
create index if not exists notes_created_idx         on public.notes(created_at desc);
create index if not exists quotes_created_idx        on public.quotes(created_at desc);

-- ---------------------------------------------------------------------
-- 2. Row Level Security: same rules, evaluated once per query
-- ---------------------------------------------------------------------
-- profiles
drop policy if exists "profiles read"        on public.profiles;
drop policy if exists "profiles self update" on public.profiles;
drop policy if exists "profiles admin write" on public.profiles;
create policy "profiles read"        on public.profiles for select to authenticated using ((select public.is_active_user()));
create policy "profiles self update" on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()) and role = (select p.role from public.profiles p where p.id = (select auth.uid())));
create policy "profiles admin write" on public.profiles for all    to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- leads (agents see their own + unassigned; admins see all)
drop policy if exists "leads read"   on public.leads;
drop policy if exists "leads insert" on public.leads;
drop policy if exists "leads update" on public.leads;
drop policy if exists "leads delete" on public.leads;
create policy "leads read"   on public.leads for select to authenticated using ((select public.is_active_user()) and ((select public.is_admin()) or agent_id is null or agent_id = (select auth.uid())));
create policy "leads insert" on public.leads for insert to authenticated with check ((select public.is_active_user()));
create policy "leads update" on public.leads for update to authenticated using ((select public.is_active_user()) and ((select public.is_admin()) or agent_id is null or agent_id = (select auth.uid())));
create policy "leads delete" on public.leads for delete to authenticated using ((select public.is_admin()));

-- every other table: read/insert/update for active users, delete for admins
do $$
declare t text;
begin
  foreach t in array array['customers','sales','policies','vehicles','drivers','claims','quotes','appointments','notes','call_log','messages','templates','files']
  loop
    execute format('drop policy if exists "%s read"   on public.%I', t, t);
    execute format('drop policy if exists "%s insert" on public.%I', t, t);
    execute format('drop policy if exists "%s update" on public.%I', t, t);
    execute format('drop policy if exists "%s delete" on public.%I', t, t);
    execute format('create policy "%s read"   on public.%I for select to authenticated using ((select public.is_active_user()))', t, t);
    execute format('create policy "%s insert" on public.%I for insert to authenticated with check ((select public.is_active_user()))', t, t);
    execute format('create policy "%s update" on public.%I for update to authenticated using ((select public.is_active_user()))', t, t);
    execute format('create policy "%s delete" on public.%I for delete to authenticated using ((select public.is_admin()))', t, t);
  end loop;
end $$;

-- tasks + agency_settings (from v2)
drop policy if exists "tasks read"   on public.tasks;
drop policy if exists "tasks insert" on public.tasks;
drop policy if exists "tasks update" on public.tasks;
drop policy if exists "tasks delete" on public.tasks;
create policy "tasks read"   on public.tasks for select to authenticated using ((select public.is_active_user()));
create policy "tasks insert" on public.tasks for insert to authenticated with check ((select public.is_active_user()));
create policy "tasks update" on public.tasks for update to authenticated using ((select public.is_active_user()));
create policy "tasks delete" on public.tasks for delete to authenticated using ((select public.is_admin()) or created_by = (select auth.uid()));
drop policy if exists "settings read"  on public.agency_settings;
drop policy if exists "settings write" on public.agency_settings;
create policy "settings read"  on public.agency_settings for select to authenticated using ((select public.is_active_user()));
create policy "settings write" on public.agency_settings for all    to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- storage
drop policy if exists "files bucket read"   on storage.objects;
drop policy if exists "files bucket insert" on storage.objects;
drop policy if exists "files bucket delete" on storage.objects;
create policy "files bucket read"   on storage.objects for select to authenticated using (bucket_id = 'files' and (select public.is_active_user()));
create policy "files bucket insert" on storage.objects for insert to authenticated with check (bucket_id = 'files' and (select public.is_active_user()));
create policy "files bucket delete" on storage.objects for delete to authenticated using (bucket_id = 'files' and (select public.is_admin()));

-- ---------------------------------------------------------------------
-- 3. Link imported DYL records to agent logins (re-run any time after
--    new agent logins are created; matches on the exact full name)
-- ---------------------------------------------------------------------
update public.leads l
   set agent_id = p.id
  from public.profiles p
 where l.agent_id is null
   and l.details->>'dyl_assigned' = p.full_name;

update public.customers c
   set agent_id = coalesce(c.agent_id, l.agent_id), sold_by_id = coalesce(c.sold_by_id, l.agent_id)
  from public.leads l
 where c.lead_id = l.id and l.agent_id is not null and (c.agent_id is null or c.sold_by_id is null);

-- 4. Clean up the QA test records
delete from public.appointments where contact_name like 'ZZ QA%';
delete from public.messages     where contact_name like 'ZZ QA%';
delete from public.leads        where first_name   like 'ZZ QA%';

select 'leads' as t, count(*) from public.leads
union all select 'customers', count(*) from public.customers
union all select 'assigned leads', count(*) from public.leads where agent_id is not null;
