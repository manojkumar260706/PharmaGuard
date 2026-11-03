// Run with:  node test/scenarios.js
// Checks that each demo scenario ends in the decision we expect.
const { generate, SCENARIOS } = require('../srv/lib/scenario');
const { evaluate } = require('../srv/lib/watchdog');
const { assess, recommend, withExtra, entryHash, verifyChain } = require('../srv/lib/decision');

const profiles = {
  'BIO-001': { minTemp: 2, maxTemp: 8, activationEnergy: 83, budgetMinutes: 60, hardRejectTemp: 25, freezeSensitive: true, batchValueINR: 4500000 },
  'INS-001': { minTemp: 2, maxTemp: 8, activationEnergy: 75, budgetMinutes: 90, hardRejectTemp: 30, freezeSensitive: true, batchValueINR: 1800000 }
};
const expected = { borderline: 'A', minor: 'C', severe: 'B' };
let failed = 0;

for (const name of Object.keys(SCENARIOS)) {
  const sc = SCENARIOS[name];
  const prof = profiles[sc.drug];
  const readings = generate(name, new Date('2026-11-01T00:00:00Z'));
  const w = evaluate(readings, prof);
  const stab = assess(w.accepted, prof);
  const rec = recommend(stab, prof);
  const ok = rec.recommended === expected[name] && w.status === 'EXCURSION';
  if (!ok) failed++;
  console.log(`\n[${ok ? 'OK ' : 'FAIL'}] ${name}: status=${w.status} blips=${w.blips.length} rejected=${w.rejected.length}`);
  console.log(`      peak=${stab.peakTemp} minAbove=${stab.minutesAbove} exposure=${stab.exposureMin}/${stab.budgetMin} used=${stab.usedPct}% MKT=${stab.mktC} -> option ${rec.recommended}`);
  if (name === 'borderline') {
    // Replay: when does the Watchdog first react?
    const seen = {};
    for (let m = 0; m <= 260; m += 5) {
      const up = new Date(Date.parse('2026-11-01T06:00:00Z') + m * 60000).toISOString();
      const s = evaluate(readings, prof, { upTo: up }).status;
      if (!seen[s]) { seen[s] = up.substr(11, 5); }
    }
    console.log('      first seen at (UTC):', JSON.stringify(seen));
    const extra = assess(withExtra(w.accepted, 120, 11.2), prof);
    console.log(`      what-if +120min at 11.2C: used=${extra.usedPct}% -> option ${recommend(extra, prof).recommended}`);
  }
}

// Audit chain check
const rows = []; let prev = 'GENESIS';
for (let i = 1; i <= 3; i++) {
  const e = { seq: i, ts: '2026-11-01T10:00:0' + i + 'Z', eventType: 'TEST', incidentID: 'INC-1', payload: '{}' };
  e.prevHash = prev; e.hash = entryHash(prev, e); prev = e.hash; rows.push(e);
}
const okChain = verifyChain(rows).valid;
rows[1].payload = '{"tampered":true}';
const brokenDetected = !verifyChain(rows).valid;
console.log(`\n[${okChain && brokenDetected ? 'OK ' : 'FAIL'}] audit chain valid, tampering detected`);
if (!(okChain && brokenDetected)) failed++;
process.exit(failed ? 1 : 0);
