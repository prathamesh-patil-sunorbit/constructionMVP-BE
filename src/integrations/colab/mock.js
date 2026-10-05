// Mock Colab feed used until real API access is configured (COLAB_API_URL).
// Payload shapes are our assumed Colab format; adjust the mappers in importer.js once the real
// API contract is confirmed. Dates are relative to today so the demo always looks current.
import { today, addDays } from '../../utils/dates.js';

const iso = (offset) => addDays(today(), offset).toISOString().slice(0, 10);

const STEPS = [
  {
    key: 'COL', name: 'Column Completion', qty: 12, uom: 'Nos', rate: 18500,
    labour: [['Carpenter', 6], ['Bar bender', 4], ['Helper', 6]],
    materials: [['Concrete M40', 6, 'cum'], ['TMT steel', 0.9, 'MT']],
    equipment: [['Tower crane', 1]],
  },
  {
    key: 'RNF', name: 'Slab Reinforcement', qty: 2.5, uom: 'MT', rate: 72000,
    labour: [['Bar bender', 10], ['Helper', 6]],
    materials: [['TMT steel', 2.6, 'MT'], ['Binding wire', 25, 'kg']],
    equipment: [['Tower crane', 1], ['Bar bending machine', 1]],
  },
  {
    key: 'FWK', name: 'Mivan Slab Formwork', qty: 1000, uom: 'sq.ft', rate: 145,
    labour: [['Mivan carpenter', 10], ['Helper', 6]],
    materials: [['Mivan aluminium panels', 1000, 'sq.ft'], ['Form release oil', 40, 'L']],
    equipment: [['Tower crane', 1]],
  },
  {
    key: 'MEP', name: 'MEP Sleeves', qty: 48, uom: 'Nos', rate: 850,
    labour: [['Electrician', 4], ['Plumber', 3]],
    materials: [['PVC sleeves', 48, 'Nos'], ['Electrical conduit', 300, 'rmt']],
    equipment: [],
  },
  {
    key: 'CON', name: 'Slab Concrete', qty: 45, uom: 'cum', rate: 6800,
    labour: [['Mason', 6], ['Helper', 10], ['Vibrator operator', 2]],
    materials: [['RMC M30', 45, 'cum']],
    equipment: [['Concrete pump', 1], ['Needle vibrator', 3]],
  },
  {
    key: 'CUR', name: 'Curing', qty: 1, uom: 'Slab', rate: 9000,
    labour: [['Helper', 2]],
    materials: [['Water', 15, 'KL'], ['Curing compound', 20, 'L']],
    equipment: [],
  },
  {
    key: 'BLK', name: 'Blockwork', qty: 850, uom: 'sq.ft', rate: 95,
    labour: [['Mason', 8], ['Helper', 8]],
    materials: [['AAC blocks', 1100, 'Nos'], ['Block adhesive', 40, 'bags']],
    equipment: [['Material hoist', 1]],
  },
];

// [startOffset, finishOffset] per step and floor (the planning team's current schedule).
const SCHEDULE = {
  17: [[-18, -17], [-16, -14], [-13, -12], [-11, -11], [-10, -10], [-9, -7], [-2, 2]],
  18: [[-8, -7], [-6, -4], [-3, 0], [1, 1], [2, 2], [3, 5], [6, 9]],
  19: [[3, 4], [5, 7], [8, 11], [12, 12], [13, 13], [14, 16], [17, 20]],
};
// Approved baseline differs where the planning team has already re-planned.
const BASELINE_SHIFT = { '18-FWK': -1, '18-RNF': -1 };

const EXTRA_TASKS = [
  {
    floor: 17, key: 'PLB', name: 'Plumbing Rough-in', start: 3, finish: 5, after: 'TA-F17-BLK',
    qty: 36, uom: 'points', rate: 1400, labour: [['Plumber', 4], ['Helper', 2]],
    materials: [['CPVC pipe', 180, 'rmt']], equipment: [],
  },
];

const ownerFor = (floor) => (floor === 19 ? 'engineer2@krisala.test' : 'engineer@krisala.test');
const taskId = (floor, key) => `TA-F${floor}-${key}`;

function allTasks() {
  const tasks = [];
  for (const floor of [17, 18, 19]) {
    STEPS.forEach((step, i) => {
      const [s, f] = SCHEDULE[floor][i];
      const shift = BASELINE_SHIFT[`${floor}-${step.key}`] || 0;
      const predecessors = i > 0 ? [{ task_id: taskId(floor, STEPS[i - 1].key), type: 'FS', lag: 0 }] : [];
      if (i === 0 && floor > 17) predecessors.push({ task_id: taskId(floor - 1, 'CON'), type: 'FS', lag: 0 });
      tasks.push({ floor, step, s, f, shift, predecessors, index: i });
    });
  }
  for (const x of EXTRA_TASKS) {
    tasks.push({ floor: x.floor, step: x, s: x.start, f: x.finish, shift: 0, predecessors: [{ task_id: x.after, type: 'FS', lag: 0 }], index: 7 });
  }
  return tasks;
}

export function teams(projectCode) {
  return {
    project_code: projectCode,
    teams: [
      {
        team_code: 'PLN-TA', name: 'Planning Cell - Tower A', type: 'planning', lead_email: 'planning@krisala.test',
        members: [{ email: 'planning@krisala.test' }, { email: 'pm@krisala.test' }],
      },
      {
        team_code: 'EST-TA', name: 'Estimation & QS', type: 'estimation', lead_email: 'estimation@krisala.test',
        members: [{ email: 'estimation@krisala.test' }],
      },
      {
        team_code: 'EXE-TA', name: 'Execution - Tower A', type: 'execution', lead_email: 'sm@krisala.test',
        members: [{ email: 'sm@krisala.test' }, { email: 'engineer@krisala.test' }, { email: 'engineer2@krisala.test' }],
      },
    ],
  };
}

export function planning(projectCode) {
  return {
    project_code: projectCode,
    schedule_version: 'REV-03',
    tasks: allTasks().map(({ floor, step, s, f, shift, predecessors, index }) => ({
      task_id: taskId(floor, step.key),
      task_name: step.name,
      wbs: `1.${floor - 16}.${index + 1}`,
      location: [{ type: 'Tower', name: 'Tower A' }, { type: 'Floor', name: `Floor ${floor}` }],
      baseline_start: iso(s + shift),
      baseline_finish: iso(f + shift),
      baseline_version: 'BL-01',
      approved_by: 'Neha Kale',
      planned_start: iso(s),
      planned_finish: iso(f),
      qty: step.qty,
      uom: step.uom,
      priority: ['CON', 'FWK'].includes(step.key) ? 'High' : 'Medium',
      owner_email: ownerFor(floor),
      predecessors,
    })),
  };
}

export function estimation(projectCode) {
  return {
    project_code: projectCode,
    estimate_version: 'EST-02',
    items: allTasks().map(({ floor, step, s, f }) => {
      const days = f - s + 1;
      return {
        task_id: taskId(floor, step.key),
        boq_code: `BOQ-${step.key}-${floor}`,
        description: `${step.name}, Tower A Floor ${floor}`,
        qty: step.qty,
        uom: step.uom,
        rate: step.rate,
        amount: Math.round(step.qty * step.rate),
        est_duration_days: days,
        productivity_per_day: Math.round((step.qty / days) * 100) / 100,
        labour: step.labour.map(([trade, count]) => ({ trade, count })),
        materials: step.materials.map(([item, qty, uom]) => ({ item, qty, uom })),
        equipment: step.equipment.map(([name, count]) => ({ name, count })),
        estimator_email: 'estimation@krisala.test',
        status: 'approved',
      };
    }),
  };
}

// Daily progress reports (DPR) from the execution team: resources actually deployed.
const SHORTFALLS = {
  '18-FWK': { days: [-1, 0], trade: 'Mivan carpenter', actual: 6, remarks: 'Shuttering panels short; Mivan crew partly idle' },
  '17-BLK': { days: [-2, -1, 0], trade: 'Mason', actual: 5, remarks: 'Masons short by 3 (2 on leave, 1 shifted to Tower B)' },
};

export function execution(projectCode) {
  const reports = [];
  for (const { floor, step, s, f } of allTasks()) {
    const shortfall = SHORTFALLS[`${floor}-${step.key}`];
    for (let d = s; d <= Math.min(f, 0); d++) {
      const short = shortfall?.days.includes(d) ? shortfall : null;
      reports.push({
        report_id: `DPR-${taskId(floor, step.key)}-${iso(d)}`,
        task_id: taskId(floor, step.key),
        date: iso(d),
        contractor: step.key === 'MEP' ? 'Voltline MEP Services' : 'Shree Ganesh Constructions',
        manpower: step.labour.map(([trade, count]) => ({ trade, planned: count, actual: short && short.trade === trade ? short.actual : count })),
        equipment: step.equipment.map(([name, count]) => ({ name, count, hours: 8 })),
        materials_consumed: step.materials.map(([item, qty, uom]) => ({ item, qty: Math.round((qty / (f - s + 1)) * 100) / 100, uom })),
        weather: d % 3 === 0 ? 'Cloudy' : 'Clear',
        working_hours: 9,
        remarks: short?.remarks || '',
        reported_by_email: 'sm@krisala.test',
      });
    }
  }
  return { project_code: projectCode, reports };
}
