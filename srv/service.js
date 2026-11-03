// PharmaGuard service: wires the agents together.
//   Watchdog  -> lib/watchdog.js   (rules + statistics)
//   Stability -> lib/decision.js    (Arrhenius maths)
//   SOP       -> lib/decision.js    (clause selection) + LLM summary
//   Decision  -> lib/decision.js    (rules) + lib/llm.js (explanation)
//   Challenger-> challenge action   (recalculates, then LLM explains)
//   Action    -> approve action     (deviation notice, alert, audit chain)
const cds = require('@sap/cds');
const { SCENARIOS, generate } = require('./lib/scenario');
const { evaluate } = require('./lib/watchdog');
const { assess, withExtra, recommend, selectSop, entryHash, verifyChain, OPTIONS } = require('./lib/decision');
const llm = require('./lib/llm');

module.exports = class PharmaGuardService extends cds.ApplicationService {
  async init() {
    const { DrugProfiles, Shipments, Telemetry, Incidents, SopChunks, AuditLog } = cds.entities('pharmaguard');
    const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;

    // ---------- helpers ----------
    const toReading = r => ({ ts: new Date(r.ts).toISOString(), tempC: Number(r.tempC), location: r.location });

    async function loadShipment(shipmentID) {
      const shipment = await SELECT.one.from(Shipments).where({ ID: shipmentID });
      if (!shipment) return null;
      const profile = await SELECT.one.from(DrugProfiles).where({ ID: shipment.drug_ID });
      const rows = await SELECT.from(Telemetry).where({ shipment_ID: shipmentID }).orderBy('ts');
      return { shipment, profile, readings: rows.map(toReading) };
    }

    async function audit(eventType, incidentID, payload) {
      const last = await SELECT.one.from(AuditLog).orderBy('seq desc');
      const e = {
        seq: (last ? last.seq : 0) + 1,
        ts: new Date().toISOString(),
        eventType,
        incidentID: incidentID || '-',
        payload: JSON.stringify(payload || {}),
        prevHash: last ? last.hash : 'GENESIS'
      };
      e.hash = entryHash(e.prevHash, e);
      await INSERT.into(AuditLog).entries(e);
      return e;
    }

    // Recompute the analysis as it stood when the incident was detected.
    async function analysisFor(incident) {
      const ctx = await loadShipment(incident.shipment_ID);
      const w = evaluate(ctx.readings, ctx.profile, { upTo: incident.detectedAt });
      const stab = assess(w.accepted, ctx.profile);
      const rec = recommend(stab, ctx.profile);
      return { ...ctx, w, stab, rec };
    }

    // ---------- 1. load a demo scenario (simulated IoT telemetry) ----------
    this.on('loadScenario', async req => {
      const name = req.data.scenario;
      const sc = SCENARIOS[name];
      if (!sc) return req.reject(400, `Unknown scenario "${name}". Use: ${Object.keys(SCENARIOS).join(', ')}`);
      const id = `SHP-${name.toUpperCase()}`;
      const rows = generate(name);
      await DELETE.from(Telemetry).where({ shipment_ID: id });
      await DELETE.from(Incidents).where({ shipment_ID: id });
      await DELETE.from(Shipments).where({ ID: id });
      await INSERT.into(Shipments).entries({ ID: id, drug_ID: sc.drug, origin: sc.origin, destination: sc.destination, scenario: name });
      await INSERT.into(Telemetry).entries(rows.map(r => ({ ID: cds.utils.uuid(), shipment_ID: id, ...r })));
      const profile = await SELECT.one.from(DrugProfiles).where({ ID: sc.drug });
      return JSON.stringify({
        shipmentID: id, label: sc.label, origin: sc.origin, destination: sc.destination,
        product: profile.name, minTemp: Number(profile.minTemp), maxTemp: Number(profile.maxTemp),
        readings: rows
      });
    });

    // ---------- 2. Watchdog agent ----------
    this.on('runWatchdog', async req => {
      const { shipmentID, upTo } = req.data;
      const ctx = await loadShipment(shipmentID);
      if (!ctx) return req.reject(404, `Shipment ${shipmentID} not found. Load a scenario first.`);
      const w = evaluate(ctx.readings, ctx.profile, { upTo });

      let incidentID = null;
      if (w.status === 'EXCURSION') {
        const existing = await SELECT.one.from(Incidents).where({ shipment_ID: shipmentID });
        if (existing) {
          incidentID = existing.ID;
        } else {
          incidentID = `INC-${shipmentID.replace('SHP-', '')}-${String(Date.now()).slice(-5)}`;
          await INSERT.into(Incidents).entries({
            ID: incidentID, shipment_ID: shipmentID, status: 'OPEN', detectedAt: w.current.ts,
            peakTemp: w.excursion.peak, minutesOut: w.excursion.minutes
          });
          await audit('EXCURSION_DETECTED', incidentID, {
            shipmentID, peak: w.excursion.peak, minutes: w.excursion.minutes,
            blipsIgnored: w.blips.length, readingsRejected: w.rejected.length
          });
        }
      }
      return JSON.stringify({
        status: w.status, current: w.current, incidentID,
        blips: w.blips.map(b => ({ start: b.start, end: b.end, peak: b.peak, minutes: b.minutes })),
        rejected: w.rejected,
        excursion: w.excursion && { start: w.excursion.start, peak: w.excursion.peak, minutes: w.excursion.minutes, ongoing: w.excursion.ongoing }
      });
    });

    // ---------- 3. Stability + SOP + Decision engine ----------
    this.on('analyze', async req => {
      const inc = await SELECT.one.from(Incidents).where({ ID: req.data.incidentID });
      if (!inc) return req.reject(404, 'Incident not found');
      if (inc.brief) return inc.brief; // already analysed, keep the brief stable for the demo

      const a = await analysisFor(inc);
      const chunks = await SELECT.from(SopChunks);
      const sop = selectSop(chunks, a.rec.recommended, a.stab).map(c => ({ id: c.ID, title: c.title, text: c.text }));
      const narrative = await llm.explainDecision({
        product: a.profile.name, maxTemp: Number(a.profile.maxTemp),
        stability: a.stab, recommendation: a.rec, sop
      });
      const brief = {
        incidentID: inc.ID, shipmentID: inc.shipment_ID, product: a.profile.name,
        route: `${a.shipment.origin} to ${a.shipment.destination}`,
        detectedAt: inc.detectedAt, location: a.w.current.location,
        watchdog: { blipsIgnored: a.w.blips.length, readingsRejected: a.w.rejected.length },
        stability: a.stab, recommendation: a.rec, sop, narrative
      };
      await UPDATE(Incidents).set({ brief: JSON.stringify(brief) }).where({ ID: inc.ID });
      await audit('ANALYSIS_COMPLETED', inc.ID, {
        recommended: a.rec.recommended, usedPct: a.stab.usedPct, sopClauses: sop.map(s => s.id), narrativeSource: narrative.source
      });
      return JSON.stringify(brief);
    });

    // ---------- 4. Challenger agent (what-if, always recalculated) ----------
    this.on('challenge', async req => {
      const { incidentID, question, extraMinutes, assumedTempC } = req.data;
      const inc = await SELECT.one.from(Incidents).where({ ID: incidentID });
      if (!inc) return req.reject(404, 'Incident not found');
      const a = await analysisFor(inc);

      const extra = Math.max(0, Math.min(Number(extraMinutes) || 0, 1440));
      const temp = assumedTempC === null || assumedTempC === undefined ? a.w.current.tempC : Number(assumedTempC);
      const alt = extra > 0 ? withExtra(a.w.accepted, extra, temp) : a.w.accepted;
      const stab2 = assess(alt, a.profile);
      const rec2 = recommend(stab2, a.profile);

      const baseline = { usedPct: a.stab.usedPct, option: a.rec.recommended };
      const scenario = { extraMinutes: extra, assumedTempC: temp, usedPct: stab2.usedPct, option: rec2.recommended, reasons: rec2.reasons, stability: stab2 };
      const q = (question && question.trim()) || `What if the batch stays at ${temp} C for ${extra} more minutes?`;
      const answer = await llm.answerChallenge({ question: q, baseline, scenario });

      await audit('CHALLENGER_QUERY', incidentID, { question: q, extraMinutes: extra, assumedTempC: temp, newOption: rec2.recommended, usedPct: stab2.usedPct });
      return JSON.stringify({ baseline, scenario, answer });
    });

    // ---------- 5. Human approval -> Action and audit agent ----------
    this.on('approve', async req => {
      const { incidentID, option, approver, note } = req.data;
      if (!OPTIONS[option]) return req.reject(400, 'Option must be A, B or C');
      const inc = await SELECT.one.from(Incidents).where({ ID: incidentID });
      if (!inc) return req.reject(404, 'Incident not found');
      if (inc.status === 'DECIDED') return req.reject(409, 'This incident already has a decision');
      const a = await analysisFor(inc);
      const override = option !== a.rec.recommended;
      if (override && !(note && note.trim().length >= 5)) {
        return req.reject(400, 'You chose a different option than recommended. Add a short note explaining why.');
      }
      const who = (approver && approver.trim()) || 'QA Manager';
      const now = new Date().toISOString();
      const notice = {
        noticeNo: `DEV-${new Date().getUTCFullYear()}-${String(Date.now()).slice(-6)}`,
        system: 'EQMS (mock endpoint)', incidentID, shipmentID: inc.shipment_ID, product: a.profile.name,
        peakTemp: a.stab.peakTemp, minutesAbove: a.stab.minutesAbove, stabilityBudgetUsedPct: a.stab.usedPct,
        decision: `${option}: ${OPTIONS[option].label}`, recommendedByAI: a.rec.recommended, overrodeRecommendation: override,
        approvedBy: who, note: note || '', createdAt: now
      };
      const alertMsg = {
        A: `HOLD shipment ${inc.shipment_ID}. Quarantined pending test results. Deviation ${notice.noticeNo}.`,
        B: `HALT shipment ${inc.shipment_ID}. Do not deliver. Batch rejected. Deviation ${notice.noticeNo}.`,
        C: `RELEASE shipment ${inc.shipment_ID} under deviation ${notice.noticeNo}.`
      }[option];
      const alert = { to: 'Supply chain team', message: alertMsg, sentAt: now };

      await UPDATE(Incidents).set({
        status: 'DECIDED', decisionOption: option, approvedBy: who, decisionNote: note || '',
        decidedAt: now, deviationNotice: JSON.stringify(notice)
      }).where({ ID: incidentID });
      await audit('DECISION_APPROVED', incidentID, { option, approvedBy: who, override, note: note || '' });
      await audit('DEVIATION_FILED', incidentID, { noticeNo: notice.noticeNo });
      await audit('ALERT_SENT', incidentID, alert);
      const tail = await SELECT.from(AuditLog).orderBy('seq desc').limit(3);
      return JSON.stringify({ notice, alert, auditTail: tail.reverse() });
    });

    // ---------- 6. Verify the tamper-evident log ----------
    this.on('verifyAudit', async () => {
      const rows = await SELECT.from(AuditLog).orderBy('seq');
      return JSON.stringify(verifyChain(rows));
    });

    // ---------- 7. Gemini AI chat proxy ----------
    this.on('geminiChat', async req => {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return JSON.stringify({ text: 'Gemini API key not configured. Set GEMINI_API_KEY environment variable.', source: 'fallback' });

      let messages, context;
      try { messages = JSON.parse(req.data.messages || '[]'); } catch { messages = []; }
      try { context = JSON.parse(req.data.context || '{}'); } catch { context = {}; }

      // Build system instruction from excursion context
      const systemInstruction = `You are PharmaGuard Assistant, an AI decision-support agent built into the PharmaGuard cold chain monitoring platform.
You help QA Managers make informed decisions about temperature excursions in pharmaceutical shipments.
Be concise, professional, and always ground your answers in the data provided.
Never identify yourself as Gemini, Google, or any other AI product — you are PharmaGuard Assistant.
If stability data, SOP clauses, or incident details are available in the context, reference them specifically.
Current excursion context: ${JSON.stringify(context)}`;

      const geminiMessages = messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));

      const body = {
        system_instruction: { parts: [{ text: systemInstruction }] },
        contents: geminiMessages,
        generationConfig: { maxOutputTokens: 512, temperature: 0.3 }
      };

      try {
        const https = require('https');
        const model = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const text = await new Promise((resolve, reject) => {
          const data = JSON.stringify(body);
          const opts = { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } };
          const r = require('https').request(url, opts, res => {
            let buf = '';
            res.on('data', d => buf += d);
            res.on('end', () => {
              try {
                const j = JSON.parse(buf);
                if (j.error) return reject(new Error(j.error.message));
                resolve(j.candidates?.[0]?.content?.parts?.[0]?.text || 'No response from Gemini.');
              } catch (e) { reject(e); }
            });
          });
          r.on('error', reject);
          r.write(data); r.end();
        });
        return JSON.stringify({ text, source: 'gemini' });
      } catch (e) {
        console.warn('[gemini] error:', e.message);
        return JSON.stringify({ text: `AI error: ${e.message}`, source: 'error' });
      }
    });

    return super.init();
  }
};
