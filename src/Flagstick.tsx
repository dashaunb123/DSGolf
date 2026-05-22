import { useMemo } from "react";
import * as THREE from "three";

type FlagstickProps = {
  /** @min 1 @max 4 */
  height?: number;
  flagColor?: string;
  poleColor?: string;
};

export function Flagstick({
  height = 2.4,
  flagColor = "#d92121",
  poleColor = "#f5f5f5",
}: FlagstickProps) {
  const flagShape = useMemo(() => {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(0.52, -0.06);
    shape.lineTo(0.42, 0.12);
    shape.lineTo(0.52, 0.3);
    shape.lineTo(0, 0.24);
    shape.closePath();
    return shape;
  }, []);

  return (
    <group>
      <mesh position={[0, height / 2, 0]} castShadow>
        <cylinderGeometry args={[0.015, 0.015, height, 8]} />
        <meshStandardMaterial color={poleColor} roughness={0.38} />
      </mesh>
      <mesh position={[0, height + 0.015, 0]} castShadow>
        <sphereGeometry args={[0.04, 12, 8]} />
        <meshStandardMaterial color="#f7f7f7" roughness={0.35} />
      </mesh>
      <mesh position={[0.025, height - 0.34, 0]} castShadow>
        <sphereGeometry args={[0.028, 10, 8]} />
        <meshStandardMaterial color="#d4d9df" roughness={0.4} />
      </mesh>
      <mesh position={[0.03, height - 0.3, 0]} rotation={[0, -0.18, 0]} castShadow>
        <shapeGeometry args={[flagShape]} />
        <meshStandardMaterial
          color={flagColor}
          side={THREE.DoubleSide}
          roughness={0.72}
        />
      </mesh>
    </group>
  );
}
