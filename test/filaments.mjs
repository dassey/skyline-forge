import * as overpass from '../js/data/overpass.js';
import { buildModel } from '../js/model/build.js';
import { defaultSettings, PARTS } from '../js/model/parts.js';
import {
  PRINTERS, printerById, planFilaments, sanitizePlan, compactPlan, deltaE, colorName,
  filamentUsage, estimateChanges, bedFit, fitPrintSize, MAX_FILAMENTS,
} from '../js/model/filaments.js';
import { buildExport } from '../js/export/index.js';
import { unzip } from '../js/data/import/unzip.js';
import { syntheticCity } from './fixture-city.mjs';

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

const ALL = PARTS.map((p) => p.id);
const CLASSIC = Object.fromEntries(PARTS.map((p) => [p.id, p.color]));
const ON_PLATE = ['route', 'buildings', 'roofs', 'rail', 'roadsMajor', 'roads', 'water', 'green', 'ground', 'frame', 'label'];

console.log('Colour');
ok('identical colours are 0 apart', deltaE('#3e8fc1', '#3E8FC1') < 1e-9);
ok('black and white are far apart', deltaE('#000000', '#ffffff') > 95);
ok('white is named White', colorName('#fdfdfd') === 'White');
ok('the classic water is a blue', /blue/i.test(colorName('#3e8fc1')), colorName('#3e8fc1'));
ok('the classic parks are a green', /green|sage/i.test(colorName('#6ba368')), colorName('#6ba368'));

console.log('\nPlanning');
for (let n = 1; n <= MAX_FILAMENTS; n++) {
  const plan = planFilaments({ colors: CLASSIC, active: ON_PLATE, count: n });
  const valid = ALL.every((id) => Number.isInteger(plan.assign[id]) && plan.assign[id] < plan.slots.length);
  if (!valid || plan.slots.length > n) {
    ok(`${n} filament plan is valid`, false, JSON.stringify(plan));
  }
}
ok('every count gives a valid plan with at most that many spools', true);

const one = planFilaments({ colors: CLASSIC, active: ON_PLATE, count: 1 });
ok('one filament puts everything on spool 1', one.slots.length === 1 && ALL.every((id) => one.assign[id] === 0));

const many = planFilaments({ colors: CLASSIC, active: ON_PLATE, count: 12 });
ok('enough spools keeps every distinct colour', many.slots.length === ON_PLATE.length);

const twin = planFilaments({
  colors: { ...CLASSIC, label: CLASSIC.buildings }, active: ON_PLATE, count: 12,
});
ok('two layers of the same colour share a spool', twin.assign.label === twin.assign.buildings);

const four = planFilaments({ colors: CLASSIC, active: ON_PLATE, count: 4 });
ok('four spools gives four filaments', four.slots.length === 4);
ok('the route never shares a spool with the streets', four.assign.route !== four.assign.roads);
ok('the route never shares a spool with the ground', four.assign.route !== four.assign.ground);
ok('main roads fall back to the street spool, not the parks',
  four.assign.roadsMajor === four.assign.roads, JSON.stringify(four.assign));
ok('the heaviest layer is filament 1', four.assign.ground === 0);
for (let n = 2; n <= 8; n++) {
  const plan = planFilaments({ colors: CLASSIC, active: ON_PLATE, count: n });
  if (plan.assign.route === plan.assign.roads) ok(`route stands out with ${n} spools`, false);
}
ok('with two or more spools the route always stands out', true);

const noWater = planFilaments({ colors: CLASSIC, active: ON_PLATE.filter((id) => id !== 'water'), count: 5 });
ok('a layer missing from the plate does not take a spool',
  !noWater.slots.includes(CLASSIC.water), noWater.slots.join(' '));
ok('…but is still given the nearest spool', Number.isInteger(noWater.assign.water));

const again = planFilaments({ colors: CLASSIC, active: ON_PLATE, count: 4 });
ok('planning is deterministic', JSON.stringify(again) === JSON.stringify(four));

const broken = sanitizePlan({ slots: ['#fff', 'nonsense'], assign: { buildings: 7, roads: 1 } });
ok('a damaged plan is repaired', broken.slots[0] === '#ffffff' && broken.slots[1] === '#cccccc' &&
  broken.assign.buildings === 0 && broken.assign.roads === 1);

const gappy = compactPlan({ slots: ['#111111', '#222222', '#333333'], assign: Object.fromEntries(ALL.map((id) => [id, 2])) });
ok('unused spools are dropped and renumbered', gappy.slots.length === 1 && gappy.slots[0] === '#333333' &&
  ALL.every((id) => gappy.assign[id] === 0));

console.log('\nPrinters');
ok('the H2C is offered with seven zero-purge colours', printerById('bambu-h2c').filaments === 7);
ok('an unknown printer falls back to a common one', printerById('nope').id === 'bambu-x1');
ok('every printer has a plate centre inside its bed', PRINTERS.every((p) =>
  p.centre[0] > 0 && p.centre[1] > 0 && p.centre[0] < p.bed[0] + 60 && p.centre[1] <= p.bed[1]));
const mini = printerById('bambu-a1mini');
ok('160 mm fits an A1 mini', bedFit(160, 160, mini).fits);
ok('200 mm does not fit an A1 mini', !bedFit(200, 160, mini).fits);
const shrunk = fitPrintSize({ printMm: 240, widthMm: 248, depthMm: 263, fixedDepthMm: 15 }, mini);
const newW = 248 * (shrunk / 240);
const newD = (263 - 15) * (shrunk / 240) + 15;
ok('shrink-to-fit lands on the plate even with a fixed nameplate bar',
  bedFit(newW, newD, mini).fits && shrunk > 150, `${shrunk} mm → ${newW.toFixed(0)} × ${newD.toFixed(0)}`);
ok('a long print fits turned through 90°', bedFit(140, 240, printerById('bambu-h2c')).fits);

console.log('\nOn a real build');
const settings = defaultSettings();
settings.location = { lat: 40.7549, lon: -73.984, label: 'Synthetic' };
settings.size.areaMetres = 1200;
settings.nameplate.title = 'SYNTHETIC';
const features = overpass.parseElements(syntheticCity({ lat: 40.7549, lon: -73.984 }).elements);
const model = buildModel(features, settings, { font: null });
ok('the synthetic city builds', model.parts.length >= 5, model.parts.map((p) => p.id).join(', '));
ok('every part reports its height range', model.parts.every((p) =>
  Number.isFinite(p.zMin) && Number.isFinite(p.zMax) && p.zMax > p.zMin));
ok('flat parts report their footprint', model.parts.filter((p) => p.id !== 'roofs' && p.id !== 'trees')
  .every((p) => p.footprintMm2 > 0));

const present = model.parts.map((p) => p.id);
const plan12 = planFilaments({ colors: settings.colors, active: present, count: 12 });
const plan3 = planFilaments({ colors: settings.colors, active: present, count: 3 });
const plan1 = planFilaments({ colors: settings.colors, active: present, count: 1 });
const changes12 = estimateChanges(model.parts, plan12);
const changes3 = estimateChanges(model.parts, plan3);
ok('fewer spools means fewer filament changes', changes3 < changes12, `${changes3} vs ${changes12}`);
ok('one spool means no filament changes', estimateChanges(model.parts, plan1) === 0);

const usage = filamentUsage(model.parts, plan3);
const grams = usage.reduce((a, u) => a + u.grams, 0);
ok('every spool is used', usage.every((u) => u.grams > 0 && u.parts.length > 0));
ok('the filament estimate is plausible', grams > 20 && grams < 400, `${grams.toFixed(0)} g`);

console.log('\nPrint-ready 3MF');
const stamped = model.parts.map((p) => ({
  ...p, color: plan3.slots[plan3.assign[p.id]], filament: plan3.assign[p.id],
}));
const h2c = printerById('bambu-h2c');
const { blob, filename } = buildExport('3mf', stamped, {
  title: 'Synthetic & Co', plateCentre: h2c.centre,
});
ok('the file is named after the title', filename === 'synthetic-co.3mf', filename);
const files = await unzip(await blob.arrayBuffer());
const text = (name) => new TextDecoder().decode(files.get(name));
ok('it carries Bambu/Orca part settings', files.has('Metadata/model_settings.config'));
const cfg = text('Metadata/model_settings.config');
const xml = text('3D/3dmodel.model');

const partIds = [...cfg.matchAll(/<part id="(\d+)"/g)].map((m) => m[1]);
const objectIds = [...xml.matchAll(/<object id="(\d+)"[^>]*pid="1"/g)].map((m) => m[1]);
ok('one part entry per mesh object', partIds.join() === objectIds.join(), `${partIds} vs ${objectIds}`);
const extruders = [...cfg.matchAll(/<part[^>]*>\s*<metadata key="name" value="([^"]*)"\/>\s*<metadata key="extruder" value="(\d+)"/g)]
  .map((m) => [m[1], Number(m[2])]);
ok('each part is on its planned filament', extruders.length === stamped.length &&
  extruders.every(([name, e], i) => name === stamped[i].label && e === stamped[i].filament + 1),
JSON.stringify(extruders));
ok('the title is escaped', cfg.includes('Synthetic &amp; Co'));
const assembly = xml.match(/<item objectid="(\d+)" transform="([^"]+)"/);
ok('the model is moved onto the plate', Boolean(assembly));
if (assembly) {
  const t = assembly[2].split(' ').map(Number);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of stamped) {
    for (let i = 0; i < p.positions.length; i += 3) {
      minX = Math.min(minX, p.positions[i]); maxX = Math.max(maxX, p.positions[i]);
      minY = Math.min(minY, p.positions[i + 1]); maxY = Math.max(maxY, p.positions[i + 1]);
    }
  }
  ok('…centred on the H2C plate',
    Math.abs((minX + maxX) / 2 + t[9] - 175) < 0.01 && Math.abs((minY + maxY) / 2 + t[10] - 160) < 0.01,
    assembly[2]);
  ok('the object id matches the config', cfg.includes(`<object id="${assembly[1]}">`));
}
ok('display colours follow the filaments', stamped.every((p) =>
  xml.includes(`name="${p.label}" displaycolor="${p.color.toUpperCase()}FF"`)));

const bundle = await unzip(await buildExport('stl-parts', stamped, {
  title: 'Synthetic', filamentNames: plan3.slots.map(colorName),
}).blob.arrayBuffer());
const names = [...bundle.keys()].filter((n) => n.endsWith('.stl'));
ok('per-layer STLs are named by filament', names.every((n) => /^filament-\d+-/.test(n)), names.join(' '));
const order = names.map((n) => Number(n.split('-')[1]));
ok('…and grouped by filament', order.every((v, i) => i === 0 || v >= order[i - 1]), names.join(' '));
const readme = new TextDecoder().decode(bundle.get('README.txt'));
ok('the README lists what to load', /Filament 1 {2}#[0-9a-f]{6} {2}\w/.test(readme));

console.log(`\n${failures ? '✗' : '✓'} ${total - failures}/${total} checks passed`);
process.exit(failures ? 1 : 0);
