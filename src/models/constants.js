export const ROLES = ['admin', 'project_manager', 'site_manager', 'site_engineer', 'planning_engineer', 'estimation_engineer'];
export const MANAGER_ROLES = ['admin', 'project_manager', 'site_manager'];
// Demo: these roles, their users and their teams are left out of lists. Empty the arrays to show them again
// (and HIDDEN_ROLES in frontend/src/lib/types.ts).
export const HIDDEN_ROLES = ['planning_engineer', 'estimation_engineer'];
export const HIDDEN_TEAM_TYPES = ['Planning', 'Estimation'];

export const TEAM_TYPES = ['Planning', 'Estimation', 'Execution'];
export const DATA_SOURCES = ['manual', 'seed', 'colab', 'msproject', 'import'];
export const SYNC_TYPES = ['teams', 'planning', 'estimation', 'execution'];

export const PROJECT_STATUSES = ['Planning', 'Active', 'On Hold', 'Completed'];

export const ACTIVITY_STATUSES = ['Planned', 'In Progress', 'Completed', 'Delayed', 'Blocked'];
export const HEALTH_STATES = ['On Track', 'At Risk', 'Delayed', 'Blocked'];
export const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];

export const DEPENDENCY_TYPES = ['FS'];

export const BLOCKER_TYPES = [
  'Material', 'Labour', 'Vendor', 'Machine', 'Drawing',
  'Approval', 'Inspection', 'Weather', 'Site Condition', 'Other',
];
export const BLOCKER_STATUSES = ['Open', 'Assigned', 'In Progress', 'Resolved', 'Closed'];
export const OPEN_BLOCKER_STATUSES = ['Open', 'Assigned', 'In Progress'];

export const SEVERITIES = ['Low', 'Medium', 'High'];

// ---------- AI layer ----------
export const AI_AGENTS = [
  'progress', 'planning', 'scheduling', 'delay', 'completion',
  'labour', 'material', 'inventory', 'equipment', 'ground', 'risk',
  'camera', 'reporting', 'copilot', 'geotech',
];
export const AI_TRIGGERS = ['manual', 'scheduled', 'event', 'copilot'];
export const AI_DECISIONS = ['Proposed', 'Accepted', 'Rejected', 'Overridden'];
export const AI_ALERT_LEVELS = ['critical', 'warning', 'attention', 'positive'];
export const DELAY_RISK_LEVELS = ['Low', 'Medium', 'High', 'Critical'];
export const STOCK_RISKS = ['Critical', 'Low', 'Normal', 'Excess'];
export const INVENTORY_TXN_TYPES = ['opening', 'received', 'consumed', 'adjustment', 'wastage'];
export const LABOUR_CATEGORIES = ['Skilled', 'Semi-skilled', 'Unskilled'];
export const REPORT_KINDS = ['daily', 'weekly', 'monthly', 'delay', 'labour', 'material', 'equipment', 'health', 'management'];
export const CAMERA_VERIFY = ['Pending', 'Accepted', 'Rejected', 'Edited'];
export const GEOTECH_VERIFY = ['Pending', 'Accepted', 'Rejected', 'Overridden'];
export const SOIL_CLASSES = ['soft', 'ordinary', 'hard', 'rock'];
export const FOUNDATION_TYPES = ['isolated', 'raft', 'pile'];

// ---------- 3D / 4D model ----------
export const COMPONENT_TYPES = [
  'base', 'column', 'slab', 'wall', 'window', 'door', 'balcony', 'stair', 'parking', 'ground',
  'light', 'flooring', 'parapet', 'frame', 'mullion', 'railing', 'furniture', 'canopy', 'step',
  'tree', 'hedge', 'ac', 'band',
];
// Component categories are matched against activity names so the model links to real work.
export const COMPONENT_CATEGORIES = ['structure', 'slab', 'masonry', 'openings', 'mep', 'finishes', 'site'];
export const severityRank = (s) => SEVERITIES.indexOf(s);
