using pharmaguard as db from '../db/schema';

@path: '/api'
service PharmaGuardService {
  @readonly entity DrugProfiles as projection on db.DrugProfiles;
  @readonly entity Shipments    as projection on db.Shipments;
  @readonly entity Incidents    as projection on db.Incidents;
  @readonly entity SopChunks    as projection on db.SopChunks;
  @readonly entity AuditLog     as projection on db.AuditLog;

  // Each action returns a JSON string to keep the demo simple.
  action loadScenario(scenario : String)                                   returns String;
  action runWatchdog(shipmentID : String, upTo : String)                   returns String;
  action analyze(incidentID : String)                                      returns String;
  action challenge(incidentID : String, question : String,
                   extraMinutes : Integer, assumedTempC : Double)          returns String;
  action approve(incidentID : String, option : String,
                 approver : String, note : String)                         returns String;
  action verifyAudit()                                                     returns String;
}
