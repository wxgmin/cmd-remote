// Generate PNG icons matching logo.svg (pure Node zlib PNG encoder, no deps).
import zlib from 'zlib';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', 'public');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// Render the logo: rounded-square tile, violet->cyan diagonal gradient,
// white ">" chevron + "_" underscore.
function renderPixel(x, y, size) {
  const t = (x + y) / (2 * (size - 1)); // diagonal gradient 0..1
  const r0 = 0x8b, g0 = 0x5c, b0 = 0xf6; // #8b5cf6
  const r1 = 0x06, g1 = 0xb6, b1 = 0xd4; // #06b6d4
  let r = Math.round(r0 + (r1 - r0) * t);
  let g = Math.round(g0 + (g1 - g0) * t);
  let b = Math.round(b0 + (b1 - b0) * t);

  // Rounded tile corners (~22% radius)
  const rad = size * 0.22;
  const cx = Math.min(x, size - 1 - x);
  const cy = Math.min(y, size - 1 - y);
  if (cx < rad && cy < rad) {
    const dx = rad - cx, dy = rad - cy;
    if (dx * dx + dy * dy > rad * rad) return [0, 0, 0, 0];
  }

  // White glyph in 512-space
  const nx = (x / size) * 512;
  const ny = (y / size) * 512;
  const w = 52;

  function onSeg(x1, y1, x2, y2, px, py, sw) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const d = Math.abs(dy * px - dx * py + x2 * y1 - y2 * x1) / len;
    const proj = ((px - x1) * dx + (py - y1) * dy) / (len * len);
    if (proj < -0.08 || proj > 1.08) return false;
    return d <= sw / 2;
  }

  const white =
    onSeg(158, 196, 300, 256, nx, ny, w) ||
    onSeg(300, 256, 158, 316, nx, ny, w) ||
    (Math.abs(ny - 352) <= w / 2 && nx >= 196 && nx <= 316);

  if (white) { r = 255; g = 255; b = 255; }
  return [r, g, b, 255];
}

function makeIcon(size) {
  const px = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    px[o++] = 0; // filter none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = renderPixel(x, y, size);
      px[o++] = r; px[o++] = g; px[o++] = b; px[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const idat = zlib.deflateSync(px, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) {
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), makeIcon(size));
  console.log(`public/icon-${size}.png written (${size}x${size})`);
}

// Windows .ico (Vista+ PNG-compressed): 256x256 PNG wrapped in an ICO container.
{
  const png = makeIcon(256);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count
  const entry = Buffer.alloc(16);
  entry[0] = 0;   // width 256 (0 means 256)
  entry[1] = 0;   // height 256
  entry[2] = 0;   // colors
  entry[3] = 0;   // reserved
  entry.writeUInt16LE(1, 4);  // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12); // offset
  fs.writeFileSync(path.join(outDir, '..', 'icon.ico'), Buffer.concat([header, entry, png]));
  console.log('icon.ico written (256x256)');
}
