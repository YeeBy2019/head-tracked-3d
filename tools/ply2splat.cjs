#!/usr/bin/env node
/**
 * 3DGS .ply -> antimatter15 .splat converter
 *
 * 3DGS PLY vertex properties (all float32, little endian):
 *   x y z  nx ny nz  f_dc_0..2  f_rest_0..44  opacity  scale_0..2  rot_0..3
 *
 * .splat per-splat layout (32 bytes):
 *   position  : 3 x float32
 *   scale     : 3 x float32   (linear, exp() already applied)
 *   color     : 4 x uint8     (RGB + alpha)
 *   rotation  : 4 x uint8     (normalized quat, mapped to 0..255)
 *
 * Usage:
 *   node ply2splat.js <in.ply> <out.splat> [maxSplats]
 */
const fs = require("fs");
const path = require("path");

const SH_C0 = 0.28209479177387814;

function readHeader(buf) {
  const marker = Buffer.from("end_header");
  const idx = buf.indexOf(marker);
  if (idx < 0) throw new Error("end_header not found");
  const headerEnd = buf.indexOf(Buffer.from("\n"), idx) + 1;
  const header = buf.slice(0, headerEnd).toString("ascii");
  const lines = header.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  let vertexCount = 0;
  const props = [];
  let inVertex = false;
  for (const line of lines) {
    if (line.startsWith("element vertex")) {
      vertexCount = parseInt(line.split(/\s+/)[2], 10);
      inVertex = true;
      continue;
    }
    if (line.startsWith("element ")) {
      inVertex = false;
      continue;
    }
    if (inVertex && line.startsWith("property float")) {
      props.push(line.split(/\s+/).pop());
    }
  }
  return { headerEnd, vertexCount, props };
}

function main() {
  const [, , inPath, outPath, maxSplatsArg] = process.argv;
  if (!inPath || !outPath) {
    console.error("usage: node ply2splat.js <in.ply> <out.splat> [maxSplats]");
    process.exit(1);
  }
  const maxSplats = maxSplatsArg ? parseInt(maxSplatsArg, 10) : Infinity;

  console.log(`reading ${inPath} ...`);
  const buf = fs.readFileSync(inPath);
  const { headerEnd, vertexCount, props } = readHeader(buf);
  console.log(`vertices=${vertexCount} props=${props.length}`);
  console.log(props.join(","));

  const stride = props.length * 4;
  const expected = headerEnd + vertexCount * stride;
  if (buf.length < expected) {
    throw new Error(`file truncated: have ${buf.length}, need ${expected}`);
  }

  const offsetOf = {};
  props.forEach((p, i) => (offsetOf[p] = headerEnd + i * 4));

  const idx = (name) => {
    const i = props.indexOf(name);
    if (i < 0) throw new Error(`missing property ${name}`);
    return headerEnd + i * 4;
  };

  const ox = idx("x"), oy = idx("y"), oz = idx("z");
  const odc0 = idx("f_dc_0"), odc1 = idx("f_dc_1"), odc2 = idx("f_dc_2");
  const oop = idx("opacity");
  const os0 = idx("scale_0"), os1 = idx("scale_1"), os2 = idx("scale_2");
  const or0 = idx("rot_0"), or1 = idx("rot_1"), or2 = idx("rot_2"), or3 = idx("rot_3");

  // Pass 1: decide which splats to keep (importance = opacity * mean linear scale)
  let keep = null;
  if (vertexCount > maxSplats) {
    console.log(`decimating to ${maxSplats} splats by importance ...`);
    const scores = new Float64Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) {
      const base = headerEnd + i * stride;
      const a = 1 / (1 + Math.exp(-buf.readFloatLE(base + oop - headerEnd)));
      const sx = Math.exp(buf.readFloatLE(base + os0 - headerEnd));
      const sy = Math.exp(buf.readFloatLE(base + os1 - headerEnd));
      const sz = Math.exp(buf.readFloatLE(base + os2 - headerEnd));
      const s = Math.cbrt(sx * sy * sz);
      // 远处 / 近处都一样处理：只按"视觉贡献"排序
      scores[i] = a * s;
    }
    const order = Array.from({ length: vertexCount }, (_, i) => i);
    order.sort((a, b) => scores[b] - scores[a]);
    keep = order.slice(0, maxSplats).sort((a, b) => a - b);
    console.log(`kept ${keep.length}`);
  }

  const count = keep ? keep.length : vertexCount;
  const out = Buffer.allocUnsafe(count * 32);
  let o = 0;
  let minScale = Infinity, maxScale = 0;

  for (let k = 0; k < count; k++) {
    const src = keep ? keep[k] : k;
    const base = headerEnd + src * stride;

    const x = buf.readFloatLE(base + ox - headerEnd);
    const y = buf.readFloatLE(base + oy - headerEnd);
    const z = buf.readFloatLE(base + oz - headerEnd);

    let s0 = Math.exp(buf.readFloatLE(base + os0 - headerEnd));
    let s1 = Math.exp(buf.readFloatLE(base + os1 - headerEnd));
    let s2 = Math.exp(buf.readFloatLE(base + os2 - headerEnd));
    minScale = Math.min(minScale, s0, s1, s2);
    maxScale = Math.max(maxScale, s0, s1, s2);

    const dc0 = buf.readFloatLE(base + odc0 - headerEnd);
    const dc1 = buf.readFloatLE(base + odc1 - headerEnd);
    const dc2 = buf.readFloatLE(base + odc2 - headerEnd);
    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    const r = Math.round(clamp01(0.5 + SH_C0 * dc0) * 255);
    const g = Math.round(clamp01(0.5 + SH_C0 * dc1) * 255);
    const b = Math.round(clamp01(0.5 + SH_C0 * dc2) * 255);

    const op = buf.readFloatLE(base + oop - headerEnd);
    const alpha = Math.round(clamp01(1 / (1 + Math.exp(-op))) * 255);

    let q0 = buf.readFloatLE(base + or0 - headerEnd);
    let q1 = buf.readFloatLE(base + or1 - headerEnd);
    let q2 = buf.readFloatLE(base + or2 - headerEnd);
    let q3 = buf.readFloatLE(base + or3 - headerEnd);
    const qlen = Math.hypot(q0, q1, q2, q3) || 1;
    q0 /= qlen; q1 /= qlen; q2 /= qlen; q3 /= qlen;

    out.writeFloatLE(x, o); o += 4;
    out.writeFloatLE(y, o); o += 4;
    out.writeFloatLE(z, o); o += 4;
    out.writeFloatLE(s0, o); o += 4;
    out.writeFloatLE(s1, o); o += 4;
    out.writeFloatLE(s2, o); o += 4;
    out.writeUInt8(r, o++);
    out.writeUInt8(g, o++);
    out.writeUInt8(b, o++);
    out.writeUInt8(alpha, o++);
    const qb = (v) => Math.max(0, Math.min(255, Math.round(v * 128 + 128)));
    out.writeUInt8(qb(q0), o++);
    out.writeUInt8(qb(q1), o++);
    out.writeUInt8(qb(q2), o++);
    out.writeUInt8(qb(q3), o++);
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, out);
  console.log(`wrote ${outPath}: ${count} splats, ${(out.length / 1048576).toFixed(1)} MB`);
  console.log(`linear scale range: ${minScale.toExponential(2)} .. ${maxScale.toExponential(2)}`);
}

main();
