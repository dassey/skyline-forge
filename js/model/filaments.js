import { PARTS } from './parts.js';

// Printers decide two things: how many spools a plan should aim for, and
// where the plate centre is so a 3MF lands in the middle of the bed.
// Bed sizes are the area every nozzle can reach, from the slicer profiles.
export const PRINTERS = [
  {
    id: 'bambu-h2c', label: 'Bambu Lab H2C', bed: [300, 320], centre: [175, 160], filaments: 7,
    note: 'Seven hotends: up to 7 colours swap nozzles instead of purging.',
  },
  {
    id: 'bambu-h2d', label: 'Bambu Lab H2D', bed: [300, 320], centre: [175, 160], filaments: 4,
    note: 'Two nozzles fed from AMS — 4 colours per AMS unit.',
  },
  {
    id: 'bambu-x1', label: 'Bambu Lab X1 / P1 / P2S', bed: [256, 256], centre: [128, 128], filaments: 4,
    note: 'One AMS holds 4 spools.',
  },
  {
    id: 'bambu-a1', label: 'Bambu Lab A1', bed: [256, 256], centre: [128, 128], filaments: 4,
    note: 'AMS lite holds 4 spools.',
  },
  {
    id: 'bambu-a1mini', label: 'Bambu Lab A1 mini', bed: [180, 180], centre: [90, 90], filaments: 4,
    note: 'AMS lite holds 4 spools. The plate is small — keep the print under 170 mm.',
  },
  {
    id: 'prusa-mmu3', label: 'Prusa MK4S / CORE One + MMU3', bed: [250, 210], centre: [125, 105], filaments: 5,
    note: 'MMU3 holds 5 spools. PrusaSlicer needs filaments assigned by hand.',
  },
  {
    id: 'prusa-xl', label: 'Prusa XL, five toolheads', bed: [360, 360], centre: [180, 180], filaments: 5,
    note: 'Five toolheads. PrusaSlicer needs filaments assigned by hand.',
  },
  {
    id: 'single', label: 'Single-colour printer', bed: [220, 220], centre: [110, 110], filaments: 1,
    note: 'One colour — the shape does the talking.',
  },
];

export const MAX_FILAMENTS = PARTS.length;
export const LAYER_HEIGHT_MM = 0.2;
const PLA_DENSITY = 1.24;

export function printerById(id) {
  return PRINTERS.find((p) => p.id === id) || PRINTERS[2];
}

// How much each layer matters to the look of the print. Heavy layers keep
// their colour when spools run short; light ones borrow a neighbour's.
const WEIGHT = {
  ground: 10, route: 9, buildings: 8, water: 7, green: 5, roads: 5,
  frame: 4, roadsMajor: 3, label: 3, roofs: 2, rail: 1.5, trees: 1.5,
};

// Pairs that sit side by side at similar heights. Sharing a filament would
// leave them distinguishable only by relief, so merging them multiplies the
// cost. It scales the colour difference rather than adding to it, so a
// palette that deliberately makes two of them alike can still merge them.
const KEEP_APART = {
  'route|roads': 3, 'route|roadsMajor': 3, 'route|ground': 3,
  'route|green': 2, 'route|buildings': 2, 'route|water': 1.5,
  'label|frame': 2, 'label|ground': 2,
  'water|ground': 1.2, 'green|ground': 0.8, 'water|green': 0.5,
  'buildings|ground': 3,
};

// Pairs that belong together, so a spare spool goes elsewhere first: main
// roads fall back to the street colour, not the park colour.
const AFFINITY = {
  'roadsMajor|roads': 0.6, 'trees|green': 0.6, 'rail|roads': 0.5,
  'roofs|buildings': 0.4, 'label|buildings': 0.3, 'frame|roads': 0.2,
};

function together(a, b) {
  return AFFINITY[`${a}|${b}`] ?? AFFINITY[`${b}|${a}`] ?? 0;
}

function apart(a, b, live) {
  // The lettering sits on a frame-coloured plaque when there is a frame,
  // and on the ground colour when there is not.
  if (live.has('frame') && ((a === 'label' && b === 'ground') || (a === 'ground' && b === 'label'))) {
    return 0;
  }
  return KEEP_APART[`${a}|${b}`] ?? KEEP_APART[`${b}|${a}`] ?? 0;
}

export function normalizeHex(hex, fallback = '#cccccc') {
  const m = String(hex || '').trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return fallback;
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return `#${h.toLowerCase()}`;
}

function toLab(hex) {
  const h = normalizeHex(hex).slice(1);
  const lin = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const [r, g, b] = lin;
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

export function deltaE(a, b) {
  const p = toLab(a);
  const q = toLab(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

export function isLight(hex) {
  return toLab(hex)[0] > 62;
}

const NAMED = [
  ['White', '#f6f6f3'], ['Ivory', '#efe6d0'], ['Beige', '#d6cab0'], ['Light grey', '#c3c6ca'],
  ['Grey', '#8d9197'], ['Slate', '#626d7a'], ['Charcoal', '#343a42'], ['Black', '#161616'],
  ['Red', '#d33b30'], ['Terracotta', '#b5583c'], ['Orange', '#e8862a'], ['Yellow', '#f2d03b'],
  ['Gold', '#c9a24a'], ['Brown', '#7a5a43'], ['Tan', '#b08c6a'], ['Green', '#4f9a48'],
  ['Sage', '#8fae86'], ['Dark green', '#2c5530'], ['Teal', '#2f8f8a'], ['Light blue', '#8cc4e8'],
  ['Blue', '#3a7fc0'], ['Navy', '#1b3352'], ['Purple', '#7a4fa0'], ['Pink', '#e58fb0'],
];

export function colorName(hex) {
  let best = NAMED[0][0];
  let bestD = Infinity;
  for (const [name, ref] of NAMED) {
    const d = deltaE(hex, ref);
    if (d < bestD) {
      bestD = d;
      best = name;
    }
  }
  return best;
}

// Group the layers onto `count` filaments. Starts with one cluster per
// distinct colour among the layers actually on the plate, then repeatedly
// merges the cheapest pair: similar colours and unimportant layers merge
// first, neighbours that need contrast merge last. A merged cluster keeps
// the colour of its heavier half, because filament comes in real spools,
// not averages. Layers that are not on the plate join the nearest spool.
export function planFilaments({ colors, active, count }) {
  const intent = (id) => normalizeHex(colors?.[id] || PARTS.find((p) => p.id === id)?.color);
  const ids = PARTS.map((p) => p.id);
  const live = ids.filter((id) => active.includes(id));
  const liveSet = new Set(live);
  const target = Math.max(1, Math.min(MAX_FILAMENTS, Math.round(count) || 1));

  let clusters = [];
  for (const id of live) {
    const color = intent(id);
    const same = clusters.find((c) => c.color === color);
    if (same) {
      same.members.push(id);
      same.weight += WEIGHT[id] || 1;
    } else {
      clusters.push({ color, members: [id], weight: WEIGHT[id] || 1 });
    }
  }
  if (!clusters.length) {
    clusters.push({ color: intent('ground'), members: [], weight: 1 });
  }

  while (clusters.length > target) {
    let best = null;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const a = clusters[i];
        const b = clusters[j];
        let penalty = 0;
        let affinity = 0;
        for (const m of a.members) {
          for (const n of b.members) {
            penalty = Math.max(penalty, apart(m, n, liveSet));
            affinity = Math.max(affinity, together(m, n));
          }
        }
        // Colours closer than ~5 ΔE look the same once printed, so merging
        // them is close to free, and the contrast penalty only bites once
        // the difference is plainly visible.
        const d = deltaE(a.color, b.color);
        const visible = Math.min(1, Math.max(0, (d - 5) / 10));
        const cost = (Math.max(0, d - 5) + d * 0.02) * (1 + penalty * visible) * (1 - affinity) *
          Math.sqrt(Math.min(a.weight, b.weight));
        if (!best || cost < best.cost) best = { cost, i, j };
      }
    }
    const a = clusters[best.i];
    const b = clusters[best.j];
    const merged = {
      color: a.weight >= b.weight ? a.color : b.color,
      members: [...a.members, ...b.members],
      weight: a.weight + b.weight,
    };
    clusters = clusters.filter((_, k) => k !== best.i && k !== best.j);
    clusters.push(merged);
  }

  clusters.sort((a, b) => b.weight - a.weight);
  const slots = clusters.map((c) => c.color);
  const assign = {};
  clusters.forEach((c, slot) => {
    for (const id of c.members) assign[id] = slot;
  });
  for (const id of ids) {
    if (id in assign) continue;
    let slot = 0;
    let bestD = Infinity;
    slots.forEach((color, k) => {
      const d = deltaE(intent(id), color);
      if (d < bestD) {
        bestD = d;
        slot = k;
      }
    });
    assign[id] = slot;
  }
  return { slots, assign };
}

// Keep a plan internally consistent after edits: every part on a slot that
// exists, and no slot past the end.
export function sanitizePlan(plan) {
  const slots = (Array.isArray(plan?.slots) && plan.slots.length ? plan.slots : ['#d8d2c2'])
    .slice(0, MAX_FILAMENTS)
    .map((c) => normalizeHex(c));
  const assign = {};
  for (const p of PARTS) {
    const raw = Number(plan?.assign?.[p.id]);
    assign[p.id] = Number.isInteger(raw) && raw >= 0 && raw < slots.length ? raw : 0;
  }
  return { slots, assign };
}

// Drop slots no part uses and renumber, so the slicer sees filaments 1..n
// with no gaps.
export function compactPlan(plan, onlyParts = null) {
  const used = [];
  for (const p of PARTS) {
    if (onlyParts && !onlyParts.includes(p.id)) continue;
    const s = plan.assign[p.id];
    if (!used.includes(s)) used.push(s);
  }
  used.sort((a, b) => a - b);
  const remap = new Map(used.map((s, i) => [s, i]));
  const assign = {};
  for (const p of PARTS) {
    assign[p.id] = remap.has(plan.assign[p.id]) ? remap.get(plan.assign[p.id]) : 0;
  }
  return { slots: used.map((s) => plan.slots[s]), assign };
}

// Rough per-part fill: thin plates are almost all solid top and bottom
// skin; tall parts are walls around sparse infill.
function fillFraction(part) {
  const area = part.footprintMm2;
  if (!area) return 0.6;
  const thickness = part.volumeMm3 / area;
  return thickness <= 3 ? 0.9 : 0.6;
}

export function gramsOf(part) {
  return (part.volumeMm3 / 1000) * PLA_DENSITY * fillFraction(part);
}

export function filamentUsage(parts, plan) {
  const usage = plan.slots.map((color, slot) => ({ slot, color, grams: 0, parts: [] }));
  for (const part of parts) {
    const u = usage[plan.assign[part.id]];
    if (!u) continue;
    u.grams += gramsOf(part);
    u.parts.push(part);
  }
  return usage;
}

// A slicer prints every filament present on a layer once, starting with the
// one the previous layer ended on, so each layer costs (filaments − 1)
// changes. Parts are treated as present from their lowest to highest point.
export function estimateChanges(parts, plan, layerHeight = LAYER_HEIGHT_MM) {
  if (!parts.length) return 0;
  const spans = parts
    .filter((p) => Number.isFinite(p.zMin) && Number.isFinite(p.zMax) && p.zMax > p.zMin)
    .map((p) => ({ lo: p.zMin, hi: p.zMax, slot: plan.assign[p.id] }));
  const top = Math.max(0, ...spans.map((s) => s.hi));
  let changes = 0;
  for (let z = layerHeight / 2; z < top; z += layerHeight) {
    const present = new Set();
    for (const s of spans) if (z >= s.lo && z < s.hi) present.add(s.slot);
    if (present.size > 1) changes += present.size - 1;
  }
  return changes;
}

const BED_MARGIN_MM = 4;

export function bedFit(widthMm, depthMm, printer) {
  const [W, D] = printer.bed;
  const w = widthMm + BED_MARGIN_MM;
  const d = depthMm + BED_MARGIN_MM;
  const straight = w <= W && d <= D;
  const turned = d <= W && w <= D;
  return { fits: straight || turned, turned: !straight && turned };
}

// The largest printed size that fits the plate. The map scales with the
// printed size but the nameplate bar does not, so depth is modelled as
// slope × size + bar, and both orientations are tried.
export function fitPrintSize({ printMm, widthMm, depthMm, fixedDepthMm = 0 }, printer) {
  const [W, D] = printer.bed;
  const a = widthMm / printMm;
  const b = Math.max(1e-6, (depthMm - fixedDepthMm) / printMm);
  const room = (span) => span - BED_MARGIN_MM - 1;
  const straight = Math.min(room(W) / a, (room(D) - fixedDepthMm) / b);
  const turned = Math.min(room(D) / a, (room(W) - fixedDepthMm) / b);
  return Math.floor(Math.max(straight, turned));
}

// After a hand edit: drop spools no layer on the plate uses, and move any
// off-plate layer that sat on one to the nearest remaining spool, so the
// numbers shown always match the numbers in the exported file.
export function tidyPlan(plan, active, colors) {
  const keep = plan.slots.map((_, s) => active.some((id) => plan.assign[id] === s));
  if (!keep.some(Boolean)) keep[0] = true;
  const remap = new Map();
  keep.forEach((k, s) => {
    if (k) remap.set(s, remap.size);
  });
  const slots = plan.slots.filter((_, s) => keep[s]);
  const assign = {};
  for (const p of PARTS) {
    const s = plan.assign[p.id];
    if (remap.has(s)) {
      assign[p.id] = remap.get(s);
      continue;
    }
    const want = normalizeHex(colors?.[p.id] || p.color);
    let best = 0;
    slots.forEach((c, k) => {
      if (deltaE(want, c) < deltaE(want, slots[best])) best = k;
    });
    assign[p.id] = best;
  }
  return { slots, assign };
}
