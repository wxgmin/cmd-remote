// Generate simple PNG icons without external deps (pure Node zlib).
// Draws the ">_" glyph on a gradient background.
import zlib from 'zlib';
import fs from 'fs';

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

function makeIcon(size) {
  const px = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    px[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      // Gradient background #4f8cff -> #7c5cff
      const t = (x + y) / (2 * size);
      const r = Math.round(0x4f + (0x7c - 0x4f) * t);
      const g = Math.round(0x8c + (0x5c - 0x8c) * t);
      const b = Math.round(0xff + (0xff - 0xff) * t);
      // Dark rounded-rect "terminal" area in the middle
      const inset = size * 0.18;
      const inRect = x > inset && x < size - inset && y > inset * 1.4 && y < size - inset * 1.4;
      // Simple ">_" shape: chevron bars
      const cx = x - size / 2;
      const cy = y - size / 2;
      const chevron = inRect &&
        (Math.abs(cy) < size * 0.12) &&
        (cx > -size * 0.22 && cx < size * 0.22);
      const underscore = inRect && Math.abs(cy - size * 0.18) < size * 0.05 &&
        cx > -size * 0.18 && cx < size * 0.18;
      if (chevron || underscore) {
        px[o++] = 15; px[o++] = 17; px[o++] = 21; px[o++] = 255;
      } else {
        px[o++] = r; px[o++] = g; px[o++] = b; px[o++] = 255;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const idat = zlib.deflateSync(px);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) {
  fs.writeFileSync(`public/icon-${size}.png`, makeIcon(size));
  console.log(`public/icon-${size}.png written (${size}x${size})`);
}
