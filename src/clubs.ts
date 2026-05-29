import * as THREE from "three";

const yd = 0.9144;
export const GRAVITY = 9.81;

// --- Real golf-ball aerodynamics -------------------------------------------
// Everything is SI (metres, kilograms, seconds). The world is modelled in
// metres, so a "240 yard" carry is ~219 m.
export const BALL_MASS = 0.0459; // kg
export const BALL_RADIUS = 0.0213; // m
const BALL_AREA = Math.PI * BALL_RADIUS * BALL_RADIUS;
export const AIR_DENSITY = 1.225; // kg/m^3
const DRAG_CD = 0.27;
/** Drag acceleration = DRAG_K * |vAir| * vAir (opposing the airflow). */
const DRAG_K = (0.5 * AIR_DENSITY * DRAG_CD * BALL_AREA) / BALL_MASS;
/** Lift acceleration magnitude = LIFT_BASE * Cl * |vAir|^2. */
const LIFT_BASE = (0.5 * AIR_DENSITY * BALL_AREA) / BALL_MASS;
/** Lift coefficient rises with the spin factor S = ωr/v, then saturates —
 *  this is what stops high-spin wedges from ballooning. */
const SPIN_LIFT_SLOPE = 1.6;
const CL_MAX = 0.3;
/** Backspin bleeds off in the air (~4% per second). */
const SPIN_DECAY = 0.04;
/** Fraction of a club's spin redirected into sidespin per radian of shape. */
const SIDE_SPIN_FRACTION = 0.6;

/**
 * Real launch angle is well below the club's face loft — a 56° wedge launches
 * around 32°, not 55° — because the shaft leans forward at impact. Without
 * this, lofted clubs fire nearly straight up and balloon.
 */
function launchAngleFor(loft: number): number {
  return Math.min(loft, 0.2 + loft * 0.42);
}

export type Club = {
  id: string;
  name: string;
  short: string;
  /** carry distance in meters at 100% power */
  carry: number;
  /** launch angle in radians */
  loft: number;
  /** bounce energy retained on first ground contact, 0..1 */
  bounce: number;
  /** backspin at impact, rev/min (drives lift + flight shape) */
  spinRpm: number;
  /** putter rolls along the ground only */
  putter?: boolean;
};

export const CLUBS: Club[] = [
  { id: "driver",  name: "Driver",        short: "DR", carry: 240 * yd, loft: 0.22, bounce: 0.45, spinRpm: 2500 },
  { id: "3wood",   name: "3 Wood",        short: "3W", carry: 215 * yd, loft: 0.27, bounce: 0.38, spinRpm: 3100 },
  { id: "5wood",   name: "5 Wood",        short: "5W", carry: 205 * yd, loft: 0.30, bounce: 0.36, spinRpm: 3500 },
  { id: "4hybrid", name: "4 Hybrid",      short: "4H", carry: 195 * yd, loft: 0.33, bounce: 0.34, spinRpm: 3900 },
  { id: "3iron",   name: "3 Iron",        short: "3i", carry: 186 * yd, loft: 0.35, bounce: 0.30, spinRpm: 4200 },
  { id: "4iron",   name: "4 Iron",        short: "4i", carry: 178 * yd, loft: 0.38, bounce: 0.28, spinRpm: 4600 },
  { id: "5iron",   name: "5 Iron",        short: "5i", carry: 170 * yd, loft: 0.41, bounce: 0.26, spinRpm: 5000 },
  { id: "6iron",   name: "6 Iron",        short: "6i", carry: 160 * yd, loft: 0.46, bounce: 0.24, spinRpm: 5600 },
  { id: "7iron",   name: "7 Iron",        short: "7i", carry: 150 * yd, loft: 0.51, bounce: 0.22, spinRpm: 6300 },
  { id: "8iron",   name: "8 Iron",        short: "8i", carry: 140 * yd, loft: 0.57, bounce: 0.20, spinRpm: 7100 },
  { id: "9iron",   name: "9 Iron",        short: "9i", carry: 128 * yd, loft: 0.65, bounce: 0.18, spinRpm: 7900 },
  { id: "wedge",   name: "Pitching Wedge", short: "PW", carry: 108 * yd, loft: 0.80, bounce: 0.13, spinRpm: 8700 },
  { id: "gap",     name: "Gap Wedge",     short: "GW", carry: 92 * yd,  loft: 0.88, bounce: 0.10, spinRpm: 9300 },
  { id: "sand",    name: "Sand Wedge",    short: "SW", carry: 76 * yd,  loft: 0.96, bounce: 0.08, spinRpm: 9900 },
  { id: "lob58",   name: "58 Degree",     short: "58", carry: 62 * yd,  loft: 1.01, bounce: 0.07, spinRpm: 10300 },
  { id: "lob60",   name: "60 Degree",     short: "60", carry: 52 * yd,  loft: 1.05, bounce: 0.06, spinRpm: 10600 },
  { id: "lob62",   name: "62 Degree",     short: "62", carry: 43 * yd,  loft: 1.08, bounce: 0.05, spinRpm: 10800 },
  { id: "lob64",   name: "64 Degree",     short: "64", carry: 34 * yd,  loft: 1.12, bounce: 0.04, spinRpm: 11000 },
  { id: "putter",  name: "Putter",        short: "PT", carry: 14,       loft: 0,    bounce: 0,    spinRpm: 0, putter: true },
];

const ZERO_WIND = new THREE.Vector3();

/**
 * Advance one ball through a single aerodynamic timestep, in place.
 * Applies gravity, quadratic drag against the relative airflow, and the
 * Magnus force from the (decaying) spin vector. Wind is a horizontal air
 * velocity in m/s. This is the single source of truth for ball flight — both
 * the live shot and the aim preview run through it, so they always agree.
 */
export function aeroStep(
  pos: THREE.Vector3,
  vel: THREE.Vector3,
  spin: THREE.Vector3,
  wind: THREE.Vector3,
  dt: number,
) {
  const ax = vel.x - wind.x;
  const ay = vel.y - wind.y;
  const az = vel.z - wind.z;
  const airSpeed = Math.hypot(ax, ay, az);

  vel.y -= GRAVITY * dt;

  if (airSpeed > 1e-4) {
    const dragMag = DRAG_K * airSpeed * dt;
    vel.x -= ax * dragMag;
    vel.y -= ay * dragMag;
    vel.z -= az * dragMag;

    // Magnus / lift: direction = unit(spin × vAir), magnitude from a
    // spin-factor lift coefficient that saturates at high spin.
    const omega = Math.hypot(spin.x, spin.y, spin.z);
    if (omega > 1e-4) {
      const spinFactor = (omega * BALL_RADIUS) / airSpeed;
      const cl = Math.min(CL_MAX, SPIN_LIFT_SLOPE * spinFactor);
      const mx = spin.y * az - spin.z * ay;
      const my = spin.z * ax - spin.x * az;
      const mz = spin.x * ay - spin.y * ax;
      const ml = Math.hypot(mx, my, mz);
      if (ml > 1e-4) {
        const a = (LIFT_BASE * cl * airSpeed * airSpeed * dt) / ml;
        vel.x += mx * a;
        vel.y += my * a;
        vel.z += mz * a;
      }
    }
  }

  if (SPIN_DECAY > 0) spin.multiplyScalar(Math.max(0, 1 - SPIN_DECAY * dt));
  pos.addScaledVector(vel, dt);
}

/** Backspin (+ optional sidespin from shape) angular-velocity vector, rad/s. */
export function clubSpinVector(club: Club, aimRad: number, shape = 0): THREE.Vector3 {
  if (club.putter) return new THREE.Vector3();
  const omega = (club.spinRpm * 2 * Math.PI) / 60;
  // "right of flight" horizontal unit (matches the world's -z forward).
  const rx = Math.cos(aimRad);
  const rz = Math.sin(aimRad);
  // Backspin about the right axis produces lift via spin × vAir.
  const spin = new THREE.Vector3(rx * omega, 0, rz * omega);
  // Sidespin about the vertical axis curves the ball (shape > 0 == fade right).
  spin.y += -shape * omega * SIDE_SPIN_FRACTION;
  return spin;
}

/** Carry (m) to first ground contact for a launch speed, under full aero. */
function simulateCarry(club: Club, speed: number): number {
  const spin = clubSpinVector(club, 0, 0);
  const la = launchAngleFor(club.loft);
  const vel = new THREE.Vector3(0, Math.sin(la) * speed, -Math.cos(la) * speed);
  const pos = new THREE.Vector3(0, 0.06, 0);
  const dt = 0.02;
  for (let i = 0; i < 600; i++) {
    aeroStep(pos, vel, spin, ZERO_WIND, dt);
    if (pos.y <= 0.06) break;
  }
  return Math.hypot(pos.x, pos.z);
}

const speedCache = new Map<string, number>();

/** Binary-search the launch speed that carries the ball `targetCarry` metres. */
function solveLaunchSpeed(club: Club, targetCarry: number): number {
  const key = `${club.loft.toFixed(3)}|${club.spinRpm}|${targetCarry.toFixed(1)}`;
  const cached = speedCache.get(key);
  if (cached !== undefined) return cached;
  let lo = 2;
  let hi = 130;
  for (let i = 0; i < 26; i++) {
    const mid = (lo + hi) / 2;
    if (simulateCarry(club, mid) < targetCarry) lo = mid;
    else hi = mid;
  }
  const speed = (lo + hi) / 2;
  speedCache.set(key, speed);
  return speed;
}

export function clubInitialVelocity(club: Club, power: number, aimRad: number): THREE.Vector3 {
  const p = THREE.MathUtils.clamp(power, 0.05, 1);
  if (club.putter) {
    const speed = club.carry * p * 0.6;
    return new THREE.Vector3(Math.sin(aimRad) * speed, 0, -Math.cos(aimRad) * speed);
  }
  // Power maps linearly to carry: pulling back to 50% flies ~50% of the way.
  // The launch speed needed for that carry is solved against the real
  // aerodynamic flight, so distance stays honest under drag + lift.
  const speed = solveLaunchSpeed(club, club.carry * p);
  const la = launchAngleFor(club.loft);
  const horizontal = Math.cos(la) * speed;
  const vertical = Math.sin(la) * speed;
  return new THREE.Vector3(
    Math.sin(aimRad) * horizontal,
    vertical,
    -Math.cos(aimRad) * horizontal,
  );
}

/** Simulate flight until first ground contact. Returns sampled points. */
export function simulateFlight(
  start: THREE.Vector3,
  vel0: THREE.Vector3,
  opts: { spin?: THREE.Vector3; wind?: THREE.Vector3; maxSteps?: number; dt?: number } = {},
): THREE.Vector3[] {
  const dt = opts.dt ?? 0.05;
  const maxSteps = opts.maxSteps ?? 240;
  const wind = opts.wind ?? ZERO_WIND;
  const spin = (opts.spin ? opts.spin.clone() : new THREE.Vector3());
  const out: THREE.Vector3[] = [start.clone()];
  const p = start.clone();
  const v = vel0.clone();
  for (let i = 0; i < maxSteps; i++) {
    aeroStep(p, v, spin, wind, dt);
    if (p.y < 0.06) {
      p.y = 0.06;
      out.push(p.clone());
      break;
    }
    out.push(p.clone());
  }
  return out;
}

export function suggestClub(distanceMeters: number, onGreen: boolean): number {
  if (onGreen) return CLUBS.findIndex((c) => c.putter);
  const ranked = CLUBS.map((c, i) => ({ c, i }))
    .filter(({ c }) => !c.putter && c.carry >= distanceMeters * 0.92)
    .sort((a, b) => a.c.carry - b.c.carry);
  if (ranked.length > 0) return ranked[0].i;
  return CLUBS.findIndex((c) => c.id === "driver");
}
