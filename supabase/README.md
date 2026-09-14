# MSIHub backend — how it fits together

| File | Purpose |
|------|---------|
| `schema.sql` | Database tables, access rules, storage bucket, default templates. Re-runnable. |
| `schema-v2.sql` | Adds agent settings on profiles, the tasks table, and the agency_settings key/value store. Re-runnable. |
| `patch-crm.js`, `patch-2-pdfs.js`, `patch-3-cleanup.js`, `patch-4-goals.js` | One-time scripts that rewired `maxsave_crm.html` (all applied, all idempotent). |
| `CONFIG.md` | Project URL + publishable key, setup log. |
| `../msihub-data.js` | Runtime data layer: login screen, loads data, saves Leads/Customers/Sales/Notes/Texts/Files, live updates. |
| `../msihub-data-2.js` | Settings lists, agent profiles, Tasks, Live View/Inbox history, Reports numbers — all from the database. |
| `../site/` | Deployable copy for Netlify (`index.html` + `msihub-data.js`). Rebuild with: `cp maxsave_crm.html site/index.html && cp msihub-data.js msihub-data-2.js site/` |
| `../tools/smoke.js` | Headless smoke test. See header comment. |

## Access rules (Row Level Security)
- Any active, signed-in user can read agency data and add/update records.
- Leads: agents see their own + unassigned; admins see all.
- Delete is admin-only (customers, sales, templates, files...).
- `tonyfballo@gmail.com` is made admin automatically; promote others with:
  `update public.profiles set role = 'admin' where email = 'agent@example.com';`
- Deactivate someone (keeps their history): `update public.profiles set active = false where email = '...';`

## Still not connected
Real calling/texting (Twilio), email inbox, e-sign delivery, payment terminal. Everything else reads and writes the database.

## Adding an agent
Logins are created in Supabase: Authentication → Users → Add user → Create new user (turn on Auto Confirm). The profile row is created automatically and the agent appears in the CRM. Deactivating from the CRM sets `active = false` (the login stays but can no longer sign in).
