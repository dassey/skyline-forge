// A minimal PNG reader for data tiles: 8-bit RGB or RGBA, not interlaced.
// Reading pixels through a canvas can alter them (colour management,
// premultiplied alpha), which is fatal when the bytes encode numbers.

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

async function inflate(bytes) {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('This browser cannot read compressed data tiles.');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function decodePng(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== SIGNATURE[i]) throw new Error('Not a PNG image.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  let idatLength = 0;

  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const start = at + 8;
    if (type === 'IHDR') {
      width = view.getUint32(start);
      height = view.getUint32(start + 4);
      const depth = bytes[start + 8];
      const colour = bytes[start + 9];
      const interlace = bytes[start + 12];
      channels = colour === 2 ? 3 : colour === 6 ? 4 : 0;
      if (depth !== 8 || !channels || interlace) {
        throw new Error('Unsupported PNG layout in data tile.');
      }
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(start, start + length));
      idatLength += length;
    } else if (type === 'IEND') {
      break;
    }
    at = start + length + 4;
  }
  if (!width || !height || !idat.length) throw new Error('Empty PNG image.');

  const packed = new Uint8Array(idatLength);
  let offset = 0;
  for (const part of idat) {
    packed.set(part, offset);
    offset += part.length;
  }
  const raw = await inflate(packed);

  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error('Truncated PNG image.');
  const data = new Uint8Array(stride * height);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? data[dst + x - channels] : 0;
      const b = y > 0 ? data[up + x] : 0;
      const c = x >= channels && y > 0 ? data[up + x - channels] : 0;
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
      data[dst + x] = (raw[src + x] + predicted) & 0xff;
    }
  }

  return { width, height, channels, data };
}
