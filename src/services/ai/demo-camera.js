// Bundled demonstration photographs for the AI camera tab.
// These are sample site stills, not a live CCTV feed. Analysis is labelled as a sample estimate.

import fs from 'node:fs';
import path from 'node:path';
import { Activity, CameraObservation } from '../../models/index.js';
import { UPLOAD_DIR } from '../../routes/activities.js';

export const DEMO_DIR = path.resolve('demo/camera');

const SAMPLE_NOTE = 'Demonstration photograph (not a live camera). The counts below are sample AI estimates for this still and must be verified.';

export const DEMO_SHOTS = [
  {
    file: 'demo-camera-formwork-day1.jpg',
    match: /formwork|shuttering|mivan/i,
    caption: 'Site camera · earlier scan — Mivan slab formwork',
    analysis: {
      workers: 2, helmets: 2, jackets: 2,
      machinery: [],
      activitiesVisible: ['Aluminium Mivan formwork', 'Prop erection'],
      safetyIssues: ['Edge protection incomplete on far side'],
      siteChanges: 'No previous photo.',
      progressEstimate: 40, previousProgressEstimate: null, progressDelta: null,
      confidence: 62, notes: SAMPLE_NOTE, aiGenerated: true,
    },
  },
  {
    file: 'demo-camera-formwork-day2.jpg',
    match: /formwork|shuttering|mivan/i,
    caption: 'Site camera · later scan — Mivan slab formwork',
    pairWith: 'demo-camera-formwork-day1.jpg',
    analysis: {
      workers: 3, helmets: 3, jackets: 3,
      machinery: [],
      activitiesVisible: ['Aluminium Mivan formwork', 'Panel delivery'],
      safetyIssues: [],
      siteChanges: 'More panels in place; remaining gap on the far bay. Extra panel stack delivered.',
      progressEstimate: 75, previousProgressEstimate: 40, progressDelta: 35,
      confidence: 68, notes: SAMPLE_NOTE, aiGenerated: true,
    },
  },
  {
    file: 'demo-camera-rebar.jpg',
    match: /reinforc|rebar|steel/i,
    caption: 'Site camera · slab reinforcement',
    analysis: {
      workers: 3, helmets: 2, jackets: 2,
      machinery: [],
      activitiesVisible: ['TMT rebar tying', 'Spacer placement'],
      safetyIssues: ['One worker without a high-visibility jacket'],
      siteChanges: 'No previous photo.',
      progressEstimate: 55, previousProgressEstimate: null, progressDelta: null,
      confidence: 60, notes: SAMPLE_NOTE, aiGenerated: true,
    },
  },
  {
    file: 'demo-camera-blockwork.jpg',
    match: /block|brick|masonry/i,
    caption: 'Site camera · AAC blockwork',
    analysis: {
      workers: 2, helmets: 2, jackets: 1,
      machinery: ['JCB (idle, at lower level)'],
      activitiesVisible: ['AAC block masonry', 'Mortar mixing'],
      safetyIssues: [],
      siteChanges: 'No previous photo.',
      progressEstimate: 48, previousProgressEstimate: null, progressDelta: null,
      confidence: 64, notes: SAMPLE_NOTE, aiGenerated: true,
    },
  },
];

function findActivity(activities, pattern) {
  return activities.find((a) => pattern.test(a.name) && a.status !== 'Completed')
    || activities.find((a) => pattern.test(a.name));
}

export async function loadDemoCameras(projectId, user) {
  if (!fs.existsSync(DEMO_DIR)) {
    const err = new Error('Demo camera images are missing on the server');
    err.status = 500;
    throw err;
  }
  const activities = await Activity.find({ project: projectId }).lean();
  await CameraObservation.deleteMany({ project: projectId, source: 'demo' });

  const created = [];
  const byFile = new Map();
  for (const shot of DEMO_SHOTS) {
    const src = path.join(DEMO_DIR, shot.file);
    if (!fs.existsSync(src)) continue;
    fs.copyFileSync(src, path.join(UPLOAD_DIR, shot.file));
    const activity = findActivity(activities, shot.match);
    const previous = shot.pairWith ? byFile.get(shot.pairWith) : null;
    const obs = await CameraObservation.create({
      project: projectId,
      activity: activity?._id,
      uploadedBy: user?._id,
      originalName: shot.file,
      filename: shot.file,
      url: `/uploads/${shot.file}`,
      mimetype: 'image/jpeg',
      caption: shot.caption,
      previous: previous?._id,
      analysis: shot.analysis,
      verification: { status: 'Pending' },
      source: 'demo',
    });
    byFile.set(shot.file, obs);
    created.push(obs);
  }
  return created;
}
