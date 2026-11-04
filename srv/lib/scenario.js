// Generates one reading per minute for a demo shipment. All data is simulated.
// Times are minutes after 06:00 (UTC) on the day the scenario is loaded.

const SCENARIOS = {
  // The story from our pitch: door-open blip, a bad sensor reading, then a real excursion on the tarmac.
  borderline: {
    label: 'Hyderabad to Delhi: tarmac delay',
    drug: 'BIO-001',
    origin: 'Hyderabad plant',
    destination: 'Delhi hospital',
    endMin: 260, // 10:20
    waypoints: [[0, 4.5], [40, 4.6], [75, 4.9], [210, 5.0], [230, 8.4], [245, 9.6], [260, 11.2]],
    anomalies: [
      { at: 40, len: 2, temp: 9.1 },  // 06:40 door opened at a checkpoint
      { at: 75, len: 1, temp: 14.8 }  // 07:15 single impossible reading (sensor glitch)
    ],
    locations: [[0, 'In transit (truck)'], [210, 'Airport tarmac']]
  },
  // Longer but mild excursion: should end as "accept under deviation".
  minor: {
    label: 'Mild excursion at customs',
    drug: 'INS-001',
    origin: 'Pune plant',
    destination: 'Bengaluru hospital',
    endMin: 240,
    waypoints: [[0, 4.5], [120, 5.0], [130, 8.6], [145, 9.2], [160, 8.8], [175, 6.0], [210, 5.0], [240, 4.8]],
    anomalies: [],
    locations: [[0, 'In transit (truck)'], [120, 'Customs hold']]
  },
  // Hours at high temperature: should end as "scrap".
  severe: {
    label: 'Cargo hold failure',
    drug: 'BIO-001',
    origin: 'Hyderabad plant',
    destination: 'Mumbai distributor',
    endMin: 320,
    waypoints: [[0, 4.5], [120, 5.0], [140, 12.0], [160, 18.0], [300, 18.5], [320, 18.5]],
    anomalies: [],
    locations: [[0, 'In transit (truck)'], [120, 'Aircraft hold']]
  },

  // Refrigerator unit failure mid-flight: slow creep, recovers partially.
  refrigfail: {
    label: 'Reefer unit failure — Chennai to Singapore',
    drug: 'BIO-001',
    origin: 'Chennai airport',
    destination: 'Singapore distributor',
    endMin: 300,
    waypoints: [[0, 4.8], [60, 5.0], [90, 6.2], [130, 9.8], [170, 11.4], [200, 10.0], [240, 7.5], [300, 5.2]],
    anomalies: [
      { at: 55, len: 2, temp: 10.2 }  // brief spike when reefer alarm triggered
    ],
    locations: [[0, 'Chennai airport (cold store)'], [60, 'In-flight (aircraft hold)'], [200, 'Singapore Changi transit']]
  },

  // Overnight road delay: temperature slowly drifts, just crosses threshold.
  overnight: {
    label: 'Overnight road delay — Mumbai to Ahmedabad',
    drug: 'INS-001',
    origin: 'Mumbai warehouse',
    destination: 'Ahmedabad hospital',
    endMin: 480,
    waypoints: [[0, 5.0], [120, 5.2], [200, 6.8], [240, 8.2], [280, 9.1], [320, 8.6], [380, 7.2], [440, 5.8], [480, 5.1]],
    anomalies: [],
    locations: [[0, 'Mumbai cold storage'], [120, 'In transit (highway)'], [240, 'Roadside breakdown'], [380, 'Back in transit']]
  },

  // Port congestion: multi-hour hold at ambient temp, insulin batch at risk.
  porthold: {
    label: 'Port congestion hold — Kolkata to Dhaka',
    drug: 'INS-001',
    origin: 'Kolkata port',
    destination: 'Dhaka hospital',
    endMin: 360,
    waypoints: [[0, 5.0], [80, 5.3], [100, 7.0], [140, 9.4], [180, 10.2], [220, 9.8], [260, 8.1], [310, 6.2], [360, 5.0]],
    anomalies: [
      { at: 78, len: 3, temp: 12.5 }  // customs scanner room exposure
    ],
    locations: [[0, 'Kolkata cold storage'], [80, 'Port customs hold'], [260, 'Vessel cold room']]
  }
};

function locationAt(sc, minute) {
  let loc = sc.locations[0][1];
  for (const [from, name] of sc.locations) if (minute >= from) loc = name;
  return loc;
}

function baseTemp(sc, minute) {
  const w = sc.waypoints;
  if (minute <= w[0][0]) return w[0][1];
  for (let i = 1; i < w.length; i++) {
    if (minute <= w[i][0]) {
      const [t0, v0] = w[i - 1];
      const [t1, v1] = w[i];
      return v0 + ((v1 - v0) * (minute - t0)) / (t1 - t0);
    }
  }
  return w[w.length - 1][1];
}

function generate(name, day = new Date()) {
  const sc = SCENARIOS[name];
  if (!sc) throw new Error(`Unknown scenario: ${name}`);
  const start = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 6, 0, 0);
  const rows = [];
  for (let m = 0; m <= sc.endMin; m++) {
    const isWaypoint = sc.waypoints.some(w => w[0] === m);
    let temp = baseTemp(sc, m) + (isWaypoint ? 0 : 0.1 * Math.sin(m * 1.7)); // small deterministic sensor noise
    for (const a of sc.anomalies) if (m >= a.at && m < a.at + a.len) temp = a.temp;
    rows.push({
      ts: new Date(start + m * 60000).toISOString(),
      tempC: Math.round(temp * 10) / 10,
      location: locationAt(sc, m)
    });
  }
  return rows;
}

module.exports = { SCENARIOS, generate };
