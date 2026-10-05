// Budget math: turn take-home pay + a set of percentages into dollar
// amounts, plus the usual rent rules of thumb. Pure functions, no DOM, so
// it can be unit tested with `node --test`.

const CATEGORIES = [
  { id: "housing", label: "Housing (rent)" },
  { id: "utilities", label: "Utilities & internet" },
  { id: "groceries", label: "Groceries" },
  { id: "transport", label: "Transportation" },
  { id: "health", label: "Health & insurance" },
  { id: "dining", label: "Dining out & fun" },
  { id: "shopping", label: "Shopping & misc" },
  { id: "donations", label: "Donations" },
  { id: "savings", label: "Savings & investing" },
];

// Percent of TAKE-HOME pay. The "50/20/20 + 10 giving" preset is 50% needs
// (housing, utilities, groceries, transport, health), 20% wants, 20% savings
// and 10% donations — the classic 50/30/20 with the donations coming out of
// the wants. Every preset must total exactly 100 (a test checks).
const PRESETS = {
  "50/20/20 + 10 giving": { housing: 25, utilities: 5, groceries: 10, transport: 5, health: 5, dining: 10, shopping: 10, donations: 10, savings: 20 },
  "60/10/20 + 10 giving": { housing: 30, utilities: 5, groceries: 10, transport: 8, health: 7, dining: 5, shopping: 5, donations: 10, savings: 20 },
  "Frugal (30% saved)": { housing: 22, utilities: 4, groceries: 10, transport: 5, health: 4, dining: 8, shopping: 7, donations: 10, savings: 30 },
};
const DEFAULT_PRESET = "50/20/20 + 10 giving";

// Biweekly pay: 26 paychecks a year (not 24, and not 12 x 2).
const PAY_PERIODS_PER_YEAR = 26;

let nextId = 1;
function createScenario(overrides = {}) {
  return {
    id: `s${Date.now().toString(36)}${nextId++}`,
    name: "Scenario",
    salary: 80000,
    filing: "single",
    stateRate: 0,
    pretax401kPct: 0,
    healthMonthly: 0,
    locked: {}, // "pinned" category ids: auto-balancing never moves them (you can still edit them yourself). While any category is pinned, the total is held at 100%.
    percents: { ...PRESETS[DEFAULT_PRESET] },
    ...overrides,
  };
}

// → { rows: [{id,label,pct,amount}], totalPct, unallocatedPct, unallocatedAmount }
// amounts are per month. Unallocated goes negative when percents add to
// more than 100 — callers show that as an over-budget warning.
function allocate(netMonthly, percents) {
  const rows = CATEGORIES.map(({ id, label }) => {
    const pct = Number(percents[id]) || 0;
    return { id, label, pct, amount: (netMonthly * pct) / 100 };
  });
  const totalPct = rows.reduce((sum, r) => sum + r.pct, 0);
  return {
    rows,
    totalPct,
    unallocatedPct: 100 - totalPct,
    unallocatedAmount: (netMonthly * (100 - totalPct)) / 100,
  };
}

// Set one category to `value`% and rescale every OTHER unlocked category
// proportionally so the total stays 100. Locked ("pinned") categories are
// never moved by auto-balancing — but the category being changed may itself
// be locked: pinning only protects a value from other edits, not from the
// user typing in it. If you ask for more than is left after the OTHER locked
// categories, the value is capped. If the other unlocked categories are all
// zero they split the remainder equally; if there are none, the changed
// category simply takes everything that's left. Returns a new percents object.
function rebalance(percents, changedId, value, locked = {}) {
  const ids = CATEGORIES.map((c) => c.id);
  const pct = (id) => Number(percents[id]) || 0;
  const lockedIds = ids.filter((id) => id !== changedId && locked[id]);
  const lockedSum = lockedIds.reduce((sum, id) => sum + pct(id), 0);
  const available = Math.max(0, 100 - lockedSum);
  const others = ids.filter((id) => id !== changedId && !locked[id]);
  const v = others.length ? Math.min(available, Math.max(0, Number(value) || 0)) : available;
  const remainder = available - v;
  const othersSum = others.reduce((sum, id) => sum + pct(id), 0);
  const out = { [changedId]: v };
  for (const id of lockedIds) out[id] = pct(id);
  for (const id of others) out[id] = othersSum > 0 ? (pct(id) / othersSum) * remainder : remainder / others.length;
  return out;
}

// Scale the unlocked categories proportionally so everything totals 100;
// locked ones keep their value.
function normalize(percents, locked = {}) {
  const ids = CATEGORIES.map((c) => c.id);
  const pct = (id) => Number(percents[id]) || 0;
  const lockedIds = ids.filter((id) => locked[id]);
  const free = ids.filter((id) => !locked[id]);
  const available = Math.max(0, 100 - lockedIds.reduce((sum, id) => sum + pct(id), 0));
  const freeSum = free.reduce((sum, id) => sum + pct(id), 0);
  const out = {};
  for (const id of lockedIds) out[id] = pct(id);
  if (!free.length) return out; // everything locked: nothing to scale
  for (const id of free) out[id] = freeSum > 0 ? (pct(id) / freeSum) * available : available / free.length;
  return out;
}

// Max monthly rent by two common rules of thumb, both from GROSS income:
// rent ≤ 30% of gross monthly, and landlords' "annual income ≥ 40× rent".
function rentRules(grossAnnual) {
  const gross = Math.max(0, Number(grossAnnual) || 0);
  return { thirtyPercent: (gross * 0.3) / 12, fortyX: gross / 40 };
}

const Budget = { PAY_PERIODS_PER_YEAR, CATEGORIES, PRESETS, DEFAULT_PRESET, createScenario, allocate, rebalance, normalize, rentRules };
if (typeof module !== "undefined" && module.exports) module.exports = Budget;
