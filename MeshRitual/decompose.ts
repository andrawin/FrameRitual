/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import * as THREE from 'three';

/** A single addressable part extracted from a loaded model. */
export interface Part {
  id: string;
  name: string;
  mesh: THREE.Mesh;
  materials: THREE.MeshStandardMaterial[];
  basePosition: THREE.Vector3;
  baseScale: THREE.Vector3;
  baseQuaternion: THREE.Quaternion;
  /** Outward explode direction in the mesh's parent-local space. */
  explodeDir: THREE.Vector3;
  /** Accumulated spin (rotate target). */
  spin: number;
}

/**
 * Walk a loaded model and turn every Mesh into a controllable Part. Materials
 * are cloned (so we can animate emissive per-part) and their emissive colour is
 * seeded from the base colour with zero intensity at rest.
 */
export function decompose(root: THREE.Object3D, center: THREE.Vector3): Part[] {
  const parts: Part[] = [];
  let idx = 0;

  root.updateWorldMatrix(true, true);

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!(mesh as any).isMesh) return;

    // Clone material(s) so per-part emissive changes don't leak across parts.
    const srcMats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const materials = srcMats.map((m) => {
      const clone = m.clone() as THREE.MeshStandardMaterial;
      if (clone.color && clone.emissive) {
        clone.emissive = clone.color.clone();
        clone.emissiveIntensity = 0;
      }
      return clone;
    });
    mesh.material = Array.isArray(mesh.material) ? materials : materials[0];

    // Outward direction = world part centre minus model centre, expressed in
    // the part's parent-local frame so position offsets look correct.
    const wp = new THREE.Vector3();
    mesh.getWorldPosition(wp);
    const dir = wp.clone().sub(center);
    if (dir.lengthSq() < 1e-8) dir.set(0, 1, 0);
    dir.normalize();
    if (mesh.parent) {
      const pq = new THREE.Quaternion();
      mesh.parent.getWorldQuaternion(pq);
      dir.applyQuaternion(pq.invert());
    }

    parts.push({
      id: `${(mesh.name || 'part').replace(/[^\w-]/g, '_')}__${idx}`,
      name: mesh.name || `Part ${idx + 1}`,
      mesh,
      materials,
      basePosition: mesh.position.clone(),
      baseScale: mesh.scale.clone(),
      baseQuaternion: mesh.quaternion.clone(),
      explodeDir: dir,
      spin: 0,
    });
    idx++;
  });

  return parts;
}
