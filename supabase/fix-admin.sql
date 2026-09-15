-- =====================================================================
--  MSIHub — admin role fix + sign-up hardening + QA cleanup (2026-09-15)
--  Paste into Supabase > SQL Editor > New query > Run. Safe to re-run.
-- =====================================================================

-- 1. Make the agency owner an admin (the bootstrap only knew the gmail address)
update public.profiles
   set role = 'admin', active = true
 where lower(email) in ('tonyb@maxsaveins.com', 'tonyfballo@gmail.com');

-- 2. Future logins: owner addresses become admin; everyone else is an agent.
--    A profile is only ACTIVE when the login was created confirmed (i.e. by an
--    admin in the Supabase dashboard with "Auto Confirm User"). Anyone who
--    self-registers through the public sign-up endpoint gets an inactive
--    profile and cannot read any agency data — even if sign-ups are left on.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, role, active)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)),
    case when lower(new.email) in ('tonyb@maxsaveins.com', 'tonyfballo@gmail.com') then 'admin' else 'agent' end,
    (new.email_confirmed_at is not null)
  )
  on conflict (id) do update set email = excluded.email;
  return new;
end $$;

-- 3. Remove the records the live test created (lead + its notes/quotes cascade)
delete from public.appointments where contact_name like 'ZZ QA%';
delete from public.messages     where contact_name like 'ZZ QA%';
delete from public.leads        where first_name   like 'ZZ QA%';

-- 4. Show the result
select email, full_name, role, active from public.profiles order by created_at;
