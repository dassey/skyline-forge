import { buildModel } from './build.js';

let currentJob = 0;

// The LiDAR roof grid is megabytes; it is sent once per area and kept here
// rather than copied with every rebuild.
let roofs = { id: 0, grid: null };

self.onmessage = (event) => {
  const { type, jobId, payload } = event.data || {};

  if (type === 'cancel') {
    currentJob++;
    return;
  }
  if (type === 'roofs') {
    roofs = { id: event.data.id, grid: event.data.grid };
    return;
  }
  if (type !== 'build') return;

  currentJob = jobId;

  const post = (message) => {
    if (jobId !== currentJob) return false;
    self.postMessage(message);
    return true;
  };

  try {
    const result = buildModel(payload.features, payload.settings, {
      heightGrid: payload.heightGrid
        ? { ...payload.heightGrid, values: new Float32Array(payload.heightGrid.values) }
        : null,
      routePoints: payload.routePoints,
      roofGrid: payload.roofsId && payload.roofsId === roofs.id ? roofs.grid : null,
      font: payload.font,
      onProgress: (fraction, message) =>
        post({ type: 'progress', jobId, fraction, message }),
    });

    if (jobId !== currentJob) return;

    const transfers = [];
    for (const part of result.parts) {
      transfers.push(part.positions.buffer, part.indices.buffer);
    }
    self.postMessage({ type: 'done', jobId, result }, transfers);
  } catch (error) {
    post({
      type: 'error',
      jobId,
      message: error?.message || String(error),
      stack: error?.stack || '',
    });
  }
};
