import {
  convexHull,
  intersection,
  orientedBounds,
  ringArea,
  snapMultiPolygon,
  triangulatePolygon,
} from './geom.js';
import { extrudePolygon, orientPolygon } from './mesh.js';

const snapZ = (z) => Math.round(z * 1000) / 1000;

const PITCH = {
  gabled: (ob, ms) => Math.min(ob.halfWidth * 0.72, 6 * ms),
  hipped: (ob, ms) => Math.min(ob.halfWidth * 0.6, 5 * ms),
  skillion: (ob, ms) => Math.min(ob.halfWidth * 0.4, 4 * ms),
  pyramidal: (ob, ms) => Math.min(ob.halfWidth * 0.9, 8 * ms),
};

export function addRoof(mesh, poly, z0, totalH, spec, opts = {}) {
  if (!mesh || !spec || spec.shape === 'flat') return null;
  if (poly.length !== 1) return null;
  const ring = poly[0];

  // A measured roof brings its own frame: where the LiDAR found the
  // building, which is not always where the outline's bounding box is.
  const ob = spec.frame || orientedBounds(ring);
  if (!ob || ob.halfWidth < (opts.minHalfWidthMm ?? 0.35)) return null;

  let shape = spec.shape;
  if (shape === 'pyramidal' && !spec.frame && convexity(ring) < 0.8) {
    shape = 'gabled';
  }

  // The roof covers the frame; any part of the outline beyond it stays a
  // flat shoulder at wall height.
  const cover = spec.frame ? intersection([poly], frameRect(ob)) : [poly];
  if (!cover.length) return null;

  const metreScale = opts.metreScale ?? 1;
  let rise =
    spec.heightM != null
      ? spec.heightM * metreScale
      : PITCH[shape](ob, metreScale);
  rise = Math.min(rise, totalH * (spec.measured ? 0.8 : 0.6));
  if (rise < (opts.minRoofMm ?? 0.2)) return null;

  const ridgeZ = snapZ(z0 + totalH);
  const wallTop = snapZ(ridgeZ - rise);
  if (ridgeZ - wallTop <= 0) return null;

  let built = false;
  if (shape === 'gabled') {
    built = gabled(mesh, cover, ob, spec, wallTop, ridgeZ);
  } else if (shape === 'hipped') {
    built = hipped(mesh, cover, ob, wallTop, ridgeZ, false);
  } else if (shape === 'skillion') {
    built = skillion(mesh, cover, ob, spec, wallTop, ridgeZ);
  } else if (shape === 'pyramidal') {
    built = spec.frame
      ? hipped(mesh, cover, ob, wallTop, ridgeZ, true)
      : pyramid(mesh, poly, ob, wallTop, ridgeZ);
  }
  return built ? wallTop : null;
}

function frameRect(ob) {
  const { cx, cy, ux, uy, vx, vy, halfLength: L, halfWidth: W } = ob;
  const at = (u, v) => [cx + ux * u + vx * v, cy + uy * u + vy * v];
  return [[[at(-L, -W), at(L, -W), at(L, W), at(-L, W), at(-L, -W)]]];
}

function convexity(ring) {
  const hull = convexHull(ring);
  if (hull.length < 3) return 0;
  const hullArea = Math.abs(ringArea(hull));
  return hullArea > 0 ? Math.abs(ringArea(ring)) / hullArea : 0;
}

function ridgeHalfPlane(ob, side, reach) {
  const { cx, cy, ux, uy, vx, vy } = ob;
  const R = reach;
  return [[
    [cx - ux * R, cy - uy * R],
    [cx + ux * R, cy + uy * R],
    [cx + ux * R + side * vx * R, cy + uy * R + side * vy * R],
    [cx - ux * R + side * vx * R, cy - uy * R + side * vy * R],
    [cx - ux * R, cy - uy * R],
  ]];
}

function gabled(mesh, cover, ob, spec, wallTop, ridgeZ) {
  let { cx, cy, ux, uy, vx, vy, halfLength, halfWidth } = ob;
  if (spec.orientation === 'across') {
    [ux, uy, vx, vy] = [vx, vy, ux, uy];
    [halfLength, halfWidth] = [halfWidth, halfLength];
  }
  if (halfWidth < 1e-6) return false;

  const rise = ridgeZ - wallTop;
  const zAt = (x, y) => {
    const d = Math.abs((x - cx) * vx + (y - cy) * vy);
    return snapZ(wallTop + rise * Math.max(0, 1 - d / halfWidth));
  };

  const axes = { cx, cy, ux, uy, vx, vy };
  const reach = halfLength + halfWidth + 10;
  let built = 0;
  for (const side of [1, -1]) {
    for (const piece of intersection(cover, ridgeHalfPlane(axes, side, reach))) {
      if (extrudePolygon(mesh, piece, wallTop, zAt)) built++;
    }
  }
  return built > 0;
}

// Four slopes meeting on a ridge shorter than the building: two long sides
// and a triangular hip at each end, all at the same pitch. The plane is cut
// into the four regions under each slope, so every piece is a flat facet.
// With `toPoint` the ridge shrinks to an apex and the ends take their own
// pitch: a pyramid over a rectangle.
function hipped(mesh, cover, ob, wallTop, ridgeZ, toPoint) {
  const { cx, cy, ux, uy, vx, vy, halfLength: L, halfWidth: W } = ob;
  if (W < 1e-6) return false;
  const rise = ridgeZ - wallTop;
  const e = toPoint ? 0 : Math.max(0, L - W);
  const run = toPoint ? L : W;
  const k = (L + W + 10) / W;
  const du = run * k;
  const dv = W * k;
  const at = (u, v) => [cx + ux * u + vx * v, cy + uy * u + vy * v];
  const region = (points) => {
    const ring = points.map(([u, v]) => at(u, v));
    ring.push(ring[0]);
    return [[ring]];
  };
  const side = (x, y) => {
    const d = Math.abs((x - cx) * vx + (y - cy) * vy);
    return snapZ(wallTop + rise * Math.max(0, 1 - d / W));
  };
  const end = (x, y) => {
    const d = Math.abs((x - cx) * ux + (y - cy) * uy);
    return snapZ(wallTop + rise * Math.max(0, Math.min(1, (L - d) / run)));
  };
  const parts = [
    [region([[-e, 0], [e, 0], [e + du, dv], [-e - du, dv]]), side],
    [region([[e, 0], [-e, 0], [-e - du, -dv], [e + du, -dv]]), side],
    [region([[e, 0], [e + du, -dv], [e + du, dv]]), end],
    [region([[-e, 0], [-e - du, dv], [-e - du, -dv]]), end],
  ];
  let built = 0;
  for (const [mask, zAt] of parts) {
    for (const piece of intersection(cover, mask)) {
      if (extrudePolygon(mesh, piece, wallTop, zAt)) built++;
    }
  }
  return built > 0;
}

function skillion(mesh, cover, ob, spec, wallTop, ridgeZ) {
  let dx, dy;
  if (spec.directionDeg != null) {
    const rad = (spec.directionDeg * Math.PI) / 180;
    dx = Math.sin(rad);
    dy = Math.cos(rad);
  } else {
    dx = ob.vx;
    dy = ob.vy;
  }
  let min = Infinity;
  let max = -Infinity;
  for (const piece of cover) {
    for (const [x, y] of piece[0]) {
      const d = x * dx + y * dy;
      if (d < min) min = d;
      if (d > max) max = d;
    }
  }
  const span = max - min;
  if (span < 1e-6) return false;

  const rise = ridgeZ - wallTop;
  const zAt = (x, y) =>
    snapZ(wallTop + (rise * (max - (x * dx + y * dy))) / span);
  let built = 0;
  for (const piece of cover) {
    if (extrudePolygon(mesh, piece, wallTop, zAt)) built++;
  }
  return built > 0;
}

function pyramid(mesh, poly, ob, wallTop, ridgeZ) {
  const snapped = snapMultiPolygon([poly])[0];
  if (!snapped) return false;
  const tri = triangulatePolygon(orientPolygon(snapped));
  if (!tri) return false;

  const { flat, indices, boundary } = tri;
  const base = mesh.vertexCount;
  for (let i = 0; i < flat.length / 2; i++) {
    mesh.addVertex(flat[i * 2], flat[i * 2 + 1], wallTop);
  }
  for (let i = 0; i < indices.length; i += 3) {
    mesh.addTriangle(base + indices[i + 2], base + indices[i + 1], base + indices[i]);
  }
  const apex = mesh.addVertex(ob.cx, ob.cy, ridgeZ);
  for (const [ia, ib] of boundary) {
    mesh.addTriangle(base + ia, base + ib, apex);
  }
  return true;
}
