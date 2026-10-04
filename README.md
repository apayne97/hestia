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

Run locally: `python3 -m http.server 8935`, then open http://localhost:8935.
Tests: `npm test` (Node's built-in runner, no install needed).

## Google Drive sync (optional)

"Connect Google Drive" keeps all scenarios in one `hestia-scenarios.json` in
your own Drive, so they follow you between devices. It uses the narrow
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

Roadmap: editable categories, mobile layout.
