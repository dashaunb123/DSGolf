import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Line } from "@react-three/drei";
import { Fragment, Suspense, forwardRef, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Hole } from "./Hole";
import { Player, type SwingState, type SwingMode } from "./Player";
import {
  COURSE_HOLES,
  POS,
  ROLL_FRICTION,
  classifySurface,
  makeHoleLayout,
  type HoleLayout,
  type Surface,
} from "./layout";
import {
  CLUBS,
  GRAVITY,
  SHAPE_CURVE_COEFF,
  clubInitialVelocity,
  simulateFlight,
} from "./clubs";

const CHARGE_DURATION = 1.0; // seconds to fill power 0 → 1
const SWING_DURATION = 0.55; // seconds the whole swing animation lasts
const IMPACT_T = 0.42;       // fraction of swing at which ball is struck
const PUTT_AIM_STEP = 0.007;
const FULL_AIM_STEP = 0.025;
const STOP_SPEED = 0.1;

type Mode = "idle" | "flight" | "rolling" | "holed";
type ViewMode = "play" | "overhead";
type ScreenMode = "menu" | "lobby" | "playing" | "controller";

type ScoreEntry = {
  strokes: number;
  par: number;
};

type HostInfo = {
  code: string;
  clientId: string;
  joinUrl: string;
};

type ServerConfig = {
  publicBaseUrl: string;
  networkMode: "local" | "online";
};

export type GolfPlayer = {
  id: string;
  name: string;
  shirtColor: string;
  pantsColor: string;
  hatColor: string;
  buildId?: PlayerBuildId;
  handedness?: Handedness;
  controllerMount?: ControllerMount;
  source: "local" | "phone";
};

type ControllerMount = "club" | "grip_butt" | "forearm";
type PowerBalanceMode = "realistic" | "relaxed" | "compact";

type GameSettings = {
  powerBalance: PowerBalanceMode;
};

const DEFAULT_GAME_SETTINGS: GameSettings = {
  powerBalance: "realistic",
};

const POWER_BALANCE_OPTIONS: Array<{
  value: PowerBalanceMode;
  label: string;
  note: string;
  fullPowerAt: number;
}> = [
  { value: "realistic", label: "Realistic", note: "full effort for full power", fullPowerAt: 1 },
  { value: "relaxed", label: "Relaxed", note: "85% effort gives 100%", fullPowerAt: 0.85 },
  { value: "compact", label: "Compact", note: "70% effort gives 100%", fullPowerAt: 0.7 },
];

type PlayerBuildId =
  | "default"
  | "mcroar"
  | "big_bryce"
  | "chef_scott"
  | "the_tiger"
  | "x_shuffle";

type PlayerBuild = {
  id: PlayerBuildId;
  name: string;
  power: number;
  control: number;
  path: number;
  putting: number;
};

const PLAYER_BUILDS: PlayerBuild[] = [
  { id: "default", name: "Default", power: 75, control: 65, path: 65, putting: 50 },
  { id: "mcroar", name: "McRoar", power: 98, control: 86, path: 88, putting: 84 },
  { id: "big_bryce", name: "Big Bryce", power: 100, control: 82, path: 80, putting: 78 },
  { id: "chef_scott", name: "Chef Scott", power: 92, control: 97, path: 98, putting: 99 },
  { id: "the_tiger", name: "The Tiger", power: 97, control: 100, path: 100, putting: 100 },
  { id: "x_shuffle", name: "X Shuffle", power: 89, control: 94, path: 95, putting: 94 },
];

const DEFAULT_BUILD = PLAYER_BUILDS[0];

function normalizeBuildId(value: unknown): PlayerBuildId {
  return PLAYER_BUILDS.some((build) => build.id === value)
    ? (value as PlayerBuildId)
    : "default";
}

function normalizeControllerMount(value: unknown): ControllerMount {
  if (value === "forearm") return "forearm";
  if (value === "grip_butt" || value === "gripEnd" || value === "butt_grip") return "grip_butt";
  return "club";
}

function isGripButtMount(value: ControllerMount) {
  return value === "grip_butt";
}

function normalizePowerBalance(value: unknown): PowerBalanceMode {
  return POWER_BALANCE_OPTIONS.some((option) => option.value === value)
    ? (value as PowerBalanceMode)
    : "realistic";
}

function powerBalanceFullPowerAt(mode: PowerBalanceMode) {
  return POWER_BALANCE_OPTIONS.find((option) => option.value === mode)?.fullPowerAt ?? 1;
}

function applyPowerBalance(power: number, mode: PowerBalanceMode, maxPower = 1) {
  const fullPowerAt = powerBalanceFullPowerAt(mode);
  return THREE.MathUtils.clamp(power / fullPowerAt, 0.025, maxPower);
}

function getPlayerBuild(player?: Pick<GolfPlayer, "buildId"> | null): PlayerBuild {
  const id = normalizeBuildId(player?.buildId);
  return PLAYER_BUILDS.find((build) => build.id === id) ?? DEFAULT_BUILD;
}

function powerCarryFactor(build: PlayerBuild) {
  // 75 power is the base bag. 100 power makes the 240 yd driver carry 350 yd.
  const maxPowerFactor = 350 / 240;
  const perPoint = (maxPowerFactor - 1) / 25;
  return THREE.MathUtils.clamp(1 + (build.power - 75) * perPoint, 0.82, maxPowerFactor);
}

function controlShapeFactor(build: PlayerBuild) {
  return THREE.MathUtils.clamp(1 - (build.control - 65) * 0.012, 0.55, 1.06);
}

function pathMissFactor(build: PlayerBuild) {
  return THREE.MathUtils.clamp(1 - (build.path - 65) * 0.012, 0.55, 1.06);
}

function puttingMistakeFactor(build: PlayerBuild) {
  return THREE.MathUtils.clamp(1 - (build.putting - 50) * 0.01, 0.5, 1.1);
}

function isChipShot(
  club: (typeof CLUBS)[number],
  distanceMeters: number,
  surface: Surface,
) {
  if (club.putter) return false;
  if (surface === "green") return false;
  return distanceMeters <= 50 && club.loft >= 0.57;
}

function effectiveClubForBuild(club: (typeof CLUBS)[number], build: PlayerBuild) {
  if (club.putter) return club;
  return { ...club, carry: club.carry * powerCarryFactor(build) };
}

function lieCarryFactor(club: (typeof CLUBS)[number], surface: Surface) {
  if (club.putter) return 1;
  if (surface === "tee" || surface === "fairway" || surface === "green") return 1;
  const loft = club.loft;
  if (surface === "rough") {
    if (loft < 0.3) return 0.62;
    if (loft < 0.45) return 0.72;
    if (loft < 0.72) return 0.84;
    return 0.93;
  }
  if (surface === "bunker") {
    if (loft < 0.45) return 0.18;
    if (loft < 0.72) return 0.36;
    if (loft < 0.95) return 0.68;
    return 0.82;
  }
  return 0.5;
}

function lieLoftAdjustment(club: (typeof CLUBS)[number], surface: Surface) {
  if (club.putter) return 0;
  if (surface === "rough") {
    return club.loft < 0.5 ? -0.04 : club.loft > 0.75 ? 0.03 : 0;
  }
  if (surface === "bunker") {
    return club.loft >= 0.75 ? 0.16 : 0.04;
  }
  return 0;
}

function lieErrorFactor(club: (typeof CLUBS)[number], surface: Surface) {
  if (club.putter) return 1;
  if (surface === "rough") {
    return club.loft < 0.45 ? 1.45 : club.loft < 0.72 ? 1.25 : 1.1;
  }
  if (surface === "bunker") {
    return club.loft < 0.45 ? 2.3 : club.loft < 0.72 ? 1.8 : 1.25;
  }
  return 1;
}

function effectiveClubForLie(club: (typeof CLUBS)[number], surface: Surface) {
  if (club.putter) return club;
  return {
    ...club,
    carry: club.carry * lieCarryFactor(club, surface),
    loft: THREE.MathUtils.clamp(club.loft + lieLoftAdjustment(club, surface), 0.12, 1.35),
    bounce:
      surface === "bunker"
        ? Math.min(0.1, club.bounce)
        : surface === "rough"
          ? club.bounce * 0.75
          : club.bounce,
  };
}

function suggestClubForBuild(
  distanceMeters: number,
  onGreen: boolean,
  player?: Pick<GolfPlayer, "buildId"> | null,
  surface: Surface = "fairway",
) {
  if (onGreen) return CLUBS.findIndex((c) => c.putter);
  const build = getPlayerBuild(player);
  const playable = CLUBS.map((c, i) => ({
    c,
    i,
    carry: effectiveClubForLie(effectiveClubForBuild(c, build), surface).carry,
  })).filter(({ c }) => !c.putter && (surface !== "bunker" || c.loft >= 0.65));
  const ranked = playable
    .filter(({ carry }) => carry >= distanceMeters * 0.92)
    .sort((a, b) => a.carry - b.carry);
  if (ranked.length > 0) return ranked[0].i;
  const bestPlayable = playable.sort((a, b) => b.carry - a.carry)[0];
  if (bestPlayable) return bestPlayable.i;
  return CLUBS.findIndex((c) => c.id === "driver");
}

const PLAYER_PALETTES: Array<{ shirt: string; pants: string; hat: string }> = [
  { shirt: "#d63a3a", pants: "#1f2733", hat: "#1a3a8c" },
  { shirt: "#3a7bd6", pants: "#2a2233", hat: "#d6a83a" },
  { shirt: "#3ad690", pants: "#2c2c2c", hat: "#b91d2d" },
  { shirt: "#d63ac4", pants: "#243042", hat: "#ffffff" },
  { shirt: "#ffb13b", pants: "#2c2c2c", hat: "#2c2c2c" },
  { shirt: "#ffffff", pants: "#1a3a8c", hat: "#b91d2d" },
];

export const SHIRT_OPTIONS = [
  "#d63a3a", "#3a7bd6", "#3ad690", "#d63ac4", "#ffb13b", "#ffffff", "#1a1a1a", "#7a3ad6",
];
export const PANTS_OPTIONS = [
  "#1f2733", "#2a2233", "#2c2c2c", "#243042", "#1a3a8c", "#6e5034", "#3a3a3a", "#d6d6d6",
];
export const HAT_OPTIONS = [
  "#1a3a8c", "#d6a83a", "#b91d2d", "#ffffff", "#2c2c2c", "#3ad690", "#d63ac4", "#ffb13b",
];

export function defaultPlayer(index: number, source: GolfPlayer["source"], id?: string): GolfPlayer {
  const pal = PLAYER_PALETTES[index % PLAYER_PALETTES.length];
  return {
    id: id ?? `local-${index + 1}`,
    name: `Player ${index + 1}`,
    shirtColor: pal.shirt,
    pantsColor: pal.pants,
    hatColor: pal.hat,
    buildId: "default",
    handedness: "right",
    controllerMount: "club",
    source,
  };
}

type PhoneSyncState = {
  clubIdx: number;
  currentPlayerId?: string;
  currentPlayerName?: string;
  currentPlayerBuildId?: PlayerBuildId;
  powerBalance?: PowerBalanceMode;
  isPutter?: boolean;
  distanceMeters?: number;
  surface?: Surface;
  recommendedPower?: number;
};

type Handedness = "right" | "left";

type SwingCalibration = {
  handedness: Handedness;
  controllerMount: ControllerMount;
  gravity: Vec3;
  targetAxis: Vec3;
  calibratedAt: number;
};

type SwingPathFeedback = {
  /** Aim offset in radians; positive misses right of the current aim line. */
  pathError: number;
  /** 0..1, where 1 is a clean on-plane path. */
  pathQuality: number;
  label: string;
  /**
   * Signed shot shape, radians. Positive = fade (curves right of aim
   * for a right-handed player), negative = draw (curves left). Causes
   * Magnus-like in-flight curve.
   */
  shape: number;
};

type ControllerAction =
  | { type: "aim"; delta: number }
  | { type: "club"; index: number }
  | { type: "autoClub" }
  | { type: "pin" }
  | { type: "view" }
  | ({ type: "swing"; power: number } & Partial<SwingPathFeedback>);

type SwingTracePoint = {
  x: number;
  y: number;
  z: number;
  mag: number;
  t?: number;
  rotAlpha?: number;
  rotBeta?: number;
  rotGamma?: number;
};

type GyroSample = {
  t: number;
  alpha: number;
  beta: number;
  gamma: number;
  accel: number;
};

type SwingMotionState = {
  maxAccel: number;
  maxRot: number;
  startedAt: number;
  samples: number;
  pathSamples: number;
  pathVectors: SwingTracePoint[];
  gyroSamples: GyroSample[];
  baseline: { x: number; y: number; z: number };
  gravity: Vec3;
  calibration: SwingCalibration | null;
  hasLinear: boolean;
  armed: boolean;
};

type SwingCapturePhase = "idle" | "settling" | "waiting" | "recording";

type PuttResult = {
  topDownPoints: string;
  tempoRatio: number;
  backTime: number;
  throughTime: number;
  startLineDeg: number;
  distanceText: string;
  strike: number;
  accelRatio: number;
  pathLabel: string;
  paceLabel: string;
};

type SwingRealism = {
  /** Overall 0–1 confidence that this motion was a real golf swing. */
  score: number;
  label: string;
  /** Essential: device travelled back then through (a backswing exists). */
  reversalScore: number;
  /** Essential: the direction of travel swept through a wide arc. */
  arcScore: number;
  /** Essential: the fast part travelled horizontally, not straight down. */
  horizontalScore: number;
  /** Modulator: swing duration sat in a human range. */
  tempoScore: number;
  /** Modulator: the controller rotated through the swing. */
  rotationScore: number;
  /** Upper bound placed on shot power by swing quality. */
  powerCap: number;
  /** Upper bound placed on strike quality by swing quality. */
  qualityCap: number;
};

type SwingResult = {
  kind: "full" | "chip" | "putt";
  power: number;
  label: string;
  pathQuality: number;
  pathError: number;
  shape: number;
  peak: number;
  plane: number;
  realMotion: boolean;
  /** Down-the-line polyline points (target vs height) "x1,y1 x2,y2 …" */
  pointsDTL: string;
  /** Face-on polyline points (along-swing vs side) */
  pointsFO: string;
  /** Top-down club/grip path estimate (side vs target-line travel). */
  pointsPath: string;
  /** Normalized 2D start direction and end direction in face-on view, for arrow overlays */
  shapeArrow: { startX: number; startY: number; endX: number; endY: number };
  realMotionDuration: number;
  realism?: SwingRealism;
  putt?: PuttResult;
};

// ────────────────────────────────────────────────────────────────────────
// Swing-math helpers
// ────────────────────────────────────────────────────────────────────────

type Vec3 = { x: number; y: number; z: number };

function buildScaledPolyline(
  xs: number[],
  ys: number[],
  box: { w: number; h: number; pad: number },
): string {
  if (xs.length === 0) return "";
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const xR = Math.max(xMax - xMin, 0.001);
  const yR = Math.max(yMax - yMin, 0.001);
  const sx = (box.w - box.pad * 2) / xR;
  const sy = (box.h - box.pad * 2) / yR;
  const s = Math.min(sx, sy);
  const cx = (xMin + xMax) / 2, cy = (yMin + yMax) / 2;
  return xs
    .map((x, i) => {
      const px = box.w / 2 + (x - cx) * s;
      const py = box.h / 2 - (ys[i] - cy) * s;
      return `${px.toFixed(1)},${py.toFixed(1)}`;
    })
    .join(" ");
}

function shapeName(shape: number) {
  const deg = Math.abs(shape) * (180 / Math.PI);
  if (deg < 3) return "Straight";
  if (shape > 0) return deg >= 12 ? "Slice" : "Fade";
  return deg >= 12 ? "Hook" : "Draw";
}

function compressShapeAngle(rawShape: number) {
  const sign = Math.sign(rawShape);
  const abs = Math.abs(rawShape);
  const deadzone = Math.PI / 30; // 6°
  if (abs <= deadzone) return 0;
  // Sensor-derived target path angles are much larger than real ball-curve
  // degrees. Soft-limit them so normal misses become fades/draws instead of
  // instantly pinning to max slice/hook.
  const maxShape = THREE.MathUtils.degToRad(22);
  const reference = THREE.MathUtils.degToRad(32);
  const scaledExcess = (abs - deadzone) * 0.55;
  return sign * maxShape * Math.tanh(scaledExcess / reference);
}

function dot(a: Vec3, b: Vec3) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function normalizeVec(v: Vec3, fallback: Vec3 = { x: 1, y: 0, z: 0 }): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z);
  if (len < 1e-4) return fallback;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function projectToPlane(v: Vec3, normal: Vec3): Vec3 {
  const d = dot(v, normal);
  return {
    x: v.x - d * normal.x,
    y: v.y - d * normal.y,
    z: v.z - d * normal.z,
  };
}

function upFromGravity(gravity: Vec3) {
  const gMag = Math.hypot(gravity.x, gravity.y, gravity.z);
  if (gMag > 1.5) {
    return { x: -gravity.x / gMag, y: -gravity.y / gMag, z: -gravity.z / gMag };
  }
  return { x: 0, y: 1, z: 0 };
}

function targetAxisFromGrip(
  gravity: Vec3,
  handedness: Handedness,
  controllerMount: ControllerMount,
) {
  const up = upFromGravity(gravity);
  // Club/handheld mode: the top edge/long axis of the phone points at target.
  const longAxis = { x: 0, y: -1, z: 0 };
  if (controllerMount === "forearm" || controllerMount === "grip_butt") {
    // Forearm mode assumes the phone is strapped along the lead forearm with
    // the top of the phone toward the hand/wrist. At address that forearm
    // points roughly across the body, so target line is perpendicular to it.
    // Grip-end mode uses the same target-frame math: the phone's top edge is
    // aligned down the shaft toward the club head, also perpendicular to target.
    const mountedAcrossBody = normalizeVec(projectToPlane(longAxis, up), { x: 1, y: 0, z: 0 });
    const target = handedness === "right"
      ? cross(up, mountedAcrossBody)
      : cross(mountedAcrossBody, up);
    return normalizeVec(projectToPlane(target, up), { x: 0, y: 0, z: -1 });
  }
  const projected = normalizeVec(projectToPlane(longAxis, up), { x: 0, y: 0, z: -1 });
  if (Math.hypot(projected.x, projected.y, projected.z) > 1e-3) return projected;
  return normalizeVec(projectToPlane({ x: 0, y: 0, z: -1 }, up), { x: 1, y: 0, z: 0 });
}

/**
 * Top eigenvector (and explained variance) of the 3×3 covariance of `pts`,
 * found by power iteration. Used to recover the swing's principal axis in
 * 3-space — i.e. the actual line the phone moved along, regardless of how
 * the phone was oriented.
 */
function computeSwingPCA(pts: SwingTracePoint[]): {
  axis: Vec3;
  mean: Vec3;
  varAlong: number;
  varPerp: number;
} {
  const n = pts.length;
  if (n < 3) {
    return { axis: { x: 1, y: 0, z: 0 }, mean: { x: 0, y: 0, z: 0 }, varAlong: 0, varPerp: 0 };
  }
  let mx = 0, my = 0, mz = 0;
  for (const p of pts) { mx += p.x; my += p.y; mz += p.z; }
  mx /= n; my /= n; mz /= n;

  let cxx = 0, cyy = 0, czz = 0, cxy = 0, cxz = 0, cyz = 0;
  for (const p of pts) {
    const dx = p.x - mx, dy = p.y - my, dz = p.z - mz;
    cxx += dx * dx; cyy += dy * dy; czz += dz * dz;
    cxy += dx * dy; cxz += dx * dz; cyz += dy * dz;
  }
  cxx /= n; cyy /= n; czz /= n; cxy /= n; cxz /= n; cyz /= n;

  // Seed away from any pure axis so we don't get stuck on a degenerate axis.
  let vx = 0.5, vy = 0.5, vz = 0.5;
  for (let i = 0; i < 16; i++) {
    const nx = cxx * vx + cxy * vy + cxz * vz;
    const ny = cxy * vx + cyy * vy + cyz * vz;
    const nz = cxz * vx + cyz * vy + czz * vz;
    const nlen = Math.hypot(nx, ny, nz) || 1;
    vx = nx / nlen; vy = ny / nlen; vz = nz / nlen;
  }
  const varAlong =
    vx * (cxx * vx + cxy * vy + cxz * vz) +
    vy * (cxy * vx + cyy * vy + cyz * vz) +
    vz * (cxz * vx + cyz * vy + czz * vz);
  const total = cxx + cyy + czz;
  const varPerp = Math.max(0, total - varAlong);

  return { axis: { x: vx, y: vy, z: vz }, mean: { x: mx, y: my, z: mz }, varAlong, varPerp };
}

/**
 * Signed shot shape: how much the swing's direction rotates around the
 * gravity axis between its first half and second half. Positive = the
 * direction rotates clockwise viewed from above (fade for a right-handed
 * player); negative = counter-clockwise (draw).
 *
 * `gravity` is the accelerometer reading at rest before the swing; it's
 * used to define the horizontal plane. If gravity is unknown the function
 * falls back to using the swing axis vertical component, which is less
 * accurate but stops the result from being meaningless.
 */
function computeShapeAngle(
  pts: SwingTracePoint[],
  gravity: Vec3,
  swingAxis: Vec3,
): number {
  if (pts.length < 6) return 0;

  const gMag = Math.hypot(gravity.x, gravity.y, gravity.z);
  let upX: number, upY: number, upZ: number;
  if (gMag > 1.5) {
    // "Up" is opposite gravity.
    upX = -gravity.x / gMag; upY = -gravity.y / gMag; upZ = -gravity.z / gMag;
  } else {
    // No usable gravity baseline; assume +y is up (matches iOS portrait at rest).
    upX = 0; upY = 1; upZ = 0;
  }

  const half = Math.floor(pts.length / 2);
  const avg = (slice: SwingTracePoint[]): Vec3 => {
    let sx = 0, sy = 0, sz = 0;
    for (const p of slice) { sx += p.x; sy += p.y; sz += p.z; }
    const k = slice.length || 1;
    return { x: sx / k, y: sy / k, z: sz / k };
  };
  const a = avg(pts.slice(0, half));
  const b = avg(pts.slice(half));

  // Project both averaged directions to the horizontal plane.
  const projHoriz = (v: Vec3): Vec3 => {
    const d = v.x * upX + v.y * upY + v.z * upZ;
    return { x: v.x - d * upX, y: v.y - d * upY, z: v.z - d * upZ };
  };
  const h1 = projHoriz(a);
  const h2 = projHoriz(b);
  const m1 = Math.hypot(h1.x, h1.y, h1.z);
  const m2 = Math.hypot(h2.x, h2.y, h2.z);
  if (m1 < 0.05 || m2 < 0.05) return 0;
  const u1x = h1.x / m1, u1y = h1.y / m1, u1z = h1.z / m1;
  const u2x = h2.x / m2, u2y = h2.y / m2, u2z = h2.z / m2;

  // Signed angle of rotation from u1 → u2 around the "up" axis.
  const crossX = u1y * u2z - u1z * u2y;
  const crossY = u1z * u2x - u1x * u2z;
  const crossZ = u1x * u2y - u1y * u2x;
  const sin = crossX * upX + crossY * upY + crossZ * upZ;
  const cos = u1x * u2x + u1y * u2y + u1z * u2z;
  // Flip sign so that "clockwise viewed from above" = positive = fade.
  // (Cross-product sin with up is positive for CCW; we want CW positive.)
  // Also reference swingAxis to keep handedness consistent if gravity
  // and swing are degenerate.
  void swingAxis;
  return -Math.atan2(sin, cos);
}

/** A swing-trace acceleration sample resolved into the target-line frame. */
type ProjectedSample = {
  /** Acceleration along the target line, positive = toward the green. */
  along: number;
  /** Acceleration across the target line, positive = right. */
  side: number;
  /** Vertical acceleration, positive = up. */
  up: number;
  /** Raw acceleration magnitude of the source sample. */
  mag: number;
  /** Elapsed seconds since swing capture began. */
  t: number;
};

function projectTargetFrame(
  pts: SwingTracePoint[],
  calibration: SwingCalibration | null,
  fallbackAxis: Vec3,
  fallbackGravity: Vec3,
): ProjectedSample[] {
  const gravity = calibration?.gravity ?? fallbackGravity;
  const up = upFromGravity(gravity);
  const fallbackForward = normalizeVec(
    projectToPlane(fallbackAxis, up),
    { x: 0, y: 0, z: -1 },
  );
  const target = calibration
    ? normalizeVec(projectToPlane(calibration.targetAxis, up), fallbackForward)
    : fallbackForward;
  // Right of target is target × up. The previous up × target convention
  // inverted the side axis, which made right-handed slice paths read as hooks.
  const sideRight = normalizeVec(cross(target, up), { x: 1, y: 0, z: 0 });

  return pts.map((p) => ({
    along: dot(p, target),
    side: dot(p, sideRight),
    up: dot(p, up),
    mag: p.mag,
    t: p.t ?? 0,
  }));
}

function computeTargetPathMetrics(
  projected: Array<{ along: number; side: number; up: number; mag: number }>,
) {
  if (projected.length < 2) {
    return { sideRatio: 0, pathAngle: 0, sideBias: 0 };
  }
  let sideEnergy = 0;
  let targetPlaneEnergy = 0;
  let weightedSide = 0;
  let weightTotal = 0;
  for (const p of projected) {
    const weight = Math.max(p.mag, 0.05);
    sideEnergy += p.side * p.side * weight;
    targetPlaneEnergy += (p.along * p.along + p.up * p.up) * weight;
    weightedSide += p.side * weight;
    weightTotal += weight;
  }
  const sideRatio = Math.sqrt(sideEnergy / Math.max(targetPlaneEnergy, 1e-4));
  const sideBias = weightedSide / Math.max(weightTotal, 1e-4);
  const half = Math.floor(projected.length / 2);
  const downswing = projected.slice(half);
  let along = 0;
  let side = 0;
  let total = 0;
  for (const p of downswing) {
    const weight = Math.max(p.mag, 0.05);
    along += p.along * weight;
    side += p.side * weight;
    total += weight;
  }
  along /= Math.max(total, 1e-4);
  side /= Math.max(total, 1e-4);
  const pathAngle = Math.atan2(side, Math.max(Math.abs(along), 1e-3));
  return { sideRatio, pathAngle, sideBias };
}

function integratedRotation(gyroSamples: GyroSample[]) {
  let total = 0;
  for (let i = 1; i < gyroSamples.length; i++) {
    const prev = gyroSamples[i - 1];
    const sample = gyroSamples[i];
    const dt = THREE.MathUtils.clamp(sample.t - prev.t, 0, 0.06);
    total += Math.hypot(sample.alpha, sample.beta, sample.gamma) * dt;
  }
  return total;
}

/**
 * Integrate the target-frame acceleration samples into a velocity track.
 *
 * `projected` holds linear acceleration (m/s²) captured at irregular,
 * motion-gated intervals. A captured swing begins and ends with the device
 * near rest, so a correct integration returns to zero — any leftover final
 * velocity is accelerometer bias, removed here as a linear drift ramp.
 *
 * This is a single integration (accel → velocity). It is far more stable than
 * integrating twice to a position track, and velocity alone exposes every
 * signal swing realism needs: direction reversal, arc sweep, vertical share.
 */
function reconstructSwingVelocity(
  projected: ProjectedSample[],
): Array<{ along: number; side: number; up: number; t: number; speed: number }> {
  const vel: Array<{ along: number; side: number; up: number; t: number; speed: number }> = [];
  if (projected.length < 2) return vel;

  let va = 0;
  let vs = 0;
  let vu = 0;
  vel.push({ along: 0, side: 0, up: 0, t: projected[0].t, speed: 0 });
  for (let i = 1; i < projected.length; i++) {
    // Gaps between motion-gated samples can be long; cap dt so one stale
    // sample cannot inject a huge phantom velocity step.
    const dt = THREE.MathUtils.clamp(projected[i].t - projected[i - 1].t, 1e-3, 0.15);
    // Trapezoidal integration of acceleration → velocity.
    va += (projected[i].along + projected[i - 1].along) * 0.5 * dt;
    vs += (projected[i].side + projected[i - 1].side) * 0.5 * dt;
    vu += (projected[i].up + projected[i - 1].up) * 0.5 * dt;
    vel.push({ along: va, side: vs, up: vu, t: projected[i].t, speed: 0 });
  }

  // De-drift: force the final velocity back to zero by subtracting a linear
  // ramp, then refresh the cached speed magnitudes.
  const last = vel[vel.length - 1];
  const t0 = vel[0].t;
  const span = Math.max(last.t - t0, 1e-3);
  const driftA = last.along;
  const driftS = last.side;
  const driftU = last.up;
  for (const v of vel) {
    const f = (v.t - t0) / span;
    v.along -= driftA * f;
    v.side -= driftS * f;
    v.up -= driftU * f;
    v.speed = Math.hypot(v.along, v.side, v.up);
  }
  return vel;
}

/**
 * Score how closely a captured motion resembles a real golf swing.
 *
 * A real swing has three properties that the common sensor-gaming motions —
 * a vertical "slam", a wrist flick, a back-and-forth shake — each lack:
 *
 *   reversal    the device travels back (backswing), then through;
 *   arc         the direction of travel sweeps through a wide angle;
 *   horizontal  the fast part travels around the body, not straight down/up.
 *
 * The three are combined with a GEOMETRIC MEAN, so a near-zero on any one
 * collapses the whole score. That is the deliberate fix for the previous
 * weighted-sum model, in which "free" tempo and rotation points let a
 * vertical slam out-score an honest swing. Tempo and rotation are now only
 * modulators — they shade a real swing up or down a little but cannot
 * manufacture a passing score on their own.
 *
 * The tunable thresholds (REVERSAL_TARGET, the arc/horizontal ramps, the
 * tempo window) are marked inline. They want a calibration pass against
 * recorded-swing fixtures, but the SHAPE of the result does not depend on
 * their exact values — a slam fails three independent gates regardless.
 */
function computeSwingRealism(
  projected: ProjectedSample[],
  gyroSamples: GyroSample[],
  elapsed: number,
  maxRot: number,
  controllerMount: ControllerMount,
  build: PlayerBuild,
  powerBalance: PowerBalanceMode,
): SwingRealism {
  const result = (
    label: string,
    score: number,
    parts?: Partial<SwingRealism>,
  ): SwingRealism => ({
    score,
    label,
    reversalScore: parts?.reversalScore ?? 0,
    arcScore: parts?.arcScore ?? 0,
    horizontalScore: parts?.horizontalScore ?? 0,
    tempoScore: parts?.tempoScore ?? 0,
    rotationScore: parts?.rotationScore ?? 0,
    // Power is gated on "was this a real swing", not "was it perfect": any
    // genuine swing (score ≳ 0.5) can deliver full power, leaving the player's
    // power-balance mode free to shape the whole range. Only fake/degenerate
    // motion — a slam, a flick — is power-capped. Strike quality and shot
    // shape are still graded by score separately, via qualityCap below.
    powerCap: THREE.MathUtils.clamp((score - 0.1) / 0.4, 0.05, 1),
    qualityCap:
      score >= 0.78 ? 1 : THREE.MathUtils.clamp(0.16 + Math.pow(score, 1.1) * 0.95, 0.16, 0.96),
  });

  if (projected.length < 6) return result("Not enough swing", 0.18);

  const vel = reconstructSwingVelocity(projected);
  if (vel.length < 6) return result("Not enough swing", 0.18);

  let maxSpeed = 0;
  for (const v of vel) maxSpeed = Math.max(maxSpeed, v.speed);
  if (maxSpeed < 1e-3) return result("No swing detected", 0.12);

  // Through-swing direction: speed²-weighted mean velocity. The downswing is
  // always the fastest phase, so this points "through the ball".
  let throughA = 0;
  let throughS = 0;
  let throughU = 0;
  for (const v of vel) {
    const w = v.speed * v.speed;
    throughA += v.along * w;
    throughS += v.side * w;
    throughU += v.up * w;
  }
  const throughLen = Math.hypot(throughA, throughS, throughU);
  if (throughLen < 1e-4) return result("No clear swing", 0.15);
  throughA /= throughLen;
  throughS /= throughLen;
  throughU /= throughLen;

  // ── Essential 1: reversal ───────────────────────────────────────────────
  // Velocity resolved onto the through-direction is negative during the
  // backswing and positive during the downswing. A one-way motion (slam,
  // shove) never builds a backswing lobe; a shake flips sign many times.
  let travelFwd = 0;
  let travelBack = 0;
  let crossings = 0;
  let prevSign = 0;
  for (let i = 1; i < vel.length; i++) {
    const dt = Math.max(vel[i].t - vel[i - 1].t, 1e-3);
    const v1d =
      0.5 *
      ((vel[i].along + vel[i - 1].along) * throughA +
        (vel[i].side + vel[i - 1].side) * throughS +
        (vel[i].up + vel[i - 1].up) * throughU);
    if (v1d >= 0) travelFwd += v1d * dt;
    else travelBack += -v1d * dt;
    const sign = v1d > 0.04 ? 1 : v1d < -0.04 ? -1 : 0;
    if (sign !== 0 && prevSign !== 0 && sign !== prevSign) crossings += 1;
    if (sign !== 0) prevSign = sign;
  }
  // REVERSAL_TARGET: integrated travel of the smaller lobe at which a
  // backswing counts as fully present. Deliberately generous — sample gating
  // under-counts a slow takeaway. Fixture-tunable.
  const REVERSAL_TARGET = 0.6;
  const lobe = Math.min(travelFwd, travelBack);
  const crossingScore =
    crossings === 0
      ? 0
      : crossings <= 2
        ? 1
        : THREE.MathUtils.clamp(1 - (crossings - 2) * 0.34, 0, 0.7);
  const reversalScore = THREE.MathUtils.clamp(lobe / REVERSAL_TARGET, 0, 1) * crossingScore;

  // ── Essential 2: arc ────────────────────────────────────────────────────
  // Total angle the travel direction sweeps. A slam holds one heading (~0);
  // a real swing flips back→through (~π) and adds the curve of the arc.
  let sweep = 0;
  for (let i = 1; i < vel.length; i++) {
    const a = vel[i - 1];
    const b = vel[i];
    if (a.speed < maxSpeed * 0.15 || b.speed < maxSpeed * 0.15) continue;
    const cos =
      (a.along * b.along + a.side * b.side + a.up * b.up) / (a.speed * b.speed);
    sweep += Math.acos(THREE.MathUtils.clamp(cos, -1, 1));
  }
  const arcScore = THREE.MathUtils.clamp((sweep - 0.7) / 2.6, 0, 1);

  // ── Essential 3: horizontal travel ──────────────────────────────────────
  // Energy split of the fast part of the swing. A golf swing travels around
  // the body (along + side); a vertical slam puts all of it into `up`.
  let horizEnergy = 0;
  let vertEnergy = 0;
  for (const v of vel) {
    if (v.speed < maxSpeed * 0.4) continue;
    horizEnergy += v.along * v.along + v.side * v.side;
    vertEnergy += v.up * v.up;
  }
  const horizShare = horizEnergy / Math.max(horizEnergy + vertEnergy, 1e-4);
  const horizontalScore = THREE.MathUtils.clamp((horizShare - 0.34) / 0.4, 0, 1);

  // ── Modulators: tempo and rotation ──────────────────────────────────────
  // The tempo window widens for the Relaxed / Compact power-balance modes:
  // those modes expect a less-than-full-effort swing, which is naturally
  // shorter and quicker, so a "rushed" (or "slow") verdict there would punish
  // the exact swing the mode is built around. Leniency comes from the mode's
  // full-power-at fraction (Realistic 1.0 → Relaxed ~1.18 → Compact ~1.43):
  // the rushed edge moves earlier and the slow edge moves later by that much.
  const tempoLeniency = 1 / powerBalanceFullPowerAt(powerBalance);
  const rushedFull = 0.14 / tempoLeniency;
  const rushedEdge = 0.3 / tempoLeniency;
  const slowEdge = 1.7 * tempoLeniency;
  const slowSpan = 0.9 * tempoLeniency;
  const tempoScore =
    elapsed < rushedEdge
      ? THREE.MathUtils.clamp(
          (elapsed - rushedFull) / Math.max(rushedEdge - rushedFull, 1e-3),
          0,
          1,
        )
      : elapsed > slowEdge
        ? THREE.MathUtils.clamp(1 - (elapsed - slowEdge) / slowSpan, 0, 1)
        : 1;
  const rotTravel = integratedRotation(gyroSamples);
  const mountStrictness =
    controllerMount === "grip_butt" ? 1.15 : controllerMount === "club" ? 0.88 : 0.76;
  const rotationScore = THREE.MathUtils.clamp(
    THREE.MathUtils.clamp((maxRot - 70 * mountStrictness) / (430 * mountStrictness), 0, 1) * 0.6 +
      THREE.MathUtils.clamp((rotTravel - 24 * mountStrictness) / (190 * mountStrictness), 0, 1) * 0.4,
    0,
    1,
  );

  // A wrist flick is almost all rotation and almost no travel — flag it for a
  // clear label even though the essentials already drag its score down.
  const swingTravel = travelFwd + travelBack;
  const isFlick = rotationScore > 0.5 && swingTravel < REVERSAL_TARGET * 0.6;

  // ── Combine ─────────────────────────────────────────────────────────────
  // Geometric mean of the essentials: any one near zero collapses the score.
  // This is what answers "was there an actual swing" — it dominates the
  // result. Tempo and rotation are only modulators; a genuine swing that is
  // slow or lazily turned still reads as real, it just loses a little polish.
  // Tempo is deliberately the lightest touch (±10%) — a slow-but-real swing
  // must never be mistaken for a non-swing. The "Slow swing" label below
  // still fires so the player gets the feedback.
  const geoMean = Math.cbrt(
    Math.max(reversalScore, 1e-3) *
      Math.max(arcScore, 1e-3) *
      Math.max(horizontalScore, 1e-3),
  );
  const buildForgiveness = THREE.MathUtils.clamp(
    ((build.control + build.path) / 2 - 55) / 45,
    0,
    1,
  );
  const score = THREE.MathUtils.clamp(
    geoMean *
      THREE.MathUtils.lerp(0.9, 1, tempoScore) *
      THREE.MathUtils.lerp(0.8, 1, rotationScore) *
      THREE.MathUtils.lerp(0.95, 1.06, buildForgiveness),
    0,
    1,
  );

  let label = "Playable swing";
  if (isFlick) label = "Wrist flick";
  else if (horizontalScore < 0.3) label = "Straight drop";
  else if (reversalScore < 0.3) label = "No backswing";
  else if (arcScore < 0.3) label = "Straight shove";
  else if (crossings > 3) label = "Loose motion";
  else if (rotationScore < 0.3) label = "No turn";
  else if (tempoScore < 0.55) label = elapsed < rushedEdge ? "Rushed swing" : "Slow swing";
  else if (score >= 0.78) label = "True swing";

  return result(label, score, {
    reversalScore,
    arcScore,
    horizontalScore,
    tempoScore,
    rotationScore,
  });
}

/**
 * One of the two swing-analysis panels on the phone result screen.
 * Renders a stylized "camera angle" — either Face-On or Down-the-Line —
 * using the target-frame sample polyline produced by finishSwing.
 *
 * `points` is a pre-built SVG polyline string in 300×170 viewBox space.
 * `arrow`, when present, draws the first-third → last-third direction
 * arrow used to communicate shot shape in the Face-On view.
 */
function SwingView({
  title,
  subtitle,
  subtitleColor,
  points,
  arrow,
  realMotion,
  qualityColor,
}: {
  title: string;
  subtitle: string;
  subtitleColor: string;
  points: string;
  arrow?: { startX: number; startY: number; endX: number; endY: number };
  realMotion: boolean;
  qualityColor: string;
}) {
  const gradId = `sv-${title.replace(/\s+/g, "")}`;
  return (
    <div
      style={{
        borderRadius: 10,
        border: "1px solid rgba(255,255,255,0.16)",
        background: "linear-gradient(180deg, rgba(45,66,85,0.78), rgba(14,22,32,0.92))",
        padding: 8,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div style={{ fontSize: 9, letterSpacing: 1.5, opacity: 0.7, fontWeight: 800 }}>
          {title}
        </div>
        <div
          style={{
            fontSize: 10,
            fontWeight: 800,
            color: subtitleColor,
            textShadow: "0 1px 2px rgba(0,0,0,0.6)",
          }}
        >
          {subtitle}
        </div>
      </div>
      <svg viewBox="0 0 300 170" style={{ width: "100%", display: "block", borderRadius: 6 }}>
        <defs>
          <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#9aa6b2" />
            <stop offset="55%" stopColor="#ffeb3b" />
            <stop offset="100%" stopColor={qualityColor} />
          </linearGradient>
        </defs>
        {/* Ground plane */}
        <line x1="0" y1="140" x2="300" y2="140" stroke="rgba(255,255,255,0.18)" strokeWidth="1.5" strokeDasharray="4 6" />
        {/* "Player" silhouette + ball at the foot of the view */}
        <circle cx="150" cy="148" r="3.5" fill="#ffffff" />
        {title === "FACE ON" ? (
          // Vertical reference line (target plane on face-on view).
          <line x1="150" y1="20" x2="150" y2="148" stroke="rgba(255,255,255,0.10)" strokeWidth="1.5" />
        ) : (
          // Target-line vanishing-point arrow on down-the-line view.
          <g>
            <line x1="150" y1="148" x2="150" y2="40" stroke="rgba(255,255,255,0.10)" strokeWidth="1.5" />
            <polygon points="150,32 144,44 156,44" fill="rgba(255,255,255,0.18)" />
          </g>
        )}
        {realMotion && points && (
          <polyline
            points={points}
            fill="none"
            stroke={`url(#${gradId})`}
            strokeWidth="5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {arrow && realMotion && (
          <g>
            <defs>
              <marker
                id={`${gradId}-arr`}
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill={subtitleColor} />
              </marker>
            </defs>
            <line
              x1={arrow.startX}
              y1={arrow.startY}
              x2={arrow.endX}
              y2={arrow.endY}
              stroke={subtitleColor}
              strokeOpacity={0.85}
              strokeWidth={3}
              markerEnd={`url(#${gradId}-arr)`}
            />
          </g>
        )}
        {!realMotion && (
          <text
            x="150"
            y="90"
            textAnchor="middle"
            fill="rgba(255,255,255,0.45)"
            fontSize="13"
            fontWeight="700"
          >
            fallback swing
          </text>
        )}
      </svg>
    </div>
  );
}

function ClubPathView({
  subtitle,
  subtitleColor,
  points,
  realMotion,
}: {
  subtitle: string;
  subtitleColor: string;
  points: string;
  realMotion: boolean;
}) {
  return (
    <div
      style={{
        borderRadius: 10,
        border: "1px solid rgba(255,255,255,0.16)",
        background: "linear-gradient(180deg, rgba(45,66,85,0.78), rgba(14,22,32,0.92))",
        padding: 8,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div style={{ fontSize: 9, letterSpacing: 1.5, opacity: 0.7, fontWeight: 800 }}>
          CLUB PATH
        </div>
        <div style={{ fontSize: 10, fontWeight: 800, color: subtitleColor }}>
          {subtitle}
        </div>
      </div>
      <svg viewBox="0 0 300 170" style={{ width: "100%", display: "block", borderRadius: 6 }}>
        <defs>
          <linearGradient id="clubPathGrad" x1="0%" y1="100%" x2="0%" y2="0%">
            <stop offset="0%" stopColor="#9aa6b2" />
            <stop offset="55%" stopColor="#ffeb3b" />
            <stop offset="100%" stopColor={subtitleColor} />
          </linearGradient>
        </defs>
        <rect x="0" y="0" width="300" height="170" fill="rgba(255,255,255,0.025)" />
        <line x1="150" y1="18" x2="150" y2="152" stroke="rgba(255,255,255,0.16)" strokeWidth="2" strokeDasharray="5 6" />
        <polygon points="150,12 144,24 156,24" fill="rgba(255,255,255,0.22)" />
        <line x1="48" y1="145" x2="252" y2="145" stroke="rgba(255,255,255,0.12)" strokeWidth="1.5" />
        <circle cx="150" cy="145" r="3.5" fill="#ffffff" />
        {realMotion && points ? (
          <polyline
            points={points}
            fill="none"
            stroke="url(#clubPathGrad)"
            strokeWidth="5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          <text x="150" y="88" textAnchor="middle" fill="rgba(255,255,255,0.55)" fontSize="12" fontWeight="800">
            fallback
          </text>
        )}
      </svg>
    </div>
  );
}

function PuttStrokeView({ putt }: { putt: PuttResult }) {
  return (
    <div style={controllerStyles.traceCard}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div style={{ fontSize: 10, letterSpacing: 1.5, opacity: 0.7, fontWeight: 850 }}>
          TOP DOWN
        </div>
        <div style={{ fontSize: 12, fontWeight: 850, color: "#63d471" }}>{putt.pathLabel}</div>
      </div>
      <svg viewBox="0 0 300 190" style={{ width: "100%", display: "block", marginTop: 6 }}>
        <defs>
          <linearGradient id="puttPath" x1="0%" y1="100%" x2="0%" y2="0%">
            <stop offset="0%" stopColor="#9aa6b2" />
            <stop offset="52%" stopColor="#ffeb3b" />
            <stop offset="100%" stopColor="#63d471" />
          </linearGradient>
        </defs>
        <rect x="0" y="0" width="300" height="190" rx="8" fill="rgba(99,166,78,0.14)" />
        <line x1="150" y1="24" x2="150" y2="166" stroke="rgba(255,255,255,0.16)" strokeDasharray="5 7" />
        <line x1="60" y1="95" x2="240" y2="95" stroke="rgba(255,255,255,0.12)" />
        <circle cx="150" cy="95" r="6" fill="#fff" stroke="#aeb5bf" strokeWidth="2" />
        <text x="158" y="89" fill="rgba(255,255,255,0.58)" fontSize="10" fontWeight="800">BALL</text>
        {putt.topDownPoints && (
          <polyline
            points={putt.topDownPoints}
            fill="none"
            stroke="url(#puttPath)"
            strokeWidth="5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        <text x="150" y="22" textAnchor="middle" fill="rgba(255,255,255,0.42)" fontSize="10" fontWeight="800">
          FOLLOWTHROUGH
        </text>
        <text x="150" y="180" textAnchor="middle" fill="rgba(255,255,255,0.42)" fontSize="10" fontWeight="800">
          BACKSTROKE
        </text>
      </svg>
    </div>
  );
}

function PhoneClubPreview({ club }: { club: (typeof CLUBS)[number] }) {
  const wood = club.id === "driver" || club.id === "3wood";
  const putter = !!club.putter;
  const wedge = club.id === "wedge" || club.id === "sand" || club.id.startsWith("lob");
  const shaftTop = wood ? 20 : putter ? 36 : wedge ? 30 : 26;
  const shaftBottom = putter ? 132 : 126;
  const shaftX1 = wood ? 122 : putter ? 138 : 130;
  const shaftX2 = putter ? 116 : wedge ? 104 : 108;
  const headColor = wood ? "#0c0d10" : putter ? "#222a36" : wedge ? "#69717f" : "#566171";
  const headWidth = wood ? 50 : putter ? 70 : wedge ? 44 : 38;
  const headHeight = wood ? 30 : putter ? 18 : wedge ? 26 : 22;
  const faceTilt = wedge ? 9 : putter ? 0 : 4;

  return (
    <svg viewBox="0 0 240 160" style={controllerStyles.clubPreviewSvg} aria-hidden="true">
      <defs>
        <linearGradient id="clubShaft" x1="0" x2="1">
          <stop offset="0" stopColor="#d8dde5" />
          <stop offset="0.5" stopColor="#737d8d" />
          <stop offset="1" stopColor="#2d3440" />
        </linearGradient>
        <radialGradient id="clubGlow" cx="50%" cy="50%" r="60%">
          <stop offset="0" stopColor="rgba(255,255,255,0.28)" />
          <stop offset="1" stopColor="rgba(255,255,255,0)" />
        </radialGradient>
      </defs>
      <ellipse cx="120" cy="138" rx="92" ry="16" fill="url(#clubGlow)" />
      <line
        x1={shaftX1}
        y1={shaftTop}
        x2={shaftX2}
        y2={shaftBottom}
        stroke="url(#clubShaft)"
        strokeWidth={wood ? 8 : 6}
        strokeLinecap="round"
      />
      <rect
        x={shaftX1 - 8}
        y={shaftTop - 10}
        width={wood ? 18 : 16}
        height={32}
        rx={7}
        fill="#111822"
        transform={`rotate(${wood ? -10 : -7} ${shaftX1} ${shaftTop})`}
      />
      <g transform={`translate(${shaftX2 - headWidth * 0.15} ${shaftBottom - headHeight * 0.55}) rotate(${faceTilt})`}>
        <rect
          x={-headWidth * 0.5}
          y={-headHeight * 0.5}
          width={headWidth}
          height={headHeight}
          rx={putter ? 5 : wood ? 13 : 4}
          fill={headColor}
        />
        <rect
          x={-headWidth * 0.42}
          y={-headHeight * 0.22}
          width={headWidth * 0.7}
          height={Math.max(4, headHeight * 0.16)}
          rx={2}
          fill="rgba(255,255,255,0.22)"
        />
      </g>
    </svg>
  );
}

function formatRelative(value: number) {
  if (value === 0) return "E";
  return value > 0 ? `+${value}` : `${value}`;
}

function scoreTotal(scorecard: Array<ScoreEntry | null>, through = scorecard.length) {
  return scorecard.slice(0, through).reduce<{ strokes: number; par: number }>(
    (sum, entry) => {
      if (!entry) return sum;
      return {
        strokes: sum.strokes + entry.strokes,
        par: sum.par + entry.par,
      };
    },
    { strokes: 0, par: 0 },
  );
}

function mapBounds(layout: HoleLayout) {
  let minX = -16;
  let maxX = 16;
  let minZ = Math.min(layout.tee.z, layout.greenCenter.z) - layout.greenRadius - 6;
  let maxZ = Math.max(layout.tee.z, layout.greenCenter.z) + 8;

  for (const zone of layout.fairways) {
    if (zone.kind === "circle") {
      minX = Math.min(minX, zone.x - zone.r - 5);
      maxX = Math.max(maxX, zone.x + zone.r + 5);
      minZ = Math.min(minZ, zone.z - zone.r - 5);
      maxZ = Math.max(maxZ, zone.z + zone.r + 5);
    } else {
      const radius = Math.hypot(zone.w, zone.d) / 2 + 5;
      minX = Math.min(minX, zone.x - radius);
      maxX = Math.max(maxX, zone.x + radius);
      minZ = Math.min(minZ, zone.z - radius);
      maxZ = Math.max(maxZ, zone.z + radius);
    }
  }

  for (const bunker of layout.bunkers) {
    minX = Math.min(minX, bunker.x - bunker.rx - 5);
    maxX = Math.max(maxX, bunker.x + bunker.rx + 5);
    minZ = Math.min(minZ, bunker.z - bunker.rz - 5);
    maxZ = Math.max(maxZ, bunker.z + bunker.rz + 5);
  }

  return { minX, maxX, minZ, maxZ };
}

function HoleMapSvg({
  layout,
  ball,
  aim,
  compact = false,
}: {
  layout: HoleLayout;
  ball?: { x: number; z: number };
  aim?: number;
  compact?: boolean;
}) {
  const width = compact ? 220 : 520;
  const height = compact ? 250 : 560;
  const pad = compact ? 14 : 26;
  const bounds = mapBounds(layout);
  const scale = Math.min(
    (width - pad * 2) / Math.max(bounds.maxX - bounds.minX, 1),
    (height - pad * 2) / Math.max(bounds.maxZ - bounds.minZ, 1),
  );
  const mapX = (x: number) => (x - bounds.minX) * scale + pad;
  const mapY = (z: number) => (bounds.maxZ - z) * scale + pad;
  const fairwayRoute = [
    { x: layout.tee.x, z: layout.tee.z },
    ...layout.fairways.map((zone) => ({ x: zone.x, z: zone.z })),
    { x: layout.greenCenter.x, z: layout.greenCenter.z },
  ];
  const routePoints = fairwayRoute
    .sort((a, b) => b.z - a.z)
    .map((p) => `${mapX(p.x).toFixed(1)},${mapY(p.z).toFixed(1)}`)
    .join(" ");
  const ballPoint = ball || { x: layout.tee.x, z: layout.tee.z };
  const aimEnd =
    typeof aim === "number"
      ? {
          x: ballPoint.x + Math.sin(aim) * (compact ? 20 : 34),
          z: ballPoint.z - Math.cos(aim) * (compact ? 20 : 34),
        }
      : null;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", display: "block" }}>
      <rect width={width} height={height} rx={compact ? 12 : 18} fill="#236b2e" />
      <rect
        x={pad * 0.5}
        y={pad * 0.5}
        width={width - pad}
        height={height - pad}
        rx={compact ? 10 : 16}
        fill="rgba(255,255,255,0.04)"
      />
      {layout.fairways.map((zone, index) =>
        zone.kind === "circle" ? (
          <circle
            key={`fw-${index}`}
            cx={mapX(zone.x)}
            cy={mapY(zone.z)}
            r={zone.r * scale}
            fill="#63a64e"
          />
        ) : (
          <rect
            key={`fw-${index}`}
            x={mapX(zone.x) - (zone.w * scale) / 2}
            y={mapY(zone.z) - (zone.d * scale) / 2}
            width={zone.w * scale}
            height={zone.d * scale}
            rx={Math.min(zone.w * scale * 0.45, compact ? 9 : 18)}
            fill="#63a64e"
            transform={`rotate(${-(zone.rot || 0) * 180 / Math.PI} ${mapX(zone.x)} ${mapY(zone.z)})`}
          />
        ),
      )}
      <polyline
        points={routePoints}
        fill="none"
        stroke="rgba(255,255,255,0.6)"
        strokeWidth={compact ? 2 : 4}
        strokeDasharray={compact ? "5 5" : "9 8"}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {layout.bunkers.map((bunker, index) => (
        <ellipse
          key={`bunker-${index}`}
          cx={mapX(bunker.x)}
          cy={mapY(bunker.z)}
          rx={bunker.rx * scale}
          ry={bunker.rz * scale}
          fill="#d6c998"
          stroke="rgba(73,61,38,0.45)"
          strokeWidth={compact ? 1 : 2}
        />
      ))}
      <circle
        cx={mapX(layout.greenCenter.x)}
        cy={mapY(layout.greenCenter.z)}
        r={layout.greenRadius * scale}
        fill="#7fc766"
        stroke="#a9e08b"
        strokeWidth={compact ? 1.5 : 3}
      />
      <circle
        cx={mapX(layout.cup.x)}
        cy={mapY(layout.cup.z)}
        r={compact ? 3.2 : 5}
        fill="#111"
      />
      <path
        d={`M ${mapX(layout.cup.x)} ${mapY(layout.cup.z)} l 0 ${compact ? -18 : -32}`}
        stroke="#f4f4f4"
        strokeWidth={compact ? 1.5 : 3}
      />
      <path
        d={`M ${mapX(layout.cup.x)} ${mapY(layout.cup.z) - (compact ? 18 : 32)} l ${compact ? 13 : 24} ${compact ? 4 : 7} l ${compact ? -13 : -24} ${compact ? 4 : 7} z`}
        fill="#b91d2d"
      />
      <rect
        x={mapX(layout.tee.x) - (compact ? 8 : 14)}
        y={mapY(layout.tee.z) - (compact ? 5 : 8)}
        width={compact ? 16 : 28}
        height={compact ? 10 : 16}
        rx={compact ? 3 : 5}
        fill="#2f8ed8"
      />
      {aimEnd && (() => {
        const bx = mapX(ballPoint.x);
        const by = mapY(ballPoint.z);
        const ax = mapX(aimEnd.x);
        const ay = mapY(aimEnd.z);
        const dx = ax - bx;
        const dy = ay - by;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        const headLen = compact ? 8 : 14;
        const headWid = compact ? 5 : 9;
        const tipX = ax;
        const tipY = ay;
        const baseX = ax - ux * headLen;
        const baseY = ay - uy * headLen;
        const leftX = baseX + -uy * headWid;
        const leftY = baseY + ux * headWid;
        const rightX = baseX - -uy * headWid;
        const rightY = baseY - ux * headWid;
        return (
          <g>
            <line
              x1={bx}
              y1={by}
              x2={baseX}
              y2={baseY}
              stroke="#ffeb3b"
              strokeWidth={compact ? 2.4 : 4}
              strokeLinecap="round"
            />
            <polygon
              points={`${tipX},${tipY} ${leftX},${leftY} ${rightX},${rightY}`}
              fill="#ffeb3b"
            />
          </g>
        );
      })()}
      {/* Player "you are here" indicator — pulsing halo + bright dot + label. */}
      {(() => {
        const bx = mapX(ballPoint.x);
        const by = mapY(ballPoint.z);
        const outerR = compact ? 11 : 18;
        const midR = compact ? 7 : 12;
        const dotR = compact ? 4.0 : 6.5;
        const distYds = Math.hypot(
          ballPoint.x - layout.cup.x,
          ballPoint.z - layout.cup.z,
        ) / 0.9144;
        return (
          <g>
            <circle
              cx={bx}
              cy={by}
              r={outerR}
              fill="none"
              stroke="#ffeb3b"
              strokeOpacity={0.35}
              strokeWidth={compact ? 1.4 : 2}
            >
              <animate
                attributeName="r"
                values={`${midR};${outerR};${midR}`}
                dur="1.6s"
                repeatCount="indefinite"
              />
              <animate
                attributeName="stroke-opacity"
                values="0.55;0.05;0.55"
                dur="1.6s"
                repeatCount="indefinite"
              />
            </circle>
            <circle
              cx={bx}
              cy={by}
              r={midR}
              fill="none"
              stroke="#ffffff"
              strokeOpacity={0.85}
              strokeWidth={compact ? 1.6 : 2.4}
            />
            <circle
              cx={bx}
              cy={by}
              r={dotR}
              fill="#ff3b3b"
              stroke="#ffffff"
              strokeWidth={compact ? 1.4 : 2}
            />
            {compact ? (
              <text
                x={bx + outerR + 3}
                y={by + 3}
                fill="#ffeb3b"
                fontSize="10"
                fontWeight="800"
                style={{ paintOrder: "stroke", stroke: "rgba(0,0,0,0.75)", strokeWidth: 2 }}
              >
                YOU · {distYds.toFixed(0)}y
              </text>
            ) : (
              <text
                x={bx + outerR + 4}
                y={by + 5}
                fill="#ffffff"
                fontSize="16"
                fontWeight="800"
                style={{ paintOrder: "stroke", stroke: "rgba(0,0,0,0.8)", strokeWidth: 3 }}
              >
                You are here
              </text>
            )}
          </g>
        );
      })()}
      {!compact && (
        <>
          <text x={mapX(layout.tee.x) + 18} y={mapY(layout.tee.z) + 6} fill="white" fontSize="18" fontWeight="800">
            Tee
          </text>
          <text x={mapX(layout.greenCenter.x) + 18} y={mapY(layout.greenCenter.z) - 12} fill="white" fontSize="18" fontWeight="800">
            Green
          </text>
        </>
      )}
      {/* North indicator (negative Z = toward green = "up" on map). */}
      <g transform={`translate(${width - (compact ? 18 : 30)}, ${compact ? 18 : 30})`}>
        <circle r={compact ? 10 : 16} fill="rgba(0,0,0,0.35)" />
        <path
          d={`M 0 ${compact ? -7 : -11} L ${compact ? 4 : 6} ${compact ? 6 : 9} L 0 ${compact ? 3 : 4} L ${compact ? -4 : -6} ${compact ? 6 : 9} Z`}
          fill="#ffffff"
        />
        <text
          x={0}
          y={compact ? -11 : -18}
          fill="#ffffff"
          fontSize={compact ? 8 : 11}
          fontWeight="800"
          textAnchor="middle"
        >
          GRN
        </text>
      </g>
    </svg>
  );
}

type HudState = {
  aim: number;
  clubIdx: number;
  strokes: number;
  distance: number;
  ball: { x: number; z: number };
  surface: Surface;
  mode: Mode;
  displayPower: number;
  sunk: boolean;
};

type PhysState = {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  mode: Mode;
  lastSafe: THREE.Vector3;
  strokes: number;
  sunk: boolean;
  /** Active shot shape (radians) — non-zero only during flight after a swing. */
  shape: number;
};

function distToCup(p: THREE.Vector3, hole: HoleLayout = POS) {
  return Math.hypot(p.x - hole.cup.x, p.z - hole.cup.z);
}

/**
 * Cinematic "drone" camera path that previews a hole. Returns a position
 * + lookAt for t∈[0,1] interpolated across five keyframes:
 *   0.00  high above & behind the tee, looking down the fairway
 *   0.30  low pass over mid-fairway, banked off-center, looking at green
 *   0.55  swooping behind the green, looking back at the cup
 *   0.75  low orbit around the cup
 *   1.00  settle into the normal play view at the tee
 * The final keyframe matches the regular play camera so the handoff is
 * seamless when the flyover ends (or when the user skips early).
 */
function droneCameraAt(
  layout: HoleLayout,
  t: number,
): { pos: THREE.Vector3; look: THREE.Vector3 } {
  const tee = layout.tee;
  const green = layout.greenCenter;
  const cup = layout.cup;
  const fwd = new THREE.Vector3().subVectors(green, tee);
  const fwdLen = Math.max(fwd.length(), 1);
  fwd.normalize();
  // Horizontal "right of swing line"
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const mid = tee.clone().lerp(green, 0.5);
  const up = (h: number) => new THREE.Vector3(0, h, 0);

  type KF = { t: number; pos: THREE.Vector3; look: THREE.Vector3 };
  const kfs: KF[] = [
    {
      t: 0.0,
      pos: tee.clone().addScaledVector(fwd, -10).add(up(Math.min(28, fwdLen * 0.13 + 14))),
      look: mid.clone().add(up(1.5)),
    },
    {
      t: 0.30,
      pos: mid.clone().addScaledVector(right, fwdLen * 0.10).add(up(7)),
      look: green.clone().add(up(0.6)),
    },
    {
      t: 0.55,
      pos: green.clone().addScaledVector(fwd, 6).addScaledVector(right, 5).add(up(6)),
      look: cup.clone().add(up(0.2)),
    },
    {
      t: 0.78,
      pos: green.clone().addScaledVector(fwd, 3).addScaledVector(right, -6).add(up(2.8)),
      look: cup.clone().add(up(0.15)),
    },
    {
      t: 1.0,
      pos: tee.clone().addScaledVector(fwd, -4.5).addScaledVector(right, 0.6).add(up(2.2)),
      look: tee.clone().addScaledVector(fwd, 8).add(up(0.6)),
    },
  ];

  const clamped = Math.max(0, Math.min(1, t));
  let i = 0;
  while (i < kfs.length - 1 && clamped > kfs[i + 1].t) i++;
  const a = kfs[i];
  const b = kfs[Math.min(i + 1, kfs.length - 1)];
  const span = Math.max(b.t - a.t, 1e-3);
  const u = (clamped - a.t) / span;
  // Smoothstep so the camera eases between waypoints instead of cutting.
  const e = u * u * (3 - 2 * u);
  return {
    pos: a.pos.clone().lerp(b.pos, e),
    look: a.look.clone().lerp(b.look, e),
  };
}

function aimToCup(
  p: THREE.Vector3 | { x: number; z: number },
  hole: HoleLayout = POS,
) {
  return Math.atan2(hole.cup.x - p.x, -(hole.cup.z - p.z));
}

function puttPowerForDistance(distanceMeters: number, surface: Surface) {
  const putter = CLUBS.find((c) => c.putter)!;
  const friction = Math.max(ROLL_FRICTION[surface], 0.1);
  const maxSpeed = putter.carry * 0.6;
  return THREE.MathUtils.clamp(
    Math.sqrt((distanceMeters * 2 * friction) / (maxSpeed * maxSpeed)),
    0.06,
    1,
  );
}

function recommendedPowerForShot(
  club: (typeof CLUBS)[number],
  distanceMeters: number,
  surface: Surface,
  player?: Pick<GolfPlayer, "buildId"> | null,
) {
  if (club.putter) return puttPowerForDistance(distanceMeters, surface);
  const effectiveClub = effectiveClubForLie(
    effectiveClubForBuild(club, getPlayerBuild(player)),
    surface,
  );

  return THREE.MathUtils.clamp(
    Math.sqrt(distanceMeters / Math.max(effectiveClub.carry, 1)),
    0.08,
    1,
  );
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const url = apiUrl(path);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readApiJson<T>(res, url);
}

function getAppRouteBase() {
  const pathname = window.location.pathname;
  if (pathname === "/dsgolf" || pathname.startsWith("/dsgolf/")) return "/dsgolf/";
  if (pathname.startsWith("/game-repos/dsgolf/dist/")) return "/game-repos/dsgolf/dist/";
  return "/";
}

function isPrivateIpv4Hostname(hostname: string) {
  const match = hostname.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const parts = match.slice(1).map((part) => Number(part));
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  return parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31;
}

function isLocalApiHostname(hostname: string) {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) return false;
  if (["localhost", "127.0.0.1", "::1"].includes(normalized)) return true;
  if (normalized.endsWith(".local")) return true;
  return isPrivateIpv4Hostname(normalized);
}

function getConfiguredApiOrigin() {
  const config = (window as typeof window & {
    __PLAYRBB_FRONTEND_CONFIG__?: { apiUrl?: string };
  }).__PLAYRBB_FRONTEND_CONFIG__;
  const configured = String(config?.apiUrl || "https://api.playrbb.com").trim().replace(/\/+$/, "");
  return configured;
}

const APP_ROUTE_BASE = getAppRouteBase();
const API_ROUTE_BASE = APP_ROUTE_BASE === "/" ? "/api" : "/dsgolf-api";
// Same-origin for local dev (server.js / server.mjs serves both bundle + API)
// and for any private/loopback host. On a public hostname the bundle is served
// by a static host (Cloudflare Pages) that cannot run the matchmaking API, so
// route DSGolf API calls to the configured Node API origin
// (__PLAYRBB_FRONTEND_CONFIG__.apiUrl, defaults to api.playrbb.com). That host
// must run a server.js that includes the /dsgolf-api/* handler.
const API_ORIGIN = isLocalApiHostname(window.location.hostname) ? "" : getConfiguredApiOrigin();

function apiUrl(path: string) {
  const raw = path.startsWith("/api/") ? path.slice(4) : path;
  const normalized = raw.startsWith("/") ? raw : `/${raw}`;
  return `${API_ORIGIN}${API_ROUTE_BASE}${normalized}`;
}

async function readApiJson<T>(res: Response, url: string): Promise<T> {
  const text = await res.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (_error) {
      const hint = text.trim().startsWith("<")
        ? "The LAN API returned HTML instead of JSON. Make sure the API server is running and this build is using the API origin, not the static launcher origin."
        : "The LAN API returned invalid JSON.";
      throw new Error(`${hint} (${res.status} ${res.statusText || "response"} from ${url})`);
    }
  }
  if (!res.ok) {
    const message = payload && typeof payload === "object" && "error" in payload
      ? String((payload as { error?: unknown }).error)
      : text || `${res.status} ${res.statusText || "request failed"}`;
    throw new Error(message);
  }
  return payload as T;
}

function controllerJoinUrl(code: string) {
  const url = new URL(APP_ROUTE_BASE, window.location.origin);
  url.searchParams.set("controller", "1");
  url.searchParams.set("code", code);
  return url.toString();
}

async function createSession() {
  const url = apiUrl("/api/session");
  const res = await fetch(url);
  return readApiJson<{ clientId: string }>(res, url);
}

async function getServerConfig() {
  const res = await fetch(apiUrl("/api/config"));
  if (!res.ok) {
    return {
      publicBaseUrl: window.location.origin,
      networkMode: window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" ? "local" : "online",
    } satisfies ServerConfig;
  }
  const config = (await res.json()) as Partial<ServerConfig>;
  const publicBaseUrl = (config.publicBaseUrl || window.location.origin).replace(/\/+$/, "");
  return {
    publicBaseUrl,
    networkMode: config.networkMode === "local" ? "local" : "online",
  } satisfies ServerConfig;
}

type GameProps = {
  layout: HoleLayout;
  aimRef: React.MutableRefObject<number>;
  shotAimOffsetRef: React.MutableRefObject<number>;
  shotShapeRef: React.MutableRefObject<number>;
  clubIdxRef: React.MutableRefObject<number>;
  chargeStartRef: React.MutableRefObject<number | null>;
  pendingShotRef: React.MutableRefObject<boolean>;
  resetTriggerRef: React.MutableRefObject<number>;
  displayPowerRef: React.MutableRefObject<number>;
  viewMode: ViewMode;
  /** When true, the Game runs a scripted "drone" flyover of the hole. */
  introActive?: boolean;
  /** Called when the flyover finishes naturally (so the parent can dismiss the intro UI). */
  onIntroComplete?: () => void;
  playerColors?: { shirt: string; pants: string; hat: string };
  playerBuild?: PlayerBuild;
  /**
   * If non-null when the reset trigger bumps, the ball is restored to this
   * state instead of being placed on the tee. Consumed (set to null) after
   * being applied. Used to "load" the current turn's player ball when turns
   * rotate based on farthest-from-hole.
   */
  pendingBallStateRef?: React.MutableRefObject<{
    pos: THREE.Vector3;
    strokes: number;
    sunk: boolean;
  } | null>;
  onState: (s: Partial<HudState>) => void;
  onLanded: (
    surface: Surface,
    distance: number,
    penalty: boolean,
    position: THREE.Vector3,
    strokes: number,
  ) => void;
};

function Game(props: GameProps) {
  const layout = props.layout;
  const ballRef = useRef<THREE.Group>(null!);
  const playerGroupRef = useRef<THREE.Group>(null!);
  const swingStateRef = useRef<SwingState>({ charge: 0, swing: 0 });
  const physRef = useRef<PhysState>({
    pos: layout.tee.clone(),
    vel: new THREE.Vector3(),
    mode: "idle",
    lastSafe: layout.tee.clone(),
    strokes: 0,
    sunk: false,
    shape: 0,
  });
  const swingStartRef = useRef<number | null>(null);
  const swingPowerRef = useRef(0);
  const swingAnchorRef = useRef(new THREE.Vector3());
  const lastResetTickRef = useRef(0);
  const lastHoleNumberRef = useRef(layout.number);
  const introStartRef = useRef<number | null>(null);
  const introHoleRef = useRef<number>(-1);
  const introCompleteFiredRef = useRef(false);
  const { camera } = useThree();

  const fireShot = (power: number) => {
    const phys = physRef.current;
    const baseClub = CLUBS[props.clubIdxRef.current];
    const surface = classifySurface(phys.pos, layout);
    const club = effectiveClubForLie(
      effectiveClubForBuild(baseClub, props.playerBuild ?? DEFAULT_BUILD),
      surface,
    );
    const shotAim = props.aimRef.current + props.shotAimOffsetRef.current;
    phys.lastSafe.copy(phys.pos);
    phys.lastSafe.y = 0.06;
    phys.vel.copy(clubInitialVelocity(club, power, shotAim));
    // Capture shot shape for this flight — putters don't curve.
    phys.shape = club.putter ? 0 : props.shotShapeRef.current;
    props.shotAimOffsetRef.current = 0;
    props.shotShapeRef.current = 0;
    phys.mode = club.putter ? "rolling" : "flight";
    phys.strokes += 1;
  };

  useFrame((_, dtRaw) => {
    const dt = Math.min(dtRaw, 1 / 30);
    const phys = physRef.current;
    const now = performance.now();

    // reset (full hole reset, or a turn-switch load)
    if (
      props.resetTriggerRef.current !== lastResetTickRef.current ||
      layout.number !== lastHoleNumberRef.current
    ) {
      lastResetTickRef.current = props.resetTriggerRef.current;
      lastHoleNumberRef.current = layout.number;
      const pending = props.pendingBallStateRef?.current ?? null;
      if (pending) {
        phys.pos.copy(pending.pos);
        phys.pos.y = 0.06;
        phys.strokes = pending.strokes;
        phys.sunk = pending.sunk;
        phys.lastSafe.copy(phys.pos);
        if (props.pendingBallStateRef) props.pendingBallStateRef.current = null;
      } else {
        phys.pos.copy(layout.tee);
        phys.strokes = 0;
        phys.sunk = false;
        phys.lastSafe.copy(layout.tee);
      }
      phys.vel.set(0, 0, 0);
      phys.mode = phys.sunk ? "holed" : "idle";
      swingStateRef.current.charge = 0;
      swingStateRef.current.swing = 0;
      swingStartRef.current = null;
      props.chargeStartRef.current = null;
      props.pendingShotRef.current = false;
      props.shotAimOffsetRef.current = 0;
      props.shotShapeRef.current = 0;
      props.displayPowerRef.current = 0;
      phys.shape = 0;
    }

    // charge animation while holding space
    if (
      props.chargeStartRef.current !== null &&
      phys.mode === "idle" &&
      swingStartRef.current === null
    ) {
      const elapsed = (now - props.chargeStartRef.current) / 1000;
      const dp = Math.min(1, elapsed / CHARGE_DURATION);
      props.displayPowerRef.current = dp;
      swingStateRef.current.charge = dp;
    }

    // begin swing on shot release
    if (
      props.pendingShotRef.current &&
      phys.mode === "idle" &&
      swingStartRef.current === null
    ) {
      swingStartRef.current = now;
      swingPowerRef.current = props.displayPowerRef.current;
      swingAnchorRef.current.copy(phys.pos);
      props.pendingShotRef.current = false;
      props.chargeStartRef.current = null;
    }

    // advance swing animation; fire at IMPACT_T
    if (swingStartRef.current !== null) {
      const t = (now - swingStartRef.current) / 1000 / SWING_DURATION;
      swingStateRef.current.swing = Math.min(0.999, t);
      if (t >= IMPACT_T && phys.mode === "idle") {
        fireShot(swingPowerRef.current);
      }
      if (t >= 1) {
        swingStartRef.current = null;
        swingStateRef.current.swing = 0;
        swingStateRef.current.charge = 0;
        props.displayPowerRef.current = 0;
      }
    }

    // physics: flight phase
    if (phys.mode === "flight") {
      phys.vel.y -= GRAVITY * dt;
      // Magnus-like in-flight curve. Side force is perpendicular to the
      // horizontal flight direction, scaled by horizontal speed × shape.
      if (phys.shape !== 0) {
        const horizSpeed = Math.hypot(phys.vel.x, phys.vel.z);
        if (horizSpeed > 0.1) {
          const fx = phys.vel.x / horizSpeed;
          const fz = phys.vel.z / horizSpeed;
          // "right of flight" in horizontal plane.
          const rx = -fz;
          const rz = fx;
          const sideAccel = phys.shape * horizSpeed * SHAPE_CURVE_COEFF;
          phys.vel.x += rx * sideAccel * dt;
          phys.vel.z += rz * sideAccel * dt;
        }
      }
      phys.pos.addScaledVector(phys.vel, dt);
      if (phys.pos.y <= 0.06) {
        phys.pos.y = 0.06;
        const club = CLUBS[props.clubIdxRef.current];
        // tally bounce per club bounciness; damp horizontal speed
        phys.vel.y = -phys.vel.y * club.bounce;
        const surf = classifySurface(phys.pos, layout);
        const surfaceDamp =
          surf === "green" ? 0.85 :
          surf === "fairway" ? 0.78 :
          surf === "bunker" ? 0.30 :
          surf === "water" ? 0.10 : 0.55;
        const horizDamp = (0.55 + club.bounce * 0.25) * surfaceDamp;
        phys.vel.x *= horizDamp;
        phys.vel.z *= horizDamp;
        // small bounces fizzle into roll
        if (phys.vel.y < 1.5) {
          phys.vel.y = 0;
          phys.mode = "rolling";
          // No more Magnus once we're on the ground.
          phys.shape = 0;
        }
      }
    } else if (phys.mode === "rolling") {
      const surf = classifySurface(phys.pos, layout);
      const friction = ROLL_FRICTION[surf];
      const horizSpeed = Math.hypot(phys.vel.x, phys.vel.z);
      const stopSpeed =
        surf === "green" ? STOP_SPEED : surf === "fairway" ? 0.14 : 0.18;
      if (horizSpeed > stopSpeed && friction >= 0) {
        const newSpeed = Math.max(0, horizSpeed - friction * dt);
        const k = newSpeed > 0 ? newSpeed / horizSpeed : 0;
        phys.vel.x *= k;
        phys.vel.z *= k;
        phys.pos.addScaledVector(phys.vel, dt);
        phys.pos.y = 0.06;
      } else {
        phys.vel.set(0, 0, 0);
        phys.mode = "idle";
        const settledSurf = classifySurface(phys.pos, layout);
        let penalty = false;
        if (settledSurf === "water") {
          phys.strokes += 1;
          phys.pos.copy(phys.lastSafe);
          phys.pos.y = 0.06;
          penalty = true;
        } else {
          phys.lastSafe.copy(phys.pos);
        }
        const landedSurface = classifySurface(phys.pos, layout);
        props.aimRef.current = aimToCup(phys.pos, layout);
        props.onLanded(landedSurface, distToCup(phys.pos, layout), penalty, phys.pos, phys.strokes);
      }
    }

    // hole-out detection
    if (
      (phys.mode === "flight" || phys.mode === "rolling") &&
      !phys.sunk
    ) {
      const d = Math.hypot(phys.pos.x - layout.cup.x, phys.pos.z - layout.cup.z);
      const slow = phys.vel.length() < 4.0;
      if (d < layout.cupRadius && slow && phys.pos.y < 0.18) {
        phys.mode = "holed";
        phys.sunk = true;
        phys.vel.set(0, 0, 0);
        phys.pos.set(layout.cup.x, 0.0, layout.cup.z);
      }
    }

    // sync ball mesh
    if (ballRef.current) {
      ballRef.current.position.copy(phys.pos);
      ballRef.current.visible = phys.mode !== "holed";
    }

    // place player beside ball at rest
    if (playerGroupRef.current && phys.mode === "idle") {
      const aim = props.aimRef.current;
      const rightDir = new THREE.Vector3(Math.cos(aim), 0, Math.sin(aim));
      const stanceDir = rightDir.clone().multiplyScalar(-1);
      const club = CLUBS[props.clubIdxRef.current];
      const stanceDistance = club.putter ? 0.48 : 0.58;
      const pp = phys.pos.clone().addScaledVector(stanceDir, stanceDistance);
      pp.y = 0;
      playerGroupRef.current.position.copy(pp);
      // The model's local +X faces the ball; the target line runs perpendicular to it.
      playerGroupRef.current.rotation.y = -aim;
      playerGroupRef.current.visible = true;
    } else if (playerGroupRef.current && phys.mode !== "idle") {
      // keep player at last position so they finish the swing visually
      // but hide once ball is sunk
      if (phys.mode === "holed") playerGroupRef.current.visible = false;
    }

    // camera
    if (props.introActive) {
      // Cinematic drone flyover takes priority while the hole intro is up.
      const INTRO_DURATION = 7.0; // seconds
      if (introStartRef.current === null || layout.number !== introHoleRef.current) {
        introStartRef.current = now;
        introHoleRef.current = layout.number;
        introCompleteFiredRef.current = false;
      }
      const elapsed = (now - introStartRef.current) / 1000;
      const t = Math.min(elapsed / INTRO_DURATION, 1);
      const { pos, look } = droneCameraAt(layout, t);
      camera.position.copy(pos);
      camera.lookAt(look);
      if (t >= 1 && !introCompleteFiredRef.current) {
        introCompleteFiredRef.current = true;
        props.onIntroComplete?.();
      }
    } else {
      // Reset intro timer state once we're back in normal play.
      introStartRef.current = null;
      introCompleteFiredRef.current = false;
      const aim = props.aimRef.current;
      const aimDir = new THREE.Vector3(Math.sin(aim), 0, -Math.cos(aim));
      const backAim = aimDir.clone().multiplyScalar(-1);
      const rightDir = new THREE.Vector3(Math.cos(aim), 0, Math.sin(aim));
      let desired: THREE.Vector3;
      let lookAt: THREE.Vector3;
      const surface = classifySurface(phys.pos, layout);
      const swingActive = swingStartRef.current !== null;
      const puttingView =
        phys.mode === "idle" && surface === "green" && !phys.sunk;
      if (props.viewMode === "overhead" && phys.mode === "idle" && !phys.sunk) {
        const center = phys.pos.clone().lerp(layout.cup, 0.5);
        const distance = distToCup(phys.pos, layout);
        desired = center
          .clone()
          .add(new THREE.Vector3(0, THREE.MathUtils.clamp(distance * 0.7 + 18, 22, 90), 0.01));
        lookAt = center;
      } else if (swingActive) {
        // Keep camera anchored at the player while the swing animation plays;
        // pan the lookAt to follow the ball if it has already been struck.
        const anchor = swingAnchorRef.current;
        desired = anchor
          .clone()
          .addScaledVector(backAim, 4.5)
          .addScaledVector(rightDir, 0.6)
          .add(new THREE.Vector3(0, 2.2, 0));
        lookAt =
          phys.mode === "idle"
            ? anchor.clone().add(new THREE.Vector3(0, 0.6, 0))
            : phys.pos.clone().add(new THREE.Vector3(0, 0.3, 0));
      } else if (phys.mode === "flight" || phys.mode === "rolling") {
        const v = phys.vel;
        const sp = Math.hypot(v.x, v.z);
        const back =
          sp > 0.5
            ? new THREE.Vector3(-v.x / sp, 0, -v.z / sp)
            : backAim;
        desired = phys.pos
          .clone()
          .addScaledVector(back, 9)
          .add(new THREE.Vector3(0, 4.5, 0));
        lookAt = phys.pos.clone().add(new THREE.Vector3(0, 0.3, 0));
      } else if (puttingView) {
        const distance = distToCup(phys.pos, layout);
        desired = phys.pos
          .clone()
          .addScaledVector(backAim, 2.9)
          .addScaledVector(rightDir, 0.35)
          .add(new THREE.Vector3(0, 1.15, 0));
        lookAt = phys.pos
          .clone()
          .addScaledVector(aimDir, Math.min(Math.max(distance, 1.5), 5))
          .add(new THREE.Vector3(0, 0.18, 0));
      } else {
        desired = phys.pos
          .clone()
          .addScaledVector(backAim, 4.5)
          .addScaledVector(rightDir, 0.6)
          .add(new THREE.Vector3(0, 2.2, 0));
        lookAt = phys.pos
          .clone()
          .addScaledVector(aimDir, 8)
          .add(new THREE.Vector3(0, 0.6, 0));
      }
      camera.position.lerp(desired, 0.14);
      camera.lookAt(lookAt);
    }

    // surface this frame
    const surface = classifySurface(phys.pos, layout);
    props.onState({
      strokes: phys.strokes,
      distance: distToCup(phys.pos, layout),
      ball: { x: phys.pos.x, z: phys.pos.z },
      surface,
      mode: phys.mode,
      displayPower: props.displayPowerRef.current,
      sunk: phys.sunk,
    });
  });

  const playerClub = CLUBS[props.clubIdxRef.current];
  // Pick the golfer's swing animation to match how this shot will be played.
  const playerSwingMode: SwingMode = playerClub.putter
    ? "putt"
    : isChipShot(
          playerClub,
          distToCup(physRef.current.pos, layout),
          classifySurface(physRef.current.pos, layout),
        )
      ? "chip"
      : "full";

  return (
    <>
      <Hole layout={layout} />
      <GolfBall ref={ballRef} />
      <group ref={playerGroupRef}>
        <Suspense fallback={null}>
          <Player
            stateRef={swingStateRef}
            club={playerClub}
            swingMode={playerSwingMode}
            shirtColor={props.playerColors?.shirt}
            pantsColor={props.playerColors?.pants}
            hatColor={props.playerColors?.hat}
          />
        </Suspense>
      </group>
      <BallTrail physRef={physRef} />
      <TrajectoryPreview
        layout={layout}
        physRef={physRef}
        aimRef={props.aimRef}
        clubIdxRef={props.clubIdxRef}
        chargeStartRef={props.chargeStartRef}
        displayPowerRef={props.displayPowerRef}
        playerBuild={props.playerBuild ?? DEFAULT_BUILD}
      />
    </>
  );
}

const GOLF_BALL_DIMPLES: Array<[number, number, number]> = [
  [0.02, 0.048, 0.032],
  [-0.024, 0.05, 0.026],
  [0.043, 0.036, -0.018],
  [-0.044, 0.034, -0.016],
  [0, 0.058, 0],
  [0.034, 0.017, 0.046],
  [-0.032, 0.018, 0.045],
  [0.05, 0.012, 0.03],
  [-0.05, 0.012, 0.03],
];

function BallDimple({ point }: { point: [number, number, number] }) {
  const normal = new THREE.Vector3(...point).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 0, 1),
    normal,
  );
  return (
    <mesh
      position={[normal.x * 0.061, normal.y * 0.061, normal.z * 0.061]}
      quaternion={[q.x, q.y, q.z, q.w]}
    >
      <circleGeometry args={[0.006, 10]} />
      <meshBasicMaterial color="#d7dbe0" side={THREE.DoubleSide} />
    </mesh>
  );
}

const GolfBall = forwardRef<THREE.Group>(function GolfBall(_, ref) {
  return (
    <group ref={ref}>
      <mesh castShadow>
        <sphereGeometry args={[0.06, 28, 28]} />
        <meshStandardMaterial color="#fafafa" roughness={0.32} />
      </mesh>
      {GOLF_BALL_DIMPLES.map((point, index) => (
        <BallDimple key={`dimple-${index}`} point={point} />
      ))}
    </group>
  );
});

/**
 * Smoking-comet trail behind the ball while it's in flight or rolling.
 * Records the last ~120 ball positions and renders them as a tapered
 * polyline that fades out a couple of seconds after the ball settles.
 * This is the bit that makes a fade or draw read visually — you can
 * actually see the curve through the air.
 */
function BallTrail({ physRef }: { physRef: React.MutableRefObject<PhysState> }) {
  const TRAIL_MAX = 120;
  const lineRef = useRef<any>(null);
  const trailRef = useRef<THREE.Vector3[]>([]);
  const fadeRef = useRef(1);
  const lastModeRef = useRef<Mode>("idle");
  const seed = useMemo(
    () => [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0.0001, 0)],
    [],
  );

  useFrame((_, dtRaw) => {
    const dt = Math.min(dtRaw, 1 / 30);
    const phys = physRef.current;
    const line = lineRef.current;
    if (!line) return;

    // Drop the trail on a fresh shot — i.e. transitions from idle → flight/rolling.
    if (
      (phys.mode === "flight" || phys.mode === "rolling") &&
      lastModeRef.current === "idle"
    ) {
      trailRef.current = [];
      fadeRef.current = 1;
    }
    lastModeRef.current = phys.mode;

    if (phys.mode === "flight" || phys.mode === "rolling") {
      const t = trailRef.current;
      const last = t[t.length - 1];
      const here = phys.pos.clone();
      if (!last || last.distanceTo(here) > 0.05) {
        t.push(here);
        if (t.length > TRAIL_MAX) t.shift();
      }
      fadeRef.current = 1;
    } else {
      // Fade out over ~1.6 s once the ball stops.
      fadeRef.current = Math.max(0, fadeRef.current - dt / 1.6);
    }

    if (trailRef.current.length < 2 || fadeRef.current <= 0.01) {
      line.visible = false;
      return;
    }
    line.visible = true;
    // Drei's <Line> exposes geometry.setPositions(number[]).
    const flat: number[] = [];
    for (const p of trailRef.current) {
      flat.push(p.x, Math.max(p.y, 0.04), p.z);
    }
    line.geometry.setPositions(flat);
    if (line.material && "opacity" in line.material) {
      line.material.opacity = 0.85 * fadeRef.current;
      line.material.transparent = true;
    }
  });

  return (
    <Line
      ref={lineRef}
      points={seed}
      color="#ffd23b"
      lineWidth={3}
      transparent
      opacity={0.85}
    />
  );
}

function TrajectoryPreview({
  layout,
  physRef,
  aimRef,
  clubIdxRef,
  chargeStartRef,
  displayPowerRef,
  playerBuild,
}: {
  layout: HoleLayout;
  physRef: React.MutableRefObject<PhysState>;
  aimRef: React.MutableRefObject<number>;
  clubIdxRef: React.MutableRefObject<number>;
  chargeStartRef: React.MutableRefObject<number | null>;
  displayPowerRef: React.MutableRefObject<number>;
  playerBuild: PlayerBuild;
}) {
  const lineRef = useRef<any>(null);
  const cupLineRef = useRef<any>(null);
  const stopRef = useRef<THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>>(null!);
  const seed = useMemo(
    () => [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0.1, 0)],
    [],
  );

  useFrame(() => {
    if (!lineRef.current) return;
    const phys = physRef.current;
    if (phys.mode !== "idle") {
      lineRef.current.visible = false;
      if (cupLineRef.current) cupLineRef.current.visible = false;
      if (stopRef.current) stopRef.current.visible = false;
      return;
    }
    lineRef.current.visible = true;

    const surf = classifySurface(phys.pos, layout);
    const club = effectiveClubForLie(
      effectiveClubForBuild(CLUBS[clubIdxRef.current], playerBuild),
      surf,
    );
    const charging = chargeStartRef.current !== null;
    const power = charging ? displayPowerRef.current : 0.7;
    const v0 = clubInitialVelocity(club, power, aimRef.current);

    let pts: THREE.Vector3[];
    if (club.putter) {
      const speed0 = Math.hypot(v0.x, v0.z);
      const friction = ROLL_FRICTION[surf] || 1.2;
      const dir = new THREE.Vector3(v0.x, 0, v0.z);
      if (dir.lengthSq() > 0) dir.normalize();
      const p = phys.pos.clone().add(new THREE.Vector3(0, 0.03, 0));
      let speed = speed0;
      pts = [p.clone()];
      for (let i = 0; i < 42 && speed > 0.04; i++) {
        const dt = 0.08;
        const nextSpeed = Math.max(0, speed - Math.max(friction, 0.1) * dt);
        const avgSpeed = (speed + nextSpeed) * 0.5;
        p.addScaledVector(dir, avgSpeed * dt);
        pts.push(p.clone());
        speed = nextSpeed;
        if (Math.hypot(p.x - layout.cup.x, p.z - layout.cup.z) < layout.cupRadius) break;
      }

      if (cupLineRef.current) {
        cupLineRef.current.visible = surf === "green";
        const start = phys.pos.clone().add(new THREE.Vector3(0, 0.035, 0));
        const end = layout.cup.clone().add(new THREE.Vector3(0, 0.035, 0));
        cupLineRef.current.geometry.setPositions([
          start.x,
          start.y,
          start.z,
          end.x,
          end.y,
          end.z,
        ]);
      }

      if (stopRef.current) {
        const end = pts[pts.length - 1];
        stopRef.current.visible = true;
        stopRef.current.position.set(end.x, 0.075, end.z);
        stopRef.current.scale.setScalar(1);
        stopRef.current.material.color.set("#ffeb3b");
      }
    } else {
      if (cupLineRef.current) cupLineRef.current.visible = false;
      pts = simulateFlight(
        phys.pos.clone().add(new THREE.Vector3(0, 0.02, 0)),
        v0,
      );
      if (stopRef.current) {
        const end = pts[pts.length - 1];
        stopRef.current.visible = true;
        stopRef.current.position.set(end.x, 0.09, end.z);
        stopRef.current.scale.setScalar(1.35);
        stopRef.current.material.color.set("#ff9f1c");
      }
    }

    const flat: number[] = [];
    for (const p of pts) flat.push(p.x, p.y + 0.04, p.z);
    if (lineRef.current.geometry?.setPositions) {
      lineRef.current.geometry.setPositions(flat);
    }
  });

  return (
    <>
      <Line
        ref={cupLineRef}
        points={seed}
        color="#ffffff"
        lineWidth={1.5}
        dashed
        dashSize={0.18}
        gapSize={0.16}
        transparent
        opacity={0.55}
      />
      <Line
        ref={lineRef}
        points={seed}
        color="#ffeb3b"
        lineWidth={3}
        dashed
        dashSize={0.4}
        gapSize={0.2}
        transparent
        opacity={0.9}
      />
      <mesh ref={stopRef} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.16, 0.22, 28]} />
        <meshBasicMaterial color="#ffeb3b" transparent opacity={0.9} />
      </mesh>
    </>
  );
}

function GolfGame({
  hostInfo,
  players: playersProp,
  gameSettings = DEFAULT_GAME_SETTINGS,
  onGameSettingsChange,
}: {
  hostInfo?: HostInfo;
  players?: GolfPlayer[];
  gameSettings?: GameSettings;
  onGameSettingsChange?: (patch: Partial<GameSettings>) => void;
}) {
  const players = useMemo<GolfPlayer[]>(
    () => (playersProp && playersProp.length > 0 ? playersProp : [defaultPlayer(0, "local", "solo")]),
    [playersProp],
  );
  const openingPlayer = players[0];
  const [holeIndex, setHoleIndex] = useState(0);
  const [currentPlayerIdx, setCurrentPlayerIdx] = useState(0);
  const layout = useMemo(() => makeHoleLayout(COURSE_HOLES[holeIndex]), [holeIndex]);
  const [hud, setHud] = useState<HudState>({
    aim: aimToCup(POS.tee),
    clubIdx: suggestClubForBuild(POS.tee.distanceTo(POS.cup), false, openingPlayer, "tee"),
    strokes: 0,
    distance: POS.tee.distanceTo(POS.cup),
    ball: { x: POS.tee.x, z: POS.tee.z },
    surface: "tee",
    mode: "idle",
    displayPower: 0,
    sunk: false,
  });
  const [message, setMessage] = useState<string>("");
  const [bannerName, setBannerName] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("play");
  const [introVisible, setIntroVisible] = useState(true);
  // Per-player scorecards; outer index = player, inner = hole.
  const [playerScorecards, setPlayerScorecards] = useState<Array<Array<ScoreEntry | null>>>(
    () => players.map(() => COURSE_HOLES.map(() => null)),
  );
  // Single-player legacy view: just the current player's card.
  const scorecard = playerScorecards[currentPlayerIdx] ?? COURSE_HOLES.map(() => null);
  const setScorecard = (updater: (prev: Array<ScoreEntry | null>) => Array<ScoreEntry | null>) => {
    setPlayerScorecards((prev) => {
      const next = prev.map((arr) => [...arr]);
      next[currentPlayerIdx] = updater(next[currentPlayerIdx] ?? COURSE_HOLES.map(() => null));
      return next;
    });
  };
  const currentPlayer = players[currentPlayerIdx] ?? players[0];
  const currentBuild = getPlayerBuild(currentPlayer);
  const currentPlayerRef = useRef(currentPlayer);
  currentPlayerRef.current = currentPlayer;

  // If the players prop changes shape (e.g. mid-game add), keep scorecards in sync.
  useEffect(() => {
    setPlayerScorecards((prev) => {
      if (prev.length === players.length) return prev;
      const next: Array<Array<ScoreEntry | null>> = players.map((_, i) =>
        prev[i] ? [...prev[i]] : COURSE_HOLES.map(() => null),
      );
      return next;
    });
  }, [players.length]);

  const aimRef = useRef(aimToCup(layout.tee, layout));
  const shotAimOffsetRef = useRef(0);
  const shotShapeRef = useRef(0);
  const clubIdxRef = useRef(suggestClubForBuild(distToCup(layout.tee, layout), false, openingPlayer, "tee"));
  const chargeStartRef = useRef<number | null>(null);
  const pendingShotRef = useRef(false);
  const resetTriggerRef = useRef(0);
  const displayPowerRef = useRef(0);
  const viewModeRef = useRef<ViewMode>("play");
  const introVisibleRef = useRef(true);
  const dragAimRef = useRef<{ active: boolean; x: number }>({
    active: false,
    x: 0,
  });
  const hudRef = useRef(hud);
  hudRef.current = hud;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const holeIndexRef = useRef(holeIndex);
  holeIndexRef.current = holeIndex;
  viewModeRef.current = viewMode;
  introVisibleRef.current = introVisible;
  const messageTimeoutRef = useRef<number | null>(null);

  const publishPhoneState = (state: Partial<PhoneSyncState> = {}) => {
    if (!hostInfo) return;
    const player = players[currentPlayerIdx] ?? players[0];
    const clubIdx = state.clubIdx ?? clubIdxRef.current;
    const club = CLUBS[clubIdx] ?? CLUBS[clubIdxRef.current];
    const distanceMeters = state.distanceMeters ?? hudRef.current.distance;
    const surface = state.surface ?? hudRef.current.surface;
    const full: PhoneSyncState = {
      clubIdx,
      currentPlayerId: player?.id,
      currentPlayerName: player?.name,
      currentPlayerBuildId: normalizeBuildId(player?.buildId),
      powerBalance: normalizePowerBalance(gameSettings.powerBalance),
      isPutter: !!club.putter,
      distanceMeters,
      surface,
      recommendedPower: recommendedPowerForShot(club, distanceMeters, surface, player),
      ...state,
    };
    void apiPost("/api/lobbies/state", {
      clientId: hostInfo.clientId,
      code: hostInfo.code,
      state: full,
    }).catch(() => {});
  };

  // Re-publish whenever the active player changes so phones can show whose turn it is.
  useEffect(() => {
    publishPhoneState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPlayerIdx]);

  const alignToPin = () => {
    aimRef.current = aimToCup(hudRef.current.ball, layoutRef.current);
    setHud((s) => ({ ...s, aim: aimRef.current }));
  };

  const nudgeAim = (amount: number) => {
    aimRef.current += amount;
    setHud((s) => ({ ...s, aim: aimRef.current }));
  };

  const selectClub = (index: number) => {
    if (index < 0 || index >= CLUBS.length) return;
    clubIdxRef.current = index;
    setHud((s) => ({ ...s, clubIdx: index }));
    publishPhoneState({ clubIdx: index });
  };

  const autoPickClub = () => {
    const buildAwareIdx = suggestClubForBuild(
      hudRef.current.distance,
      hudRef.current.surface === "green",
      currentPlayerRef.current,
      hudRef.current.surface,
    );
    clubIdxRef.current = buildAwareIdx;
    if (hudRef.current.surface === "green") {
      aimRef.current = aimToCup(hudRef.current.ball, layoutRef.current);
    }
    setHud((s) => ({ ...s, clubIdx: buildAwareIdx, aim: aimRef.current }));
    publishPhoneState({ clubIdx: buildAwareIdx });
  };

  const remoteSwing = (
    power: number,
    pathError = 0,
    pathQuality = 1,
    label = "",
    shape = 0,
  ) => {
    if (introVisibleRef.current) return;
    if (hudRef.current.mode !== "idle" || hudRef.current.sunk) return;
    const putting = CLUBS[clubIdxRef.current]?.putter;
    const build = getPlayerBuild(currentPlayerRef.current);
    const baseClub = CLUBS[clubIdxRef.current] ?? CLUBS[0];
    const lie = hudRef.current.surface;
    const liePenalty = lieErrorFactor(baseClub, lie);
    const quality = THREE.MathUtils.clamp(pathQuality, 0, 1);
    const maxMiss = putting ? 0.16 : 0.34;
    const miss = THREE.MathUtils.clamp(pathError * pathMissFactor(build) * liePenalty, -maxMiss, maxMiss);
    const p = putting
      ? THREE.MathUtils.clamp(power, 0.05, 1)
      : THREE.MathUtils.clamp(power * THREE.MathUtils.lerp(0.82, 1, quality), 0.05, 1);
    shotAimOffsetRef.current = miss;
    // Cap shape so a wild reading can't produce a hook around the whole
    // map. Putters are flat-rolling — no curve.
    shotShapeRef.current = putting ? 0 : THREE.MathUtils.clamp(shape * controlShapeFactor(build) * liePenalty, -0.45, 0.45);
    if (label) {
      const missLabel =
        Math.abs(miss) < 0.035
          ? ""
          : miss > 0
            ? " · pushed right"
            : " · pulled left";
      flashMessage(`${label}${missLabel}`, 1800);
    }
    chargeStartRef.current = performance.now() - p * CHARGE_DURATION * 1000;
    displayPowerRef.current = p;
    pendingShotRef.current = true;
  };

  const handleControllerAction = (action: ControllerAction) => {
    if (action.type === "aim") nudgeAim(action.delta);
    else if (action.type === "club") selectClub(action.index);
    else if (action.type === "autoClub") autoPickClub();
    else if (action.type === "pin") alignToPin();
    else if (action.type === "view") {
      const next = viewModeRef.current === "play" ? "overhead" : "play";
      viewModeRef.current = next;
      setViewMode(next);
    } else if (action.type === "swing") {
      remoteSwing(
        action.power,
        action.pathError ?? 0,
        action.pathQuality ?? 1,
        action.label ?? "",
        action.shape ?? 0,
      );
    }
  };

  const flashMessage = (text: string, ms: number) => {
    setMessage(text);
    if (messageTimeoutRef.current !== null) {
      window.clearTimeout(messageTimeoutRef.current);
    }
    messageTimeoutRef.current = window.setTimeout(() => setMessage(""), ms);
  };

  const setUpHole = (nextIndex: number, announce = true) => {
    const nextLayout = makeHoleLayout(COURSE_HOLES[nextIndex]);
    const nextDistance = distToCup(nextLayout.tee, nextLayout);
    const nextClub = suggestClubForBuild(nextDistance, false, players[0], "tee");
    aimRef.current = aimToCup(nextLayout.tee, nextLayout);
    clubIdxRef.current = nextClub;
    shotAimOffsetRef.current = 0;
    chargeStartRef.current = null;
    pendingShotRef.current = false;
    displayPowerRef.current = 0;
    resetTriggerRef.current += 1;
    setHoleIndex(nextIndex);
    setIntroVisible(true);
    setHud({
      aim: aimRef.current,
      clubIdx: nextClub,
      strokes: 0,
      distance: nextDistance,
      ball: { x: nextLayout.tee.x, z: nextLayout.tee.z },
      surface: "tee",
      mode: "idle",
      displayPower: 0,
      sunk: false,
    });
    publishPhoneState({ clubIdx: nextClub, distanceMeters: nextDistance, surface: "tee" });
    if (announce) {
      flashMessage(`Hole ${nextLayout.number} · Par ${nextLayout.par}`, 1800);
    }
  };

  // Per-player ball state for the CURRENT hole. null = hasn't played a
  // shot yet on this hole (treated as "on tee, 0 strokes").
  type PlayerBall = {
    pos: THREE.Vector3;
    strokes: number;
    sunk: boolean;
    teedOff: boolean;
  };
  const playerBallStatesRef = useRef<Array<PlayerBall | null>>(
    players.map(() => null),
  );
  // Consumed by Game on the next reset to load a specific ball state
  // (used when swapping which player is up mid-hole).
  const pendingBallStateRef = useRef<{
    pos: THREE.Vector3;
    strokes: number;
    sunk: boolean;
  } | null>(null);

  // Reset per-player ball states when a new hole begins.
  useEffect(() => {
    playerBallStatesRef.current = players.map(() => null);
  }, [holeIndex, players.length]);

  const currentPlayerIdxRef = useRef(currentPlayerIdx);
  currentPlayerIdxRef.current = currentPlayerIdx;

  const showTurnBanner = (name: string) => {
    setBannerName(name);
    window.setTimeout(() => {
      setBannerName((curr) => (curr === name ? null : curr));
    }, 2200);
  };

  /**
   * Switch the active turn to `newIdx`, loading that player's saved ball
   * state (or the tee, if they haven't teed off yet) into the Game.
   */
  const switchToPlayer = (newIdx: number) => {
    const saved = playerBallStatesRef.current[newIdx];
    const tee = layoutRef.current.tee;
    const pos = saved?.teedOff ? saved.pos.clone() : tee.clone();
    pos.y = 0.06;
    const strokes = saved?.strokes ?? 0;
    const sunk = saved?.sunk ?? false;

    pendingBallStateRef.current = { pos: pos.clone(), strokes, sunk };
    resetTriggerRef.current += 1;

    const dist = Math.hypot(pos.x - layoutRef.current.cup.x, pos.z - layoutRef.current.cup.z);
    const surf = classifySurface(pos, layoutRef.current);
    const nextPlayer = players[newIdx];
    const club = suggestClubForBuild(dist, surf === "green", nextPlayer, surf);
    aimRef.current = aimToCup({ x: pos.x, z: pos.z }, layoutRef.current);
    clubIdxRef.current = club;
    shotAimOffsetRef.current = 0;
    chargeStartRef.current = null;
    pendingShotRef.current = false;
    displayPowerRef.current = 0;

    setCurrentPlayerIdx(newIdx);
    setHud({
      aim: aimRef.current,
      clubIdx: club,
      strokes,
      distance: dist,
      ball: { x: pos.x, z: pos.z },
      surface: surf,
      mode: "idle",
      displayPower: 0,
      sunk,
    });

    if (nextPlayer) {
      showTurnBanner(nextPlayer.name);
      flashMessage(`${nextPlayer.name} is up`, 2000);
    }
  };

  /**
   * Determine the next player to swing, given current ball states:
   *  - if anyone hasn't teed off, they're up (roster order)
   *  - otherwise the player whose ball is FARTHEST from the cup is up
   *  - players who have sunk are skipped
   * Returns -1 if everyone has sunk.
   */
  const computeNextActivePlayer = (): number => {
    const remaining: number[] = [];
    for (let i = 0; i < players.length; i++) {
      if (!playerBallStatesRef.current[i]?.sunk) remaining.push(i);
    }
    if (remaining.length === 0) return -1;
    const notTeedOff = remaining.filter(
      (i) => !playerBallStatesRef.current[i]?.teedOff,
    );
    if (notTeedOff.length > 0) return notTeedOff[0];
    const cup = layoutRef.current.cup;
    return remaining.reduce((farIdx, i) => {
      const a = playerBallStatesRef.current[i]!.pos;
      const b = playerBallStatesRef.current[farIdx]!.pos;
      const da = Math.hypot(a.x - cup.x, a.z - cup.z);
      const db = Math.hypot(b.x - cup.x, b.z - cup.z);
      return da > db ? i : farIdx;
    }, remaining[0]);
  };

  /**
   * Called whenever the active player completes a shot (ball settles or
   * goes in). Records that player's new ball state, then either keeps
   * them on (if still farthest) or swaps to the next player.
   */
  const advanceTurnAfterShot = (
    position: { x: number; z: number },
    strokes: number,
    sunk: boolean,
  ) => {
    const idx = currentPlayerIdxRef.current;
    const ballPos = new THREE.Vector3(position.x, 0.06, position.z);
    playerBallStatesRef.current[idx] = {
      pos: ballPos,
      strokes,
      sunk,
      teedOff: true,
    };

    // All players sunk → advance hole (existing hud.sunk effect schedules it).
    const allSunk = players.every(
      (_, i) => playerBallStatesRef.current[i]?.sunk,
    );
    if (allSunk) return;

    const nextIdx = computeNextActivePlayer();
    if (nextIdx === -1) return;

    if (nextIdx === idx && !sunk) {
      // Same player remains farthest — keep going, no swap.
      return;
    }

    // Pause briefly before swapping so the shot result is visible.
    const delay = sunk ? 1500 : 350;
    window.setTimeout(() => {
      switchToPlayer(nextIdx);
    }, delay);
  };

  // Per-hole completion: when this player sinks, record their score; if
  // everyone has sunk, schedule the hole advance.
  useEffect(() => {
    if (!hud.sunk) return;
    setScorecard((prev) => {
      if (prev[holeIndex]) return prev;
      const next = [...prev];
      next[holeIndex] = { strokes: hud.strokes, par: layout.par };
      return next;
    });
    // Mirror this into per-player ball state for the turn logic below.
    advanceTurnAfterShot({ x: hud.ball.x, z: hud.ball.z }, hud.strokes, true);

    const everyoneDone = players.every(
      (_, i) => playerBallStatesRef.current[i]?.sunk,
    );
    if (!everyoneDone) return;

    const lastHole = holeIndex === COURSE_HOLES.length - 1;
    if (lastHole) return; // game over — leave on overlay
    const timer = window.setTimeout(() => {
      playerBallStatesRef.current = players.map(() => null);
      setCurrentPlayerIdx(0);
      setUpHole(holeIndex + 1);
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [hud.sunk, holeIndex]);

  // First-of-hole banner: when intro overlay is dismissed and we're on player 0.
  useEffect(() => {
    if (introVisible) return;
    if (currentPlayerIdx !== 0) return;
    const first = players[0];
    if (!first) return;
    showTurnBanner(first.name);
    flashMessage(`${first.name} is up`, 2000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [introVisible, holeIndex]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (introVisibleRef.current) {
        if (e.code === "Enter" || e.code === "Space") {
          e.preventDefault();
          setIntroVisible(false);
        }
        return;
      }
      if (e.code === "KeyA" || e.code === "ArrowLeft") {
        const putting =
          hudRef.current.surface === "green" && CLUBS[clubIdxRef.current]?.putter;
        const modifier = e.shiftKey ? 0.4 : e.altKey ? 2.2 : 1;
        nudgeAim(-(putting ? PUTT_AIM_STEP : FULL_AIM_STEP) * modifier);
      } else if (e.code === "KeyD" || e.code === "ArrowRight") {
        const putting =
          hudRef.current.surface === "green" && CLUBS[clubIdxRef.current]?.putter;
        const modifier = e.shiftKey ? 0.4 : e.altKey ? 2.2 : 1;
        nudgeAim((putting ? PUTT_AIM_STEP : FULL_AIM_STEP) * modifier);
      } else if (e.code === "Space") {
        e.preventDefault();
        if (e.repeat) return;
        if (chargeStartRef.current === null && !pendingShotRef.current) {
          shotAimOffsetRef.current = 0;
          chargeStartRef.current = performance.now();
          displayPowerRef.current = 0;
        }
      } else if (e.code === "KeyR") {
        setUpHole(holeIndexRef.current, false);
        flashMessage("Reset", 800);
      } else if (e.code === "KeyC") {
        autoPickClub();
      } else if (e.code === "KeyQ") {
        alignToPin();
      } else if (e.code === "KeyV") {
        const next = viewModeRef.current === "play" ? "overhead" : "play";
        viewModeRef.current = next;
        setViewMode(next);
      } else if (e.code.startsWith("Digit")) {
        const n = parseInt(e.code.slice(5), 10);
        if (n >= 1 && n <= Math.min(CLUBS.length, 9)) {
          selectClub(n - 1);
        }
      } else if (e.code === "BracketLeft") {
        selectClub((clubIdxRef.current - 1 + CLUBS.length) % CLUBS.length);
      } else if (e.code === "BracketRight") {
        selectClub((clubIdxRef.current + 1) % CLUBS.length);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        if (chargeStartRef.current !== null) {
          pendingShotRef.current = true;
        }
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      if (
        introVisibleRef.current ||
        e.button !== 0 ||
        hudRef.current.mode !== "idle" ||
        hudRef.current.sunk
      ) {
        return;
      }
      dragAimRef.current = { active: true, x: e.clientX };
    };

    const onPointerMove = (e: PointerEvent) => {
      const drag = dragAimRef.current;
      if (!drag.active) return;
      const dx = e.clientX - drag.x;
      drag.x = e.clientX;
      const putting =
        hudRef.current.surface === "green" && CLUBS[clubIdxRef.current]?.putter;
      nudgeAim(dx * (putting ? 0.004 : 0.006));
    };

    const onPointerUp = () => {
      dragAimRef.current.active = false;
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, []);

  useEffect(() => {
    if (!hostInfo) return;
    publishPhoneState();
  }, [hostInfo, gameSettings.powerBalance]);

  useEffect(() => {
    if (!hostInfo) return;
    const events = new EventSource(
      apiUrl(`/api/events?code=${encodeURIComponent(hostInfo.code)}&clientId=${encodeURIComponent(
        hostInfo.clientId,
      )}`),
    );
    events.addEventListener("controller_joined", () => {
      flashMessage("Controller connected", 1400);
      publishPhoneState();
    });
    events.addEventListener("controller_action", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as {
        action: ControllerAction;
      };
      handleControllerAction(payload.action);
    });
    events.onerror = () => {
      flashMessage("Controller connection lost", 1600);
    };
    return () => events.close();
  }, [hostInfo]);

  const onState = (s: Partial<HudState>) => {
    setHud((prev) => {
      const next = { ...prev, ...s, aim: aimRef.current, clubIdx: clubIdxRef.current };
      // skip re-render if nothing meaningful changed
      if (
        prev.strokes === next.strokes &&
        prev.surface === next.surface &&
        prev.mode === next.mode &&
        prev.sunk === next.sunk &&
        Math.abs(prev.distance - next.distance) < 0.25 &&
        Math.abs(prev.displayPower - next.displayPower) < 0.01 &&
        Math.abs(prev.ball.x - next.ball.x) < 0.05 &&
        Math.abs(prev.ball.z - next.ball.z) < 0.05 &&
        prev.aim === next.aim &&
        prev.clubIdx === next.clubIdx
      ) {
        return prev;
      }
      return next;
    });
  };

  const onLanded = (
    surface: Surface,
    distance: number,
    penalty: boolean,
    position: THREE.Vector3,
    strokes: number,
  ) => {
    const idx = suggestClubForBuild(distance, surface === "green", currentPlayerRef.current, surface);
    clubIdxRef.current = idx;
    aimRef.current = aimToCup(position, layoutRef.current);
    setHud((s) => ({
      ...s,
      clubIdx: idx,
      aim: aimRef.current,
      ball: { x: position.x, z: position.z },
    }));
    publishPhoneState({ clubIdx: idx, distanceMeters: distance, surface });
    if (penalty) flashMessage("Splash! +1 stroke", 2200);
    else if (surface === "bunker") flashMessage("In the bunker", 1600);
    else if (surface === "rough") flashMessage("In the rough", 1200);
    else if (surface === "green") flashMessage("On the green", 1200);
    advanceTurnAfterShot({ x: position.x, z: position.z }, strokes, false);
  };

  const club = CLUBS[hud.clubIdx];
  const yards = (hud.distance / 0.9144).toFixed(0);
  const targetPower = recommendedPowerForShot(club, hud.distance, hud.surface, currentPlayer);

  return (
    <>
      <Canvas
        shadows
        dpr={[1, 2]}
        camera={{ fov: 55, position: [0, 5, layout.tee.z + 8] }}
      >
        <Game
          layout={layout}
          aimRef={aimRef}
          shotAimOffsetRef={shotAimOffsetRef}
          shotShapeRef={shotShapeRef}
          clubIdxRef={clubIdxRef}
          chargeStartRef={chargeStartRef}
          pendingShotRef={pendingShotRef}
          resetTriggerRef={resetTriggerRef}
          displayPowerRef={displayPowerRef}
          viewMode={viewMode}
          pendingBallStateRef={pendingBallStateRef}
          introActive={introVisible && !hud.sunk}
          onIntroComplete={() => {
            if (introVisibleRef.current) setIntroVisible(false);
          }}
          playerColors={{
            shirt: currentPlayer.shirtColor,
            pants: currentPlayer.pantsColor,
            hat: currentPlayer.hatColor,
          }}
          playerBuild={currentBuild}
          onState={onState}
          onLanded={onLanded}
        />
      </Canvas>
      <HUD
        club={club}
        clubIdx={hud.clubIdx}
        strokes={hud.strokes}
        yards={yards}
        power={hud.displayPower}
        aim={hud.aim}
        surface={hud.surface}
        sunk={hud.sunk}
        message={message}
        targetPower={targetPower}
        viewMode={viewMode}
        layout={layout}
        ball={hud.ball}
        holeNumber={layout.number}
        holePar={layout.par}
        holesTotal={COURSE_HOLES.length}
        finalHole={holeIndex === COURSE_HOLES.length - 1}
        currentPlayer={currentPlayer}
        currentBuild={currentBuild}
        players={players}
        playerScorecards={playerScorecards}
        scorecard={scorecard}
        holeIndex={holeIndex}
      />
      {introVisible && !hud.sunk && (
        <HoleIntroOverlay
          layout={layout}
          scorecard={scorecard}
          holeIndex={holeIndex}
          selectedClub={club}
          onStart={() => setIntroVisible(false)}
          players={players}
          playerScorecards={playerScorecards}
          currentPlayerIdx={currentPlayerIdx}
        />
      )}
      {bannerName && <TurnBanner name={bannerName} />}
      {players.length > 1 && (
        <PlayerStandings players={players} scorecards={playerScorecards} currentIdx={currentPlayerIdx} />
      )}
      {hostInfo && (
        <HostBadge
          hostInfo={hostInfo}
          gameSettings={gameSettings}
          onGameSettingsChange={onGameSettingsChange}
        />
      )}
    </>
  );
}

function TurnBanner({ name }: { name: string }) {
  return (
    <div
      style={{
        position: "absolute",
        top: "26%",
        left: "50%",
        transform: "translateX(-50%)",
        pointerEvents: "none",
        textAlign: "center",
        fontFamily: "-apple-system, system-ui, sans-serif",
        color: "white",
      }}
    >
      <div
        style={{
          padding: "10px 28px",
          background: "rgba(11,24,18,0.78)",
          border: "2px solid #ffd23b",
          borderRadius: 16,
          boxShadow: "0 12px 40px rgba(0,0,0,0.45)",
          fontSize: 38,
          fontWeight: 900,
          letterSpacing: 1.5,
          textShadow: "0 2px 6px rgba(0,0,0,0.7)",
          animation: "dsTurnBannerIn 220ms ease-out",
        }}
      >
        {name} is up
      </div>
      <style>{`
        @keyframes dsTurnBannerIn {
          from { transform: scale(0.85); opacity: 0; }
          to { transform: scale(1); opacity: 1; }
        }
      `}</style>
    </div>
  );
}

function PlayerStandings({
  players,
  scorecards,
  currentIdx,
}: {
  players: GolfPlayer[];
  scorecards: Array<Array<ScoreEntry | null>>;
  currentIdx: number;
}) {
  return (
    <div
      style={{
        position: "absolute",
        right: 16,
        top: 96,
        background: "rgba(11,24,18,0.72)",
        border: "1px solid rgba(255,255,255,0.24)",
        borderRadius: 10,
        padding: "8px 12px",
        color: "white",
        fontFamily: "-apple-system, system-ui, sans-serif",
        fontSize: 13,
        minWidth: 180,
        textShadow: "0 1px 2px rgba(0,0,0,0.7)",
      }}
    >
      <div style={{ fontSize: 11, opacity: 0.7, letterSpacing: 1, marginBottom: 4 }}>PLAYERS</div>
      {players.map((p, i) => {
        const card = scorecards[i] ?? [];
        const totals = card.reduce(
          (acc, e) => (e ? { s: acc.s + e.strokes, par: acc.par + e.par } : acc),
          { s: 0, par: 0 },
        );
        const rel = totals.s - totals.par;
        const relStr = totals.s === 0 ? "—" : rel === 0 ? "E" : rel > 0 ? `+${rel}` : `${rel}`;
        return (
          <div
            key={p.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "3px 0",
              fontWeight: i === currentIdx ? 800 : 500,
              color: i === currentIdx ? "#ffd23b" : "white",
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: 12,
                height: 12,
                borderRadius: 3,
                background: p.shirtColor,
                border: "1px solid rgba(255,255,255,0.5)",
              }}
            />
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {i === currentIdx ? "▶ " : ""}
              {p.name}
            </span>
            <span style={{ fontVariantNumeric: "tabular-nums", opacity: 0.85 }}>{totals.s || "·"}</span>
            <span style={{ fontVariantNumeric: "tabular-nums", width: 28, textAlign: "right", opacity: 0.7 }}>
              {relStr}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function HostBadge({
  hostInfo,
  gameSettings,
  onGameSettingsChange,
}: {
  hostInfo: HostInfo;
  gameSettings: GameSettings;
  onGameSettingsChange?: (patch: Partial<GameSettings>) => void;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: 16,
        bottom: 96,
        color: "white",
        background: "rgba(0,0,0,0.42)",
        border: "1px solid rgba(255,255,255,0.28)",
        borderRadius: 8,
        padding: "10px 12px",
        fontFamily: "-apple-system, system-ui, sans-serif",
        fontSize: 13,
        lineHeight: 1.45,
        textShadow: "0 1px 2px rgba(0,0,0,0.7)",
        maxWidth: 360,
        pointerEvents: "auto",
      }}
    >
      <div style={{ fontWeight: 800, fontSize: 16 }}>Host Code {hostInfo.code}</div>
      <div>Phone: {hostInfo.joinUrl}</div>
      <div style={{ marginTop: 8 }}>
        <PowerBalanceSelector
          value={gameSettings.powerBalance}
          onPick={(powerBalance) => onGameSettingsChange?.({ powerBalance })}
          compact
        />
      </div>
    </div>
  );
}

function HoleIntroOverlay({
  layout,
  scorecard,
  holeIndex,
  selectedClub,
  onStart,
  players,
  playerScorecards,
  currentPlayerIdx,
}: {
  layout: HoleLayout;
  scorecard: Array<ScoreEntry | null>;
  holeIndex: number;
  selectedClub: (typeof CLUBS)[number];
  onStart: () => void;
  players?: GolfPlayer[];
  playerScorecards?: Array<Array<ScoreEntry | null>>;
  currentPlayerIdx?: number;
}) {
  // Unused — scorecard moves to the round-complete overlay now.
  void scorecard;
  void selectedClub;
  void players;
  void playerScorecards;
  void currentPlayerIdx;

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 20,
        pointerEvents: "auto",
        background: "transparent",
        color: "white",
        fontFamily: "-apple-system, system-ui, sans-serif",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        // Soft top + bottom letterbox bars for cinematic feel.
        boxShadow: "inset 0 90px 90px -40px rgba(0,0,0,0.55), inset 0 -90px 90px -40px rgba(0,0,0,0.55)",
      }}
      onClick={onStart}
    >
      {/* Top — hole title card */}
      <div
        style={{
          padding: "22px 28px 0",
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <div
          style={{
            background: "rgba(7,18,14,0.55)",
            border: "1px solid rgba(255,255,255,0.18)",
            backdropFilter: "blur(6px)",
            borderRadius: 12,
            padding: "10px 16px",
            textShadow: "0 2px 4px rgba(0,0,0,0.6)",
            maxWidth: 360,
            animation: "dsHoleIntroFadeIn 600ms ease-out both",
          }}
        >
          <div style={{ fontSize: 11, letterSpacing: 3, opacity: 0.75, fontWeight: 800 }}>
            HOLE {holeIndex + 1} OF {COURSE_HOLES.length}
            {layout.name ? ` · ${layout.name.toUpperCase()}` : ""}
          </div>
          <div style={{ fontSize: 34, fontWeight: 950, letterSpacing: 1, lineHeight: 1.05, marginTop: 2 }}>
            Par {layout.par}
            <span style={{ fontSize: 18, fontWeight: 800, opacity: 0.85, marginLeft: 10 }}>
              {layout.yardage} yds
            </span>
          </div>
        </div>
      </div>

      {/* Bottom — skip hint */}
      <div
        style={{
          padding: "0 28px 22px",
          display: "flex",
          justifyContent: "center",
        }}
      >
        <div
          style={{
            background: "rgba(7,18,14,0.5)",
            border: "1px solid rgba(255,255,255,0.18)",
            borderRadius: 999,
            padding: "8px 18px",
            fontSize: 13,
            fontWeight: 700,
            letterSpacing: 1,
            textShadow: "0 1px 2px rgba(0,0,0,0.6)",
            opacity: 0.92,
            cursor: "pointer",
          }}
        >
          ⏯  CLICK OR PRESS SPACE TO SKIP
        </div>
      </div>

      <style>{`
        @keyframes dsHoleIntroFadeIn {
          from { transform: translateY(-8px); opacity: 0; }
          to   { transform: translateY(0); opacity: 1; }
        }
      `}</style>
    </div>
  );
}

function Scoreboard({
  scorecard,
  activeIndex,
  coursePar,
}: {
  scorecard: Array<ScoreEntry | null>;
  activeIndex: number;
  coursePar: number;
}) {
  const totals = scoreTotal(scorecard);
  return (
    <div style={introStyles.scoreboard}>
      <div style={introStyles.scoreHeader}>
        <span>Scoreboard</span>
        <span>
          Through {scorecard.filter(Boolean).length} · {totals.strokes || 0}/{coursePar}
        </span>
      </div>
      <div style={introStyles.scoreGrid}>
        <div style={introStyles.scoreCellHead}>Hole</div>
        <div style={introStyles.scoreCellHead}>Par</div>
        <div style={introStyles.scoreCellHead}>Score</div>
        <div style={introStyles.scoreCellHead}>+/-</div>
        {COURSE_HOLES.map((hole, index) => {
          const entry = scorecard[index];
          const active = index === activeIndex;
          return (
            <Fragment key={hole.number}>
              <div style={{ ...introStyles.scoreCell, ...(active ? introStyles.scoreCellActive : null) }}>
                {hole.number}
              </div>
              <div style={{ ...introStyles.scoreCell, ...(active ? introStyles.scoreCellActive : null) }}>
                {hole.par}
              </div>
              <div style={{ ...introStyles.scoreCell, ...(active ? introStyles.scoreCellActive : null) }}>
                {entry?.strokes ?? "—"}
              </div>
              <div style={{ ...introStyles.scoreCell, ...(active ? introStyles.scoreCellActive : null) }}>
                {entry ? formatRelative(entry.strokes - entry.par) : active ? "Now" : "—"}
              </div>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Full-screen end-of-round summary. Shows every player's per-hole strokes
 * and totals, sorted by finishing score. This is the only place the
 * scoreboard appears in the new flow — during play the round is "blind"
 * apart from the small live standings card.
 */
function RoundCompleteOverlay({
  players,
  playerScorecards,
  singleScorecard,
  activeIndex,
}: {
  players?: GolfPlayer[];
  playerScorecards?: Array<Array<ScoreEntry | null>>;
  singleScorecard?: Array<ScoreEntry | null>;
  activeIndex: number;
}) {
  const cards = playerScorecards && players && players.length > 0
    ? playerScorecards
    : singleScorecard
      ? [singleScorecard]
      : [];
  const names = players && players.length > 0
    ? players.map((p) => p.name)
    : ["Player"];
  const swatches = players && players.length > 0
    ? players.map((p) => p.shirtColor)
    : ["#ffffff"];
  const coursePar = COURSE_HOLES.reduce((s, h) => s + h.par, 0);

  const standings = cards.map((card, i) => {
    const totals = scoreTotal(card);
    return {
      name: names[i] ?? `Player ${i + 1}`,
      color: swatches[i] ?? "#ffffff",
      strokes: totals.strokes,
      diff: totals.strokes - totals.par,
      card,
    };
  });
  // Lowest strokes first (treat 0 strokes as DNF → push to bottom).
  const ranked = [...standings].sort((a, b) => {
    const aDone = a.strokes > 0 ? a.strokes : Number.POSITIVE_INFINITY;
    const bDone = b.strokes > 0 ? b.strokes : Number.POSITIVE_INFINITY;
    return aDone - bDone;
  });

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "radial-gradient(circle at 50% 30%, rgba(11,40,30,0.92) 0%, rgba(5,12,9,0.96) 70%)",
        color: "white",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        boxSizing: "border-box",
        fontFamily: "-apple-system, system-ui, sans-serif",
        zIndex: 25,
        textAlign: "center",
        pointerEvents: "auto",
        overflow: "auto",
      }}
    >
      <div style={{ fontSize: 12, letterSpacing: 6, opacity: 0.7, fontWeight: 800 }}>
        ROUND COMPLETE
      </div>
      <div style={{ fontSize: 52, fontWeight: 950, marginTop: 4, marginBottom: 18 }}>
        Final scorecard
      </div>
      <div
        style={{
          background: "rgba(0,0,0,0.45)",
          border: "1px solid rgba(255,255,255,0.18)",
          borderRadius: 14,
          padding: 16,
          maxWidth: "min(1100px, 100%)",
          width: "100%",
          overflowX: "auto",
          boxShadow: "0 24px 60px rgba(0,0,0,0.45)",
        }}
      >
        <table
          style={{
            width: "100%",
            borderCollapse: "separate",
            borderSpacing: 0,
            fontVariantNumeric: "tabular-nums",
            color: "white",
            fontSize: 13,
          }}
        >
          <thead>
            <tr style={{ background: "rgba(255,255,255,0.06)" }}>
              <th style={rcStyles.th}>Player</th>
              {COURSE_HOLES.map((h) => (
                <th key={`h-${h.number}`} style={rcStyles.th}>
                  {h.number}
                </th>
              ))}
              <th style={{ ...rcStyles.th, fontWeight: 950 }}>Total</th>
              <th style={rcStyles.th}>+/-</th>
            </tr>
            <tr style={{ background: "rgba(255,255,255,0.03)" }}>
              <td style={{ ...rcStyles.td, opacity: 0.6 }}>Par</td>
              {COURSE_HOLES.map((h) => (
                <td key={`p-${h.number}`} style={{ ...rcStyles.td, opacity: 0.7 }}>
                  {h.par}
                </td>
              ))}
              <td style={{ ...rcStyles.td, opacity: 0.7 }}>{coursePar}</td>
              <td style={rcStyles.td}>—</td>
            </tr>
          </thead>
          <tbody>
            {ranked.map((row, idx) => (
              <tr
                key={`${row.name}-${idx}`}
                style={{
                  background: idx === 0 ? "rgba(255,210,59,0.10)" : "transparent",
                }}
              >
                <td
                  style={{
                    ...rcStyles.td,
                    textAlign: "left",
                    fontWeight: 800,
                    color: idx === 0 ? "#ffd23b" : "white",
                  }}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <span
                      style={{
                        display: "inline-block",
                        width: 12,
                        height: 12,
                        borderRadius: 3,
                        background: row.color,
                        border: "1px solid rgba(255,255,255,0.4)",
                      }}
                    />
                    {idx === 0 ? "🏆 " : ""}
                    {row.name}
                  </span>
                </td>
                {COURSE_HOLES.map((h, hi) => {
                  const cell = row.card[hi];
                  const strokes = cell?.strokes;
                  const rel = cell ? strokes! - h.par : null;
                  let bg = "transparent";
                  if (rel !== null) {
                    if (rel <= -2) bg = "rgba(80,180,255,0.22)";
                    else if (rel === -1) bg = "rgba(80,180,255,0.13)";
                    else if (rel === 1) bg = "rgba(255,120,120,0.12)";
                    else if (rel >= 2) bg = "rgba(255,120,120,0.22)";
                  }
                  return (
                    <td key={`c-${idx}-${hi}`} style={{ ...rcStyles.td, background: bg }}>
                      {strokes ?? "—"}
                    </td>
                  );
                })}
                <td style={{ ...rcStyles.td, fontWeight: 950 }}>{row.strokes || "—"}</td>
                <td style={rcStyles.td}>{row.strokes ? formatRelative(row.diff) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ marginTop: 22, fontSize: 13, opacity: 0.7 }}>
        Press R to replay this hole · ← SPORTS to return to the menu
      </div>
      {void activeIndex}
    </div>
  );
}

const rcStyles: Record<string, React.CSSProperties> = {
  th: {
    padding: "8px 10px",
    fontSize: 11,
    letterSpacing: 1,
    textTransform: "uppercase",
    fontWeight: 800,
    opacity: 0.8,
    textAlign: "center",
    borderBottom: "1px solid rgba(255,255,255,0.12)",
  },
  td: {
    padding: "7px 10px",
    textAlign: "center",
    borderBottom: "1px solid rgba(255,255,255,0.06)",
  },
};

function HUD({
  club,
  clubIdx,
  strokes,
  yards,
  power,
  aim,
  surface,
  sunk,
  message,
  targetPower,
  viewMode,
  layout,
  ball,
  holeNumber,
  holePar,
  holesTotal,
  finalHole,
  currentPlayer,
  currentBuild,
  players,
  playerScorecards,
  scorecard,
  holeIndex,
}: {
  club: (typeof CLUBS)[number];
  clubIdx: number;
  strokes: number;
  yards: string;
  power: number;
  aim: number;
  surface: Surface;
  sunk: boolean;
  message: string;
  targetPower: number;
  viewMode: ViewMode;
  layout: HoleLayout;
  ball: { x: number; z: number };
  holeNumber: number;
  holePar: number;
  holesTotal: number;
  finalHole: boolean;
  currentPlayer?: GolfPlayer;
  currentBuild: PlayerBuild;
  players?: GolfPlayer[];
  playerScorecards?: Array<Array<ScoreEntry | null>>;
  scorecard?: Array<ScoreEntry | null>;
  holeIndex?: number;
}) {
  const powerColor =
    power > 0.92 ? "#ff4040" : power > 0.7 ? "#ffb13b" : "#5fd35f";
  const effectiveClub = effectiveClubForLie(
    effectiveClubForBuild(club, currentBuild),
    surface,
  );

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        color: "white",
        textShadow: "0 1px 2px rgba(0,0,0,0.7)",
        fontFamily: "-apple-system, system-ui, sans-serif",
        userSelect: "none",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 16,
          left: 16,
          width: 220,
          padding: 10,
          borderRadius: 10,
          background: "rgba(11,24,18,0.72)",
          border: "1px solid rgba(255,255,255,0.24)",
          boxShadow: "0 12px 30px rgba(0,0,0,0.28)",
          fontSize: 14,
          lineHeight: 1.5,
        }}
      >
        <HoleMapSvg layout={layout} ball={ball} aim={aim} compact />
        <div style={{ fontSize: 18, fontWeight: 700 }}>
          Hole {holeNumber} of {holesTotal} · Par {holePar}
        </div>
        {currentPlayer && players && players.length > 1 && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginTop: 2,
              padding: "3px 6px",
              borderRadius: 6,
              background: "rgba(255,210,59,0.18)",
              border: "1px solid rgba(255,210,59,0.45)",
            }}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 2,
                background: currentPlayer.shirtColor,
                border: "1px solid rgba(255,255,255,0.5)",
                display: "inline-block",
              }}
            />
            <span style={{ fontWeight: 800 }}>{currentPlayer.name}</span>
            <span style={{ marginLeft: "auto", opacity: 0.7, fontSize: 11 }}>up</span>
          </div>
        )}
        <div>
          {currentPlayer && players && players.length > 1 ? `${currentPlayer.name}: ` : "Strokes: "}
          <b>{strokes}</b>
        </div>
        <div><b>{yards}</b> yds to pin</div>
        <div style={{ textTransform: "capitalize", opacity: 0.85 }}>
          Lie: {surface}
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          top: 16,
          right: 16,
          fontSize: 13,
          lineHeight: 1.4,
          textAlign: "right",
        }}
      >
        <div style={{ fontSize: 20, fontWeight: 700 }}>
          {club.short} — {club.name}
        </div>
        <div style={{ opacity: 0.85 }}>
          Full carry: {(effectiveClub.carry / 0.9144).toFixed(0)} yds
        </div>
        <div style={{ opacity: 0.72, fontSize: 11 }}>
          {currentBuild.name} · PWR {currentBuild.power} · CTL {currentBuild.control} · PTH {currentBuild.path} · PUT {currentBuild.putting}
        </div>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 4,
            justifyContent: "flex-end",
            marginTop: 6,
            maxWidth: 360,
          }}
        >
          {CLUBS.map((c, i) => (
            <div
              key={c.id}
              style={{
                padding: "3px 7px",
                borderRadius: 4,
                fontSize: 11,
                background:
                  i === clubIdx ? "rgba(255,235,59,0.85)" : "rgba(0,0,0,0.35)",
                color: i === clubIdx ? "#000" : "#fff",
                border: "1px solid rgba(255,255,255,0.35)",
              }}
            >
              {i + 1} {c.short}
            </div>
          ))}
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          bottom: 16,
          left: 16,
          right: 16,
          display: "flex",
          alignItems: "flex-end",
          gap: 24,
        }}
      >
        <div style={{ fontSize: 12, lineHeight: 1.6, opacity: 0.95 }}>
          <div>
            <b>A/D</b> aim · <b>drag</b> aim · <b>V</b>{" "}
            {viewMode === "overhead" ? "play view" : "overhead"} ·{" "}
            <b>Q</b> pin · <b>1–9</b> club · <b>[ ]</b> cycle · <b>C</b> auto-pick ·{" "}
            <b>hold Space</b> charge · release to swing · <b>R</b> reset
          </div>
          <div>
            Aim: {((aim * 180) / Math.PI).toFixed(1)}°
            {` · recommended ${Math.round(targetPower * 100)}%`}
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ width: 240 }}>
          <div style={{ fontSize: 11, marginBottom: 4 }}>
            Power {Math.round(power * 100)}%
          </div>
          <div
            style={{
              height: 16,
              background: "rgba(0,0,0,0.4)",
              borderRadius: 8,
              overflow: "hidden",
              border: "1px solid rgba(255,255,255,0.5)",
              position: "relative",
            }}
          >
            <div
              style={{
                width: `${power * 100}%`,
                height: "100%",
                background: powerColor,
                transition: "width 30ms linear, background 100ms",
                position: "relative",
                zIndex: 2,
              }}
            />
            <div
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                bottom: 0,
                width: `${targetPower * 100}%`,
                background: "rgba(255,255,255,0.22)",
                zIndex: 1,
              }}
            />
            <div
              style={{
                position: "absolute",
                left: `${targetPower * 100}%`,
                top: 0,
                bottom: 0,
                width: 2,
                background: "rgba(255,255,255,0.8)",
                zIndex: 3,
              }}
            />
          </div>
        </div>
      </div>

      {message && !sunk && (
        <div
          style={{
            position: "absolute",
            top: "28%",
            left: 0,
            right: 0,
            textAlign: "center",
            fontSize: 32,
            fontWeight: 700,
            pointerEvents: "none",
          }}
        >
          {message}
        </div>
      )}

      {sunk && !finalHole && (
        <div
          style={{
            position: "absolute",
            top: "38%",
            left: 0,
            right: 0,
            textAlign: "center",
            fontSize: 56,
            fontWeight: 800,
            pointerEvents: "none",
          }}
        >
          In the hole!
          <div style={{ fontSize: 22, marginTop: 12, opacity: 0.9 }}>
            {strokes} {strokes === 1 ? "stroke" : "strokes"} · Next hole loading
          </div>
        </div>
      )}
      {sunk && finalHole && (
        <RoundCompleteOverlay
          players={players}
          playerScorecards={playerScorecards}
          singleScorecard={scorecard}
          activeIndex={holeIndex ?? 0}
        />
      )}
    </div>
  );
}

export function App({ onExitToMenu }: { onExitToMenu?: () => void } = {}) {
  const params = new URLSearchParams(window.location.search);
  const startAsController = params.get("controller") === "1";
  const [mode, setMode] = useState<ScreenMode>(
    startAsController ? "controller" : "menu",
  );
  const [hostInfo, setHostInfo] = useState<HostInfo | null>(null);
  const [error, setError] = useState("");
  const [players, setPlayers] = useState<GolfPlayer[]>([]);
  const [gameSettings, setGameSettings] = useState<GameSettings>(DEFAULT_GAME_SETTINGS);

  const exitButton = onExitToMenu ? (
    <button
      onClick={onExitToMenu}
      style={{
        position: "absolute",
        top: 12,
        left: 12,
        zIndex: 50,
        padding: "6px 12px",
        borderRadius: 999,
        border: "1px solid rgba(255,255,255,0.4)",
        background: "rgba(0,0,0,0.45)",
        color: "white",
        fontSize: 12,
        fontWeight: 700,
        letterSpacing: 1,
        cursor: "pointer",
        fontFamily: "-apple-system, system-ui, sans-serif",
      }}
    >
      ← SPORTS
    </button>
  ) : null;

  const startHost = async () => {
    setError("");
    try {
      const session = await createSession();
      const config = await getServerConfig();
      const created = await apiPost<{ lobby: { code: string } }>(
        "/api/lobbies/create",
        { clientId: session.clientId },
      );
      const joinUrl = controllerJoinUrl(created.lobby.code);
      setHostInfo({
        code: created.lobby.code,
        clientId: session.clientId,
        joinUrl,
      });
      // The host is usually on a laptop driving the screen and isn't a
      // player themselves — start with an empty roster. They can still
      // "+ Add Local Player" from the lobby if they do want to play.
      setPlayers([]);
      setMode("lobby");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start host");
    }
  };

  const startSolo = () => {
    setHostInfo(null);
    setPlayers([defaultPlayer(0, "local", "solo")]);
    setMode("playing");
  };

  if (mode === "playing")
    return (
      <>
        {exitButton}
        <GolfGame
          hostInfo={hostInfo ?? undefined}
          players={players}
          gameSettings={gameSettings}
          onGameSettingsChange={(patch) => setGameSettings((prev) => ({ ...prev, ...patch }))}
        />
      </>
    );
  if (mode === "lobby")
    return (
      <>
        {exitButton}
        <LobbyScreen
          hostInfo={hostInfo!}
          players={players}
          setPlayers={setPlayers}
          gameSettings={gameSettings}
          onGameSettingsChange={(patch) => setGameSettings((prev) => ({ ...prev, ...patch }))}
          onStart={() => setMode("playing")}
          onCancel={() => {
            setHostInfo(null);
            setPlayers([]);
            setMode("menu");
          }}
        />
      </>
    );
  if (mode === "controller")
    return (
      <>
        {exitButton}
        <PhoneController onBack={() => setMode("menu")} />
      </>
    );

  return (
    <>
      {exitButton}
      <MenuScreen
        error={error}
        onHost={startHost}
        onJoin={() => setMode("controller")}
        onSolo={startSolo}
      />
    </>
  );
}

function LobbyScreen({
  hostInfo,
  players,
  setPlayers,
  gameSettings,
  onGameSettingsChange,
  onStart,
  onCancel,
}: {
  hostInfo: HostInfo;
  players: GolfPlayer[];
  setPlayers: React.Dispatch<React.SetStateAction<GolfPlayer[]>>;
  gameSettings: GameSettings;
  onGameSettingsChange: (patch: Partial<GameSettings>) => void;
  onStart: () => void;
  onCancel: () => void;
}) {
  // Subscribe to lobby events so phone joiners appear live.
  useEffect(() => {
    const events = new EventSource(
      apiUrl(`/api/events?code=${encodeURIComponent(hostInfo.code)}&clientId=${encodeURIComponent(
        hostInfo.clientId,
      )}`),
    );
    events.addEventListener("players_changed", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as {
        players: Array<Omit<GolfPlayer, "source"> & { source?: GolfPlayer["source"] }>;
      };
      setPlayers((prev) => {
        const localOnly = prev.filter((p) => p.source === "local");
      const remote = payload.players.map<GolfPlayer>((p) => ({
          ...p,
          buildId: normalizeBuildId(p.buildId),
          controllerMount: normalizeControllerMount(p.controllerMount),
          source: "phone",
        }));
        // Dedup: drop any local entry whose id matches a remote one.
        const remoteIds = new Set(remote.map((p) => p.id));
        return [...localOnly.filter((p) => !remoteIds.has(p.id)), ...remote];
      });
    });
    return () => events.close();
  }, [hostInfo.code, hostInfo.clientId, setPlayers]);

  const addLocalPlayer = () => {
    setPlayers((prev) => {
      const idx = prev.length;
      return [...prev, defaultPlayer(idx, "local", `local-${Date.now()}-${idx}`)];
    });
  };

  const removePlayer = (id: string) => {
    setPlayers((prev) => prev.filter((p) => p.id !== id));
  };

  const updatePlayer = (id: string, patch: Partial<GolfPlayer>) => {
    setPlayers((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };

  return (
    <div style={lobbyStyles.shell}>
      <div style={lobbyStyles.panel}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 6 }}>
          <div style={{ fontSize: 28, fontWeight: 900 }}>Lobby</div>
          <div style={{ opacity: 0.7, fontSize: 13 }}>customize names & outfits, then start</div>
        </div>

        <div style={lobbyStyles.codeBox}>
          <div style={{ fontSize: 11, opacity: 0.7, letterSpacing: 2 }}>HOST CODE</div>
          <div style={{ fontSize: 44, fontWeight: 900, letterSpacing: 6 }}>{hostInfo.code}</div>
          <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>
            Phones join at <b>{hostInfo.joinUrl}</b>
          </div>
          {hostInfo.joinUrl.includes("localhost") || hostInfo.joinUrl.includes("127.0.0.1") ? (
            <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
              Localhost links only work on this computer. Deploy the server to public HTTPS for friends on cellular.
            </div>
          ) : null}
        </div>

        <div style={{ marginTop: 12 }}>
          <PowerBalanceSelector
            value={gameSettings.powerBalance}
            onPick={(powerBalance) => onGameSettingsChange({ powerBalance })}
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12 }}>
          {players.length === 0 && (
            <div style={{ opacity: 0.6, fontStyle: "italic" }}>No players yet — add one below or have a phone join.</div>
          )}
          {players.map((p) => (
            <PlayerRow
              key={p.id}
              player={p}
              onChange={(patch) => updatePlayer(p.id, patch)}
              onRemove={p.source === "local" ? () => removePlayer(p.id) : undefined}
            />
          ))}
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
          <button style={lobbyStyles.secondary} onClick={addLocalPlayer}>
            + Add Local Player
          </button>
          <button
            style={{
              ...lobbyStyles.primary,
              opacity: players.length === 0 ? 0.4 : 1,
              cursor: players.length === 0 ? "not-allowed" : "pointer",
            }}
            onClick={onStart}
            disabled={players.length === 0}
          >
            Start Round →
          </button>
          <button style={lobbyStyles.secondary} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function PlayerRow({
  player,
  onChange,
  onRemove,
}: {
  player: GolfPlayer;
  onChange: (patch: Partial<GolfPlayer>) => void;
  onRemove?: () => void;
}) {
  return (
    <div style={lobbyStyles.row}>
      <div
        style={{
          width: 42,
          height: 42,
          borderRadius: 8,
          background: player.shirtColor,
          border: `3px solid ${player.hatColor}`,
          boxShadow: `inset 0 -16px 0 ${player.pantsColor}`,
          flexShrink: 0,
        }}
        title="Outfit preview"
      />
      <input
        value={player.name}
        onChange={(e) => onChange({ name: e.target.value.slice(0, 18) })}
        style={lobbyStyles.nameInput}
        maxLength={18}
      />
      <BuildSelectCompact
        value={normalizeBuildId(player.buildId)}
        onPick={(buildId) => onChange({ buildId })}
      />
      <ColorSwatch label="Shirt" value={player.shirtColor} options={SHIRT_OPTIONS} onPick={(c) => onChange({ shirtColor: c })} />
      <ColorSwatch label="Pants" value={player.pantsColor} options={PANTS_OPTIONS} onPick={(c) => onChange({ pantsColor: c })} />
      <ColorSwatch label="Hat" value={player.hatColor} options={HAT_OPTIONS} onPick={(c) => onChange({ hatColor: c })} />
      <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
        <span
          style={{
            fontSize: 10,
            padding: "3px 8px",
            borderRadius: 999,
            background: player.source === "phone" ? "rgba(60,160,255,0.25)" : "rgba(255,255,255,0.12)",
            border: `1px solid ${player.source === "phone" ? "rgba(60,160,255,0.6)" : "rgba(255,255,255,0.25)"}`,
            letterSpacing: 1,
            fontWeight: 700,
          }}
        >
          {player.source === "phone" ? "PHONE" : "LOCAL"}
        </span>
        {onRemove && (
          <button
            onClick={onRemove}
            style={{
              padding: "4px 10px",
              borderRadius: 6,
              background: "rgba(255,80,80,0.18)",
              border: "1px solid rgba(255,80,80,0.5)",
              color: "#ffb0b0",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

function PlayerAvatar({
  player,
  size = 96,
}: {
  player: { shirtColor: string; pantsColor: string; hatColor: string };
  size?: number;
}) {
  // Stylized SVG of a golfer — hat, shirt torso + sleeves, pants. Pure
  // visual so we can show outfit colors at a glance.
  const w = size;
  const h = size * 1.25;
  return (
    <svg viewBox="0 0 100 125" width={w} height={h} aria-hidden="true">
      {/* shadow */}
      <ellipse cx="50" cy="118" rx="22" ry="3.5" fill="rgba(0,0,0,0.35)" />
      {/* legs / pants */}
      <rect x="36" y="74" width="11" height="36" rx="4" fill={player.pantsColor} />
      <rect x="53" y="74" width="11" height="36" rx="4" fill={player.pantsColor} />
      {/* shoes */}
      <rect x="34" y="108" width="15" height="6" rx="2" fill="#1a1a1a" />
      <rect x="51" y="108" width="15" height="6" rx="2" fill="#1a1a1a" />
      {/* shirt torso */}
      <path
        d="M30 42 Q30 36 36 34 L64 34 Q70 36 70 42 L72 78 Q60 82 50 82 Q40 82 28 78 Z"
        fill={player.shirtColor}
        stroke="rgba(0,0,0,0.15)"
      />
      {/* sleeves */}
      <path d="M30 42 Q22 46 22 60 L30 64 Z" fill={player.shirtColor} />
      <path d="M70 42 Q78 46 78 60 L70 64 Z" fill={player.shirtColor} />
      {/* arms */}
      <rect x="20" y="58" width="8" height="22" rx="3" fill="#e3b894" />
      <rect x="72" y="58" width="8" height="22" rx="3" fill="#e3b894" />
      {/* neck */}
      <rect x="46" y="28" width="8" height="8" fill="#e3b894" />
      {/* head */}
      <circle cx="50" cy="22" r="10" fill="#e3b894" />
      {/* hat */}
      <path d="M37 18 Q37 10 50 10 Q63 10 63 18 L63 20 L37 20 Z" fill={player.hatColor} />
      <path d="M30 20 L70 20 L66 23 L34 23 Z" fill={player.hatColor} />
    </svg>
  );
}

function PhoneLobbyView({
  code,
  profile,
  players,
  myClientId,
  onPick,
}: {
  code: string;
  profile: GolfPlayer;
  players: GolfPlayer[];
  myClientId: string;
  onPick: (patch: Partial<GolfPlayer>) => void;
}) {
  // Server-side roster minus self; we render self separately at the top.
  const others = players.filter((p) => p.id !== myClientId);

  return (
    <div
      style={{
        minHeight: "100dvh",
        background:
          "radial-gradient(circle at 50% 20%, #1f4a8f 0%, #0a1d3a 60%, #050b18 100%)",
        color: "white",
        fontFamily: "-apple-system, system-ui, sans-serif",
        padding: "18px 16px 28px",
        boxSizing: "border-box",
        overflowY: "auto",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 8,
        }}
      >
        <div style={{ fontSize: 12, opacity: 0.65, letterSpacing: 2 }}>LOBBY · {code}</div>
        <div style={{ fontSize: 11, opacity: 0.6 }}>
          waiting for host to start
        </div>
      </div>

      {/* You card */}
      <div
        style={{
          display: "flex",
          gap: 14,
          alignItems: "center",
          padding: 14,
          borderRadius: 14,
          background: "rgba(255,210,59,0.10)",
          border: "1.5px solid rgba(255,210,59,0.55)",
          marginBottom: 16,
        }}
      >
        <PlayerAvatar player={profile} size={88} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, opacity: 0.7, letterSpacing: 2 }}>YOU</div>
          <div
            style={{
              fontSize: 24,
              fontWeight: 900,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {profile.name}
          </div>
          <div style={{ marginTop: 6, fontSize: 12, fontWeight: 800, color: "#ffd23b" }}>
            {getPlayerBuild(profile).name} · PWR {getPlayerBuild(profile).power} · CTL {getPlayerBuild(profile).control} · PTH {getPlayerBuild(profile).path} · PUT {getPlayerBuild(profile).putting}
          </div>
          <div style={{ marginTop: 6 }}>
            <BuildSelector
              value={normalizeBuildId(profile.buildId)}
              onPick={(buildId) => onPick({ buildId })}
              compact
            />
            <ColorSwatchRow label="Shirt" value={profile.shirtColor} options={SHIRT_OPTIONS} onPick={(c) => onPick({ shirtColor: c })} compact />
            <ColorSwatchRow label="Pants" value={profile.pantsColor} options={PANTS_OPTIONS} onPick={(c) => onPick({ pantsColor: c })} compact />
            <ColorSwatchRow label="Hat"   value={profile.hatColor}   options={HAT_OPTIONS}   onPick={(c) => onPick({ hatColor: c })} compact />
            <HandednessSelector
              value={profile.handedness ?? "right"}
              onPick={(handedness) => onPick({ handedness })}
              compact
            />
            <MountSelector
              value={normalizeControllerMount(profile.controllerMount)}
              onPick={(controllerMount) => onPick({ controllerMount })}
              compact
            />
          </div>
        </div>
      </div>

      {/* Others in lobby */}
      <div style={{ fontSize: 11, opacity: 0.7, letterSpacing: 2, marginBottom: 8 }}>
        PLAYERS IN LOBBY ({players.length})
      </div>
      {others.length === 0 ? (
        <div
          style={{
            padding: 16,
            borderRadius: 12,
            background: "rgba(255,255,255,0.05)",
            border: "1px dashed rgba(255,255,255,0.2)",
            textAlign: "center",
            opacity: 0.7,
            fontSize: 13,
          }}
        >
          You're the only one here so far.
          <br />
          Share the host code <b>{code}</b> with friends.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {others.map((p) => (
            <div
              key={p.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: 10,
                borderRadius: 12,
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.14)",
              }}
            >
              <PlayerAvatar player={p} size={52} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 16,
                    fontWeight: 800,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {p.name}
                </div>
                <div style={{ fontSize: 11, opacity: 0.68, fontWeight: 800, marginTop: 2 }}>
                  {getPlayerBuild(p).name}
                </div>
                <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                  {[p.shirtColor, p.pantsColor, p.hatColor].map((c, i) => (
                    <span
                      key={i}
                      style={{
                        width: 14,
                        height: 14,
                        borderRadius: 3,
                        background: c,
                        border: "1px solid rgba(255,255,255,0.3)",
                        display: "inline-block",
                      }}
                    />
                  ))}
                </div>
              </div>
              <span
                style={{
                  fontSize: 10,
                  padding: "3px 8px",
                  borderRadius: 999,
                  background: p.source === "phone" ? "rgba(60,160,255,0.25)" : "rgba(255,255,255,0.12)",
                  border: `1px solid ${p.source === "phone" ? "rgba(60,160,255,0.6)" : "rgba(255,255,255,0.25)"}`,
                  letterSpacing: 1,
                  fontWeight: 700,
                }}
              >
                {p.source === "phone" ? "PHONE" : "LOCAL"}
              </span>
            </div>
          ))}
        </div>
      )}

      <div
        style={{
          marginTop: 22,
          padding: 12,
          textAlign: "center",
          fontSize: 12,
          opacity: 0.55,
          fontStyle: "italic",
        }}
      >
        The golf controls will appear here when the host starts the round.
      </div>
    </div>
  );
}

function ColorSwatchRow({
  label,
  value,
  options,
  onPick,
  compact = false,
}: {
  label: string;
  value: string;
  options: string[];
  onPick: (c: string) => void;
  compact?: boolean;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 0" }}>
      <div style={{ width: compact ? 38 : 46, fontSize: 11, opacity: 0.7, letterSpacing: 1 }}>
        {label.toUpperCase()}
      </div>
      <div style={{ display: "flex", gap: 4 }}>
        {options.map((c) => (
          <button
            key={c}
            onClick={() => onPick(c)}
            style={{
              width: compact ? 18 : 20,
              height: compact ? 18 : 20,
              borderRadius: 4,
              background: c,
              border: c === value ? "2px solid #ffd23b" : "1px solid rgba(255,255,255,0.3)",
              cursor: "pointer",
              padding: 0,
            }}
          />
        ))}
      </div>
    </div>
  );
}

function ColorSwatch({
  label,
  value,
  options,
  onPick,
}: {
  label: string;
  value: string;
  options: string[];
  onPick: (c: string) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, alignItems: "center" }}>
      <div style={{ fontSize: 10, opacity: 0.65, letterSpacing: 1 }}>{label.toUpperCase()}</div>
      <div style={{ display: "flex", gap: 3 }}>
        {options.map((c) => (
          <button
            key={c}
            onClick={() => onPick(c)}
            title={c}
            style={{
              width: 16,
              height: 16,
              borderRadius: 4,
              background: c,
              border: c === value ? "2px solid #ffd23b" : "1px solid rgba(255,255,255,0.3)",
              cursor: "pointer",
              padding: 0,
            }}
          />
        ))}
      </div>
    </div>
  );
}

function HandednessSelector({
  value,
  onPick,
  compact = false,
}: {
  value: Handedness;
  onPick: (value: Handedness) => void;
  compact?: boolean;
}) {
  return (
    <div style={{ display: "grid", gap: compact ? 4 : 6 }}>
      <div style={{ fontSize: compact ? 10 : 12, opacity: 0.68, letterSpacing: 1 }}>
        HANDEDNESS
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 6,
        }}
      >
        {(["right", "left"] as Handedness[]).map((hand) => (
          <button
            key={hand}
            onClick={() => onPick(hand)}
            style={{
              minHeight: compact ? 28 : 38,
              borderRadius: 7,
              border:
                value === hand
                  ? "1px solid #63d471"
                  : "1px solid rgba(255,255,255,0.18)",
              background: value === hand ? "#63d471" : "#202c38",
              color: value === hand ? "#0d1b16" : "white",
              fontSize: compact ? 12 : 14,
              fontWeight: 900,
            }}
          >
            {hand === "right" ? "Righty" : "Lefty"}
          </button>
        ))}
      </div>
    </div>
  );
}

function MountSelector({
  value,
  onPick,
  compact = false,
}: {
  value: ControllerMount;
  onPick: (value: ControllerMount) => void;
  compact?: boolean;
}) {
  const options: Array<{ value: ControllerMount; label: string; note: string }> = [
    { value: "club", label: "Club Grip", note: "phone points at target" },
    { value: "grip_butt", label: "Grip End", note: "top points to clubhead" },
    { value: "forearm", label: "Forearm", note: "top points to hand" },
  ];
  return (
    <div style={{ display: "grid", gap: compact ? 4 : 6 }}>
      <div style={{ fontSize: compact ? 10 : 12, opacity: 0.68, letterSpacing: 1 }}>
        CONTROLLER MOUNT
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6 }}>
        {options.map((option) => {
          const active = value === option.value;
          return (
            <button
              key={option.value}
              onClick={() => onPick(option.value)}
              style={{
                minHeight: compact ? 34 : 44,
                borderRadius: 7,
                border: active ? "1px solid #63d471" : "1px solid rgba(255,255,255,0.18)",
                background: active ? "#63d471" : "#202c38",
                color: active ? "#0d1b16" : "white",
                fontSize: compact ? 11 : 13,
                fontWeight: 900,
                padding: compact ? "4px 6px" : "6px 8px",
              }}
            >
              <div>{option.label}</div>
              {!compact && (
                <div style={{ fontSize: 10, opacity: active ? 0.7 : 0.55, marginTop: 2 }}>
                  {option.note}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PowerBalanceSelector({
  value,
  onPick,
  compact = false,
}: {
  value: PowerBalanceMode;
  onPick: (value: PowerBalanceMode) => void;
  compact?: boolean;
}) {
  const selected = normalizePowerBalance(value);
  return (
    <div
      style={{
        display: "grid",
        gap: compact ? 4 : 7,
        padding: compact ? 0 : 12,
        borderRadius: compact ? 0 : 10,
        background: compact ? "transparent" : "rgba(255,255,255,0.06)",
        border: compact ? 0 : "1px solid rgba(255,255,255,0.14)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
        <div style={{ fontSize: compact ? 10 : 12, opacity: 0.72, letterSpacing: 1.2, fontWeight: 850 }}>
          POWER BALANCING
        </div>
        {!compact && (
          <div style={{ fontSize: 11, opacity: 0.58 }}>
            host setting
          </div>
        )}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 6 }}>
        {POWER_BALANCE_OPTIONS.map((option) => {
          const active = selected === option.value;
          return (
            <button
              key={option.value}
              onClick={() => onPick(option.value)}
              style={{
                minHeight: compact ? 34 : 48,
                borderRadius: 7,
                border: active ? "1px solid #ffd23b" : "1px solid rgba(255,255,255,0.18)",
                background: active ? "#ffd23b" : "#202c38",
                color: active ? "#1a1a1a" : "white",
                fontSize: compact ? 10 : 13,
                fontWeight: 900,
                padding: compact ? "4px 5px" : "7px 8px",
                lineHeight: 1.15,
              }}
            >
              <div>{option.label}</div>
              {!compact && (
                <div style={{ fontSize: 10, opacity: active ? 0.72 : 0.56, marginTop: 3 }}>
                  {option.note}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function BuildSelector({
  value,
  onPick,
  compact = false,
}: {
  value: PlayerBuildId;
  onPick: (value: PlayerBuildId) => void;
  compact?: boolean;
}) {
  const selected = normalizeBuildId(value);
  return (
    <div style={{ display: "grid", gap: compact ? 5 : 8 }}>
      <div style={{ fontSize: compact ? 10 : 12, opacity: 0.68, letterSpacing: 1 }}>
        BUILD
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: compact ? "1fr" : "1fr 1fr",
          gap: 7,
        }}
      >
        {PLAYER_BUILDS.map((build) => {
          const active = selected === build.id;
          return (
            <button
              key={build.id}
              onClick={() => onPick(build.id)}
              style={{
                minHeight: compact ? 42 : 58,
                borderRadius: 8,
                border: active ? "1px solid #ffd23b" : "1px solid rgba(255,255,255,0.16)",
                background: active ? "rgba(255,210,59,0.18)" : "#202c38",
                color: "white",
                textAlign: "left",
                padding: compact ? "6px 8px" : "8px 10px",
                fontFamily: "inherit",
                cursor: "pointer",
              }}
            >
              <div style={{ fontSize: compact ? 12 : 15, fontWeight: 950 }}>
                {build.name}
              </div>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: compact ? 6 : 10,
                  marginTop: 4,
                  fontSize: compact ? 10 : 11,
                  opacity: 0.78,
                  fontWeight: 800,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                <span>PWR {build.power}</span>
                <span>CTL {build.control}</span>
                <span>PTH {build.path}</span>
                <span>PUT {build.putting}</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function BuildSelectCompact({
  value,
  onPick,
}: {
  value: PlayerBuildId;
  onPick: (value: PlayerBuildId) => void;
}) {
  const selected = getPlayerBuild({ buildId: value });
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 3, alignItems: "center" }}>
      <span style={{ fontSize: 10, opacity: 0.65, letterSpacing: 1 }}>BUILD</span>
      <select
        value={normalizeBuildId(value)}
        onChange={(e) => onPick(normalizeBuildId(e.target.value))}
        style={{
          width: 116,
          background: "rgba(0,0,0,0.35)",
          border: "1px solid rgba(255,255,255,0.25)",
          color: "white",
          borderRadius: 6,
          padding: "5px 6px",
          fontSize: 12,
          fontWeight: 800,
          fontFamily: "inherit",
        }}
      >
        {PLAYER_BUILDS.map((build) => (
          <option key={build.id} value={build.id}>
            {build.name}
          </option>
        ))}
      </select>
      <span style={{ fontSize: 9, opacity: 0.6, fontVariantNumeric: "tabular-nums" }}>
        {selected.power}/{selected.control}/{selected.path}/{selected.putting}
      </span>
    </label>
  );
}

const lobbyStyles: Record<string, React.CSSProperties> = {
  shell: {
    position: "absolute",
    inset: 0,
    background: "radial-gradient(circle at 50% 30%, #1f4a8f 0%, #0a1d3a 60%, #050b18 100%)",
    color: "white",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "-apple-system, system-ui, sans-serif",
    padding: 24,
    boxSizing: "border-box",
  },
  panel: {
    background: "rgba(8,16,32,0.85)",
    border: "1px solid rgba(255,255,255,0.18)",
    borderRadius: 16,
    padding: "20px 24px",
    minWidth: 720,
    maxWidth: 920,
    width: "100%",
    boxShadow: "0 24px 60px rgba(0,0,0,0.5)",
  },
  codeBox: {
    background: "rgba(255,210,59,0.10)",
    border: "1px solid rgba(255,210,59,0.4)",
    borderRadius: 10,
    padding: "10px 16px",
    marginTop: 8,
  },
  row: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 12,
    padding: "10px 12px",
    background: "rgba(255,255,255,0.05)",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 10,
  },
  nameInput: {
    background: "rgba(0,0,0,0.35)",
    border: "1px solid rgba(255,255,255,0.25)",
    color: "white",
    padding: "6px 10px",
    borderRadius: 6,
    fontSize: 16,
    fontWeight: 700,
    width: 160,
    fontFamily: "inherit",
    outline: "none",
  },
  primary: {
    padding: "10px 18px",
    borderRadius: 8,
    border: "none",
    background: "#ffd23b",
    color: "#1a1a1a",
    fontWeight: 800,
    fontSize: 15,
    cursor: "pointer",
    letterSpacing: 1,
  },
  secondary: {
    padding: "10px 16px",
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.3)",
    background: "rgba(255,255,255,0.06)",
    color: "white",
    fontWeight: 700,
    fontSize: 14,
    cursor: "pointer",
  },
};

function MenuScreen({
  error,
  onHost,
  onJoin,
  onSolo,
}: {
  error: string;
  onHost: () => void;
  onJoin: () => void;
  onSolo: () => void;
}) {
  return (
    <div style={menuStyles.shell}>
      <div style={menuStyles.panel}>
        <div style={{ fontSize: 34, fontWeight: 900, marginBottom: 6 }}>DSGolf</div>
        <div style={{ opacity: 0.78, marginBottom: 24 }}>
          Host the course on this screen, then friends can join from phones with the game code.
        </div>
        <button style={menuStyles.primaryButton} onClick={onHost}>Host Online Game</button>
        <button style={menuStyles.button} onClick={onJoin}>Join From Phone</button>
        <button style={menuStyles.button} onClick={onSolo}>Play Solo</button>
        {error && <div style={menuStyles.error}>{error}</div>}
        <div style={menuStyles.note}>
          Cellular play needs a public HTTPS server. Locally, use `npm run network`; for iPhone motion testing on local Wi-Fi use `HTTPS=1 npm run network`.
        </div>
      </div>
    </div>
  );
}

function PhoneController({ onBack }: { onBack: () => void }) {
  const urlCode = new URLSearchParams(window.location.search).get("code") || "";
  const [code, setCode] = useState(urlCode.toUpperCase());
  const [clientId, setClientId] = useState("");
  const [joined, setJoined] = useState(false);
  const [status, setStatus] = useState("");
  const [profile, setProfile] = useState<GolfPlayer>(() => defaultPlayer(0, "phone"));
  const profileRef = useRef(profile);
  profileRef.current = profile;
  const [currentPlayerName, setCurrentPlayerName] = useState<string>("");
  const [currentPlayerId, setCurrentPlayerId] = useState<string>("");
  const [lobbyPlayers, setLobbyPlayers] = useState<GolfPlayer[]>([]);
  // Game is "live" once the host starts broadcasting a current player.
  const gameStarted = !!currentPlayerName;
  const [fallbackPower, setFallbackPower] = useState(0.65);
  const [swinging, setSwinging] = useState(false);
  const [capturePhase, setCapturePhase] = useState<SwingCapturePhase>("idle");
  const [motionGranted, setMotionGranted] = useState(false);
  const [motionError, setMotionError] = useState("");
  const [liveAccel, setLiveAccel] = useState(0);
  const [swingResult, setSwingResult] = useState<SwingResult | null>(null);
  const [ready, setReady] = useState(false);
  const swingModeRef = useRef<"practice" | "live">("live");
  const [lastSwingMode, setLastSwingMode] = useState<"practice" | "live">("live");
  const calibrationRef = useRef<SwingCalibration | null>(null);
  const captureRef = useRef<{
    phase: SwingCapturePhase;
    mode: "practice" | "live";
    requestedAt: number;
    stableSince: number | null;
    lastMotionAt: number;
    peakSeen: boolean;
  }>({
    phase: "idle",
    mode: "live",
    requestedAt: 0,
    stableSince: null,
    lastMotionAt: 0,
    peakSeen: false,
  });
  const [selectedClubIdx, setSelectedClubIdx] = useState(
    suggestClubForBuild(POS.tee.distanceTo(POS.cup), false, profile, "tee"),
  );
  const [phoneSync, setPhoneSync] = useState<PhoneSyncState>(() => {
    const clubIdx = suggestClubForBuild(POS.tee.distanceTo(POS.cup), false, profile, "tee");
    const club = CLUBS[clubIdx];
    const distanceMeters = POS.tee.distanceTo(POS.cup);
    const surface: Surface = "tee";
    return {
      clubIdx,
      powerBalance: "realistic",
      isPutter: !!club.putter,
      distanceMeters,
      surface,
      recommendedPower: recommendedPowerForShot(club, distanceMeters, surface, profile),
    };
  });
  const phoneSyncRef = useRef(phoneSync);
  phoneSyncRef.current = phoneSync;
  const clubSwipeRef = useRef<{ x: number; y: number } | null>(null);
  const latestMotionRef = useRef({
    x: 0,
    y: 0,
    z: 0,
    hasLinear: false,
    // Acceleration *including* gravity, kept separately so we always have
    // a gravity reference for the swing-plane / shape math even when the
    // linear-only stream is the active one.
    gx: 0, gy: 0, gz: 0,
  });
  const swingRef = useRef<SwingMotionState>({
    maxAccel: 0,
    maxRot: 0,
    startedAt: 0,
    samples: 0,
    pathSamples: 0,
    pathVectors: [] as SwingTracePoint[],
    gyroSamples: [],
    baseline: { x: 0, y: 0, z: 0 },
    /** Gravity vector captured at swing start (m/s² in phone frame). */
    gravity: { x: 0, y: 9.81, z: 0 } as Vec3,
    calibration: null,
    hasLinear: false,
    armed: false,
  });

  const needsExplicitPermission =
    typeof DeviceMotionEvent !== "undefined" &&
    typeof (DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> })
      .requestPermission === "function";
  const isSecure =
    typeof window !== "undefined" &&
    (window.isSecureContext ||
      window.location.protocol === "https:" ||
      window.location.hostname === "localhost");

  const join = async () => {
    setStatus("");
    try {
      const session = await createSession();
      await apiPost("/api/lobbies/join", {
        clientId: session.clientId,
        code,
        name: profile.name,
        shirtColor: profile.shirtColor,
        pantsColor: profile.pantsColor,
        hatColor: profile.hatColor,
        buildId: normalizeBuildId(profile.buildId),
        handedness: profile.handedness ?? "right",
        controllerMount: normalizeControllerMount(profile.controllerMount),
      });
      setClientId(session.clientId);
      setProfile((p) => ({ ...p, id: session.clientId }));
      setJoined(true);
      setStatus("Connected");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Could not join");
    }
  };

  const pushProfile = async (patch: Partial<GolfPlayer>) => {
    const next = { ...profile, ...patch };
    setProfile(next);
    if (!joined || !clientId) return;
    try {
      await apiPost("/api/lobbies/player_update", {
        clientId,
        code,
        name: next.name,
        shirtColor: next.shirtColor,
        pantsColor: next.pantsColor,
        hatColor: next.hatColor,
        buildId: normalizeBuildId(next.buildId),
        handedness: next.handedness ?? "right",
        controllerMount: normalizeControllerMount(next.controllerMount),
      });
    } catch {
      /* non-fatal */
    }
  };

  const send = async (action: ControllerAction) => {
    if (!joined) return;
    await apiPost("/api/lobbies/action", { clientId, code, action });
  };

  const selectPhoneClub = async (index: number) => {
    const next = (index + CLUBS.length) % CLUBS.length;
    const club = CLUBS[next];
    setSelectedClubIdx(next);
    setPhoneSync((prev) => ({
      ...prev,
      clubIdx: next,
      isPutter: !!club.putter,
      recommendedPower: recommendedPowerForShot(
        club,
        prev.distanceMeters ?? POS.tee.distanceTo(POS.cup),
        prev.surface ?? "tee",
        profile,
      ),
    }));
    setStatus(`${CLUBS[next].name} selected`);
    await send({ type: "club", index: next });
  };

  const captureSwingCalibration = () => {
    const latest = latestMotionRef.current;
    const activeProfile = profileRef.current;
    const gravity = {
      x: latest.gx || latest.x,
      y: latest.gy || latest.y || 9.81,
      z: latest.gz || latest.z,
    };
    const handedness = activeProfile.handedness ?? "right";
    const controllerMount = normalizeControllerMount(activeProfile.controllerMount);
    const calibration: SwingCalibration = {
      handedness,
      controllerMount,
      gravity,
      targetAxis: targetAxisFromGrip(gravity, handedness, controllerMount),
      calibratedAt: performance.now(),
    };
    calibrationRef.current = calibration;
    return calibration;
  };

  const resetSwingMotionState = (
    latest: typeof latestMotionRef.current,
    calibration: SwingCalibration | null,
    armed: boolean,
  ) => {
    const state = swingRef.current;
    state.maxAccel = 0;
    state.maxRot = 0;
    state.samples = 0;
    state.pathSamples = 0;
    state.pathVectors = [];
    state.gyroSamples = [];
    state.baseline = { x: latest.x, y: latest.y, z: latest.z };
    state.gravity = { x: latest.gx, y: latest.gy, z: latest.gz };
    state.calibration = calibration;
    state.hasLinear = latest.hasLinear;
    state.startedAt = performance.now();
    state.armed = armed;
  };

  const setCaptureState = (phase: SwingCapturePhase) => {
    captureRef.current.phase = phase;
    setCapturePhase(phase);
  };

  const cancelAutoSwing = () => {
    swingRef.current.armed = false;
    captureRef.current.phase = "idle";
    captureRef.current.stableSince = null;
    captureRef.current.peakSeen = false;
    setCapturePhase("idle");
    setSwinging(false);
    setReady(false);
    setStatus("");
  };

  const handleClubPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    clubSwipeRef.current = { x: event.clientX, y: event.clientY };
  };

  const handleClubPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = clubSwipeRef.current;
    clubSwipeRef.current = null;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) < 34 || Math.abs(dx) < Math.abs(dy) * 1.25) return;
    void selectPhoneClub(selectedClubIdx + (dx < 0 ? 1 : -1));
  };

  useEffect(() => {
    if (!joined || !clientId) return;
    const events = new EventSource(
      apiUrl(`/api/events?code=${encodeURIComponent(code)}&clientId=${encodeURIComponent(
        clientId,
      )}`),
    );
    events.addEventListener("host_state", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as {
        state?: Partial<PhoneSyncState>;
      };
      if (payload.state) {
        setPhoneSync((prev) => ({
          ...prev,
          ...payload.state,
          powerBalance: normalizePowerBalance(payload.state?.powerBalance),
        }));
      }
      const next = payload.state?.clubIdx;
      if (typeof next === "number" && next >= 0 && next < CLUBS.length) {
        setSelectedClubIdx(next);
      }
      const payloadState = payload.state ?? {};
      if (typeof payloadState.currentPlayerId === "string") {
        setCurrentPlayerId(payloadState.currentPlayerId);
      }
      if (typeof payloadState.currentPlayerName === "string") {
        setCurrentPlayerName(payloadState.currentPlayerName);
      }
    });
    events.addEventListener("players_changed", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as {
        players: GolfPlayer[];
      };
      setLobbyPlayers((payload.players ?? []).map((p) => ({
        ...p,
        buildId: normalizeBuildId(p.buildId),
        controllerMount: normalizeControllerMount(p.controllerMount),
      })));
    });
    events.onerror = () => {
      setStatus((prev) => prev || "Waiting for host sync...");
    };
    return () => events.close();
  }, [joined, clientId, code]);

  useEffect(() => {
    if (!motionGranted) return;
    const handler = (event: DeviceMotionEvent) => {
      const linear = event.acceleration;
      const hasLinear =
        !!linear &&
        Math.hypot(linear.x || 0, linear.y || 0, linear.z || 0) > 0.05;
      const a = hasLinear ? linear : event.accelerationIncludingGravity;
      const r = event.rotationRate;
      const alpha = r?.alpha || 0;
      const beta = r?.beta || 0;
      const gamma = r?.gamma || 0;
      const rot = Math.hypot(alpha, beta, gamma);
      const raw = {
        x: a?.x || 0,
        y: a?.y || 0,
        z: a?.z || 0,
      };
      const grav = event.accelerationIncludingGravity;
      latestMotionRef.current = {
        ...raw,
        hasLinear,
        gx: grav?.x || 0,
        gy: grav?.y || 0,
        gz: grav?.z || 0,
      };
      const liveMag = hasLinear
        ? Math.hypot(raw.x, raw.y, raw.z)
        : Math.max(0, Math.hypot(raw.x, raw.y, raw.z) - 9.8);
      setLiveAccel((prev) => Math.max(prev * 0.85, liveMag));
      const now = performance.now();
      const capture = captureRef.current;
      const putting = !!phoneSyncRef.current.isPutter;
      const activeClub = CLUBS[phoneSyncRef.current.clubIdx ?? selectedClubIdx] ?? CLUBS[selectedClubIdx];
      const chipping = isChipShot(
        activeClub,
        phoneSyncRef.current.distanceMeters ?? 999,
        phoneSyncRef.current.surface ?? "fairway",
      );
      const gripButt = isGripButtMount(normalizeControllerMount(profileRef.current.controllerMount));
      if (capture.phase === "settling") {
        const stableAccel = putting
          ? gripButt ? 0.42 : 0.35
          : chipping
            ? gripButt ? 0.52 : 0.42
            : gripButt ? 0.72 : 0.55;
        const stableRot = putting
          ? gripButt ? 22 : 18
          : chipping
            ? gripButt ? 34 : 26
            : gripButt ? 48 : 35;
        const stable = liveMag < stableAccel && rot < stableRot;
        if (stable) {
          capture.stableSince ??= now;
        } else {
          capture.stableSince = null;
        }
        if (capture.stableSince !== null && now - capture.stableSince >= 380) {
          const calibration = captureSwingCalibration();
          resetSwingMotionState(latestMotionRef.current, calibration, false);
          capture.phase = "waiting";
          capture.lastMotionAt = now;
          capture.peakSeen = false;
          setCapturePhase("waiting");
          setStatus(putting ? "Putt!" : chipping ? "Chip!" : "Swing!");
        } else if (now - capture.requestedAt > 3000 && capture.stableSince === null) {
          setStatus("Hold still to calibrate...");
        }
      } else if (capture.phase === "waiting") {
        const startAccel = putting
          ? gripButt ? 0.45 : 0.55
          : chipping
            ? gripButt ? 0.62 : 0.75
            : gripButt ? 0.9 : 1.2;
        const startRot = putting
          ? gripButt ? 24 : 28
          : chipping
            ? gripButt ? 38 : 45
            : gripButt ? 64 : 85;
        const startDetected = liveMag > startAccel || rot > startRot;
        if (startDetected) {
          const calibration = calibrationRef.current ?? captureSwingCalibration();
          resetSwingMotionState(latestMotionRef.current, calibration, true);
          capture.phase = "recording";
          capture.lastMotionAt = now;
          capture.peakSeen = false;
          setCapturePhase("recording");
          setStatus("Recording...");
        } else if (now - capture.requestedAt > 8000) {
          cancelAutoSwing();
          setReady(true);
          setStatus("Swing timed out");
        }
      }
      const state = swingRef.current;
      if (state.armed) {
        const dx = hasLinear ? raw.x : raw.x - state.baseline.x;
        const dy = hasLinear ? raw.y : raw.y - state.baseline.y;
        const dz = hasLinear ? raw.z : raw.z - state.baseline.z;
        const accel = Math.hypot(dx, dy, dz);
        const elapsed = Math.max(0, (performance.now() - state.startedAt) / 1000);
        if (accel > state.maxAccel) state.maxAccel = accel;
        if (rot > state.maxRot) state.maxRot = rot;
        // Sample whenever there's any motion. The PCA/shape analysis
        // benefits from the smaller backswing samples — the dominant
        // axis is still set by the high-energy downswing because of the
        // squared-deltas in covariance.
        if (state.gyroSamples.length < 180) {
          state.gyroSamples.push({ t: elapsed, alpha, beta, gamma, accel });
        }
        const sampleGate = putting
          ? gripButt ? 0.1 : 0.15
          : chipping
            ? gripButt ? 0.18 : 0.25
            : gripButt ? 0.28 : 0.4;
        const sampleCap = putting ? 90 : chipping ? 120 : 180;
        if (accel > sampleGate && state.pathVectors.length < sampleCap) {
          state.pathVectors.push({
            x: dx,
            y: dy,
            z: dz,
            mag: accel,
            t: elapsed,
            rotAlpha: alpha,
            rotBeta: beta,
            rotGamma: gamma,
          });
          state.pathSamples += 1;
        }
        state.samples += 1;
        if (capture.phase === "recording") {
          const activeAccel = putting
            ? gripButt ? 0.34 : 0.45
            : chipping
              ? gripButt ? 0.48 : 0.6
              : gripButt ? 0.68 : 0.9;
          const activeRot = putting
            ? gripButt ? 18 : 22
            : chipping
              ? gripButt ? 30 : 38
              : gripButt ? 52 : 70;
          if (accel > activeAccel || rot > activeRot) {
            capture.lastMotionAt = now;
          }
          const peakAccel = putting
            ? gripButt ? 0.7 : 0.9
            : chipping
              ? gripButt ? 1.35 : 1.8
              : gripButt ? 2.2 : 3.0;
          const peakRot = putting
            ? gripButt ? 28 : 35
            : chipping
              ? gripButt ? 58 : 75
              : gripButt ? 105 : 140;
          if (state.maxAccel > peakAccel || state.maxRot > peakRot) {
            capture.peakSeen = true;
          }
          const maxMs = putting ? 2500 : chipping ? 2200 : 3000;
          const settleMs = putting ? 280 : chipping ? 300 : 340;
          if (
            now - state.startedAt > maxMs ||
            (capture.peakSeen && now - capture.lastMotionAt > settleMs && elapsed > 0.45)
          ) {
            void finishSwing();
          }
        }
      }
    };
    window.addEventListener("devicemotion", handler);
    return () => window.removeEventListener("devicemotion", handler);
  }, [motionGranted]);

  const enableMotion = async () => {
    setMotionError("");
    if (typeof DeviceMotionEvent === "undefined") {
      setMotionError("This browser has no motion sensor API.");
      return;
    }
    if (needsExplicitPermission && !isSecure) {
      setMotionError(
        "iOS needs HTTPS for motion. Use the public https:// game URL, or run HTTPS=1 npm run network for local testing.",
      );
      return;
    }
    try {
      if (needsExplicitPermission) {
        const motion = DeviceMotionEvent as unknown as {
          requestPermission: () => Promise<string>;
        };
        const result = await motion.requestPermission();
        if (result !== "granted") {
          setMotionError("Motion permission denied. Tap Enable Motion again to retry.");
          return;
        }
      }
      setMotionGranted(true);
    } catch (err) {
      setMotionError(
        "Motion permission failed: " + (err instanceof Error ? err.message : String(err)),
      );
    }
  };

  const finishSwing = async () => {
    if (!swinging && captureRef.current.phase === "idle") return;
    const state = swingRef.current;
    state.armed = false;
    setSwinging(false);
    setCaptureState("idle");
    captureRef.current.stableSince = null;
    captureRef.current.peakSeen = false;
    const elapsed = Math.max((performance.now() - state.startedAt) / 1000, 0.15);
    const selectedClub = CLUBS[phoneSyncRef.current.clubIdx ?? selectedClubIdx] ?? CLUBS[selectedClubIdx];
    if (phoneSyncRef.current.isPutter ?? selectedClub.putter) {
      await finishPutt(state, elapsed);
      return;
    }
    if (
      isChipShot(
        selectedClub,
        phoneSyncRef.current.distanceMeters ?? 999,
        phoneSyncRef.current.surface ?? "fairway",
      )
    ) {
      await finishChip(state, elapsed);
      return;
    }
    const gripButt = isGripButtMount(
      state.calibration?.controllerMount ?? normalizeControllerMount(profileRef.current.controllerMount),
    );
    const linearScore = THREE.MathUtils.clamp(
      (state.maxAccel - (gripButt ? 1.8 : 2.5)) / (gripButt ? 24 : 30),
      0,
      1,
    );
    const rotScore = THREE.MathUtils.clamp(
      (state.maxRot - (gripButt ? 65 : 100)) / (gripButt ? 1050 : 1400),
      0,
      1,
    );
    const tempoPenalty = elapsed < 0.22 ? 0.82 : elapsed > 1.45 ? 0.9 : 1;
    const motionPower =
      ((gripButt ? 0.6 : 0.78) * Math.pow(linearScore, 1.35) +
        (gripButt ? 0.4 : 0.22) * Math.pow(rotScore, 1.4)) *
      tempoPenalty;
    const realMotion =
      motionGranted &&
      state.samples >= 2 &&
      (state.maxAccel > (gripButt ? 3.1 : 4.5) || state.maxRot > (gripButt ? 115 : 160));

    // ── Target-relative frame. PCA remains only as a fallback if a swing somehow
    // finishes without calibration.
    const pca = computeSwingPCA(state.pathVectors);
    const projected = projectTargetFrame(
      state.pathVectors,
      state.calibration,
      pca.axis,
      state.gravity,
    );
    const targetMetrics = computeTargetPathMetrics(projected);
    const wobbleRatio = targetMetrics.sideRatio;
    const activeBuild = getPlayerBuild({
      buildId: phoneSyncRef.current.currentPlayerBuildId ?? profileRef.current.buildId,
    });
    const realism = realMotion
      ? computeSwingRealism(
          projected,
          state.gyroSamples,
          elapsed,
          state.maxRot,
          state.calibration?.controllerMount ?? normalizeControllerMount(profileRef.current.controllerMount),
          activeBuild,
          normalizePowerBalance(phoneSyncRef.current.powerBalance),
        )
      : null;
    const wobbleSeverity =
      realMotion && state.pathSamples >= 4
        ? THREE.MathUtils.clamp((wobbleRatio - 0.22) / 0.75, 0, 1)
        : 0;
    const pathQuality = realMotion
      ? THREE.MathUtils.clamp((1 - wobbleSeverity * 0.7) * (realism?.qualityCap ?? 1), 0.08, 1)
      : 1;

    // ── Shape: signed curve of the swing in the horizontal plane ──
    const calibratedShape =
      realMotion && state.calibration
        ? (state.calibration.handedness === "right"
            ? -targetMetrics.pathAngle
            : targetMetrics.pathAngle)
        : null;
    const rawShape = realMotion
      ? calibratedShape ?? computeShapeAngle(state.pathVectors, state.gravity, pca.axis)
      : 0;
    const shape = compressShapeAngle(rawShape);

    // ── Path miss: launch direction is now measured against the calibrated
    // target line, not against the swing's self-selected PCA axis.
    const realismMiss =
      realMotion && realism && realism.score < 0.62
        ? Math.sign(targetMetrics.pathAngle || targetMetrics.sideBias || 1) * (0.62 - realism.score) * 0.14
        : 0;
    const pathError = Math.abs(targetMetrics.pathAngle + realismMiss) > 0.025
      ? THREE.MathUtils.clamp(targetMetrics.pathAngle + realismMiss, -0.22, 0.22)
      : 0;

    // ── Labels ──
    const shapeDeg = Math.abs(shape) * (180 / Math.PI);
    const shapeLabel = shapeName(shape);
    let qualityLabel = "Pured it";
    if (wobbleSeverity > 0.55) qualityLabel = "Mis-strike";
    else if (wobbleSeverity > 0.28) qualityLabel = "Loose contact";
    if (realism && realism.score < 0.45) qualityLabel = "Bad contact";
    else if (realism && realism.score < 0.62) qualityLabel = "Weak contact";
    const label = realMotion
      ? realism && realism.score < 0.7
        ? `${realism.label} · ${qualityLabel}`
        : `${shapeLabel} · ${qualityLabel}`
      : "Fallback swing";

    const powerBalance = normalizePowerBalance(phoneSyncRef.current.powerBalance);
    // Power-balance reshapes the effort curve itself: in Relaxed / Compact a
    // smaller motion already counts as full effort (fullPowerAt is the effort
    // fraction that now maps to 100%). Applying it to motionPower lifts the
    // whole range — soft and hard swings alike — instead of only nudging the
    // top, and keeps the fixed 0.08 floor mode-independent. Because power is
    // now capped only for non-swings, the mode is felt on every real shot.
    const balancedEffort = THREE.MathUtils.clamp(
      motionPower / powerBalanceFullPowerAt(powerBalance),
      0,
      1,
    );
    const rawPower = THREE.MathUtils.clamp(0.08 + balancedEffort * 0.92, 0.08, 1);
    const power = realMotion
      ? Math.min(rawPower, realism?.powerCap ?? 1)
      : fallbackPower;

    // ── Build 2D points for the new result screen views ──
    // Face-On:       target axis (along) vs height (up)
    // Down-the-Line: side of target line vs height (up)
    const buildPolyline = (
      xs: number[],
      ys: number[],
      box: { w: number; h: number; pad: number },
    ): string => {
      if (xs.length === 0) return "";
      const xMin = Math.min(...xs), xMax = Math.max(...xs);
      const yMin = Math.min(...ys), yMax = Math.max(...ys);
      const xR = Math.max(xMax - xMin, 0.001);
      const yR = Math.max(yMax - yMin, 0.001);
      const sx = (box.w - box.pad * 2) / xR;
      const sy = (box.h - box.pad * 2) / yR;
      const s = Math.min(sx, sy);
      const cx = (xMin + xMax) / 2, cy = (yMin + yMax) / 2;
      return xs
        .map((x, i) => {
          const px = box.w / 2 + (x - cx) * s;
          const py = box.h / 2 - (ys[i] - cy) * s;
          return `${px.toFixed(1)},${py.toFixed(1)}`;
        })
        .join(" ");
    };
    const dtlBox = { w: 300, h: 170, pad: 16 };
    const foBox = { w: 300, h: 170, pad: 16 };
    const pathBox = { w: 300, h: 170, pad: 18 };
    const pointsDTL = projected.length > 1
      ? buildPolyline(
          projected.map((p) => p.side),
          projected.map((p) => p.up),
          dtlBox,
        )
      : "";
    const pointsFO = projected.length > 1
      ? buildPolyline(
          projected.map((p) => p.along),
          projected.map((p) => p.up),
          foBox,
        )
      : "";
    const pointsPath = projected.length > 1
      ? buildPolyline(
          projected.map((p) => p.side),
          projected.map((p) => p.along),
          pathBox,
        )
      : "";
    // Shape arrows: average first-third vs last-third in face-on (along, up) space.
    const third = Math.max(1, Math.floor(projected.length / 3));
    const arrAvg = (slice: typeof projected) => {
      let sxv = 0, suv = 0;
      for (const p of slice) { sxv += p.along; suv += p.up; }
      const n = slice.length || 1;
      return { x: sxv / n, y: suv / n };
    };
    const a1 = projected.length > 0 ? arrAvg(projected.slice(0, third)) : { x: 0, y: 0 };
    const a2 = projected.length > 0 ? arrAvg(projected.slice(-third)) : { x: 0, y: 0 };
    const arrowScale = 70;
    const cx = foBox.w / 2, cy = foBox.h / 2;
    const shapeArrow = {
      startX: cx + a1.x * arrowScale * 0.04,
      startY: cy - a1.y * arrowScale * 0.04,
      endX: cx + a2.x * arrowScale * 0.04,
      endY: cy - a2.y * arrowScale * 0.04,
    };

    const mode = swingModeRef.current;
    setLastSwingMode(mode);
    if (mode === "live") {
      await send({
        type: "swing",
        power,
        pathError: realMotion ? pathError : 0,
        pathQuality: realMotion ? pathQuality : 1,
        shape: realMotion ? shape : 0,
        label: realMotion ? label : "Fallback swing",
      });
    }
    const prefix = mode === "practice" ? "Practice · " : "";
    setStatus(
      realMotion
        ? `${prefix}${label} · ${Math.round(power * 100)}% · shape ${shapeDeg.toFixed(1)}°${state.calibration ? " · calibrated" : ""} · wobble ${wobbleRatio.toFixed(2)}`
        : `${prefix}Fallback swing ${Math.round(power * 100)}%${
            motionGranted ? " (no peak detected)" : ""
          }`,
    );
    setSwingResult({
      kind: "full",
      power,
      label,
      pathQuality: realMotion ? pathQuality : 1,
      pathError: realMotion ? pathError : 0,
      shape: realMotion ? shape : 0,
      peak: state.maxAccel,
      plane: wobbleRatio,
      realMotion,
      pointsDTL,
      pointsFO,
      pointsPath,
      shapeArrow,
      realMotionDuration: elapsed,
      realism: realism ?? undefined,
    });
  };

  const startSwing = (mode: "practice" | "live" = "live") => {
    if (!joined || swinging) return;
    swingModeRef.current = mode;
    setSwingResult(null);
    if (!motionGranted) {
      setStatus("Enable Motion first");
      void enableMotion();
      return;
    }
    const now = performance.now();
    captureRef.current = {
      phase: "settling",
      mode,
      requestedAt: now,
      stableSince: null,
      lastMotionAt: now,
      peakSeen: false,
    };
    swingRef.current.armed = false;
    setCapturePhase("settling");
    setSwinging(true);
    setStatus("Hold still...");
  };

  const useFallbackSwing = (mode: "practice" | "live" = "live") => {
    if (!joined || swinging) return;
    swingModeRef.current = mode;
    setSwingResult(null);
    const putting = !!phoneSyncRef.current.isPutter;
    const activeClub = CLUBS[phoneSyncRef.current.clubIdx ?? selectedClubIdx] ?? CLUBS[selectedClubIdx];
    const chipping = isChipShot(
      activeClub,
      phoneSyncRef.current.distanceMeters ?? 999,
      phoneSyncRef.current.surface ?? "fairway",
    );
    const verb = mode === "practice"
      ? putting ? "Practice putt" : chipping ? "Practice chip" : "Practice swing"
      : putting ? "Putting" : chipping ? "Chipping" : "Swinging";
    const latest = latestMotionRef.current;
    const now = performance.now();
    resetSwingMotionState(latest, null, false);
    captureRef.current = {
      phase: "recording",
      mode,
      requestedAt: now,
      stableSince: null,
      lastMotionAt: now,
      peakSeen: false,
    };
    setCapturePhase("recording");
    setSwinging(true);
    setStatus(`${verb} (fallback)...`);
    window.setTimeout(() => {
      void finishSwing();
    }, 120);
  };

  const finishChip = async (state: SwingMotionState, elapsed: number) => {
    const gripButt = isGripButtMount(
      state.calibration?.controllerMount ?? normalizeControllerMount(profileRef.current.controllerMount),
    );
    const realMotion =
      motionGranted &&
      state.samples >= 2 &&
      (state.maxAccel > (gripButt ? 1.2 : 1.6) ||
        state.maxRot > (gripButt ? 45 : 60) ||
        state.pathSamples >= 4);
    const pca = computeSwingPCA(state.pathVectors);
    const projected = projectTargetFrame(
      state.pathVectors,
      state.calibration,
      pca.axis,
      state.gravity,
    );
    const targetMetrics = computeTargetPathMetrics(projected);
    const pathSeverity = realMotion && state.pathSamples >= 4
      ? THREE.MathUtils.clamp((targetMetrics.sideRatio - 0.28) / 0.9, 0, 1)
      : 0;
    const tempoScore = THREE.MathUtils.clamp(1 - Math.abs(elapsed - 0.85) / 0.85, 0, 1);
    const contact = realMotion
      ? THREE.MathUtils.clamp(1 - pathSeverity * 0.45 + tempoScore * 0.12, 0.25, 1)
      : 1;
    const linearScore = THREE.MathUtils.clamp(
      (state.maxAccel - (gripButt ? 0.45 : 0.7)) / (gripButt ? 8.5 : 11),
      0,
      1,
    );
    const rotScore = THREE.MathUtils.clamp(
      (state.maxRot - (gripButt ? 24 : 35)) / (gripButt ? 420 : 520),
      0,
      1,
    );
    const motionPower =
      ((gripButt ? 0.56 : 0.72) * Math.pow(linearScore, 1.08) +
        (gripButt ? 0.44 : 0.28) * Math.pow(rotScore, 1.15)) *
      THREE.MathUtils.lerp(0.82, 1.05, tempoScore);
    const recommended = phoneSyncRef.current.recommendedPower ?? fallbackPower;
    const power = realMotion
      ? THREE.MathUtils.clamp(recommended * 0.35 + motionPower * 0.65, 0.04, 0.86)
      : fallbackPower;
    const pathError = Math.abs(targetMetrics.pathAngle) > 0.035
      ? THREE.MathUtils.clamp(targetMetrics.pathAngle * 0.45, -0.09, 0.09)
      : 0;
    const shape = realMotion
      ? THREE.MathUtils.clamp(compressShapeAngle(targetMetrics.pathAngle) * 0.28, -0.08, 0.08)
      : 0;
    const qualityLabel =
      contact > 0.78
        ? "Crisp chip"
        : tempoScore < 0.45
          ? "Tempo off"
          : "Thin contact";
    const directionLabel =
      Math.abs(pathError) < 0.025
        ? "Online"
        : pathError > 0
          ? "Pushed"
          : "Pulled";
    const label = realMotion
      ? `${directionLabel} · ${qualityLabel}`
      : "Fallback chip";
    const pointsDTL = projected.length > 1
      ? buildScaledPolyline(
          projected.map((p) => p.side),
          projected.map((p) => p.up),
          { w: 300, h: 170, pad: 16 },
        )
      : "";
    const pointsFO = projected.length > 1
      ? buildScaledPolyline(
          projected.map((p) => p.along),
          projected.map((p) => p.up),
          { w: 300, h: 170, pad: 16 },
        )
      : "";
    const mode = swingModeRef.current;
    setLastSwingMode(mode);
    if (mode === "live") {
      await send({
        type: "swing",
        power,
        pathError: realMotion ? pathError : 0,
        pathQuality: realMotion ? contact : 1,
        shape: realMotion ? shape : 0,
        label: realMotion ? label : "Fallback chip",
      });
    }
    const prefix = mode === "practice" ? "Practice · " : "";
    setStatus(
      realMotion
        ? `${prefix}${label} · ${Math.round(power * 100)}% · tempo ${elapsed.toFixed(2)}s`
        : `${prefix}Fallback chip ${Math.round(power * 100)}%${
            motionGranted ? " (no chip peak detected)" : ""
          }`,
    );
    setSwingResult({
      kind: "chip",
      power,
      label,
      pathQuality: realMotion ? contact : 1,
      pathError: realMotion ? pathError : 0,
      shape: realMotion ? shape : 0,
      peak: state.maxAccel,
      plane: targetMetrics.sideRatio,
      realMotion,
      pointsDTL,
      pointsFO,
      pointsPath: "",
      shapeArrow: { startX: 150, startY: 85, endX: 150 + pathError * 260, endY: 85 },
      realMotionDuration: elapsed,
    });
  };

  const finishPutt = async (state: SwingMotionState, elapsed: number) => {
    const gripButt = isGripButtMount(
      state.calibration?.controllerMount ?? normalizeControllerMount(profileRef.current.controllerMount),
    );
    const realMotion =
      motionGranted &&
      state.samples >= 2 &&
      (state.maxAccel > (gripButt ? 0.72 : 1.0) ||
        state.maxRot > (gripButt ? 17 : 22) ||
        state.pathSamples >= 3);
    const pca = computeSwingPCA(state.pathVectors);
    let projected = projectTargetFrame(
      state.pathVectors,
      state.calibration,
      pca.axis,
      state.gravity,
    );
    const firstAlong = projected[0]?.along ?? 0;
    const lastAlong = projected[projected.length - 1]?.along ?? firstAlong;
    // Keep follow-through visually "forward" for the top-down plot.
    if (lastAlong < firstAlong) {
      projected = projected.map((p) => ({ ...p, along: -p.along, side: -p.side }));
    }
    const targetMetrics = computeTargetPathMetrics(projected);
    const puttingBuild = getPlayerBuild({
      buildId: phoneSyncRef.current.currentPlayerBuildId ?? profile.buildId,
    });
    const puttForgiveness = puttingMistakeFactor(puttingBuild);

    const alongs = projected.map((p) => p.along);
    const reversalIndex = alongs.length > 0
      ? alongs.reduce((best, value, index) => (value < alongs[best] ? index : best), 0)
      : 0;
    const reversalTime = projected[reversalIndex]?.mag !== undefined
      ? state.pathVectors[reversalIndex]?.t ?? elapsed * 0.55
      : elapsed * 0.55;
    const backTime = THREE.MathUtils.clamp(reversalTime, 0.08, elapsed);
    const throughTime = THREE.MathUtils.clamp(elapsed - reversalTime, 0.06, elapsed);
    const tempoRatio = backTime / throughTime;
    const backPeak = Math.max(0.05, ...state.pathVectors.slice(0, reversalIndex + 1).map((p) => p.mag));
    const throughPeak = Math.max(0.05, ...state.pathVectors.slice(reversalIndex + 1).map((p) => p.mag));
    const accelRatio = throughPeak / backPeak;
    const tempoScore = THREE.MathUtils.clamp(1 - Math.abs(tempoRatio - 2) / 1.8, 0, 1);
    const accelScore = THREE.MathUtils.clamp(1 - Math.abs(Math.log(Math.max(accelRatio, 0.05))) / 1.25, 0, 1);
    const rawStrike = realMotion
      ? THREE.MathUtils.clamp(0.55 * tempoScore + 0.45 * accelScore, 0.15, 1)
      : 1;
    const strike = realMotion
      ? THREE.MathUtils.clamp(1 - (1 - rawStrike) * puttForgiveness, 0.15, 1)
      : 1;

    const recommended = phoneSyncRef.current.recommendedPower ?? fallbackPower;
    const percentile = (values: number[], pct: number, fallback: number) => {
      if (values.length === 0) return fallback;
      const sorted = [...values].sort((a, b) => a - b);
      const idx = THREE.MathUtils.clamp(Math.floor((sorted.length - 1) * pct), 0, sorted.length - 1);
      return sorted[idx];
    };
    const usefulBackAccel = percentile(
      state.pathVectors.slice(0, reversalIndex + 1).map((p) => p.mag),
      0.72,
      backPeak,
    );
    const usefulThroughAccel = percentile(
      state.pathVectors.slice(reversalIndex + 1).map((p) => p.mag),
      0.72,
      throughPeak,
    );
    const usefulAccel = THREE.MathUtils.clamp(
      usefulThroughAccel * 0.62 + usefulBackAccel * 0.38,
      0,
      3.2,
    );
    const accelEffort = THREE.MathUtils.clamp((usefulAccel - 0.08) / 2.35, 0, 1);
    const lengthEffort = THREE.MathUtils.clamp(backTime / 0.85, 0.18, 1);
    const paceSignal = THREE.MathUtils.clamp(
      (accelEffort * 0.45 + lengthEffort * 0.55) * THREE.MathUtils.lerp(0.9, 1.08, tempoScore),
      0,
      1,
    );
    const paceMultiplier = THREE.MathUtils.lerp(0.42, 1.62, Math.pow(paceSignal, 1.12));
    const puttPowerCeiling = THREE.MathUtils.clamp(recommended * 1.45 + 0.08, 0.16, 1);
    const motionPower = THREE.MathUtils.clamp(
      recommended * paceMultiplier,
      0.025,
      puttPowerCeiling,
    );
    const rawPower = realMotion
      ? THREE.MathUtils.clamp(motionPower, 0.025, puttPowerCeiling)
      : fallbackPower;
    const balancedRawPower = realMotion
      ? applyPowerBalance(rawPower, normalizePowerBalance(phoneSyncRef.current.powerBalance), puttPowerCeiling)
      : rawPower;
    const power = realMotion
      ? THREE.MathUtils.clamp(recommended + (balancedRawPower - recommended) * puttForgiveness, 0.025, puttPowerCeiling)
      : fallbackPower;

    const sampleAroundImpact = (() => {
      const target = reversalTime + throughTime * 0.58;
      const windowed = state.gyroSamples.filter((s) => Math.abs(s.t - target) < 0.16);
      return windowed.length > 0 ? windowed : state.gyroSamples.slice(-8);
    })();
    let twistAlpha = 0, twistBeta = 0, twistGamma = 0;
    for (let i = 1; i < sampleAroundImpact.length; i++) {
      const prev = sampleAroundImpact[i - 1];
      const sample = sampleAroundImpact[i];
      const dt = THREE.MathUtils.clamp(sample.t - prev.t, 0, 0.06);
      twistAlpha += sample.alpha * dt;
      twistBeta += sample.beta * dt;
      twistGamma += sample.gamma * dt;
    }
    const twistCandidates = [twistAlpha, twistBeta, twistGamma];
    const twistDeg = twistCandidates.reduce((best, value) =>
      Math.abs(value) > Math.abs(best) ? value : best,
    0);
    const pathStartDeg = THREE.MathUtils.radToDeg(
      THREE.MathUtils.clamp(targetMetrics.pathAngle, -0.08, 0.08),
    );
    const rawStartLineDeg = THREE.MathUtils.clamp(twistDeg * 0.18 + pathStartDeg * 0.35, -4.5, 4.5);
    const startLineDeg = realMotion
      ? rawStartLineDeg * puttForgiveness
      : 0;
    const pathError = THREE.MathUtils.degToRad(startLineDeg);
    const absStart = Math.abs(startLineDeg);
    const startLineLabel =
      absStart < 0.5
        ? "ONLINE"
        : startLineDeg > 0
          ? `PUSHED RIGHT ${absStart.toFixed(1)}°`
          : `PULLED LEFT ${absStart.toFixed(1)}°`;

    const distanceMeters = phoneSyncRef.current.distanceMeters ?? 6;
    const feetError = Math.max(1, Math.round(Math.abs(power - recommended) * (distanceMeters * 3.28 * 1.45 + 6)));
    const paceLabel =
      Math.abs(power - recommended) < 0.07
        ? "Pace good"
        : power < recommended
          ? `Left short by ~${feetError} ft`
          : `Raced ~${feetError} ft past`;
    const distanceText =
      Math.abs(power - recommended) < 0.07
        ? "Speed matched"
        : power < recommended
          ? "Too soft"
          : "Too firm";
    const strikeLabel =
      strike > 0.78
        ? "Smooth strike"
        : accelRatio < 0.72
          ? "Decelerated"
          : tempoRatio < 1.35
            ? "Rushed"
            : "Uneven strike";
    const pathLabel =
      projected.length > 2 && targetMetrics.sideRatio > 0.28
        ? "Arced stroke"
        : "Straight path";

    const topDownPoints = projected.length > 1
      ? buildScaledPolyline(
          projected.map((p) => p.side),
          projected.map((p) => p.along),
          { w: 300, h: 190, pad: 24 },
        )
      : "";
    const mode = swingModeRef.current;
    setLastSwingMode(mode);
    if (mode === "live") {
      await send({
        type: "swing",
        power,
        pathError: realMotion ? pathError : 0,
        pathQuality: realMotion ? strike : 1,
        shape: 0,
        label: realMotion ? `${startLineLabel} · ${strikeLabel}` : "Fallback putt",
      });
    }
    const prefix = mode === "practice" ? "Practice · " : "";
    setStatus(
      realMotion
        ? `${prefix}${startLineLabel} · ${Math.round(power * 100)}% · tempo ${tempoRatio.toFixed(1)}:1`
        : `${prefix}Fallback putt ${Math.round(power * 100)}%${
            motionGranted ? " (no putt peak detected)" : ""
          }`,
    );
    setSwingResult({
      kind: "putt",
      power,
      label: realMotion ? `${startLineLabel} · ${strikeLabel}` : "Fallback putt",
      pathQuality: realMotion ? strike : 1,
      pathError: realMotion ? pathError : 0,
      shape: 0,
      peak: state.maxAccel,
      plane: accelRatio,
      realMotion,
      pointsDTL: "",
      pointsFO: "",
      pointsPath: "",
      shapeArrow: { startX: 0, startY: 0, endX: 0, endY: 0 },
      realMotionDuration: elapsed,
      putt: {
        topDownPoints,
        tempoRatio,
        backTime,
        throughTime,
        startLineDeg: realMotion ? startLineDeg : 0,
        distanceText,
        strike: realMotion ? strike : 1,
        accelRatio,
        pathLabel,
        paceLabel,
      },
    });
  };

  if (!joined) {
    return (
      <div style={menuStyles.shell}>
        <div style={{ ...menuStyles.panel, minWidth: 320 }}>
          <div style={{ fontSize: 28, fontWeight: 900, marginBottom: 16 }}>Join Host</div>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="CODE"
            maxLength={6}
            style={menuStyles.input}
          />
          <div style={{ marginTop: 8, marginBottom: 4, opacity: 0.7, fontSize: 12, letterSpacing: 1 }}>YOUR NAME</div>
          <input
            value={profile.name}
            onChange={(e) => setProfile((p) => ({ ...p, name: e.target.value.slice(0, 18) }))}
            placeholder="Player name"
            maxLength={18}
            style={menuStyles.input}
          />
          <div style={{ margin: "10px 0 14px", fontSize: 12, opacity: 0.62, lineHeight: 1.35 }}>
            Build, handedness, controller mount, and outfit are selected after connecting.
          </div>
          <button style={menuStyles.primaryButton} onClick={join}>Connect</button>
          <button style={menuStyles.button} onClick={onBack}>Back</button>
          {status && <div style={menuStyles.error}>{status}</div>}
        </div>
      </div>
    );
  }

  const isMyTurn = currentPlayerId && currentPlayerId === clientId;

  if (!gameStarted) {
    // Pre-game lobby on the phone: hide all golf controls; show a player
    // preview and the full roster of everyone in the lobby.
    return (
      <PhoneLobbyView
        code={code}
        profile={profile}
        players={lobbyPlayers}
        myClientId={clientId}
        onPick={pushProfile}
      />
    );
  }

  if (swingResult) {
    if (swingResult.kind === "putt" && swingResult.putt) {
      const putt = swingResult.putt;
      const strikeColor =
        putt.strike > 0.8 ? "#63d471" : putt.strike > 0.55 ? "#ffb13b" : "#ff5d5d";
      const startColor =
        Math.abs(putt.startLineDeg) < 0.5 ? "#63d471" : Math.abs(putt.startLineDeg) < 2 ? "#ffb13b" : "#ff5d5d";
      const startLineText =
        Math.abs(putt.startLineDeg) < 0.5
          ? "ONLINE"
          : putt.startLineDeg > 0
            ? `PUSHED RIGHT ${Math.abs(putt.startLineDeg).toFixed(1)}°`
            : `PULLED LEFT ${Math.abs(putt.startLineDeg).toFixed(1)}°`;
      const totalTempo = Math.max(putt.backTime + putt.throughTime, 0.01);
      const backPct = (putt.backTime / totalTempo) * 100;
      return (
        <div style={controllerStyles.resultShell}>
          <div style={controllerStyles.resultHeader}>
            <div>
              <div style={{ fontSize: 12, opacity: 0.7, display: "flex", gap: 6, alignItems: "center" }}>
                {lastSwingMode === "practice" && (
                  <span
                    style={{
                      padding: "2px 7px",
                      borderRadius: 999,
                      background: "rgba(255,177,59,0.25)",
                      border: "1px solid rgba(255,177,59,0.55)",
                      color: "#ffb13b",
                      fontWeight: 800,
                      letterSpacing: 1,
                      fontSize: 10,
                    }}
                  >
                    PRACTICE
                  </span>
                )}
                Putt analysis
              </div>
              <div style={{ fontSize: 22, fontWeight: 950, lineHeight: 1.1 }}>{swingResult.label}</div>
            </div>
            <div
              style={{
                ...controllerStyles.scorePill,
                borderColor: strikeColor,
                color: strikeColor,
                display: "flex",
                flexDirection: "column",
                padding: "4px 8px",
                minWidth: 70,
              }}
            >
              <span style={{ fontSize: 9, opacity: 0.7, letterSpacing: 1 }}>STRIKE</span>
              <span style={{ fontSize: 22 }}>{Math.round(putt.strike * 100)}</span>
            </div>
          </div>

          <PuttStrokeView putt={putt} />

          <div style={controllerStyles.metricGrid}>
            <div style={controllerStyles.metricBox}>
              <div style={controllerStyles.metricLabel}>Start Line</div>
              <div style={{ ...controllerStyles.metricValue, color: startColor, fontSize: 19 }}>
                {startLineText}
              </div>
            </div>
            <div style={controllerStyles.metricBox}>
              <div style={controllerStyles.metricLabel}>Distance</div>
              <div style={{ ...controllerStyles.metricValue, fontSize: 20 }}>
                {putt.distanceText}
              </div>
              <div style={{ fontSize: 12, opacity: 0.72, fontWeight: 800 }}>{putt.paceLabel}</div>
            </div>
          </div>

          <div style={controllerStyles.metricBox}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <div style={controllerStyles.metricLabel}>Tempo</div>
              <div style={{ fontSize: 13, fontWeight: 900 }}>
                {putt.tempoRatio.toFixed(1)}:1
              </div>
            </div>
            <div style={{ ...controllerStyles.resultMeter, position: "relative", height: 14 }}>
              <div
                style={{
                  height: "100%",
                  width: `${backPct}%`,
                  background: "#3a7bd6",
                  borderRadius: "999px 0 0 999px",
                }}
              />
              <div
                style={{
                  position: "absolute",
                  left: `${backPct}%`,
                  top: 0,
                  bottom: 0,
                  width: 2,
                  background: "rgba(255,255,255,0.78)",
                }}
              />
              <div
                style={{
                  position: "absolute",
                  left: "66.7%",
                  top: -3,
                  bottom: -3,
                  width: 2,
                  background: "#63d471",
                }}
              />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, opacity: 0.65, marginTop: 6 }}>
              <span>Back {putt.backTime.toFixed(2)}s</span>
              <span>2:1 marker</span>
              <span>Through {putt.throughTime.toFixed(2)}s</span>
            </div>
          </div>

          <div style={controllerStyles.diag}>
            Peak {swingResult.peak.toFixed(1)} m/s² · accel ratio {putt.accelRatio.toFixed(2)}
            {!swingResult.realMotion ? " · fallback" : ""}
          </div>

          <button
            style={controllerStyles.continueButton}
            onClick={() => {
              setSwingResult(null);
              if (lastSwingMode === "live") setReady(false);
            }}
          >
            {lastSwingMode === "practice" ? "Back to controls" : "Continue"}
          </button>
        </div>
      );
    }

    const qualityColor =
      swingResult.pathQuality > 0.8
        ? "#63d471"
        : swingResult.pathQuality > 0.55
          ? "#ffb13b"
          : "#ff5d5d";
    const shapeDeg = swingResult.shape * (180 / Math.PI);
    const shapeColor = swingResult.shape > 0 ? "#3a7bd6" : swingResult.shape < 0 ? "#d63ac4" : "#63d471";
    const shapeLabel = shapeName(swingResult.shape);
    const shapeText =
      Math.abs(shapeDeg) < 3
        ? "Straight"
        : `${Math.abs(shapeDeg).toFixed(0)}° ${shapeLabel.toLowerCase()}`;
    const missText =
      Math.abs(swingResult.pathError) < 0.035
        ? "On line"
        : swingResult.pathError > 0
          ? `Pushed right · ${(Math.abs(swingResult.pathError) * 180 / Math.PI).toFixed(0)}°`
          : `Pulled left · ${(Math.abs(swingResult.pathError) * 180 / Math.PI).toFixed(0)}°`;
    const clubPathText =
      Math.abs(swingResult.pathError) < 0.035
        ? "Neutral path"
        : swingResult.pathError > 0
          ? "In-to-out"
          : "Out-to-in";
    const realismColor = !swingResult.realism
      ? qualityColor
      : swingResult.realism.score > 0.74
        ? "#63d471"
        : swingResult.realism.score > 0.52
          ? "#ffb13b"
          : "#ff5d5d";

    return (
      <div style={controllerStyles.resultShell}>
        <div style={controllerStyles.resultHeader}>
          <div>
            <div style={{ fontSize: 12, opacity: 0.7, display: "flex", gap: 6, alignItems: "center" }}>
              {lastSwingMode === "practice" && (
                <span
                  style={{
                    padding: "2px 7px",
                    borderRadius: 999,
                    background: "rgba(255,177,59,0.25)",
                    border: "1px solid rgba(255,177,59,0.55)",
                    color: "#ffb13b",
                    fontWeight: 800,
                    letterSpacing: 1,
                    fontSize: 10,
                  }}
                >
                  PRACTICE
                </span>
              )}
              {swingResult.kind === "chip" ? "Chip analysis" : "Swing analysis"}
            </div>
            <div style={{ fontSize: 22, fontWeight: 950, lineHeight: 1.1 }}>{swingResult.label}</div>
          </div>
          <div
            style={{
              ...controllerStyles.scorePill,
              borderColor: qualityColor,
              color: qualityColor,
              display: "flex",
              flexDirection: "column",
              padding: "4px 8px",
              minWidth: 70,
            }}
          >
            <span style={{ fontSize: 9, opacity: 0.7, letterSpacing: 1 }}>QUALITY</span>
            <span style={{ fontSize: 22 }}>{Math.round(swingResult.pathQuality * 100)}</span>
          </div>
        </div>

        {/* Two views side by side: FACE-ON shows shape/curve; DOWN-THE-LINE shows the swing plane. */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <SwingView
            title="FACE ON"
            subtitle={shapeText}
            subtitleColor={shapeColor}
            points={swingResult.pointsFO}
            arrow={swingResult.shapeArrow}
            realMotion={swingResult.realMotion}
            qualityColor={qualityColor}
          />
          <SwingView
            title="DOWN THE LINE"
            subtitle={missText}
            subtitleColor={Math.abs(swingResult.pathError) < 0.035 ? "#63d471" : qualityColor}
            points={swingResult.pointsDTL}
            realMotion={swingResult.realMotion}
            qualityColor={qualityColor}
          />
        </div>
        {swingResult.kind === "full" && (
          <ClubPathView
            subtitle={swingResult.realism ? `${clubPathText} · ${swingResult.realism.label}` : clubPathText}
            subtitleColor={realismColor}
            points={swingResult.pointsPath}
            realMotion={swingResult.realMotion}
          />
        )}

        <div style={controllerStyles.metricGrid}>
          <div style={controllerStyles.metricBox}>
            <div style={controllerStyles.metricLabel}>Power</div>
            <div style={controllerStyles.metricValue}>{Math.round(swingResult.power * 100)}%</div>
            <div style={controllerStyles.resultMeter}>
              <div
                style={{
                  ...controllerStyles.resultMeterFill,
                  width: `${swingResult.power * 100}%`,
                  background: "#63d471",
                }}
              />
            </div>
          </div>
          <div style={controllerStyles.metricBox}>
            <div style={controllerStyles.metricLabel}>Shape</div>
            <div style={{ ...controllerStyles.metricValue, color: shapeColor }}>
              {Math.abs(shapeDeg) < 3 ? "—" : `${Math.abs(shapeDeg).toFixed(1)}°`}
            </div>
            <div style={controllerStyles.resultMeter}>
              <div
                style={{
                  ...controllerStyles.resultMeterFill,
                  width: `${Math.min(100, Math.abs(shapeDeg) * 4)}%`,
                  background: shapeColor,
                  marginLeft: shapeDeg < 0 ? "auto" : 0,
                }}
              />
            </div>
          </div>
        </div>

        <div style={controllerStyles.diag}>
          Peak {swingResult.peak.toFixed(1)} m/s² · tempo {swingResult.realMotionDuration.toFixed(2)}s · wobble {swingResult.plane.toFixed(2)}
          {swingResult.realism ? ` · motion ${Math.round(swingResult.realism.score * 100)}` : ""}
          {!swingResult.realMotion ? " · fallback" : ""}
        </div>

        <button
          style={controllerStyles.continueButton}
          onClick={() => {
            setSwingResult(null);
            // After a real swing the ball was hit; reset Ready so the next
            // shot needs another explicit Ready tap. Practice swings keep
            // Ready engaged so you can try again immediately.
            if (lastSwingMode === "live") setReady(false);
          }}
        >
          {lastSwingMode === "practice" ? "Back to controls" : "Continue"}
        </button>
      </div>
    );
  }

  const selectedClub = CLUBS[selectedClubIdx];
  const puttingMode = !!(phoneSync.isPutter ?? selectedClub.putter);
  const chippingMode = isChipShot(
    selectedClub,
    phoneSync.distanceMeters ?? 999,
    phoneSync.surface ?? "fairway",
  );
  const selectedBuild = getPlayerBuild({ buildId: phoneSync.currentPlayerBuildId ?? profile.buildId });
  const selectedEffectiveClub = effectiveClubForLie(
    effectiveClubForBuild(selectedClub, selectedBuild),
    phoneSync.surface ?? "tee",
  );
  const selectedCarry = selectedClub.putter
    ? `${selectedClub.carry.toFixed(0)} m roll`
    : `${(selectedEffectiveClub.carry / 0.9144).toFixed(0)} yd carry`;
  const captureText =
    capturePhase === "settling"
      ? "Hold Still"
      : capturePhase === "waiting"
        ? puttingMode ? "Putt!" : chippingMode ? "Chip!" : "Swing!"
        : capturePhase === "recording"
          ? "Recording"
          : null;
  const activePowerBalance = normalizePowerBalance(phoneSync.powerBalance);
  const activePowerBalanceLabel =
    POWER_BALANCE_OPTIONS.find((option) => option.value === activePowerBalance)?.label ?? "Realistic";

  return (
    <div style={controllerStyles.shell}>
      <div style={{ ...controllerStyles.header, flex: "0 0 auto" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
          <div style={{ fontSize: 18, fontWeight: 900 }}>{code}</div>
          <div
            style={{
              fontSize: 11,
              opacity: 0.7,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            · {profile.name}
          </div>
        </div>
        <button
          style={{ ...controllerStyles.smallButton, minHeight: 30, padding: "2px 10px" }}
          onClick={() => send({ type: "pin" })}
        >
          Pin
        </button>
      </div>

      {currentPlayerName && (
        <div
          style={{
            padding: "5px 10px",
            borderRadius: 8,
            background: isMyTurn ? "rgba(95,211,95,0.18)" : "rgba(255,255,255,0.05)",
            border: `1px solid ${isMyTurn ? "rgba(95,211,95,0.55)" : "rgba(255,255,255,0.18)"}`,
            color: "white",
            fontWeight: 800,
            fontSize: 12,
            letterSpacing: 0.5,
            flex: "0 0 auto",
            textAlign: "center",
          }}
        >
          {isMyTurn
            ? `Your turn — ${currentPlayerName} · ${selectedBuild.name}`
            : `${currentPlayerName} is up · ${selectedBuild.name}`}
        </div>
      )}

      <div style={controllerStyles.row}>
        <button style={controllerStyles.bigButton} onClick={() => send({ type: "aim", delta: -0.025 })}>Aim ←</button>
        <button style={controllerStyles.bigButton} onClick={() => send({ type: "aim", delta: 0.025 })}>Aim →</button>
      </div>

      <div
        style={controllerStyles.clubSelector}
        onPointerDown={handleClubPointerDown}
        onPointerUp={handleClubPointerUp}
        onPointerCancel={() => {
          clubSwipeRef.current = null;
        }}
      >
        <button
          style={controllerStyles.clubArrow}
          onClick={() => selectPhoneClub(selectedClubIdx - 1)}
          aria-label="Previous club"
        >
          ‹
        </button>
        <div style={controllerStyles.clubDisplay}>
          <div style={controllerStyles.clubMeta}>
            <div style={controllerStyles.clubShort}>{selectedClub.short}</div>
            <div>
              <div style={controllerStyles.clubName}>{selectedClub.name}</div>
              <div style={controllerStyles.clubCarry}>{selectedCarry}</div>
            </div>
          </div>
          <PhoneClubPreview club={selectedClub} />
        </div>
        <button
          style={controllerStyles.clubArrow}
          onClick={() => selectPhoneClub(selectedClubIdx + 1)}
          aria-label="Next club"
        >
          ›
        </button>
      </div>

      <div style={controllerStyles.clubDots}>
        {CLUBS.map((club, index) => (
          <button
            key={club.id}
            style={{
              ...controllerStyles.clubDot,
              background:
                index === selectedClubIdx
                  ? "#63d471"
                  : "rgba(255,255,255,0.28)",
              width: index === selectedClubIdx ? 22 : 9,
            }}
            onClick={() => selectPhoneClub(index)}
            aria-label={club.name}
          />
        ))}
      </div>

      <div style={controllerStyles.row}>
        <button
          style={controllerStyles.smallButton}
          onClick={() => {
            setStatus("Auto club selected on host");
            void send({ type: "autoClub" });
          }}
        >
          Auto Club
        </button>
        <button style={controllerStyles.smallButton} onClick={() => send({ type: "view" })}>View</button>
      </div>

      {!ready && (
        <MountSelector
          value={normalizeControllerMount(profile.controllerMount)}
          onPick={(controllerMount) => {
            calibrationRef.current = null;
            pushProfile({ controllerMount });
          }}
          compact
        />
      )}

      {/* Compact motion/fallback row. Hidden once Ready is engaged so the
          swing buttons can fill the bottom of the screen. */}
      {!ready && (
        <div style={controllerStyles.motionRow}>
          {!motionGranted ? (
            <button style={controllerStyles.smallButton} onClick={enableMotion}>
              Enable Motion {needsExplicitPermission && !isSecure ? "(needs HTTPS)" : ""}
            </button>
          ) : (
            <div style={controllerStyles.diag}>
              Motion: {liveAccel.toFixed(1)} m/s² · peak {swingRef.current.maxAccel.toFixed(1)} · {activePowerBalanceLabel}
            </div>
          )}
          {!motionGranted && (
            <label style={controllerStyles.fallbackLabel}>
              <span>Power {Math.round(fallbackPower * 100)}%</span>
              <input
                type="range"
                min="0.08"
                max="1"
                step="0.01"
                value={fallbackPower}
                onChange={(e) => setFallbackPower(Number(e.target.value))}
                style={{ width: "100%" }}
              />
            </label>
          )}
        </div>
      )}
      {motionError && <div style={controllerStyles.diagWarn}>{motionError}</div>}

      <div style={controllerStyles.swingArea}>
        {!ready ? (
          <button
            style={{
              ...controllerStyles.swingButton,
              background: "#ffd23b",
              color: "#1a1a1a",
            }}
            onClick={() => setReady(true)}
          >
            READY
          </button>
        ) : (
          <div style={controllerStyles.swingPair}>
            <button
              style={{
                ...controllerStyles.swingButton,
                background:
                  swinging && swingModeRef.current === "practice" ? "#ffb13b" : "#3a7bd6",
                color: "white",
                fontSize: 18,
                opacity: swinging && swingModeRef.current !== "practice" ? 0.45 : 1,
              }}
              onClick={() => startSwing("practice")}
              disabled={swinging}
            >
              {swinging && swingModeRef.current === "practice"
                ? captureText
                : puttingMode ? "Practice\nPutt" : chippingMode ? "Practice\nChip" : "Practice\nSwing"}
            </button>
            <button
              style={{
                ...controllerStyles.swingButton,
                background:
                  swinging && swingModeRef.current === "live" ? "#ffb13b" : "#63d471",
                color: "#0d1b16",
                opacity: swinging && swingModeRef.current !== "live" ? 0.45 : 1,
              }}
              onClick={() => startSwing("live")}
              disabled={swinging}
            >
              {swinging && swingModeRef.current === "live" ? captureText : puttingMode ? "PUTT" : chippingMode ? "CHIP" : "SWING"}
            </button>
          </div>
        )}
        {ready && !motionGranted && !swinging && (
          <div style={controllerStyles.fallbackReadyRow}>
            <button
              style={controllerStyles.smallButton}
              onClick={() => useFallbackSwing("practice")}
            >
              Fallback Practice
            </button>
            <button
              style={controllerStyles.smallButton}
              onClick={() => useFallbackSwing("live")}
            >
              Fallback Shot
            </button>
          </div>
        )}
        {ready && (
          <button
            style={controllerStyles.cancelReady}
            onClick={swinging ? cancelAutoSwing : () => setReady(false)}
          >
            {swinging ? "Cancel Swing" : "Cancel"}
          </button>
        )}
      </div>
      <div style={controllerStyles.status}>{status}</div>
    </div>
  );
}

const menuStyles = {
  shell: {
    minHeight: "100%",
    display: "grid",
    placeItems: "center",
    background: "#bcdcff",
    color: "#142033",
    fontFamily: "-apple-system, system-ui, sans-serif",
    padding: 20,
  } satisfies React.CSSProperties,
  panel: {
    width: "min(460px, 100%)",
    background: "rgba(255,255,255,0.82)",
    border: "1px solid rgba(20,32,51,0.14)",
    borderRadius: 8,
    padding: 24,
    boxShadow: "0 18px 55px rgba(31,62,94,0.18)",
  } satisfies React.CSSProperties,
  primaryButton: {
    width: "100%",
    padding: "14px 16px",
    marginTop: 10,
    borderRadius: 6,
    border: 0,
    background: "#1d6f42",
    color: "white",
    fontSize: 17,
    fontWeight: 800,
  } satisfies React.CSSProperties,
  button: {
    width: "100%",
    padding: "12px 16px",
    marginTop: 10,
    borderRadius: 6,
    border: "1px solid rgba(20,32,51,0.18)",
    background: "white",
    color: "#142033",
    fontSize: 16,
    fontWeight: 750,
  } satisfies React.CSSProperties,
  input: {
    width: "100%",
    boxSizing: "border-box",
    padding: "14px 16px",
    borderRadius: 6,
    border: "1px solid rgba(20,32,51,0.22)",
    fontSize: 24,
    fontWeight: 900,
    textTransform: "uppercase",
    letterSpacing: 0,
    textAlign: "center",
  } satisfies React.CSSProperties,
  error: {
    marginTop: 14,
    color: "#9b241f",
    fontSize: 14,
  } satisfies React.CSSProperties,
  note: {
    marginTop: 18,
    opacity: 0.65,
    fontSize: 13,
    lineHeight: 1.45,
  } satisfies React.CSSProperties,
};

const introStyles = {
  statBox: {
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "rgba(255,255,255,0.07)",
    padding: "10px 12px",
  } satisfies React.CSSProperties,
  statLabel: {
    fontSize: 11,
    opacity: 0.62,
    fontWeight: 800,
    textTransform: "uppercase",
  } satisfies React.CSSProperties,
  statValue: {
    marginTop: 4,
    fontSize: 22,
    fontWeight: 950,
  } satisfies React.CSSProperties,
  scoreboard: {
    marginTop: 18,
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.14)",
    overflow: "hidden",
  } satisfies React.CSSProperties,
  scoreHeader: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    padding: "10px 12px",
    background: "rgba(0,0,0,0.22)",
    fontSize: 13,
    fontWeight: 850,
  } satisfies React.CSSProperties,
  scoreGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr 1fr 1fr",
  } satisfies React.CSSProperties,
  scoreCellHead: {
    padding: "8px 10px",
    fontSize: 11,
    opacity: 0.65,
    fontWeight: 850,
    textTransform: "uppercase",
    borderTop: "1px solid rgba(255,255,255,0.08)",
  } satisfies React.CSSProperties,
  scoreCell: {
    padding: "8px 10px",
    borderTop: "1px solid rgba(255,255,255,0.08)",
    fontSize: 14,
    fontWeight: 800,
  } satisfies React.CSSProperties,
  scoreCellActive: {
    background: "rgba(99,212,113,0.16)",
    color: "#d7ffdd",
  } satisfies React.CSSProperties,
  startButton: {
    width: "100%",
    minHeight: 58,
    marginTop: 18,
    borderRadius: 8,
    border: 0,
    background: "#63d471",
    color: "#0d1b16",
    fontSize: 20,
    fontWeight: 950,
  } satisfies React.CSSProperties,
};

const controllerStyles = {
  shell: {
    height: "100dvh",
    background: "#101820",
    color: "white",
    fontFamily: "-apple-system, system-ui, sans-serif",
    padding: "8px 10px 6px",
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    gap: 6,
    overflow: "hidden",
    touchAction: "none",
  } satisfies React.CSSProperties,
  resultShell: {
    minHeight: "100%",
    background: "#101820",
    color: "white",
    fontFamily: "-apple-system, system-ui, sans-serif",
    padding: 18,
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    gap: 16,
    touchAction: "none",
  } satisfies React.CSSProperties,
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  } satisfies React.CSSProperties,
  resultHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 14,
  } satisfies React.CSSProperties,
  scorePill: {
    minWidth: 66,
    height: 54,
    display: "grid",
    placeItems: "center",
    borderRadius: 10,
    border: "2px solid #63d471",
    background: "rgba(255,255,255,0.05)",
    fontSize: 24,
    fontWeight: 950,
  } satisfies React.CSSProperties,
  traceCard: {
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.16)",
    background: "linear-gradient(180deg, rgba(45,66,85,0.78), rgba(18,28,38,0.88))",
    padding: 12,
    boxShadow: "0 18px 45px rgba(0,0,0,0.28)",
  } satisfies React.CSSProperties,
  traceSvg: {
    width: "100%",
    display: "block",
  } satisfies React.CSSProperties,
  traceCaption: {
    textAlign: "center",
    fontSize: 14,
    fontWeight: 800,
    opacity: 0.86,
    marginTop: 4,
  } satisfies React.CSSProperties,
  metricGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 12,
  } satisfies React.CSSProperties,
  metricBox: {
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "#182431",
    padding: 12,
  } satisfies React.CSSProperties,
  metricLabel: {
    fontSize: 12,
    opacity: 0.68,
    marginBottom: 4,
  } satisfies React.CSSProperties,
  metricValue: {
    fontSize: 26,
    fontWeight: 950,
    marginBottom: 10,
  } satisfies React.CSSProperties,
  resultMeter: {
    height: 10,
    borderRadius: 999,
    background: "rgba(255,255,255,0.12)",
    overflow: "hidden",
  } satisfies React.CSSProperties,
  resultMeterFill: {
    height: "100%",
    borderRadius: 999,
  } satisfies React.CSSProperties,
  continueButton: {
    minHeight: 72,
    borderRadius: 10,
    border: 0,
    background: "#63d471",
    color: "#0d1b16",
    fontSize: 24,
    fontWeight: 950,
    marginTop: "auto",
  } satisfies React.CSSProperties,
  row: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 8,
    flex: "0 0 auto",
  } satisfies React.CSSProperties,
  bigButton: {
    minHeight: 48,
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.14)",
    background: "#1f3f5c",
    color: "white",
    fontSize: 16,
    fontWeight: 850,
    padding: "6px 8px",
  } satisfies React.CSSProperties,
  smallButton: {
    minHeight: 36,
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.16)",
    background: "#263545",
    color: "white",
    fontSize: 13,
    fontWeight: 800,
    padding: "4px 8px",
  } satisfies React.CSSProperties,
  clubGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: 8,
  } satisfies React.CSSProperties,
  clubButton: {
    minHeight: 52,
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.16)",
    background: "#202c38",
    color: "white",
    fontSize: 14,
    fontWeight: 850,
  } satisfies React.CSSProperties,
  clubSelector: {
    display: "grid",
    gridTemplateColumns: "36px minmax(0, 1fr) 36px",
    alignItems: "stretch",
    gap: 6,
    touchAction: "pan-y",
    flex: "0 0 auto",
  } satisfies React.CSSProperties,
  clubArrow: {
    minHeight: 70,
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.16)",
    background: "#263545",
    color: "white",
    fontSize: 24,
    fontWeight: 900,
    lineHeight: 1,
    padding: 0,
  } satisfies React.CSSProperties,
  clubDisplay: {
    minHeight: 70,
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.18)",
    background: "linear-gradient(180deg, #243443, #17222d)",
    boxShadow: "0 6px 14px rgba(0,0,0,0.22)",
    overflow: "hidden",
    position: "relative",
    userSelect: "none",
  } satisfies React.CSSProperties,
  clubMeta: {
    position: "absolute",
    top: 6,
    left: 8,
    right: 8,
    zIndex: 1,
    display: "flex",
    alignItems: "center",
    gap: 8,
    pointerEvents: "none",
  } satisfies React.CSSProperties,
  clubShort: {
    width: 34,
    height: 34,
    borderRadius: 6,
    display: "grid",
    placeItems: "center",
    background: "#63d471",
    color: "#0d1b16",
    fontSize: 14,
    fontWeight: 950,
    flex: "0 0 auto",
  } satisfies React.CSSProperties,
  clubName: {
    fontSize: 14,
    fontWeight: 950,
    lineHeight: 1.05,
  } satisfies React.CSSProperties,
  clubCarry: {
    marginTop: 1,
    fontSize: 11,
    fontWeight: 800,
    color: "rgba(255,255,255,0.68)",
  } satisfies React.CSSProperties,
  clubPreviewSvg: {
    width: "100%",
    height: "100%",
    display: "block",
    paddingTop: 2,
    boxSizing: "border-box",
  } satisfies React.CSSProperties,
  clubDots: {
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    gap: 4,
    minHeight: 12,
    flex: "0 0 auto",
  } satisfies React.CSSProperties,
  clubDot: {
    height: 6,
    borderRadius: 999,
    border: 0,
    padding: 0,
    transition: "width 140ms ease, background 140ms ease",
  } satisfies React.CSSProperties,
  label: {
    display: "grid",
    gap: 6,
    fontSize: 12,
    opacity: 0.9,
  } satisfies React.CSSProperties,
  motionRow: {
    display: "flex",
    gap: 6,
    alignItems: "center",
    flex: "0 0 auto",
  } satisfies React.CSSProperties,
  fallbackLabel: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    fontSize: 10,
    opacity: 0.8,
  } satisfies React.CSSProperties,
  swingArea: {
    flex: "1 1 auto",
    display: "flex",
    flexDirection: "column",
    gap: 4,
    minHeight: 110,
  } satisfies React.CSSProperties,
  swingPair: {
    flex: 1,
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 8,
  } satisfies React.CSSProperties,
  fallbackReadyRow: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 8,
    flex: "0 0 auto",
  } satisfies React.CSSProperties,
  swingButton: {
    flex: 1,
    width: "100%",
    height: "100%",
    minHeight: 90,
    borderRadius: 12,
    border: 0,
    fontSize: 24,
    fontWeight: 950,
    whiteSpace: "pre-line",
    lineHeight: 1.05,
  } satisfies React.CSSProperties,
  cancelReady: {
    minHeight: 28,
    borderRadius: 6,
    border: "1px solid rgba(255,255,255,0.2)",
    background: "transparent",
    color: "rgba(255,255,255,0.75)",
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 1,
  } satisfies React.CSSProperties,
  status: {
    minHeight: 14,
    textAlign: "center",
    opacity: 0.7,
    fontSize: 11,
    flex: "0 0 auto",
  } satisfies React.CSSProperties,
  diag: {
    fontSize: 11,
    opacity: 0.7,
    textAlign: "center",
    fontVariantNumeric: "tabular-nums",
  } satisfies React.CSSProperties,
  diagWarn: {
    fontSize: 11,
    color: "#ffb13b",
    textAlign: "center",
    lineHeight: 1.3,
  } satisfies React.CSSProperties,
};
