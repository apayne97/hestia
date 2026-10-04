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
  { id: "savings", label: "Savings & investing" },
];

// Percent of TAKE-HOME pay. 50/30/20 puts 50% on needs (housing, utilities,
// groceries, transport, health), 30% on wants, 20% on savings.
const PRESETS = {
  "50/30/20": { housing: 25, utilities: 5, groceries: 10, transport: 5, health: 5, dining: 15, shopping: 15, savings: 20 },
  "60/20/20": { housing: 30, utilities: 5, groceries: 10, transport: 8, health: 7, dining: 10, shopping: 10, savings: 20 },
  "Frugal (40% saved)": { housing: 22, utilities: 4, groceries: 10, transport: 5, health: 4, dining: 8, shopping: 7, savings: 40 },
};
const DEFAULT_PRESET = "50/30/20";

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
    locked: {}, // category ids that auto-balance must not touch
    balance: false, // "Keep total at 100%": editing one category rescales the rest
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
// proportionally so the total stays 100. Locked categories never move (and
// can't be the one being changed); if you ask for more than is left after
// the locked ones, the value is capped. If the other unlocked categories are
// all zero they split the remainder equally; if there are none, the changed
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
  for (const id of free) out[id] = freeSum > 0 ? (pct(id) / freeSum) * available : available / free.length;
  return out;
}

// Max monthly rent by two common rules of thumb, both from GROSS income:
// rent ≤ 30% of gross monthly, and landlords' "annual income ≥ 40× rent".
function rentRules(grossAnnual) {
  const gross = Math.max(0, Number(grossAnnual) || 0);
  return { thirtyPercent: (gross * 0.3) / 12, fortyX: gross / 40 };
}

const Budget = { CATEGORIES, PRESETS, DEFAULT_PRESET, createScenario, allocate, rebalance, normalize, rentRules };
if (typeof module !== "undefined" && module.exports) module.exports = Budget;
