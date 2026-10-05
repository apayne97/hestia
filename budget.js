// Budget math: turn take-home pay + a set of percentages into dollar
// amounts, plus the usual rent rules of thumb. Pure functions, no DOM, so
// it can be unit tested with `node --test`.
//
// Categories are user data (add / rename / reorder / delete), shared by every
// scenario so side-by-side comparisons always line up. A scenario stores its
// percentages by category id; a category a scenario has no value for counts as
// 0%. DEFAULT_CATEGORIES is just where a new browser starts.

const DEFAULT_CATEGORIES = [
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

// Percent of TAKE-HOME pay, keyed by the DEFAULT_CATEGORIES ids. The
// "50/20/20 + 10 giving" preset is 50% needs (housing, utilities, groceries,
// transport, health), 20% wants, 20% savings and 10% donations — the classic
// 50/30/20 with the donations coming out of the wants. Every preset must total
// exactly 100 (a test checks).
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

// ---- categories --------------------------------------------------------------

// A preset's percentages for whatever categories exist now: ids the preset
// knows get its values, anything else (custom, or a default the user renamed
// to something new) starts at 0, and the result is scaled to total exactly 100
// — so deleting a category before applying a preset can't leave the budget
// short.
function applyPreset(name, categories = DEFAULT_CATEGORIES) {
  const preset = PRESETS[name] || PRESETS[DEFAULT_PRESET];
  const raw = {};
  for (const c of categories) raw[c.id] = preset[c.id] || 0;
  return normalize(raw, {}, categories);
}

let nextCategoryId = 1;
// → new list with a fresh category appended. Ids never collide with existing ones.
function addCategory(categories, label = "New category") {
  const taken = new Set(categories.map((c) => c.id));
  let id;
  do { id = `c${Date.now().toString(36)}${nextCategoryId++}`; } while (taken.has(id));
  return [...categories, { id, label: String(label).trim() || "New category" }];
}

function renameCategory(categories, id, label) {
  return categories.map((c) => (c.id === id ? { ...c, label } : c));
}

// delta -1 = up, +1 = down; stays put at either end.
function moveCategory(categories, id, delta) {
  const i = categories.findIndex((c) => c.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= categories.length) return categories;
  const out = categories.slice();
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

function removeCategory(categories, id) {
  return categories.filter((c) => c.id !== id);
}

// A scenario without any trace of a deleted category.
function dropCategory(scenario, id) {
  const percents = { ...scenario.percents };
  const locked = { ...scenario.locked };
  delete percents[id];
  delete locked[id];
  return { ...scenario, percents, locked };
}

// Whatever came out of storage / a Drive file → a valid category list, or null
// if it isn't one (callers then fall back to the defaults). An empty list is
// valid: the user may have deleted everything.
function cleanCategories(raw) {
  if (!Array.isArray(raw)) return null;
  const seen = new Set();
  const out = [];
  for (const c of raw) {
    if (!c || typeof c.id !== "string" || !c.id || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push({ id: c.id, label: typeof c.label === "string" ? c.label : c.id });
  }
  return out;
}

// ---- allocation ----------------------------------------------------------------

// → { rows: [{id,label,pct,amount}], totalPct, unallocatedPct, unallocatedAmount }
// amounts are per month. Unallocated goes negative when percents add to
// more than 100 — callers show that as an over-budget warning.
function allocate(netMonthly, percents, categories = DEFAULT_CATEGORIES) {
  const rows = categories.map(({ id, label }) => {
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
function rebalance(percents, changedId, value, locked = {}, categories = DEFAULT_CATEGORIES) {
  const ids = categories.map((c) => c.id);
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
function normalize(percents, locked = {}, categories = DEFAULT_CATEGORIES) {
  const ids = categories.map((c) => c.id);
  const pct = (id) => Number(percents[id]) || 0;
  const lockedIds = ids.filter((id) => locked[id]);
  const free = ids.filter((id) => !locked[id]);
  const available = Math.max(0, 100 - lockedIds.reduce((sum, id) => sum + pct(id), 0));
  const freeSum = free.reduce((sum, id) => sum + pct(id), 0);
  const out = {};
  for (const id of lockedIds) out[id] = pct(id);
  if (!free.length) return out; // everything locked (or no categories at all): nothing to scale
  for (const id of free) out[id] = freeSum > 0 ? (pct(id) / freeSum) * available : available / free.length;
  return out;
}

// Max monthly rent by two common rules of thumb, both from GROSS income:
// rent ≤ 30% of gross monthly, and landlords' "annual income ≥ 40× rent".
function rentRules(grossAnnual) {
  const gross = Math.max(0, Number(grossAnnual) || 0);
  return { thirtyPercent: (gross * 0.3) / 12, fortyX: gross / 40 };
}

const Budget = {
  PAY_PERIODS_PER_YEAR, DEFAULT_CATEGORIES, PRESETS, DEFAULT_PRESET,
  createScenario, applyPreset, addCategory, renameCategory, moveCategory, removeCategory, dropCategory, cleanCategories,
  allocate, rebalance, normalize, rentRules,
};
if (typeof module !== "undefined" && module.exports) module.exports = Budget;
