import { decodePng } from './png.js';

// Roof heights measured by airborne LiDAR. The USGS 3D Elevation Program has
// flown almost all of the United States; Microsoft's Planetary Computer
// serves 2 m rasters derived from it. Height above ground is the surface
// model (first returns: roofs, trees) minus the terrain model (bare earth),
// which is what turns a footprint into the building that actually stands on
// it. The ready-made height-above-ground layer is not used: in some surveys
// it is smeared several metres sideways.

const STAC = 'https://planetarycomputer.microsoft.com/api/stac/v1/search';
const DATA = 'https://planetarycomputer.microsoft.com/api/data/v1/item/bbox';
const SURFACE = '3dep-lidar-dsm';
const TERRAIN = '3dep-lidar-dtm';

const TARGET_PIXEL_M = 1;
const MAX_PIXELS = 2048;
const MAX_SURVEYS = 3;
const MAX_TILES_PER_SURVEY = 6;
const TIMEOUT_MS = 45000;
const SEARCH_TIMEOUT_MS = 20000;

const cache = new Map();

// 3DEP covers the fifty states and the territories; skip the request anywhere
// else.
export function mayHaveLidar(bbox) {
  const lat = (bbox.minLat + bbox.maxLat) / 2;
  const lon = (bbox.minLon + bbox.maxLon) / 2;
  const states = lat > 17 && lat < 72 && lon > -170 && lon < -64;
  const pacific = lat > 13 && lat < 21 && lon > 144 && lon < 147;
  return states || pacific;
}

function spanMetres(bbox) {
  const midLat = (bbox.minLat + bbox.maxLat) / 2;
  return {
    x: (bbox.maxLon - bbox.minLon) * 111320 * Math.cos((midLat * Math.PI) / 180),
    y: (bbox.maxLat - bbox.minLat) * 110540,
  };
}

async function fetchWithTimeout(url, signal, timeout = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// Tiles are named {survey}-dsm-2m-{col}-{row}; group them by survey and put
// the most recent flight first, since buildings change. A survey is only
// usable when it has both a surface and a terrain tile.
export function groupSurveys(items) {
  const surveys = new Map();
  for (const item of items) {
    const props = item.properties || {};
    const kind = /-dsm-/.test(item.id) ? 'surface' : /-dtm-/.test(item.id) ? 'terrain' : null;
    if (!kind) continue;
    const name = props['3dep:usgs_id'] || String(item.id).replace(/-d[st]m-.*$/, '');
    const when = props.end_datetime || props.datetime || props.start_datetime || '';
    const year = parseInt(String(when).slice(0, 4), 10) || null;
    if (!surveys.has(name)) surveys.set(name, { name, year, when, surface: [], terrain: [] });
    surveys.get(name)[kind].push(item.id);
  }
  return [...surveys.values()]
    .filter((s) => s.surface.length && s.terrain.length)
    .sort((a, b) => (a.when < b.when ? 1 : a.when > b.when ? -1 : 0));
}

// Terrarium encoding: metres = R·256 + G + B/256 − 32768, alpha 0 = no data.
// Rows arrive north-first; grids are stored south-first like the terrain
// grid. Only cells that are still empty are written.
export function mergeTerrarium(values, cols, rows, png) {
  if (png.width !== cols || png.height !== rows) return 0;
  const { data, channels } = png;
  let filled = 0;
  for (let r = 0; r < rows; r++) {
    const src = (rows - 1 - r) * cols * channels;
    const dst = r * cols;
    for (let c = 0; c < cols; c++) {
      if (!Number.isNaN(values[dst + c])) continue;
      const at = src + c * channels;
      if (channels === 4 && data[at + 3] === 0) continue;
      const h = data[at] * 256 + data[at + 1] + data[at + 2] / 256 - 32768;
      if (h < -500 || h > 9000) continue;
      values[dst + c] = h;
      filled++;
    }
  }
  return filled;
}

// The terrain model has holes under large buildings, where no pulse reached
// the ground. Bridge them from the ground on either side, along rows and
// columns, so the roof above still gets a height.
export function fillTerrainGaps(values, cols, rows) {
  const across = new Float32Array(values.length).fill(NaN);
  const down = new Float32Array(values.length).fill(NaN);

  const bridge = (out, count, length, index) => {
    for (let line = 0; line < count; line++) {
      let last = -1;
      for (let i = 0; i <= length; i++) {
        const here = i < length ? values[index(line, i)] : NaN;
        if (i < length && Number.isNaN(here)) continue;
        if (i - last > 1) {
          const a = last >= 0 ? values[index(line, last)] : here;
          const b = i < length ? here : a;
          if (!Number.isNaN(a) && !Number.isNaN(b)) {
            for (let k = last + 1; k < i; k++) {
              const t = last < 0 || i >= length ? 0 : (k - last) / (i - last);
              out[index(line, k)] = a + (b - a) * t;
            }
          }
        }
        last = i;
      }
    }
  };
  bridge(across, rows, cols, (r, c) => r * cols + c);
  bridge(down, cols, rows, (c, r) => r * cols + c);

  for (let i = 0; i < values.length; i++) {
    if (!Number.isNaN(values[i])) continue;
    const a = across[i];
    const b = down[i];
    values[i] = Number.isNaN(a) ? b : Number.isNaN(b) ? a : (a + b) / 2;
  }
}

export async function fetchRoofGrid(bbox, opts = {}) {
  if (!mayHaveLidar(bbox)) return null;

  const key = [bbox.minLat, bbox.minLon, bbox.maxLat, bbox.maxLon].map((v) => v.toFixed(5)).join(',');
  if (cache.has(key)) return cache.get(key);

  opts.onProgress?.('Looking for LiDAR roof measurements…');
  const box = `${bbox.minLon.toFixed(6)},${bbox.minLat.toFixed(6)},${bbox.maxLon.toFixed(6)},${bbox.maxLat.toFixed(6)}`;
  const found = await fetchWithTimeout(
    `${STAC}?collections=${SURFACE},${TERRAIN}&bbox=${box}&limit=100`,
    opts.signal,
    SEARCH_TIMEOUT_MS
  );
  if (!found.ok) throw new Error(`LiDAR catalogue ${found.status}`);
  const surveys = groupSurveys((await found.json()).features || []);
  if (!surveys.length) {
    cache.set(key, null);
    return null;
  }

  const span = spanMetres(bbox);
  const pixel = Math.max(TARGET_PIXEL_M, Math.max(span.x, span.y) / MAX_PIXELS);
  const cols = Math.max(8, Math.round(span.x / pixel));
  const rows = Math.max(8, Math.round(span.y / pixel));
  const grid = {
    cols,
    rows,
    bbox: { ...bbox },
    values: new Float32Array(cols * rows).fill(NaN),
    resolutionM: Math.max(2, pixel),
  };

  const used = [];
  let filled = 0;
  for (const survey of surveys.slice(0, MAX_SURVEYS)) {
    opts.onProgress?.(
      `Reading LiDAR roof heights${survey.year ? ` (${survey.year} survey)` : ''}…`
    );
    const load = async (collection, id) => {
      const url =
        `${DATA}/${box}/${cols}x${rows}.png?collection=${collection}` +
        `&item=${encodeURIComponent(id)}&assets=data&algorithm=terrarium`;
      try {
        const res = await fetchWithTimeout(url, opts.signal);
        if (!res.ok) return null;
        return await decodePng(await res.arrayBuffer());
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        return null;
      }
    };
    const [surfaceTiles, terrainTiles] = await Promise.all([
      Promise.all(survey.surface.slice(0, MAX_TILES_PER_SURVEY).map((id) => load(SURFACE, id))),
      Promise.all(survey.terrain.slice(0, MAX_TILES_PER_SURVEY).map((id) => load(TERRAIN, id))),
    ]);

    const surface = new Float32Array(cols * rows).fill(NaN);
    const terrain = new Float32Array(cols * rows).fill(NaN);
    for (const png of surfaceTiles) if (png) mergeTerrarium(surface, cols, rows, png);
    for (const png of terrainTiles) if (png) mergeTerrarium(terrain, cols, rows, png);
    fillTerrainGaps(terrain, cols, rows);

    let added = 0;
    for (let i = 0; i < surface.length; i++) {
      if (!Number.isNaN(grid.values[i])) continue;
      const h = surface[i] - terrain[i];
      if (Number.isNaN(h) || h > 900) continue;
      grid.values[i] = h < 0 ? 0 : h;
      added++;
    }
    if (added) used.push(survey);
    filled += added;
    if (filled >= cols * rows * 0.985) break;
  }

  grid.coverage = filled / (cols * rows);
  if (grid.coverage < 0.02) {
    cache.set(key, null);
    return null;
  }
  grid.source = {
    provider: 'USGS 3DEP LiDAR',
    survey: used[0]?.name || '',
    year: used[0]?.year || null,
    surveys: used.map((s) => s.name),
  };

  cache.set(key, grid);
  if (cache.size > 3) cache.delete(cache.keys().next().value);
  return grid;
}
