-- 2026-09-30: remove duplicate leads created by a dyl-import run that signed in as an agent.
-- The agent login could not see leads assigned to Tony (RLS), so the importer re-inserted ~800 of them
-- as unassigned copies, plus their [DYL] notes, before failing on a customer_no collision.
-- Run in Supabase SQL Editor. Step 1 only counts; step 2 deletes; step 3 verifies.

-- 1. Count the copies: unassigned leads whose DYL id also exists on an assigned lead.
select count(*) as duplicate_leads
  from public.leads l
 where l.agent_id is null
   and l.details->>'dyl_id' is not null
   and exists (select 1 from public.leads o
                where o.details->>'dyl_id' = l.details->>'dyl_id'
                  and o.id <> l.id and o.agent_id is not null);

-- 2. Delete their notes, then the copies.
with dup as (
  select l.id
    from public.leads l
   where l.agent_id is null
     and l.details->>'dyl_id' is not null
     and exists (select 1 from public.leads o
                  where o.details->>'dyl_id' = l.details->>'dyl_id'
                    and o.id <> l.id and o.agent_id is not null)
)
delete from public.notes n using dup where n.lead_id = dup.id;

delete from public.leads l
 where l.agent_id is null
   and l.details->>'dyl_id' is not null
   and exists (select 1 from public.leads o
                where o.details->>'dyl_id' = l.details->>'dyl_id'
                  and o.id <> l.id and o.agent_id is not null);

-- 3. Verify: expect 0 duplicates and one row per DYL id.
select 'duplicate leads left' as check, count(*) from public.leads l
 where l.details->>'dyl_id' is not null
   and exists (select 1 from public.leads o where o.details->>'dyl_id' = l.details->>'dyl_id' and o.id <> l.id)
union all
select 'leads total', count(*) from public.leads
union all
select 'orphan notes', count(*) from public.notes n where n.lead_id is not null and not exists (select 1 from public.leads l where l.id = n.lead_id);
