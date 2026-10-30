import { toBinaryStl, toStlBuffer } from './stl.js';
import { to3mf } from './threemf.js';
import { toObj } from './obj.js';
import { createZip } from './zip.js';

export const FORMATS = [
  {
    id: '3mf',
    label: '3MF — print-ready colour',
    ext: '3mf',
    detail: 'Opens in Bambu Studio and OrcaSlicer with every part on its filament, centred on your plate.',
  },
  {
    id: 'stl',
    label: 'STL — single file',
    ext: 'stl',
    detail: 'Every layer merged into one file. Universal, but no colour.',
  },
  {
    id: 'stl-parts',
    label: 'STL — one per layer',
    ext: 'zip',
    detail: 'A ZIP of separate STLs. Load them together for filament swaps.',
  },
  {
    id: 'obj',
    label: 'OBJ + MTL',
    ext: 'zip',
    detail: 'For Blender and renderers. Keeps colours as materials.',
  },
];

export function slugify(text, fallback = 'skyline') {
  const slug = String(text || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || fallback;
}

function banner(meta) {
  return `Skyline Forge | ${meta.title || 'model'} | ${meta.coords || ''}`.slice(0, 79);
}

export function buildExport(format, parts, meta = {}) {
  const usable = parts.filter((p) => p.indices.length >= 3);
  if (!usable.length) throw new Error('There is no geometry to export yet.');

  const stem = slugify(meta.title, 'skyline');

  switch (format) {
    case 'stl':
      return {
        blob: toBinaryStl(usable, banner(meta)),
        filename: `${stem}.stl`,
      };

    case 'stl-parts': {
      const ordered = usable
        .map((part, i) => ({ part, i }))
        .sort((a, b) => (a.part.filament ?? a.i) - (b.part.filament ?? b.i) || a.i - b.i)
        .map(({ part }) => part);
      const entries = ordered.map((part, i) => ({
        name: Number.isInteger(part.filament)
          ? `filament-${part.filament + 1}-${slugify(part.id, part.id)}.stl`
          : `${String(i + 1).padStart(2, '0')}-${slugify(part.id, part.id)}.stl`,
        data: new Uint8Array(toStlBuffer([part], `${banner(meta)} | ${part.label}`)),
      }));
      entries.push({ name: 'README.txt', data: partsReadme(ordered, meta) });
      return {
        blob: createZip(entries),
        filename: `${stem}-parts.zip`,
      };
    }

    case 'obj': {
      const { obj, mtl } = toObj(usable, stem);
      return {
        blob: createZip([
          { name: `${stem}.obj`, data: obj },
          { name: `${stem}.mtl`, data: mtl },
        ]),
        filename: `${stem}-obj.zip`,
      };
    }

    case '3mf':
    default:
      return {
        blob: to3mf(usable, {
          title: meta.title || 'Skyline model',
          description: meta.description || '',
          application: 'Skyline Forge',
          plateCentre: meta.plateCentre,
        }),
        filename: `${stem}.3mf`,
      };
  }
}

function partsReadme(parts, meta) {
  const lines = ['Skyline Forge — per-layer STL bundle', '====================================', ''];
  if (meta.title) lines.push(`Model:  ${meta.title}`);
  if (meta.coords) lines.push(`Centre: ${meta.coords}`);
  if (meta.scale) lines.push(`Scale:  ${meta.scale}`);
  lines.push(
    '',
    'Every file below is a separate watertight solid, already positioned so',
    'that importing all of them together reassembles the model exactly. No',
    'moving, scaling or rotating is needed.',
    '',
    'PrusaSlicer / OrcaSlicer / Bambu Studio:',
    '  1. Import the first STL.',
    '  2. Right-click it, "Add part" -> "Load", and add the rest.',
    '  3. Assign each part the filament number in its file name.',
    '  (The 3MF export does steps 1-3 for you in Bambu Studio and OrcaSlicer.)',
    '',
    'Cura:',
    '  1. Open all files at once; Cura keeps their shared origin.',
    '  2. Select all, then "Merge models" (Ctrl+Alt+G).',
    '',
    'Single-colour printing: use the merged .stl export instead.',
    ''
  );
  if (parts.every((p) => Number.isInteger(p.filament))) {
    lines.push('Filaments — load these, then give each file the filament in its name:');
    const slots = [...new Set(parts.map((p) => p.filament))];
    for (const slot of slots) {
      const members = parts.filter((p) => p.filament === slot);
      const name = meta.filamentNames?.[slot];
      lines.push(
        `  Filament ${slot + 1}  ${members[0].color}${name ? `  ${name}` : ''}`,
        `      ${members.map((p) => p.label).join(', ')}`
      );
    }
    lines.push('');
  }
  lines.push('Layers in this bundle:');
  parts.forEach((p, i) => {
    lines.push(
      `  ${String(i + 1).padStart(2, '0')}. ${p.label.padEnd(12)} ${p.color}   ` +
        `${p.triangleCount.toLocaleString()} triangles`
    );
  });
  lines.push('', 'Map data © OpenStreetMap contributors (ODbL).');
  return lines.join('\n');
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
