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

## Status (updated 2026-10-01, 4:30 PM PT)
- [x] Intake SQL written and tested locally (`node tools/intake-sql-test.mjs`, 46 checks incl. a 150k-row table)
- [x] Tony ran `supabase/local-intake.sql` (rev 1) in the SQL Editor. First live test hit the anon statement timeout: the duplicate
      check was an OR across an unindexed jsonb expression on 150k leads. Fixed with two indexed lookups; re-run; live test passes.
- [x] **EverQuote is LIVE.** Generic Webhook (JSON → EverQuote URL) added to all 4 campaigns on 2026-10-01 ~4:10 PM PT.
      Ricochet, DYL, PL Rater and the three email recipients are unchanged. First real leads arrived 4:14 PM.
- [x] Rev 2 installed 2026-10-01 (EverQuote mapping: vehicles, drivers, license, coverage, credit, SR-22, TrustedForm consent; backfill ran).
- [x] Rev 3 installed 2026-10-01 evening (body type, commute, garaging ZIP, primary driver per vehicle, driver first/last/license state; backfill ran). Health check 200, 28 leads received on day one, 0 errors.
- [ ] Delete the test lead "Webhook Test Delete Me" (admin only).
- [ ] MediaAlpha and "usmg": parked by Tony 2026-10-01 ("EverQuote is the priority").
- [ ] **DYL top-ups now double up EverQuote leads** (webhook leads have no `dyl_id`). Before any further `dyl-import` run, add
      phone + received-date matching, or exclude source Everquote for dates after 2026-10-01, or retire the top-ups.
- [ ] Lead distribution: webhook leads arrive unassigned (visible to every agent). Decide on round-robin / assignment rules.

## EverQuote notes for whoever touches this next
- Real payload shape: `lead.contact{firstName,lastName,primaryPhone,email,addressLine1,city,state,zipCode}`, `lead.eqLeadId`,
  `lead.autoInsurance.{drivers[],vehicles[],customerProfile{credit,residence,…}}`, `consent{universal_lead_id,trusted_form_cert_url,…}`.
- Campaign → Delivery tab is one edit form; Save sends a single PATCH with only `locationSet`, `leadTypes`, `deliverySettings`.
  Campaign hours/timezone are NOT in that request (the form shows "Eastern" regardless; the saved hours stay Pacific).
- `tools/vendor/portal.js` has `dryclick`: clicks a button but blocks and prints the write requests, a safe preview of any Save.
  `tools/vendor/eq-add-webhook.sh <campaignId>` repeats the whole verified sequence (dry-run check, exact-URL check, save, verify).
- EverQuote's app freezes a headless tab after a puppeteer page load. Use `portal.js everquote newtab <url>` then clicks.
- Login: Okta, username then password, no MFA prompt so far. Session cookies do not survive closing the browser.
- Check the feed any time: `node tools/vendor/intake-ping.js status`.
