# Hestia

Household budget theory. Enter a salary, get an estimated take-home, then
slide percentages across categories to see what rent, groceries, etc. you
can afford. Compare several scenarios (job offers, cities) side by side.

No raw financial data: only a salary and some percentages, saved in your
browser's `localStorage`.

- `tax.js` — rough US federal + FICA + flat state estimate. Update the
  numbers at the top once a year (`TAX_YEAR`).
- `budget.js` — presets, allocation and rent rules of thumb. Pure functions.
- `app.js` — UI. `index.html` / `style.css` / `theme.js` — shell.

Run locally: `python3 devserver.py` (serves http://localhost:4461 with caching
disabled), then open http://localhost:4461. Use that exact origin: it is the one
authorized for Google sign-in.
Tests: `npm test` (Node's built-in runner, no install needed).

## Google Drive sync (optional)

"Connect Google Drive" keeps all scenarios in one `hestia-scenarios.json`
inside a `Hestia` folder in your own Drive ("Change folder" moves it), so they follow you between devices. It uses the narrow
`drive.file` scope (the app can only see files it created or you picked) and
runs entirely in the browser. Edits auto-save ~1s after you stop typing; if
both this browser and Drive changed since the last sync you're asked which
version to keep. `gdrive.js` is a generic, config-driven Drive client;
`sync.js` has the Hestia-specific file format and sync decision.

It shares lyre's Google Cloud project/OAuth client, so every origin Hestia is
served from must be added in Google Cloud Console → APIs & Services →
Credentials: the OAuth client's **Authorized JavaScript origins** and the API
key's **HTTP referrer** restrictions need `https://hestia.apayne.org` (and
`http://localhost:4461` for local dev).

## Branches

Work on `dev`; `main` is what GitHub Pages serves and is fast-forwarded from
`dev` once CI passes (branch protection requires the `test` check).

## Rent paid from the paycheck

If your rent is deducted before your pay reaches your account, set "Rent paid from
paycheck ($/mo)" on a scenario. Percentages stay a share of the *full* take-home, so
scenarios with and without paycheck rent compare like for like: Housing becomes a
fixed row worth rent / take-home, the other categories share the rest, and the table
adds "Rent (from paycheck)" and "Lands in your account" lines. In the budget-vs-actual
comparison and the rest-of-year plan the rent counts as spent in Housing, even though a
bank CSV never shows it. It's per scenario, so a different job can have it paid the
usual way.

## Categories

The budget rows are editable: "Edit categories" lets you add, rename, reorder
and delete them (built-in ones included). They're shared by every scenario so
side-by-side comparisons always line up, and they sync to Drive with the
scenarios (file format version 2; older version-1 files still load). Deleting a
category removes its percentage from every scenario; presets adapt to whatever
categories exist.

## Importing what you actually spent

"Import spending" reads a categorized CSV (an Amount and a Category column, plus
an optional Date) and compares it with each scenario's theoretical budget.

- **Privacy:** the file is parsed in the browser. Individual transactions are
  never stored, synced or sent anywhere; only per-category totals, the date range
  and the number of months are kept (in this browser and, if you connect Drive, in
  your own Drive file). `*.csv` is in `.gitignore` so a real export can't be
  committed by accident. Tests use made-up data only.
- **Mapping:** each CSV category is netted (a refund cancels a purchase) and counts
  as spending when the net is positive. You choose where each one goes (an existing
  category, a new one, or ignore, e.g. for transfers). Tick "flip" for a category
  whose spending is negative in your export. Choices are remembered.
- **Monthly average:** actual spend per month next to each scenario's budget.
- **Rest of year:** each category's target is its % of *all* the take-home for the
  period (received so far + still to come). Remaining = target - spent so far, scaled
  down if it exceeds the money you really have left. A month that blew one category
  (paid for out of savings) shows up as less room there later and more elsewhere, so
  the year evens out. "Received so far" and "still to come" can be overridden.

Roadmap: mobile layout.
