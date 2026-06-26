/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import * as THREE from 'three';
import type { Band } from './types';

/** One shatter fragment built from a cluster of the model's triangles. */
export interface Fragment {
  mesh: THREE.Mesh;
  base: THREE.Vector3; // rest position (cluster centroid in model space)
  dir: THREE.Vector3; // outward explode direction
  axis: THREE.Vector3; // random spin axis
  phase: number; // 0..1 random offset for variety
  band: Band; // assigned band when distribute is on
  spin: number; // accumulated rotation
}

/** Flatten every mesh in the model into world-space triangle soup (pos+normal). */
function collectTriangles(root: THREE.Object3D): { pos: number[]; nrm: number[] } {
  const pos: number[] = [];
  const nrm: number[] = [];
  root.updateWorldMatrix(true, true);

  const v = new THREE.Vector3();
  const vn = new THREE.Vector3();

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!(mesh as any).isMesh) return;

    let g = mesh.geometry as THREE.BufferGeometry;
    g = g.index ? g.toNonIndexed() : g.clone();
    if (!g.getAttribute('normal')) g.computeVertexNormals();

    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const mw = mesh.matrixWorld;
    const nmat = new THREE.Matrix3().getNormalMatrix(mw);

    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(mw);
      pos.push(v.x, v.y, v.z);
      vn.fromBufferAttribute(n, i).applyMatrix3(nmat).normalize();
      nrm.push(vn.x, vn.y, vn.z);
    }
    g.dispose();
  });

  return { pos, nrm };
}

/**
 * Shatter a model into `count` fragments by k-means clustering its triangles,
 * returning a Group of fragment meshes plus their animation metadata.
 *
 * Not a true convex Voronoi decomposition, but visually reads as a clean
 * spatial shatter and works on any mesh (including single fused meshes).
 */
export function fracture(
  root: THREE.Object3D,
  center: THREE.Vector3,
  count: number,
  baseColor: THREE.Color,
): { group: THREE.Group; fragments: Fragment[]; material: THREE.MeshStandardMaterial } {
  const group = new THREE.Group();
  const fragments: Fragment[] = [];

  const material = new THREE.MeshStandardMaterial({
    color: baseColor,
    emissive: baseColor.clone(),
    emissiveIntensity: 0,
    metalness: 0.25,
    roughness: 0.45,
  });

  const { pos, nrm } = collectTriangles(root);
  const triCount = Math.floor(pos.length / 9);
  if (triCount === 0) return { group, fragments, material };

  const N = Math.max(1, Math.min(count, triCount));

  // Per-triangle centroids.
  const cen = new Float32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    cen[t * 3] = (pos[o] + pos[o + 3] + pos[o + 6]) / 3;
    cen[t * 3 + 1] = (pos[o + 1] + pos[o + 4] + pos[o + 7]) / 3;
    cen[t * 3 + 2] = (pos[o + 2] + pos[o + 5] + pos[o + 8]) / 3;
  }

  // K-means: init from evenly-strided triangles, then refine.
  const cx = new Float32Array(N);
  const cy = new Float32Array(N);
  const cz = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    const t = Math.floor((k / N) * triCount);
    cx[k] = cen[t * 3];
    cy[k] = cen[t * 3 + 1];
    cz[k] = cen[t * 3 + 2];
  }

  const assign = new Int32Array(triCount);
  for (let iter = 0; iter < 8; iter++) {
    // Assign each triangle to nearest cluster.
    for (let t = 0; t < triCount; t++) {
      const px = cen[t * 3];
      const py = cen[t * 3 + 1];
      const pz = cen[t * 3 + 2];
      let best = 0;
      let bestD = Infinity;
      for (let k = 0; k < N; k++) {
        const dx = px - cx[k];
        const dy = py - cy[k];
        const dz = pz - cz[k];
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      }
      assign[t] = best;
    }
    // Recompute centroids.
    const sx = new Float32Array(N);
    const sy = new Float32Array(N);
    const sz = new Float32Array(N);
    const cnt = new Int32Array(N);
    for (let t = 0; t < triCount; t++) {
      const k = assign[t];
      sx[k] += cen[t * 3];
      sy[k] += cen[t * 3 + 1];
      sz[k] += cen[t * 3 + 2];
      cnt[k]++;
    }
    for (let k = 0; k < N; k++) {
      if (cnt[k] > 0) {
        cx[k] = sx[k] / cnt[k];
        cy[k] = sy[k] / cnt[k];
        cz[k] = sz[k] / cnt[k];
      }
    }
  }

  // Build one geometry per non-empty cluster, recentred on its centroid.
  const bands: Band[] = ['low', 'mid', 'high'];
  for (let k = 0; k < N; k++) {
    const verts: number[] = [];
    const norms: number[] = [];
    for (let t = 0; t < triCount; t++) {
      if (assign[t] !== k) continue;
      const o = t * 9;
      for (let j = 0; j < 9; j++) {
        verts.push(pos[o + j]);
        norms.push(nrm[o + j]);
      }
    }
    if (verts.length === 0) continue;

    const ctr = new THREE.Vector3(cx[k], cy[k], cz[k]);
    for (let i = 0; i < verts.length; i += 3) {
      verts[i] -= ctr.x;
      verts[i + 1] -= ctr.y;
      verts[i + 2] -= ctr.z;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(norms, 3));

    const mesh = new THREE.Mesh(geo, material);
    mesh.position.copy(ctr);
    group.add(mesh);

    const dir = ctr.clone().sub(center);
    if (dir.lengthSq() < 1e-8) dir.set(0, 1, 0);
    dir.normalize();

    const axis = new THREE.Vector3(
      Math.random() - 0.5,
      Math.random() - 0.5,
      Math.random() - 0.5,
    );
    if (axis.lengthSq() < 1e-8) axis.set(0, 1, 0);
    axis.normalize();

    fragments.push({
      mesh,
      base: ctr.clone(),
      dir,
      axis,
      phase: Math.random(),
      band: bands[fragments.length % 3],
      spin: 0,
    });
  }

  return { group, fragments, material };
}
