// Hestia UI: a row of scenario cards, each with salary → take-home →
// percentage sliders → dollar amounts. State lives in localStorage; typing
// patches the outputs in place (so inputs keep focus), and structural
// changes (add / delete / duplicate / preset) rebuild the cards.
const STORAGE_KEY = "hestia-scenarios-v1";
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

let scenarios = loadScenarios();
const root = document.getElementById("scenarios");

function loadScenarios() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    // spread over fresh defaults so scenarios saved before a field existed still load
    if (Array.isArray(parsed) && parsed.length) return parsed.map((s) => ({ ...Budget.createScenario(), ...s }));
  } catch (e) { /* no storage, or corrupt — fall through to a fresh scenario */ }
  return [Budget.createScenario({ name: "Scenario 1" })];
}

const localUpdatedAt = () => Number(lsGet(LS.updated)) || 0;

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(scenarios)); } catch (e) { /* private mode etc */ }
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
    await drive.write(driveFileId, serializeState({ scenarios, updatedAt: stamp }));
    lsSet(LS.synced, String(stamp));
    lastSyncAt = new Date();
    renderDriveUI();
  } catch (e) { handleDriveError(e); }
}

function applyPull(remote) {
  scenarios = remote.scenarios.map((s) => ({ ...Budget.createScenario(), ...s }));
  lsSet(STORAGE_KEY, JSON.stringify(scenarios));
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
    </div>
    <table class="tax">
      <thead><tr><th></th><th>Year</th><th>Month</th><th title="Biweekly: year ÷ 26">Paycheck</th></tr></thead>
      <tbody>
        ${[["gross", "Gross pay"], ["federal", "Federal income tax"], ["socialSecurity", "Social Security"],
           ["medicare", "Medicare"], ["state", "State tax"],
           ["k401", "401(k) contribution"], ["health", "Health premiums"]]
          .map(([k, label]) => `<tr><td>${label}</td><td data-tax="${k}"></td><td data-tax-mo="${k}"></td><td data-tax-pay="${k}"></td></tr>`).join("")}
        <tr class="total"><td>Take-home</td><td data-tax="net"></td><td data-tax-mo="net"></td><td data-tax-pay="net"></td></tr>
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
      ${Budget.CATEGORIES.map((c) => `
        <div class="cat" data-cat="${c.id}">
          <span class="cat-label"><button type="button" class="lock" data-action="lock" aria-label="Pin ${c.label}" title="Pin: auto-balancing won't change this category (you can still edit it yourself)"></button>${c.label}</span>
          <input type="range" min="0" max="60" step="1" data-role="slider" aria-label="${c.label} slider">
          <input type="number" min="0" max="100" step="0.5" data-role="pct" aria-label="${c.label} percent">
          <input type="number" min="0" step="10" data-role="amt" aria-label="${c.label} dollars per month">
        </div>`).join("")}
      <div class="cat unalloc">
        <span class="cat-label"><span class="lock lock-static" title="Total is held at 100% while any category is pinned"></span>Unallocated</span><span></span>
        <span data-role="pct"></span><span data-role="amt"></span>
      </div>
    </div>
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
  refresh(card, s);
  return card;
}

// Padlock icons (currentColor, so CSS controls the color). Locked = shackle
// closed over the body; unlocked = shackle swung open to the left.
const LOCK_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="3" y="7" width="10" height="7.5" rx="1.5" fill="currentColor"/><path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
const UNLOCK_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="3" y="7" width="10" height="7.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M11 7V5a3 3 0 0 0-5.6-1.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

// While any category is locked the total is held at 100%, so Unallocated is
// fixed at 0 too (shown with its own locked marker).
const hasLocks = (s) => Object.values(s.locked).some(Boolean);

const round = (n, places) => Number(n.toFixed(places));

function setText(card, selector, text) {
  const el = card.querySelector(selector);
  if (el) el.textContent = text;
}

function refresh(card, s) {
  const t = Tax.estimateTax(s);
  for (const k of ["gross", "federal", "socialSecurity", "medicare", "state", "k401", "health", "net"]) {
    const sign = k === "gross" || k === "net" ? "" : "−";
    setText(card, `[data-tax="${k}"]`, sign + money.format(t[k]));
    setText(card, `[data-tax-mo="${k}"]`, sign + money.format(t[k] / 12));
    setText(card, `[data-tax-pay="${k}"]`, sign + money.format(t[k] / Budget.PAY_PERIODS_PER_YEAR));
  }
  setText(card, '[data-out="effective"]',
    `Effective tax rate ${pctFmt.format(t.effectiveRate * 100)}% · top federal bracket ${pctFmt.format(t.marginalFederal * 100)}% (${Tax.TAX_YEAR} rates, estimate only)`);

  const a = Budget.allocate(t.netMonthly, s.percents);
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
    const locked = !!s.locked[r.id];
    row.classList.toggle("locked", locked);
    const lockBtn = row.querySelector(".lock");
    // only swap the icon when the state changes, so a refresh can't replace the <svg> between mousedown and mouseup
    if (lockBtn.dataset.state !== String(locked)) {
      lockBtn.innerHTML = locked ? LOCK_ICON : UNLOCK_ICON;
      lockBtn.dataset.state = String(locked);
    }
    lockBtn.setAttribute("aria-pressed", String(locked));
    // a locked ("pinned") category is only protected from auto-balancing; you can still edit it
    pctIn.readOnly = dollar;
    amtIn.readOnly = !dollar;
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

  const rent = Budget.rentRules(t.gross);
  setText(card, '[data-rent="slice"]', money.format(a.rows.find((r) => r.id === "housing").amount) + "/mo");
  setText(card, '[data-rent="thirty"]', money.format(rent.thirtyPercent) + "/mo");
  setText(card, '[data-rent="forty"]', money.format(rent.fortyX) + "/mo");
}

function render() {
  root.replaceChildren(...scenarios.map(buildCard));
  for (const btn of root.querySelectorAll("[data-view]")) btn.setAttribute("aria-pressed", String(btn.dataset.view === viewMode));
}

const find = (card) => scenarios.find((s) => s.id === card.dataset.id);

root.addEventListener("input", (e) => {
  const card = e.target.closest(".card");
  if (!card) return;
  const s = find(card);
  const field = e.target.dataset.field;
  if (field) {
    s[field] = e.target.type === "number" ? Number(e.target.value) : e.target.value;
  } else if (e.target.dataset.role) {
    const id = e.target.closest(".cat[data-cat]").dataset.cat;
    const v = Number(e.target.value) || 0;
    const net = Tax.estimateTax(s).netMonthly;
    // convert whatever unit was edited into percent of take-home
    const inDollars = e.target.dataset.role === "amt" || (e.target.dataset.role === "slider" && viewMode === "dollar");
    const pct = Math.min(100, Math.max(0, inDollars ? (net > 0 ? (v / net) * 100 : 0) : v));
    if (hasLocks(s)) s.percents = Budget.rebalance(s.percents, id, pct, s.locked);
    else s.percents[id] = pct;
  } else return;
  save();
  refresh(card, s);
});

root.addEventListener("change", (e) => {
  if (e.target.dataset.action !== "preset" || !e.target.value) return;
  const s = find(e.target.closest(".card"));
  s.percents = { ...Budget.PRESETS[e.target.value] };
  save();
  render();
});

root.addEventListener("click", (e) => {
  const actionEl = e.target.closest("[data-action]"); // a click on the icon's <svg> must still count
  const action = actionEl && actionEl.dataset.action;
  const card = e.target.closest(".card");
  if (action === "lock" && card) {
    const s = find(card);
    const id = e.target.closest(".cat[data-cat]").dataset.cat;
    s.locked = { ...s.locked, [id]: !s.locked[id] };
    if (hasLocks(s)) s.percents = Budget.normalize(s.percents, s.locked); // snap to 100% as soon as a lock holds the total
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
  scenarios.push(Budget.createScenario({ name: `Scenario ${scenarios.length + 1}` }));
  save();
  render();
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
});

render();
setView(viewMode);
renderDriveUI();
