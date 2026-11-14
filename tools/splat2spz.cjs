#!/usr/bin/env node
/**
 * .splat -> .spz（SPZ v2）转换器
 *
 * 为什么自己写：@mkkellogg/gaussian-splats-3d 内置的 SpzLoader 只解 version 1/2，
 * 而现成的转换工具（@playcanvas/splat-transform）最低只写 v3，
 * 两者对不上。SPZ 的布局很小，照着库里的解码器写一份编码器最省事。
 *
 * 布局（全部小端，整份文件 gzip 压缩）：
 *   header 16 B : magic "NGSP"(0x5053474e) / version=2 / numPoints / shDegree / fractionalBits / flags / reserved
 *   positions   : numPoints × 9 B，每个分量 24 位定点（有符号），值 = 原始坐标 × 2^fractionalBits
 *   alphas      : numPoints × 1 B
 *   colors      : numPoints × 3 B，值 = ((rgb/255 − 0.5) / SH_C0 × 0.15 + 0.5) × 255
 *   scales      : numPoints × 3 B，值 = (ln(线性尺度) + 10) × 16
 *   rotations   : numPoints × 3 B，四元数 xyz，值 = (分量 + 1) × 127.5，w 由 1 − |xyz|² 解出
 *                 （输入 .splat 的四个旋转字节顺序是 w,x,y,z）
 *   sh          : shDegree 为 0 时为空
 *
 * 库假定四元数 w ≥ 0（它把 w 当正的还原），所以 w 为负时先把整个四元数取反。
 *
 * 用法: node tools/splat2spz.cjs <in.splat> <out.spz>
 */
const fs = require("fs");
const zlib = require("zlib");

const MAGIC = 0x5053474e; // "NGSP"
const VERSION = 2;
const FRACTIONAL_BITS = 12; // 1/4096 ≈ 0.24 mm，远小于高斯间距
const SH_C0 = 0.28209479177387814;
const COLOR_SCALE = 0.15;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const toByte = (v) => clamp(Math.round(v), 0, 255);

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("usage: node tools/splat2spz.cjs <in.splat> <out.spz>");
  process.exit(1);
}

const src = fs.readFileSync(inPath);
if (src.length % 32 !== 0) {
  console.error(`坏文件：长度 ${src.length} 不是 32 的整数倍`);
  process.exit(1);
}
const count = src.length / 32;

const header = Buffer.alloc(16);
header.writeUInt32LE(MAGIC, 0);
header.writeUInt32LE(VERSION, 4);
header.writeUInt32LE(count, 8);
header.writeUInt8(0, 12); // shDegree
header.writeUInt8(FRACTIONAL_BITS, 13);
header.writeUInt8(0, 14); // flags
header.writeUInt8(0, 15); // reserved

const positions = Buffer.allocUnsafe(count * 9);
const alphas = Buffer.allocUnsafe(count);
const colors = Buffer.allocUnsafe(count * 3);
const scales = Buffer.allocUnsafe(count * 3);
const rotations = Buffer.allocUnsafe(count * 3);

const fixedScale = 1 << FRACTIONAL_BITS;

for (let i = 0; i < count; i++) {
  const o = i * 32;

  // 位置：float32 -> 24 位定点
  for (let j = 0; j < 3; j++) {
    const v = src.readFloatLE(o + j * 4) * fixedScale;
    const fixed = clamp(Math.round(v), -0x800000, 0x7fffff);
    const base = i * 9 + j * 3;
    positions[base] = fixed & 0xff;
    positions[base + 1] = (fixed >> 8) & 0xff;
    positions[base + 2] = (fixed >> 16) & 0xff;
  }

  // 颜色：.splat 的 0..255 -> SPZ 的 0..255（两边量化基准不同，要反解一次）
  for (let j = 0; j < 3; j++) {
    const c = src[o + 24 + j] / 255;
    const packed = ((c - 0.5) / SH_C0) * COLOR_SCALE + 0.5;
    colors[i * 3 + j] = toByte(packed * 255);
  }

  // 尺度：线性值 -> log 量化
  for (let j = 0; j < 3; j++) {
    const s = src.readFloatLE(o + 12 + j * 4);
    scales[i * 3 + j] = toByte((Math.log(Math.max(s, 1e-9)) + 10) * 16);
  }

  // 旋转：.splat 的字节 28..31 是 w,x,y,z（不是 x,y,z,w）。
  // 依据库里 SplatParser：new Quaternion(r[1], r[2], r[3], r[0])。
  let qw = (src[o + 28] - 128) / 128;
  let qx = (src[o + 29] - 128) / 128;
  let qy = (src[o + 30] - 128) / 128;
  let qz = (src[o + 31] - 128) / 128;
  const qlen = Math.hypot(qw, qx, qy, qz) || 1;
  qw /= qlen;
  qx /= qlen;
  qy /= qlen;
  qz /= qlen;
  // 库按 w = sqrt(1 - |xyz|²) 还原，必须保证 w 不为负、且 xyz 落在单位球内
  if (qw < 0) {
    qx = -qx;
    qy = -qy;
    qz = -qz;
  }
  const sq = qx * qx + qy * qy + qz * qz;
  if (sq > 1) {
    const k = 0.9999 / Math.sqrt(sq);
    qx *= k;
    qy *= k;
    qz *= k;
  }
  rotations[i * 3] = toByte((qx + 1) * 127.5);
  rotations[i * 3 + 1] = toByte((qy + 1) * 127.5);
  rotations[i * 3 + 2] = toByte((qz + 1) * 127.5);

  alphas[i] = src[o + 27];
}

const raw = Buffer.concat([header, positions, alphas, colors, scales, rotations]);
const gz = zlib.gzipSync(raw, { level: 9 });
fs.writeFileSync(outPath, gz);

console.log(
  `${count} splats -> ${(gz.length / 1048576).toFixed(1)} MiB ` +
    `(raw ${(raw.length / 1048576).toFixed(1)} MiB, ${(gz.length / raw.length * 100).toFixed(0)}%)`
);
