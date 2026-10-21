import * as THREE from "three";
import { parseDeviceKitUsdz } from "./devicekitUsdz";

// Mesh bindings in DeviceKit's V68.usdz. Validate them before mounting the view
// so a changed Xcode model can use the existing 2D view instead of a broken rig.
const INNER_DISPLAY = "mQHVkATpIwJRVQx";
const COVER_DISPLAY = "zaWsadDZpWAUDAX";

// ADE patch: the archive's bytes come from ADE's `ios_simulator.getDuoModel`
// (read from the Xcode on the machine that owns the simulator), not from a
// serve-sim HTTP endpoint.
export async function loadDuoModel(bytes: ArrayBuffer): Promise<THREE.Group> {
  return prepareDuoModel(await parseDeviceKitUsdz(bytes));
}

/** Bind the installed model to the viewer's hinge and live displays in memory.
 * Xcode's coordinates put the open screen on X/Z; the viewer uses X/Y.
 * Splitting triangles at the hinge preserves the original outline and UVs.
 */
export function prepareDuoModel(source: THREE.Group): THREE.Group {
  const inner = source.getObjectByName(INNER_DISPLAY);
  const cover = source.getObjectByName(COVER_DISPLAY);
  if (!(inner instanceof THREE.Mesh) || !(cover instanceof THREE.Mesh))
    throw new Error("Missing Xcode Duo displays");
  source.updateMatrixWorld(true);
  const displayBounds = new THREE.Box3().setFromObject(inner);
  const transform = new THREE.Matrix4().makeRotationX(Math.PI / 2);
  transform.setPosition(0, 0, -displayBounds.getCenter(new THREE.Vector3()).y);
  const model = new THREE.Group();
  const left = new THREE.Group();
  left.name = "left-half";
  const right = new THREE.Group();
  right.name = "right-half";
  model.add(left, right);
  const skeletons = new Set<THREE.Skeleton>();
  source.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const geometry = child.geometry
      .clone()
      .applyMatrix4(transform.clone().multiply(child.matrixWorld));
    for (const [half, sign] of [
      [left, -1],
      [right, 1],
    ] as const) {
      const clipped = clipHingeGeometry(geometry, sign);
      if (!clipped) continue;
      const mesh = new THREE.Mesh(clipped, child.material);
      mesh.name =
        child === inner
          ? `inner-display-${sign < 0 ? "left" : "right"}`
          : child === cover
            ? "cover-display"
            : child.name;
      half.add(mesh);
    }
    geometry.dispose();
    child.geometry.dispose();
    if (child instanceof THREE.SkinnedMesh) skeletons.add(child.skeleton);
  });
  for (const skeleton of skeletons) skeleton.dispose();
  return model;
}

export function clipHingeGeometry(
  geometry: THREE.BufferGeometry,
  sign: -1 | 1,
): THREE.BufferGeometry | null {
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox!;
  if (sign < 0 ? bounds.min.x > 0 : bounds.max.x < 0) return null;
  if (sign < 0 ? bounds.max.x <= 0 : bounds.min.x >= 0) {
    return geometry.clone().deleteAttribute("skinIndex").deleteAttribute("skinWeight");
  }
  const attributes = Object.entries(geometry.attributes).filter(
    ([name]) => !name.startsWith("skin"),
  );
  // Position comes first so the hinge plane is the first component of a vertex.
  attributes.sort(([a], [b]) => (a === "position" ? -1 : b === "position" ? 1 : 0));
  const values: number[][] = attributes.map(() => []);
  const count = geometry.index?.count ?? geometry.getAttribute("position").count;
  const result = new THREE.BufferGeometry();
  let total = 0;
  for (const group of geometry.groups.length
    ? geometry.groups
    : [{ start: 0, count, materialIndex: 0 }]) {
    const start = total;
    for (let index = group.start; index < group.start + group.count; index += 3) {
      const polygon = [0, 1, 2].map((corner) => {
        const vertex = geometry.index?.getX(index + corner) ?? index + corner;
        return attributes.flatMap(([, attribute]) =>
          Array.from({ length: attribute.itemSize }, (_, component) =>
            attribute.getComponent(vertex, component),
          ),
        );
      });
      const clipped: number[][] = [];
      for (let i = 0; i < polygon.length; i++) {
        const current = polygon[i]!;
        const previous = polygon[(i + polygon.length - 1) % polygon.length]!;
        const inside = sign * current[0]! >= 0;
        if (inside !== sign * previous[0]! >= 0) {
          const t = previous[0]! / (previous[0]! - current[0]!);
          const edge = previous.map(
            (value, component) => value + t * (current[component]! - value),
          );
          edge[0] = 0;
          clipped.push(edge);
        }
        if (inside) clipped.push(current);
      }
      for (let triangle = 1; triangle < clipped.length - 1; triangle++) {
        for (const vertex of [clipped[0]!, clipped[triangle]!, clipped[triangle + 1]!]) {
          let offset = 0;
          attributes.forEach(([, attribute], attributeIndex) => {
            values[attributeIndex]!.push(...vertex.slice(offset, (offset += attribute.itemSize)));
          });
          total++;
        }
      }
    }
    if (total > start) result.addGroup(start, total - start, group.materialIndex);
  }
  if (!total) return null;
  attributes.forEach(([name, attribute], index) =>
    result.setAttribute(name, new THREE.Float32BufferAttribute(values[index]!, attribute.itemSize)),
  );
  if (result.hasAttribute("normal")) result.normalizeNormals();
  return result;
}
