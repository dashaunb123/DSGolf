type TreeProps = {
  position?: [number, number, number];
  /** @min 1 @max 6 */
  scale?: number;
  foliageColor?: string;
};

export function Tree({
  position = [0, 0, 0],
  scale = 1,
  foliageColor = "#2f6b2a",
}: TreeProps) {
  const darkFoliage = "#245621";
  const trunkColor = "#5b3a1e";
  const barkShadow = "#3c2715";

  return (
    <group position={position} scale={scale}>
      <mesh position={[0, 0.45, 0]} castShadow>
        <cylinderGeometry args={[0.11, 0.18, 0.9, 10]} />
        <meshStandardMaterial color={trunkColor} roughness={0.85} />
      </mesh>
      <mesh position={[0.045, 0.48, 0.01]} castShadow>
        <cylinderGeometry args={[0.018, 0.026, 0.74, 6]} />
        <meshStandardMaterial color={barkShadow} roughness={0.95} />
      </mesh>
      <mesh position={[0, 1.22, 0]} scale={[0.92, 0.52, 0.92]} castShadow>
        <sphereGeometry args={[0.72, 18, 12]} />
        <meshStandardMaterial color={darkFoliage} roughness={0.9} />
      </mesh>
      <mesh position={[-0.26, 1.62, 0.03]} scale={[0.76, 0.58, 0.74]} castShadow>
        <sphereGeometry args={[0.68, 18, 12]} />
        <meshStandardMaterial color={foliageColor} roughness={0.86} />
      </mesh>
      <mesh position={[0.28, 1.67, -0.02]} scale={[0.72, 0.56, 0.7]} castShadow>
        <sphereGeometry args={[0.64, 18, 12]} />
        <meshStandardMaterial color="#356f2d" roughness={0.86} />
      </mesh>
      <mesh position={[0.02, 2.1, 0]} scale={[0.7, 0.58, 0.7]} castShadow>
        <sphereGeometry args={[0.62, 18, 12]} />
        <meshStandardMaterial color={foliageColor} roughness={0.86} />
      </mesh>
    </group>
  );
}
