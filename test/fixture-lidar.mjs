// Synthetic LiDAR for tests: a height-above-ground scene described as boxes
// and roofs in metres, rasterised and smeared the way the real 2 m survey
// is, and encoded as the terrarium PNG tiles the app downloads.

import { deflateSync } from 'node:zlib';

const CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

// An RGBA PNG. `filter` picks the row filter (0–4) so the decoder's
// unfiltering is exercised; pixels are stored exactly either way.
export function encodePng(width, height, rgba, filter = 0) {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const cur = rgba[y * stride + x];
      const a = x >= 4 ? rgba[y * stride + x - 4] : 0;
      const b = y > 0 ? rgba[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? rgba[(y - 1) * stride + x - 4] : 0;
      let predicted = 0;
      if (filter === 1) predicted = a;
      else if (filter === 2) predicted = b;
      else if (filter === 3) predicted = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      raw[y * (stride + 1) + 1 + x] = (cur - predicted) & 0xff;
    }
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// Elevations (south-first rows, NaN = no data) as a north-first terrarium
// tile: metres = R·256 + G + B/256 − 32768.
export function terrariumPng(values, cols, rows, filter = 0) {
  const rgba = new Uint8Array(cols * rows * 4);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const h = values[(rows - 1 - r) * cols + c];
      const at = (r * cols + c) * 4;
      if (Number.isNaN(h)) continue;
      const v = Math.round((h + 32768) * 256);
      rgba[at] = (v >> 16) & 0xff;
      rgba[at + 1] = (v >> 8) & 0xff;
      rgba[at + 2] = v & 0xff;
      rgba[at + 3] = 255;
    }
  }
  return encodePng(cols, rows, rgba, filter);
}

// Height above ground at (x, y) metres for a list of things standing on
// flat ground. Each has a centre, half-sizes along its own axes, a bearing
// (degrees anticlockwise from east) and a roof.
export function heightOf(things, x, y) {
  let top = 0;
  for (const t of things) {
    const a = ((t.angle || 0) * Math.PI) / 180;
    const dx = x - t.x;
    const dy = y - t.y;
    const u = dx * Math.cos(a) + dy * Math.sin(a);
    const v = -dx * Math.sin(a) + dy * Math.cos(a);
    if (Math.abs(u) > t.halfLength || Math.abs(v) > t.halfWidth) continue;
    let h = t.eave;
    if (t.roof === 'gabled') h += t.rise * (1 - Math.abs(v) / t.halfWidth);
    else if (t.roof === 'gabled-across') h += t.rise * (1 - Math.abs(u) / t.halfLength);
    else if (t.roof === 'hipped') {
      h += t.rise * Math.min(1 - Math.abs(v) / t.halfWidth, (t.halfLength - Math.abs(u)) / t.halfWidth);
    } else if (t.roof === 'shed') h += t.rise * ((v + t.halfWidth) / (2 * t.halfWidth));
    if (h > top) top = h;
  }
  return top;
}

// Rasterise a scene onto a lat/lon grid of `pixel` metres and smear it over
// about 2.5 m, which is what the real 2 m rasters look like.
export function lidarGrid(things, { lat, lon, halfMetres, pixel = 1, smear = 2 }) {
  const mPerLat = 111132.92 - 559.82 * Math.cos((2 * lat * Math.PI) / 180);
  const mPerLon = 111412.84 * Math.cos((lat * Math.PI) / 180) - 93.5 * Math.cos((3 * lat * Math.PI) / 180);
  const cols = Math.round((2 * halfMetres) / pixel);
  const rows = cols;
  const sharp = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = -halfMetres + (c + 0.5) * pixel;
      const y = -halfMetres + (r + 0.5) * pixel;
      sharp[r * cols + c] = heightOf(things, x, y);
    }
  }
  const values = new Float32Array(cols * rows);
  const reach = Math.round(smear / pixel);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sum = 0;
      let weight = 0;
      for (let dr = -reach; dr <= reach; dr++) {
        for (let dc = -reach; dc <= reach; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
          const w = (reach + 1 - Math.abs(dr)) * (reach + 1 - Math.abs(dc));
          sum += sharp[rr * cols + cc] * w;
          weight += w;
        }
      }
      values[r * cols + c] = sum / weight;
    }
  }
  return {
    cols,
    rows,
    values,
    resolutionM: 2,
    bbox: {
      minLat: lat - halfMetres / mPerLat,
      maxLat: lat + halfMetres / mPerLat,
      minLon: lon - halfMetres / mPerLon,
      maxLon: lon + halfMetres / mPerLon,
    },
    source: { provider: 'USGS 3DEP LiDAR', survey: 'TEST_SURVEY_2020', year: 2020, surveys: ['TEST_SURVEY_2020'] },
  };
}

// A rectangular outline in Overpass form, optionally shifted and enlarged,
// the way outlines traced from imagery miss the building.
export function outlineOf(thing, { lat, lon, id = 1, tags = { building: 'yes' }, shift = [0, 0], grow = 0 }) {
  const mPerLat = 111132.92 - 559.82 * Math.cos((2 * lat * Math.PI) / 180);
  const mPerLon = 111412.84 * Math.cos((lat * Math.PI) / 180) - 93.5 * Math.cos((3 * lat * Math.PI) / 180);
  const a = ((thing.angle || 0) * Math.PI) / 180;
  const L = thing.halfLength + grow;
  const W = thing.halfWidth + grow;
  const corners = [[-L, -W], [L, -W], [L, W], [-L, W], [-L, -W]].map(([u, v]) => {
    const x = thing.x + shift[0] + u * Math.cos(a) - v * Math.sin(a);
    const y = thing.y + shift[1] + u * Math.sin(a) + v * Math.cos(a);
    return { lat: lat + y / mPerLat, lon: lon + x / mPerLon };
  });
  return { type: 'way', id, tags, geometry: corners };
}
