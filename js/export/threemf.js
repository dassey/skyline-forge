import { createZip } from './zip.js';

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
  <Default Extension="config" ContentType="application/xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

function escapeXml(str) {
  return String(str).replace(/[<>&"']/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]
  );
}

function toDisplayColor(hex) {
  const clean = String(hex || '#cccccc').replace('#', '');
  const rgb = clean.length === 3
    ? clean.split('').map((c) => c + c).join('')
    : clean.padEnd(6, 'c').slice(0, 6);
  return `#${rgb.toUpperCase()}FF`;
}

export function to3mf(parts, meta = {}) {
  const usable = parts.filter((p) => p.indices.length >= 3);
  if (!usable.length) throw new Error('Nothing to export.');

  const materials = usable
    .map(
      (p) =>
        `      <base name="${escapeXml(p.label || p.id)}" displaycolor="${toDisplayColor(p.color)}"/>`
    )
    .join('\n');

  const objects = [];
  usable.forEach((part, index) => {
    const objectId = index + 2;
    const pos = part.positions;
    const idx = part.indices;

    const vertices = [];
    for (let i = 0; i < pos.length; i += 3) {
      vertices.push(
        `<vertex x="${fmt(pos[i])}" y="${fmt(pos[i + 1])}" z="${fmt(pos[i + 2])}"/>`
      );
    }
    const triangles = [];
    for (let i = 0; i < idx.length; i += 3) {
      triangles.push(
        `<triangle v1="${idx[i]}" v2="${idx[i + 1]}" v3="${idx[i + 2]}"/>`
      );
    }

    objects.push(
      `    <object id="${objectId}" name="${escapeXml(part.label || part.id)}" type="model" pid="1" pindex="${index}">
      <mesh>
        <vertices>${vertices.join('')}</vertices>
        <triangles>${triangles.join('')}</triangles>
      </mesh>
    </object>`
    );
  });

  const assemblyId = usable.length + 2;
  const components = usable
    .map((_, i) => `      <component objectid="${i + 2}"/>`)
    .join('\n');

  // Slicers keep the build transform, so move the model's footprint onto
  // the middle of the chosen printer's plate and stand it on z = 0.
  let transform = '';
  if (meta.plateCentre) {
    const b = boundsOf(usable);
    const dx = meta.plateCentre[0] - (b.minX + b.maxX) / 2;
    const dy = meta.plateCentre[1] - (b.minY + b.maxY) / 2;
    transform = ` transform="1 0 0 0 1 0 0 0 1 ${fmt(dx)} ${fmt(dy)} ${fmt(-b.minZ)}"`;
  }

  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Title">${escapeXml(meta.title || 'Skyline model')}</metadata>
  <metadata name="Designer">${escapeXml(meta.designer || '')}</metadata>
  <metadata name="Description">${escapeXml(meta.description || '')}</metadata>
  <metadata name="Application">${escapeXml(meta.application || 'Skyline Forge')}</metadata>
  <resources>
    <basematerials id="1">
${materials}
    </basematerials>
${objects.join('\n')}
    <object id="${assemblyId}" name="${escapeXml(meta.title || 'Model')}" type="model">
      <components>
${components}
      </components>
    </object>
  </resources>
  <build>
    <item objectid="${assemblyId}"${transform}/>
  </build>
</model>`;

  const entries = [
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: RELS },
    { name: '3D/3dmodel.model', data: model },
  ];
  if (usable.some((p) => Number.isInteger(p.filament))) {
    entries.push({
      name: 'Metadata/model_settings.config',
      data: modelSettings(usable, assemblyId, meta.title || 'Skyline model'),
    });
  }
  return createZip(entries, 'model/3mf');
}

// Bambu Studio and OrcaSlicer read per-part filament numbers from this file,
// so each layer opens already assigned to its spool. Other slicers ignore it.
function modelSettings(parts, assemblyId, title) {
  const extruder = (p) => (Number.isInteger(p.filament) ? p.filament : 0) + 1;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<config>',
    `  <object id="${assemblyId}">`,
    `    <metadata key="name" value="${escapeXml(title)}"/>`,
    `    <metadata key="extruder" value="${extruder(parts[0])}"/>`,
  ];
  parts.forEach((part, index) => {
    lines.push(
      `    <part id="${index + 2}" subtype="normal_part">`,
      `      <metadata key="name" value="${escapeXml(part.label || part.id)}"/>`,
      `      <metadata key="extruder" value="${extruder(part)}"/>`,
      '    </part>'
    );
  });
  lines.push('  </object>', '</config>', '');
  return lines.join('\n');
}

function boundsOf(parts) {
  const b = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const part of parts) {
    const pos = part.positions;
    for (let i = 0; i < pos.length; i += 3) {
      if (pos[i] < b.minX) b.minX = pos[i];
      if (pos[i] > b.maxX) b.maxX = pos[i];
      if (pos[i + 1] < b.minY) b.minY = pos[i + 1];
      if (pos[i + 1] > b.maxY) b.maxY = pos[i + 1];
      if (pos[i + 2] < b.minZ) b.minZ = pos[i + 2];
    }
  }
  return b;
}

function fmt(v) {
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/\.?0+$/, '');
}
