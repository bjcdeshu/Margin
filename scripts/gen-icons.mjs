/**
 * Pure Node.js PNG generator (zero native deps) for Margin's Quiet Paper editorial "M" icons.
 * Generates 16x16, 32x32, 48x48, and 128x128 RGBA PNGs in public/icons/.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const iconsDir = path.resolve(__dirname, '..', 'public', 'icons');
fs.mkdirSync(iconsDir, { recursive: true });

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePngRgba(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

function sdRoundedBox(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  const out = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return out + inside - r;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2)) : 0;
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

function blend(dst, src, alpha) {
  const a = Math.max(0, Math.min(1, alpha));
  return [
    dst[0] * (1 - a) + src[0] * a,
    dst[1] * (1 - a) + src[1] * a,
    dst[2] * (1 - a) + src[2] * a,
    Math.max(dst[3], a * 255),
  ];
}

function renderMarginIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  // Quiet Paper tokens: paper #fbfaf6, frame #8c5a21, accent #b9833d, ink #20211f
  const PAPER = [251, 250, 246];
  const BORDER = [140, 90, 33];
  const ACCENT = [185, 131, 61];
  const INK = [32, 33, 31];

  const s = size;
  const pad = s * 0.06;
  const radius = s * 0.2;
  const borderWidth = Math.max(1, s * 0.045);

  for (let y = 0; y < s; y += 1) {
    for (let x = 0; x < s; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      let col = [0, 0, 0, 0];

      const dOuter = sdRoundedBox(px, py, s / 2, s / 2, s / 2 - pad, s / 2 - pad, radius);
      const outerAlpha = Math.max(0, Math.min(1, 0.5 - dOuter));

      if (outerAlpha > 0) {
        col = [PAPER[0], PAPER[1], PAPER[2], outerAlpha * 255];

        // Subtle border stroke
        const dInner = dOuter + borderWidth;
        const borderMask = Math.max(0, Math.min(1, 0.5 + dInner));
        col = blend(col, BORDER, borderMask * 0.88);

        // Left editorial margin rule (#b9833d)
        const ruleX = s * 0.22;
        const dRule = distToSegment(px, py, ruleX, s * 0.23, ruleX, s * 0.77) - Math.max(0.75, s * 0.032);
        const ruleAlpha = Math.max(0, Math.min(1, 0.5 - dRule));
        col = blend(col, ACCENT, ruleAlpha);

        // Crisp editorial "M" glyph on the right of the margin rule
        const stroke = Math.max(0.85, s * 0.052);
        const xL = s * 0.35;
        const xM = s * 0.555;
        const xR = s * 0.76;
        const yT = s * 0.27;
        const yV = s * 0.62;
        const yB = s * 0.74;

        const dM = Math.min(
          distToSegment(px, py, xL, yT, xL, yB) - stroke,
          distToSegment(px, py, xR, yT, xR, yB) - stroke,
          distToSegment(px, py, xL, yT, xM, yV) - stroke * 0.9,
          distToSegment(px, py, xR, yT, xM, yV) - stroke * 0.9,
        );
        const mAlpha = Math.max(0, Math.min(1, 0.5 - dM));
        col = blend(col, INK, mAlpha);

        col[3] = outerAlpha * 255;
      }

      const idx = (y * s + x) * 4;
      buf[idx] = Math.round(col[0]);
      buf[idx + 1] = Math.round(col[1]);
      buf[idx + 2] = Math.round(col[2]);
      buf[idx + 3] = Math.round(col[3]);
    }
  }
  return encodePngRgba(size, size, buf);
}

for (const size of [16, 32, 48, 128]) {
  const png = renderMarginIcon(size);
  fs.writeFileSync(path.join(iconsDir, `${size}.png`), png);
}
console.log('[margin] Generated Quiet Paper editorial icons (16, 32, 48, 128).');
