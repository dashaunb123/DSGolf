import * as THREE from "three";

const yd = 0.9144;
export const GRAVITY = 9.81;

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
  /** putter rolls along the ground only */
  putter?: boolean;
};

export const CLUBS: Club[] = [
  { id: "driver",  name: "Driver",       short: "DR", carry: 240 * yd, loft: 0.22, bounce: 0.45 },
  { id: "3wood",   name: "3 Wood",       short: "3W", carry: 215 * yd, loft: 0.28, bounce: 0.38 },
  { id: "4hybrid", name: "4 Hybrid",     short: "4H", carry: 195 * yd, loft: 0.34, bounce: 0.34 },
  { id: "6iron",   name: "6 Iron",       short: "6i", carry: 165 * yd, loft: 0.46, bounce: 0.26 },
  { id: "8iron",   name: "8 Iron",       short: "8i", carry: 145 * yd, loft: 0.57, bounce: 0.21 },
  { id: "9iron",   name: "9 Iron",       short: "9i", carry: 130 * yd, loft: 0.65, bounce: 0.18 },
  { id: "wedge",   name: "Pitching Wedge", short: "PW", carry: 105 * yd, loft: 0.82, bounce: 0.12 },
  { id: "sand",    name: "Sand Wedge",   short: "SW", carry: 75 * yd,  loft: 0.98, bounce: 0.08 },
  { id: "lob58",   name: "58 Degree",    short: "58", carry: 62 * yd,  loft: 1.01, bounce: 0.07 },
  { id: "lob60",   name: "60 Degree",    short: "60", carry: 52 * yd,  loft: 1.05, bounce: 0.06 },
  { id: "lob62",   name: "62 Degree",    short: "62", carry: 43 * yd,  loft: 1.08, bounce: 0.05 },
  { id: "lob64",   name: "64 Degree",    short: "64", carry: 34 * yd,  loft: 1.12, bounce: 0.04 },
  { id: "putter",  name: "Putter",       short: "PT", carry: 14,       loft: 0,    bounce: 0, putter: true },
];

function loftHeightBias(loft: number) {
  const t = THREE.MathUtils.clamp((loft - 0.45) / (1.12 - 0.45), 0, 1);
  return 1 + Math.pow(t, 1.15) * 0.32;
}

export function clubInitialVelocity(club: Club, power: number, aimRad: number): THREE.Vector3 {
  const p = THREE.MathUtils.clamp(power, 0.05, 1);
  if (club.putter) {
    const speed = club.carry * p * 0.6;
    return new THREE.Vector3(Math.sin(aimRad) * speed, 0, -Math.cos(aimRad) * speed);
  }
  const sin2t = Math.sin(2 * club.loft);
  const vMax = Math.sqrt((club.carry * GRAVITY) / Math.max(sin2t, 0.05));
  const baseVy = vMax * Math.sin(club.loft);
  const heightBias = loftHeightBias(club.loft);
  const verticalSpeed = baseVy * heightBias * p;
  // Preserve the club's listed carry while giving higher-loft clubs a taller,
  // steeper flight: range = 2 * horizontalSpeed * verticalSpeed / gravity.
  const horizontalSpeed = (club.carry * GRAVITY) / Math.max(2 * baseVy * heightBias, 0.1) * p;
  return new THREE.Vector3(
    Math.sin(aimRad) * horizontalSpeed,
    verticalSpeed,
    -Math.cos(aimRad) * horizontalSpeed,
  );
}

/**
 * In-flight side acceleration coefficient. Side-acceleration is applied
 * perpendicular to the horizontal flight direction, proportional to
 * forward speed × shape (rad). Tuned so ±0.25 rad shape gives roughly
 * a 12–15 yard curve on a mid-iron.
 */
export const SHAPE_CURVE_COEFF = 0.32;

/** Simulate flight until first ground contact. Returns sampled points. */
export function simulateFlight(
  start: THREE.Vector3,
  vel0: THREE.Vector3,
  maxSteps = 80,
  dt = 0.06,
  shape = 0,
): THREE.Vector3[] {
  const out: THREE.Vector3[] = [start.clone()];
  const p = start.clone();
  const v = vel0.clone();
  for (let i = 0; i < maxSteps; i++) {
    v.y -= GRAVITY * dt;
    if (shape !== 0) {
      const horizSpeed = Math.hypot(v.x, v.z);
      if (horizSpeed > 0.1) {
        const fx = v.x / horizSpeed;
        const fz = v.z / horizSpeed;
        // "right of flight" in the horizontal plane (with -z as forward,
        // matching the world convention used everywhere else).
        const rx = -fz;
        const rz = fx;
        const sideAccel = shape * horizSpeed * SHAPE_CURVE_COEFF;
        v.x += rx * sideAccel * dt;
        v.z += rz * sideAccel * dt;
      }
    }
    p.addScaledVector(v, dt);
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
