import * as overpass from '../js/data/overpass.js';
import * as G from '../js/core/geom.js';
import { createProjection } from '../js/core/projection.js';
import { decodePng } from '../js/data/png.js';
import { fetchRoofGrid, groupSurveys, mergeTerrarium, fillTerrainGaps, mayHaveLidar } from '../js/data/lidar.js';
import { makeRoofSampler, scanBuilding, regionalRoofStyle, fieldSampler } from '../js/model/roofscan.js';
import { buildModel } from '../js/model/build.js';
import { defaultSettings } from '../js/model/parts.js';
import { hasMeasuredHeight } from '../js/model/tags.js';
import { encodePng, terrariumPng, lidarGrid, outlineOf } from './fixture-lidar.mjs';

let failures = 0;
let total = 0;

function ok(label, condition, detail = '') {
  total++;
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
const near = (label, actual, expected, tol) =>
  ok(label, Math.abs(actual - expected) <= tol, `got ${Number(actual).toFixed(2)}, want ${expected} ±${tol}`);

function openEdges(part) {
  const ids = new Map();
  const id = (i) => {
    const p = part.positions;
    const key = `${p[i * 3].toFixed(3)},${p[i * 3 + 1].toFixed(3)},${p[i * 3 + 2].toFixed(3)}`;
    let v = ids.get(key);
    if (v === undefined) {
      v = ids.size;
      ids.set(key, v);
    }
    return v;
  };
  const edges = new Map();
  for (let t = 0; t < part.indices.length; t += 3) {
    const a = id(part.indices[t]);
    const b = id(part.indices[t + 1]);
    const c = id(part.indices[t + 2]);
    if (a === b || b === c || a === c) continue;
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const key = p < q ? `${p}|${q}` : `${q}|${p}`;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  }
  let open = 0;
  for (const n of edges.values()) if (n % 2) open++;
  return open;
}

console.log('PNG data tiles');
{
  const rgba = new Uint8Array(7 * 5 * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37 + (i >> 3) * 11) & 0xff;
  for (const filter of [0, 1, 2, 3, 4]) {
    const png = await decodePng(encodePng(7, 5, rgba, filter));
    const same = png.width === 7 && png.height === 5 && png.channels === 4 &&
      png.data.every((v, i) => v === rgba[i]);
    ok(`row filter ${filter} decodes byte for byte`, same);
  }
  let threw = false;
  try {
    await decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
  } catch {
    threw = true;
  }
  ok('something that is not a PNG is refused', threw);
}

console.log('\nTerrarium tiles');
{
  const cols = 4;
  const rows = 3;
  // South-first: row 0 is the southern edge.
  const heights = Float32Array.from([1, 2, 3, 4, 10.5, 20.25, NaN, 40, 100, 200, 300.125, -3]);
  const png = await decodePng(terrariumPng(heights, cols, rows, 4));
  const out = new Float32Array(cols * rows).fill(NaN);
  const filled = mergeTerrarium(out, cols, rows, png);
  ok('every valid cell is read', filled === 11, `${filled}`);
  ok('heights survive to 1/256 m', [...heights].every((h, i) =>
    Number.isNaN(h) ? Number.isNaN(out[i]) : Math.abs(out[i] - h) < 0.005));
  ok('transparent pixels stay empty', Number.isNaN(out[6]));
  const again = mergeTerrarium(out, cols, rows, png);
  ok('cells already filled are not overwritten', again === 0);
  ok('a tile of the wrong size is ignored', mergeTerrarium(out, 5, 3, png) === 0);

  const holed = Float32Array.from([
    10, 10, 10, 10, 10,
    10, NaN, NaN, NaN, 20,
    10, NaN, NaN, NaN, 20,
    10, 20, 20, 20, 20,
  ]);
  fillTerrainGaps(holed, 5, 4);
  ok('terrain holes under buildings are bridged', holed.every((v) => !Number.isNaN(v)));
  ok('…with values between the ground either side', holed[6] > 10 && holed[6] < 20 && holed[8] > holed[6]);
}

console.log('\nSurvey catalogue');
{
  const item = (id, when) => ({ id, properties: { end_datetime: when } });
  const surveys = groupSurveys([
    item('OLD_2012-dsm-2m-1-1', '2012-05-01T00:00:00Z'),
    item('OLD_2012-dtm-2m-1-1', '2012-05-01T00:00:00Z'),
    item('NEW_2020-dsm-2m-3-4', '2020-03-01T00:00:00Z'),
    item('NEW_2020-dsm-2m-3-5', '2020-03-01T00:00:00Z'),
    item('NEW_2020-dtm-2m-3-4', '2020-03-01T00:00:00Z'),
    item('HALF_2022-dsm-2m-1-1', '2022-03-01T00:00:00Z'),
    item('NEW_2020-hag-2m-3-4', '2020-03-01T00:00:00Z'),
  ]);
  ok('the newest complete survey comes first', surveys[0]?.name === 'NEW_2020' && surveys[0].year === 2020);
  ok('surface and terrain tiles are kept apart', surveys[0].surface.length === 2 && surveys[0].terrain.length === 1);
  ok('a survey with no terrain model is dropped', !surveys.some((s) => s.name === 'HALF_2022'));
  ok('older surveys follow', surveys[1]?.name === 'OLD_2012');
  ok('the US is in range', mayHaveLidar({ minLat: 40.7, maxLat: 40.8, minLon: -74, maxLon: -73.9 }));
  ok('Europe is not', !mayHaveLidar({ minLat: 52.3, maxLat: 52.4, minLon: 4.8, maxLon: 4.9 }));
}

console.log('\nLoading a roof grid');
{
  const realFetch = globalThis.fetch;
  const calls = [];
  // North half of the box stands 10 m above the ground, south half is bare.
  // The terrain model has a hole in the middle, as under a large building.
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/stac/')) {
      return new Response(JSON.stringify({
        features: [
          { id: 'TEST_2019-dsm-2m-1-1', properties: { '3dep:usgs_id': 'TEST_2019', end_datetime: '2019-06-01T00:00:00Z' } },
          { id: 'TEST_2019-dtm-2m-1-1', properties: { '3dep:usgs_id': 'TEST_2019', end_datetime: '2019-06-01T00:00:00Z' } },
        ],
      }));
    }
    const [, w, h] = u.match(/\/(\d+)x(\d+)\.png/);
    const cols = +w;
    const rows = +h;
    const values = new Float32Array(cols * rows);
    const surface = u.includes('3dep-lidar-dsm');
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const north = r >= rows / 2;
        const hole = Math.abs(r - rows / 2) < 6 && Math.abs(c - cols / 2) < 6;
        values[r * cols + c] = surface ? 150 + (north ? 10 : 0) : hole ? NaN : 150;
      }
    }
    return new Response(terrariumPng(values, cols, rows, 2));
  };

  const bbox = { minLat: 40.72, maxLat: 40.723, minLon: -73.515, maxLon: -73.511 };
  const grid = await fetchRoofGrid(bbox);
  ok('a grid comes back', Boolean(grid));
  ok('one catalogue search, one surface and one terrain tile', calls.length === 3 &&
    calls.filter((u) => u.includes('3dep-lidar-dsm')).length === 2 &&
    calls.filter((u) => u.includes('3dep-lidar-dtm')).length === 2, calls.join('\n'));
  ok('about a metre per cell', Math.abs(grid.cols - 337) < 12 && Math.abs(grid.rows - 333) < 12,
    `${grid.cols} × ${grid.rows}`);
  near('the south half reads as ground', grid.values[5 * grid.cols + 5], 0, 0.02);
  near('the north half reads 10 m up', grid.values[(grid.rows - 5) * grid.cols + 5], 10, 0.02);
  const mid = (Math.floor(grid.rows / 2) + 2) * grid.cols + Math.floor(grid.cols / 2);
  near('a roof over a terrain hole still gets its height', grid.values[mid], 10, 0.02);
  ok('fully covered', grid.coverage > 0.999, `${grid.coverage}`);
  ok('the survey is credited', grid.source.survey === 'TEST_2019' && grid.source.year === 2019);

  const before = calls.length;
  await fetchRoofGrid(bbox);
  ok('the same area is not fetched twice', calls.length === before);

  ok('nothing is requested outside the US',
    (await fetchRoofGrid({ minLat: 52.3, maxLat: 52.31, minLon: 4.8, maxLon: 4.81 })) === null &&
    calls.length === before);

  globalThis.fetch = async () => new Response(JSON.stringify({ features: [] }));
  ok('no survey means no grid, not an error',
    (await fetchRoofGrid({ minLat: 44.97, maxLat: 44.98, minLon: -93.27, maxLon: -93.26 })) === null);

  globalThis.fetch = async () => new Response('nope', { status: 503 });
  let failed = false;
  try {
    await fetchRoofGrid({ minLat: 41.0, maxLat: 41.01, minLon: -87.6, maxLon: -87.59 });
  } catch {
    failed = true;
  }
  ok('a catalogue outage is reported, so the app can fall back', failed);
  globalThis.fetch = realFetch;
}

// A small town on flat ground, in gable country.
const LAT = 40.72;
const LON = -73.51;
const THINGS = {
  gable: { x: -90, y: 80, halfLength: 7, halfWidth: 4, angle: 20, eave: 3, rise: 3, roof: 'gabled' },
  across: { x: -50, y: 80, halfLength: 5, halfWidth: 4.4, angle: 0, eave: 3, rise: 3.2, roof: 'gabled-across' },
  box: { x: -10, y: 80, halfLength: 6, halfWidth: 5, angle: 0, eave: 4.2, rise: 0, roof: 'flat' },
  oversized: { x: 30, y: 80, halfLength: 6, halfWidth: 4, angle: 0, eave: 3, rise: 2.6, roof: 'gabled' },
  shaded: { x: 75, y: 80, halfLength: 7, halfWidth: 4, angle: 0, eave: 3, rise: 3, roof: 'gabled' },
  tree: { x: 75, y: 87, halfLength: 3.5, halfWidth: 3.5, angle: 0, eave: 15, rise: 0, roof: 'flat' },
  podium: { x: -60, y: -20, halfLength: 30, halfWidth: 22, angle: 30, eave: 12, rise: 0, roof: 'flat' },
  tower: { x: -60, y: -20, halfLength: 11, halfWidth: 9, angle: 30, eave: 80, rise: 0, roof: 'flat' },
  warehouse: { x: 50, y: -30, halfLength: 28, halfWidth: 16, angle: 0, eave: 9, rise: 0, roof: 'flat' },
  vacant: { x: 60, y: 20, halfLength: 8, halfWidth: 6, angle: 0, eave: 0, rise: 0, roof: 'flat' },
};
const scene = { lat: LAT, lon: LON, halfMetres: 150 };
const grid = lidarGrid(
  Object.entries(THINGS).filter(([name]) => name !== 'vacant').map(([, t]) => t),
  scene
);

const K = 0.5; // plate millimetres per metre
const proj = createProjection(LAT, LON);
const sample = makeRoofSampler(grid, proj, K);
const ringOf = (el) => G.closeRing(el.geometry.map((p) => {
  const [x, y] = proj.forward(p.lat, p.lon);
  return [x * K, y * K];
}));
const scanOf = (thing, opts = {}) => scanBuilding([ringOf(outlineOf(thing, { ...scene, ...opts }))], sample, K);

console.log('\nReading the survey');
{
  const [x, y] = [THINGS.box.x * K, THINGS.box.y * K];
  near('a roof reads its height', sample(x, y), 4.2, 0.05);
  near('open ground reads zero', sample(0, 0), 0, 0.01);
  ok('off the grid reads as unknown', Number.isNaN(sample(900, 900)));
}

console.log('\nMeasuring houses');
{
  // The outline sits 2.5 m east and 1.5 m south of the real house.
  const s = scanOf(THINGS.gable, { shift: [2.5, -1.5] });
  ok('a gabled house is pitched', s?.kind === 'pitched', s?.kind);
  near('…with its ridge height', s.heightM, 6, 0.6);
  ok('…ridge along the long side', s.orientation === 'along');
  ok('…and a believable pitch', s.riseM >= 1 && s.riseM <= 3.6, `${s.riseM?.toFixed(2)} m`);
  ok('the misplaced outline is moved', Boolean(s.snap) && Math.hypot(s.snap.dx, s.snap.dy) > 0.8 * K,
    JSON.stringify(s.snap && [s.snap.dx / K, s.snap.dy / K]));
  near('…onto the house, east–west', s.frame.cx / K, THINGS.gable.x, 1);
  near('…and north–south', s.frame.cy / K, THINGS.gable.y, 1);

  const a = scanOf(THINGS.across);
  ok('a ridge across the short side is seen', a?.kind === 'pitched' && a.orientation === 'across',
    `${a?.kind} ${a?.orientation}`);

  const b = scanOf(THINGS.box);
  ok('a level roof is flat', b?.kind === 'flat', b?.kind);
  near('…at its measured height', b.heightM, 4.2, 0.3);
  ok('…and stays put', !b.snap, JSON.stringify(b.snap));

  // Outline 3 m too big all round.
  const o = scanOf(THINGS.oversized, { grow: 3 });
  ok('an oversized outline is trimmed to the roof', Boolean(o?.snap?.clip));
  near('…to about the real length', o.frame.halfLength / K, 6, 1.6);
  near('…and the real width', o.frame.halfWidth / K, 4, 1.6);

  const t = scanOf(THINGS.shaded);
  near('a tree over the roof does not raise the house', t.heightM, 6, 1.2);

  ok('a vacant lot is reported as absent', scanOf(THINGS.vacant)?.kind === 'absent');
  ok('a shed-sized outline is left to the map', scanOf({ ...THINGS.box, halfLength: 1.5, halfWidth: 1.5 }) === null);
  ok('no survey, no measurement', scanBuilding([ringOf(outlineOf(THINGS.box, scene))], null, K) === null);
}

console.log('\nMeasuring large buildings');
{
  const w = scanOf(THINGS.warehouse);
  ok('a warehouse is flat', w?.kind === 'flat', w?.kind);
  near('…at its measured height', w.heightM, 9, 0.4);
  ok('…and is never moved', !w.snap);

  const p = scanOf(THINGS.podium);
  ok('a tower on a podium keeps its measured surface', p?.kind === 'surface', p?.kind);
  near('…topping out at the tower', p.heightM, 80, 2);
  const at = fieldSampler(p.field);
  near('the tower reads tall', at(THINGS.tower.x * K, THINGS.tower.y * K), 80, 1);
  const a = (30 * Math.PI) / 180;
  const far = [THINGS.podium.x + 24 * Math.cos(a), THINGS.podium.y + 24 * Math.sin(a)];
  near('the podium reads low', at(far[0] * K, far[1] * K), 12, 1);
  const edge = [THINGS.podium.x + 29.4 * Math.cos(a), THINGS.podium.y + 29.4 * Math.sin(a)];
  near('walls stand square: the smeared edge is restored', at(edge[0] * K, edge[1] * K), 12, 1.2);
}

console.log('\nRoof style by region');
{
  ok('Long Island builds gables', regionalRoofStyle(40.72, -73.51) === 'gabled');
  ok('Dallas builds hips', regionalRoofStyle(32.78, -96.8) === 'hipped');
  ok('Phoenix builds hips', regionalRoofStyle(33.45, -112.07) === 'hipped');
  ok('Miami builds hips', regionalRoofStyle(25.79, -80.13) === 'hipped');
  ok('Chicago builds gables', regionalRoofStyle(41.88, -87.62) === 'gabled');
  ok('Seattle builds gables', regionalRoofStyle(47.6, -122.33) === 'gabled');
  ok('a mapped height counts as measured', hasMeasuredHeight({ height: '30' }) &&
    hasMeasuredHeight({ 'building:levels': '4' }) && !hasMeasuredHeight({ building: 'yes' }));
}

console.log('\nIn the model');
{
  const elements = [
    outlineOf(THINGS.gable, { ...scene, id: 1, shift: [2.5, -1.5] }),
    outlineOf(THINGS.across, { ...scene, id: 2 }),
    outlineOf(THINGS.box, { ...scene, id: 3 }),
    outlineOf(THINGS.oversized, { ...scene, id: 4, grow: 3 }),
    outlineOf(THINGS.shaded, { ...scene, id: 5 }),
    outlineOf(THINGS.podium, { ...scene, id: 6 }),
    outlineOf(THINGS.warehouse, { ...scene, id: 7 }),
    outlineOf(THINGS.vacant, { ...scene, id: 8 }),
  ];
  const features = overpass.parseElements(elements);
  const settings = defaultSettings();
  settings.location = { lat: LAT, lon: LON, label: 'Test town' };
  settings.size.areaMetres = 300;
  settings.size.printMm = 150;
  settings.shape.type = 'square';

  const plain = buildModel(features, settings, {});
  const real = buildModel(features, settings, { roofGrid: grid });

  ok('without a survey every building is a guess', plain.stats.roofs === null);
  near('…and the town is a uniform 9 m', plain.stats.heightMm, 2 + 9 * K, 0.6);
  near('with one, the tower stands at its real height', real.stats.heightMm, 2 + 80 * K, 1.5);

  const r = real.stats.roofs;
  ok('seven buildings measured, one absent', r.measured === 7 && r.absent === 1, JSON.stringify(r));
  ok('houses get gables here', r.shapes.gabled === 4, JSON.stringify(r.shapes));
  ok('level roofs stay flat', r.shapes.flat === 2, JSON.stringify(r.shapes));
  ok('the tower is built from the measured roof', r.shapes.surface === 1);
  ok('outlines were moved or trimmed', r.moved >= 2, `${r.moved}`);
  ok('the survey is credited', r.source?.year === 2020);

  for (const part of real.parts) {
    ok(`${part.id}: watertight`, openEdges(part) === 0, `${openEdges(part)} open edges`);
  }
  const roofs = real.parts.find((p) => p.id === 'roofs');
  ok('pitched roofs are their own part', roofs && roofs.triangleCount > 20);
  ok('terracing keeps the tower cheap', real.stats.triangles < 6000, `${real.stats.triangles} triangles`);

  // Podium and tower as two level roofs: almost all the top surface of the
  // tower block sits at one of the two measured heights.
  const b = real.parts.find((p) => p.id === 'buildings');
  const tops = new Map();
  for (let i = 2; i < b.positions.length; i += 3) {
    const z = Math.round(b.positions[i] * 10) / 10;
    tops.set(z, (tops.get(z) || 0) + 1);
  }
  const has = (mm) => [...tops.keys()].some((z) => Math.abs(z - mm) < 0.6);
  ok('the podium is a level roof at 12 m', has(2 + 12 * K), [...tops.keys()].sort((x, y) => x - y).join(' '));
  ok('the tower is a level roof at 80 m', has(2 + 80 * K));

  settings.print.roofStyle = 'hipped';
  const hipped = buildModel(features, settings, { roofGrid: grid });
  ok('choosing hipped changes the houses', hipped.stats.roofs.shapes.hipped === 4 && !hipped.stats.roofs.shapes.gabled,
    JSON.stringify(hipped.stats.roofs.shapes));
  const volume = (m) => m.parts.find((p) => p.id === 'roofs').volumeMm3;
  ok('…and a hip holds less than a gable', volume(hipped) < volume(real) * 0.95,
    `${volume(hipped).toFixed(1)} vs ${volume(real).toFixed(1)} mm³`);
  ok('hipped roofs are watertight too', openEdges(hipped.parts.find((p) => p.id === 'roofs')) === 0);
  settings.print.roofStyle = 'auto';

  // A height someone surveyed by hand beats the LiDAR.
  const tagged = overpass.parseElements([
    outlineOf(THINGS.warehouse, { ...scene, id: 9, tags: { building: 'yes', height: '20' } }),
  ]);
  const kept = buildModel(tagged, settings, { roofGrid: grid });
  near('a mapped height wins over the survey', kept.stats.heightMm, 2 + 20 * K, 0.3);

  settings.layers.roofs = false;
  const bare = buildModel(features, settings, { roofGrid: grid });
  ok('with roofs switched off houses are flat-topped at their measured height',
    !bare.parts.some((p) => p.id === 'roofs') && bare.stats.roofs.measured === 7);
}

console.log(`\n${failures ? '✗' : '✓'} ${total - failures}/${total} checks passed`);
process.exit(failures ? 1 : 0);
