# MaxSaveHub (formerly MSIHub) — where things stand (updated 2026-09-30)

Read this first when picking up on another machine. Start Claude Code in this folder and say:
"Continue MaxSaveHub from HANDOFF.md."

## Picking up on the laptop (2026-09-30)
- Clone/pull `tonyfballo-star/MaxSave-CRM`, or let OneDrive sync `OneDrive/Desktop/MSICRM` (the folder lives in OneDrive, so it syncs by itself).
- `fonts/` (TT Hoves TTFs) is gitignored. OneDrive carries it; if cloning fresh, copy `fonts/` and `site/fonts/` from the desktop PC or build them from `OneDrive/Desktop/FONT/HOVES` (Regular, Medium, Demibold -> `TTHoves-Regular/Medium/DemiBold.ttf`).
- `cd tools && npm i` (puppeteer-core + csv-parse are in package.json). Needs Microsoft Edge for smoke tests and DYL pulls.
- Preview: `node tools/preview.js` -> http://localhost:8765/ (fonts need http, not file://).
- Deploy: rebuild `site/` with the command under "What is live", zip with forward-slash paths, POST to the Netlify API. The token is NOT in the repo; Tony has it.
- Credentials are never in the repo: Netlify token, DYL login, CRM admin login all come from Tony in chat.
- **Next agreed project:** real-time lead intake from vendors (EverQuote ~3.4k/mo, USMG ~1.4k/mo). Plan: a Supabase endpoint per vendor that receives their lead-delivery POST and inserts into `leads`; vendors configured to post to it; keep DYL receiving in parallel for a couple of weeks. Not started.

## What is live
- **App:** https://msihub-maxsave.netlify.app/ (Netlify project id ba46785b-f37b-4cc9-80c8-b92ddc7dd684). Deploy via API — never by dragging (drops on the Netlify home page create new sites): `curl -X POST https://api.netlify.com/api/v1/sites/<id>/deploys -H 'Authorization: Bearer <token>' -H 'Content-Type: application/zip' --data-binary @msihub-site.zip`. Token is held locally by Claude, not in this repo. Public URL, sign-in required, `noindex`.
- **Database:** Supabase project `xcwkkynxgojmabxdrngm` (see `supabase/CONFIG.md`). `schema.sql`, `schema-v2.sql` and `schema-v3.sql` have all been run.
- **Source of truth:** `maxsave_crm.html` + `msihub-data.js` + `msihub-data-2.js` + `msihub-telnyx.js` + `docs/*.pdf` + `fonts/*.ttf`. Rebuild the deploy copy with:
  `cp maxsave_crm.html site/index.html && cp msihub-data.js msihub-data-2.js msihub-telnyx.js site/ && mkdir -p site/fonts && cp fonts/*.ttf site/fonts/` then zip `site/*` → `msihub-site.zip`.
- **Tests:** `tools/smoke.js fake` (in-memory stub, 58 steps incl. 14 Telnyx steps against stand-ins), `node tools/telnyx-fn-test.mjs` (the edge function against a fake Telnyx + database, 33 checks, Node 24+) and `tools/live.js <url> <email> <password>` (real sign-in walkthrough). Need `npm i puppeteer-core@23` inside `tools/` and Microsoft Edge.

## Brand (standing rule, 2026-09-30)
- Follows the MaxSaveHub brand guide: Turquoise `#09C4CD` (fills only, black text on it), Black `#000`, Charcoal `#696969`, White; text-safe turquoise for links is `#067C83`. Black sidebar, light pages, dark mode = full black. Typeface TT Hoves (400/500/600) via `@font-face` from `fonts/`. Logo = X mark + MAXSAVEHUB wordmark as inline SVG (sidebar, login, favicon); vector sources in `OneDrive/Desktop/LOGO/PDF`, converted with `tools/pdf2svg.js`.
- **Font licence:** TT Hoves is licensed (rights held by Tony's designer, confirmed 2026-09-30). The TTFs in `fonts/` are the production files. They stay gitignored because the repo is public and the licence does not allow redistribution; they ship in the zip. The font folder must exist locally before rebuilding `site/`.
- `tools/rebrand.js` is the palette/name codemod; `node tools/rebrand.js --check` must print "clean" for all three files before a deploy.
- Visible product name is **MaxSaveHub**; code identifiers (`window.MSIHub`, `[MSIHub]` logs, ids) are unchanged on purpose. The onboarding invite still links to `msihub.maxsave.com/join/…` — update when the real domain (maxsavehub.com?) is wired up.

## Done so far
1. Supabase backend: 18 tables, RLS, storage bucket, realtime.
2. Login screen, first-login name + password screen, logout.
3. Leads, lead profiles (data-driven), New Lead form, notes, quotes, appointments, files, call/text logging, bulk text logging, templates.
4. Customers, New Sale (creates customer + sale + policies), customer notes/texts.
5. Tasks, admin settings (tiers, carriers, vendors, lead sources, lifecycle rules), agent profile edits/goals, Live View + Inbox from real logs, Reports computed for the selected range, Goals page live.
6. All sample data removed. E-sign PDFs moved to `docs/`. Tab icon, noindex, alerts → toasts.
7. Bug fixed: Settings page crashed for single-word agent names.
8. 2026-09-30: full visual rebrand to MaxSaveHub (merged to master, smoke 44/44 clean). DEPLOYED via API (deploy 6abd9006, verified live: title, fonts, wordmark). Sidebar shows the wordmark only; X mark is on login + favicon.

## In progress / blocked
- **Live verification PASSED 2026-09-15** (29/29 steps, 0 errors). Owner login is tonyb@maxsaveins.com (admin, active, name Tony Ballo). Public sign-ups DISABLED (verified). Default settings seeded. QA test rows purged. Test login qa@maxsave.com (agent) — password given in chat.
- **Brevo SMTP:** account exists; Supabase Auth → Emails → SMTP Settings still needs: host `smtp-relay.brevo.com`, port 587, username = Brevo login email, password = Brevo SMTP key, sender = a verified Brevo sender. Then raise Auth rate limits.
- **Custom domain:** msihub.com is taken (since 2015). Available: msihub.app, msihub.io, getmsihub.com. `maxsavehub.com` was registered 2026-07-02 — possibly Tony's; ask. Connect via Netlify → Domain management, then update Supabase Site URL + Redirect URLs.

## DYL data migration (2026-09-15, in progress)
- Full DYL export pulled headlessly (see tools/dyl/README.md): 381,544 of 382,621 leads (99.7%), 16,381 customers, ~275 MB of CSV in OneDrive/Desktop/DYL Export (not in repo). Parsed to leads.jsonl.
- Importer written (tools/dyl/dyl-import.js). Final dry run, recommended scope (customers + any real disposition + last 12 months): 95,241 leads, 16,381 customers; 24-month option: 149,429 leads.
- CRM prepared for volume: on-demand loading (working set + DB search + per-lead history) and Customers paging — pushed, needs redeploy of msihub-site.zip.
- DONE 2026-09-17: Tony chose 24 months. Import complete: 149,248 leads (+notes), customers deduped by phone, vehicles/drivers. Imported as qa@maxsave.com; customer_no = DYL-<id>. Current agents: Dellano Soro, Marino D Alfonso, Nathan Hermiz, Alton Jorjes, Arman Nishan, Julian Sabri, Nawras Tatta, Norman Tatta, Jermaine Jackson — logins still to be created by Tony, then map details.dyl_assigned → agent_id.
- 2026-09-17 evening: schema-v3.sql RUN (verified: fast queries, QA rows purged, Tony's ~950 DYL leads auto-assigned). Latest build DEPLOYED via API and verified live (29/29). Two stray Netlify sites from accidental drops (eclectic-souffle-37b91d, profound-daifuku-9568d5) can be deleted.
- After import: reconcile details.dyl_assigned → agent_id once agent logins exist; consider Supabase Pro if DB > 500 MB.

## DYL top-up 2026-09-30 (DONE)
- September re-pulled from DYL (5,225 Auto + 555 Contact; newest 09-30 15:26). leads.jsonl rebuilt (383,781 leads). ~2,237 new leads + 60 customers waiting to import.
- First attempt ran as qa (agent) → RLS hid Tony's assigned leads → 800 duplicates. Tony ran `supabase/fix-dyl-duplicates.sql` (0 left), then the import re-ran as admin: **inserted 2,237 leads + 60 customers**, 147,567 skipped. Importer now refuses non-admin logins; `tools/dyl/dyl-check.js` is the read-only diagnostic.
- Repeat procedure for the next top-up: move aside `DYL Export/<Type>/<current month>.csv`, `node dyl.js login …`, `node dyl-pull.js YYYY-MM YYYY-MM all`, `node dyl-parse.js`, `node dyl-import.js --scope=recommended --months=24 --email=<admin> --password=…`. New leads land unassigned; re-run schema-v3.sql section 3 to map `details.dyl_assigned` → agent once agent logins exist.
- Tony's admin password was set to a temporary value in the SQL editor on 2026-09-30 (not stored here); he should change it. Supabase built-in email does NOT deliver to tonyb@maxsaveins.com ("Error sending recovery email") → Brevo SMTP is now the blocker for any password reset.

## Telnyx — real texting + browser calling (built and deployed 2026-10-01; switched off until the Telnyx account is upgraded)
Deployed end to end, but no real text or call has gone through it yet. Until an admin switches it on in Settings, the CRM behaves exactly as before (texts/calls logged only).

**Pieces**
- `supabase/schema-v4.sql` — delivery columns on `messages`, call details on `call_log`, `profiles.telnyx_*`, `phone_presence`, `sms_opt_outs`.
- `supabase/functions/telnyx/index.ts` — one edge function, one URL (`https://xcwkkynxgojmabxdrngm.supabase.co/functions/v1/telnyx`). Signed-in users call it with `{action:'sms'|'token'|'status'}`; Telnyx posts webhooks to the same URL (accepted by URL secret or Ed25519 signature). Must be deployed with JWT verification OFF.
- `msihub-telnyx.js` — third data-layer file. Overrides `M.recordText`, `sendTextReply`, `inboxSendText`, `sendBulkText`, `doCall`, `hudEndCall`, `showTextPopup`, `renderCallSettingsPanel`; each falls through to the old behaviour while the matching switch is off. Settings live in `agency_settings` key `telnyx` (`sms_enabled`, `voice_enabled`, `sms_number`, `caller_id`, `fallback_number`; optional `ring_secs`, `inbound_agent_id`, `unavailable_message`, `caller_name`).

**What it does**
- Texts: sent through Telnyx from the agent's direct number or the agency number; delivery status shown under the bubble; replies arrive live, matched to the lead/customer and to the agent who last texted them; STOP/START handled (server refuses opted-out numbers); texted photos are copied into storage and added to the lead's Files; outbound pictures up to 1 MB; bulk text capped at 500 with a confirm.
- Calls: browser phone (Telnyx WebRTC SDK 2.27.10 from jsDelivr, pinned with an integrity hash). Outbound calls are logged by the browser with real duration. Inbound calls are logged by the server and ring one agent at a time (number owner → last texter → lead's agent → anyone available; max 3), then the forwarding number, then a spoken "we'll call you back". Agents count as available when their browser reported in within 90 s (`phone_presence`) and Live View status is not DND/Offline.
- Not built: voicemail, recording, real transfer/parking (Live View drag-and-drop is still visual only), power dialer, scheduled texts, Live View showing other agents' real status.

**Telnyx account state (checked by API 2026-10-01)**
- **Number: (619) 535-2168** (`+16195352168`, San Diego, voice + SMS + MMS), ordered by API 2026-10-01 at Tony's request (one new number). Active, already attached to the MaxSaveHub messaging profile and the MaxSaveHub Inbound Calls application. Balance went to -$0.10, so the account needs funds.
- Account was created 2026-10-01 and is still at the restricted (free) account level: browser-phone logins (`/telephony_credentials`), 10DLC registration and porting all answer "Feature not permitted at this account level" until the account is upgraded at telnyx.com/upgrade.
- Tony supplied the API key in chat (held locally by Claude, never in this repo).
- Created by API, all pointing at the function URL, nothing attached to them yet:
  - Messaging Profile "MaxSaveHub" — `4001a0f9-0c72-4476-859a-1a52820fbc5e` (US + CA, webhook v2)
  - Voice API Application "MaxSaveHub Inbound Calls" — `3061331374049854629` (webhook v2, outbound profile Default)
  - Credentials SIP Connection "MaxSaveHub Browser Phones" — `3061331386850870439` ← this is `TELNYX_CONNECTION_ID` (SIP URI calls: internal, outbound profile Default `3061318111610275331`)
- The account's auto-created connection "Forward Only" was left untouched.

**Went live 2026-10-01 (server side + site), switches still OFF**
- `node tools/telnyx-go-live.mjs` was run with a Supabase access token Tony generated: `schema-v4.sql` applied, secrets set (`TELNYX_API_KEY`, `TELNYX_CONNECTION_ID`, `TELNYX_WEBHOOK_SECRET`), function `telnyx` deployed (JWT verification off), Telnyx messaging profile + inbound-call application pointed at it, settings row saved with (619) 535-2168 as text number and caller ID, `sms_enabled` / `voice_enabled` false.
- Verified against the real function with the QA login: non-admin `status` → 403, `token`/`sms` → 409 "turned off", webhook with wrong secret → 401, right secret → 200, presence table writable under RLS.
- Site deployed (deploy `6abef22b0ee2e25478482986`): includes `msihub-telnyx.js` plus the calendar / Live View / intake work committed since 09-30. Headless sign-in on the live site: loads, 0 errors, phone module dormant.
- Incident: the first site deploy (23:50 UTC) published an empty site for about two minutes because the zip had `./`-prefixed entries; rolled back to `6abd9006`, script fixed. Site deploys from the script now go up as a draft, are checked on the preview address, and are only then published.
- Webhooks are authenticated by a secret in the URL (`?k=…`); the Telnyx Public Key is not needed. Local-only values (Telnyx API key, webhook secret, IDs, Supabase token) are in `supabase/local-telnyx.json`, gitignored.

**Still blocked — only Tony can do it (state at 2026-10-01 5:10 PM PT, after his first upgrade step):** Telnyx now allows browser-phone logins and the balance shows $5.00, but the account is still limited: an outbound call is refused with "Can not make calls to non-verified numbers at this account level" and 10DLC registration + porting still return "Feature not permitted at this account level". He needs to finish whatever telnyx.com/upgrade still lists (deposit / verification). Live test done with the QA login on the live site: phone registered with Telnyx in 3–9 s, the call reached Telnyx, the refusal was shown and the call was logged; calling was then switched back OFF so agents keep the old Call behaviour. Right now a call to (619) 535-2168 hears the "all agents are busy" message and is logged as missed; an inbound text is recorded.

**After the upgrade (Claude):** register the 10DLC brand + campaign by API and attach the number (needs legal business name, EIN, address, contact); run `node tools/telnyx-go-live.mjs --no-site --sms --voice`; first live test — text own cell and reply, call own cell, call (619) 535-2168 with the CRM open. Inbound call routing has only been tested against a stand-in.

## Next steps (agreed order)
1. Finish live verification, fix anything it finds.
2. Brevo SMTP (above).
3. Domain (above).
4. **Telnyx** — built, waiting on the account details; see the Telnyx section above.
5. Data import of past customers/policies — Tony will supply a file "in the coming days". Needs: customer name, phone, agent, carrier, policy #, effective date, premium, broker fee.
6. Agent logins: created in Supabase → Authentication → Users → Add user (Auto Confirm). Tony will do this later.

## Not connected yet
Real calls/texts, email inbox, e-sign delivery, payment terminal. Everything else reads/writes the database.

## Gotchas
- `maxsave_crm.html` uses CRLF line endings; the patch scripts handle it.
- Never commit `*.xlsx` (customer data) — the repo is public.
- Deleting records is admin-only by design; agents can deactivate/hide instead.

## Live View layout + supervisor controls (2026-10-01, desktop session)
- Boxes are now: **My Call** (the signed-in agent and who they are talking to, draggable, End call), **Available** (drop targets), **On the Phone** (other agents' live calls), **Offline** (DND agents listed first with a DND tag). Parking Lot and Transfer to All unchanged.
- Admins (`CURRENT_USER.role === 'Admin'`) get Listen / Whisper / Barge on every other agent's live call, plus a banner with mode switch and Stop. State lives in `LIVEVIEW_STATE.monitor = {agent, mode, lead, since}` and clears when that call ends.
- **Visual only until the phone layer implements it.** Contract: set `window.hudMonitorHook = ({action:'start'|'stop', agent, mode:'listen'|'whisper'|'barge', lead}) => …` and perform the real supervise leg there (Telnyx: dial the admin in with `supervise_call_control_id` + `supervisor_role` monitor/whisper/barge). Function names the Telnyx layer relies on (`hudStartCall`, `hudWrapUp`, `hudMe`, `hudRefresh`, `hudEndCall`, `setMyLiveStatus`) are unchanged.
- Vendor lead intake (EverQuote webhook, live since 2026-10-01 4:10 PM PT) is documented in `supabase/INTAKE.md`.

## Lead list + lead card (2026-10-01, desktop session)
- **Bulk bar:** selecting leads (or customers) shows one slim black bar (`.bulk-bar`: count, Text, Power Dial, Clear) that is `position:sticky` and stays pinned while the list scrolls. The old header buttons are gone.
- **Lead card tabs** (keys unchanged, labels/order changed): Text (`sms`, default), Notes (`comments`), Appointment, Task, Files, History (`activities`), Quotes (`applications`, kept so Add Quote is still reachable). The separate Call tab was folded into History.
- **History** lists every call with the lead from every agent (`leadCalls` matches `lead_id`, or the phone when a call has no lead yet), newest first, then the full activity timeline.
- **Listen:** a call row shows a Listen button when `call_log.recording_url` (https) is set, and plays it inline for any agent (`MSIHub.playRecording`). **No recordings exist yet**: the column is not in the schema and Telnyx recording is not switched on. To enable: `alter table public.call_log add column if not exists recording_url text;`, start recording on answered calls, store the URL from the `call.recording.saved` webhook. Recorded-call disclosure is required in California (two-party consent) before turning this on.
- **Lead card body:** Name, Phone, Email, Address (one line), Date of Birth, then a tinted row of three drop-downs: Vehicles, Coverage, Additional Drivers (`MSIHub.toggleLeadSection`, open state in `M.leadOpen`, survives re-renders). Gender / marital / license / violations / occupation now live under Additional Drivers as "Primary driver"; prior coverage, SR-22, credit, home ownership under Coverage. The Hide-empty toggle is no longer shown.
- **Lead card rev 2 (same day):** two drop-downs now, **Vehicles/Coverage** and **Additional Drivers**. The main card also shows the lead's Gender, Marital Status, License Status, License State, Violations. Every listed field always renders; a missing one reads "Not provided" / "Not specified" so agents see what to ask. Per vehicle: year, make, model, VIN, body type, own or lease, annual mileage, use, commute, garaging, primary driver, coverage requested. Coverage grid: level, BI limits, PD, Comprehensive, Collision (read from an explicit field, else inferred only from wording like "Full coverage" / "Liability only"), deductible, UM, UIM, med pay, towing, rental, SR-22, then insurance history.
- **Placeholder VINs:** when a vehicle has no VIN, `MSIHub.placeholderVin(make, year)` builds a brand + year stub (real manufacturer prefix, correct model-year character, valid check digit, zeros elsewhere) and the UI tags it "Placeholder" (lead card, and "VIN (placeholder)" in the rater export panel). It is never stored and never a real vehicle; unknown makes get none. The real VIN is still required before binding.
- **Intake rev 3** (`schema-v5-intake.sql`): also keeps EverQuote `vehicleType`, `oneWayDistance`, `garageZipCode`, each vehicle's primary driver, and driver first/last/license state. 48 local checks. Needs one more paste of `supabase/local-intake.sql` (includes the backfill).
