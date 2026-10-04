// Hestia UI: a row of scenario cards, each with salary → take-home →
// percentage sliders → dollar amounts. State lives in localStorage; typing
// patches the outputs in place (so inputs keep focus), and structural
// changes (add / delete / duplicate / preset) rebuild the cards.
const STORAGE_KEY = "hestia-scenarios-v1";
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const pctFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

let scenarios = loadScenarios();
const root = document.getElementById("scenarios");

function loadScenarios() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch (e) { /* no storage, or corrupt — fall through to a fresh scenario */ }
  return [Budget.createScenario({ name: "Scenario 1" })];
}

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(scenarios)); } catch (e) { /* private mode etc */ }
}

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
    </div>
    <table class="tax">
      <thead><tr><th></th><th>Year</th><th>Month</th></tr></thead>
      <tbody>
        ${[["gross", "Gross pay"], ["federal", "Federal income tax"], ["socialSecurity", "Social Security"],
           ["medicare", "Medicare"], ["state", "State tax"]]
          .map(([k, label]) => `<tr><td>${label}</td><td data-tax="${k}"></td><td data-tax-mo="${k}"></td></tr>`).join("")}
        <tr class="total"><td>Take-home</td><td data-tax="net"></td><td data-tax-mo="net"></td></tr>
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
      ${Budget.CATEGORIES.map((c) => `
        <div class="cat" data-cat="${c.id}">
          <span class="cat-label">${c.label}</span>
          <input type="range" min="0" max="60" step="1" data-role="slider" aria-label="${c.label} percent">
          <input type="number" min="0" max="100" step="0.5" data-role="pct" aria-label="${c.label} percent">
          <span class="cat-amt" data-role="amt"></span>
        </div>`).join("")}
      <div class="cat unalloc" data-out="unalloc">
        <span class="cat-label">Unallocated</span><span></span>
        <span data-role="pct"></span><span class="cat-amt" data-role="amt"></span>
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
  for (const row of card.querySelectorAll(".cat[data-cat]")) {
    const v = s.percents[row.dataset.cat] ?? 0;
    row.querySelector('[data-role="slider"]').value = v;
    row.querySelector('[data-role="pct"]').value = v;
  }
  refresh(card, s);
  return card;
}

function setText(card, selector, text) {
  const el = card.querySelector(selector);
  if (el) el.textContent = text;
}

function refresh(card, s) {
  const t = Tax.estimateTax(s);
  for (const k of ["gross", "federal", "socialSecurity", "medicare", "state", "net"]) {
    const sign = k === "gross" || k === "net" ? "" : "−";
    setText(card, `[data-tax="${k}"]`, sign + money.format(t[k]));
    setText(card, `[data-tax-mo="${k}"]`, sign + money.format(t[k] / 12));
  }
  setText(card, '[data-out="effective"]',
    `Effective tax rate ${pctFmt.format(t.effectiveRate * 100)}% · top federal bracket ${pctFmt.format(t.marginalFederal * 100)}% (${Tax.TAX_YEAR} rates, estimate only)`);

  const a = Budget.allocate(t.netMonthly, s.percents);
  for (const r of a.rows) {
    setText(card, `.cat[data-cat="${r.id}"] [data-role="amt"]`, money.format(r.amount) + "/mo");
  }
  const un = card.querySelector(".unalloc");
  un.querySelector('[data-role="pct"]').textContent = pctFmt.format(a.unallocatedPct) + "%";
  un.querySelector('[data-role="amt"]').textContent = money.format(a.unallocatedAmount) + "/mo";
  un.classList.toggle("over", a.unallocatedPct < -0.001);

  const rent = Budget.rentRules(t.gross);
  setText(card, '[data-rent="slice"]', money.format(a.rows.find((r) => r.id === "housing").amount) + "/mo");
  setText(card, '[data-rent="thirty"]', money.format(rent.thirtyPercent) + "/mo");
  setText(card, '[data-rent="forty"]', money.format(rent.fortyX) + "/mo");
}

function render() {
  root.replaceChildren(...scenarios.map(buildCard));
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
    const row = e.target.closest(".cat[data-cat]");
    const v = Number(e.target.value) || 0;
    s.percents[row.dataset.cat] = v;
    // keep the slider and the number box in sync with each other
    row.querySelector('[data-role="slider"]').value = v;
    if (e.target.dataset.role === "slider") row.querySelector('[data-role="pct"]').value = v;
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
  const action = e.target.dataset.action;
  const card = e.target.closest(".card");
  if (!card || (action !== "delete" && action !== "duplicate")) return;
  const i = scenarios.findIndex((s) => s.id === card.dataset.id);
  if (action === "duplicate") {
    const src = scenarios[i];
    scenarios.splice(i + 1, 0, Budget.createScenario({ ...src, name: src.name + " copy", percents: { ...src.percents } }));
  } else if (scenarios.length > 1) {
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

render();
