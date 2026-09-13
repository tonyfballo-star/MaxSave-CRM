# MSIHub backend — how it fits together

| File | Purpose |
|------|---------|
| `schema.sql` | Database tables, access rules, storage bucket, default templates. Re-runnable. |
| `patch-crm.js` | One-time script that wired `maxsave_crm.html` to the database (already applied). |
| `CONFIG.md` | Project URL + publishable key, setup log. |
| `../msihub-data.js` | Runtime data layer loaded by the CRM: login screen, loads data, saves changes, live updates. |
| `../site/` | Deployable copy for Netlify (`index.html` + `msihub-data.js`). Rebuild with: `cp maxsave_crm.html site/index.html && cp msihub-data.js site/` |
| `../tools/smoke.js` | Headless smoke test. See header comment. |

## Access rules (Row Level Security)
- Any active, signed-in user can read agency data and add/update records.
- Leads: agents see their own + unassigned; admins see all.
- Delete is admin-only (customers, sales, templates, files...).
- `tonyfballo@gmail.com` is made admin automatically; promote others with:
  `update public.profiles set role = 'admin' where email = 'agent@example.com';`
- Deactivate someone (keeps their history): `update public.profiles set active = false where email = '...';`

## Still in-memory (not saved yet)
Tasks, Inbox/Live View sample data, Agent Management goals/tiers, Carriers, Vendors, Lead Sources, Lifecycle rules, Time cards. These come in a later step.
