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
    assert.deepEqual(Object.keys(p).sort(), Budget.CATEGORIES.map((c) => c.id).sort(), name);
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
  const p = Budget.rebalance(Budget.PRESETS["50/30/20"], "housing", 40);
  near(p.housing, 40);
  near(Object.values(p).reduce((a, b) => a + b, 0), 100, 1e-9);
  // others keep their relative proportions: groceries was 2x transport
  near(p.groceries / p.transport, 2, 1e-9);
});

test("rebalance: clamps to 0-100 and splits evenly when the others are all zero", () => {
  const zeros = Object.fromEntries(Budget.CATEGORIES.map((c) => [c.id, 0]));
  const p = Budget.rebalance(zeros, "housing", 30);
  near(p.groceries, 10); // 70 / 7 others
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
  const start = Budget.PRESETS["50/30/20"];
  const locked = { savings: true, housing: true };
  const p = Budget.rebalance(start, "groceries", 20, locked);
  near(p.savings, 20);
  near(p.housing, 25);
  near(p.groceries, 20);
  near(Object.values(p).reduce((a, b) => a + b, 0), 100, 1e-9);
});

test("rebalance with locks: value is capped to what the locked categories leave", () => {
  const p = Budget.rebalance(Budget.PRESETS["50/30/20"], "groceries", 90, { savings: true, housing: true });
  near(p.groceries, 55); // 100 - 20 - 25
  near(p.dining, 0);
  near(Object.values(p).reduce((a, b) => a + b, 0), 100, 1e-9);
});

test("rebalance with locks: if everything else is locked, the changed category takes the remainder", () => {
  const locked = Object.fromEntries(Budget.CATEGORIES.filter((c) => c.id !== "dining" && c.id !== "shopping").map((c) => [c.id, true]));
  const p = Budget.rebalance(Budget.PRESETS["50/30/20"], "dining", 5, locked);
  near(p.dining + p.shopping, 30);
  near(p.dining, 5);
  const onlyOne = Object.fromEntries(Budget.CATEGORIES.filter((c) => c.id !== "dining").map((c) => [c.id, true]));
  near(Budget.rebalance(Budget.PRESETS["50/30/20"], "dining", 5, onlyOne).dining, 15);
});

test("normalize with locks keeps locked values and scales the rest", () => {
  const p = Budget.normalize({ housing: 30, savings: 10, dining: 10 }, { housing: true });
  near(p.housing, 30);
  near(p.savings + p.dining, 70);
  near(p.savings, p.dining);
});
