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
