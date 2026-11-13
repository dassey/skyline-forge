import { orientedBounds, pointInRing, ringArea } from '../core/geom.js';

// Reads the LiDAR height-above-ground grid inside one building footprint and
// works out what actually stands there.
//
// What a 2 m survey can and cannot say about a house was settled by looking
// at real neighbourhoods. It measures the ridge height well, shows where the
// house really is (outlines traced from imagery are often metres off), tells
// a flat roof from a pitched one, and shows which way the ridge runs. It
// cannot tell a gable from a hip: the two differ only at the ends of the
// ridge, and every edge in the data is smeared over 2–3 m, which is most of
// a house's half-width. So the survey sets the size, place, height and
// direction of a clean roof, and the gable-or-hip style is left to the
// caller, who knows the region.
//
// Large buildings are different: they are many cells across, so they keep
// the measured surface itself, which is what gives a tower its setbacks.

const ROOF_MIN_M = 2;         // anything lower is ground, a car or a hedge
const MIN_AREA_M2 = 14;       // smaller than this is a few LiDAR cells at best
const SMALL_AREA_M2 = 650;    // up to here a single roof shape is plausible
const SMALL_HEIGHT_M = 16;
const MAX_CELLS = 36000;
const BLUR_M = 2.5;           // how far a wall is smeared in the 2 m rasters
const REACH_M = 3.5;          // how far a house may sit from its outline

// Bilinear lookup into the lat/lon grid from plate millimetres. The local
// projection is linear in latitude and longitude, so the mapping is affine.
export function makeRoofSampler(grid, projection, mmPerMetre) {
  if (!grid) return null;
  const { cols, rows, bbox, values } = grid;
  const [x0, y0] = projection.forward(bbox.minLat, bbox.minLon);
  const [x1, y1] = projection.forward(bbox.maxLat, bbox.maxLon);
  const originX = x0 * mmPerMetre;
  const originY = y0 * mmPerMetre;
  const perMmX = cols / ((x1 - x0) * mmPerMetre);
  const perMmY = rows / ((y1 - y0) * mmPerMetre);

  return function sample(x, y) {
    const u = (x - originX) * perMmX - 0.5;
    const v = (y - originY) * perMmY - 0.5;
    if (u < -1 || v < -1 || u > cols || v > rows) return NaN;
    const c0 = Math.max(0, Math.min(cols - 1, Math.floor(u)));
    const r0 = Math.max(0, Math.min(rows - 1, Math.floor(v)));
    const c1 = Math.min(cols - 1, c0 + 1);
    const r1 = Math.min(rows - 1, r0 + 1);
    const fu = Math.max(0, Math.min(1, u - c0));
    const fv = Math.max(0, Math.min(1, v - r0));

    const h00 = values[r0 * cols + c0];
    const h10 = values[r0 * cols + c1];
    const h01 = values[r1 * cols + c0];
    const h11 = values[r1 * cols + c1];
    if (!Number.isNaN(h00) && !Number.isNaN(h10) && !Number.isNaN(h01) && !Number.isNaN(h11)) {
      const lo = h00 + (h10 - h00) * fu;
      const hi = h01 + (h11 - h01) * fu;
      return lo + (hi - lo) * fv;
    }
    let sum = 0;
    let weight = 0;
    const add = (h, w) => {
      if (!Number.isNaN(h) && w > 0) {
        sum += h * w;
        weight += w;
      }
    };
    add(h00, (1 - fu) * (1 - fv));
    add(h10, fu * (1 - fv));
    add(h01, (1 - fu) * fv);
    add(h11, fu * fv);
    return weight > 0 ? sum / weight : NaN;
  };
}

function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

export function scanBuilding(poly, sample, mmPerMetre, opts = {}) {
  if (!sample || !poly?.length) return null;
  const outer = poly[0];
  let areaMm2 = Math.abs(ringArea(outer));
  for (let i = 1; i < poly.length; i++) areaMm2 -= Math.abs(ringArea(poly[i]));
  const areaM2 = areaMm2 / (mmPerMetre * mmPerMetre);
  if (areaM2 < MIN_AREA_M2) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of outer) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  // About a metre between samples on a house, coarser on big buildings.
  let stepM = Math.max(1, Math.min(4, Math.sqrt(areaM2 / 900)));
  const blurM = opts.blurM ?? BLUR_M;
  const size = (s) => {
    const pad = Math.ceil(Math.max(blurM + 1, REACH_M + 1) / s) + 1;
    return {
      pad,
      nx: Math.ceil((maxX - minX) / (s * mmPerMetre)) + pad * 2,
      ny: Math.ceil((maxY - minY) / (s * mmPerMetre)) + pad * 2,
    };
  };
  let dims = size(stepM);
  if (dims.nx * dims.ny > MAX_CELLS) {
    stepM *= Math.sqrt((dims.nx * dims.ny) / MAX_CELLS);
    dims = size(stepM);
  }
  const { pad, nx, ny } = dims;
  const step = stepM * mmPerMetre;
  const x0 = minX - pad * step;
  const y0 = minY - pad * step;
  const cells = nx * ny;

  const heights = new Float32Array(cells).fill(NaN);
  const inside = new Uint8Array(cells);
  let nInside = 0;
  let nKnown = 0;
  const raised = [];

  for (let r = 0; r < ny; r++) {
    const y = y0 + (r + 0.5) * step;
    for (let c = 0; c < nx; c++) {
      const x = x0 + (c + 0.5) * step;
      const i = r * nx + c;
      const h = sample(x, y);
      if (!Number.isNaN(h)) heights[i] = h;
      if (!pointInRing([x, y], outer)) continue;
      let hole = false;
      for (let k = 1; k < poly.length && !hole; k++) hole = pointInRing([x, y], poly[k]);
      if (hole) continue;
      inside[i] = 1;
      nInside++;
      if (Number.isNaN(h)) continue;
      nKnown++;
      if (h >= ROOF_MIN_M) raised.push(h);
    }
  }

  if (nInside < 6 || nKnown < nInside * 0.6) return null;
  // Mostly bare ground inside the outline: the building was not there when
  // the survey flew, or the outline is in the wrong place.
  if (raised.length < Math.max(5, nInside * 0.3)) return { kind: 'absent', areaM2 };

  raised.sort((a, b) => a - b);
  const level = percentile(raised, 0.5);
  const small = areaM2 <= SMALL_AREA_M2 && percentile(raised, 0.9) <= SMALL_HEIGHT_M;

  // A smeared wall passes through half the roof height where the wall
  // really is, so that is where the building ends. A tree over a house
  // reads far above the roof; a tower over a podium does too, so only trim
  // the top on house-sized buildings.
  const floor = Math.max(1.4, Math.min(4, 0.5 * percentile(raised, 0.25)));
  const ceiling = small ? level + Math.max(3.5, 0.5 * level) : Infinity;
  const roof = new Uint8Array(cells);
  const kept = [];
  for (let i = 0; i < cells; i++) {
    const h = heights[i];
    if (inside[i] && h >= floor && h <= ceiling) {
      roof[i] = 1;
      kept.push(h);
    }
  }
  if (kept.length < 6) return { kind: 'absent', areaM2 };

  // Cells with roof all round them are free of the smear at the walls.
  const core = new Uint8Array(cells);
  const coreHeights = [];
  const rim = Math.max(1, Math.round(Math.min(blurM, 2) / stepM));
  for (let r = rim; r < ny - rim; r++) {
    for (let c = rim; c < nx - rim; c++) {
      const i = r * nx + c;
      if (!roof[i]) continue;
      let ok = true;
      for (let dr = -rim; dr <= rim && ok; dr++) {
        for (let dc = -rim; dc <= rim && ok; dc++) {
          if (!roof[(r + dr) * nx + c + dc]) ok = false;
        }
      }
      if (ok) {
        core[i] = 1;
        coreHeights.push(heights[i]);
      }
    }
  }
  const usable = coreHeights.length >= Math.max(6, kept.length * 0.12) ? coreHeights : kept;
  const hasCore = usable === coreHeights;
  usable.sort((a, b) => a - b);

  const p10 = percentile(usable, 0.1);
  const p50 = percentile(usable, 0.5);
  const p90 = percentile(usable, 0.9);
  const top = percentile(usable, 0.97);
  const relief = p90 - p10;

  const ob = orientedBounds(outer);
  if (!ob || ob.halfWidth < 1e-6) return null;

  // Where the house actually is. Outlines traced from imagery are often a
  // few metres off, or larger than the building. Take the raised patch the
  // outline sits on, let it reach a little way outside the outline, and box
  // it in the outline's own directions.
  let { ux, uy, vx, vy } = ob;
  let blob = roof;
  if (small) {
    const reach = Math.max(1, Math.round(REACH_M / stepM));
    const near = new Uint8Array(cells);
    for (let r = 0; r < ny; r++) {
      for (let c = 0; c < nx; c++) {
        if (!inside[r * nx + c]) continue;
        for (let dr = -reach; dr <= reach; dr++) {
          for (let dc = -reach; dc <= reach; dc++) {
            const rr = r + dr;
            const cc = c + dc;
            if (rr >= 0 && cc >= 0 && rr < ny && cc < nx) near[rr * nx + cc] = 1;
          }
        }
      }
    }
    const label = new Int32Array(cells);
    const stack = [];
    let bestLabel = 0;
    let bestOverlap = 0;
    let labels = 0;
    for (let start = 0; start < cells; start++) {
      if (!roof[start] || label[start]) continue;
      labels++;
      let overlap = 0;
      label[start] = labels;
      stack.push(start);
      while (stack.length) {
        const i = stack.pop();
        if (inside[i]) overlap++;
        const r = (i / nx) | 0;
        const c = i - r * nx;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr;
            const cc = c + dc;
            if (rr < 0 || cc < 0 || rr >= ny || cc >= nx) continue;
            const j = rr * nx + cc;
            const h = heights[j];
            if (label[j] || !near[j] || !(h >= floor && h <= ceiling)) continue;
            label[j] = labels;
            stack.push(j);
          }
        }
      }
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestLabel = labels;
      }
    }
    blob = new Uint8Array(cells);
    for (let i = 0; i < cells; i++) if (label[i] === bestLabel) blob[i] = 1;
  }

  const us = [];
  const vs = [];
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      if (!blob[r * nx + c]) continue;
      const dx = x0 + (c + 0.5) * step - ob.cx;
      const dy = y0 + (r + 0.5) * step - ob.cy;
      us.push(dx * ux + dy * uy);
      vs.push(dx * vx + dy * vy);
    }
  }
  us.sort((a, b) => a - b);
  vs.sort((a, b) => a - b);
  const half = step / 2;
  let uLo = percentile(us, 0.02) - half;
  let uHi = percentile(us, 0.98) + half;
  let vLo = percentile(vs, 0.02) - half;
  let vHi = percentile(vs, 0.98) + half;
  // A tree against the wall can stretch the patch; never let the house grow
  // much past the outline's own size.
  const cap = (lo, hi, limit) => {
    if (hi - lo <= limit) return [lo, hi];
    const mid = (lo + hi) / 2;
    return [mid - limit / 2, mid + limit / 2];
  };
  [uLo, uHi] = cap(uLo, uHi, ob.halfLength * 2 * 1.2);
  [vLo, vHi] = cap(vLo, vHi, ob.halfWidth * 2 * 1.2);
  let L = (uHi - uLo) / 2;
  let W = (vHi - vLo) / 2;
  const cx = ob.cx + ((uLo + uHi) / 2) * ux + ((vLo + vHi) / 2) * vx;
  const cy = ob.cy + ((uLo + uHi) / 2) * uy + ((vLo + vHi) / 2) * vy;
  if (W > L) {
    [L, W] = [W, L];
    [ux, uy, vx, vy] = [vx, vy, -ux, -uy];
  }
  if (W < 1e-6) return null;
  const frame = { cx, cy, ux, uy, vx, vy, halfLength: L, halfWidth: W };

  // For a house, print the outline where the LiDAR found it: moved when it
  // is clearly off, and cut down when the roof fills clearly less of it.
  let snap = null;
  if (small) {
    const dx = cx - ob.cx;
    const dy = cy - ob.cy;
    const filled = (L * W) / (ob.halfLength * ob.halfWidth);
    const moved = Math.hypot(dx, dy) >= 1 * mmPerMetre;
    const shrunk = filled < 0.8 && L * W * 4 >= MIN_AREA_M2 * mmPerMetre * mmPerMetre;
    if (moved || shrunk) snap = { dx: moved ? dx : 0, dy: moved ? dy : 0, clip: shrunk ? frame : null };
  }

  const base = {
    areaM2, p10, p50, p90, frame, snap,
    samples: kept.length,
    coverage: kept.length / nInside,
  };
  const flat = () => ({ kind: 'flat', heightM: p50, eaveM: p50, riseM: 0, ...base });

  // The measured surface. The smeared band along the walls is replaced by
  // the nearest clean roof height, so walls rise square to the roof edge
  // instead of sloping in, and the result reaches two cells past the
  // outline so nothing sags at the boundary.
  const surface = () => {
    const field = new Float32Array(cells).fill(NaN);
    const seed = hasCore ? core : roof;
    for (let i = 0; i < cells; i++) if (seed[i]) field[i] = heights[i];
    let pending = true;
    for (let pass = 0; pending && pass < nx + ny; pass++) {
      pending = false;
      const next = field.slice();
      for (let r = 0; r < ny; r++) {
        for (let c = 0; c < nx; c++) {
          const i = r * nx + c;
          if (!Number.isNaN(field[i])) continue;
          let best = -Infinity;
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              const rr = r + dr;
              const cc = c + dc;
              if (rr < 0 || cc < 0 || rr >= ny || cc >= nx) continue;
              const h = field[rr * nx + cc];
              if (!Number.isNaN(h) && h > best) best = h;
            }
          }
          // Keep a real measurement where there is one and it is higher:
          // only the smear is being undone, not the roof.
          if (best > -Infinity) next[i] = roof[i] && heights[i] > best ? heights[i] : best;
          else pending = true;
        }
      }
      field.set(next);
    }
    // A 3 × 3 median takes out antennas, vents and stray returns without
    // rounding off the steps between roof levels.
    const smooth = field.slice();
    const win = new Float32Array(9);
    for (let r = 1; r < ny - 1; r++) {
      for (let c = 1; c < nx - 1; c++) {
        let n = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const h = field[(r + dr) * nx + c + dc];
            if (!Number.isNaN(h)) win[n++] = h;
          }
        }
        if (n < 5) continue;
        const sorted = win.subarray(0, n).slice().sort();
        smooth[r * nx + c] = sorted[n >> 1];
      }
    }
    field.set(smooth);
    return {
      kind: 'surface',
      heightM: top,
      eaveM: Math.max(ROOF_MIN_M, p10),
      riseM: Math.max(0, top - p10),
      field: { x0, y0, step, nx, ny, values: field, floorM: Math.max(ROOF_MIN_M, p10 * 0.85) },
      ...base,
    };
  };

  if (!small) return relief <= Math.max(1.2, 0.08 * p50) ? flat() : surface();

  // A house. Everything below works from the cells of the house itself.
  let us2 = [];
  let vs2 = [];
  let hs = [];
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      const i = r * nx + c;
      if (!blob[i]) continue;
      const dx = x0 + (c + 0.5) * step - cx;
      const dy = y0 + (r + 0.5) * step - cy;
      us2.push(dx * ux + dy * uy);
      vs2.push(dx * vx + dy * vy);
      hs.push(heights[i]);
    }
  }
  if (hs.length < 6) return null;

  // A branch over the roof stands clear of everything else the roof does:
  // drop whatever is above the upper quartile by more than the spread of
  // the roof itself.
  let sorted = hs.slice().sort((a, b) => a - b);
  const q1 = percentile(sorted, 0.25);
  const q3 = percentile(sorted, 0.75);
  const fence = q3 + (q3 - q1) + 0.5;
  if (sorted[sorted.length - 1] > fence) {
    const keep = hs.map((h) => h <= fence);
    us2 = us2.filter((_, i) => keep[i]);
    vs2 = vs2.filter((_, i) => keep[i]);
    hs = hs.filter((_, i) => keep[i]);
    sorted = hs.slice().sort((a, b) => a - b);
  }

  const Lm = L / mmPerMetre;
  const Wm = W / mmPerMetre;
  const ridge = percentile(sorted, 0.97);
  let mean = 0;
  for (const h of hs) mean += h;
  mean /= hs.length;
  const spread = percentile(sorted, 0.9) - percentile(sorted, 0.1);

  // How full the house would read if its roof were level: all of it at
  // full height except the smeared rim, which costs a sixth of the smear
  // width per unit of half-length on each axis. A flat roof reads about
  // that full; under a pitched roof the average is well below the ridge.
  const rimLoss = (halfM) => 1 - Math.min(0.5, blurM / (6 * halfM));
  const levelFullness = rimLoss(Lm) * rimLoss(Wm);
  const fullness = mean / ridge;
  if (fullness >= 0.94 * levelFullness || spread <= 0.6) {
    return { kind: 'flat', heightM: ridge, eaveM: ridge, riseM: 0, ...base };
  }

  // Which way the ridge runs: height falls away from the ridge, so it
  // tracks distance across the ridge more than distance along it.
  const fall = (coords, halfSpan) => {
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < hs.length; i++) {
      const x = Math.abs(coords[i]) / halfSpan;
      sx += x;
      sy += hs[i];
      sxx += x * x;
      syy += hs[i] * hs[i];
      sxy += x * hs[i];
    }
    const n = hs.length;
    const cov = sxy - (sx * sy) / n;
    const den = Math.sqrt((sxx - (sx * sx) / n) * (syy - (sy * sy) / n));
    return den > 0 ? cov / den : 0;
  };
  // Ridge across the short side only on a nearly square plan, and only
  // when the heights say so.
  const orientation = fall(us2, L) < fall(vs2, W) - 0.08 && L / W < 1.35 ? 'across' : 'along';

  // One slope: the highest cells sit against one long wall instead of
  // down the middle.
  let lean = null;
  const low = percentile(sorted, 0.3);
  const cut = low + 0.62 * (ridge - low);
  const high = [];
  for (let i = 0; i < hs.length; i++) if (hs[i] >= cut) high.push(vs2[i]);
  high.sort((a, b) => a - b);
  if (high.length >= 4) {
    const offV = percentile(high, 0.5) / W;
    const width = (percentile(high, 0.95) - percentile(high, 0.05) + step) / (2 * W);
    if (Math.abs(offV) > 0.62 && width < 0.5) lean = offV > 0 ? [0, -1] : [0, 1];
  }

  // Pitch. Under a ridge roof the average height is half the rise below
  // the ridge, once the smeared rim is allowed for; and the smear shaves
  // the ridge itself by about a third of its width times the slope, which
  // is put back. Kept between roughly 15° and 40°.
  const spanM = lean ? 2 * Wm : orientation === 'across' ? Lm : Wm;
  const shave = lean ? 0 : Math.min(0.6, blurM / (3 * spanM));
  let riseM = (2 * (ridge - mean / levelFullness)) / (1 - 2 * shave);
  riseM = Math.min(Math.max(riseM, 0.27 * spanM), 0.85 * spanM);
  const heightM = ridge + Math.min(1.2, riseM * shave);
  riseM = Math.min(riseM, 0.62 * heightM);

  const result = {
    kind: lean ? 'skillion' : 'pitched',
    orientation,
    heightM,
    eaveM: heightM - riseM,
    riseM,
    ...base,
  };
  if (lean) {
    // Compass bearing the roof falls towards, as OSM's roof:direction.
    const fx = lean[0] * ux + lean[1] * vx;
    const fy = lean[0] * uy + lean[1] * vy;
    result.directionDeg = ((Math.atan2(fx, fy) * 180) / Math.PI + 360) % 360;
  }
  return result;
}

// Which pitched roof to draw where the survey cannot say. Hipped roofs
// dominate the hot and hurricane-prone South and Southwest; gables the
// rest of the country.
export function regionalRoofStyle(lat, lon) {
  const south = lat < 34.6;
  const southwest = lat < 37.2 && lon < -100;
  return south || southwest ? 'hipped' : 'gabled';
}

// Bilinear lookup into a building's filled surface, in metres.
export function fieldSampler(field) {
  const { x0, y0, step, nx, ny, values, floorM } = field;
  return function at(x, y) {
    const u = Math.max(0, Math.min(nx - 1, (x - x0) / step - 0.5));
    const v = Math.max(0, Math.min(ny - 1, (y - y0) / step - 0.5));
    const c0 = Math.floor(u);
    const r0 = Math.floor(v);
    const c1 = Math.min(nx - 1, c0 + 1);
    const r1 = Math.min(ny - 1, r0 + 1);
    const fu = u - c0;
    const fv = v - r0;
    const pick = (r, c) => {
      const h = values[r * nx + c];
      return !Number.isNaN(h) ? h : floorM;
    };
    const lo = pick(r0, c0) + (pick(r0, c1) - pick(r0, c0)) * fu;
    const hi = pick(r1, c0) + (pick(r1, c1) - pick(r1, c0)) * fu;
    const h = lo + (hi - lo) * fv;
    return h > floorM ? h : floorM;
  };
}
