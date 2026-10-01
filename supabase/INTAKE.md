# Real-time lead intake from vendors (started 2026-10-01)

Goal: every lead a vendor sells us lands in the CRM within seconds, without DYL in the middle.
Kept in this file (not HANDOFF.md) because a second session was editing HANDOFF.md the same day for Telnyx.

## How it works
- Vendor POSTs one lead as JSON to a secret URL on the Supabase REST API:
  `https://xcwkkynxgojmabxdrngm.supabase.co/rest/v1/rpc/hook_<vendor>_<secret>?apikey=<publishable key>`
- The URL is a Postgres function (`supabase/schema-v5-intake.sql`). It saves the raw payload to `lead_intake`,
  maps it to a row in `leads` (source `Everquote` / `MediaAlpha`, status `New Lead`, unassigned), and skips duplicates
  (same vendor lead id, or same phone from the same vendor within 12 hours). It never raises, so vendors do not retry-storm.
- The CRM already listens for new `leads` rows over realtime, so they appear without a refresh.
- Field mapping is format-agnostic: keys are normalised (`first_name`, `firstName`, `First Name` → `firstname`) and searched
  at any nesting depth. If a vendor's real format has fields we miss, the raw payload is still in `lead_intake` to re-map.

## Files
- `supabase/schema-v5-intake.sql` — TEMPLATE with `__EQ_SECRET__`, `__MA_SECRET__`, `__ST_SECRET__` placeholders. Safe to commit.
- `supabase/local-intake.sql`, `local-intake-urls.txt`, `local-intake-secrets.json` — the filled-in SQL, the three real URLs,
  and the secrets. **Gitignored (`supabase/local-*`). Never commit: the repo is public and the URL is the only credential.**
  They exist only on the desktop PC (and wherever OneDrive syncs the folder).
- `tools/intake-sql-test.mjs` — runs the template in PGlite with stand-in tables; 27 checks. `node tools/intake-sql-test.mjs`
  (needs `@electric-sql/pglite`; defaults to the copy in `~/fulfillment-ims/node_modules`, override with `PGLITE=`).
- `tools/vendor/portal.js` — headless Edge driver for vendor portals (`node portal.js everquote|mediaalpha <cmd>`).
  Credentials come from Tony in chat; nothing is stored.

## Health check (no login needed)
POST an empty JSON body to the status URL in `local-intake-urls.txt`. It returns counts per vendor and status for the
last 24 hours, the 15 most recent intake rows (id, time, vendor, status, error), and the *shape* of each vendor's latest
payload (field names and types only, never customer values).

## Vendor findings (2026-10-01)
**EverQuote Pro** (`pro.everquote.com`, Okta login, no MFA prompt)
- 4 active campaigns: AGP Standard - Throttle, AGP StandardNonstandard - Throttle, Non-Standard No Throttle: Weekend,
  Standard No Throttle: Weekend.
- Each delivers to: Email (tonyb@, contact@, a Zapier mailbox), PL Rater, and two lead systems: **Ricochet** (Post URL) and **DYL**.
- Campaign → Delivery tab → Lead Management Systems offers **Generic Webhook** with two fields: *Data Format* (JSON or XML)
  and *Post URL*. Plan: add Generic Webhook / JSON / the EverQuote URL to all four campaigns, leaving Ricochet and DYL in place.
- The Delivery tab is itself an edit form (Save & continue / Cancel). Deep links to a campaign froze headless Edge once;
  navigate by clicking the campaign row instead.

**MediaAlpha** (`insurance-exchange.mediaalpha.com`)
- Login needs a 6-digit code emailed to tonyb@maxsaveins.com on every new device (valid 10 minutes). Tony has to read it
  out; Claude is not permitted to pull it from email. Portal not yet explored.

**Unknown:** September data shows a source called `usmg` (~1,440 leads/month). Tony to say which vendor/portal that is.

## Status
- [x] Intake SQL written and tested locally (27/27)
- [ ] Tony runs `supabase/local-intake.sql` in the Supabase SQL Editor
- [ ] Live test post + health check
- [ ] Add Generic Webhook to the 4 EverQuote campaigns
- [ ] MediaAlpha: get past the email code, find its delivery settings, point it at the MediaAlpha URL
- [ ] Watch the first real payloads (`latest_shape`) and tighten the field mapping
- [ ] Once webhooks are live, DYL top-up imports must dedupe against webhook leads (they have no `dyl_id`):
      match on phone + received date before inserting, or stop the top-ups.
