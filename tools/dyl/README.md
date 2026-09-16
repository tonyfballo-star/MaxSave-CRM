# DYL → MSIHub migration tooling

All scripts need `npm i puppeteer-core@23 csv-parse` (run inside `tools/`) and Microsoft Edge. Credentials are passed on the command line, never stored.

| Script | What it does |
|--------|--------------|
| `dyl.js` | Keeps one headless Edge signed into my.dyl.com. `node dyl.js login <user> <pw>`, then `goto <url>`, `eval "<js>"`, `shot`. |
| `dyl-pull.js` | `node dyl-pull.js 2019-01 2026-09 all` — for every lead type × month: runs the Browse Leads filter (XHR, `d2-` fields, `timeframe=spc`), then exports CSV (`cmd-1_1=action`, `a0-1_1=export`, `d1-options` = notes, details, call_result). Details require a single lead type; the Contact type (value `''`) exports without details. Resumable; writes `DYL Export/<Type>/<YYYY-MM>.csv` + `pull.log`. |
| `dyl-parse.js` | Stitches continuation rows (blank Id = extra car/driver) into one JSON per lead → `DYL Export/leads.jsonl`; strips card/SSN patterns from notes. `--stats-only` prints tallies. |
| `dyl-import.js` | Maps leads → `leads` (+ `notes`), customers → `customers` + `vehicles` + `drivers`. `--scope=recommended|customers|all --months=12 --dry-run`. Idempotent (skips DYL ids already present). Needs `--email/--password` of an active MSIHub login. |

Findings (2026-09-15): 382,621 DYL leads since Aug 2019, ~16.5k flagged customers, 11.6k "New Sale". DYL holds no premium/fee data. Exports live outside the repo in `OneDrive/Desktop/DYL Export/` (customer data — never commit).
