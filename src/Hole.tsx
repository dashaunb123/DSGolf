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

function WaterPatch({ zone, index }: { zone: WaterZone; index: number }) {
  const rot = zone.rot || 0;
  const waveColor = index % 2 === 0 ? "#d6fbff" : "#b9edf7";

  if (zone.kind === "ellipse") {
    return (
      <group rotation={[-Math.PI / 2, 0, rot]} position={[zone.x, 0.017, zone.z]}>
        <mesh scale={[zone.rx * 1.05, zone.rz * 1.05, 1]} receiveShadow>
          <ringGeometry args={[0.91, 1, 72]} />
          <meshStandardMaterial color="#234f45" roughness={0.95} />
        </mesh>
        <mesh scale={[zone.rx, zone.rz, 1]} receiveShadow>
          <circleGeometry args={[1, 96]} />
          <meshStandardMaterial color="#177c99" roughness={0.18} metalness={0.08} transparent opacity={0.88} />
        </mesh>
        <mesh position={[0, 0, 0.004]} scale={[zone.rx * 0.76, zone.rz * 0.7, 1]}>
          <circleGeometry args={[1, 72]} />
          <meshStandardMaterial color="#42b8cc" roughness={0.12} metalness={0.15} transparent opacity={0.32} />
        </mesh>
        {[0.3, 0.48, 0.66, 0.82].map((r, i) => (
          <mesh
            key={`water-ellipse-ripple-${index}-${i}`}
            position={[0, 0, 0.007 + i * 0.001]}
            scale={[zone.rx, zone.rz, 1]}
          >
            <ringGeometry args={[r, r + 0.01, 72]} />
            <meshStandardMaterial color={waveColor} roughness={0.28} transparent opacity={0.18 - i * 0.025} />
          </mesh>
        ))}
      </group>
    );
  }

  const stripeCount = Math.max(4, Math.floor(zone.d / 18));
  return (
    <group rotation={[-Math.PI / 2, 0, rot]} position={[zone.x, 0.017, zone.z]}>
      <mesh position={[0, 0, -0.002]} receiveShadow>
        <planeGeometry args={[zone.w * 1.08, zone.d * 1.04]} />
        <meshStandardMaterial color="#234f45" roughness={0.95} />
      </mesh>
      <mesh receiveShadow>
        <planeGeometry args={[zone.w, zone.d]} />
        <meshStandardMaterial color="#177c99" roughness={0.18} metalness={0.08} transparent opacity={0.88} />
      </mesh>
      {Array.from({ length: stripeCount }).map((_, i) => {
        const z = -zone.d / 2 + ((i + 0.5) * zone.d) / stripeCount;
        return (
          <mesh key={`water-rect-ripple-${index}-${i}`} position={[0, z, 0.006 + i * 0.001]}>
            <planeGeometry args={[zone.w * (0.55 + (i % 2) * 0.22), 0.18]} />
            <meshStandardMaterial color={waveColor} roughness={0.25} transparent opacity={0.2} />
          </mesh>
        );
      })}
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
      {layout.water.map((zone, index) => (
        <WaterPatch key={`water-${index}`} zone={zone} index={index} />
      ))}

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
