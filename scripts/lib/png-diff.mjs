/* global Buffer */
/**
 * A PNG decoder and a masked pixel differ, in Node's standard library.
 *
 * WHY NOT A DEPENDENCY. The visual gate needs exact per-pixel comparison of
 * Chrome's own screenshots, and Chrome writes two shapes: 8-bit truecolour, with
 * alpha (type 6) or without (type 2), never interlaced. Decoding that is
 * `zlib.inflateSync` plus the five PNG filters — about seventy lines — and `sharp`
 * or `pngjs` would add a native build or a dependency to the tree for a script that
 * runs only during a launch audit.
 *
 * Anything Chrome does not emit is REFUSED rather than guessed at: an interlaced,
 * 16-bit or palette PNG throws, so a decoder that silently mis-reads a file can
 * never be the reason a comparison passes. Output is always RGBA, so a run that
 * captured an opaque page and a baseline that captured a transparent one still
 * compare — the alpha column is the difference, and it is a real one.
 */
import { inflateSync } from "node:zlib";

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** @returns {{width:number,height:number,data:Buffer}} RGBA, 4 bytes per pixel. */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error("not a PNG");
  let off = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const colour = body[9];
      const interlace = body[12];
      if (depth !== 8 || (colour !== 6 && colour !== 2) || interlace !== 0) {
        throw new Error(`unsupported PNG: depth ${depth}, colour ${colour}, interlace ${interlace}`);
      }
      channels = colour === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  if (!width || !height) throw new Error("PNG had no IHDR");

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let p = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[p];
    p += 1;
    const line = raw.subarray(p, p + stride);
    p += stride;
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : out.subarray((y - 1) * stride, y * stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? row[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      const v = line[x];
      switch (filter) {
        case 0: row[x] = v; break;
        case 1: row[x] = (v + a) & 0xff; break;
        case 2: row[x] = (v + b) & 0xff; break;
        case 3: row[x] = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const pa = Math.abs(b - c);
          const pb = Math.abs(a - c);
          const pc = Math.abs(a + b - 2 * c);
          row[x] = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
          break;
        }
        default: throw new Error(`unknown PNG filter ${filter}`);
      }
    }
  }
  if (channels === 4) return { width, height, data: out };
  // Widen RGB to RGBA once, here, so every caller sees one pixel layout.
  const rgba = Buffer.alloc(width * height * 4, 0xff);
  for (let i = 0, j = 0; i < out.length; i += 3, j += 4) {
    rgba[j] = out[i];
    rgba[j + 1] = out[i + 1];
    rgba[j + 2] = out[i + 2];
  }
  return { width, height, data: rgba };
}

/**
 * Compares two decoded images, ignoring pixels inside any mask rectangle.
 *
 * `tolerance` is per channel and deliberately small (8/255 by default): it absorbs
 * the sub-pixel text rendering that differs between two runs of the same build,
 * and nothing else. A 12px padding change or a shifted hue moves whole regions and
 * is reported. `worst` is the bounding box of everything that differed, so a
 * reviewer is pointed at where rather than only told how much.
 */
export function diffPixels(a, b, { masks = [], tolerance = 8 } = {}) {
  if (a.width !== b.width || a.height !== b.height) {
    return {
      comparable: false,
      reason: `size ${b.width}x${b.height} vs baseline ${a.width}x${a.height}`,
      differing: -1, considered: 0, ratio: 1, worst: null,
    };
  }
  const inMask = (x, y) =>
    masks.some((m) => x >= m.x && x < m.x + m.w && y >= m.y && y < m.y + m.h);
  let differing = 0;
  let considered = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < a.height; y += 1) {
    for (let x = 0; x < a.width; x += 1) {
      if (inMask(x, y)) continue;
      considered += 1;
      const i = (y * a.width + x) * 4;
      if (
        Math.abs(a.data[i] - b.data[i]) > tolerance ||
        Math.abs(a.data[i + 1] - b.data[i + 1]) > tolerance ||
        Math.abs(a.data[i + 2] - b.data[i + 2]) > tolerance ||
        Math.abs(a.data[i + 3] - b.data[i + 3]) > tolerance
      ) {
        differing += 1;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  return {
    comparable: true,
    reason: "",
    differing,
    considered,
    ratio: considered === 0 ? 0 : differing / considered,
    worst: x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 },
  };
}
