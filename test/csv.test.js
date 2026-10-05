// All data below is made up — no real transactions in this repo.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const Csv = require("../csv.js");
const Budget = require("../budget.js");

const near = (a, b, eps = 0.005) => assert.ok(Math.abs(a - b) < eps, `${a} !≈ ${b}`);

test("parseCsv: quoted commas, escaped quotes, CRLF, BOM and blank lines", () => {
  const text = '﻿Date,Description,Amount,Category\r\n2026-01-05,"Cafe, Downtown","12.50",Dining\r\n\r\n2026-01-06,"She said ""hi""",3,Fun\n';
  assert.deepEqual(Csv.parseCsv(text), [
    ["Date", "Description", "Amount", "Category"],
    ["2026-01-05", "Cafe, Downtown", "12.50", "Dining"],
    ["2026-01-06", 'She said "hi"', "3", "Fun"],
  ]);
});

test("parseCsv: a newline inside quotes stays in the field; semicolon and tab files are detected", () => {
  assert.deepEqual(Csv.parseCsv('a,b\n"line1\nline2",x'), [["a", "b"], ["line1\nline2", "x"]]);
  assert.deepEqual(Csv.parseCsv("Amount;Category\n1,5;Food"), [["Amount", "Category"], ["1,5", "Food"]]);
  assert.deepEqual(Csv.parseCsv("Amount\tCategory\n4\tFood"), [["Amount", "Category"], ["4", "Food"]]);
});

test("parseAmount handles currency symbols, thousands separators, parentheses and trailing minus", () => {
  near(Csv.parseAmount("12.5"), 12.5);
  near(Csv.parseAmount("$1,234.50"), 1234.5);
  near(Csv.parseAmount("-3.76"), -3.76);
  near(Csv.parseAmount("(12.00)"), -12);
  near(Csv.parseAmount("12.00-"), -12);
  near(Csv.parseAmount("−5"), -5); // unicode minus
  near(Csv.parseAmount("€ 1.234,50"), 1234.5); // European
  near(Csv.parseAmount("12,5"), 12.5);
  near(Csv.parseAmount("1,234"), 1234);
  assert.ok(Number.isNaN(Csv.parseAmount("")));
  assert.ok(Number.isNaN(Csv.parseAmount("n/a")));
  assert.ok(Number.isNaN(Csv.parseAmount(undefined)));
});

test("parseDate: ISO, US slashes, 2-digit years, day-first when unambiguous, and junk", () => {
  assert.equal(Csv.parseDate("2026-03-09"), Date.UTC(2026, 2, 9));
  assert.equal(Csv.parseDate("3/9/2026"), Date.UTC(2026, 2, 9));
  assert.equal(Csv.parseDate("3/9/26"), Date.UTC(2026, 2, 9));
  assert.equal(Csv.parseDate("25/12/2026"), Date.UTC(2026, 11, 25));
  assert.ok(Number.isNaN(Csv.parseDate("")));
  assert.ok(Number.isNaN(Csv.parseDate("whenever")));
});

test("findHeader skips preamble rows and finds the Amount / Category / Date columns", () => {
  const rows = [["Exported by Some Bank"], ["Account", "1234"], ["Posted Date", "Description", "Amount (USD)", "Category"], ["2026-01-01", "x", "5", "Food"]];
  const h = Csv.findHeader(rows);
  assert.equal(h.headerIndex, 2);
  assert.deepEqual(h.columns, { amount: 2, category: 3, date: 0 });
  // no recognizable header: row 0, columns not found
  assert.deepEqual(Csv.findHeader([["a", "b"], ["1", "2"]]).columns, { amount: -1, category: -1, date: -1 });
});

test("summarize nets amounts per category, ignores case, counts skipped rows and tracks the date range", () => {
  const rows = [
    ["2026-01-02", "10", "Groceries"],
    ["2026-01-20", "-4", "groceries "],   // a refund cancels part of a purchase
    ["2026-03-31", "50", "Transfers"],
    ["2026-02-10", "-50", "Transfers"],
    ["2026-02-11", "oops", "Dining"],     // not a number: skipped
    ["2026-02-12", "7", ""],
  ];
  const s = Csv.summarize(rows, { date: 0, amount: 1, category: 2 });
  const byName = Object.fromEntries(s.categories.map((c) => [c.name, c]));
  near(byName["Groceries"].net, 6);
  assert.equal(byName["Groceries"].count, 2);
  near(byName["Transfers"].net, 0);
  near(byName["(uncategorized)"].net, 7);
  assert.equal(s.read, 5);
  assert.equal(s.skipped, 1);
  assert.equal(s.minDate, Date.UTC(2026, 0, 2));
  assert.equal(s.maxDate, Date.UTC(2026, 2, 31));
});

test("spanMonths: roughly months of data, at least 1, null without dates", () => {
  assert.equal(Csv.spanMonths(null, null), null);
  assert.equal(Csv.spanMonths(Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 10)), 1);
  near(Csv.spanMonths(Date.UTC(2026, 0, 1), Date.UTC(2026, 2, 31)), 3, 0.05); // Jan 1 – Mar 31
  near(Csv.spanMonths(Date.UTC(2026, 0, 1), Date.UTC(2026, 11, 31)), 12, 0.05);
});

test("suggestTarget maps common bank category names onto the default categories", () => {
  const D = Budget.DEFAULT_CATEGORIES;
  const cases = {
    "Charitable Donations": "donations", "Dining & Drinks": "dining", "Entertainment": "dining",
    "Groceries": "groceries", "Savings Transfer": "savings", "Investment": "savings",
    "Internal Transfer": "ignore", "Credit Card Payment": "ignore", "Paycheck": "ignore",
    "Rent": "housing", "Electric & Water": "utilities", "Gas Station": "transport",
    "Pharmacy": "health", "Amazon": "shopping", "Pets": "new", "Parenting": "new", "Current account": "new",
  };
  for (const [name, want] of Object.entries(cases)) assert.equal(Csv.suggestTarget(name, D), want, name);
});

test("suggestTarget: an exact label match wins, and a rule is skipped once its category is deleted", () => {
  const withPets = Budget.addCategory(Budget.DEFAULT_CATEGORIES, "Pets");
  assert.equal(Csv.suggestTarget("pets", withPets), withPets.at(-1).id);
  assert.equal(Csv.suggestTarget("Housing (rent)", withPets), "housing");
  const noDonations = Budget.removeCategory(Budget.DEFAULT_CATEGORIES, "donations");
  assert.equal(Csv.suggestTarget("Charitable Donations", noDonations), "new");
});

test("buildActuals: totals and monthly averages, several CSV categories into one, ignore, and flip", () => {
  const summary = { categories: [
    { key: "dining & drinks", name: "Dining & Drinks", net: 90, count: 4 },
    { key: "entertainment", name: "Entertainment", net: 30, count: 2 },
    { key: "investment", name: "Investment", net: -12, count: 3 },       // spending shows as negative here
    { key: "internal transfer", name: "Internal Transfer", net: -275, count: 2 },
    { key: "groceries", name: "Groceries", net: 300, count: 9 },
    { key: "mystery", name: "Mystery", net: 5, count: 1 },
  ] };
  const mapping = { "dining & drinks": "dining", entertainment: "dining", investment: "savings", "internal transfer": "ignore", groceries: "groceries" };
  const a = Csv.buildActuals(summary, { mapping, flip: { investment: true } }, 3);
  assert.deepEqual(a.totals, { dining: 120, savings: 12, groceries: 300 });
  assert.deepEqual(a.perMonth, { dining: 40, savings: 4, groceries: 100 });
  assert.equal(a.months, 3);
  // without the flip a negative net isn't spending
  assert.equal("savings" in Csv.buildActuals(summary, { mapping }, 3).totals, false);
  // unmapped categories ("mystery") and an absurd months value can't produce NaN
  assert.ok(Object.values(Csv.buildActuals(summary, { mapping }, 0).perMonth).every(Number.isFinite));
});

test("toIsoDate / fromIsoDate round-trip", () => {
  const ms = Date.UTC(2026, 9, 4);
  assert.equal(Csv.toIsoDate(ms), "2026-10-04");
  assert.equal(Csv.fromIsoDate("2026-10-04"), ms);
});
