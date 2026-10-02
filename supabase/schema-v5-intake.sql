-- schema-v5: real-time lead intake from vendors (EverQuote, MediaAlpha).
-- (v4 is the Telnyx schema; this file is independent of it and can be run before or after.)
-- Each vendor POSTs one lead (JSON) to a secret-named RPC endpoint:
--   https://<project>.supabase.co/rest/v1/rpc/hook_eq___EQ_SECRET__?apikey=<publishable key>
-- The secret is the function name. This file is a TEMPLATE: the real names live in
-- supabase/local-intake.sql (gitignored). Never commit the filled-in version; the repo is public.
-- Safe to re-run. Revision 2 (2026-10-01): EverQuote-specific mapping (vehicles, drivers, consent) + backfill.
-- Revision 3 (2026-10-01): vehicle body type, commute, garaging ZIP, each vehicle's primary driver; driver first/last, license state.

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
create index if not exists lead_intake_lead_idx     on public.lead_intake(lead_id);
-- The duplicate check below must be index-backed: outside callers get a ~3 second statement timeout and leads has 150k+ rows.
create index if not exists leads_vendor_lead_id_idx on public.leads ((details ->> 'vendor_lead_id'));
create index if not exists leads_phone_idx          on public.leads (phone);
alter table public.lead_intake enable row level security;
drop policy if exists "intake admin read" on public.lead_intake;
create policy "intake admin read" on public.lead_intake for select to authenticated using ((select public.is_admin()));

-- 2. Helpers.
-- Flatten any JSON shape into { normalisedkey: "value" }. Keys are lower-cased with punctuation removed
-- (first_name, firstName, "First Name" -> firstname). Shallower keys win; arrays contribute their first element.
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

create or replace function public.intake_bool(t text) returns boolean
language sql immutable as $$ select lower(coalesce(t, '')) in ('true', 't', 'yes', 'y', '1') $$;

-- 1990-01-05 (with or without a time part) -> 01/05/1990, the format the lead profile already uses. Anything else passes through.
create or replace function public.intake_date(t text) returns text
language sql immutable as $$
  select case when t ~ '^\d{4}-\d{2}-\d{2}' then substr(t, 6, 2) || '/' || substr(t, 9, 2) || '/' || substr(t, 1, 4) else nullif(t, '') end;
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

-- 3. Payload -> { first, last, phone, email, ext, prior, sr22, details }.
--    Generic mapping first (works for any vendor), then EverQuote's known structure fills in vehicles, drivers and consent.
create or replace function public.intake_map(p_vendor text, p jsonb) returns jsonb
language plpgsql immutable as $$
declare f jsonb := public.intake_flat(p);
        v_first text; v_last text; v_name text; v_digits text; v_phone text; v_ext text; v_sr22 boolean;
        d jsonb; ai jsonb; veh jsonb; drv jsonb;
begin
  v_first := public.intake_pick(f, 'firstname', 'first', 'fname', 'contactfirstname', 'givenname');
  v_last  := public.intake_pick(f, 'lastname', 'last', 'lname', 'contactlastname', 'surname', 'familyname');
  if v_first is null then
    v_name  := trim(coalesce(public.intake_pick(f, 'fullname', 'name', 'contactname', 'customername'), ''));
    v_first := nullif(split_part(v_name, ' ', 1), '');
    v_last  := nullif(trim(substr(v_name, length(split_part(v_name, ' ', 1)) + 1)), '');
  end if;
  v_digits := regexp_replace(coalesce(public.intake_pick(f, 'phone', 'phonenumber', 'primaryphone', 'homephone', 'mobilephone', 'cellphone', 'dayphone', 'phone1', 'contactphone', 'mobile', 'cell', 'telephone'), ''), '\D', '', 'g');
  if length(v_digits) = 11 and left(v_digits, 1) = '1' then v_digits := substr(v_digits, 2); end if;
  v_phone := case when length(v_digits) = 10 then '(' || substr(v_digits, 1, 3) || ') ' || substr(v_digits, 4, 3) || '-' || substr(v_digits, 7) else nullif(v_digits, '') end;
  v_ext   := public.intake_pick(f, 'eqleadid', 'leadid', 'leaduuid', 'uuid', 'externalid', 'transactionid', 'leadtoken', 'universalleadid', 'id');
  v_sr22  := public.intake_bool(public.intake_pick(f, 'sr22required', 'sr22'));

  d := jsonb_strip_nulls(jsonb_build_object(
    'vendor', p_vendor, 'vendor_lead_id', v_ext,
    'dob', public.intake_date(public.intake_pick(f, 'dob', 'dateofbirth', 'birthdate', 'birthday')),
    'gender', public.intake_pick(f, 'gender', 'sex'),
    'marital', public.intake_pick(f, 'maritalstatus', 'marital'),
    'license', public.intake_pick(f, 'licensestatus', 'license'),
    'address', public.intake_pick(f, 'address', 'address1', 'street', 'streetaddress', 'addressline1'),
    'city', public.intake_pick(f, 'city'),
    'state', coalesce(public.intake_pick(f, 'state', 'statecode', 'stateabbr'), 'CA'),
    'zip', public.intake_pick(f, 'zip', 'zipcode', 'postalcode', 'postal'),
    'vehicle', nullif(jsonb_strip_nulls(jsonb_build_object(
        'year', public.intake_pick(f, 'vehicleyear', 'modelyear', 'year'),
        'make', public.intake_pick(f, 'vehiclemake', 'make'),
        'model', public.intake_pick(f, 'vehiclemodel', 'model'),
        'vin', public.intake_pick(f, 'vin', 'vinnumber'))), '{}'::jsonb),
    'current_carrier', public.intake_pick(f, 'currentcarrier', 'currentinsurer', 'currentinsurancecompany', 'insurancecompany', 'carrier', 'insurer'),
    'insured', public.intake_pick(f, 'currentlyinsured', 'insured', 'hasinsurance'),
    'home_ownership', public.intake_pick(f, 'homeownership', 'ownhome', 'residencetype', 'homeowner'),
    'credit', public.intake_pick(f, 'creditrating', 'credit', 'creditscore')));

  -- EverQuote "Generic Webhook" JSON: lead.contact, lead.autoInsurance.{vehicles[],drivers[],customerProfile}, consent.
  ai := p #> '{lead,autoInsurance}';
  if jsonb_typeof(ai) = 'object' then
    if jsonb_typeof(ai -> 'vehicles') = 'array' then
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
               'year', case when (v ->> 'year') ~ '^\d{4}$' then to_jsonb((v ->> 'year')::int) else v -> 'year' end,
               'make', initcap(v ->> 'make'), 'model', v ->> 'model', 'trim', v ->> 'submodel', 'vin', v ->> 'vin',
               'use', v ->> 'primaryUse', 'mileage', (v ->> 'annualMileage') || ' mi/yr',
               'ownership', v ->> 'ownership', 'garaging', v ->> 'garageType', 'garage_zip', v ->> 'garageZipCode', 'coverage', v ->> 'coveragePackage',
               'type', v ->> 'vehicleType', 'commute', (v ->> 'oneWayDistance') || ' mi one way',
               'primary_driver', (select nullif(trim(initcap(coalesce(pd ->> 'firstName', '') || ' ' || coalesce(pd ->> 'lastName', ''))), '')
                                    from jsonb_array_elements(case when jsonb_typeof(ai -> 'drivers') = 'array' then ai -> 'drivers' else '[]'::jsonb end) pd
                                   where pd ->> 'driverId' = v ->> 'primaryDriverId' limit 1))) order by n)
        into veh from jsonb_array_elements(ai -> 'vehicles') with ordinality as t(v, n);
    end if;
    if jsonb_typeof(ai -> 'drivers') = 'array' then
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
               'name', nullif(trim(initcap(coalesce(x ->> 'firstName', '') || ' ' || coalesce(x ->> 'lastName', ''))), ''),
               'dob', public.intake_date(x ->> 'dateOfBirth'), 'gender', x ->> 'gender', 'marital', x ->> 'maritalStatus',
               'license', x ->> 'licenseStatus', 'relationship', x ->> 'relationshipToContact', 'occupation', x ->> 'occupation',
               'education', x ->> 'educationLevel', 'first', initcap(x ->> 'firstName'), 'last', initcap(x ->> 'lastName'),
               'license_state', upper(coalesce(x ->> 'licenseState', x ->> 'stateLicensed')), 'age_licensed', x ->> 'licenseObtainedAge',
               'violations', case when public.intake_bool(x ->> 'licenseEverSuspendedOrRevoked') then 'Suspension' end,
               'sr22', public.intake_bool(x ->> 'sr22Required'), 'primary', n = 1)) order by n),
             coalesce(bool_or(public.intake_bool(x ->> 'sr22Required')), false)
        into drv, v_sr22 from jsonb_array_elements(ai -> 'drivers') with ordinality as t(x, n);
    end if;
    d := d || jsonb_strip_nulls(jsonb_build_object(
      'dob', public.intake_date(coalesce(ai #>> '{customerProfile,dateOfBirth}', drv #>> '{0,dob}')),
      'gender', coalesce(ai #>> '{customerProfile,gender}', drv #>> '{0,gender}'),
      'marital', coalesce(ai #>> '{customerProfile,maritalStatus}', drv #>> '{0,marital}'),
      'license', drv #>> '{0,license}', 'license_state', drv #>> '{0,license_state}', 'violations', drv #>> '{0,violations}', 'occupation', drv #>> '{0,occupation}',
      'vehicles', veh, 'drivers', drv, 'driver2', drv -> 1,
      'vehicle', case when veh is not null then jsonb_strip_nulls(jsonb_build_object('year', veh #> '{0,year}', 'make', veh #> '{0,make}', 'model', veh #> '{0,model}', 'vin', veh #> '{0,vin}', 'use', veh #> '{0,use}', 'mileage', veh #> '{0,mileage}')) end,
      'coverage', case when veh #>> '{0,coverage}' is not null then jsonb_build_object('type', veh #>> '{0,coverage}') end,
      'credit', ai #>> '{customerProfile,credit,rating}', 'bankruptcy', ai #>> '{customerProfile,credit,bankruptcy}',
      'home_ownership', ai #>> '{customerProfile,residence,own}', 'residency_years', ai #>> '{customerProfile,residence,years}',
      'consent', nullif(jsonb_strip_nulls(jsonb_build_object('universal_lead_id', p #>> '{consent,universal_lead_id}', 'trusted_form_cert_url', p #>> '{consent,trusted_form_cert_url}')), '{}'::jsonb),
      'traffic_tier', p #>> '{lead,traffic_tier}', 'products', p #>> '{lead,products}'));
  end if;

  return jsonb_build_object('first', v_first, 'last', v_last, 'phone', v_phone,
    'email', lower(public.intake_pick(f, 'email', 'emailaddress', 'contactemail')), 'ext', v_ext, 'sr22', coalesce(v_sr22, false),
    'prior', public.intake_pick(f, 'currentcarrier', 'currentinsurer', 'currentinsurancecompany', 'insurancecompany'), 'details', d);
end $$;

-- 4. Store the payload, map it to a lead, skip duplicates. Always answers with JSON and never raises,
--    so the vendor sees a success response and does not retry-storm.
create or replace function public.intake_lead(p_vendor text, p_source text, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m jsonb; v_phone text; v_ext text; v_lead uuid; v_dup uuid; v_intake bigint;
begin
  insert into lead_intake(vendor, payload) values (p_vendor, coalesce(p, '{}'::jsonb)) returning id into v_intake;
  begin
    m := intake_map(p_vendor, p); v_phone := m ->> 'phone'; v_ext := m ->> 'ext';
    if v_phone is null and m ->> 'email' is null and coalesce(m ->> 'first', '') = '' then
      raise exception 'no name, phone or email found in payload';
    end if;

    -- Two separate lookups (never an OR) so each one uses its own index.
    if v_ext is not null then
      select id into v_dup from leads where details ->> 'vendor_lead_id' = v_ext and source = p_source limit 1;
    end if;
    if v_dup is null and v_phone is not null then
      select id into v_dup from leads where phone = v_phone and source = p_source and received_at > now() - interval '12 hours' limit 1;
    end if;
    if v_dup is not null then
      update lead_intake set status = 'duplicate', lead_id = v_dup where id = v_intake;
      return jsonb_build_object('ok', true, 'duplicate', true, 'lead_id', v_dup);
    end if;

    insert into leads(first_name, last_name, phone, email, status, policy_type, source, received_at, language, prior_coverage, sr22, details)
    values (initcap(coalesce(m ->> 'first', '')), initcap(coalesce(m ->> 'last', '')), v_phone, m ->> 'email', 'New Lead', 'Auto', p_source, now(), 'English',
            m ->> 'prior', coalesce((m ->> 'sr22')::boolean, false), (m -> 'details') || jsonb_build_object('intake_id', v_intake))
    returning id into v_lead;
    update lead_intake set status = 'inserted', lead_id = v_lead where id = v_intake;
    return jsonb_build_object('ok', true, 'lead_id', v_lead);
  exception when others then
    update lead_intake set status = 'error', error = sqlerrm where id = v_intake;
    return jsonb_build_object('ok', false, 'error', sqlerrm, 'intake_id', v_intake);
  end;
end $$;

-- 5. Public endpoints. The single unnamed jsonb parameter receives the whole request body.
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

-- 6. Lock down: only the three hook functions are callable from outside.
revoke execute on function public.intake_lead(text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.intake_map(text, jsonb) from public, anon, authenticated;
revoke execute on function public.intake_flat(jsonb, int) from public, anon, authenticated;
revoke execute on function public.intake_pick(jsonb, text[]) from public, anon, authenticated;
revoke execute on function public.intake_bool(text) from public, anon, authenticated;
revoke execute on function public.intake_date(text) from public, anon, authenticated;
revoke execute on function public.intake_shape(jsonb, int) from public, anon, authenticated;
grant execute on function public.hook_eq___EQ_SECRET__(jsonb) to anon, authenticated;
grant execute on function public.hook_ma___MA_SECRET__(jsonb) to anon, authenticated;
grant execute on function public.hook_status___ST_SECRET__() to anon, authenticated;

-- 7. Backfill: re-map every lead that came in through a hook with the current mapping (vendor values win over the
--    earlier, thinner mapping; anything an agent added under other keys is kept). Idempotent.
update public.leads l
   set details = l.details || (x.m -> 'details'),
       sr22 = l.sr22 or coalesce((x.m ->> 'sr22')::boolean, false),
       prior_coverage = coalesce(l.prior_coverage, x.m ->> 'prior')
  from public.lead_intake i
 cross join lateral (select public.intake_map(i.vendor, i.payload) as m) x
 where i.lead_id = l.id and i.status = 'inserted';

notify pgrst, 'reload schema';

select 'lead intake ready (rev 3)' as result;
