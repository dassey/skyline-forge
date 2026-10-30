// A synthetic, deterministic Overpass response: a gridded city with towers,
// avenues, a river, a park, a rail line and street trees. Lets the browser
// and build tests run offline when no cached OSM extract is available.

export function syntheticCity({ lat = 40.7549, lon = -73.984, spanMetres = 2600, seed = 7 } = {}) {
  let state = seed >>> 0;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };

  const mPerLat = 111320;
  const mPerLon = 111320 * Math.cos((lat * Math.PI) / 180);
  const at = (x, y) => ({ lat: lat + y / mPerLat, lon: lon + x / mPerLon });
  const ring = (pts) => [...pts.map(([x, y]) => at(x, y)), at(...pts[0])];

  const elements = [];
  let id = 1;
  const way = (tags, pts, closed = true) =>
    elements.push({ type: 'way', id: id++, tags, geometry: closed ? ring(pts) : pts.map(([x, y]) => at(x, y)) });

  const half = spanMetres / 2;
  const riverX = -half * 0.62;
  const avenueGap = 260;
  const streetGap = 84;
  const parkCol = 1;
  const parkRows = [2, 3, 4];

  way({ natural: 'water', name: 'River' }, [
    [-half - 200, -half - 200],
    [riverX, -half - 200],
    [riverX + 40, 0],
    [riverX, half + 200],
    [-half - 200, half + 200],
  ]);

  const avenues = [];
  for (let x = riverX + 120; x < half + 200; x += avenueGap) avenues.push(x);
  const streets = [];
  for (let y = -half - 100; y < half + 200; y += streetGap) streets.push(y);

  avenues.forEach((x, i) => {
    way({ highway: i % 2 ? 'primary' : 'secondary', name: `Avenue ${i + 1}` },
      [[x, -half - 150], [x, half + 150]], false);
  });
  streets.forEach((y, i) => {
    way({ highway: i % 5 === 0 ? 'tertiary' : 'residential', name: `Street ${i + 1}` },
      [[riverX + 60, y], [half + 150, y]], false);
  });

  way({ railway: 'rail' }, [[riverX + 70, -half - 150], [riverX + 70, half + 150]], false);

  for (let c = 0; c < avenues.length - 1; c++) {
    for (let r = 0; r < streets.length - 1; r++) {
      const x0 = avenues[c] + 12;
      const x1 = avenues[c + 1] - 12;
      const y0 = streets[r] + 9;
      const y1 = streets[r + 1] - 9;

      if (c === parkCol && parkRows.includes(r)) {
        way({ leisure: 'park', name: 'Central Green' }, [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
        for (let t = 0; t < 14; t++) {
          const p = at(x0 + 8 + rand() * (x1 - x0 - 16), y0 + 8 + rand() * (y1 - y0 - 16));
          elements.push({ type: 'node', id: id++, lat: p.lat, lon: p.lon, tags: { natural: 'tree' } });
        }
        continue;
      }

      const lots = 3 + Math.floor(rand() * 4);
      const lotW = (x1 - x0) / lots;
      const centre = Math.hypot((x0 + x1) / 2, (y0 + y1) / 2);
      for (let k = 0; k < lots; k++) {
        const a = x0 + k * lotW + 1.5;
        const b = a + lotW - 3;
        const tall = Math.max(0, 1 - centre / (half * 0.9));
        const levels = Math.round(3 + rand() * 8 + tall * tall * rand() * 70);
        const tags = { building: levels > 12 ? 'commercial' : 'apartments' };
        if (rand() < 0.6) tags.height = String((levels * 3.4).toFixed(1));
        else tags['building:levels'] = String(levels);
        const inset = rand() * 6;
        way(tags, [[a, y0 + inset], [b, y0 + inset], [b, y1 - inset], [a, y1 - inset]]);
      }

      if (r % 3 === 0) {
        for (let t = 0; t < 3; t++) {
          const p = at(x0 + rand() * (x1 - x0), streets[r] + 4);
          elements.push({ type: 'node', id: id++, lat: p.lat, lon: p.lon, tags: { natural: 'tree' } });
        }
      }
    }
  }

  return { version: 0.6, generator: 'skyline-forge synthetic fixture', elements };
}
