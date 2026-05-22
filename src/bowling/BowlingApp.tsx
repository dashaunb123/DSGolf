import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Sky } from "@react-three/drei";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

/**
 * Bowling — 10 frames, classic scoring.
 *
 * Coordinates: foul line at z=0, headpin at z=-LANE_LEN+1, ball starts at z=+1.
 * Negative z = down the lane. Positive x = right.
 *
 * Physics is intentionally lightweight: ball is a single dynamic body with
 * friction; pins are dynamic on the XZ plane only (with a fall-over visual).
 * Pin-pin and ball-pin collisions are elastic-ish impulses, run at the
 * useFrame tick. It's not Bullet, but it gives a believable spread.
 */

const LANE_LEN = 18;
const LANE_HALF_W = 0.55;
const PIN_RADIUS = 0.06;
const PIN_HEIGHT = 0.38;
const BALL_RADIUS = 0.108;
const HEAD_PIN_Z = -LANE_LEN + 1.2;
const PIN_SPACING = 0.305;

// Pin positions: standard 4-row triangle, headpin at (0, HEAD_PIN_Z).
function defaultPinLayout(): Array<{ x: number; z: number }> {
  const rowDz = PIN_SPACING * Math.sqrt(3) / 2; // row spacing
  const out: Array<{ x: number; z: number }> = [];
  for (let row = 0; row < 4; row++) {
    const count = row + 1;
    const xOffset = -((count - 1) * PIN_SPACING) / 2;
    for (let i = 0; i < count; i++) {
      out.push({
        x: xOffset + i * PIN_SPACING,
        z: HEAD_PIN_Z - row * rowDz,
      });
    }
  }
  return out;
}

type PinState = {
  pos: THREE.Vector3;       // x,z used; y stays 0 (base on lane)
  vel: THREE.Vector3;
  standing: boolean;
  fallProgress: number;     // 0..1 for tip-over animation
  fallAxis: THREE.Vector3;  // unit vector pin tips about (x-z plane)
  home: { x: number; z: number };
};

type BallState = {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  mode: "idle" | "rolling" | "dead";
  spawnedAt: number;
};

type Roll = number; // pins knocked on this roll

type FrameScore = {
  rolls: Roll[];
  score: number | null;
};

const FRAMES = 10;

function makeEmptyFrames(): FrameScore[] {
  return Array.from({ length: FRAMES }, () => ({ rolls: [], score: null }));
}

function makeInitialPins(): PinState[] {
  return defaultPinLayout().map((p) => ({
    pos: new THREE.Vector3(p.x, 0, p.z),
    vel: new THREE.Vector3(),
    standing: true,
    fallProgress: 0,
    fallAxis: new THREE.Vector3(1, 0, 0),
    home: { ...p },
  }));
}

function computeScores(frames: FrameScore[]): FrameScore[] {
  // Flatten rolls in throw order to compute strike/spare bonuses cleanly.
  // For frames 0..8, each entry is rolls of that frame (1 if strike, else up to 2).
  // For frame 9, up to 3 rolls.
  const flat: number[] = [];
  const frameStarts: number[] = [];
  frames.forEach((f, idx) => {
    frameStarts[idx] = flat.length;
    f.rolls.forEach((r) => flat.push(r));
  });

  let running = 0;
  const out = frames.map((f) => ({ ...f, score: null as number | null }));

  for (let i = 0; i < FRAMES; i++) {
    const f = frames[i];
    const startIdx = frameStarts[i];
    if (i < 9) {
      const isStrike = f.rolls[0] === 10;
      const isSpare = !isStrike && f.rolls.length >= 2 && f.rolls[0] + f.rolls[1] === 10;
      if (isStrike) {
        const b1 = flat[startIdx + 1];
        const b2 = flat[startIdx + 2];
        if (b1 == null || b2 == null) return out; // pending bonus
        running += 10 + b1 + b2;
      } else if (isSpare) {
        const b1 = flat[startIdx + 2];
        if (b1 == null) return out;
        running += 10 + b1;
      } else {
        if (f.rolls.length < 2) return out;
        running += f.rolls[0] + f.rolls[1];
      }
      out[i].score = running;
    } else {
      // 10th frame
      if (f.rolls.length < 2) return out;
      const sum = f.rolls.reduce((s, r) => s + r, 0);
      const earnsThird =
        f.rolls[0] === 10 || (f.rolls[0] + (f.rolls[1] ?? 0) === 10);
      if (earnsThird && f.rolls.length < 3) return out;
      running += sum;
      out[i].score = running;
    }
  }

  return out;
}

function rollGlyph(rolls: Roll[], frameIdx: number, slot: number): string {
  const r = rolls[slot];
  if (r == null) return "";
  if (frameIdx < 9) {
    if (slot === 0 && r === 10) return "X";
    if (slot === 1 && rolls[0] + r === 10) return "/";
    if (r === 0) return "−";
    return String(r);
  }
  // 10th frame
  if (r === 10) return "X";
  if (slot > 0 && rolls[slot - 1] !== 10 && rolls[slot - 1] + r === 10) return "/";
  if (r === 0) return "−";
  return String(r);
}

function maxPinsForNextRoll(
  frame: FrameScore,
  frameIdx: number,
  standingCount: number,
): number {
  if (frameIdx < 9) return standingCount;
  // 10th frame logic — pins reset after a strike or a spare.
  return standingCount;
}

export function BowlingApp({ onExitToMenu }: { onExitToMenu: () => void }) {
  const [frames, setFrames] = useState<FrameScore[]>(() => makeEmptyFrames());
  const [frameIdx, setFrameIdx] = useState(0);
  const [gameOver, setGameOver] = useState(false);
  const [message, setMessage] = useState("Frame 1 · Roll 1");
  const [hud, setHud] = useState({ aim: 0, power: 0, charging: false, ballMode: "idle" as BallState["mode"] });

  // Refs that the Game (Canvas) interacts with via mutation.
  const aimRef = useRef(0);              // -0.35 .. 0.35 radians
  const powerHoldStartRef = useRef<number | null>(null);
  const pendingThrowRef = useRef<{ power: number; aim: number } | null>(null);
  const resetTickRef = useRef(0);
  const settleCallbackRef = useRef<((pinsDown: number) => void) | null>(null);

  // Keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.code === "Escape") {
        onExitToMenu();
        return;
      }
      if (e.code === "KeyR") {
        // Full game reset
        setFrames(makeEmptyFrames());
        setFrameIdx(0);
        setGameOver(false);
        setMessage("Frame 1 · Roll 1");
        resetTickRef.current += 1;
        return;
      }
      if (gameOver) return;
      if (e.code === "ArrowLeft" || e.code === "KeyA") {
        aimRef.current = THREE.MathUtils.clamp(aimRef.current - 0.04, -0.45, 0.45);
        setHud((s) => ({ ...s, aim: aimRef.current }));
      } else if (e.code === "ArrowRight" || e.code === "KeyD") {
        aimRef.current = THREE.MathUtils.clamp(aimRef.current + 0.04, -0.45, 0.45);
        setHud((s) => ({ ...s, aim: aimRef.current }));
      } else if (e.code === "Space") {
        if (hud.ballMode === "idle" && powerHoldStartRef.current == null) {
          powerHoldStartRef.current = performance.now();
          setHud((s) => ({ ...s, charging: true }));
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space" && powerHoldStartRef.current != null) {
        const elapsed = (performance.now() - powerHoldStartRef.current) / 1000;
        const power = THREE.MathUtils.clamp(elapsed / 1.4, 0.15, 1);
        pendingThrowRef.current = { power, aim: aimRef.current };
        powerHoldStartRef.current = null;
        setHud((s) => ({ ...s, charging: false, power }));
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [onExitToMenu, gameOver, hud.ballMode]);

  // Charging anim power readout
  useEffect(() => {
    if (!hud.charging) return;
    let raf = 0;
    const tick = () => {
      if (powerHoldStartRef.current != null) {
        const elapsed = (performance.now() - powerHoldStartRef.current) / 1000;
        const p = THREE.MathUtils.clamp(elapsed / 1.4, 0, 1);
        setHud((s) => ({ ...s, power: p }));
        raf = requestAnimationFrame(tick);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hud.charging]);

  // When a roll ends, the Game calls settleCallbackRef with number of pins knocked this roll.
  settleCallbackRef.current = (pinsDown: number) => {
    if (gameOver) return;
    setFrames((prevFrames) => {
      const next = prevFrames.map((f) => ({ ...f, rolls: [...f.rolls] }));
      const f = next[frameIdx];
      f.rolls.push(pinsDown);
      const scored = computeScores(next);

      // Decide if frame ends.
      let advance = false;
      let resetPins = false;
      if (frameIdx < 9) {
        if (f.rolls[0] === 10 || f.rolls.length === 2) {
          advance = true;
          resetPins = true;
        } else {
          // Continue same frame, do NOT reset pins.
          resetPins = false;
        }
      } else {
        // 10th frame
        const r1 = f.rolls[0];
        const r2 = f.rolls[1];
        const r3 = f.rolls[2];
        if (r1 === 10) {
          // first was strike: reset for roll 2, keep going up to 3 rolls
          if (f.rolls.length === 1) resetPins = true;
          else if (f.rolls.length === 2 && r2 === 10) resetPins = true;
          else if (f.rolls.length === 2) resetPins = false; // spare-like continuation
          if (f.rolls.length === 3) advance = true;
        } else if (f.rolls.length === 2) {
          if (r1 + r2 === 10) {
            resetPins = true; // spare → bonus roll on fresh rack
          } else {
            advance = true;
          }
        } else if (f.rolls.length === 3) {
          advance = true;
        }
      }

      if (advance) {
        if (frameIdx + 1 >= FRAMES) {
          setGameOver(true);
          setMessage("Game over · press R to play again");
        } else {
          setFrameIdx((i) => i + 1);
          setMessage(`Frame ${frameIdx + 2} · Roll 1`);
        }
      } else {
        setMessage(`Frame ${frameIdx + 1} · Roll ${f.rolls.length + 1}`);
      }

      // Hand reset-pins decision to the Game via a ref signal.
      pendingResetPinsRef.current = resetPins ? resetTickRef.current + 1 : null;
      if (resetPins) resetTickRef.current += 1;

      return scored;
    });
  };

  const pendingResetPinsRef = useRef<number | null>(null);

  return (
    <div style={{ position: "absolute", inset: 0, background: "#0a1d3a" }}>
      <Canvas shadows camera={{ position: [0, 1.4, 3], fov: 55 }}>
        <BowlingScene
          aimRef={aimRef}
          pendingThrowRef={pendingThrowRef}
          resetTickRef={resetTickRef}
          pendingResetPinsRef={pendingResetPinsRef}
          onBallModeChange={(m) => setHud((s) => ({ ...s, ballMode: m }))}
          onRollSettled={(n) => settleCallbackRef.current?.(n)}
        />
      </Canvas>

      <BowlingHud
        frames={frames}
        frameIdx={frameIdx}
        gameOver={gameOver}
        message={message}
        aim={hud.aim}
        power={hud.power}
        charging={hud.charging}
        ballMode={hud.ballMode}
      />

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
    </div>
  );
}

function BowlingScene({
  aimRef,
  pendingThrowRef,
  resetTickRef,
  pendingResetPinsRef,
  onBallModeChange,
  onRollSettled,
}: {
  aimRef: React.MutableRefObject<number>;
  pendingThrowRef: React.MutableRefObject<{ power: number; aim: number } | null>;
  resetTickRef: React.MutableRefObject<number>;
  pendingResetPinsRef: React.MutableRefObject<number | null>;
  onBallModeChange: (m: BallState["mode"]) => void;
  onRollSettled: (pinsKnocked: number) => void;
}) {
  const pinsRef = useRef<PinState[]>(makeInitialPins());
  const standingAtRollStartRef = useRef<boolean[]>(pinsRef.current.map(() => true));
  const ballRef = useRef<BallState>({
    pos: new THREE.Vector3(0, BALL_RADIUS, 1.5),
    vel: new THREE.Vector3(),
    mode: "idle",
    spawnedAt: 0,
  });
  const ballModeRef = useRef<BallState["mode"]>("idle");
  const settleTimerRef = useRef(0);
  const lastResetTickRef = useRef(resetTickRef.current);
  const lastPinsResetTickRef = useRef<number | null>(null);

  const ballMesh = useRef<THREE.Mesh>(null!);
  const pinGroupRefs = useRef<Array<THREE.Group | null>>([]);
  const { camera } = useThree();

  const respawnBall = () => {
    const b = ballRef.current;
    b.pos.set(aimRef.current * 0.3, BALL_RADIUS, 1.5);
    b.vel.set(0, 0, 0);
    b.mode = "idle";
    ballModeRef.current = "idle";
    onBallModeChange("idle");
  };

  const resetAllPins = () => {
    pinsRef.current = makeInitialPins();
    standingAtRollStartRef.current = pinsRef.current.map(() => true);
  };

  useEffect(() => {
    respawnBall();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useFrame((_, dtRaw) => {
    const dt = Math.min(dtRaw, 1 / 30);
    const b = ballRef.current;
    const pins = pinsRef.current;

    // Full-game reset
    if (resetTickRef.current !== lastResetTickRef.current) {
      lastResetTickRef.current = resetTickRef.current;
      resetAllPins();
      respawnBall();
    }

    // Pins-only reset (between frames or after strike in 10th)
    if (
      pendingResetPinsRef.current != null &&
      pendingResetPinsRef.current !== lastPinsResetTickRef.current
    ) {
      lastPinsResetTickRef.current = pendingResetPinsRef.current;
      resetAllPins();
    }

    // Idle: keep ball at start, follow aim laterally.
    if (b.mode === "idle") {
      b.pos.x = aimRef.current * 0.3;
      // Camera follows the ball area.
      const target = new THREE.Vector3(b.pos.x * 0.5, 1.2, b.pos.z + 1.8);
      camera.position.lerp(target, 0.2);
      camera.lookAt(0, 0.3, HEAD_PIN_Z);

      const pending = pendingThrowRef.current;
      if (pending) {
        pendingThrowRef.current = null;
        const speed = THREE.MathUtils.lerp(7, 14, pending.power); // m/s
        const dir = new THREE.Vector3(Math.sin(pending.aim), 0, -Math.cos(pending.aim));
        b.vel.copy(dir).multiplyScalar(speed);
        b.mode = "rolling";
        b.spawnedAt = performance.now();
        ballModeRef.current = "rolling";
        onBallModeChange("rolling");
        // Snapshot which pins were standing when this roll started.
        standingAtRollStartRef.current = pins.map((p) => p.standing);
        settleTimerRef.current = 0;
      }
      return;
    }

    if (b.mode === "rolling") {
      // Friction on ball (lane is fast)
      const ballFriction = 1.2;
      const sp = b.vel.length();
      if (sp > 0.001) {
        const decel = Math.min(sp, ballFriction * dt);
        b.vel.multiplyScalar((sp - decel) / sp);
      }
      b.pos.addScaledVector(b.vel, dt);

      // Gutter check — once past 0.6m beyond foul line so pre-throw nudges don't trigger.
      if (b.pos.z < -0.5 && Math.abs(b.pos.x) > LANE_HALF_W) {
        // ride the gutter quietly to the end
        b.vel.x = 0;
        b.pos.x = Math.sign(b.pos.x) * (LANE_HALF_W + 0.12);
        if (b.pos.z < -LANE_LEN - 0.5) {
          b.mode = "dead";
        }
      }

      // Ball-pin collisions
      for (const pin of pins) {
        if (!pin.standing) continue;
        const dx = b.pos.x - pin.pos.x;
        const dz = b.pos.z - pin.pos.z;
        const d2 = dx * dx + dz * dz;
        const rsum = BALL_RADIUS + PIN_RADIUS;
        if (d2 < rsum * rsum) {
          const d = Math.sqrt(d2) || 0.0001;
          const nx = dx / d;
          const nz = dz / d;
          // separate
          const overlap = rsum - d;
          pin.pos.x -= nx * overlap;
          pin.pos.z -= nz * overlap;
          // pin gets pushed in direction opposite to normal (away from ball)
          const vAlong = b.vel.x * nx + b.vel.z * nz;
          if (vAlong < 0) {
            const transfer = -vAlong * 1.8; // ball is heavier than pin → transfer
            pin.vel.x += -nx * transfer + (Math.random() - 0.5) * 0.6;
            pin.vel.z += -nz * transfer + (Math.random() - 0.5) * 0.6;
            pin.standing = false;
            pin.fallAxis.set(-nz, 0, nx).normalize(); // tip axis perpendicular to hit direction
            // ball loses some energy
            b.vel.x -= -nx * 0.05;
            b.vel.z -= -nz * 0.05;
          }
        }
      }

      // Ball past pins or stopped → start settling
      if (b.pos.z < HEAD_PIN_Z - 2 || b.vel.length() < 0.15) {
        b.mode = "dead";
        ballModeRef.current = "dead";
        onBallModeChange("dead");
      }
    }

    // Pin physics (run regardless once anything moving)
    for (const pin of pins) {
      if (pin.vel.lengthSq() > 0.0001) {
        // friction
        const sp = pin.vel.length();
        const decel = Math.min(sp, 3.5 * dt);
        pin.vel.multiplyScalar((sp - decel) / sp);
        pin.pos.addScaledVector(pin.vel, dt);
      }
      if (!pin.standing && pin.fallProgress < 1) {
        pin.fallProgress = Math.min(1, pin.fallProgress + dt * 4.5);
      }
    }

    // Pin-pin collisions (knocked pins → standing pins)
    for (let i = 0; i < pins.length; i++) {
      const pi = pins[i];
      if (pi.vel.lengthSq() < 0.05) continue;
      for (let j = 0; j < pins.length; j++) {
        if (i === j) continue;
        const pj = pins[j];
        const dx = pj.pos.x - pi.pos.x;
        const dz = pj.pos.z - pi.pos.z;
        const d2 = dx * dx + dz * dz;
        const rsum = PIN_RADIUS * 2.4; // forgiving collision radius
        if (d2 < rsum * rsum) {
          const d = Math.sqrt(d2) || 0.0001;
          const nx = dx / d;
          const nz = dz / d;
          const vAlong = pi.vel.x * nx + pi.vel.z * nz;
          if (vAlong > 0) {
            const give = vAlong * 0.7;
            if (pj.standing) {
              pj.standing = false;
              pj.fallAxis.set(-nz, 0, nx).normalize();
            }
            pj.vel.x += nx * give;
            pj.vel.z += nz * give;
            pi.vel.x -= nx * give * 0.4;
            pi.vel.z -= nz * give * 0.4;
          }
        }
      }
    }

    // Camera while rolling — track ball
    if (b.mode === "rolling" || b.mode === "dead") {
      const target = new THREE.Vector3(b.pos.x * 0.6, 1.3, b.pos.z + 2.2);
      camera.position.lerp(target, 0.06);
      camera.lookAt(b.pos.x, 0.3, HEAD_PIN_Z);
    }

    // Settle
    if (b.mode === "dead") {
      const anyPinMoving = pins.some((p) => p.vel.lengthSq() > 0.02);
      const anyFalling = pins.some((p) => !p.standing && p.fallProgress < 1);
      if (!anyPinMoving && !anyFalling) {
        settleTimerRef.current += dt;
        if (settleTimerRef.current > 0.6) {
          // Compute pins knocked this roll: standing at start minus standing now,
          // restricted to those that were standing at start.
          const before = standingAtRollStartRef.current;
          let knocked = 0;
          pins.forEach((p, idx) => {
            if (before[idx] && !p.standing) knocked++;
          });
          settleTimerRef.current = 0;
          onRollSettled(knocked);
          // The HUD logic may set pendingResetPinsRef; respawn ball next frame.
          respawnBall();
        }
      }
    }

    // Apply pin transforms
    pins.forEach((pin, idx) => {
      const g = pinGroupRefs.current[idx];
      if (!g) return;
      g.position.set(pin.pos.x, 0, pin.pos.z);
      if (pin.standing) {
        g.rotation.set(0, 0, 0);
      } else {
        const angle = (Math.PI / 2) * pin.fallProgress;
        // Rotate around fallAxis (xz vector)
        const axis = pin.fallAxis;
        g.quaternion.setFromAxisAngle(new THREE.Vector3(axis.x, 0, axis.z), angle);
      }
    });

    // Apply ball transform
    if (ballMesh.current) {
      ballMesh.current.position.copy(b.pos);
      // rolling spin
      if (b.mode === "rolling") {
        const dist = b.vel.length() * dt;
        ballMesh.current.rotateX(-dist / BALL_RADIUS);
      }
    }
  });

  return (
    <group>
      <ambientLight intensity={0.6} />
      <directionalLight
        position={[6, 12, 6]}
        intensity={1.2}
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
      />
      <Sky sunPosition={[6, 12, 6]} turbidity={2} rayleigh={0.5} />
      <fog attach="fog" args={["#1a1f2a", 20, 60]} />

      {/* Bowling alley room floor */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, -LANE_LEN / 2]} receiveShadow>
        <planeGeometry args={[40, LANE_LEN + 20]} />
        <meshStandardMaterial color="#252a35" />
      </mesh>

      {/* Lane plank */}
      <mesh position={[0, 0, -LANE_LEN / 2 + 0.5]} receiveShadow>
        <boxGeometry args={[LANE_HALF_W * 2, 0.04, LANE_LEN]} />
        <meshStandardMaterial color="#caa46e" />
      </mesh>
      {/* Lane wood strips for depth */}
      {Array.from({ length: 12 }).map((_, i) => (
        <mesh
          key={`strip-${i}`}
          position={[
            -LANE_HALF_W + ((i + 0.5) * (LANE_HALF_W * 2)) / 12,
            0.022,
            -LANE_LEN / 2 + 0.5,
          ]}
        >
          <boxGeometry args={[0.01, 0.002, LANE_LEN]} />
          <meshStandardMaterial color="#8a6a3b" />
        </mesh>
      ))}

      {/* Gutters */}
      <mesh position={[-LANE_HALF_W - 0.15, -0.04, -LANE_LEN / 2 + 0.5]} receiveShadow>
        <boxGeometry args={[0.22, 0.06, LANE_LEN]} />
        <meshStandardMaterial color="#1d242f" />
      </mesh>
      <mesh position={[LANE_HALF_W + 0.15, -0.04, -LANE_LEN / 2 + 0.5]} receiveShadow>
        <boxGeometry args={[0.22, 0.06, LANE_LEN]} />
        <meshStandardMaterial color="#1d242f" />
      </mesh>

      {/* Foul line */}
      <mesh position={[0, 0.025, 0]}>
        <boxGeometry args={[LANE_HALF_W * 2, 0.001, 0.04]} />
        <meshStandardMaterial color="#b91d2d" emissive="#b91d2d" emissiveIntensity={0.3} />
      </mesh>

      {/* Aim arrows on lane */}
      {[-0.3, -0.1, 0.1, 0.3].map((x, i) => (
        <mesh key={`arrow-${i}`} position={[x, 0.024, -3]} rotation={[-Math.PI / 2, 0, 0]}>
          <coneGeometry args={[0.05, 0.18, 3]} />
          <meshStandardMaterial color="#5a3a1c" />
        </mesh>
      ))}

      {/* Pin deck (slightly different color) */}
      <mesh position={[0, 0.026, HEAD_PIN_Z - 0.4]} receiveShadow>
        <boxGeometry args={[LANE_HALF_W * 2 + 0.05, 0.001, 1.6]} />
        <meshStandardMaterial color="#e7d3a1" />
      </mesh>

      {/* Back wall */}
      <mesh position={[0, 1.2, -LANE_LEN - 0.4]}>
        <boxGeometry args={[6, 2.4, 0.1]} />
        <meshStandardMaterial color="#1a1f2a" />
      </mesh>

      {/* Pins */}
      {pinsRef.current.map((pin, idx) => (
        <group
          key={`pin-${idx}`}
          ref={(g) => (pinGroupRefs.current[idx] = g)}
          position={[pin.pos.x, 0, pin.pos.z]}
        >
          <PinMesh />
        </group>
      ))}

      {/* Ball */}
      <mesh ref={ballMesh} castShadow position={[0, BALL_RADIUS, 1.5]}>
        <sphereGeometry args={[BALL_RADIUS, 24, 24]} />
        <meshStandardMaterial color="#1c1c1c" metalness={0.3} roughness={0.35} />
      </mesh>
    </group>
  );
}

function PinMesh() {
  return (
    <group>
      <mesh castShadow position={[0, PIN_HEIGHT * 0.5, 0]}>
        <cylinderGeometry args={[PIN_RADIUS, PIN_RADIUS * 0.8, PIN_HEIGHT, 16]} />
        <meshStandardMaterial color="#ffffff" />
      </mesh>
      <mesh castShadow position={[0, PIN_HEIGHT - 0.02, 0]}>
        <sphereGeometry args={[PIN_RADIUS * 0.78, 16, 16]} />
        <meshStandardMaterial color="#ffffff" />
      </mesh>
      {/* red neck stripe */}
      <mesh position={[0, PIN_HEIGHT - 0.08, 0]}>
        <cylinderGeometry args={[PIN_RADIUS * 0.85, PIN_RADIUS * 0.85, 0.02, 16]} />
        <meshStandardMaterial color="#b91d2d" />
      </mesh>
    </group>
  );
}

function BowlingHud({
  frames,
  frameIdx,
  gameOver,
  message,
  aim,
  power,
  charging,
  ballMode,
}: {
  frames: FrameScore[];
  frameIdx: number;
  gameOver: boolean;
  message: string;
  aim: number;
  power: number;
  charging: boolean;
  ballMode: BallState["mode"];
}) {
  const total = frames[FRAMES - 1].score ?? (frames.find((f) => f.score == null && frameIdx > 0)?.score ?? frames.filter((f) => f.score != null).slice(-1)[0]?.score ?? 0);

  const powerColor = power > 0.92 ? "#ff4040" : power > 0.7 ? "#ffb13b" : "#5fd35f";

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        color: "white",
        fontFamily: "-apple-system, system-ui, sans-serif",
        userSelect: "none",
        textShadow: "0 1px 2px rgba(0,0,0,0.7)",
      }}
    >
      {/* Scoreboard top */}
      <div
        style={{
          position: "absolute",
          top: 10,
          left: "50%",
          transform: "translateX(-50%)",
          background: "rgba(11,18,30,0.78)",
          border: "1px solid rgba(255,255,255,0.18)",
          borderRadius: 10,
          padding: "6px 10px",
          display: "flex",
          gap: 4,
          alignItems: "stretch",
        }}
      >
        {frames.map((f, i) => {
          const active = i === frameIdx && !gameOver;
          const slots = i < 9 ? 2 : 3;
          return (
            <div
              key={i}
              style={{
                minWidth: i < 9 ? 44 : 60,
                border: `1px solid ${active ? "#ffd23b" : "rgba(255,255,255,0.2)"}`,
                borderRadius: 6,
                background: active ? "rgba(255,210,59,0.10)" : "rgba(255,255,255,0.04)",
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
              }}
            >
              <div style={{ display: "flex", borderBottom: "1px solid rgba(255,255,255,0.12)" }}>
                {Array.from({ length: slots }).map((_, slot) => (
                  <div
                    key={slot}
                    style={{
                      flex: 1,
                      textAlign: "center",
                      fontSize: 13,
                      fontWeight: 800,
                      padding: "2px 0",
                      borderLeft: slot > 0 ? "1px solid rgba(255,255,255,0.12)" : "none",
                    }}
                  >
                    {rollGlyph(f.rolls, i, slot) || "·"}
                  </div>
                ))}
              </div>
              <div style={{ textAlign: "center", fontSize: 13, padding: "2px 0", fontVariantNumeric: "tabular-nums" }}>
                {f.score ?? ""}
              </div>
            </div>
          );
        })}
        <div
          style={{
            marginLeft: 6,
            padding: "2px 10px",
            background: "rgba(255,210,59,0.18)",
            border: "1px solid rgba(255,210,59,0.5)",
            borderRadius: 6,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            minWidth: 56,
          }}
        >
          <div style={{ fontSize: 10, opacity: 0.7, letterSpacing: 1 }}>TOTAL</div>
          <div style={{ fontSize: 20, fontWeight: 900, fontVariantNumeric: "tabular-nums" }}>{total}</div>
        </div>
      </div>

      {/* Bottom controls panel */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          bottom: 16,
          transform: "translateX(-50%)",
          background: "rgba(11,18,30,0.78)",
          border: "1px solid rgba(255,255,255,0.18)",
          borderRadius: 12,
          padding: "10px 16px",
          minWidth: 360,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 6,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: 1 }}>{message}</div>

        {/* Aim bar */}
        <div style={{ width: 280, fontSize: 11, opacity: 0.75, display: "flex", justifyContent: "space-between" }}>
          <span>← aim</span><span>aim →</span>
        </div>
        <div style={{ width: 280, height: 8, background: "rgba(255,255,255,0.1)", borderRadius: 4, position: "relative" }}>
          <div
            style={{
              position: "absolute",
              left: "50%",
              top: -2,
              width: 2,
              height: 12,
              background: "rgba(255,255,255,0.3)",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: `${50 + (aim / 0.45) * 50}%`,
              top: -3,
              transform: "translateX(-50%)",
              width: 10,
              height: 14,
              background: "#ffd23b",
              borderRadius: 3,
            }}
          />
        </div>

        {/* Power bar */}
        <div style={{ width: 280, height: 12, background: "rgba(255,255,255,0.1)", borderRadius: 4, overflow: "hidden", marginTop: 4 }}>
          <div
            style={{
              width: `${power * 100}%`,
              height: "100%",
              background: powerColor,
              transition: charging ? "none" : "width 120ms ease",
            }}
          />
        </div>
        <div style={{ fontSize: 11, opacity: 0.75, marginTop: 2 }}>
          {ballMode === "idle"
            ? "← / → aim · Hold SPACE to charge, release to bowl · R reset · Esc menu"
            : ballMode === "rolling"
            ? "Pin action…"
            : "Waiting for pins to settle…"}
        </div>
      </div>
    </div>
  );
}
