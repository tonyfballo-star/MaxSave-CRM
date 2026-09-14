# MSIHub — Supabase connection

Project ref: `xcwkkynxgojmabxdrngm`
Project URL: `https://xcwkkynxgojmabxdrngm.supabase.co`
Live site (Netlify): `https://stellular-cuchufli-1dd0d7.netlify.app/`  (site id ba46785b-f37b-4cc9-80c8-b92ddc7dd684; redeploy = drag `site/` or `msihub-site.zip` to app.netlify.com/drop, or Deploys > drag-and-drop on the site page)

Publishable key (safe to ship in the app):
`sb_publishable__FNJF77rVOr5kbP2grko_w_0sIz3GDM`

Legacy anon key (same purpose, older format):
`eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhjd2treW54Z29qbWFieGRybmdtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkyNDc3ODcsImV4cCI6MjEwNDgyMzc4N30.1UO0uVrqOKvTnzOQ0VwsLFZ6xRV03ZDfVK4vSD7-8_g`

Never put the `secret` / `service_role` key or the database password in this repo.

## Setup log
- 2026-09-12: project created, keys verified, email auth enabled. `schema.sql` written (not yet run).
- 2026-09-12: schema.sql run by Tony; all 15 tables verified; users invited.
- 2026-09-12: CRM wired to Supabase. `msihub-data.js` = data layer (login, loads all tables, saves every write). `supabase/patch-crm.js` = the one-time patch applied to maxsave_crm.html (40 edits, sample data removed). `site/` = deployable copy (index.html + msihub-data.js) for Netlify. `tools/smoke.js` = headless Edge smoke test (28 steps, all passing).
- NEXT: host `site/` on Netlify, then set Supabase Auth > URL Configuration > Site URL to the Netlify address (invite emails redirect there), re-send invites, log in and test with real data.
- 2026-09-12: deployed to Netlify (public). Supabase built-in email hit rate limit; users to be created with passwords directly in dashboard.
- 2026-09-14: schema-v2.sql written (profiles agent columns, tasks, agency_settings). msihub-data-2.js + patches 3/4 applied: tasks, settings lists, agent profiles, live view/inbox, reports, goals all live. Smoke 43/43.
