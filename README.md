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

Roadmap: opt-in Google Drive sync (same `drive.file` pattern as lyre),
editable categories, mobile layout.
