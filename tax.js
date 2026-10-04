// Rough US tax estimator — "good enough to compare job offers", not tax
// advice. Ignores pre-tax deductions (401k, HSA, health premiums), credits,
// itemizing, and local taxes. State tax is a single flat effective rate the
// user supplies.
//
// The numbers below are for ONE tax year (TAX_YEAR) and are the only thing
// that needs updating each January. Brackets are [upper bound of bracket,
// rate]; the last bound is Infinity.
const TAX_YEAR = 2026;

const FEDERAL = {
  single: {
    standardDeduction: 16100,
    brackets: [[12400, 0.10], [50400, 0.12], [105700, 0.22], [201775, 0.24], [256225, 0.32], [640600, 0.35], [Infinity, 0.37]],
    addlMedicareThreshold: 200000,
  },
  married: {
    standardDeduction: 32200,
    brackets: [[24800, 0.10], [100800, 0.12], [211400, 0.22], [403550, 0.24], [512450, 0.32], [768700, 0.35], [Infinity, 0.37]],
    addlMedicareThreshold: 250000,
  },
  head: {
    standardDeduction: 24150,
    brackets: [[17700, 0.10], [67450, 0.12], [105700, 0.22], [201750, 0.24], [256200, 0.32], [640600, 0.35], [Infinity, 0.37]],
    addlMedicareThreshold: 200000,
  },
};

const FILING_LABELS = { single: "Single", married: "Married filing jointly", head: "Head of household" };

const SOCIAL_SECURITY_RATE = 0.062;
const SOCIAL_SECURITY_WAGE_BASE = 184500;
const MEDICARE_RATE = 0.0145;
const ADDL_MEDICARE_RATE = 0.009;

function federalIncomeTax(taxableIncome, filing) {
  const { brackets } = FEDERAL[filing];
  let tax = 0;
  let lower = 0;
  for (const [upper, rate] of brackets) {
    if (taxableIncome <= lower) break;
    tax += (Math.min(taxableIncome, upper) - lower) * rate;
    lower = upper;
  }
  return tax;
}

function marginalRate(taxableIncome, filing) {
  const { brackets } = FEDERAL[filing];
  for (const [upper, rate] of brackets) if (taxableIncome <= upper) return rate;
  return brackets[brackets.length - 1][1];
}

// stateRate is a percentage (e.g. 5 for 5%), applied flat to gross.
function estimateTax({ salary, filing = "single", stateRate = 0 }) {
  const gross = Math.max(0, Number(salary) || 0);
  const f = FEDERAL[filing] || FEDERAL.single;
  const taxable = Math.max(0, gross - f.standardDeduction);
  const federal = federalIncomeTax(taxable, filing in FEDERAL ? filing : "single");
  const socialSecurity = Math.min(gross, SOCIAL_SECURITY_WAGE_BASE) * SOCIAL_SECURITY_RATE;
  const medicare = gross * MEDICARE_RATE + Math.max(0, gross - f.addlMedicareThreshold) * ADDL_MEDICARE_RATE;
  const state = gross * ((Number(stateRate) || 0) / 100);
  const totalTax = federal + socialSecurity + medicare + state;
  const net = gross - totalTax;
  return {
    gross, federal, socialSecurity, medicare, state, totalTax, net,
    grossMonthly: gross / 12,
    netMonthly: net / 12,
    effectiveRate: gross > 0 ? totalTax / gross : 0,
    marginalFederal: marginalRate(taxable, filing in FEDERAL ? filing : "single"),
  };
}

const Tax = { TAX_YEAR, FEDERAL, FILING_LABELS, federalIncomeTax, estimateTax };
if (typeof module !== "undefined" && module.exports) module.exports = Tax;
