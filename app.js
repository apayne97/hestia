// Hestia UI: a row of scenario cards, each with salary → take-home →
// percentage sliders → dollar amounts. State lives in localStorage; typing
// patches the outputs in place (so inputs keep focus), and structural
// changes (add / delete / duplicate / preset / category edits) rebuild the cards.
// Categories (the budget's rows) are shared by every scenario and editable.
const STORAGE_KEY = "hestia-scenarios-v1";
const CATS_KEY = "hestia-categories-v1";
const ACTUALS_KEY = "hestia-actuals-v1";   // per-category spending totals from an imported CSV (never the transactions)
const CSVMAP_KEY = "hestia-csv-mapping-v1"; // remembered CSV category -> budget category choices
const COMPARE_KEY = "hestia-compare";
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const pctFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

// Google Drive sync (opt-in). Same Google Cloud project as lyre, so the
// origins this app is served from must be listed on that OAuth client — see
// gdrive.js. These values are public by design (the API key is restricted
// to our domains in the console).
const drive = createDrive({
  clientId: "646803858670-8r7k3h8mfgri92cqalhc8b70l3g62grd.apps.googleusercontent.com",
  apiKey: "AIzaSyAcogjzidhCeWPLJhUlUV0oT5xM1i1Jxx8",
  appId: "646803858670",
  fileName: "hestia-scenarios.json",
  folderName: "Hestia",
});
const LS = {
  updated: "hestia-updated-at", synced: "hestia-synced-at", file: "hestia-drive-file-id",
  folderId: "hestia-drive-folder-id", folderName: "hestia-drive-folder-name", picked: "hestia-drive-file-picked",
};
const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } };
const lsDel = (k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } };
let driveFileId = lsGet(LS.file);
let driveFolder = lsGet(LS.folderId) ? { id: lsGet(LS.folderId), name: lsGet(LS.folderName) || "Hestia" } : null;
let pushTimer = null;
let lastSyncAt = null; // when this session last confirmed Drive and this browser agree

const VIEW_KEY = "hestia-view";
let viewMode = "percent"; // "percent" | "dollar": which column of each category row is editable
try { if (localStorage.getItem(VIEW_KEY) === "dollar") viewMode = "dollar"; } catch (e) { /* ignore */ }

let categories = loadCategories();
let actuals = loadActuals(); // { totals: {categoryId: $ over the period}, months, start, end, importedAt } | null
let compareMode = "avg";     // "avg" (monthly average vs budget) | "year" (re-plan the rest of the year)
try { if (localStorage.getItem(COMPARE_KEY) === "year") compareMode = "year"; } catch (e) { /* ignore */ }
let editingCats = false; // "Edit categories" mode: rows show rename / move / delete instead of the numbers
let scenarios = loadScenarios();
const root = document.getElementById("scenarios");

function loadCategories() {
  try {
    const cats = Budget.cleanCategories(JSON.parse(localStorage.getItem(CATS_KEY)));
    if (cats) return cats;
  } catch (e) { /* no storage, or corrupt — fall through to the defaults */ }
  return Budget.DEFAULT_CATEGORIES.map((c) => ({ ...c }));
}

function loadActuals() {
  try { return cleanActuals(JSON.parse(localStorage.getItem(ACTUALS_KEY))); } catch (e) { return null; }
}

// A scenario whose percentages start from the default preset over the CURRENT categories.
function newScenario(overrides = {}) {
  return Budget.createScenario({ percents: Budget.applyPreset(Budget.DEFAULT_PRESET, categories), ...overrides });
}

function loadScenarios() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    // spread over fresh defaults so scenarios saved before a field existed still load
    if (Array.isArray(parsed) && parsed.length) return parsed.map((s) => enforceRent({ ...Budget.createScenario(), ...s }));
  } catch (e) { /* no storage, or corrupt — fall through to a fresh scenario */ }
  return [newScenario({ name: "Scenario 1" })];
}

const localUpdatedAt = () => Number(lsGet(LS.updated)) || 0;

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(scenarios));
    localStorage.setItem(CATS_KEY, JSON.stringify(categories));
    if (actuals) localStorage.setItem(ACTUALS_KEY, JSON.stringify(actuals));
    else localStorage.removeItem(ACTUALS_KEY);
  } catch (e) { /* private mode etc */ }
  lsSet(LS.updated, String(Date.now()));
  schedulePush();
}

// ---- Google Drive sync -------------------------------------------------------

const driveEls = {
  status: document.getElementById("driveStatus"), btn: document.getElementById("driveBtn"),
  folder: document.getElementById("driveFolder"), off: document.getElementById("driveOff"),
};

// message overrides the default status text for the current connection state
function renderDriveUI(message) {
  const linked = !!driveFileId;
  const live = linked && drive.isConnected();
  const where = driveFolder ? ` · in “${driveFolder.name}”` : "";
  const when = lastSyncAt ? ` ${lastSyncAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}` : "";
  driveEls.status.textContent = message || (live ? `☁ Synced${when}${where}` : linked ? "Drive linked — sign in to sync" : "");
  driveEls.folder.classList.toggle("hidden", !live);
  driveEls.btn.textContent = live ? "Sync now" : linked ? "Sign in & sync" : "Connect Google Drive";
  driveEls.off.classList.toggle("hidden", !linked);
}

function handleDriveError(e, { forgetFile = false } = {}) {
  if (forgetFile) { driveFileId = null; lsDel(LS.file); }
  renderDriveUI(e instanceof DriveAuthError ? "Google sign-in expired — click to reconnect" : `Drive: ${e.message}`);
}

function schedulePush() {
  if (!driveFileId || !drive.isConnected()) { if (driveFileId) renderDriveUI("Drive linked — changes not synced yet"); return; }
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushNow, 1000);
}

async function pushNow() {
  let stamp = localUpdatedAt();
  if (!stamp) { stamp = Date.now(); lsSet(LS.updated, String(stamp)); }
  renderDriveUI("Saving to Drive…");
  try {
    await drive.write(driveFileId, serializeState({ scenarios, categories, actuals, updatedAt: stamp }));
    lsSet(LS.synced, String(stamp));
    lastSyncAt = new Date();
    renderDriveUI();
  } catch (e) { handleDriveError(e); }
}

function applyPull(remote) {
  scenarios = remote.scenarios.map((s) => enforceRent({ ...Budget.createScenario(), ...s }));
  if (remote.categories) categories = remote.categories; // a version-1 Drive file has none: keep ours
  if (remote.actuals !== undefined) actuals = remote.actuals; // undefined = an older file that predates actuals: keep ours
  lsSet(STORAGE_KEY, JSON.stringify(scenarios));
  lsSet(CATS_KEY, JSON.stringify(categories));
  if (actuals) lsSet(ACTUALS_KEY, JSON.stringify(actuals)); else lsDel(ACTUALS_KEY);
  lsSet(LS.updated, String(remote.updatedAt));
  lsSet(LS.synced, String(remote.updatedAt));
  render();
}

function setDriveFolder(folder) {
  driveFolder = folder;
  if (folder) { lsSet(LS.folderId, folder.id); lsSet(LS.folderName, folder.name); }
  else { lsDel(LS.folderId); lsDel(LS.folderName); }
}

// The Hestia folder: remembered id → one we can find by name → created on
// demand. Keeping the file in a folder stops it cluttering the top of Drive.
async function ensureDriveFolder() {
  if (!driveFolder) setDriveFolder(await drive.findFolder() || await drive.createFolder());
  return driveFolder;
}

// Find (or create) the scenarios file, inside the Hestia folder.
// → {id, name}, or null if the user backed out.
async function resolveDriveFile() {
  if (!driveFolder) {
    const found = await drive.findFolder();
    if (found) setDriveFolder(found);
  }
  let file = driveFolder ? await drive.find(undefined, driveFolder.id) : null;
  if (file) return file;
  // A file left at the top level of Drive by an earlier version: move it into the folder.
  const stray = await drive.find();
  if (stray) {
    await drive.move(stray.id, (await ensureDriveFolder()).id);
    return stray;
  }
  const create = confirm("No Hestia file found in your Google Drive yet.\n\nOK = create one (in a “Hestia” folder) from this browser's scenarios.\nCancel = pick an existing file instead.");
  if (create) return drive.create("", undefined, (await ensureDriveFolder()).id);
  const picked = await drive.pick(driveFolder && driveFolder.id);
  if (picked) lsSet(LS.picked, "1"); // leave a hand-picked file where the user keeps it
  return picked;
}

async function syncWithDrive(retried = false) {
  const fresh = !driveFileId; // a file we're only just linking — forget it again if it turns out to be wrong
  renderDriveUI("Connecting…");
  try {
    if (!drive.isConnected()) await drive.connect();
    if (!driveFileId) {
      const file = await resolveDriveFile();
      if (!file) { renderDriveUI(); return; }
      driveFileId = file.id;
      lsSet(LS.file, file.id);
    }
    // A file linked before folders existed (or at the top level of Drive) gets
    // tidied into the Hestia folder — unless the user picked it themselves.
    if (!driveFolder && lsGet(LS.picked) !== "1") {
      await drive.move(driveFileId, (await ensureDriveFolder()).id);
    }
    const remote = parseState(await drive.read(driveFileId));
    let action = decideSync({
      localUpdatedAt: localUpdatedAt(),
      syncedAt: Number(lsGet(LS.synced)) || 0,
      driveUpdatedAt: remote ? remote.updatedAt : 0,
      driveHasData: !!remote,
    });
    if (action === "conflict") {
      action = confirm("Both this browser and Google Drive have changes since the last sync.\n\nOK = keep this browser's version (overwrites Drive).\nCancel = use Drive's version (replaces what's here).") ? "push" : "pull";
    }
    if (action === "pull") { applyPull(remote); lastSyncAt = new Date(); renderDriveUI(); }
    else if (action === "push") await pushNow();
    else { lsSet(LS.synced, String(localUpdatedAt())); lastSyncAt = new Date(); renderDriveUI(); }
  } catch (e) {
    // The linked file or folder is gone (deleted in Drive): unlink and look again / recreate.
    if (e.status === 404 && !fresh && !retried) {
      driveFileId = null; lsDel(LS.file); lsDel(LS.synced); setDriveFolder(null);
      return syncWithDrive(true);
    }
    handleDriveError(e, { forgetFile: fresh && !(e instanceof DriveAuthError) });
  }
}

driveEls.btn.addEventListener("click", () => syncWithDrive());
driveEls.folder.addEventListener("click", async () => {
  try {
    if (!drive.isConnected()) await drive.connect();
    const pickExisting = confirm("Move your Hestia file to a different Drive folder?\n\nOK = pick an existing folder.\nCancel = create a new folder.");
    let folder;
    if (pickExisting) folder = await drive.pickFolder();
    else {
      const name = (prompt("Name for the new folder:", "Hestia") || "").trim();
      if (name) folder = await drive.createFolder(name);
    }
    if (!folder) return;
    await drive.move(driveFileId, folder.id);
    setDriveFolder(folder);
    renderDriveUI();
  } catch (e) { handleDriveError(e); }
});
driveEls.off.addEventListener("click", () => {
  drive.disconnect();
  clearTimeout(pushTimer);
  driveFileId = null;
  lsDel(LS.file);
  lsDel(LS.synced);
  lsDel(LS.picked);
  lastSyncAt = null;
  setDriveFolder(null);
  renderDriveUI("Disconnected (your scenarios stay in this browser and in the Drive file)");
});

function buildCard(s) {
  const card = document.createElement("section");
  card.className = "card";
  card.dataset.id = s.id;
  card.innerHTML = `
    <div class="card-head">
      <input class="name" data-field="name" aria-label="Scenario name">
      <button type="button" data-action="duplicate" title="Duplicate">⧉</button>
      <button type="button" data-action="delete" title="Delete">✕</button>
    </div>
    <div class="inputs">
      <label>Salary (gross / yr)
        <input type="number" min="0" step="1000" data-field="salary">
      </label>
      <label>Filing status
        <select data-field="filing">
          ${Object.entries(Tax.FILING_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}
        </select>
      </label>
      <label>State income tax (effective %)
        <input type="number" min="0" max="20" step="0.1" data-field="stateRate">
      </label>
      <div class="pair">
        <label>401(k) (% of gross, pre-tax)
          <input type="number" min="0" max="100" step="0.5" data-field="pretax401kPct">
        </label>
        <label>Health premiums ($/mo, pre-tax)
          <input type="number" min="0" step="10" data-field="healthMonthly">
        </label>
      </div>
      <label>Rent paid from paycheck ($/mo)
        <input type="number" min="0" step="50" data-field="rentFromPaycheck" title="If your rent is deducted before your pay reaches your account, enter it here. It stays in the budget as a fixed Housing share of take-home, so this scenario still compares with ones where you pay rent yourself.">
      </label>
    </div>
    <table class="tax">
      <thead><tr><th></th><th>Year</th><th>Month</th><th title="Biweekly: year ÷ 26">Paycheck</th></tr></thead>
      <tbody>
        ${[["gross", "Gross pay"], ["federal", "Federal income tax"], ["socialSecurity", "Social Security"],
           ["medicare", "Medicare"], ["state", "State tax"],
           ["k401", "401(k) contribution"], ["health", "Health premiums"]]
          .map(([k, label]) => `<tr><td>${label}</td><td data-tax="${k}"></td><td data-tax-mo="${k}"></td><td data-tax-pay="${k}"></td></tr>`).join("")}
        <tr class="total"><td>Take-home</td><td data-tax="net"></td><td data-tax-mo="net"></td><td data-tax-pay="net"></td></tr>
        <tr class="rent-lines hidden"><td>Rent (from paycheck)</td><td data-tax="rent"></td><td data-tax-mo="rent"></td><td data-tax-pay="rent"></td></tr>
        <tr class="rent-lines deposit hidden"><td>Lands in your account</td><td data-tax="deposit"></td><td data-tax-mo="deposit"></td><td data-tax-pay="deposit"></td></tr>
      </tbody>
    </table>
    <p class="muted" data-out="effective"></p>
    <div class="preset-row">
      <label>Preset
        <select data-action="preset">
          <option value="">Apply a preset…</option>
          ${Object.keys(Budget.PRESETS).map((p) => `<option>${p}</option>`).join("")}
        </select>
      </label>
    </div>
    <div class="cats">
      <div class="cat cat-head"><span></span><span></span>
        <span class="seg view-toggle" role="group" aria-label="Edit budget in">
          <button type="button" data-view="percent">% of pay</button><button type="button" data-view="dollar">$ / month</button>
        </span></div>
      <div class="cat unalloc">
        <span class="cat-label"><span class="lock lock-static" title="Total is held at 100% while any category is pinned"></span>Unallocated</span><span></span>
        <span data-role="pct"></span><span data-role="amt"></span>
      </div>
      <div class="cat-add"><button type="button" data-action="cat-add">＋ Add category</button></div>
    </div>
    <details class="compare hidden" open>
      <summary>Budget vs. what you actually spent</summary>
      <div class="seg compare-toggle" role="group" aria-label="Comparison view">
        <button type="button" data-compare="avg">Monthly average</button><button type="button" data-compare="year">Rest of year</button>
      </div>
      <div class="compare-avg">
        <table class="cmp">
          <thead><tr><th></th><th>Budget</th><th>Actual</th><th title="Actual minus budget, per month">Diff</th></tr></thead>
          <tbody></tbody>
          <tfoot></tfoot>
        </table>
      </div>
      <div class="compare-year">
        <div class="ytd-inputs">
          <label>Take-home received so far
            <input type="number" min="0" step="100" data-field="ytdReceived" placeholder="auto">
          </label>
          <label>Take-home still to come
            <input type="number" min="0" step="100" data-field="ytdToCome" placeholder="auto">
          </label>
        </div>
        <p class="muted" data-out="ytd-note"></p>
        <table class="cmp">
          <thead><tr><th></th><th title="Your % of all take-home for the period">Target</th><th>Spent</th><th title="Target minus spent (negative = already over)">Left</th><th title="What to spend per remaining month">Per month</th></tr></thead>
          <tbody></tbody>
          <tfoot></tfoot>
        </table>
        <p class="muted" data-out="ytd-summary"></p>
      </div>
      <p class="muted" data-out="rent-note"></p>
      <p class="muted compare-foot"><span data-out="actuals-note"></span>
        <button type="button" data-action="import-open">Re-import</button>
        <button type="button" data-action="actuals-clear">Clear</button></p>
    </details>
    <div class="rent">
      <h3>What rent can you afford?</h3>
      <div class="rent-row"><span>Your housing slice</span><b data-rent="slice"></b></div>
      <div class="rent-row"><span>30% of gross</span><b data-rent="thirty"></b></div>
      <div class="rent-row"><span>40× rule (landlords)</span><b data-rent="forty"></b></div>
    </div>`;

  card.querySelector('[data-field="name"]').value = s.name;
  card.querySelector('[data-field="salary"]').value = s.salary;
  card.querySelector('[data-field="filing"]').value = s.filing;
  card.querySelector('[data-field="stateRate"]').value = s.stateRate;
  card.querySelector('[data-field="pretax401kPct"]').value = s.pretax401kPct;
  card.querySelector('[data-field="healthMonthly"]').value = s.healthMonthly;
  card.querySelector('[data-field="rentFromPaycheck"]').value = s.rentFromPaycheck || 0;
  card.querySelector('[data-field="ytdReceived"]').value = s.ytdReceived ?? "";
  card.querySelector('[data-field="ytdToCome"]').value = s.ytdToCome ?? "";
  const unalloc = card.querySelector(".unalloc");
  for (const c of categories) unalloc.before(buildCatRow(c));
  refresh(card, s);
  return card;
}

// One budget row. The label is user text, so it goes in via textContent/value,
// never innerHTML.
function buildCatRow(c) {
  const row = document.createElement("div");
  row.className = "cat";
  row.dataset.cat = c.id;
  row.innerHTML = `
    <span class="cat-label">
      <button type="button" class="lock" data-action="lock" title="Pin: auto-balancing won't change this category (you can still edit it yourself)"></button>
      <span class="cat-name"></span>
      <input class="cat-name-input" data-catname aria-label="Category name" maxlength="40">
      <span class="cat-ctrls">
        <button type="button" data-action="cat-up" title="Move up" aria-label="Move up">▲</button>
        <button type="button" data-action="cat-down" title="Move down" aria-label="Move down">▼</button>
        <button type="button" data-action="cat-delete" title="Delete category" aria-label="Delete category">✕</button>
      </span>
    </span>
    <input type="range" min="0" max="60" step="1" data-role="slider">
    <input type="number" min="0" max="100" step="0.5" data-role="pct">
    <input type="number" min="0" step="10" data-role="amt">`;
  setCatLabel(row, c.label);
  return row;
}

// Everything that shows (or is named after) a category's label.
function setCatLabel(row, label) {
  row.querySelector(".cat-name").textContent = label;
  const input = row.querySelector(".cat-name-input");
  if (document.activeElement !== input) input.value = label;
  row.querySelector(".lock").setAttribute("aria-label", `Pin ${label}`);
  row.querySelector('[data-role="slider"]').setAttribute("aria-label", `${label} slider`);
  row.querySelector('[data-role="pct"]').setAttribute("aria-label", `${label} percent`);
  row.querySelector('[data-role="amt"]').setAttribute("aria-label", `${label} dollars per month`);
}

// Padlock icons (currentColor, so CSS controls the color). Locked = shackle
// closed over the body; unlocked = shackle swung open to the left.
const LOCK_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="3" y="7" width="10" height="7.5" rx="1.5" fill="currentColor"/><path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
const UNLOCK_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="3" y="7" width="10" height="7.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M11 7V5a3 3 0 0 0-5.6-1.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

// While any category is locked the total is held at 100%, so Unallocated is
// fixed at 0 too (shown with its own locked marker).
function hasLocks(s) { return categories.some((c) => lockedFor(s)[c.id]); }

// Rent paid from the paycheck stays IN the percentage budget (so a scenario with it
// compares like for like with one without): Housing becomes a fixed category worth
// rent / take-home, behaving like a permanently pinned row, and the others share the rest.
function rentActive(s) {
  return categories.some((c) => c.id === Budget.RENT_CATEGORY_ID) && Tax.estimateTax(s).rent > 0;
}
function lockedFor(s) { return rentActive(s) ? { ...s.locked, [Budget.RENT_CATEGORY_ID]: true } : s.locked; }
// Pin Housing to its rent share and let the other categories fill the remaining 100%. Idempotent; returns s.
function enforceRent(s) {
  if (!rentActive(s)) return s;
  const t = Tax.estimateTax(s);
  const withRent = { ...s.percents, [Budget.RENT_CATEGORY_ID]: Budget.rentShare(t.netMonthly, t.rent / 12) };
  s.percents = Budget.normalize(withRent, lockedFor(s), categories);
  return s;
}

const round = (n, places) => Number(n.toFixed(places));

function setText(card, selector, text) {
  const el = card.querySelector(selector);
  if (el) el.textContent = text;
}

function refresh(card, s) {
  enforceRent(s); // keep Housing pinned to its rent share whatever just changed (salary, taxes, ...)
  const t = Tax.estimateTax(s);
  for (const k of ["gross", "federal", "socialSecurity", "medicare", "state", "k401", "health", "net", "rent", "deposit"]) {
    const sign = k === "gross" || k === "net" || k === "deposit" ? "" : "−";
    setText(card, `[data-tax="${k}"]`, sign + money.format(t[k]));
    setText(card, `[data-tax-mo="${k}"]`, sign + money.format(t[k] / 12));
    setText(card, `[data-tax-pay="${k}"]`, sign + money.format(t[k] / Budget.PAY_PERIODS_PER_YEAR));
  }
  for (const row of card.querySelectorAll(".rent-lines")) row.classList.toggle("hidden", !(t.rent > 0));
  setText(card, '[data-out="effective"]',
    `Effective tax rate ${pctFmt.format(t.effectiveRate * 100)}% · top federal bracket ${pctFmt.format(t.marginalFederal * 100)}% (${Tax.TAX_YEAR} rates, estimate only)`);

  const a = Budget.allocate(t.netMonthly, s.percents, categories);
  const dollar = viewMode === "dollar";
  // slider tracks whichever unit is being edited; dollar range scales with take-home
  const dollarMax = Math.max(50, Math.ceil((t.netMonthly * 0.6) / 50) * 50);
  for (const r of a.rows) {
    const row = card.querySelector(`.cat[data-cat="${r.id}"]`);
    const slider = row.querySelector('[data-role="slider"]');
    slider.max = dollar ? dollarMax : 60;
    slider.step = dollar ? 5 : 1;
    const pctIn = row.querySelector('[data-role="pct"]');
    const amtIn = row.querySelector('[data-role="amt"]');
    const locked = !!lockedFor(s)[r.id];
    const rentRow = r.id === Budget.RENT_CATEGORY_ID && rentActive(s);
    row.classList.toggle("locked", locked);
    row.classList.toggle("rentfixed", rentRow);
    row.title = rentRow ? "Fixed: this rent is paid straight from your paycheck" : "";
    slider.disabled = rentRow;
    const lockBtn = row.querySelector(".lock");
    // only swap the icon when the state changes, so a refresh can't replace the <svg> between mousedown and mouseup
    if (lockBtn.dataset.state !== String(locked)) {
      lockBtn.innerHTML = locked ? LOCK_ICON : UNLOCK_ICON;
      lockBtn.dataset.state = String(locked);
    }
    lockBtn.setAttribute("aria-pressed", String(locked));
    // a locked ("pinned") category is only protected from auto-balancing; you can still edit it
    pctIn.readOnly = dollar || rentRow;
    amtIn.readOnly = !dollar || rentRow;
    // never rewrite the field the user is typing in; update everything else
    if (document.activeElement !== slider) slider.value = dollar ? round(r.amount, 0) : round(r.pct, 1);
    if (document.activeElement !== pctIn) pctIn.value = round(r.pct, 1);
    if (document.activeElement !== amtIn) amtIn.value = round(r.amount, 0);
  }
  const un = card.querySelector(".unalloc");
  const unPct = Math.abs(a.unallocatedPct) < 0.05 ? 0 : a.unallocatedPct;
  const unAmt = Math.abs(a.unallocatedAmount) < 0.5 ? 0 : a.unallocatedAmount;
  un.querySelector('[data-role="pct"]').textContent = pctFmt.format(unPct) + "%";
  un.querySelector('[data-role="amt"]').textContent = money.format(unAmt);
  un.classList.toggle("over", a.unallocatedPct < -0.05);
  const fixed = hasLocks(s);
  const marker = un.querySelector(".lock-static");
  marker.innerHTML = fixed ? LOCK_ICON : "";
  marker.classList.toggle("on", fixed);

  refreshCompare(card, s, t, a);

  const rent = Budget.rentRules(t.gross);
  const housing = a.rows.find((r) => r.id === "housing"); // the user may have deleted the Housing category
  setText(card, '[data-rent="slice"]',
    t.rent > 0 ? `${money.format(t.rent / 12)}/mo (from your paycheck)` : housing ? money.format(housing.amount) + "/mo" : "—");
  setText(card, '[data-rent="thirty"]', money.format(rent.thirtyPercent) + "/mo");
  setText(card, '[data-rent="forty"]', money.format(rent.fortyX) + "/mo");
}

// Typing in a category's name box: relabel it everywhere (it's shared by all scenarios) without
// rebuilding anything, so the input keeps focus.
function renameCategoryLive(input) {
  const id = input.closest(".cat[data-cat]").dataset.cat;
  categories = Budget.renameCategory(categories, id, input.value);
  for (const row of root.querySelectorAll(`.cat[data-cat="${id}"]`)) setCatLabel(row, input.value);
  save();
}

// ---- budget vs. actual -----------------------------------------------------------

const nearZero = (n) => (Math.abs(n) < 0.5 ? 0 : n); // so a rounding crumb never prints as "-$0"
const signed = (n) => (Math.abs(n) < 0.5 ? money.format(0) : (n > 0 ? "+" : "−") + money.format(Math.abs(n)));
const longDate = (iso) => (iso ? new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : null);

function rowHtml(cells, cls = "") {
  return `<tr class="${cls}">${cells.map((c, i) => `<${i ? "td" : "th"}${c.cls ? ` class="${c.cls}"` : ""}>${c.text}</${i ? "td" : "th"}>`).join("")}</tr>`;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

function refreshCompare(card, s, t, a) {
  const box = card.querySelector(".compare");
  box.classList.toggle("hidden", !actuals);
  if (!actuals) return;
  for (const btn of box.querySelectorAll("[data-compare]")) btn.setAttribute("aria-pressed", String(btn.dataset.compare === compareMode));
  box.classList.toggle("show-year", compareMode === "year");
  const months = actuals.months;
  // rent deducted from the paycheck is real spending that never shows in a bank CSV: count it as spent in Housing
  const spentTotals = { ...actuals.totals };
  const rentOn = rentActive(s);
  if (rentOn) spentTotals[Budget.RENT_CATEGORY_ID] = (t.rent / 12) * months;
  setText(card, '[data-out="rent-note"]', rentOn
    ? `Your ${money.format(t.rent / 12)}/mo rent is paid from your paycheck, so it counts as spent in Housing even though it isn't in your CSV.` : "");
  const when = actuals.start && actuals.end ? ` (${longDate(actuals.start)} – ${longDate(actuals.end)})` : "";
  setText(card, '[data-out="actuals-note"]', `Imported ${longDate((actuals.importedAt || "").slice(0, 10)) || "earlier"}: ${pctFmt.format(months)} months of spending${when}. Only totals are kept, never the transactions.`);

  // monthly average vs budget
  const spentPerMonth = (id) => (spentTotals[id] || 0) / months;
  let budgetSum = 0, actualSum = 0;
  const body = a.rows.map((r) => {
    const actual = spentPerMonth(r.id);
    budgetSum += r.amount; actualSum += actual;
    const diff = actual - r.amount;
    const notable = Math.abs(diff) >= 25 && Math.abs(diff) >= 0.1 * r.amount;
    return rowHtml([{ text: esc(r.label) }, { text: money.format(r.amount) }, { text: money.format(actual) }, { text: signed(diff), cls: notable ? "notable" : "" }]);
  }).join("");
  box.querySelector(".compare-avg tbody").innerHTML = body;
  box.querySelector(".compare-avg tfoot").innerHTML =
    rowHtml([{ text: "Total spending" }, { text: money.format(budgetSum) }, { text: money.format(actualSum) }, { text: signed(actualSum - budgetSum) }], "total") +
    rowHtml([{ text: "Left of take-home" }, { text: money.format(nearZero(t.netMonthly - budgetSum)) }, { text: money.format(nearZero(t.netMonthly - actualSum)) }, { text: "" }]);

  // rest of year
  const endMs = actuals.end ? Csv.fromIsoDate(actuals.end) : Date.now();
  const monthsLeft = Budget.monthsLeftInYear(endMs);
  const plan = Budget.planRestOfYear({
    netMonthly: t.netMonthly, percents: s.percents, categories, spent: spentTotals, monthsCovered: months, monthsLeft,
    received: s.ytdReceived, toCome: s.ytdToCome,
  });
  const recInput = box.querySelector('[data-field="ytdReceived"]');
  const comeInput = box.querySelector('[data-field="ytdToCome"]');
  recInput.placeholder = money.format(t.netMonthly * months);
  comeInput.placeholder = money.format(t.netMonthly * monthsLeft);
  const yearBody = box.querySelector(".compare-year tbody"), yearFoot = box.querySelector(".compare-year tfoot");
  if (plan.ended) {
    yearBody.innerHTML = ""; yearFoot.innerHTML = "";
    setText(card, '[data-out="ytd-note"]', "");
    setText(card, '[data-out="ytd-summary"]', `The year is over as of ${longDate(actuals.end) || "the last transaction"}, so there is nothing left to plan. Import newer spending to plan next year.`);
    return;
  }
  setText(card, '[data-out="ytd-note"]',
    `${pctFmt.format(months)} months covered + ${pctFmt.format(plan.monthsLeft)} left in the year. All the take-home in that time: ${money.format(plan.received)} received + ${money.format(plan.toCome)} still to come = ${money.format(plan.pot)}.`);
  yearBody.innerHTML = plan.rows.map((r) =>
    rowHtml([{ text: esc(r.label) }, { text: money.format(r.target) }, { text: money.format(r.spent) },
      { text: r.over ? `−${money.format(-r.remaining)}` : money.format(r.remaining), cls: r.over ? "over-cell" : "" },
      { text: money.format(r.perMonth), cls: "strong" }])).join("");
  const sum = (k) => plan.rows.reduce((x, r) => x + r[k], 0);
  yearFoot.innerHTML = rowHtml([{ text: "Total" }, { text: money.format(sum("target")) }, { text: money.format(sum("spent")) },
    { text: signed(sum("remaining")) }, { text: money.format(sum("perMonth")), cls: "strong" }], "total");
  const notes = [];
  notes.push(plan.broke
    ? "You have already spent more than all your take-home for this period, so there is nothing left to allocate."
    : `You really have ${money.format(plan.available)} left to allocate (still to come, plus what you haven't spent so far).`);
  if (plan.scale < 1 && !plan.broke) notes.push(`The plan is scaled to ${pctFmt.format(plan.scale * 100)}% of the remaining envelopes so it fits that money.`);
  if (plan.overspent > 0.5) notes.push(`${money.format(plan.overspent)} is already over target across categories; those get nothing more.`);
  if (plan.unallocated > 0.5 && !plan.broke) notes.push(`${money.format(plan.unallocated)} isn't assigned to any category (your percentages add up to less than 100%).`);
  setText(card, '[data-out="ytd-summary"]', notes.join(" "));
}

// ---- CSV import ----------------------------------------------------------------

const dlg = {
  el: document.getElementById("importDialog"), file: document.getElementById("csvFile"), body: document.getElementById("importBody"),
  amount: document.getElementById("colAmount"), category: document.getElementById("colCategory"), date: document.getElementById("colDate"),
  months: document.getElementById("importMonths"), summary: document.getElementById("importSummary"), map: document.querySelector("#mapTable tbody"),
  total: document.getElementById("importTotal"), go: document.getElementById("importGo"), error: document.getElementById("importError"),
};
let imp = null; // { header, data, summary } while the dialog is open — the parsed file lives only here, in memory

const loadMapping = () => { try { return JSON.parse(localStorage.getItem(CSVMAP_KEY)) || {}; } catch (e) { return {}; } };

function openImport() {
  imp = null;
  dlg.file.value = "";
  dlg.body.classList.add("hidden");
  dlg.error.textContent = "";
  dlg.go.disabled = true;
  dlg.el.showModal();
}

function closeImport() {
  imp = null; // drop the parsed rows
  dlg.map.innerHTML = "";
  dlg.el.close();
}

dlg.file.addEventListener("change", async () => {
  const file = dlg.file.files[0];
  if (!file) return;
  dlg.error.textContent = "";
  try {
    const rows = Csv.parseCsv(await file.text());
    if (rows.length < 2) throw new Error("That file has no data rows.");
    const { headerIndex, header, columns } = Csv.findHeader(rows);
    imp = { header, data: rows.slice(headerIndex + 1), summary: null };
    const options = (withNone) => (withNone ? '<option value="-1">(none)</option>' : '<option value="-1">Choose…</option>') +
      header.map((h, i) => `<option value="${i}">${esc(h || `Column ${i + 1}`)}</option>`).join("");
    dlg.amount.innerHTML = options(false); dlg.category.innerHTML = options(false); dlg.date.innerHTML = options(true);
    dlg.amount.value = columns.amount; dlg.category.value = columns.category; dlg.date.value = columns.date;
    dlg.body.classList.remove("hidden");
    analyzeImport(true);
  } catch (e) {
    imp = null;
    dlg.body.classList.add("hidden");
    dlg.go.disabled = true;
    dlg.error.textContent = e.message || "Couldn't read that file.";
  }
});

for (const sel of [dlg.amount, dlg.category, dlg.date]) sel.addEventListener("change", () => analyzeImport(true));
dlg.months.addEventListener("input", updateImportTotals);

// (Re)read the chosen columns: total per CSV category and propose where each goes.
function analyzeImport(resetMonths) {
  if (!imp) return;
  const cols = { amount: Number(dlg.amount.value), category: Number(dlg.category.value), date: Number(dlg.date.value) };
  if (cols.amount < 0 || cols.category < 0) { dlg.map.innerHTML = ""; dlg.summary.textContent = "Choose the Amount and Category columns."; dlg.go.disabled = true; return; }
  imp.summary = Csv.summarize(imp.data, cols);
  const sm = imp.summary;
  if (resetMonths) dlg.months.value = Csv.spanMonths(sm.minDate, sm.maxDate) ?? 1;
  const dates = sm.minDate !== null ? ` from ${longDate(Csv.toIsoDate(sm.minDate))} to ${longDate(Csv.toIsoDate(sm.maxDate))}` : " (no usable dates, so enter how many months it covers)";
  dlg.summary.textContent = `Read ${sm.read} transactions${dates}${sm.skipped ? `; skipped ${sm.skipped} rows without a numeric amount` : ""}.`;
  const memory = loadMapping();
  dlg.map.innerHTML = sm.categories.map((c, i) => {
    const remembered = memory[c.key];
    const known = remembered && (remembered.target === "ignore" || remembered.target === "new" || categories.some((x) => x.id === remembered.target));
    const target = known ? remembered.target : Csv.suggestTarget(c.name, categories);
    const flip = known ? !!remembered.flip : false;
    const opts = categories.map((x) => `<option value="${esc(x.id)}"${x.id === target ? " selected" : ""}>${esc(x.label)}</option>`).join("") +
      `<option value="new"${target === "new" ? " selected" : ""}>＋ New category</option><option value="ignore"${target === "ignore" ? " selected" : ""}>Ignore</option>`;
    return `<tr data-i="${i}"><th>${esc(c.name)}</th><td>${c.count}</td><td>${money.format(c.net)}</td>
      <td><select data-map aria-label="Where ${esc(c.name)} goes">${opts}</select></td>
      <td><label class="flip" title="Tick if this category's spending appears as negative amounts"><input type="checkbox" data-flip${flip ? " checked" : ""}> flip</label></td>
      <td class="counted" data-counted></td></tr>`;
  }).join("");
  updateImportTotals();
}

// The dollars each CSV category contributes, given the current mapping/flip/months.
function importChoices() {
  const mapping = {}, flip = {};
  for (const tr of dlg.map.querySelectorAll("tr")) {
    const c = imp.summary.categories[Number(tr.dataset.i)];
    mapping[c.key] = tr.querySelector("[data-map]").value;
    flip[c.key] = tr.querySelector("[data-flip]").checked;
  }
  return { mapping, flip };
}

function updateImportTotals() {
  if (!imp || !imp.summary) return;
  const months = Number(dlg.months.value) > 0 ? Number(dlg.months.value) : 1;
  const { mapping, flip } = importChoices();
  let grand = 0;
  for (const tr of dlg.map.querySelectorAll("tr")) {
    const c = imp.summary.categories[Number(tr.dataset.i)];
    const net = flip[c.key] ? -c.net : c.net;
    const counted = mapping[c.key] !== "ignore" && net > 0 ? net : 0;
    grand += counted;
    tr.querySelector("[data-counted]").textContent = counted ? `${money.format(counted / months)}/mo` : (mapping[c.key] === "ignore" ? "ignored" : "not spending");
  }
  dlg.total.textContent = `${money.format(grand / months)} per month counted as spending (${money.format(grand)} over ${pctFmt.format(months)} months)`;
  dlg.go.disabled = grand <= 0;
}

dlg.map.addEventListener("change", updateImportTotals);

dlg.go.addEventListener("click", () => {
  if (!imp || !imp.summary) return;
  const { mapping, flip } = importChoices();
  const months = Number(dlg.months.value) > 0 ? Number(dlg.months.value) : 1;
  const memory = loadMapping();
  for (const c of imp.summary.categories) {
    memory[c.key] = { target: mapping[c.key], flip: flip[c.key] };
    const net = flip[c.key] ? -c.net : c.net;
    if (mapping[c.key] === "new") {
      if (net > 0) { // only spending categories earn a new row
        categories = Budget.addCategory(categories, c.name);
        mapping[c.key] = categories[categories.length - 1].id;
      } else mapping[c.key] = "ignore";
    }
  }
  try { localStorage.setItem(CSVMAP_KEY, JSON.stringify(memory)); } catch (e) { /* ignore */ }
  const built = Csv.buildActuals(imp.summary, { mapping, flip }, months);
  const sm = imp.summary;
  actuals = {
    totals: built.totals, months: built.months,
    start: sm.minDate !== null ? Csv.toIsoDate(sm.minDate) : null,
    end: sm.maxDate !== null ? Csv.toIsoDate(sm.maxDate) : Csv.toIsoDate(Date.now()),
    importedAt: new Date().toISOString(),
  };
  save();
  render();
  closeImport();
});
document.getElementById("importCancel").addEventListener("click", closeImport);
dlg.el.addEventListener("cancel", () => { imp = null; });
document.getElementById("importOpen").addEventListener("click", openImport);

function render() {
  root.replaceChildren(...scenarios.map(buildCard));
  for (const btn of root.querySelectorAll("[data-view]")) btn.setAttribute("aria-pressed", String(btn.dataset.view === viewMode));
}

const find = (card) => scenarios.find((s) => s.id === card.dataset.id);

root.addEventListener("input", (e) => {
  const card = e.target.closest(".card");
  if (!card) return;
  if ("catname" in e.target.dataset) { renameCategoryLive(e.target); return; }
  const s = find(card);
  const field = e.target.dataset.field;
  if (field === "ytdReceived" || field === "ytdToCome") {
    s[field] = e.target.value === "" ? null : Number(e.target.value); // empty = estimate automatically
  } else if (field) {
    s[field] = e.target.type === "number" ? Number(e.target.value) : e.target.value;
  } else if (e.target.dataset.role) {
    const id = e.target.closest(".cat[data-cat]").dataset.cat;
    const v = Number(e.target.value) || 0;
    const net = Tax.estimateTax(s).netMonthly;
    // convert whatever unit was edited into percent of take-home
    const inDollars = e.target.dataset.role === "amt" || (e.target.dataset.role === "slider" && viewMode === "dollar");
    const pct = Math.min(100, Math.max(0, inDollars ? (net > 0 ? (v / net) * 100 : 0) : v));
    if (hasLocks(s)) s.percents = Budget.rebalance(s.percents, id, pct, lockedFor(s), categories);
    else s.percents[id] = pct;
  } else return;
  enforceRent(s);
  save();
  refresh(card, s);
});

root.addEventListener("change", (e) => {
  if ("catname" in e.target.dataset) { // leaving a name box empty would leave an unlabeled row
    if (!e.target.value.trim()) { e.target.value = "Untitled"; renameCategoryLive(e.target); }
    return;
  }
  if (e.target.dataset.action !== "preset" || !e.target.value) return;
  const s = find(e.target.closest(".card"));
  s.percents = Budget.applyPreset(e.target.value, categories);
  s.locked = {}; // a preset replaces every value, so old pins no longer mean anything
  enforceRent(s);
  save();
  render();
});

root.addEventListener("click", (e) => {
  const actionEl = e.target.closest("[data-action]"); // a click on the icon's <svg> must still count
  const action = actionEl && actionEl.dataset.action;
  const card = e.target.closest(".card");
  if (action === "import-open") { openImport(); return; }
  if (action === "actuals-clear") {
    if (!confirm("Clear the imported spending? Your budgets stay as they are.")) return;
    actuals = null;
    save();
    render();
    return;
  }
  if (action === "cat-add") {
    categories = Budget.addCategory(categories);
    const newId = categories[categories.length - 1].id;
    const cardIndex = [...root.children].indexOf(card);
    save();
    render();
    const input = root.children[cardIndex].querySelector(`.cat[data-cat="${newId}"] .cat-name-input`);
    input.focus();
    input.select();
    return;
  }
  if (action === "cat-up" || action === "cat-down" || action === "cat-delete") {
    const id = e.target.closest(".cat[data-cat]").dataset.cat;
    if (action === "cat-delete") {
      const label = (categories.find((c) => c.id === id) || {}).label || "this category";
      if (!confirm(`Delete “${label}”? Its percentages are removed from every scenario.`)) return;
      categories = Budget.removeCategory(categories, id);
      if (actuals) delete actuals.totals[id];
      // freed percent becomes Unallocated — unless something is pinned, which holds the total at 100%
      scenarios = scenarios.map((s) => {
        const t = Budget.dropCategory(s, id);
        if (hasLocks(t)) t.percents = Budget.normalize(t.percents, lockedFor(t), categories);
        enforceRent(t);
        return t;
      });
    } else {
      categories = Budget.moveCategory(categories, id, action === "cat-up" ? -1 : +1);
    }
    save();
    render();
    return;
  }
  if (action === "lock" && card) {
    const s = find(card);
    const id = e.target.closest(".cat[data-cat]").dataset.cat;
    if (id === Budget.RENT_CATEGORY_ID && rentActive(s)) return; // fixed by the paycheck rent; can't be pinned or unpinned
    s.locked = { ...s.locked, [id]: !s.locked[id] };
    if (hasLocks(s)) s.percents = Budget.normalize(s.percents, lockedFor(s), categories); // snap to 100% as soon as a lock holds the total
    save();
    refresh(card, s);
    return;
  }
  if (!card || (action !== "delete" && action !== "duplicate")) return;
  const i = scenarios.findIndex((s) => s.id === card.dataset.id);
  if (action === "duplicate") {
    const src = scenarios[i];
    scenarios.splice(i + 1, 0, Budget.createScenario({ ...src, name: src.name + " copy", percents: { ...src.percents }, locked: { ...src.locked } }));
  } else if (scenarios.length > 1) {
    const name = scenarios[i].name || "this scenario";
    const syncNote = driveFileId ? " It will also be removed from Google Drive on the next sync." : "";
    if (!confirm(`Delete “${name}”?${syncNote}`)) return;
    scenarios.splice(i, 1);
  }
  save();
  render();
});

document.getElementById("addScenario").addEventListener("click", () => {
  scenarios.push(newScenario({ name: `Scenario ${scenarios.length + 1}` }));
  save();
  render();
});

const editBtn = document.getElementById("editCats");
editBtn.addEventListener("click", () => {
  editingCats = !editingCats;
  root.classList.toggle("editing", editingCats);
  editBtn.setAttribute("aria-pressed", String(editingCats));
  editBtn.textContent = editingCats ? "Done editing" : "Edit categories";
});

function setView(mode) {
  viewMode = mode;
  try { localStorage.setItem(VIEW_KEY, mode); } catch (e) { /* ignore */ }
  for (const btn of root.querySelectorAll("[data-view]")) btn.setAttribute("aria-pressed", String(btn.dataset.view === mode));
  for (const card of root.children) refresh(card, find(card));
}
// the toggle lives in every card's column headings; all of them stay in step
root.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-view]");
  if (btn) setView(btn.dataset.view);
  const cmp = e.target.closest("[data-compare]");
  if (cmp) {
    compareMode = cmp.dataset.compare;
    try { localStorage.setItem(COMPARE_KEY, compareMode); } catch (err) { /* ignore */ }
    for (const card of root.children) refresh(card, find(card));
  }
});

render();
setView(viewMode);
renderDriveUI();
