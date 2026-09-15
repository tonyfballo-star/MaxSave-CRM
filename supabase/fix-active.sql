-- MSIHub — activate the owner login and stop new dashboard-created logins from starting inactive (2026-09-15)
-- Paste into Supabase > SQL Editor > New query > Run.

update public.profiles
   set active = true, role = 'admin', full_name = 'Tony Ballo'
 where lower(email) = 'tonyb@maxsaveins.com';

-- Logins created in the Supabase dashboard are not yet "confirmed" at the moment the
-- profile trigger fires, so profiles must start active. Public self-registration is
-- prevented by turning off "Allow new users to sign up" in Authentication > Sign In / Providers > Email.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, role, active)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)),
    case when lower(new.email) in ('tonyb@maxsaveins.com', 'tonyfballo@gmail.com') then 'admin' else 'agent' end,
    true
  )
  on conflict (id) do update set email = excluded.email;
  return new;
end $$;

select email, full_name, role, active from public.profiles order by created_at;
