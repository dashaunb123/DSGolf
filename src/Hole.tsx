import { Flagstick } from "./Flagstick";
import { SceneEnvironment } from "./SceneEnvironment";
import { Tree } from "./Tree";
import { POS, type FairwayZone, type HoleLayout } from "./layout";

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
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.02, greenZ]}
        receiveShadow
      >
        <circleGeometry args={[greenRadius, 48]} />
        <meshStandardMaterial color="#7fd06a" />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.024, greenZ]} receiveShadow>
        <ringGeometry args={[greenRadius * 0.92, greenRadius * 1.08, 72]} />
        <meshStandardMaterial color="#5daf52" roughness={0.9} />
      </mesh>
      {[0.34, 0.58, 0.78].map((r, index) => (
        <mesh
          key={`green-contour-${index}`}
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, 0.028 + index * 0.001, greenZ]}
        >
          <ringGeometry args={[greenRadius * r, greenRadius * (r + 0.018), 72]} />
          <meshStandardMaterial
            color={index % 2 === 0 ? "#8ddd73" : "#6fc05a"}
            transparent
            opacity={0.55}
            roughness={0.9}
          />
        </mesh>
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
