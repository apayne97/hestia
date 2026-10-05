const { test } = require("node:test");
const assert = require("node:assert/strict");
const Tax = require("../tax.js");
const Budget = require("../budget.js");

const near = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) < eps, `${a} !≈ ${b}`);

test("federal brackets: tax is progressive and zero below the first bracket", () => {
  assert.equal(Tax.federalIncomeTax(0, "single"), 0);
  near(Tax.federalIncomeTax(10000, "single"), 1000);
  // 12,400 @10% + (30,000-12,400) @12%
  near(Tax.federalIncomeTax(30000, "single"), 1240 + 2112);
});

test("estimateTax: standard deduction, FICA and state rate are applied", () => {
  const t = Tax.estimateTax({ salary: 80000, filing: "single", stateRate: 5 });
  near(t.socialSecurity, 80000 * 0.062);
  near(t.medicare, 80000 * 0.0145);
  near(t.state, 4000);
  near(t.federal, Tax.federalIncomeTax(80000 - 16100, "single"));
  near(t.net, t.gross - t.totalTax);
  near(t.netMonthly * 12, t.net);
});

test("estimateTax: Social Security caps at the wage base; high earners pay extra Medicare", () => {
  const t = Tax.estimateTax({ salary: 400000, filing: "single" });
  near(t.socialSecurity, 184500 * 0.062);
  near(t.medicare, 400000 * 0.0145 + 200000 * 0.009);
});

test("estimateTax: zero or junk salary yields zero tax, not NaN", () => {
  for (const salary of [0, "", undefined, -5]) {
    const t = Tax.estimateTax({ salary });
    assert.equal(t.totalTax, 0);
    assert.equal(t.effectiveRate, 0);
  }
});

test("every preset sums to exactly 100% and covers every category", () => {
  for (const [name, p] of Object.entries(Budget.PRESETS)) {
    assert.deepEqual(Object.keys(p).sort(), Budget.DEFAULT_CATEGORIES.map((c) => c.id).sort(), name);
    assert.equal(Object.values(p).reduce((a, b) => a + b, 0), 100, name);
  }
});

test("allocate: dollars follow percents; unallocated goes negative when over 100%", () => {
  const a = Budget.allocate(5000, { housing: 30, savings: 20 });
  near(a.rows.find((r) => r.id === "housing").amount, 1500);
  near(a.unallocatedPct, 50);
  near(a.unallocatedAmount, 2500);
  const over = Budget.allocate(5000, { housing: 70, savings: 50 });
  near(over.unallocatedPct, -20);
  assert.ok(over.unallocatedAmount < 0);
});

test("rentRules: 30% of gross and the 40x rule", () => {
  const r = Budget.rentRules(96000);
  near(r.thirtyPercent, 2400);
  near(r.fortyX, 2400);
});

test("createScenario: gives distinct ids and independent percents", () => {
  const a = Budget.createScenario();
  const b = Budget.createScenario();
  assert.notEqual(a.id, b.id);
  a.percents.housing = 99;
  assert.notEqual(b.percents.housing, 99);
});

test("401(k) lowers income-tax wages but not FICA; health premiums lower both", () => {
  const base = Tax.estimateTax({ salary: 100000 });
  const k = Tax.estimateTax({ salary: 100000, pretax401kPct: 10 });
  near(k.k401, 10000);
  near(k.socialSecurity, base.socialSecurity);
  assert.ok(k.federal < base.federal);
  near(k.net, base.net - 10000 + (base.federal - k.federal));
  const h = Tax.estimateTax({ salary: 100000, healthMonthly: 500 });
  near(h.health, 6000);
  near(h.socialSecurity, 94000 * 0.062);
  near(h.net, h.gross - h.totalTax - 6000);
});

test("pre-tax contributions can't exceed gross pay", () => {
  const t = Tax.estimateTax({ salary: 1000, pretax401kPct: 150, healthMonthly: 999 });
  assert.ok(t.k401 <= 1000 && t.health >= 0 && t.k401 + t.health <= 1000);
  assert.ok(Number.isFinite(t.net));
});

test("rebalance: changed category is set and the rest rescale to total 100", () => {
  const p = Budget.rebalance(Budget.PRESETS[Budget.DEFAULT_PRESET], "housing", 40);
  near(p.housing, 40);
  near(Object.values(p).reduce((a, b) => a + b, 0), 100, 1e-9);
  // others keep their relative proportions: groceries was 2x transport
  near(p.groceries / p.transport, 2, 1e-9);
});

test("rebalance: clamps to 0-100 and splits evenly when the others are all zero", () => {
  const zeros = Object.fromEntries(Budget.DEFAULT_CATEGORIES.map((c) => [c.id, 0]));
  const p = Budget.rebalance(zeros, "housing", 30);
  near(p.groceries, 70 / (Budget.DEFAULT_CATEGORIES.length - 1)); // the remainder split evenly among the others
  near(Budget.rebalance(zeros, "housing", 250).housing, 100);
  near(Object.values(Budget.rebalance(zeros, "housing", -5)).reduce((a, b) => a + b, 0), 100, 1e-9);
});

test("normalize: scales to 100 and handles an all-zero budget", () => {
  const p = Budget.normalize({ housing: 30, savings: 10 });
  near(p.housing, 75);
  near(p.savings, 25);
  near(Object.values(Budget.normalize({})).reduce((a, b) => a + b, 0), 100, 1e-9);
});

test("rebalance with locks: locked categories never move, the rest absorb the change", () => {
  const start = Budget.PRESETS[Budget.DEFAULT_PRESET];
  const locked = { savings: true, housing: true };
  const p = Budget.rebalance(start, "groceries", 20, locked);
  near(p.savings, 20);
  near(p.housing, 25);
  near(p.groceries, 20);
  near(Object.values(p).reduce((a, b) => a + b, 0), 100, 1e-9);
});

test("rebalance with locks: value is capped to what the locked categories leave", () => {
  const p = Budget.rebalance(Budget.PRESETS[Budget.DEFAULT_PRESET], "groceries", 90, { savings: true, housing: true });
  near(p.groceries, 55); // 100 - 20 - 25
  near(p.dining, 0);
  near(Object.values(p).reduce((a, b) => a + b, 0), 100, 1e-9);
});

test("rebalance with locks: if everything else is locked, the changed category takes the remainder", () => {
  const locked = Object.fromEntries(Budget.DEFAULT_CATEGORIES.filter((c) => c.id !== "dining" && c.id !== "shopping").map((c) => [c.id, true]));
  const p = Budget.rebalance(Budget.PRESETS[Budget.DEFAULT_PRESET], "dining", 5, locked);
  near(p.dining + p.shopping, 20); // 100 minus everything locked (25+5+10+5+5+10+20)
  near(p.dining, 5);
  const onlyOne = Object.fromEntries(Budget.DEFAULT_CATEGORIES.filter((c) => c.id !== "dining").map((c) => [c.id, true]));
  near(Budget.rebalance(Budget.PRESETS[Budget.DEFAULT_PRESET], "dining", 5, onlyOne).dining, 10); // 100 minus the other eight (90)
});

test("normalize with locks keeps locked values and scales the rest", () => {
  const p = Budget.normalize({ housing: 30, savings: 10, dining: 10 }, { housing: true });
  near(p.housing, 30);
  near(p.savings + p.dining, 70);
  near(p.savings, p.dining);
});

test("normalize with every category locked returns them unchanged (no NaN)", () => {
  const all = Object.fromEntries(Budget.DEFAULT_CATEGORIES.map((c) => [c.id, true]));
  const p = Budget.normalize(Budget.PRESETS[Budget.DEFAULT_PRESET], all);
  assert.deepEqual(p, Budget.PRESETS[Budget.DEFAULT_PRESET]);
});

test("paychecks: 26 a year, so a paycheck is smaller than a month's pay", () => {
  assert.equal(Budget.PAY_PERIODS_PER_YEAR, 26);
  const t = Tax.estimateTax({ salary: 78000 });
  near(78000 / Budget.PAY_PERIODS_PER_YEAR, 3000);
  assert.ok(t.net / Budget.PAY_PERIODS_PER_YEAR < t.netMonthly);
});

test("rebalance: editing a locked category directly is allowed; unlocked ones absorb the change, other locked ones stay", () => {
  const start = Budget.PRESETS[Budget.DEFAULT_PRESET]; // housing 25, savings 20, donations 10, ...
  const locked = { housing: true, savings: true };
  const p = Budget.rebalance(start, "housing", 35, locked);
  near(p.housing, 35);          // the pinned category took the user's value
  near(p.savings, 20);          // the other pinned one didn't move
  near(Object.values(p).reduce((a, b) => a + b, 0), 100, 1e-9);
  assert.ok(p.dining < start.dining && p.groceries < start.groceries); // unlocked ones gave up the difference
});

test("rebalance: a locked category's edit is still capped by the other locked ones", () => {
  const p = Budget.rebalance(Budget.PRESETS[Budget.DEFAULT_PRESET], "housing", 95, { housing: true, savings: true });
  near(p.housing, 80); // 100 - savings (20)
  near(p.savings, 20);
});

test("donations: a category defaulting to 10% of take-home in every preset and new scenarios", () => {
  assert.ok(Budget.DEFAULT_CATEGORIES.some((c) => c.id === "donations"));
  for (const [name, p] of Object.entries(Budget.PRESETS)) assert.equal(p.donations, 10, name);
  const s = Budget.createScenario();
  assert.equal(s.percents.donations, 10);
  const a = Budget.allocate(5000, s.percents);
  near(a.rows.find((r) => r.id === "donations").amount, 500);
});

test("scenarios saved before donations existed total <100% rather than breaking", () => {
  const old = { ...Budget.PRESETS[Budget.DEFAULT_PRESET] };
  delete old.donations;
  const a = Budget.allocate(5000, old);
  near(a.unallocatedPct, 10);
  near(a.rows.find((r) => r.id === "donations").pct, 0);
});

// ---- editable categories -----------------------------------------------------

const D = Budget.DEFAULT_CATEGORIES;

test("addCategory appends a uniquely-id'd category with a trimmed label", () => {
  let cats = Budget.addCategory(D, "  Pets  ");
  cats = Budget.addCategory(cats, "Pets");
  assert.equal(cats.length, D.length + 2);
  assert.equal(cats[D.length].label, "Pets");
  assert.notEqual(cats[D.length].id, cats[D.length + 1].id);
  assert.equal(Budget.addCategory(D, "   ").at(-1).label, "New category");
  assert.equal(D.length, 9); // the input wasn't mutated
});

test("renameCategory / moveCategory / removeCategory return new lists and leave the input alone", () => {
  const renamed = Budget.renameCategory(D, "housing", "Rent");
  assert.equal(renamed[0].label, "Rent");
  assert.equal(D[0].label, "Housing (rent)");
  const down = Budget.moveCategory(D, "housing", +1);
  assert.deepEqual(down.slice(0, 2).map((c) => c.id), ["utilities", "housing"]);
  assert.equal(Budget.moveCategory(D, "housing", -1), D); // already first: unchanged
  assert.equal(Budget.moveCategory(D, "savings", +1), D); // already last
  assert.equal(Budget.moveCategory(D, "nope", +1), D);
  assert.equal(Budget.removeCategory(D, "groceries").some((c) => c.id === "groceries"), false);
  assert.equal(D.length, 9);
});

test("dropCategory removes a category's percent and lock from a scenario", () => {
  const s = Budget.createScenario({ locked: { groceries: true, savings: true } });
  const out = Budget.dropCategory(s, "groceries");
  assert.equal("groceries" in out.percents, false);
  assert.equal("groceries" in out.locked, false);
  assert.equal(out.locked.savings, true);
  assert.equal(s.percents.groceries, 10); // original untouched
});

test("allocate / rebalance / normalize work over a custom category list", () => {
  const cats = [{ id: "rent", label: "Rent" }, { id: "pets", label: "Pets" }, { id: "fun", label: "Fun" }];
  const a = Budget.allocate(1000, { rent: 50, pets: 10 }, cats);
  assert.deepEqual(a.rows.map((r) => r.label), ["Rent", "Pets", "Fun"]);
  near(a.unallocatedPct, 40);
  const r = Budget.rebalance({ rent: 50, pets: 10, fun: 40 }, "pets", 30, { rent: true }, cats);
  near(r.rent, 50); near(r.pets, 30); near(r.fun, 20);
  const n = Budget.normalize({ rent: 30, pets: 10, fun: 10 }, { rent: true }, cats);
  near(n.rent, 30); near(n.pets + n.fun, 70);
});

test("a category with no stored percent counts as 0, so a freshly added one doesn't disturb totals", () => {
  const cats = Budget.addCategory(D, "Pets");
  const a = Budget.allocate(5000, Budget.PRESETS[Budget.DEFAULT_PRESET], cats);
  near(a.unallocatedPct, 0);
  assert.equal(a.rows.at(-1).pct, 0);
});

test("applyPreset adapts to the current categories and still totals 100", () => {
  const sum = (o) => Object.values(o).reduce((x, y) => x + y, 0);
  near(sum(Budget.applyPreset(Budget.DEFAULT_PRESET, D)), 100, 1e-9);
  assert.deepEqual(Budget.applyPreset(Budget.DEFAULT_PRESET, D), Budget.PRESETS[Budget.DEFAULT_PRESET]);
  // delete shopping (10%): the other categories scale up to fill 100
  const noShopping = Budget.removeCategory(D, "shopping");
  const p = Budget.applyPreset(Budget.DEFAULT_PRESET, noShopping);
  near(sum(p), 100, 1e-9);
  assert.equal("shopping" in p, false);
  assert.ok(p.housing > 25);
  // a custom category starts at 0 under a preset
  const withPets = Budget.addCategory(D, "Pets");
  near(Budget.applyPreset(Budget.DEFAULT_PRESET, withPets)[withPets.at(-1).id], 0);
  // only custom categories: even split rather than NaN
  const only = Budget.addCategory([], "A");
  near(Budget.applyPreset(Budget.DEFAULT_PRESET, only)[only[0].id], 100);
  assert.deepEqual(Budget.applyPreset(Budget.DEFAULT_PRESET, []), {});
});

test("cleanCategories validates stored data", () => {
  assert.equal(Budget.cleanCategories("x"), null);
  assert.equal(Budget.cleanCategories(null), null);
  assert.deepEqual(Budget.cleanCategories([]), []);
  assert.deepEqual(Budget.cleanCategories([{ id: "a", label: "A" }, { id: "a" }, { label: "x" }, { id: "b" }]),
    [{ id: "a", label: "A" }, { id: "b", label: "b" }]);
});

// ---- rest-of-year plan ---------------------------------------------------------

const PLAN_CATS = [{ id: "a", label: "A" }, { id: "b", label: "B" }];
const plan = (o) => Budget.planRestOfYear({ netMonthly: 5000, percents: { a: 60, b: 40 }, categories: PLAN_CATS, monthsCovered: 6, monthsLeft: 6, ...o });

test("monthsLeftInYear counts from a date to Dec 31, never negative", () => {
  near(Budget.monthsLeftInYear(Date.UTC(2026, 9, 4)), 2.9, 0.06);
  assert.equal(Budget.monthsLeftInYear(Date.UTC(2026, 11, 31)), 0);
  near(Budget.monthsLeftInYear(Date.UTC(2026, 0, 1)), 12, 0.06);
});

test("plan: spending exactly on budget keeps the same monthly budget going forward", () => {
  const p = plan({ spent: { a: 18000, b: 12000 } });
  near(p.pot, 60000);
  near(p.available, 30000);
  near(p.rows[0].perMonth, 3000);
  near(p.rows[1].perMonth, 2000);
  assert.equal(p.scale, 1);
  assert.equal(p.broke, false);
  near(p.unallocated, 0);
});

test("plan: a category that blew its months gets less later and the under-spent one gets more (the year evens out)", () => {
  const p = plan({ spent: { a: 25000, b: 5000 } }); // A over its half-year share, B well under
  near(p.rows[0].remaining, 11000);
  near(p.rows[1].remaining, 19000);
  near(p.rows[0].perMonth, 11000 / 6);
  near(p.rows[1].perMonth, 19000 / 6);
  near(p.rows[0].perMonth + p.rows[1].perMonth, 5000); // still spends exactly the monthly take-home
});

test("plan: a category already over its whole-year target gets 0, and the rest scale to the money really left", () => {
  const p = plan({ spent: { a: 40000, b: 5000 } }); // A is 4000 past its annual 36000
  assert.equal(p.rows[0].over, true);
  assert.equal(p.rows[0].perMonth, 0);
  near(p.overspent, 4000);
  near(p.available, 15000);          // 30000 still to come + (30000 received - 45000 spent)
  near(p.scale, 15000 / 19000);
  near(p.rows[1].perMonth, 15000 / 6);
});

test("plan: when more has been spent than there is income, nothing is available", () => {
  const p = plan({ spent: { a: 50000, b: 20000 } });
  assert.equal(p.broke, true);
  assert.ok(p.available < 0);
  assert.ok(p.rows.every((r) => r.perMonth === 0));
});

test("plan: received / to-come overrides replace the estimates; percents under 100 leave money unallocated", () => {
  const p = plan({ spent: { a: 10000, b: 10000 }, received: 40000, toCome: 20000, percents: { a: 50, b: 30 } });
  near(p.pot, 60000);
  near(p.available, 20000 + (40000 - 20000));
  near(p.rows[0].remaining, 30000 - 10000);
  assert.ok(p.unallocated > 0); // 20% of the pot isn't assigned to any category
});

test("plan: the year being over (or no months left) returns ended instead of dividing by zero", () => {
  assert.deepEqual(plan({ spent: {}, monthsLeft: 0 }), { ended: true });
  assert.deepEqual(plan({ spent: {}, monthsLeft: 0.04 }), { ended: true });
});

// ---- rent paid from the paycheck -------------------------------------------------

test("rent from the paycheck doesn't change take-home or tax; it only splits it into rent and what lands in the account", () => {
  const base = Tax.estimateTax({ salary: 90000 });
  const withRent = Tax.estimateTax({ salary: 90000, rentFromPaycheck: 1500 });
  near(withRent.net, base.net);
  near(withRent.totalTax, base.totalTax);
  near(withRent.rent, 18000);
  near(withRent.deposit, base.net - 18000);
  near(withRent.depositMonthly, base.netMonthly - 1500);
  assert.equal(base.rent, 0);
  near(base.deposit, base.net);
});

test("rent from the paycheck can't take more than take-home, and junk input counts as 0", () => {
  const t = Tax.estimateTax({ salary: 20000, rentFromPaycheck: 5000 });
  assert.ok(t.deposit >= 0 && Number.isFinite(t.deposit));
  near(t.rent, t.net);
  assert.equal(Tax.estimateTax({ salary: 90000, rentFromPaycheck: "abc" }).rent, 0);
  assert.equal(Tax.estimateTax({ salary: 90000, rentFromPaycheck: -200 }).rent, 0);
});

test("rentShare: rent as a percent of take-home, capped and safe", () => {
  near(Budget.rentShare(5000, 1500), 30);
  assert.equal(Budget.rentShare(0, 1500), 0);
  assert.equal(Budget.rentShare(5000, 0), 0);
  assert.equal(Budget.rentShare(5000, "x"), 0);
  assert.equal(Budget.rentShare(1000, 5000), 100);
});

test("a fixed Housing share plus normalize keeps the rest of the budget summing to 100", () => {
  const share = Budget.rentShare(5000, 1500); // 30%
  const start = { ...Budget.PRESETS[Budget.DEFAULT_PRESET], housing: share };
  const p = Budget.normalize(start, { housing: true });
  near(p.housing, 30);
  near(Object.values(p).reduce((a, b) => a + b, 0), 100, 1e-9);
  // rebalancing another category leaves the rent share alone
  const r = Budget.rebalance(p, "dining", 20, { housing: true });
  near(r.housing, 30);
  near(Object.values(r).reduce((a, b) => a + b, 0), 100, 1e-9);
});

test("new scenarios default to no paycheck rent", () => {
  assert.equal(Budget.createScenario().rentFromPaycheck, 0);
});
