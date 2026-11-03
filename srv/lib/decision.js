// STABILITY AGENT + SOP AGENT (selection) + DECISION RULES + AUDIT HASHING.
// All numbers come from code, never from the LLM. The LLM only explains them.
const crypto = require('crypto');

const R = 8.314462; // J/(mol*K)
const MIN = 60000;
const kelvin = c => Number(c) + 273.15;

// ---- STABILITY AGENT -------------------------------------------------------
// Arrhenius: how much faster does the product degrade at T than at its upper storage limit?
function rateRatio(tempC, profile) {
  const ea = Number(profile.activationEnergy) * 1000; // J/mol
  return Math.exp((ea / R) * (1 / kelvin(profile.maxTemp) - 1 / kelvin(tempC)));
}

// Mean Kinetic Temperature of the whole record (standard pharma metric).
function meanKineticTemp(readings, profile) {
  const ea = Number(profile.activationEnergy) * 1000;
  const mean = readings.reduce((s, r) => s + Math.exp(-ea / (R * kelvin(r.tempC))), 0) / readings.length;
  return Math.round(((ea / R) / -Math.log(mean) - 273.15) * 10) / 10;
}

function assess(accepted, profile) {
  let exposure = 0; // minutes-equivalent at the upper limit
  let minutesAbove = 0;
  let peak = -Infinity;
  let trough = Infinity;
  accepted.forEach((r, i) => {
    const dt = i < accepted.length - 1 ? (new Date(accepted[i + 1].ts) - new Date(r.ts)) / MIN : 1;
    peak = Math.max(peak, r.tempC);
    trough = Math.min(trough, r.tempC);
    if (r.tempC > Number(profile.maxTemp)) {
      exposure += rateRatio(r.tempC, profile) * dt;
      minutesAbove += dt;
    }
  });
  const budget = Number(profile.budgetMinutes);
  const used = exposure / budget;
  return {
    exposureMin: Math.round(exposure * 10) / 10,
    budgetMin: budget,
    usedPct: Math.round(used * 100),
    marginPct: Math.max(-999, Math.round((1 - used) * 100)),
    peakTemp: peak,
    troughTemp: trough,
    minutesAbove: Math.round(minutesAbove),
    mktC: accepted.length ? meanKineticTemp(accepted, profile) : null,
    freezeRisk: Boolean(profile.freezeSensitive) && trough < Number(profile.minTemp)
  };
}

// What-if for the Challenger: keep the product at `tempC` for `extraMinutes` longer.
function withExtra(accepted, extraMinutes, tempC) {
  const out = [...accepted];
  const last = accepted[accepted.length - 1];
  const t0 = new Date(last.ts).getTime();
  for (let m = 1; m <= extraMinutes; m++) {
    out.push({ ts: new Date(t0 + m * MIN).toISOString(), tempC: Number(tempC), location: last.location });
  }
  return out;
}

// ---- DECISION RULES --------------------------------------------------------
const OPTIONS = {
  A: { id: 'A', label: 'Quarantine and test', detail: 'Hold the batch, run potency and purity tests, release only if it passes.' },
  B: { id: 'B', label: 'Scrap batch', detail: 'Reject and destroy the batch, trigger a replacement shipment.' },
  C: { id: 'C', label: 'Accept under deviation', detail: 'Release with a documented deviation. Stability data supports it.' }
};

function recommend(stab, profile) {
  const reasons = [];
  let id = 'C';
  if (stab.peakTemp >= Number(profile.hardRejectTemp)) {
    id = 'B';
    reasons.push(`Peak ${stab.peakTemp} C reached the hard reject limit of ${profile.hardRejectTemp} C.`);
  } else if (stab.freezeRisk) {
    id = 'B';
    reasons.push(`Product dropped to ${stab.troughTemp} C and is freeze sensitive.`);
  } else if (stab.usedPct > 100) {
    id = 'B';
    reasons.push(`Exposure used ${stab.usedPct}% of the stability budget (over 100%).`);
  } else if (stab.usedPct >= 50) {
    id = 'A';
    reasons.push(`Exposure used ${stab.usedPct}% of the stability budget. Testing is needed to confirm quality.`);
  } else {
    reasons.push(`Exposure used only ${stab.usedPct}% of the stability budget.`);
  }
  return { recommended: id, reasons, options: Object.values(OPTIONS), lossIfScrapINR: Number(profile.batchValueINR) };
}

// ---- SOP AGENT (selection) -------------------------------------------------
// Picks the clauses that apply. The LLM later summarises them; it never invents clauses.
function selectSop(chunks, optionId, stab) {
  const want = new Set(['always']);
  want.add({ A: 'test', B: 'reject', C: 'accept' }[optionId]);
  if (stab.freezeRisk) want.add('reject');
  return chunks.filter(c => (c.tags || '').split(',').map(t => t.trim()).some(t => want.has(t)));
}

// ---- AUDIT HASH CHAIN ------------------------------------------------------
function entryHash(prevHash, e) {
  return crypto.createHash('sha256')
    .update(`${prevHash}|${e.seq}|${e.ts}|${e.eventType}|${e.incidentID}|${e.payload}`)
    .digest('hex');
}

function verifyChain(rows) {
  let prev = 'GENESIS';
  for (const r of rows) {
    if (r.prevHash !== prev || entryHash(prev, r) !== r.hash) return { valid: false, brokenAtSeq: r.seq };
    prev = r.hash;
  }
  return { valid: true, entries: rows.length };
}

module.exports = { assess, withExtra, recommend, selectSop, entryHash, verifyChain, OPTIONS, rateRatio };
