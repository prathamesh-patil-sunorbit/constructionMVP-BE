import mongoose from 'mongoose';
import {
  ROLES, PROJECT_STATUSES, ACTIVITY_STATUSES, HEALTH_STATES, PRIORITIES, DEPENDENCY_TYPES,
  BLOCKER_TYPES, BLOCKER_STATUSES, SEVERITIES, TEAM_TYPES,
  AI_TRIGGERS, AI_DECISIONS, AI_ALERT_LEVELS,
  STOCK_RISKS, INVENTORY_TXN_TYPES, LABOUR_CATEGORIES, REPORT_KINDS, CAMERA_VERIFY, GEOTECH_VERIFY,
} from './constants.js';

const { Schema, model } = mongoose;
const ref = (name) => ({ type: Schema.Types.ObjectId, ref: name });
const opts = { timestamps: true };

// ---------- Access ----------
const userSchema = new Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ROLES, required: true },
  phone: String,
  active: { type: Boolean, default: true },
}, opts);
export const User = model('User', userSchema);

// ---------- Structure ----------
const projectSchema = new Schema({
  code: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  location: String,
  projectType: String,
  startDate: Date,
  plannedCompletionDate: Date,
  status: { type: String, enum: PROJECT_STATUSES, default: 'Active' },
  projectManager: ref('User'),
  siteManager: ref('User'),
  lastEvaluatedAt: Date,
}, opts);
export const Project = model('Project', projectSchema);

// Generic tree (Project -> Tower/Building -> Floor/Zone -> ...). Node "type" is free text so
// the hierarchy is not hard-coded to one project's structure.
const structureNodeSchema = new Schema({
  project: { ...ref('Project'), required: true, index: true },
  parent: { ...ref('StructureNode'), default: null },
  name: { type: String, required: true },
  type: { type: String, default: 'Zone' },
  order: { type: Number, default: 0 },
}, opts);
export const StructureNode = model('StructureNode', structureNodeSchema);

// ---------- Planning ----------
const activitySchema = new Schema({
  code: { type: String, required: true },
  name: { type: String, required: true },
  project: { ...ref('Project'), required: true, index: true },
  structureNode: ref('StructureNode'),
  wbs: String,
  plannedStart: { type: Date, required: true },
  plannedFinish: { type: Date, required: true },
  plannedDuration: Number,
  plannedQuantity: Number,
  unit: String,
  responsible: ref('User'),
  priority: { type: String, enum: PRIORITIES, default: 'Medium' },
  status: { type: String, enum: ACTIVITY_STATUSES, default: 'Planned' },
  health: { type: String, enum: HEALTH_STATES, default: 'On Track' },
  // Derived by the rules engine; recalculated on every evaluation.
  metrics: {
    plannedProgress: { type: Number, default: 0 },
    actualProgress: { type: Number, default: 0 },
    actualQuantity: { type: Number, default: 0 },
    progressVariance: { type: Number, default: 0 },
    actualStart: Date,
    actualFinish: Date,
    expectedStart: Date,
    expectedFinish: Date,
    scheduleVarianceDays: { type: Number, default: 0 },
    baselineVarianceDays: Number,
    manpower: { date: Date, trade: String, planned: Number, actual: Number, short: Boolean },
    impactedBy: [{ activity: ref('Activity'), name: String, delayDays: Number, _id: false }],
    healthReason: String,
    lastUpdateAt: Date,
    evaluatedAt: Date,
  },
  // Planning team's approved baseline; plannedStart/plannedFinish is the current (possibly revised) plan.
  baseline: {
    start: Date,
    finish: Date,
    version: String,
    approvedBy: String,
    source: String,
    setAt: Date,
  },
  source: { type: String, default: 'manual' },
  externalRef: String,
  lastSyncedAt: Date,
}, opts);
activitySchema.index({ project: 1, code: 1 }, { unique: true });
export const Activity = model('Activity', activitySchema);

const dependencySchema = new Schema({
  project: { ...ref('Project'), required: true, index: true },
  predecessor: { ...ref('Activity'), required: true },
  successor: { ...ref('Activity'), required: true },
  type: { type: String, enum: DEPENDENCY_TYPES, default: 'FS' },
  lagDays: { type: Number, default: 0 },
}, opts);
dependencySchema.index({ predecessor: 1, successor: 1 }, { unique: true });
export const Dependency = model('Dependency', dependencySchema);

// ---------- Execution ----------
// Daily actuals. Every update is a new document: progress history is never overwritten.
const progressUpdateSchema = new Schema({
  project: { ...ref('Project'), required: true, index: true },
  activity: { ...ref('Activity'), required: true, index: true },
  date: { type: Date, required: true },
  plannedQuantity: Number,
  actualQuantity: Number,
  plannedProgress: Number,
  actualProgress: { type: Number, required: true, min: 0, max: 100 },
  status: { type: String, enum: ACTIVITY_STATUSES },
  comment: String,
  reportedBy: ref('User'),
  source: { type: String, default: 'manual' },
  externalRef: String,
}, opts);
export const ProgressUpdate = model('ProgressUpdate', progressUpdateSchema);

// ---------- Teams (Planning / Estimation / Execution) ----------
const teamSchema = new Schema({
  project: { ...ref('Project'), required: true, index: true },
  code: { type: String, required: true },
  name: { type: String, required: true },
  type: { type: String, enum: TEAM_TYPES, required: true },
  lead: ref('User'),
  members: [ref('User')],
  source: { type: String, default: 'manual' },
  externalRef: String,
  lastSyncedAt: Date,
}, opts);
teamSchema.index({ project: 1, code: 1 }, { unique: true });
export const Team = model('Team', teamSchema);

// Estimation team output per activity: BOQ quantity, cost and planned resources.
const resourceLine = { name: String, quantity: Number, unit: String, _id: false };
const estimateSchema = new Schema({
  project: { ...ref('Project'), required: true, index: true },
  activity: { ...ref('Activity'), required: true, index: true },
  boqCode: { type: String, required: true },
  description: String,
  quantity: Number,
  unit: String,
  rate: Number,
  amount: Number,
  currency: { type: String, default: 'INR' },
  estimatedDurationDays: Number,
  productivityPerDay: Number,
  labour: [{ trade: String, count: Number, _id: false }],
  materials: [resourceLine],
  machinery: [{ name: String, count: Number, _id: false }],
  version: String,
  status: { type: String, enum: ['Draft', 'Approved'], default: 'Approved' },
  preparedBy: ref('User'),
  source: { type: String, default: 'manual' },
  externalRef: String,
  lastSyncedAt: Date,
}, opts);
estimateSchema.index({ activity: 1, boqCode: 1 }, { unique: true });
export const Estimate = model('Estimate', estimateSchema);

// Execution team daily report (DPR) per activity: resources deployed on site.
const executionLogSchema = new Schema({
  project: { ...ref('Project'), required: true, index: true },
  activity: { ...ref('Activity'), required: true, index: true },
  date: { type: Date, required: true },
  contractor: String,
  manpower: [{ trade: String, planned: Number, actual: Number, _id: false }],
  machinery: [{ name: String, count: Number, hours: Number, _id: false }],
  materialsConsumed: [resourceLine],
  weather: String,
  workingHours: Number,
  remarks: String,
  reportedBy: ref('User'),
  source: { type: String, default: 'manual' },
  externalRef: String,
}, opts);
executionLogSchema.index({ activity: 1, date: 1, source: 1 }, { unique: true });
export const ExecutionLog = model('ExecutionLog', executionLogSchema);

// One record per integration run, so every import is traceable.
const integrationSyncSchema = new Schema({
  project: ref('Project'),
  source: { type: String, required: true },
  mode: { type: String, enum: ['pull', 'push'], default: 'pull' },
  types: [String],
  status: { type: String, enum: ['Running', 'Success', 'Partial', 'Failed'], default: 'Running' },
  stats: Schema.Types.Mixed,
  errorMessages: [String],
  triggeredBy: ref('User'),
  startedAt: { type: Date, default: Date.now },
  finishedAt: Date,
}, opts);
export const IntegrationSync = model('IntegrationSync', integrationSyncSchema);

// ---------- Blockers ----------
const blockerSchema = new Schema({
  project: { ...ref('Project'), required: true, index: true },
  activity: { ...ref('Activity'), required: true, index: true },
  type: { type: String, enum: BLOCKER_TYPES, required: true },
  description: { type: String, required: true },
  reportedBy: ref('User'),
  reportedDate: { type: Date, required: true },
  expectedResolution: Date,
  severity: { type: String, enum: SEVERITIES, default: 'Medium' },
  status: { type: String, enum: BLOCKER_STATUSES, default: 'Open' },
  assignedTo: ref('User'),
  resolutionNote: String,
  resolvedAt: Date,
  history: [{
    status: String, note: String, by: ref('User'), at: { type: Date, default: Date.now }, _id: false,
  }],
}, opts);
export const Blocker = model('Blocker', blockerSchema);

// ---------- Risk ----------
const riskSchema = new Schema({
  project: { ...ref('Project'), required: true, index: true },
  activity: { ...ref('Activity'), required: true, index: true },
  status: { type: String, enum: ['Open', 'Closed'], default: 'Open' },
  activityHealth: String,
  progressVariance: Number,
  delayDays: Number,
  blocker: ref('Blocker'),
  blockerType: String,
  impacted: [{ activity: ref('Activity'), name: String, delayDays: Number, _id: false }],
  expectedImpactDays: Number,
  severity: { type: String, enum: SEVERITIES },
  message: String,
  escalatedTo: ref('User'),
  closedAt: Date,
  history: [{
    at: { type: Date, default: Date.now }, event: String, severity: String, message: String, _id: false,
  }],
}, opts);
export const Risk = model('Risk', riskSchema);

const escalationSchema = new Schema({
  project: { ...ref('Project'), required: true, index: true },
  risk: { ...ref('Risk'), required: true },
  activity: ref('Activity'),
  severity: String,
  level: String,
  escalatedTo: ref('User'),
  reason: String,
  status: { type: String, enum: ['Open', 'Acknowledged'], default: 'Open' },
  acknowledgedAt: Date,
  acknowledgedBy: ref('User'),
}, opts);
export const Escalation = model('Escalation', escalationSchema);

// ---------- Communication ----------
const notificationSchema = new Schema({
  user: { ...ref('User'), required: true, index: true },
  type: { type: String, default: 'info' },
  title: String,
  message: String,
  link: String,
  risk: ref('Risk'),
  activity: ref('Activity'),
  read: { type: Boolean, default: false },
}, opts);
export const Notification = model('Notification', notificationSchema);

const commentSchema = new Schema({
  activity: { ...ref('Activity'), required: true, index: true },
  project: ref('Project'),
  user: ref('User'),
  text: { type: String, required: true },
}, opts);
export const Comment = model('Comment', commentSchema);

const attachmentSchema = new Schema({
  activity: { ...ref('Activity'), required: true, index: true },
  project: ref('Project'),
  uploadedBy: ref('User'),
  originalName: String,
  filename: String,
  url: String,
  mimetype: String,
  size: Number,
  caption: String,
}, opts);
export const Attachment = model('Attachment', attachmentSchema);

// ---------- Governance ----------
const auditLogSchema = new Schema({
  user: ref('User'),
  userName: String,
  action: { type: String, required: true },
  entityType: String,
  entityId: Schema.Types.ObjectId,
  project: ref('Project'),
  activity: ref('Activity'),
  field: String,
  previousValue: Schema.Types.Mixed,
  newValue: Schema.Types.Mixed,
  comment: String,
}, opts);
auditLogSchema.index({ activity: 1, createdAt: -1 });
export const AuditLog = model('AuditLog', auditLogSchema);

// ---------- 3D / 4D model ----------
// Parametric building spec per project. Geometry is derived from the activity plan and these
// overrides; there is no BIM/IFC source, so nothing here claims surveyed accuracy.
const buildingSpecSchema = new Schema({
  project: { ...ref('Project'), required: true, unique: true },
  // Any field left null is derived from project data (see services/building.js).
  plateAreaSqm: Number,
  aspectRatio: Number, // width ÷ depth of the floor plate
  floorHeightM: Number,
  slabThicknessM: Number,
  columnSizeM: Number,
  wallThicknessM: Number,
  baysX: Number,
  baysZ: Number,
  floorsBelow: Number, // existing storeys below the planned floors, shown as a plain mass
  balconySide: { type: String, enum: ['front', 'back', 'both', 'none'], default: 'front' },
  balconyDepthM: Number,
  hasParking: { type: Boolean, default: true },
  towerGapM: Number,
  wallColor: String,
  notes: String,
  // Interpreted DWG / DXF floor plans (see services/floorplan). When set, replaces the City Life massing.
  floorplan: Schema.Types.Mixed,
  updatedBy: ref('User'),
}, opts);
export const BuildingSpec = model('BuildingSpec', buildingSpecSchema);

// ---------- AI layer ----------
// Every agent execution is recorded: what went in, what came out, which model answered.
const aiRunSchema = new Schema({
  project: ref('Project'),
  agent: { type: String, required: true },
  trigger: { type: String, enum: AI_TRIGGERS, default: 'manual' },
  user: ref('User'),
  question: String,
  context: Schema.Types.Mixed, // deterministic findings sent to the model
  output: Schema.Types.Mixed, // model narration (or deterministic-only result)
  model: String,
  usage: { promptTokens: Number, responseTokens: Number, totalTokens: Number },
  latencyMs: Number,
  status: { type: String, enum: ['Success', 'Degraded', 'Failed'], default: 'Success' },
  errorMessage: String,
}, opts);
aiRunSchema.index({ project: 1, agent: 1, createdAt: -1 });
export const AiRun = model('AiRun', aiRunSchema);

// A numeric/date forecast the agents produced. Humans can accept, reject or override it.
const aiPredictionSchema = new Schema({
  project: { ...ref('Project'), required: true, index: true },
  activity: ref('Activity'),
  agent: { type: String, required: true },
  kind: { type: String, required: true }, // e.g. completionDate, delayDays, labourShortfall
  label: String,
  value: Schema.Types.Mixed, // deterministic numbers/dates, never model-authored
  unit: String,
  confidence: Number, // 0-100, derived from data coverage
  basis: [String], // human-readable evidence lines
  narration: String, // Gemini explanation, labelled as AI-generated in the UI
  run: ref('AiRun'),
  status: { type: String, enum: AI_DECISIONS, default: 'Proposed' },
  decidedBy: ref('User'),
  decidedAt: Date,
  override: { value: Schema.Types.Mixed, reason: String },
}, opts);
aiPredictionSchema.index({ project: 1, kind: 1, createdAt: -1 });
export const AiPrediction = model('AiPrediction', aiPredictionSchema);

// Alert centre entries. Generated by deterministic thresholds so they never depend on the model.
const aiAlertSchema = new Schema({
  project: { ...ref('Project'), required: true, index: true },
  activity: ref('Activity'),
  key: { type: String, required: true }, // stable identity so repeat runs update instead of duplicating
  level: { type: String, enum: AI_ALERT_LEVELS, required: true },
  category: { type: String, required: true },
  title: { type: String, required: true },
  message: String,
  basis: [String],
  agent: String,
  status: { type: String, enum: ['Open', 'Acknowledged', 'Resolved'], default: 'Open' },
  acknowledgedBy: ref('User'),
  acknowledgedAt: Date,
  resolvedAt: Date,
}, opts);
aiAlertSchema.index({ project: 1, key: 1, status: 1 });
export const AiAlert = model('AiAlert', aiAlertSchema);

// Copilot threads, kept so answers stay auditable alongside the records they cited.
const aiConversationSchema = new Schema({
  user: { ...ref('User'), required: true, index: true },
  project: ref('Project'),
  title: String,
  messages: [{
    role: { type: String, enum: ['user', 'assistant'], required: true },
    text: { type: String, required: true },
    agent: String,
    sources: [String],
    run: ref('AiRun'),
    at: { type: Date, default: Date.now },
    _id: false,
  }],
}, opts);
export const AiConversation = model('AiConversation', aiConversationSchema);

// ---------- Resources (labour / inventory / site / camera) ----------
const inventoryItemSchema = new Schema({
  project: { ...ref('Project'), required: true, index: true },
  name: { type: String, required: true },
  unit: { type: String, required: true },
  stock: { type: Number, default: 0 },
  minStock: { type: Number, default: 0 },
  reorderLevel: { type: Number, default: 0 },
  supplier: String,
  notes: String,
  source: { type: String, default: 'manual' },
}, opts);
inventoryItemSchema.index({ project: 1, name: 1 }, { unique: true });
export const InventoryItem = model('InventoryItem', inventoryItemSchema);

const inventoryTxnSchema = new Schema({
  project: { ...ref('Project'), required: true, index: true },
  item: { ...ref('InventoryItem'), required: true, index: true },
  type: { type: String, enum: INVENTORY_TXN_TYPES, required: true },
  quantity: { type: Number, required: true },
  date: { type: Date, required: true },
  activity: ref('Activity'),
  supplier: String,
  note: String,
  recordedBy: ref('User'),
  source: { type: String, default: 'manual' },
}, opts);
export const InventoryTxn = model('InventoryTxn', inventoryTxnSchema);

const labourAttendanceSchema = new Schema({
  project: { ...ref('Project'), required: true, index: true },
  date: { type: Date, required: true },
  trade: { type: String, required: true },
  category: { type: String, enum: LABOUR_CATEGORIES, default: 'Skilled' },
  contractor: String,
  planned: { type: Number, default: 0 },
  present: { type: Number, default: 0 },
  checkIn: String,
  checkOut: String,
  activity: ref('Activity'),
  reportedBy: ref('User'),
  source: { type: String, default: 'manual' },
}, opts);
labourAttendanceSchema.index({ project: 1, date: 1, trade: 1, contractor: 1 }, { unique: true });
export const LabourAttendance = model('LabourAttendance', labourAttendanceSchema);

const siteReportSchema = new Schema({
  project: { ...ref('Project'), required: true, index: true },
  date: { type: Date, required: true },
  reportedBy: ref('User'),
  workCompleted: [{ activity: ref('Activity'), quantity: Number, progress: Number, notes: String, _id: false }],
  labour: [{ trade: String, category: { type: String, enum: LABOUR_CATEGORIES }, planned: Number, present: Number, _id: false }],
  materialsReceived: [resourceLine],
  materialsConsumed: [resourceLine],
  equipment: [{ name: String, count: Number, hours: Number, _id: false }],
  weather: String,
  issues: String,
  remarks: String,
  photos: [ref('Attachment')],
  aiSummary: Schema.Types.Mixed,
  source: { type: String, default: 'manual' },
}, opts);
siteReportSchema.index({ project: 1, date: 1, reportedBy: 1 }, { unique: true });
export const SiteReport = model('SiteReport', siteReportSchema);

const cameraObservationSchema = new Schema({
  project: { ...ref('Project'), required: true, index: true },
  activity: ref('Activity'),
  uploadedBy: ref('User'),
  originalName: String,
  filename: String,
  url: String,
  mimetype: String,
  caption: String,
  previous: ref('CameraObservation'),
  analysis: {
    workers: Number,
    helmets: Number,
    jackets: Number,
    machinery: [String],
    activitiesVisible: [String],
    safetyIssues: [String],
    siteChanges: String,
    progressEstimate: Number,
    previousProgressEstimate: Number,
    progressDelta: Number,
    confidence: Number,
    notes: String,
    aiGenerated: { type: Boolean, default: true },
  },
  verification: {
    status: { type: String, enum: CAMERA_VERIFY, default: 'Pending' },
    by: ref('User'),
    at: Date,
    note: String,
    edited: Schema.Types.Mixed,
  },
  source: { type: String, enum: ['upload', 'cctv', 'drone', 'mobile', 'demo'], default: 'upload' },
}, opts);
export const CameraObservation = model('CameraObservation', cameraObservationSchema);

const aiReportSchema = new Schema({
  project: { ...ref('Project'), required: true, index: true },
  kind: { type: String, enum: REPORT_KINDS, required: true },
  periodStart: Date,
  periodEnd: Date,
  data: Schema.Types.Mixed, // deterministic body
  narration: Schema.Types.Mixed,
  generatedBy: ref('User'),
  run: ref('AiRun'),
}, opts);
export const AiReport = model('AiReport', aiReportSchema);

// Geotechnical report and the plinth estimate calculated from it. Gemini only fills
// `extraction.facts`; `estimate` is computed by services/ai/geotech.js from those facts and the
// user's inputs. `actual` is what happened on site, which the agent learns its rates from.
const geotechReportSchema = new Schema({
  project: { ...ref('Project'), required: true, index: true },
  uploadedBy: ref('User'),
  source: { type: String, enum: ['upload', 'sample'], default: 'upload' },
  file: { originalName: String, filename: String, url: String, mimetype: String, size: Number },
  extraction: {
    status: { type: String, enum: ['Read', 'Not read', 'Sample'], required: true },
    reason: String,
    model: String,
    facts: Schema.Types.Mixed,
  },
  inputs: {
    plinthAreaSqm: Number, // as typed, else read from the report, else the default
    areaSource: String, // user | report | default
    depthM: Number, // as typed by the user, if any
    depthUsedM: Number,
    depthSource: String,
  },
  estimate: Schema.Types.Mixed,
  // Rain buffer on the estimate (services/weather.js): dated schedule from the start date.
  weather: Schema.Types.Mixed,
  // Weather report uploaded for this site; Gemini reads it into daily rain, which wins over the forecast.
  weatherUpload: {
    file: { originalName: String, filename: String, url: String, mimetype: String, size: Number },
    status: { type: String, enum: ['Read', 'Not read'] },
    reason: String,
    title: String,
    location: String,
    days: Schema.Types.Mixed,
    by: ref('User'),
    at: Date,
  },
  narration: Schema.Types.Mixed, // AI-written explanation of the calculated estimate
  verification: {
    status: { type: String, enum: GEOTECH_VERIFY, default: 'Pending' },
    by: ref('User'),
    at: Date,
    note: String,
  },
  actual: {
    excavationDays: Number,
    jcbCount: Number,
    totalDays: Number,
    note: String,
    recordedBy: ref('User'),
    at: Date,
  },
  run: ref('AiRun'),
  prediction: ref('AiPrediction'),
}, opts);
geotechReportSchema.index({ project: 1, createdAt: -1 });
export const GeotechReport = model('GeotechReport', geotechReportSchema);

// One working day of an accepted plinth estimate: the checklist the site engineer works through.
// Created when the estimate is accepted; the engineer ticks items, adds their own and records the
// actual quantity. `items` with source 'plan' come from the estimate, 'added' from people on site.
const plinthDaySchema = new Schema({
  report: { ...ref('GeotechReport'), required: true, index: true },
  project: { ...ref('Project'), required: true, index: true },
  day: { type: Number, required: true }, // 1-based, across the whole plinth plan
  date: { type: Date, required: true },
  phaseKey: String,
  phaseName: String,
  dayInPhase: Number,
  phaseDays: Number,
  title: String,
  // Set on days the weather takes: rain, light (slow wet day), recovery (dry-out) or buffer.
  weather: { kind: String, rainMm: Number, note: String },
  planned: { quantity: Number, unit: String, label: String },
  crew: [{ trade: String, count: Number, _id: false }],
  machines: [{ name: String, count: Number, kind: String, _id: false }],
  items: [{
    text: { type: String, required: true },
    done: { type: Boolean, default: false },
    source: { type: String, enum: ['plan', 'added'], default: 'plan' },
    addedBy: ref('User'),
    doneBy: ref('User'),
    doneAt: Date,
  }],
  actualQuantity: Number,
  note: String,
  status: { type: String, enum: ['Pending', 'In Progress', 'Done'], default: 'Pending' },
  completedAt: Date,
  updatedBy: ref('User'),
}, opts);
plinthDaySchema.index({ report: 1, day: 1 }, { unique: true });
export const PlinthDay = model('PlinthDay', plinthDaySchema);

// Configurable business rules (single document, key = 'rules').
const settingSchema = new Schema({
  key: { type: String, unique: true },
  value: Schema.Types.Mixed,
}, opts);
export const Setting = model('Setting', settingSchema);
