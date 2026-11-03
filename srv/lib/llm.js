// LLM layer. Uses SAP Generative AI Hub (via SAP AI Core) through the SAP Cloud SDK for AI.
// If the LLM is off, slow or fails, we fall back to a templated explanation built from the same
// numbers, so the demo never breaks.
//
// Env vars:
//   AI_MODE=off          force the fallback (no AI Core needed)
//   AI_MODEL=gpt-4o      model name as listed in SAP AI Launchpad > Generative AI Hub
//   AICORE_SERVICE_KEY   service key JSON of your AI Core instance (local dev, see guide)

const MODEL = process.env.AI_MODEL || 'gpt-4o';
const TIMEOUT_MS = 25000;

const SYSTEM = `You are PharmaGuard, a decision-support assistant for a pharmaceutical QA Manager.
Rules:
- Use ONLY the numbers and SOP clauses in the JSON you are given. Never invent figures or clauses.
- Cite SOP clauses by id, for example (SOP-TE-02).
- You support the decision. The QA Manager makes it. Be clear, short and plain.`;

async function chat(user) {
  if (process.env.AI_MODE === 'off') throw new Error('AI_MODE=off');
  // The SDK is ESM, so import it dynamically (works from CommonJS code).
  const { OrchestrationClient } = await import('@sap-ai-sdk/orchestration');
  const client = new OrchestrationClient({ promptTemplating: { model: { name: MODEL } } });
  const call = client.chatCompletion({
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }]
  });
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('LLM timeout')), TIMEOUT_MS));
  const res = await Promise.race([call, timeout]);
  return res.getContent();
}

function parseJson(text) {
  const cleaned = String(text).replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned.slice(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1));
}

// ---- Decision brief narrative ---------------------------------------------
function fallbackNarrative(ctx) {
  const s = ctx.stability;
  const rec = ctx.recommendation;
  const label = rec.options.find(o => o.id === rec.recommended).label;
  const summary = `${ctx.product} spent ${s.minutesAbove} minutes above ${ctx.maxTemp} C (peak ${s.peakTemp} C). ` +
    `That used ${s.usedPct}% of its stability budget. Recommended: ${label}. ${rec.reasons.join(' ')}`;
  return {
    summary,
    rationale: {
      A: `Hold the batch and test it. Right when exposure is between 50% and 100% of budget (now ${s.usedPct}%).`,
      B: `Scrap loses INR ${rec.lossIfScrapINR.toLocaleString('en-IN')}. Required if the budget is exceeded or a hard limit is hit.`,
      C: `Release under deviation only when exposure is under 50% of budget (now ${s.usedPct}%).`
    },
    source: 'fallback'
  };
}

async function explainDecision(ctx) {
  const prompt = `Write the decision brief for the QA Manager.
Return ONLY JSON: {"summary": "3 sentences max", "rationale": {"A": "one sentence", "B": "one sentence", "C": "one sentence"}}
Mention the recommended option and cite SOP clause ids.
DATA: ${JSON.stringify(ctx)}`;
  try {
    const out = parseJson(await chat(prompt));
    if (!out.summary || !out.rationale) throw new Error('bad shape');
    return { summary: out.summary, rationale: out.rationale, source: 'llm' };
  } catch (e) {
    console.warn('[llm] explainDecision fallback:', e.message);
    return fallbackNarrative(ctx);
  }
}

// ---- Challenger ------------------------------------------------------------
function fallbackChallenge(ctx) {
  const b = ctx.baseline;
  const s = ctx.scenario;
  const changed = b.option !== s.option;
  return {
    text: `If the batch stays at ${s.assumedTempC} C for ${s.extraMinutes} more minutes, stability budget used goes from ` +
      `${b.usedPct}% to ${s.usedPct}%. ` + (changed
        ? `The recommendation changes from option ${b.option} to option ${s.option}.`
        : `The recommendation stays at option ${s.option}.`),
    source: 'fallback'
  };
}

async function answerChallenge(ctx) {
  const prompt = `The QA Manager is challenging the recommendation. Answer their question using the recalculated numbers.
State clearly whether the recommendation changes and why. 4 sentences max. Plain text, no JSON.
QUESTION: ${ctx.question}
DATA: ${JSON.stringify(ctx)}`;
  try {
    return { text: (await chat(prompt)).trim(), source: 'llm' };
  } catch (e) {
    console.warn('[llm] answerChallenge fallback:', e.message);
    return fallbackChallenge(ctx);
  }
}

module.exports = { explainDecision, answerChallenge };
