import * as THREE from "three";

const yd = 0.9144;

export type FairwayZone =
  | { kind: "rect"; x: number; z: number; w: number; d: number; rot?: number }
  | { kind: "circle"; x: number; z: number; r: number };

export type BunkerZone = {
  x: number;
  z: number;
  rx: number;
  rz: number;
};

export type TreeSpec = { x: number; z: number; scale?: number };

export type HoleSpec = {
  number: number;
  par: number;
  yardage: number;
  fairwayWidth: number;
  greenRadius: number;
  cupOffsetX: number;
  cupOffsetZ: number;
  bunkerSide: -1 | 1;
  bunkerForward: number;
  name?: string;
  fairways?: FairwayZone[];
  bunkers?: BunkerZone[];
  trees?: TreeSpec[];
};

/**
 * 18-hole course. The first 3 holes are the originals; holes 4-18 each have
 * custom fairway/bunker/tree layouts (doglegs, islands, ridges, etc.) so
 * routing matters even though gameplay rules are unchanged.
 *
 * Coordinate system: tee starts at +z, green at -z. Positive z is "behind"
 * the tee, negative z is forward toward the green. Positive x is right.
 */
export const COURSE_HOLES: HoleSpec[] = [
  {
    number: 1,
    par: 3,
    yardage: 165,
    fairwayWidth: 12,
    greenRadius: 5,
    cupOffsetX: 0.6,
    cupOffsetZ: -0.4,
    bunkerSide: -1,
    bunkerForward: 0.5,
    name: "Opening Salvo",
  },
  {
    number: 2,
    par: 4,
    yardage: 325,
    fairwayWidth: 14,
    greenRadius: 5.5,
    cupOffsetX: -0.8,
    cupOffsetZ: 0.15,
    bunkerSide: 1,
    bunkerForward: -0.8,
    name: "Straightaway",
  },
  {
    number: 3,
    par: 5,
    yardage: 545,
    fairwayWidth: 16,
    greenRadius: 6.2,
    cupOffsetX: 1.1,
    cupOffsetZ: -0.25,
    bunkerSide: -1,
    bunkerForward: 0.3,
    name: "Snake Run",
    fairways: [
      { kind: "rect", x: 0, z: 164, w: 22, d: 160, rot: -0.06 },
      { kind: "circle", x: -14, z: 86, r: 27 },
      { kind: "circle", x: -8, z: 40, r: 18 },
      { kind: "rect", x: -18, z: 28, w: 26, d: 112, rot: -0.38 },
      { kind: "circle", x: 7, z: -48, r: 24 },
      { kind: "rect", x: 20, z: -123, w: 16, d: 150, rot: 0.28 },
      { kind: "circle", x: 5, z: -200, r: 20 },
    ],
    bunkers: [
      { x: -31, z: 88, rx: 4.2, rz: 8.5 },
      { x: 1, z: 8, rx: 3.8, rz: 7.8 },
      { x: 35, z: -118, rx: 4.4, rz: 9.5 },
      { x: -9, z: -207, rx: 5.2, rz: 4.2 },
    ],
    trees: [
      { x: 26, z: 82, scale: 1.9 },
      { x: 31, z: 34, scale: 1.6 },
      { x: -42, z: -12, scale: 1.8 },
      { x: -30, z: -92, scale: 1.7 },
      { x: 43, z: -188, scale: 1.9 },
    ],
  },
  // 4: Short par-3 island green – tiny patch of fairway floating in rough.
  {
    number: 4,
    par: 3,
    yardage: 145,
    fairwayWidth: 10,
    greenRadius: 4.8,
    cupOffsetX: 0,
    cupOffsetZ: 0.4,
    bunkerSide: 1,
    bunkerForward: 0,
    name: "The Island",
    fairways: [
      { kind: "circle", x: 0, z: 55, r: 9 },
      { kind: "circle", x: 0, z: 10, r: 7 },
    ],
    bunkers: [
      { x: -7, z: -55, rx: 3.4, rz: 3.2 },
      { x: 7, z: -55, rx: 3.4, rz: 3.2 },
      { x: 0, z: -48, rx: 2.4, rz: 2.4 },
    ],
    trees: [
      { x: -14, z: 30, scale: 1.6 },
      { x: 14, z: 30, scale: 1.6 },
      { x: -16, z: -30, scale: 1.8 },
      { x: 16, z: -30, scale: 1.8 },
    ],
  },
  // 5: Sharp dogleg-left par-4.
  {
    number: 5,
    par: 4,
    yardage: 360,
    fairwayWidth: 14,
    greenRadius: 5.6,
    cupOffsetX: -1.0,
    cupOffsetZ: 0.1,
    bunkerSide: 1,
    bunkerForward: -0.5,
    name: "Hook Shot",
    fairways: [
      { kind: "rect", x: 4, z: 100, w: 16, d: 140, rot: 0.12 },
      { kind: "circle", x: -2, z: 28, r: 26 },
      { kind: "circle", x: -9, z: -10, r: 14 },
      { kind: "rect", x: -16, z: -55, w: 16, d: 130, rot: -0.45 },
    ],
    bunkers: [
      { x: 22, z: 92, rx: 4.0, rz: 6.5 },
      { x: 4, z: 18, rx: 3.6, rz: 3.6 },
      { x: -32, z: -90, rx: 4.2, rz: 5.5 },
    ],
    trees: [
      { x: 24, z: 130, scale: 1.7 },
      { x: -22, z: 40, scale: 1.9 },
      { x: 12, z: -40, scale: 1.8 },
      { x: -36, z: -140, scale: 1.6 },
    ],
  },
  // 6: Dogleg-right par-4 around bunker complex.
  {
    number: 6,
    par: 4,
    yardage: 380,
    fairwayWidth: 13,
    greenRadius: 5.4,
    cupOffsetX: 1.2,
    cupOffsetZ: -0.3,
    bunkerSide: -1,
    bunkerForward: 0.4,
    name: "Slice City",
    fairways: [
      { kind: "rect", x: -4, z: 110, w: 22, d: 150, rot: -0.1 },
      { kind: "circle", x: 4, z: 28, r: 27 },
      { kind: "circle", x: 11, z: -15, r: 16 },
      { kind: "rect", x: 18, z: -58, w: 22, d: 140, rot: 0.42 },
    ],
    bunkers: [
      { x: -22, z: 100, rx: 4.0, rz: 6.0 },
      { x: 2, z: 50, rx: 3.6, rz: 3.6 },
      { x: 36, z: -90, rx: 4.4, rz: 5.4 },
    ],
    trees: [
      { x: -24, z: 140, scale: 1.7 },
      { x: 26, z: 28, scale: 1.9 },
      { x: -12, z: -42, scale: 1.6 },
      { x: 38, z: -150, scale: 1.6 },
    ],
  },
  // 7: Long par-5 with split fairway around a central waste bunker.
  {
    number: 7,
    par: 5,
    yardage: 560,
    fairwayWidth: 18,
    greenRadius: 6.0,
    cupOffsetX: 0.4,
    cupOffsetZ: -0.6,
    bunkerSide: 1,
    bunkerForward: 0.5,
    name: "Split Decision",
    fairways: [
      { kind: "rect", x: 0, z: 200, w: 22, d: 90 },
      { kind: "rect", x: -12, z: 90, w: 14, d: 130 },
      { kind: "rect", x: 12, z: 90, w: 14, d: 130 },
      { kind: "rect", x: 0, z: -40, w: 22, d: 130 },
      { kind: "circle", x: 0, z: -200, r: 18 },
    ],
    bunkers: [
      { x: 0, z: 90, rx: 4.5, rz: 30 },
      { x: -22, z: 30, rx: 3.4, rz: 5.2 },
      { x: 22, z: 30, rx: 3.4, rz: 5.2 },
      { x: -8, z: -210, rx: 4.2, rz: 4.0 },
      { x: 10, z: -210, rx: 4.2, rz: 4.0 },
    ],
    trees: [
      { x: -22, z: 200, scale: 1.7 },
      { x: 22, z: 200, scale: 1.7 },
      { x: -28, z: 30, scale: 1.8 },
      { x: 28, z: 30, scale: 1.8 },
      { x: -20, z: -120, scale: 1.6 },
      { x: 20, z: -120, scale: 1.6 },
    ],
  },
  // 8: Drivable par-4 — short, high risk.
  {
    number: 8,
    par: 4,
    yardage: 280,
    fairwayWidth: 11,
    greenRadius: 5.0,
    cupOffsetX: 0,
    cupOffsetZ: 0.2,
    bunkerSide: -1,
    bunkerForward: -1,
    name: "Go For It",
    fairways: [
      { kind: "rect", x: 0, z: 60, w: 12, d: 80 },
      { kind: "rect", x: -6, z: -10, w: 8, d: 60, rot: -0.2 },
      { kind: "circle", x: -2, z: -80, r: 11 },
    ],
    bunkers: [
      { x: 8, z: 20, rx: 4.0, rz: 6.0 },
      { x: -12, z: -30, rx: 3.4, rz: 4.4 },
      { x: 6, z: -85, rx: 3.0, rz: 3.0 },
      { x: -8, z: -90, rx: 3.0, rz: 3.0 },
    ],
    trees: [
      { x: -10, z: 80, scale: 1.6 },
      { x: 12, z: 60, scale: 1.6 },
      { x: 10, z: -10, scale: 1.7 },
      { x: -14, z: -80, scale: 1.5 },
    ],
  },
  // 9: Bowl-shaped par-3 over rough, big elevated green.
  {
    number: 9,
    par: 3,
    yardage: 195,
    fairwayWidth: 8,
    greenRadius: 7.0,
    cupOffsetX: -1.2,
    cupOffsetZ: -0.8,
    bunkerSide: -1,
    bunkerForward: 0,
    name: "Cathedral",
    fairways: [
      { kind: "circle", x: 0, z: 60, r: 8 },
    ],
    bunkers: [
      { x: -8, z: -75, rx: 3.6, rz: 3.6 },
      { x: 8, z: -75, rx: 3.6, rz: 3.6 },
      { x: -10, z: -90, rx: 3.0, rz: 3.0 },
      { x: 10, z: -90, rx: 3.0, rz: 3.0 },
      { x: 0, z: -95, rx: 2.4, rz: 2.4 },
    ],
    trees: [
      { x: -14, z: 30, scale: 1.7 },
      { x: 14, z: 30, scale: 1.7 },
      { x: -16, z: -30, scale: 1.9 },
      { x: 16, z: -30, scale: 1.9 },
      { x: -18, z: -90, scale: 2.0 },
      { x: 18, z: -90, scale: 2.0 },
    ],
  },
  // 10: S-curve double dogleg par-5.
  {
    number: 10,
    par: 5,
    yardage: 520,
    fairwayWidth: 15,
    greenRadius: 5.8,
    cupOffsetX: -0.6,
    cupOffsetZ: -0.3,
    bunkerSide: 1,
    bunkerForward: 0.3,
    name: "Serpent",
    fairways: [
      { kind: "rect", x: 6, z: 180, w: 16, d: 110, rot: 0.18 },
      { kind: "circle", x: -4, z: 90, r: 28 },
      { kind: "rect", x: -14, z: 10, w: 16, d: 130, rot: -0.32 },
      { kind: "circle", x: 6, z: -70, r: 24 },
      { kind: "rect", x: 14, z: -150, w: 16, d: 120, rot: 0.28 },
    ],
    bunkers: [
      { x: 22, z: 200, rx: 4.0, rz: 5.5 },
      { x: -18, z: 100, rx: 4.0, rz: 5.0 },
      { x: 4, z: 10, rx: 3.6, rz: 4.0 },
      { x: -22, z: -40, rx: 4.0, rz: 5.0 },
      { x: 28, z: -140, rx: 4.0, rz: 5.5 },
    ],
    trees: [
      { x: -16, z: 200, scale: 1.7 },
      { x: 26, z: 80, scale: 1.8 },
      { x: -28, z: 0, scale: 1.9 },
      { x: 22, z: -70, scale: 1.6 },
      { x: -16, z: -180, scale: 1.7 },
    ],
  },
  // 11: Cape hole — fairway hugs sand on the left, shortcut over hazard.
  {
    number: 11,
    par: 4,
    yardage: 410,
    fairwayWidth: 14,
    greenRadius: 5.6,
    cupOffsetX: -0.4,
    cupOffsetZ: 0,
    bunkerSide: -1,
    bunkerForward: 0.5,
    name: "The Cape",
    fairways: [
      { kind: "rect", x: 6, z: 110, w: 18, d: 150, rot: 0.08 },
      { kind: "circle", x: 4, z: 25, r: 14 },
      { kind: "rect", x: 2, z: -60, w: 16, d: 150, rot: -0.05 },
    ],
    bunkers: [
      { x: -16, z: 150, rx: 6.0, rz: 30 },
      { x: -10, z: -10, rx: 5.0, rz: 12 },
      { x: 14, z: -120, rx: 4.0, rz: 6.5 },
      { x: -10, z: -140, rx: 4.0, rz: 4.0 },
    ],
    trees: [
      { x: 24, z: 140, scale: 1.7 },
      { x: 22, z: 30, scale: 1.7 },
      { x: 22, z: -90, scale: 1.6 },
      { x: -20, z: -150, scale: 1.6 },
    ],
  },
  // 12: Ridge between two valleys — narrow ribbon fairway.
  {
    number: 12,
    par: 3,
    yardage: 210,
    fairwayWidth: 8,
    greenRadius: 5.4,
    cupOffsetX: 0,
    cupOffsetZ: 0,
    bunkerSide: 1,
    bunkerForward: 0,
    name: "Knife Edge",
    fairways: [
      { kind: "rect", x: 0, z: 0, w: 6, d: 180 },
    ],
    bunkers: [
      { x: -10, z: 70, rx: 5.0, rz: 12 },
      { x: 10, z: 70, rx: 5.0, rz: 12 },
      { x: -10, z: -50, rx: 5.0, rz: 12 },
      { x: 10, z: -50, rx: 5.0, rz: 12 },
    ],
    trees: [
      { x: -16, z: 90, scale: 1.5 },
      { x: 16, z: 90, scale: 1.5 },
      { x: -16, z: -90, scale: 1.5 },
      { x: 16, z: -90, scale: 1.5 },
    ],
  },
  // 13: Horseshoe par-4 wrapping a giant central bunker.
  {
    number: 13,
    par: 4,
    yardage: 395,
    fairwayWidth: 12,
    greenRadius: 5.6,
    cupOffsetX: 0.8,
    cupOffsetZ: -0.4,
    bunkerSide: -1,
    bunkerForward: 0.5,
    name: "Horseshoe",
    fairways: [
      { kind: "rect", x: -16, z: 120, w: 22, d: 130 },
      { kind: "rect", x: 0, z: 40, w: 40, d: 60 },
      { kind: "rect", x: 16, z: -50, w: 22, d: 170 },
    ],
    bunkers: [
      { x: 0, z: 90, rx: 14, rz: 10 },
      { x: -22, z: 30, rx: 3.4, rz: 3.4 },
      { x: 22, z: 30, rx: 3.4, rz: 3.4 },
      { x: 22, z: -130, rx: 3.6, rz: 5.0 },
    ],
    trees: [
      { x: -28, z: 140, scale: 1.7 },
      { x: -28, z: 40, scale: 1.6 },
      { x: 28, z: 40, scale: 1.6 },
      { x: 28, z: -80, scale: 1.7 },
      { x: 8, z: -150, scale: 1.6 },
    ],
  },
  // 14: Punchbowl par-3 — green sunk behind a wall of sand.
  {
    number: 14,
    par: 3,
    yardage: 175,
    fairwayWidth: 11,
    greenRadius: 6.2,
    cupOffsetX: 0,
    cupOffsetZ: -1.0,
    bunkerSide: 1,
    bunkerForward: 0,
    name: "Punchbowl",
    fairways: [
      { kind: "rect", x: 0, z: 30, w: 12, d: 70 },
      { kind: "circle", x: 0, z: -50, r: 9 },
    ],
    bunkers: [
      { x: -10, z: -65, rx: 4.0, rz: 3.4 },
      { x: 10, z: -65, rx: 4.0, rz: 3.4 },
      { x: 0, z: -70, rx: 6.0, rz: 2.0 },
      { x: -8, z: -85, rx: 2.4, rz: 2.4 },
      { x: 8, z: -85, rx: 2.4, rz: 2.4 },
    ],
    trees: [
      { x: -12, z: 50, scale: 1.6 },
      { x: 12, z: 50, scale: 1.6 },
      { x: -14, z: -85, scale: 1.8 },
      { x: 14, z: -85, scale: 1.8 },
    ],
  },
  // 15: Reachable par-5 with a heroic carry over bunkers in two.
  {
    number: 15,
    par: 5,
    yardage: 490,
    fairwayWidth: 16,
    greenRadius: 6.0,
    cupOffsetX: -0.5,
    cupOffsetZ: 0.2,
    bunkerSide: -1,
    bunkerForward: 0.4,
    name: "Hero's Path",
    fairways: [
      { kind: "rect", x: 0, z: 160, w: 18, d: 140 },
      { kind: "circle", x: -2, z: 70, r: 20 },
      { kind: "rect", x: 0, z: -30, w: 16, d: 160 },
      { kind: "circle", x: 0, z: -160, r: 18 },
    ],
    bunkers: [
      { x: 14, z: 160, rx: 4.0, rz: 6.0 },
      { x: -14, z: 40, rx: 4.0, rz: 5.0 },
      { x: 12, z: -60, rx: 4.0, rz: 5.5 },
      { x: -14, z: -110, rx: 5.0, rz: 6.0 },
      { x: 14, z: -110, rx: 5.0, rz: 6.0 },
      { x: -8, z: -175, rx: 3.4, rz: 3.4 },
      { x: 8, z: -175, rx: 3.4, rz: 3.4 },
    ],
    trees: [
      { x: -22, z: 180, scale: 1.7 },
      { x: 22, z: 180, scale: 1.7 },
      { x: 24, z: 60, scale: 1.6 },
      { x: -22, z: -30, scale: 1.7 },
      { x: 22, z: -160, scale: 1.8 },
    ],
  },
  // 16: Right angle dogleg — fairway turns 90° around a stand of trees.
  {
    number: 16,
    par: 4,
    yardage: 340,
    fairwayWidth: 12,
    greenRadius: 5.4,
    cupOffsetX: 0,
    cupOffsetZ: -0.4,
    bunkerSide: -1,
    bunkerForward: 0,
    name: "The Elbow",
    fairways: [
      { kind: "rect", x: 0, z: 100, w: 14, d: 130 },
      { kind: "rect", x: 18, z: 30, w: 30, d: 14 },
      { kind: "rect", x: 30, z: -80, w: 14, d: 130 },
    ],
    bunkers: [
      { x: 10, z: 80, rx: 3.4, rz: 5.0 },
      { x: 36, z: 8, rx: 4.0, rz: 3.4 },
      { x: 30, z: -150, rx: 3.6, rz: 4.4 },
      { x: 22, z: -135, rx: 3.0, rz: 3.0 },
    ],
    trees: [
      { x: -14, z: 100, scale: 1.7 },
      { x: 14, z: 100, scale: 1.7 },
      { x: 18, z: 60, scale: 2.0 },
      { x: 6, z: 22, scale: 2.0 },
      { x: 14, z: 0, scale: 1.9 },
      { x: 44, z: -60, scale: 1.6 },
      { x: 16, z: -120, scale: 1.7 },
    ],
  },
  // 17: Drivable par-3 with massive double-tier green.
  {
    number: 17,
    par: 3,
    yardage: 130,
    fairwayWidth: 9,
    greenRadius: 8.0,
    cupOffsetX: 2.5,
    cupOffsetZ: -1.5,
    bunkerSide: -1,
    bunkerForward: 0.6,
    name: "Postage Tier",
    fairways: [
      { kind: "circle", x: 0, z: 40, r: 7 },
    ],
    bunkers: [
      { x: -9, z: -45, rx: 3.6, rz: 6.0 },
      { x: 9, z: -45, rx: 3.6, rz: 6.0 },
      { x: 0, z: -65, rx: 5.0, rz: 2.2 },
    ],
    trees: [
      { x: -12, z: 20, scale: 1.6 },
      { x: 12, z: 20, scale: 1.6 },
      { x: -14, z: -30, scale: 1.7 },
      { x: 14, z: -30, scale: 1.7 },
      { x: 0, z: -78, scale: 1.5 },
    ],
  },
  // 18: Grand finishing par-5 — long, wide, then a peninsula green.
  {
    number: 18,
    par: 5,
    yardage: 580,
    fairwayWidth: 18,
    greenRadius: 6.4,
    cupOffsetX: 0,
    cupOffsetZ: -0.5,
    bunkerSide: 1,
    bunkerForward: 0.5,
    name: "Closing Argument",
    fairways: [
      { kind: "rect", x: 0, z: 210, w: 24, d: 110 },
      { kind: "rect", x: -2, z: 80, w: 22, d: 160, rot: -0.05 },
      { kind: "circle", x: 4, z: -20, r: 24 },
      { kind: "rect", x: 8, z: -110, w: 18, d: 130, rot: 0.1 },
      { kind: "circle", x: 4, z: -210, r: 20 },
    ],
    bunkers: [
      { x: -16, z: 220, rx: 4.2, rz: 6.0 },
      { x: 18, z: 130, rx: 4.0, rz: 5.5 },
      { x: -16, z: 40, rx: 4.0, rz: 5.0 },
      { x: 22, z: -60, rx: 4.0, rz: 5.5 },
      { x: -10, z: -160, rx: 5.0, rz: 7.0 },
      { x: -10, z: -210, rx: 4.0, rz: 4.0 },
      { x: 18, z: -210, rx: 4.0, rz: 4.0 },
    ],
    trees: [
      { x: -22, z: 240, scale: 1.8 },
      { x: 22, z: 240, scale: 1.8 },
      { x: 24, z: 80, scale: 1.7 },
      { x: -24, z: -20, scale: 1.8 },
      { x: 26, z: -120, scale: 1.7 },
      { x: -20, z: -200, scale: 1.9 },
      { x: 24, z: -200, scale: 1.9 },
    ],
  },
];

export type HoleLayout = ReturnType<typeof makeHoleLayout>;

export function makeHoleLayout(spec: HoleSpec) {
  const length = spec.yardage * yd;
  const halfLen = length / 2;
  const greenZ = -halfLen + spec.greenRadius + 1;
  const defaultBunker = {
    x: spec.bunkerSide * (spec.greenRadius + 1.2),
    z: greenZ + spec.bunkerForward,
    rx: 2.4,
    rz: 2.4,
  };
  const defaultFairways: FairwayZone[] = [
    { kind: "rect", x: 0, z: 0, w: spec.fairwayWidth, d: length - 10 },
  ];

  const fairways: FairwayZone[] = spec.fairways ?? defaultFairways;
  const bunkers: BunkerZone[] = spec.bunkers ?? [defaultBunker];

  return {
    ...spec,
    length,
    halfLen,
    teeZ: halfLen - 4,
    greenZ,
    tee: new THREE.Vector3(0, 0.06, halfLen - 4 + 0.8),
    cup: new THREE.Vector3(spec.cupOffsetX, 0, greenZ + spec.cupOffsetZ),
    cupRadius: 0.14,
    greenCenter: new THREE.Vector3(0, 0, greenZ),
    fairways,
    bunkers,
    trees: spec.trees ?? [],
    bunkerCenter: new THREE.Vector3(defaultBunker.x, 0, defaultBunker.z),
    bunkerRadius: Math.max(defaultBunker.rx, defaultBunker.rz),
  };
}

export const HOLE = COURSE_HOLES[0];
export const POS = makeHoleLayout(HOLE);

export type Surface = "tee" | "green" | "fairway" | "bunker" | "water" | "rough";

const FAIRWAY_LIE_MARGIN = 3.5;

function pointInRotatedFairwayRect(p: THREE.Vector3, zone: Extract<FairwayZone, { kind: "rect" }>, rot: number) {
  const dx = p.x - zone.x;
  const dz = p.z - zone.z;
  const c = Math.cos(-rot);
  const s = Math.sin(-rot);
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  return (
    Math.abs(lx) <= zone.w / 2 + FAIRWAY_LIE_MARGIN &&
    Math.abs(lz) <= zone.d / 2 + FAIRWAY_LIE_MARGIN
  );
}

function pointInFairwayZone(p: THREE.Vector3, zone: FairwayZone) {
  // Classify the playable lie from the visible fairway, not from a razor-thin
  // geometry edge. The margin covers ball radius, antialiasing, and tiny
  // shot-settle offsets that can otherwise make an obviously fairway ball play
  // as rough.
  if (zone.kind === "circle") {
    return Math.hypot(p.x - zone.x, p.z - zone.z) <= zone.r + FAIRWAY_LIE_MARGIN;
  }

  const rot = zone.rot || 0;
  return pointInRotatedFairwayRect(p, zone, rot) || (rot !== 0 && pointInRotatedFairwayRect(p, zone, -rot));
}

function fairwayLieWidth(zone: FairwayZone) {
  if (zone.kind === "circle") return zone.r;
  return Math.min(zone.w / 2, 18);
}

function distanceToSegment2D(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
  const vx = bx - ax;
  const vz = bz - az;
  const wx = px - ax;
  const wz = pz - az;
  const lenSq = vx * vx + vz * vz;
  if (lenSq <= 0.0001) return Math.hypot(px - ax, pz - az);
  const t = THREE.MathUtils.clamp((wx * vx + wz * vz) / lenSq, 0, 1);
  return Math.hypot(px - (ax + vx * t), pz - (az + vz * t));
}

function pointInFairwayConnector(p: THREE.Vector3, a: FairwayZone, b: FairwayZone) {
  const span = Math.hypot(b.x - a.x, b.z - a.z);
  if (span < 1 || span > 125) return false;

  const corridorHalfWidth = THREE.MathUtils.clamp(
    Math.max(8, Math.min(fairwayLieWidth(a), fairwayLieWidth(b))) + FAIRWAY_LIE_MARGIN,
    9,
    20,
  );
  return distanceToSegment2D(p.x, p.z, a.x, a.z, b.x, b.z) <= corridorHalfWidth;
}

function pointInFairwayRoute(p: THREE.Vector3, fairways: FairwayZone[]) {
  for (let i = 0; i < fairways.length - 1; i += 1) {
    if (pointInFairwayConnector(p, fairways[i], fairways[i + 1])) return true;
  }
  return false;
}

export function classifySurface(p: THREE.Vector3, hole: HoleLayout = POS): Surface {
  for (const bunker of hole.bunkers) {
    const dx = (p.x - bunker.x) / bunker.rx;
    const dz = (p.z - bunker.z) / bunker.rz;
    if (dx * dx + dz * dz < 1) return "bunker";
  }

  const dg = Math.hypot(p.x - hole.greenCenter.x, p.z - hole.greenCenter.z);
  if (dg < hole.greenRadius) return "green";

  if (Math.abs(p.x) < 2 && Math.abs(p.z - hole.teeZ) < 1.5) return "tee";

  if (hole.fairways.some((zone) => pointInFairwayZone(p, zone)) || pointInFairwayRoute(p, hole.fairways)) {
    return "fairway";
  }

  return "rough";
}

/** Deceleration applied to a rolling ball, m/s². */
export const ROLL_FRICTION: Record<Surface, number> = {
  green: 1.2,
  fairway: 2.5,
  rough: 7.0,
  bunker: 14.0,
  tee: 1.8,
  water: 0,
};
