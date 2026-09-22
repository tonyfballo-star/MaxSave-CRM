# MSIHub — where things stand (updated 2026-09-21)

Read this first when picking up on another machine. Start Claude Code in this folder and say:
"Continue MSIHub from HANDOFF.md."

## What is live
- **App:** https://msihub-maxsave.netlify.app/ (Netlify project id ba46785b-f37b-4cc9-80c8-b92ddc7dd684). Deploy via API — never by dragging (drops on the Netlify home page create new sites): `curl -X POST https://api.netlify.com/api/v1/sites/<id>/deploys -H 'Authorization: Bearer <token>' -H 'Content-Type: application/zip' --data-binary @msihub-site.zip`. Token is held locally by Claude, not in this repo. Public URL, sign-in required, `noindex`.
- **Database:** Supabase project `xcwkkynxgojmabxdrngm` (see `supabase/CONFIG.md`). `schema.sql`, `schema-v2.sql` and `schema-v3.sql` have all been run.
- **Source of truth:** `maxsave_crm.html` + `msihub-data.js` + `msihub-data-2.js` + `docs/*.pdf`. Rebuild the deploy copy with:
  `cp maxsave_crm.html site/index.html && cp msihub-data.js msihub-data-2.js site/` then zip `site/*` → `msihub-site.zip`.
- **Tests:** `tools/smoke.js fake` (in-memory stub, 44 steps) and `tools/live.js <url> <email> <password>` (real sign-in walkthrough). Need `npm i puppeteer-core@23` inside `tools/` and Microsoft Edge.

## Done so far
1. Supabase backend: 18 tables, RLS, storage bucket, realtime.
2. Login screen, first-login name + password screen, logout.
3. Leads, lead profiles (data-driven), New Lead form, notes, quotes, appointments, files, call/text logging, bulk text logging, templates.
4. Customers, New Sale (creates customer + sale + policies), customer notes/texts.
5. Tasks, admin settings (tiers, carriers, vendors, lead sources, lifecycle rules), agent profile edits/goals, Live View + Inbox from real logs, Reports computed for the selected range, Goals page live.
6. All sample data removed. E-sign PDFs moved to `docs/`. Tab icon, noindex, alerts → toasts.
7. Bug fixed: Settings page crashed for single-word agent names.

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

## Next steps (agreed order)
1. Finish live verification, fix anything it finds.
2. Brevo SMTP (above).
3. Domain (above).
4. **Telnyx** (not Twilio) for real calling/texting — Tony will say when the account is ready. `messages.provider_sid` and `call_log` are ready for it.
5. Data import of past customers/policies — Tony will supply a file "in the coming days". Needs: customer name, phone, agent, carrier, policy #, effective date, premium, broker fee.
6. Agent logins: created in Supabase → Authentication → Users → Add user (Auto Confirm). Tony will do this later.

## Not connected yet
Real calls/texts, email inbox, e-sign delivery, payment terminal. Everything else reads/writes the database.

## Gotchas
- `maxsave_crm.html` uses CRLF line endings; the patch scripts handle it.
- Never commit `*.xlsx` (customer data) — the repo is public.
- Deleting records is admin-only by design; agents can deactivate/hide instead.
