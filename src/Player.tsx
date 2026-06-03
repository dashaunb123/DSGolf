import { useFBX, useTexture } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { forwardRef, useMemo, useRef } from "react";
import * as THREE from "three";
import { clone as cloneRig } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { Club } from "./clubs";
import golferFbxUrl from "../mixamo/golfer-mixamo-upload.fbx?url";
import golferTextureUrl from "../golfer-basecolor.jpg?url";
import driveFbxUrl from "../mixamo/golf-drive.fbx?url";
import chipFbxUrl from "../mixamo/golf-chip.fbx?url";
import puttFbxUrl from "../mixamo/golf-putt.fbx?url";

export type SwingState = {
  /** 0 = address, 1 = full backswing pulled */
  charge: number;
  /** 0 if no swing playing; ramps 0->1 over the swing animation duration */
  swing: number;
};

/** Which Mixamo golf clip the golfer plays. */
export type SwingMode = "full" | "chip" | "putt";

type PlayerProps = {
  stateRef: React.MutableRefObject<SwingState>;
  club: Club;
  /** Chosen by App from club + lie + distance. Falls back to club.putter. */
  swingMode?: SwingMode;
  // Outfit colours are kept on the API for compatibility, but this model is a
  // single textured mesh — they currently don't recolour it.
  shirtColor?: string;
  hatColor?: string;
  pantsColor?: string;
  shoeColor?: string;
  soleColor?: string;
  skinColor?: string;
};

// ── Tuning constants ─────────────────────────────────────────────────────
/** Rendered height of the golfer, in metres (world units). */
const TARGET_HEIGHT = 1.74;
/** Yaw so this exported FBX's visual forward faces the ball.
 * Game convention: the Player root's local +X points at the ball.
 * This specific Mixamo export presents its chest along local -X in bind pose,
 * so a 180deg yaw maps that forward onto game +X. */
const FACING_Y = Math.PI;
/**
 * Fraction of each clip at the top of the backswing. The charge phase scrubs
 * the clip address(0) → TOP; the swing phase scrubs TOP → finish(1). Nudge if
 * the wind-up looks like it stops short of, or past, the real backswing top.
 */
const TOP_FRAC: Record<SwingMode, number> = {
  full: 0.5,
  chip: 0.45,
  putt: 0.42,
};

function easeInOut(t: number) {
  return t * t * (3 - 2 * t);
}

type Rig = {
  root: THREE.Group;
  scale: number;
  yOffset: number;
  hips: THREE.Object3D | null;
  hipsRest: THREE.Vector3 | null;
};

type ClubPose = {
  handle: THREE.Vector3;
  head: THREE.Vector3;
};

const CLUB_IMPACT_FRAC = 0.42;

function orientSegment(group: THREE.Group, from: THREE.Vector3, to: THREE.Vector3) {
  const delta = to.clone().sub(from);
  const length = Math.max(delta.length(), 0.001);
  group.position.copy(from).addScaledVector(delta, 0.5);
  group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
  group.scale.set(1, length, 1);
}

function blendPose(out: ClubPose, from: ClubPose, to: ClubPose, t: number) {
  out.handle.lerpVectors(from.handle, to.handle, t);
  out.head.lerpVectors(from.head, to.head, t);
}

function makeClubPoses(club: Club, mode: SwingMode) {
  const putter = club.putter || mode === "putt";
  const chip = mode === "chip";
  const loftT = THREE.MathUtils.clamp((club.loft - 0.35) / 0.8, 0, 1);
  const headX = putter ? 0.46 : 0.54;
  const address: ClubPose = {
    handle: new THREE.Vector3(putter ? 0.16 : 0.19, putter ? 0.68 : 0.78, -0.02),
    head: new THREE.Vector3(headX, 0.055, putter ? 0.0 : 0.035),
  };
  const top: ClubPose = putter
    ? {
        handle: new THREE.Vector3(0.16, 0.68, -0.14),
        head: new THREE.Vector3(0.45, 0.08, -0.22),
      }
    : chip
      ? {
          handle: new THREE.Vector3(0.13, 0.88, -0.22),
          head: new THREE.Vector3(0.22, 0.9, -0.46),
        }
      : {
          handle: new THREE.Vector3(0.04, 1.0, -0.26),
          head: new THREE.Vector3(-0.12 - loftT * 0.06, 1.48, -0.5),
        };
  const finish: ClubPose = putter
    ? {
        handle: new THREE.Vector3(0.16, 0.68, 0.14),
        head: new THREE.Vector3(0.45, 0.08, 0.22),
      }
    : chip
      ? {
          handle: new THREE.Vector3(0.11, 0.9, 0.23),
          head: new THREE.Vector3(0.16, 0.98, 0.48),
        }
      : {
          handle: new THREE.Vector3(0.02, 1.02, 0.27),
          head: new THREE.Vector3(-0.16 - loftT * 0.05, 1.46, 0.52),
        };
  return { address, top, finish };
}

function RenderedClub({
  stateRef,
  club,
  swingMode,
}: {
  stateRef: React.MutableRefObject<SwingState>;
  club: Club;
  swingMode?: SwingMode;
}) {
  const shaftRef = useRef<THREE.Group>(null);
  const gripRef = useRef<THREE.Group>(null);
  const headRef = useRef<THREE.Group>(null);
  const handsRef = useRef<THREE.Group>(null);
  const poseRef = useRef<ClubPose>({
    handle: new THREE.Vector3(),
    head: new THREE.Vector3(),
  });
  const gripEndRef = useRef(new THREE.Vector3());
  const isWood = club.id === "driver" || club.id === "3wood" || club.id === "4hybrid";
  const isWedge = club.id === "wedge" || club.id === "sand" || club.id.startsWith("lob");

  useFrame(() => {
    const mode: SwingMode = swingMode ?? (club.putter ? "putt" : "full");
    const poses = makeClubPoses(club, mode);
    const { charge, swing } = stateRef.current;
    const pose = poseRef.current;

    if (swing > 0) {
      if (swing <= CLUB_IMPACT_FRAC) {
        blendPose(pose, poses.top, poses.address, easeInOut(swing / CLUB_IMPACT_FRAC));
      } else {
        blendPose(
          pose,
          poses.address,
          poses.finish,
          easeInOut((swing - CLUB_IMPACT_FRAC) / (1 - CLUB_IMPACT_FRAC)),
        );
      }
    } else {
      blendPose(pose, poses.address, poses.top, easeInOut(charge));
    }

    if (shaftRef.current) orientSegment(shaftRef.current, pose.handle, pose.head);
    if (gripRef.current) {
      gripEndRef.current.copy(pose.handle).lerp(pose.head, 0.18);
      orientSegment(gripRef.current, pose.handle, gripEndRef.current);
    }
    if (headRef.current) {
      headRef.current.position.copy(pose.head);
      headRef.current.rotation.set(0, club.putter ? 0.08 : -0.18, club.putter ? 0 : -0.22);
    }
    if (handsRef.current) {
      handsRef.current.position.copy(pose.handle).lerp(pose.head, 0.08);
      handsRef.current.rotation.set(-0.2, 0, 0.25);
    }
  });

  return (
    <group>
      <group ref={shaftRef}>
        <mesh castShadow>
          <cylinderGeometry args={[0.007, 0.006, 1, 12]} />
          <meshStandardMaterial color="#b7c1ca" metalness={0.7} roughness={0.32} />
        </mesh>
      </group>
      <group ref={gripRef}>
        <mesh castShadow>
          <cylinderGeometry args={[0.017, 0.014, 1, 12]} />
          <meshStandardMaterial color="#171717" roughness={0.72} />
        </mesh>
      </group>
      <group ref={handsRef}>
        <mesh castShadow position={[-0.018, 0.0, -0.012]} scale={[0.034, 0.026, 0.026]}>
          <sphereGeometry args={[1, 16, 10]} />
          <meshStandardMaterial color="#e8dcc8" roughness={0.65} />
        </mesh>
        <mesh castShadow position={[0.018, 0.0, 0.012]} scale={[0.036, 0.027, 0.027]}>
          <sphereGeometry args={[1, 16, 10]} />
          <meshStandardMaterial color="#f3f0e7" roughness={0.68} />
        </mesh>
      </group>
      <group ref={headRef}>
        {club.putter ? (
          <mesh castShadow receiveShadow position={[0.0, 0.0, 0.0]}>
            <boxGeometry args={[0.16, 0.035, 0.075]} />
            <meshStandardMaterial color="#d7dde2" metalness={0.72} roughness={0.28} />
          </mesh>
        ) : isWood ? (
          <mesh castShadow receiveShadow scale={[0.105, 0.052, 0.068]}>
            <sphereGeometry args={[1, 24, 14]} />
            <meshStandardMaterial color="#242a31" metalness={0.38} roughness={0.38} />
          </mesh>
        ) : (
          <mesh castShadow receiveShadow scale={[isWedge ? 0.13 : 0.115, 0.035, 0.052]}>
            <boxGeometry args={[1, 1, 1]} />
            <meshStandardMaterial color={isWedge ? "#e0d9c9" : "#cbd2d8"} metalness={0.68} roughness={0.3} />
          </mesh>
        )}
      </group>
    </group>
  );
}

/**
 * Clone the skinned character FBX, apply the base-colour texture, and
 * normalise it to TARGET_HEIGHT with its feet on the turf. Cloned with
 * SkeletonUtils (a plain .clone() breaks skin binding) so each Player gets an
 * independent skeleton the AnimationMixer can drive.
 */
function buildRig(fbx: THREE.Group, texture: THREE.Texture): Rig {
  const root = cloneRig(fbx) as THREE.Group;

  texture.colorSpace = THREE.SRGBColorSpace;
  // This is a Mixamo auto-bake: the skin/clothing live in many small UV islands.
  // Mipmapping averages across the gaps between islands, which shows up as the
  // "cracked squares" seam pattern. Sampling the full-res texture directly
  // (no mipmaps) with anisotropic filtering keeps each island clean.
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  const material = new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.85,
    metalness: 0.0,
    // Lift the character out of shadow so the (fairly light) texture doesn't
    // read as a dark muddy mass under the course lighting.
    emissiveMap: texture,
    emissive: new THREE.Color("#ffffff"),
    emissiveIntensity: 0.22,
  });
  root.traverse((obj) => {
    const skinned = obj as THREE.SkinnedMesh;
    if (skinned.isSkinnedMesh) {
      skinned.castShadow = true;
      skinned.receiveShadow = true;
      skinned.material = material;
      // Skinned bounds come from the bind pose; disable culling so the golfer
      // doesn't pop out of view at the edge of frame mid-swing.
      skinned.frustumCulled = false;
    }
  });

  const box = new THREE.Box3().setFromObject(root);
  const measured = box.max.y - box.min.y || 1;
  const scale = TARGET_HEIGHT / measured;
  const yOffset = -box.min.y * scale;
  const hips = root.getObjectByName("mixamorigHips") ?? null;
  return {
    root,
    scale,
    yOffset,
    hips,
    hipsRest: hips ? hips.position.clone() : null,
  };
}

type ClipEntry = { action: THREE.AnimationAction; duration: number };

export const Player = forwardRef<THREE.Group, PlayerProps>(function Player(
  { stateRef, club, swingMode },
  rootRef,
) {
  const charFbx = useFBX(golferFbxUrl);
  const texture = useTexture(golferTextureUrl);
  const driveFbx = useFBX(driveFbxUrl);
  const chipFbx = useFBX(chipFbxUrl);
  const puttFbx = useFBX(puttFbxUrl);
  const rigGroupRef = useRef<THREE.Group>(null);
  const groundBoxRef = useRef(new THREE.Box3());

  const rig = useMemo(() => buildRig(charFbx, texture), [charFbx, texture]);

  // One mixer on the cloned skeleton; one scrubbable action per golf clip.
  // The clips were exported on the same Mixamo skeleton as the character, so
  // their tracks bind to its bones by name with no retargeting.
  const anim = useMemo(() => {
    const mixer = new THREE.AnimationMixer(rig.root);
    const makeEntry = (fbx: THREE.Group, name: SwingMode): ClipEntry | null => {
      const clip = fbx.animations?.[0];
      if (!clip) return null;
      clip.name = name; // every Mixamo clip ships as "mixamo.com" — disambiguate
      const action = mixer.clipAction(clip);
      action.play();
      action.enabled = false;
      return { action, duration: clip.duration };
    };
    return {
      mixer,
      full: makeEntry(driveFbx, "full"),
      chip: makeEntry(chipFbx, "chip"),
      putt: makeEntry(puttFbx, "putt"),
    };
  }, [rig.root, driveFbx, chipFbx, puttFbx]);

  useFrame(() => {
    const { charge, swing } = stateRef.current;
    const mode: SwingMode = swingMode ?? (club.putter ? "putt" : "full");
    const active = anim[mode] ?? anim.full;

    // Only the active clip contributes; the others are held silent.
    for (const m of ["full", "chip", "putt"] as SwingMode[]) {
      const entry = anim[m];
      if (entry) {
        const on = entry === active;
        entry.action.enabled = on;
        entry.action.weight = on ? 1 : 0;
      }
    }
    if (!active) return;

    // Scrub the clip: charge winds address → backswing-top; swing plays
    // backswing-top → finish. Idle (charge 0, swing 0) rests at the clip's
    // frame 0, which is a real address pose.
    const top = TOP_FRAC[mode];
    let progress: number;
    if (swing > 0 && swing < 1) {
      progress = THREE.MathUtils.lerp(top, 1, swing);
    } else if (swing >= 1) {
      progress = 1;
    } else {
      progress = THREE.MathUtils.lerp(0, top, easeInOut(charge));
    }
    active.action.time = THREE.MathUtils.clamp(progress, 0, 1) * (active.duration - 0.001);
    anim.mixer.update(0);

    // Mixamo clips include root/hips translation. Keep the golfer planted
    // beside the ball; rotations still animate the full skeleton.
    if (rig.hips && rig.hipsRest) {
      rig.hips.position.copy(rig.hipsRest);
    }
    if (rigGroupRef.current) {
      groundBoxRef.current.setFromObject(rig.root);
      if (Number.isFinite(groundBoxRef.current.min.y)) {
        rigGroupRef.current.position.y -= groundBoxRef.current.min.y;
      }
    }
  });

  return (
    <group ref={rootRef}>
      <group
        ref={rigGroupRef}
        rotation={[0, FACING_Y, 0]}
        position={[0, rig.yOffset, 0]}
        scale={rig.scale}
      >
        <primitive object={rig.root} />
      </group>
      <RenderedClub stateRef={stateRef} club={club} swingMode={swingMode} />
    </group>
  );
});

useFBX.preload(golferFbxUrl);
useFBX.preload(driveFbxUrl);
useFBX.preload(chipFbxUrl);
useFBX.preload(puttFbxUrl);
