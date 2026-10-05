// Hestia-specific sync logic: what goes in the Drive file, and when to push,
// pull, or ask. Pure functions (no DOM, no network) so they're unit tested.
// The generic Drive plumbing lives in gdrive.js.

// The Drive file's contents. `updatedAt` is when the scenarios or categories
// were last edited (ms since epoch), which is what sync compares.
// Version 2 added the shared `categories` list; version 3 added `actuals`
// (per-category spending totals from an imported CSV — never the transactions).
function serializeState({ scenarios, categories, actuals = null, updatedAt }) {
  return JSON.stringify({ app: "hestia", version: 3, updatedAt, categories, actuals, scenarios }, null, 2) + "\n";
}

// → { scenarios, categories, actuals, updatedAt } or null for an empty/new file.
// `categories` is null when the file has none (a version-1 file, or garbage) —
// callers then keep their own. `actuals` is undefined when the file predates
// them (keep ours), null when the user cleared them, else the cleaned object. Throws on a file that isn't Hestia's, so we
// never overwrite someone's unrelated JSON.
function parseState(text) {
  if (!text || !text.trim()) return null;
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error("That Drive file isn't valid JSON."); }
  if (data.app !== "hestia" || !Array.isArray(data.scenarios)) throw new Error("That Drive file isn't a Hestia scenarios file.");
  return { scenarios: data.scenarios, categories: cleanCategoriesList(data.categories),
    actuals: "actuals" in data ? cleanActuals(data.actuals) : undefined, updatedAt: Number(data.updatedAt) || 0 };
}

// Same validation as Budget.cleanCategories, kept local so sync.js stays
// standalone: a list of {id, label} with unique string ids, or null.
function cleanCategoriesList(raw) {
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

// Imported spending: { totals: {categoryId: dollars}, months, start, end, importedAt } or null.
function cleanActuals(raw) {
  if (!raw || typeof raw !== "object" || !raw.totals || typeof raw.totals !== "object") return null;
  const totals = {};
  for (const [id, v] of Object.entries(raw.totals)) if (Number.isFinite(Number(v)) && Number(v) > 0) totals[id] = Number(v);
  const months = Number(raw.months);
  if (!(months > 0)) return null;
  const iso = (x) => (typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : null);
  return { totals, months, start: iso(raw.start), end: iso(raw.end), importedAt: typeof raw.importedAt === "string" ? raw.importedAt : null };
}

// What to do when connecting / syncing, given three timestamps:
//   localUpdatedAt — when this browser's scenarios last changed
//   syncedAt       — the updatedAt value both sides agreed on at the last sync (0 = never)
//   driveUpdatedAt — updatedAt stored in the Drive file
// → "push" | "pull" | "none" | "conflict" (both sides changed since last sync)
function decideSync({ localUpdatedAt, syncedAt, driveUpdatedAt, driveHasData }) {
  if (!driveHasData) return "push";
  const localChanged = localUpdatedAt > syncedAt;
  const driveChanged = driveUpdatedAt > syncedAt;
  if (localUpdatedAt === driveUpdatedAt) return "none";
  if (localChanged && driveChanged) return "conflict";
  if (driveChanged) return "pull";
  if (localChanged) return "push";
  return "none";
}

if (typeof module !== "undefined" && module.exports) module.exports = { serializeState, parseState, decideSync, cleanActuals };
