import { Flagstick } from "./Flagstick";
import { SceneEnvironment } from "./SceneEnvironment";
import { Tree } from "./Tree";
import { POS, type FairwayZone, type HoleLayout, type WaterZone } from "./layout";

function FairwayDetail({ zone, index }: { zone: FairwayZone; index: number }) {
  if (zone.kind === "circle") {
    return (
      <group rotation={[-Math.PI / 2, 0, 0]} position={[zone.x, 0.014, zone.z]}>
        {[0.42, 0.64, 0.84].map((r, i) => (
          <mesh key={`circle-stripe-${index}-${i}`} receiveShadow>
            <ringGeometry args={[zone.r * (r - 0.035), zone.r * r, 64]} />
            <meshStandardMaterial
              color={i % 2 === 0 ? "#6dbd54" : "#4f9d40"}
              transparent
              opacity={0.34}
              roughness={0.9}
            />
          </mesh>
        ))}
      </group>
    );
  }

  const stripeCount = Math.max(3, Math.floor(zone.w / 4));
  return (
    <group
      rotation={[-Math.PI / 2, 0, zone.rot || 0]}
      position={[zone.x, 0.014, zone.z]}
    >
      {Array.from({ length: stripeCount }).map((_, i) => {
        const stripeW = zone.w / stripeCount;
        const x = -zone.w / 2 + stripeW * (i + 0.5);
        return (
          <mesh key={`rect-stripe-${index}-${i}`} position={[x, 0, 0]} receiveShadow>
            <planeGeometry args={[stripeW * 0.62, zone.d * 0.96]} />
            <meshStandardMaterial
              color={i % 2 === 0 ? "#6dbd54" : "#4f9d40"}
              transparent
              opacity={0.26}
              roughness={0.92}
            />
          </mesh>
        );
      })}
    </group>
  );
}

// Realistic still-water palette (viewed top-down): a grassy/marshy shore lip,
// a darker deep band at the edges, the main lake-blue surface, and a soft sky
// reflection. No cartoon ripple rings.
const WATER_SHORE = "#34543f";
const WATER_EDGE = "#0f3a4e";
const WATER_MAIN = "#1d6485";
const WATER_SHEEN = "#7cbad6";

// One flat layer of a water body. Ellipse zones scale a disc; rect zones scale
// a plane. `inflate` grows the shape (banks are drawn larger than the fill);
// `offset` nudges the sky-sheen off-centre so it reads as a reflection.
function WaterLayer({
  zone,
  y,
  inflate,
  color,
  opacity = 1,
  roughness = 0.9,
  metalness = 0,
  offset = false,
}: {
  zone: WaterZone;
  y: number;
  inflate: number;
  color: string;
  opacity?: number;
  roughness?: number;
  metalness?: number;
  offset?: boolean;
}) {
  const rot = zone.rot || 0;
  const transparent = opacity < 1;
  if (zone.kind === "ellipse") {
    const ox = offset ? zone.rx * 0.16 : 0;
    const oy = offset ? -zone.rz * 0.12 : 0;
    return (
      <group rotation={[-Math.PI / 2, 0, rot]} position={[zone.x, y, zone.z]}>
        <mesh position={[ox, oy, 0]} scale={[zone.rx * inflate, zone.rz * inflate, 1]} receiveShadow>
          <circleGeometry args={[1, 80]} />
          <meshStandardMaterial color={color} roughness={roughness} metalness={metalness} transparent={transparent} opacity={opacity} />
        </mesh>
      </group>
    );
  }
  const ox = offset ? zone.w * 0.14 : 0;
  const oy = offset ? -zone.d * 0.1 : 0;
  return (
    <group rotation={[-Math.PI / 2, 0, rot]} position={[zone.x, y, zone.z]}>
      <mesh position={[ox, oy, 0]} receiveShadow>
        <planeGeometry args={[zone.w * inflate, zone.d * inflate]} />
        <meshStandardMaterial color={color} roughness={roughness} metalness={metalness} transparent={transparent} opacity={opacity} />
      </mesh>
    </group>
  );
}

// Render every water body in stacked passes so that overlapping ellipses fuse
// into a single organic lake: shore + deep-edge are drawn first and larger, the
// opaque main fill on top covers all the internal overlaps, and a soft sheen
// finishes it. Shorelines therefore only show on the outer union boundary.
function WaterField({ zones }: { zones: WaterZone[] }) {
  if (zones.length === 0) return null;
  return (
    <group>
      {zones.map((zone, i) => (
        <WaterLayer key={`shore-${i}`} zone={zone} y={0.0158} inflate={1.18} color={WATER_SHORE} roughness={0.96} />
      ))}
      {zones.map((zone, i) => (
        <WaterLayer key={`deep-${i}`} zone={zone} y={0.0168} inflate={1.05} color={WATER_EDGE} roughness={0.6} metalness={0.08} />
      ))}
      {zones.map((zone, i) => (
        <WaterLayer key={`fill-${i}`} zone={zone} y={0.018} inflate={1.0} color={WATER_MAIN} roughness={0.32} metalness={0.1} />
      ))}
      {zones.map((zone, i) => (
        <WaterLayer key={`sheen-${i}`} zone={zone} y={0.0188} inflate={0.6} color={WATER_SHEEN} roughness={0.12} metalness={0.18} opacity={0.3} offset />
      ))}
    </group>
  );
}

/**
 * Static Par 3 hole scene. Geometry sourced from ./layout so game logic
 * (surface classification, ball positions) stays in sync with what's rendered.
 */
export function Hole({
  layout = POS,
  flagColor = "#d92121",
}: {
  layout?: HoleLayout;
  flagColor?: string;
}) {
  const { length, teeZ, greenZ, fairwayWidth, greenRadius } = layout;

  return (
    <group>
      <SceneEnvironment />

      {/* Rough — big ground plane */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0, 0]}
        receiveShadow
      >
        <planeGeometry args={[length + 120, length + 120]} />
        <meshStandardMaterial color="#3f7a2e" />
      </mesh>

      {/* Fairway zones */}
      {layout.fairways.map((zone, index) =>
        zone.kind === "circle" ? (
          <mesh
            key={`fairway-${index}`}
            rotation={[-Math.PI / 2, 0, 0]}
            position={[zone.x, 0.01, zone.z]}
            receiveShadow
          >
            <circleGeometry args={[zone.r, 48]} />
            <meshStandardMaterial color="#5fae4a" />
          </mesh>
        ) : (
          <mesh
            key={`fairway-${index}`}
            rotation={[-Math.PI / 2, 0, zone.rot || 0]}
            position={[zone.x, 0.01, zone.z]}
            receiveShadow
          >
            <planeGeometry args={[zone.w, zone.d]} />
            <meshStandardMaterial color="#5fae4a" />
          </mesh>
        ),
      )}
      {layout.fairways.map((zone, index) => (
        <FairwayDetail key={`fairway-detail-${index}`} zone={zone} index={index} />
      ))}

      {/* Water hazards */}
      <WaterField zones={layout.water} />

      {/* Tee box */}
      <mesh position={[0, 0.05, teeZ]} receiveShadow>
        <boxGeometry args={[4, 0.1, 3]} />
        <meshStandardMaterial color="#6fbf55" />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.105, teeZ]} receiveShadow>
        <ringGeometry args={[1.75, 2.05, 4]} />
        <meshStandardMaterial color="#3f9b45" roughness={0.85} />
      </mesh>
      <mesh position={[-1.2, 0.15, teeZ + 0.5]} castShadow>
        <sphereGeometry args={[0.12, 12, 12]} />
        <meshStandardMaterial color="#ffffff" />
      </mesh>
      <mesh position={[1.2, 0.15, teeZ + 0.5]} castShadow>
        <sphereGeometry args={[0.12, 12, 12]} />
        <meshStandardMaterial color="#ffffff" />
      </mesh>

      {/* Putting green */}
      {layout.greenZones.map((zone, zoneIndex) => (
        <group
          key={`green-zone-${zoneIndex}`}
          rotation={[-Math.PI / 2, 0, zone.rot || 0]}
          position={[zone.x, 0.02 + zoneIndex * 0.001, zone.z]}
        >
          <mesh scale={[zone.rx, zone.rz, 1]} receiveShadow>
            <circleGeometry args={[1, 72]} />
            <meshStandardMaterial color="#7fd06a" />
          </mesh>
          <mesh position={[0, 0, 0.004]} scale={[zone.rx, zone.rz, 1]} receiveShadow>
            <ringGeometry args={[0.9, 1.03, 72]} />
            <meshStandardMaterial color="#5daf52" roughness={0.9} />
          </mesh>
          {[0.34, 0.58, 0.78].map((r, index) => (
            <mesh
              key={`green-contour-${zoneIndex}-${index}`}
              position={[0, 0, 0.008 + index * 0.001]}
              scale={[zone.rx, zone.rz, 1]}
            >
              <ringGeometry args={[r, r + 0.018, 72]} />
              <meshStandardMaterial
                color={index % 2 === 0 ? "#8ddd73" : "#6fc05a"}
                transparent
                opacity={0.48}
                roughness={0.9}
              />
            </mesh>
          ))}
        </group>
      ))}

      {/* Cup */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[layout.cup.x, 0.031, layout.cup.z]}
      >
        <ringGeometry args={[layout.cupRadius, layout.cupRadius * 1.55, 28]} />
        <meshStandardMaterial color="#dfe8d5" roughness={0.55} />
      </mesh>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[layout.cup.x, 0.034, layout.cup.z]}
      >
        <circleGeometry args={[layout.cupRadius, 24]} />
        <meshStandardMaterial color="#0a0a0a" />
      </mesh>

      {/* Flag */}
      <group position={[layout.cup.x, 0.03, layout.cup.z]}>
        <Flagstick flagColor={flagColor} />
      </group>

      {/* Bunkers */}
      {layout.bunkers.map((bunker, index) => (
        <group key={`bunker-${index}`} rotation={[-Math.PI / 2, 0, 0]} position={[bunker.x, 0.03, bunker.z]}>
          <mesh scale={[bunker.rx * 1.12, bunker.rz * 1.12, 1]} receiveShadow>
            <ringGeometry args={[0.86, 1, 40]} />
            <meshStandardMaterial color="#c9b574" roughness={0.95} />
          </mesh>
          <mesh position={[0, 0, 0.002]} scale={[bunker.rx, bunker.rz, 1]} receiveShadow>
            <circleGeometry args={[1, 40]} />
            <meshStandardMaterial color="#ead8a3" roughness={1} />
          </mesh>
          <mesh position={[0, 0, 0.004]} scale={[bunker.rx * 0.72, bunker.rz * 0.72, 1]}>
            <ringGeometry args={[0.62, 0.68, 34]} />
            <meshStandardMaterial color="#f3e6be" transparent opacity={0.55} roughness={1} />
          </mesh>
        </group>
      ))}

      {/* Trees — use custom set if the hole defines one, otherwise default corridor. */}
      {layout.trees.length > 0 ? (
        layout.trees.map((t, i) => (
          <Tree key={`tree-${i}`} position={[t.x, 0, t.z]} scale={t.scale ?? 1.6} />
        ))
      ) : (
        <>
          <Tree position={[-fairwayWidth, 0, teeZ - length * 0.15]} scale={1.6} />
          <Tree position={[fairwayWidth, 0, teeZ - length * 0.25]} scale={1.4} />
          <Tree position={[-fairwayWidth - 2, 0, 0]} scale={1.8} />
          <Tree position={[fairwayWidth + 1, 0, 5]} scale={1.5} />
          <Tree position={[fairwayWidth + 3, 0, greenZ + 2]} scale={1.7} />
          <Tree position={[-fairwayWidth - 3, 0, greenZ - 3]} scale={1.5} />
          <Tree position={[fairwayWidth + 4, 0, greenZ - 8]} scale={1.4} />
          <Tree position={[-fairwayWidth - 4, 0, teeZ - length * 0.4]} scale={1.5} />
        </>
      )}
    </group>
  );
}
