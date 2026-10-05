// CSV import for "what I actually spent": parse a categorized transaction
// export, total it per category, and turn the totals into monthly averages per
// budget category. Pure functions (no DOM, no network) so they're unit tested.
//
// Privacy: this runs entirely in the browser on a file the user picks. Nothing
// here stores or sends individual transactions — callers keep only the
// per-category monthly averages that buildActuals() returns.

// ---- parsing -------------------------------------------------------------------

function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim()) || "";
  const counts = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch]++;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ",";
}

// RFC-4180-ish: quoted fields, "" escapes, commas/newlines inside quotes,
// \r\n or \n, a leading BOM. Blank lines are skipped.
function parseCsv(text) {
  text = String(text).replace(/^﻿/, "");
  const delim = detectDelimiter(text);
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const endField = () => { row.push(field); field = ""; };
  const endRow = () => {
    endField();
    if (row.some((f) => f.trim() !== "")) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"' && field === "") inQuotes = true;
    else if (ch === delim) endField();
    else if (ch === "\n") endRow();
    else if (ch === "\r") { if (text[i + 1] === "\n") i++; endRow(); }
    else field += ch;
  }
  if (field !== "" || row.length) endRow();
  return rows;
}

// "$1,234.50", "(12.00)", "−5", "12-", "1.234,50" (European) → number; NaN if it isn't one.
function parseAmount(raw) {
  let t = String(raw ?? "").trim().replace(/[−–—]/g, "-");
  if (!t) return NaN;
  let negative = false;
  if (/^\(.*\)$/.test(t)) { negative = true; t = t.slice(1, -1); }
  if (t.endsWith("-")) { negative = !negative; t = t.slice(0, -1); }
  if (t.startsWith("-")) { negative = !negative; t = t.slice(1); }
  t = t.replace(/[^0-9.,]/g, "");
  if (!/\d/.test(t)) return NaN;
  const lastDot = t.lastIndexOf(".");
  const lastComma = t.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    // both present: whichever comes last is the decimal separator
    t = lastDot > lastComma ? t.replace(/,/g, "") : t.replace(/\./g, "").replace(",", ".");
  } else if (lastComma >= 0) {
    // lone comma: decimal if exactly 1-2 digits follow it, otherwise a thousands separator
    t = /,\d{1,2}$/.test(t) && t.indexOf(",") === lastComma ? t.replace(",", ".") : t.replace(/,/g, "");
  }
  const n = Number(t);
  return Number.isFinite(n) ? (negative ? -n : n) : NaN;
}

// ISO (2026-10-04), US slashes (10/4/2026, 10/4/26; day-first only when the first part can't be a month), or whatever Date.parse accepts. → ms since epoch (UTC), or NaN.
function parseDate(raw) {
  const t = String(raw ?? "").trim();
  if (!t) return NaN;
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    let [a, b, y] = [+m[1], +m[2], +m[3]];
    if (y < 100) y += 2000;
    const [month, day] = a > 12 ? [b, a] : [a, b];
    return Date.UTC(y, month - 1, day);
  }
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? NaN : ms;
}

// ---- columns -------------------------------------------------------------------

// Header row → column indices (-1 when not found).
function detectColumns(header) {
  const names = header.map((h) => String(h).trim().toLowerCase());
  const find = (...tests) => {
    for (const test of tests) {
      const i = names.findIndex(test);
      if (i >= 0) return i;
    }
    return -1;
  };
  return {
    amount: find((n) => n === "amount", (n) => n.includes("amount"), (n) => n === "amt" || n === "value"),
    category: find((n) => n === "category", (n) => n.includes("categor")),
    date: find((n) => n === "date", (n) => n.includes("date"), (n) => n === "posted" || n === "time"),
  };
}

// The header is the first row (within the first 10) that has both an Amount and
// a Category column; failing that, row 0. → { headerIndex, header, columns }
function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const columns = detectColumns(rows[i]);
    if (columns.amount >= 0 && columns.category >= 0) return { headerIndex: i, header: rows[i], columns };
  }
  const header = rows[0] || [];
  return { headerIndex: 0, header, columns: detectColumns(header) };
}

// ---- totals --------------------------------------------------------------------

// Net amount per CSV category (refunds and returns cancel purchases, transfers
// that go both ways cancel out). → {
//   categories: [{ key, name, net, count }]  (in first-seen order),
//   minDate, maxDate (ms, or null), read, skipped }
function summarize(rows, { amount, category, date = -1 }) {
  const byKey = new Map();
  let minDate = null, maxDate = null, read = 0, skipped = 0;
  for (const r of rows) {
    const value = parseAmount(r[amount]);
    if (Number.isNaN(value)) { skipped++; continue; }
    read++;
    const name = String(r[category] ?? "").trim() || "(uncategorized)";
    const key = name.toLowerCase();
    const entry = byKey.get(key) || { key, name, net: 0, count: 0 };
    entry.net += value;
    entry.count++;
    byKey.set(key, entry);
    if (date >= 0) {
      const d = parseDate(r[date]);
      if (!Number.isNaN(d)) {
        if (minDate === null || d < minDate) minDate = d;
        if (maxDate === null || d > maxDate) maxDate = d;
      }
    }
  }
  return { categories: [...byKey.values()], minDate, maxDate, read, skipped };
}

// Months the data spans (≥ 1, one decimal), or null if there were no dates.
function spanMonths(minDate, maxDate) {
  if (minDate === null || maxDate === null) return null;
  const days = (maxDate - minDate) / 86400000 + 1;
  return Math.max(1, Math.round((days / 30.4375) * 10) / 10);
}

// Where a CSV category probably belongs among the budget categories →
// a category id, "ignore" (transfers and the like), or "new" (make a category).
// Keyword rules key off the DEFAULT category ids, and apply only when that
// category still exists; an exact label match always wins first.
const MAPPING_RULES = [
  ["savings", /\bsaving|\binvest|\bretire|\b401|\bira\b|\bbrokerage|\bstock|\bcrypto/],
  ["donations", /\bcharit|\bdonat|\bgiving|\btithe|\bnonprofit/],
  ["housing", /\brent\b|\bmortgage|\bhousing|\bhoa\b/],
  ["utilities", /\butilit|\binternet|\bphone|\belectric|\bwater\b|\bgas bill|\bcable|\bwifi/],
  ["groceries", /\bgrocer|\bsupermarket|\bmarket\b/],
  ["transport", /\btransport|\btransit|\bfuel|\bgas station|\buber|\blyft|\bparking|\btoll|\bauto\b|\bcar\b/],
  ["health", /\bhealth|\bmedical|\bpharmac|\bdoctor|\bdental|\binsurance|\bvision/],
  ["shopping", /\bshop|\bclothing|\bmerchandise|\bamazon|\bretail|\bhome goods/],
  ["dining", /\bdining|\brestaurant|\bdrink|\bcoffee|\bbar\b|\bfood|\bentertain|\bfun\b|\bmovie|\bmusic|\bhobb|\btravel/],
];
const IGNORE_WORDS = /\btransfer|\binternal|\bpayment|\bcredit card|\bincome|\bsalary|\bpaycheck|\bpayroll|\bdeposit|\brefund|\breimburse|\binterest/;

function suggestTarget(csvName, categories) {
  const name = String(csvName).trim().toLowerCase();
  const exact = categories.find((c) => c.label.trim().toLowerCase() === name || c.id === name);
  if (exact) return exact.id;
  for (const [id, re] of MAPPING_RULES) {
    if (re.test(name) && categories.some((c) => c.id === id)) return id;
  }
  return IGNORE_WORDS.test(name) ? "ignore" : "new";
}

// What was spent per budget category over the imported period.
//   mapping: csv category key → budget category id | "ignore"
//   flip:    csv category key → true when that category's spending shows as negative
// A CSV category counts only when its (possibly flipped) net is positive; several
// CSV categories mapped to one budget category add up.
// → { totals: {id: dollars over the whole period}, perMonth: {id: dollars}, months }
function buildActuals(summary, { mapping, flip = {} }, months) {
  const m = Math.max(0.1, Number(months) || 1);
  const totals = {};
  for (const c of summary.categories) {
    const target = mapping[c.key];
    if (!target || target === "ignore") continue;
    const net = flip[c.key] ? -c.net : c.net;
    if (net <= 0) continue;
    totals[target] = (totals[target] || 0) + net;
  }
  const perMonth = {};
  for (const id of Object.keys(totals)) {
    perMonth[id] = Math.round((totals[id] / m) * 100) / 100;
    totals[id] = Math.round(totals[id] * 100) / 100;
  }
  return { totals, perMonth, months: m };
}

// Ms since epoch → "YYYY-MM-DD" (UTC), and back. Actuals store only these dates, never transactions.
const toIsoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const fromIsoDate = (iso) => parseDate(iso);

const Csv = { parseCsv, parseAmount, parseDate, detectColumns, findHeader, summarize, spanMonths, suggestTarget, buildActuals, toIsoDate, fromIsoDate };
if (typeof module !== "undefined" && module.exports) module.exports = Csv;
