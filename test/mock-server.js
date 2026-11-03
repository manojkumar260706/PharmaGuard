// Optional: run the dashboard WITHOUT any SAP service, using in-memory data.
//   node test/mock-server.js     then open http://localhost:4004/dashboard/index.html
// Mirrors srv/service.js so you can check the UI first. The real app uses CAP + HANA Cloud.
process.env.AI_MODE = process.env.AI_MODE || 'off';
const http = require('http'), fs = require('fs'), path = require('path');
const { SCENARIOS, generate } = require('../srv/lib/scenario');
const { evaluate } = require('../srv/lib/watchdog');
const { assess, withExtra, recommend, selectSop, entryHash, verifyChain, OPTIONS } = require('../srv/lib/decision');
const llm = require('../srv/lib/llm');

const profiles = {
  'BIO-001': { name: 'Monoclonal antibody (biologic)', minTemp: 2, maxTemp: 8, activationEnergy: 83, budgetMinutes: 60, hardRejectTemp: 25, freezeSensitive: true, batchValueINR: 4500000 },
  'INS-001': { name: 'Rapid-acting insulin', minTemp: 2, maxTemp: 8, activationEnergy: 75, budgetMinutes: 90, hardRejectTemp: 30, freezeSensitive: true, batchValueINR: 1800000 }
};
const csv = fs.readFileSync(path.join(__dirname, '../db/data/pharmaguard-SopChunks.csv'), 'utf8').trim().split('\n').slice(1);
const sopChunks = csv.map(l => { const m = l.match(/^([^,]+),([^,]+),"(.*)","?([a-z,]+)"?$/); return { ID: m[1], title: m[2], text: m[3], tags: m[4] }; });
const ships = {}, incidents = {}, audit = [];

function addAudit(eventType, incidentID, payload) {
  const last = audit[audit.length - 1];
  const e = { seq: audit.length + 1, ts: new Date().toISOString(), eventType, incidentID: incidentID || '-', payload: JSON.stringify(payload || {}), prevHash: last ? last.hash : 'GENESIS' };
  e.hash = entryHash(e.prevHash, e); audit.push(e);
}
const analysisFor = inc => { const s = ships[inc.shipmentID]; const w = evaluate(s.rows, s.profile, { upTo: inc.detectedAt }); const stab = assess(w.accepted, s.profile); return { s, w, stab, rec: recommend(stab, s.profile) }; };

const actions = {
  async loadScenario({ scenario }) {
    const sc = SCENARIOS[scenario]; if (!sc) throw new Error('Unknown scenario');
    const id = 'SHP-' + scenario.toUpperCase(); const rows = generate(scenario);
    ships[id] = { rows, profile: profiles[sc.drug], sc }; delete incidents[id];
    const p = profiles[sc.drug];
    return { shipmentID: id, label: sc.label, origin: sc.origin, destination: sc.destination, product: p.name, minTemp: p.minTemp, maxTemp: p.maxTemp, readings: rows };
  },
  async runWatchdog({ shipmentID, upTo }) {
    const s = ships[shipmentID]; const w = evaluate(s.rows, s.profile, { upTo });
    if (w.status === 'EXCURSION' && !incidents[shipmentID]) {
      const id = `INC-${shipmentID.replace('SHP-', '')}-${String(Date.now()).slice(-5)}`;
      incidents[shipmentID] = { ID: id, shipmentID, status: 'OPEN', detectedAt: w.current.ts };
      addAudit('EXCURSION_DETECTED', id, { peak: w.excursion.peak, minutes: w.excursion.minutes });
    }
    const inc = incidents[shipmentID];
    return { status: w.status, current: w.current, incidentID: w.status === 'EXCURSION' && inc ? inc.ID : null,
      blips: w.blips.map(b => ({ start: b.start, end: b.end, peak: b.peak, minutes: b.minutes })), rejected: w.rejected,
      excursion: w.excursion && { start: w.excursion.start, peak: w.excursion.peak, minutes: w.excursion.minutes, ongoing: w.excursion.ongoing } };
  },
  async analyze({ incidentID }) {
    const inc = Object.values(incidents).find(i => i.ID === incidentID); if (inc.brief) return inc.brief;
    const a = analysisFor(inc); const sop = selectSop(sopChunks, a.rec.recommended, a.stab).map(c => ({ id: c.ID, title: c.title, text: c.text }));
    const narrative = await llm.explainDecision({ product: a.s.profile.name, maxTemp: a.s.profile.maxTemp, stability: a.stab, recommendation: a.rec, sop });
    inc.brief = { incidentID, shipmentID: inc.shipmentID, product: a.s.profile.name, route: `${a.s.sc.origin} to ${a.s.sc.destination}`, detectedAt: inc.detectedAt, location: a.w.current.location,
      watchdog: { blipsIgnored: a.w.blips.length, readingsRejected: a.w.rejected.length }, stability: a.stab, recommendation: a.rec, sop, narrative };
    addAudit('ANALYSIS_COMPLETED', incidentID, { recommended: a.rec.recommended }); return inc.brief;
  },
  async challenge({ incidentID, question, extraMinutes, assumedTempC }) {
    const inc = Object.values(incidents).find(i => i.ID === incidentID); const a = analysisFor(inc);
    const extra = Math.max(0, Math.min(Number(extraMinutes) || 0, 1440)); const temp = Number(assumedTempC);
    const stab2 = assess(extra > 0 ? withExtra(a.w.accepted, extra, temp) : a.w.accepted, a.s.profile); const rec2 = recommend(stab2, a.s.profile);
    const baseline = { usedPct: a.stab.usedPct, option: a.rec.recommended };
    const scenario = { extraMinutes: extra, assumedTempC: temp, usedPct: stab2.usedPct, option: rec2.recommended, reasons: rec2.reasons, stability: stab2 };
    const answer = await llm.answerChallenge({ question: question || 'what if', baseline, scenario });
    addAudit('CHALLENGER_QUERY', incidentID, { extra, temp }); return { baseline, scenario, answer };
  },
  async approve({ incidentID, option, approver, note }) {
    if (!OPTIONS[option]) throw new Error('Option must be A, B or C');
    const inc = Object.values(incidents).find(i => i.ID === incidentID); if (inc.status === 'DECIDED') throw new Error('This incident already has a decision');
    const a = analysisFor(inc); const override = option !== a.rec.recommended;
    if (override && !(note && note.trim().length >= 5)) throw new Error('You chose a different option than recommended. Add a short note explaining why.');
    inc.status = 'DECIDED'; const noticeNo = `DEV-2026-${String(Date.now()).slice(-6)}`;
    const notice = { noticeNo, shipmentID: inc.shipmentID, product: a.s.profile.name, peakTemp: a.stab.peakTemp, minutesAbove: a.stab.minutesAbove, stabilityBudgetUsedPct: a.stab.usedPct,
      decision: `${option}: ${OPTIONS[option].label}`, recommendedByAI: a.rec.recommended, overrodeRecommendation: override, approvedBy: approver || 'QA Manager', note: note || '' };
    const msg = { A: `HOLD shipment ${inc.shipmentID}. Quarantined pending test results. Deviation ${noticeNo}.`, B: `HALT shipment ${inc.shipmentID}. Do not deliver. Batch rejected. Deviation ${noticeNo}.`, C: `RELEASE shipment ${inc.shipmentID} under deviation ${noticeNo}.` }[option];
    addAudit('DECISION_APPROVED', incidentID, { option }); addAudit('DEVIATION_FILED', incidentID, { noticeNo }); addAudit('ALERT_SENT', incidentID, { msg });
    return { notice, alert: { to: 'Supply chain team', message: msg }, auditTail: audit.slice(-3) };
  },
  async verifyAudit() { return verifyChain(audit); }
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
  try {
    if (url.pathname.startsWith('/api/AuditLog')) return send(200, JSON.stringify({ value: [...audit].reverse().slice(0, 12) }));
    if (url.pathname.startsWith('/api/') && req.method === 'POST') {
      let body = ''; for await (const c of req) body += c;
      const fn = actions[url.pathname.slice(5)]; if (!fn) return send(404, '{"error":{"message":"Unknown action"}}');
      return send(200, JSON.stringify({ value: JSON.stringify(await fn(JSON.parse(body || '{}'))) }));
    }
    const file = path.join(__dirname, '../app', url.pathname === '/' ? 'dashboard/index.html' : url.pathname);
    return send(200, fs.readFileSync(file), 'text/html');
  } catch (e) { send(400, JSON.stringify({ error: { message: e.message } })); }
}).listen(4004, () => console.log('Mock server: http://localhost:4004/dashboard/index.html'));
