const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createDrive, DriveAuthError } = require("../gdrive.js");
const { decideSync, serializeState, parseState } = require("../sync.js");

const drive = createDrive({ clientId: "cid", apiKey: "key", appId: "123", fileName: "hestia-scenarios.json", folderName: "Hestia" });

test("decideSync: empty Drive file gets the local data", () => {
  assert.equal(decideSync({ localUpdatedAt: 0, syncedAt: 0, driveUpdatedAt: 0, driveHasData: false }), "push");
});

test("decideSync: first connect on a fresh browser pulls what's in Drive", () => {
  assert.equal(decideSync({ localUpdatedAt: 0, syncedAt: 0, driveUpdatedAt: 500, driveHasData: true }), "pull");
});

test("decideSync: only local changed → push; only Drive changed → pull; neither → none", () => {
  assert.equal(decideSync({ localUpdatedAt: 900, syncedAt: 500, driveUpdatedAt: 500, driveHasData: true }), "push");
  assert.equal(decideSync({ localUpdatedAt: 500, syncedAt: 500, driveUpdatedAt: 900, driveHasData: true }), "pull");
  assert.equal(decideSync({ localUpdatedAt: 500, syncedAt: 500, driveUpdatedAt: 500, driveHasData: true }), "none");
});

test("decideSync: both sides changed since the last sync → conflict", () => {
  assert.equal(decideSync({ localUpdatedAt: 900, syncedAt: 500, driveUpdatedAt: 700, driveHasData: true }), "conflict");
  // never synced, but this browser was edited and Drive already has data
  assert.equal(decideSync({ localUpdatedAt: 900, syncedAt: 0, driveUpdatedAt: 700, driveHasData: true }), "conflict");
});

test("decideSync: identical timestamps are already in sync", () => {
  assert.equal(decideSync({ localUpdatedAt: 700, syncedAt: 0, driveUpdatedAt: 700, driveHasData: true }), "none");
});

test("serializeState / parseState round-trip", () => {
  const scenarios = [{ id: "a", name: "Job A", salary: 90000, locked: { savings: true } }];
  const categories = [{ id: "housing", label: "Rent" }, { id: "c1", label: "Pets" }];
  const parsed = parseState(serializeState({ scenarios, categories, updatedAt: 1234 }));
  assert.deepEqual(parsed, { scenarios, categories, actuals: null, updatedAt: 1234 });
});

test("parseState: empty file is null; foreign or broken JSON is refused", () => {
  assert.equal(parseState(""), null);
  assert.equal(parseState("  \n"), null);
  assert.throws(() => parseState("{nope"), /valid JSON/);
  assert.throws(() => parseState(JSON.stringify({ some: "other file" })), /Hestia/);
});

// ---- REST helpers against a stubbed fetch ----------------------------------

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options);
  };
  return calls;
}
const jsonRes = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

test("findDriveFile queries by name, sends the bearer token, returns the newest match", async () => {
  drive._setToken("tok");
  const calls = stubFetch(() => jsonRes({ files: [{ id: "f1", name: "hestia-scenarios.json" }] }));
  const file = await drive.find();
  assert.deepEqual(file, { id: "f1", name: "hestia-scenarios.json" });
  assert.equal(new URL(calls[0].url).searchParams.get("q"), "name='hestia-scenarios.json' and trashed=false");
  assert.equal(calls[0].options.headers.Authorization, "Bearer tok");
});

test("findDriveFile returns null when nothing matches", async () => {
  drive._setToken("tok");
  stubFetch(() => jsonRes({ files: [] }));
  assert.equal(await drive.find(), null);
});

test("a 401 clears the token and surfaces a DriveAuthError", async () => {
  drive._setToken("expired");
  stubFetch(() => jsonRes({}, 401));
  await assert.rejects(() => drive.read("f1"), DriveAuthError);
  assert.equal(drive.isConnected(), false);
});

test("calling Drive without a token fails fast without hitting the network", async () => {
  drive._setToken(null);
  const calls = stubFetch(() => jsonRes({}));
  await assert.rejects(() => drive.find(), DriveAuthError);
  assert.equal(calls.length, 0);
});

test("createDriveFile uploads multipart JSON with the file name", async () => {
  drive._setToken("tok");
  const calls = stubFetch(() => jsonRes({ id: "new", name: "hestia-scenarios.json" }));
  const file = await drive.create('{"app":"hestia"}');
  assert.equal(file.id, "new");
  assert.equal(calls[0].options.method, "POST");
  assert.match(calls[0].options.headers["Content-Type"], /^multipart\/related; boundary=/);
  assert.match(calls[0].options.body, /"name":"hestia-scenarios\.json"/);
  assert.match(calls[0].options.body, /\{"app":"hestia"\}/);
});

test("find with a parent folder restricts the search to that folder", async () => {
  drive._setToken("tok");
  const calls = stubFetch(() => jsonRes({ files: [] }));
  await drive.find(undefined, "folder1");
  assert.equal(new URL(calls[0].url).searchParams.get("q"),
    "name='hestia-scenarios.json' and trashed=false and 'folder1' in parents");
});

test("findFolder searches by folder name and folder mime type", async () => {
  drive._setToken("tok");
  const calls = stubFetch(() => jsonRes({ files: [{ id: "d1", name: "Hestia" }] }));
  assert.deepEqual(await drive.findFolder(), { id: "d1", name: "Hestia" });
  assert.equal(new URL(calls[0].url).searchParams.get("q"),
    "name='Hestia' and mimeType='application/vnd.google-apps.folder' and trashed=false");
});

test("names with quotes are escaped in the Drive query", async () => {
  drive._setToken("tok");
  const calls = stubFetch(() => jsonRes({ files: [] }));
  await drive.findFolder("Alex's budget");
  assert.match(new URL(calls[0].url).searchParams.get("q"), /name='Alex\\'s budget'/);
});

test("createFolder posts a folder-typed file", async () => {
  drive._setToken("tok");
  const calls = stubFetch(() => jsonRes({ id: "d2", name: "Hestia" }));
  assert.deepEqual(await drive.createFolder(), { id: "d2", name: "Hestia" });
  assert.deepEqual(JSON.parse(calls[0].options.body), { name: "Hestia", mimeType: "application/vnd.google-apps.folder" });
});

test("create puts the file in the given folder", async () => {
  drive._setToken("tok");
  const calls = stubFetch(() => jsonRes({ id: "n1", name: "hestia-scenarios.json" }));
  await drive.create("{}", undefined, "d2");
  assert.match(calls[0].options.body, /"parents":\["d2"\]/);
});

test("move swaps the file's parents for the new folder, and does nothing if it's already there", async () => {
  drive._setToken("tok");
  let calls = stubFetch((url, o) => o.method === "PATCH" ? jsonRes({ id: "f1" }) : jsonRes({ parents: ["rootId"] }));
  await drive.move("f1", "d2");
  assert.equal(calls.length, 2);
  const patch = new URL(calls[1].url);
  assert.equal(calls[1].options.method, "PATCH");
  assert.equal(patch.searchParams.get("addParents"), "d2");
  assert.equal(patch.searchParams.get("removeParents"), "rootId");
  calls = stubFetch(() => jsonRes({ parents: ["d2"] }));
  await drive.move("f1", "d2");
  assert.equal(calls.length, 1); // only the parents lookup
});

test("non-401 failures carry the HTTP status so callers can react to a 404", async () => {
  drive._setToken("tok");
  stubFetch(() => jsonRes({}, 404));
  await assert.rejects(() => drive.read("gone"), (e) => e.status === 404 && /404/.test(e.message));
});

test("parseState: a version-1 file (no categories) still loads, with categories null", () => {
  const v1 = JSON.stringify({ app: "hestia", version: 1, updatedAt: 99, scenarios: [{ id: "a" }] });
  assert.deepEqual(parseState(v1), { scenarios: [{ id: "a" }], categories: null, actuals: undefined, updatedAt: 99 });
});

test("parseState: malformed categories are dropped or ignored rather than trusted", () => {
  const base = { app: "hestia", version: 2, updatedAt: 1, scenarios: [] };
  assert.equal(parseState(JSON.stringify({ ...base, categories: "nope" })).categories, null);
  const mixed = parseState(JSON.stringify({ ...base, categories: [{ id: "a", label: "A" }, { id: "a", label: "dup" }, { label: "no id" }, null, { id: "b" }] }));
  assert.deepEqual(mixed.categories, [{ id: "a", label: "A" }, { id: "b", label: "b" }]);
  assert.deepEqual(parseState(JSON.stringify({ ...base, categories: [] })).categories, []); // user deleted them all
});

test("actuals round-trip through the Drive file; a file without them parses as undefined, a cleared one as null", () => {
  const actuals = { totals: { groceries: 300, dining: 120 }, months: 3, start: "2026-01-01", end: "2026-03-31", importedAt: "2026-04-02T10:00:00.000Z" };
  const parsed = parseState(serializeState({ scenarios: [], categories: [], actuals, updatedAt: 5 }));
  assert.deepEqual(parsed.actuals, actuals);
  assert.equal(parseState(serializeState({ scenarios: [], categories: [], actuals: null, updatedAt: 5 })).actuals, null);
  assert.equal(parseState(JSON.stringify({ app: "hestia", version: 2, updatedAt: 1, scenarios: [] })).actuals, undefined);
});

test("cleanActuals drops junk: non-positive or non-numeric totals, bad months, malformed dates", () => {
  const { cleanActuals } = require("../sync.js");
  assert.equal(cleanActuals(null), null);
  assert.equal(cleanActuals({ totals: {}, months: 0 }), null);
  assert.equal(cleanActuals("x"), null);
  const c = cleanActuals({ totals: { a: 10, b: -5, c: "x", d: "7" }, months: "2", start: "last week", end: "2026-02-01" });
  assert.deepEqual(c, { totals: { a: 10, d: 7 }, months: 2, start: null, end: "2026-02-01", importedAt: null });
});
