// Hestia-specific sync logic: what goes in the Drive file, and when to push,
// pull, or ask. Pure functions (no DOM, no network) so they're unit tested.
// The generic Drive plumbing lives in gdrive.js.

// The Drive file's contents. `updatedAt` is when the scenarios were last
// edited (ms since epoch), which is what sync compares.
function serializeState({ scenarios, updatedAt }) {
  return JSON.stringify({ app: "hestia", version: 1, updatedAt, scenarios }, null, 2) + "\n";
}

// → { scenarios, updatedAt } or null for an empty/new file. Throws on a file
// that isn't Hestia's, so we never overwrite someone's unrelated JSON.
function parseState(text) {
  if (!text || !text.trim()) return null;
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error("That Drive file isn't valid JSON."); }
  if (data.app !== "hestia" || !Array.isArray(data.scenarios)) throw new Error("That Drive file isn't a Hestia scenarios file.");
  return { scenarios: data.scenarios, updatedAt: Number(data.updatedAt) || 0 };
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

if (typeof module !== "undefined" && module.exports) module.exports = { serializeState, parseState, decideSync };
