// Computer-vision estimates from uploaded site photographs.
// Every number here is an AI estimate and must be verified by a person before it is trusted.

import { Type } from '@google/genai';
import { askGemini, aiConfig } from './gemini.js';

const visionSchema = {
  type: Type.OBJECT,
  properties: {
    workers: { type: Type.NUMBER, description: 'Visible people who appear to be workers. 0 if none or unclear.' },
    helmets: { type: Type.NUMBER },
    jackets: { type: Type.NUMBER },
    machinery: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Visible machines, empty if none.' },
    activitiesVisible: { type: Type.ARRAY, items: { type: Type.STRING } },
    safetyIssues: { type: Type.ARRAY, items: { type: Type.STRING } },
    siteChanges: { type: Type.STRING, description: 'What changed versus the previous photo, or "no previous photo".' },
    progressEstimate: { type: Type.NUMBER, description: '0-100 visual estimate of the named activity, or null if not visible.' },
    confidence: { type: Type.NUMBER, description: '0-100 self-assessed visibility confidence.' },
    notes: { type: Type.STRING },
  },
  required: ['workers', 'helmets', 'jackets', 'machinery', 'activitiesVisible', 'safetyIssues', 'siteChanges', 'confidence', 'notes'],
};

export async function analyseSitePhoto({ imageBase64, mimeType, caption, activity, previous }) {
  if (!aiConfig().configured) {
    return {
      insufficientData: true,
      reason: 'GEMINI_API_KEY is not configured, so the photograph cannot be analysed.',
      aiGenerated: true,
    };
  }
  const { data, model, usage, latencyMs } = await askGemini({
    system: `You are reviewing a construction-site photograph. Count only what is clearly visible.
If something is not visible, use 0 or an empty list. Never invent a worker count, machine or progress figure.
progressEstimate is a visual guess of the named activity only, or omit it if the activity is not in the frame.
Label uncertainty in notes. This is an estimate for a site engineer to verify, not a measurement.`,
    payload: {
      caption: caption || null,
      activity: activity ? { code: activity.code, name: activity.name } : null,
      previous: previous ? {
        caption: previous.caption,
        workers: previous.analysis?.workers,
        progressEstimate: previous.analysis?.progressEstimate,
      } : null,
      image: { mimeType, base64Length: imageBase64.length },
    },
    schema: visionSchema,
    image: { mimeType, data: imageBase64 },
  });
  const prev = previous?.analysis?.progressEstimate;
  return {
    ...data,
    previousProgressEstimate: prev ?? null,
    progressDelta: data.progressEstimate != null && prev != null ? data.progressEstimate - prev : null,
    aiGenerated: true,
    model,
    usage,
    latencyMs,
  };
}
