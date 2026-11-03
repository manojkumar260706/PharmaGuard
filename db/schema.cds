using { cuid } from '@sap/cds/common';

namespace pharmaguard;

// Stability + limits per product. Numbers are ILLUSTRATIVE (mock data for the demo).
entity DrugProfiles {
  key ID             : String(20);
  name               : String(100);
  minTemp            : Decimal(4,1);   // lower storage limit in C
  maxTemp            : Decimal(4,1);   // upper storage limit in C
  activationEnergy   : Decimal(6,1);   // kJ/mol, drives the Arrhenius model
  budgetMinutes      : Integer;        // exposure budget, in minutes-equivalent at maxTemp
  hardRejectTemp     : Decimal(4,1);   // at or above this temp the batch is rejected
  freezeSensitive    : Boolean;
  batchValueINR      : Integer;
  units              : Integer;
}

entity Shipments {
  key ID             : String(30);
  drug               : Association to DrugProfiles;
  origin             : String(60);
  destination        : String(60);
  scenario           : String(30);
}

entity Telemetry : cuid {
  shipment           : Association to Shipments;
  ts                 : Timestamp;
  tempC              : Decimal(5,1);
  location           : String(60);
}

entity Incidents {
  key ID             : String(40);
  shipment           : Association to Shipments;
  status             : String(20);     // OPEN, DECIDED
  detectedAt         : Timestamp;
  peakTemp           : Decimal(5,1);
  minutesOut         : Integer;
  brief              : LargeString;    // JSON: stability, sop, options, narrative
  decisionOption     : String(1);      // A, B or C
  approvedBy         : String(60);
  decisionNote       : String(500);
  decidedAt          : Timestamp;
  deviationNotice    : LargeString;    // JSON: mock EQMS notice
}

entity SopChunks {
  key ID             : String(20);
  title              : String(100);
  text               : LargeString;
  tags               : String(200);    // comma separated: always, test, reject, accept
}

// Tamper-evident log: each row stores the hash of the previous row.
entity AuditLog {
  key seq            : Integer;
  ts                 : String(30);     // stored as plain text so the hash always re-computes exactly
  eventType          : String(40);
  incidentID         : String(40);
  payload            : LargeString;
  prevHash           : String(64);
  hash               : String(64);
}
