const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createDrive, DriveAuthError } = require("../gdrive.js");
const { decideSync, serializeState, parseState } = require("../sync.js");

const drive = createDrive({ clientId: "cid", apiKey: "key", appId: "123", fileName: "hestia-scenarios.json" });

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
  const parsed = parseState(serializeState({ scenarios, updatedAt: 1234 }));
  assert.deepEqual(parsed, { scenarios, updatedAt: 1234 });
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
