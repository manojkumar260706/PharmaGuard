// WATCHDOG AGENT: decides whether something that looks wrong is a real excursion.
// Pure rules and statistics. No LLM, so it is fast, predictable and easy to defend.

const MIN = 60000;

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// 1) Sanity check: drop impossible values and isolated one-off spikes.
function filterReadings(readings) {
  const accepted = [];
  const rejected = [];
  readings.forEach((r, i) => {
    const t = Number(r.tempC);
    if (t < -40 || t > 60) {
      rejected.push({ ts: r.ts, tempC: t, reason: 'Outside physically possible range' });
      return;
    }
    const neighbours = [];
    for (let j = Math.max(0, i - 2); j <= Math.min(readings.length - 1, i + 2); j++) {
      if (j !== i) neighbours.push(Number(readings[j].tempC));
    }
    if (neighbours.length >= 2) {
      const spread = Math.max(...neighbours) - Math.min(...neighbours);
      if (spread <= 2 && Math.abs(t - median(neighbours)) > 5) {
        rejected.push({ ts: r.ts, tempC: t, reason: 'Isolated spike, neighbours disagree (likely sensor error)' });
        return;
      }
    }
    accepted.push({ ts: r.ts, tempC: t, location: r.location });
  });
  return { accepted, rejected };
}

// 2) Trend: robust slope in C per minute. Compares the median of the older half of the last
//    10 readings with the median of the newer half, so a short blip cannot fake a trend.
function slopePerMin(acc) {
  const w = acc.slice(-10);
  if (w.length < 6) return 0;
  const h = Math.floor(w.length / 2);
  const older = w.slice(0, h);
  const newer = w.slice(-h);
  const meanTime = a => a.reduce((s, r) => s + new Date(r.ts).getTime(), 0) / a.length;
  const dtMin = (meanTime(newer) - meanTime(older)) / MIN;
  if (dtMin <= 0) return 0;
  return (median(newer.map(r => r.tempC)) - median(older.map(r => r.tempC))) / dtMin;
}

// 3) Find runs of consecutive out-of-range readings.
function findRuns(acc, profile) {
  const runs = [];
  let cur = null;
  acc.forEach((r, i) => {
    const out = r.tempC > Number(profile.maxTemp) || r.tempC < Number(profile.minTemp);
    if (out) {
      if (!cur) cur = { start: r.ts, peak: r.tempC, trough: r.tempC, startIdx: i };
      cur.end = r.ts;
      cur.endIdx = i;
      cur.peak = Math.max(cur.peak, r.tempC);
      cur.trough = Math.min(cur.trough, r.tempC);
    } else if (cur) {
      runs.push(cur);
      cur = null;
    }
  });
  if (cur) runs.push(cur);
  runs.forEach(r => {
    r.minutes = Math.round((new Date(r.end) - new Date(r.start)) / MIN) + 1;
    r.ongoing = r.endIdx === acc.length - 1;
  });
  return runs;
}

// Main entry. `upTo` lets the UI replay the shipment minute by minute.
function evaluate(allReadings, profile, { upTo, thresholdMin = 30 } = {}) {
  const cut = upTo ? new Date(upTo).getTime() : Infinity;
  const readings = allReadings
    .filter(r => new Date(r.ts).getTime() <= cut)
    .sort((a, b) => new Date(a.ts) - new Date(b.ts));
  if (!readings.length) return { status: 'NORMAL', current: null, runs: [], blips: [], rejected: [], excursion: null, accepted: [] };

  const { accepted, rejected } = filterReadings(readings);
  const runs = findRuns(accepted, profile);
  const last = accepted[accepted.length - 1];
  const slope = slopePerMin(accepted);
  const projected45 = Math.round((last.tempC + slope * 45) * 10) / 10;

  const blips = runs.filter(r => !r.ongoing && r.minutes < thresholdMin);
  const excursionRuns = runs.filter(r => r.minutes >= thresholdMin);
  const ongoing = runs.find(r => r.ongoing);
  const excursion = excursionRuns.length ? excursionRuns.reduce((a, b) => (b.minutes > a.minutes ? b : a)) : null;

  const rising = slope > 0.05 && projected45 > Number(profile.maxTemp) + 2 && last.tempC > Number(profile.maxTemp) - 2;
  let status = 'NORMAL';
  if (excursion) status = 'EXCURSION';
  else if (rising) status = 'WARNING';
  else if (ongoing) status = 'WATCH';

  return {
    status,
    current: {
      ts: last.ts,
      tempC: last.tempC,
      location: last.location,
      minutesOut: ongoing ? ongoing.minutes : 0,
      slopePerMin: Math.round(slope * 1000) / 1000,
      projected45
    },
    runs,
    blips,
    rejected,
    excursion,
    accepted
  };
}

module.exports = { evaluate, filterReadings };
