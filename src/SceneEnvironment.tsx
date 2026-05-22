import { Sky } from "@react-three/drei";

/**
 * Scene lighting + atmosphere for the golf course.
 *
 * Extracted from Hole.tsx so the light rig and the course geometry can be
 * iterated independently. Mounted once inside the <Canvas>, in place of the
 * old inline <ambientLight>/<directionalLight>/<Sky>/<fog> block.
 *
 * Rig — a standard outdoor key + fill + ambient:
 *   - hemisphereLight   sky-blue from above, turf-green bounce from below.
 *                       A gradient ambient, replacing the old flat grey one,
 *                       so shadowed faces pick up a believable colour.
 *   - key directional   the sun; the scene's only shadow caster.
 *   - fill directional  low, shadowless, opposite the sun, so shadowed faces
 *                       keep some light instead of crushing to black.
 *
 * Intensities are tuned for ACES tone mapping, which @react-three/fiber v8
 * applies to the renderer by default — no <Canvas> change is needed for it.
 */

/** Shared sun direction — the key light and the Sky dome must agree on it. */
const SUN_POSITION: [number, number, number] = [40, 60, 20];

/**
 * Half-extent of the sun's shadow frustum, in metres, centred on the world
 * origin. Wider than the old ±100 so more of a long hole is shadowed; kept
 * finite so the 2048² shadow map keeps a usable texel density. (A camera-
 * following shadow target would cover the longest par-5s edge to edge — see
 * collab.md work log.)
 */
const SHADOW_EXTENT = 150;

export function SceneEnvironment() {
  return (
    <>
      <hemisphereLight args={["#bcd6ff", "#3f5d2c", 0.7]} />

      <directionalLight
        position={SUN_POSITION}
        intensity={1.45}
        color="#fff3df"
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-SHADOW_EXTENT}
        shadow-camera-right={SHADOW_EXTENT}
        shadow-camera-top={SHADOW_EXTENT}
        shadow-camera-bottom={-SHADOW_EXTENT}
        shadow-camera-near={1}
        shadow-camera-far={300}
        shadow-bias={-0.0005}
        shadow-normalBias={0.02}
        shadow-radius={4}
      />

      <directionalLight position={[-46, 34, -38]} intensity={0.28} color="#cdddff" />

      <Sky
        sunPosition={SUN_POSITION}
        turbidity={2.5}
        rayleigh={0.5}
        mieCoefficient={0.005}
        mieDirectionalG={0.8}
      />
      <fog attach="fog" args={["#cfe6ff", 90, 320]} />
    </>
  );
}
