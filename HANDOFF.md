# MSIHub — where things stand (updated 2026-09-15)

Read this first when picking up on another machine. Start Claude Code in this folder and say:
"Continue MSIHub from HANDOFF.md."

## What is live
- **App:** https://msihub-maxsave.netlify.app/ (Netlify project, deployed by dragging `msihub-site.zip` or the `site/` folder onto the Deploys page). Public URL, sign-in required, `noindex`.
- **Database:** Supabase project `xcwkkynxgojmabxdrngm` (see `supabase/CONFIG.md`). `schema.sql` and `schema-v2.sql` have both been run.
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
- **Live verification PASSED 2026-09-15** (29/29 steps, 0 errors) signed in as qa@maxsave.com. Findings: Tony's login is tonyb@maxsaveins.com with role *agent* (not admin) and public sign-ups are still enabled → run `supabase/fix-admin.sql` (makes him admin, hardens the profile trigger, purges QA test rows) and turn off "Allow new users to sign up" in Supabase Auth → Sign In / Providers → Email.
- **Brevo SMTP:** account exists; Supabase Auth → Emails → SMTP Settings still needs: host `smtp-relay.brevo.com`, port 587, username = Brevo login email, password = Brevo SMTP key, sender = a verified Brevo sender. Then raise Auth rate limits.
- **Custom domain:** msihub.com is taken (since 2015). Available: msihub.app, msihub.io, getmsihub.com. `maxsavehub.com` was registered 2026-07-02 — possibly Tony's; ask. Connect via Netlify → Domain management, then update Supabase Site URL + Redirect URLs.

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
