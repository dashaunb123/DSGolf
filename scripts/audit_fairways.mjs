#!/usr/bin/env node
// Audit fairway-zone coverage of the route between adjacent fairway zones
// for every hole defined in src/layout.ts. A "small gap" along this route
// reproduces the "I'm on the fairway but lie says Rough" complaint.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, "..", "src", "layout.ts"), "utf8");

const YD = 0.9144;
// Must stay in sync with the `margin` constant in pointInFairwayZone (layout.ts).
// Any gap up to this size is absorbed by edge forgiveness at classification time.
const CLASSIFY_MARGIN_M = 2.0;
// Gaps larger than this are treated as intentional rough/hazard (forced
// carry, split fairway around a center bunker, approach to green). Anything
// between CLASSIFY_MARGIN_M and this is a coverage bug.
const DESIGN_GAP_M = 4.5;

function extractHoles(source) {
  const holes = [];
  const positions = [];
  const numberRe = /\bnumber:\s*(\d+),/g;
  let m;
  while ((m = numberRe.exec(source)) !== null) positions.push({ number: +m[1], start: m.index });
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].start;
    const end = i + 1 < positions.length ? positions[i + 1].start : source.length;
    const block = source.slice(start, end);
    const yardage = +block.match(/yardage:\s*([\d.]+)/)[1];
    const greenRadius = +block.match(/greenRadius:\s*([\d.]+)/)[1];
    holes.push({ number: positions[i].number, yardage, greenRadius, fairways: extractFairways(block) });
  }
  return holes;
}

function extractFairways(block) {
  const idx = block.indexOf("fairways:");
  if (idx === -1) return null;
  let i = block.indexOf("[", idx);
  let depth = 0, end = -1;
  for (let j = i; j < block.length; j++) {
    if (block[j] === "[") depth++;
    else if (block[j] === "]") { depth--; if (depth === 0) { end = j; break; } }
  }
  const arr = block.slice(i + 1, end);
  const zones = [];
  const zoneRe = /\{\s*kind:\s*"(circle|rect)",([^}]+)\}/g;
  let m;
  while ((m = zoneRe.exec(arr)) !== null) {
    const kind = m[1], body = m[2];
    const get = (k) => { const r = body.match(new RegExp(k + ":\\s*(-?[\\d.]+)")); return r ? +r[1] : undefined; };
    if (kind === "circle") zones.push({ kind, x: get("x"), z: get("z"), r: get("r") });
    else zones.push({ kind, x: get("x"), z: get("z"), w: get("w"), d: get("d"), rot: get("rot") ?? 0 });
  }
  return zones;
}

function inRect(px, pz, z) {
  const rot = z.rot || 0, dx = px - z.x, dz = pz - z.z;
  const c = Math.cos(-rot), s = Math.sin(-rot);
  return Math.abs(dx * c - dz * s) <= z.w / 2 && Math.abs(dx * s + dz * c) <= z.d / 2;
}
function inCircle(px, pz, z) { return Math.hypot(px - z.x, pz - z.z) <= z.r; }
function inAny(px, pz, fs) { return fs.some(z => z.kind === "circle" ? inCircle(px, pz, z) : inRect(px, pz, z)); }
function distTo(px, pz, z) {
  if (z.kind === "circle") return Math.hypot(px - z.x, pz - z.z) - z.r;
  const rot = z.rot || 0, dx = px - z.x, dz = pz - z.z;
  const c = Math.cos(-rot), s = Math.sin(-rot);
  const lx = dx * c - dz * s, lz = dx * s + dz * c;
  return Math.hypot(Math.max(Math.abs(lx) - z.w / 2, 0), Math.max(Math.abs(lz) - z.d / 2, 0));
}

const holes = extractHoles(src);
let bugs = 0;
for (const h of holes) {
  const length = h.yardage * YD;
  const fairways = h.fairways ?? [{ kind: "rect", x: 0, z: 0, w: 12, d: length - 10 }];
  if (fairways.length < 2) { console.log(`Hole ${h.number}: single zone ✓`); continue; }
  const order = [...fairways].sort((a, b) => b.z - a.z);
  const reports = [];
  for (let i = 0; i < order.length - 1; i++) {
    const a = order[i], b = order[i + 1];
    const steps = Math.max(80, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) * 6));
    let gap = 0, at = null;
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const px = a.x + (b.x - a.x) * t, pz = a.z + (b.z - a.z) * t;
      if (!inAny(px, pz, fairways)) {
        const d = Math.min(...fairways.map(z => distTo(px, pz, z)));
        if (d > gap) { gap = d; at = { px, pz }; }
      }
    }
    if (gap > 0.05) reports.push({ seg: `${i}->${i+1}`, gap: +gap.toFixed(2), at });
  }
  const small = reports.filter(r => r.gap > CLASSIFY_MARGIN_M && r.gap < DESIGN_GAP_M);
  const designed = reports.filter(r => r.gap >= DESIGN_GAP_M);
  if (!small.length) {
    console.log(`Hole ${h.number}: ✓${designed.length ? ` (${designed.length} designed gap${designed.length > 1 ? "s" : ""})` : ""}`);
  } else {
    bugs += small.length;
    console.log(`Hole ${h.number}: ⚠ ${small.length} small gap(s)`);
    for (const r of small) console.log(`     seg ${r.seg} gap=${r.gap}m at (${r.at.px.toFixed(2)}, ${r.at.pz.toFixed(2)})`);
  }
}
console.log(bugs === 0 ? "\nAll holes clean." : `\n${bugs} bug-shaped gap(s) remain.`);
process.exit(bugs === 0 ? 0 : 1);
