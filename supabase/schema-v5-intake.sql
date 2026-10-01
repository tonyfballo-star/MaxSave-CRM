-- schema-v5: real-time lead intake from vendors (EverQuote, MediaAlpha).
-- (v4 is the Telnyx schema; this file is independent of it and can be run before or after.)
-- Each vendor POSTs one lead (JSON) to a secret-named RPC endpoint:
--   https://<project>.supabase.co/rest/v1/rpc/hook_eq___EQ_SECRET__?apikey=<publishable key>
-- The secret is the function name. This file is a TEMPLATE: the real names live in
-- supabase/local-intake.sql (gitignored). Never commit the filled-in version; the repo is public.
-- Safe to re-run.

-- 1. Every payload is kept verbatim, so a mapping gap never loses a lead.
create table if not exists public.lead_intake (
  id          bigint generated always as identity primary key,
  vendor      text not null,
  received_at timestamptz not null default now(),
  payload     jsonb not null,
  status      text not null default 'new',        -- inserted | duplicate | error
  lead_id     uuid references public.leads(id) on delete set null,
  error       text
);
create index if not exists lead_intake_received_idx on public.lead_intake(received_at desc);
alter table public.lead_intake enable row level security;
drop policy if exists "intake admin read" on public.lead_intake;
create policy "intake admin read" on public.lead_intake for select to authenticated using ((select public.is_admin()));

-- 2. Flatten any JSON shape into { normalisedkey: "value" }. Keys are lower-cased with punctuation removed
--    (first_name, firstName, "First Name" -> firstname). Shallower keys win; arrays contribute their first element.
create or replace function public.intake_flat(p jsonb, depth int default 0) returns jsonb
language plpgsql immutable as $$
declare outp jsonb := '{}'::jsonb; r record; nk text;
begin
  if p is null or depth > 6 then return outp; end if;
  if jsonb_typeof(p) = 'array' then
    if jsonb_array_length(p) > 0 then return public.intake_flat(p -> 0, depth + 1); end if;
    return outp;
  elsif jsonb_typeof(p) <> 'object' then return outp; end if;
  for r in select key, value from jsonb_each(p) loop
    if jsonb_typeof(r.value) in ('string', 'number', 'boolean') and coalesce(r.value #>> '{}', '') <> '' then
      nk := regexp_replace(lower(r.key), '[^a-z0-9]', '', 'g');
      if nk <> '' and not outp ? nk then outp := outp || jsonb_build_object(nk, r.value #>> '{}'); end if;
    end if;
  end loop;
  for r in select key, value from jsonb_each(p) loop
    if jsonb_typeof(r.value) in ('object', 'array') then outp := public.intake_flat(r.value, depth + 1) || outp; end if;
  end loop;
  return outp;
end $$;

create or replace function public.intake_pick(f jsonb, variadic keys text[]) returns text
language sql immutable as $$
  select f ->> k from unnest(keys) with ordinality as t(k, n) where f ? k order by n limit 1;
$$;

-- Same structure with every value replaced by its type: lets us study a vendor's format without exposing customer data.
create or replace function public.intake_shape(p jsonb, depth int default 0) returns jsonb
language plpgsql immutable as $$
begin
  if p is null then return 'null'::jsonb; end if;
  if depth > 6 then return '"…"'::jsonb; end if;
  if jsonb_typeof(p) = 'object' then
    return coalesce((select jsonb_object_agg(key, public.intake_shape(value, depth + 1)) from jsonb_each(p)), '{}'::jsonb);
  elsif jsonb_typeof(p) = 'array' then
    return case when jsonb_array_length(p) = 0 then '[]'::jsonb else jsonb_build_array(public.intake_shape(p -> 0, depth + 1)) end;
  end if;
  return to_jsonb(jsonb_typeof(p));
end $$;

-- 3. Store the payload, map it to a lead, skip duplicates. Always answers with JSON and never raises,
--    so the vendor sees a success response and does not retry-storm.
create or replace function public.intake_lead(p_vendor text, p_source text, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare f jsonb; v_first text; v_last text; v_name text; v_digits text; v_phone text; v_email text; v_ext text;
        v_lead uuid; v_dup uuid; v_intake bigint; v_details jsonb;
begin
  insert into lead_intake(vendor, payload) values (p_vendor, coalesce(p, '{}'::jsonb)) returning id into v_intake;
  begin
    f := intake_flat(p);
    v_first := intake_pick(f, 'firstname', 'first', 'fname', 'contactfirstname', 'givenname');
    v_last  := intake_pick(f, 'lastname', 'last', 'lname', 'contactlastname', 'surname', 'familyname');
    if v_first is null then
      v_name  := trim(coalesce(intake_pick(f, 'fullname', 'name', 'contactname', 'customername'), ''));
      v_first := nullif(split_part(v_name, ' ', 1), '');
      v_last  := nullif(trim(substr(v_name, length(split_part(v_name, ' ', 1)) + 1)), '');
    end if;
    v_digits := regexp_replace(coalesce(intake_pick(f, 'phone', 'phonenumber', 'primaryphone', 'homephone', 'mobilephone', 'cellphone', 'dayphone', 'phone1', 'contactphone', 'mobile', 'cell', 'telephone'), ''), '\D', '', 'g');
    if length(v_digits) = 11 and left(v_digits, 1) = '1' then v_digits := substr(v_digits, 2); end if;
    v_phone := case when length(v_digits) = 10 then '(' || substr(v_digits, 1, 3) || ') ' || substr(v_digits, 4, 3) || '-' || substr(v_digits, 7) else nullif(v_digits, '') end;
    v_email := lower(intake_pick(f, 'email', 'emailaddress', 'contactemail'));
    v_ext   := intake_pick(f, 'leadid', 'leaduuid', 'uuid', 'externalid', 'transactionid', 'leadtoken', 'universalleadid', 'id');
    if v_phone is null and v_email is null and coalesce(v_first, '') = '' then
      raise exception 'no name, phone or email found in payload';
    end if;

    select id into v_dup from leads
     where source = p_source
       and ((v_ext is not null and details ->> 'vendor_lead_id' = v_ext)
         or (v_phone is not null and phone = v_phone and received_at > now() - interval '12 hours'))
     limit 1;
    if v_dup is not null then
      update lead_intake set status = 'duplicate', lead_id = v_dup where id = v_intake;
      return jsonb_build_object('ok', true, 'duplicate', true, 'lead_id', v_dup);
    end if;

    v_details := jsonb_strip_nulls(jsonb_build_object(
      'vendor', p_vendor, 'vendor_lead_id', v_ext, 'intake_id', v_intake,
      'dob', intake_pick(f, 'dob', 'dateofbirth', 'birthdate', 'birthday'),
      'gender', intake_pick(f, 'gender', 'sex'),
      'marital', intake_pick(f, 'maritalstatus', 'marital'),
      'address', intake_pick(f, 'address', 'address1', 'street', 'streetaddress', 'addressline1'),
      'city', intake_pick(f, 'city'),
      'state', coalesce(intake_pick(f, 'state', 'statecode', 'stateabbr'), 'CA'),
      'zip', intake_pick(f, 'zip', 'zipcode', 'postalcode', 'postal'),
      'vehicle', nullif(jsonb_strip_nulls(jsonb_build_object(
          'year', intake_pick(f, 'vehicleyear', 'modelyear', 'year'),
          'make', intake_pick(f, 'vehiclemake', 'make'),
          'model', intake_pick(f, 'vehiclemodel', 'model'),
          'vin', intake_pick(f, 'vin', 'vinnumber'))), '{}'::jsonb),
      'current_carrier', intake_pick(f, 'currentcarrier', 'currentinsurer', 'currentinsurancecompany', 'insurancecompany', 'carrier', 'insurer'),
      'insured', intake_pick(f, 'currentlyinsured', 'insured', 'hasinsurance'),
      'home_ownership', intake_pick(f, 'homeownership', 'ownhome', 'residencetype', 'homeowner'),
      'credit', intake_pick(f, 'credit', 'creditrating', 'creditscore')));

    insert into leads(first_name, last_name, phone, email, status, policy_type, source, received_at, language, prior_coverage, details)
    values (initcap(coalesce(v_first, '')), initcap(coalesce(v_last, '')), v_phone, v_email, 'New Lead', 'Auto', p_source, now(), 'English',
            intake_pick(f, 'currentcarrier', 'currentinsurer', 'currentinsurancecompany', 'insurancecompany'), v_details)
    returning id into v_lead;
    update lead_intake set status = 'inserted', lead_id = v_lead where id = v_intake;
    return jsonb_build_object('ok', true, 'lead_id', v_lead);
  exception when others then
    update lead_intake set status = 'error', error = sqlerrm where id = v_intake;
    return jsonb_build_object('ok', false, 'error', sqlerrm, 'intake_id', v_intake);
  end;
end $$;

-- 4. Public endpoints. The single unnamed jsonb parameter receives the whole request body.
create or replace function public.hook_eq___EQ_SECRET__(jsonb) returns jsonb
language sql security definer set search_path = public as $$ select public.intake_lead('everquote', 'Everquote', $1) $$;

create or replace function public.hook_ma___MA_SECRET__(jsonb) returns jsonb
language sql security definer set search_path = public as $$ select public.intake_lead('mediaalpha', 'MediaAlpha', $1) $$;

-- Health check: counts and the SHAPE (types only, no values) of the latest payload per vendor.
create or replace function public.hook_status___ST_SECRET__() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'last_24h', coalesce((select jsonb_object_agg(k, n) from (select vendor || ':' || status as k, count(*) as n from lead_intake where received_at > now() - interval '24 hours' group by 1) t), '{}'::jsonb),
    'total', (select count(*) from lead_intake),
    'recent', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'at', received_at, 'vendor', vendor, 'status', status, 'error', error) order by id desc) from (select * from lead_intake order by id desc limit 15) r), '[]'::jsonb),
    'latest_shape', coalesce((select jsonb_object_agg(vendor, public.intake_shape(payload)) from (select distinct on (vendor) vendor, payload from lead_intake order by vendor, id desc) s), '{}'::jsonb));
$$;

-- 5. Lock down: only the three hook functions are callable from outside.
revoke execute on function public.intake_lead(text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.intake_flat(jsonb, int) from public, anon, authenticated;
revoke execute on function public.intake_pick(jsonb, text[]) from public, anon, authenticated;
revoke execute on function public.intake_shape(jsonb, int) from public, anon, authenticated;
grant execute on function public.hook_eq___EQ_SECRET__(jsonb) to anon, authenticated;
grant execute on function public.hook_ma___MA_SECRET__(jsonb) to anon, authenticated;
grant execute on function public.hook_status___ST_SECRET__() to anon, authenticated;

notify pgrst, 'reload schema';

select 'lead intake ready' as result;
