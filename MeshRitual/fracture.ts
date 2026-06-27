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
  spin: number; // accumulated rotation (deterministic mode)
  vel: THREE.Vector3; // linear velocity (physics mode)
  angVel: THREE.Vector3; // angular velocity axis*speed (physics mode)
  resting: boolean; // held at rest / settled (physics mode)
}

interface TriangleSoup {
  pos: number[]; // 9 per triangle
  nrm: number[]; // 9 per triangle
  uv: number[]; // 6 per triangle
  tmat: number[]; // 1 per triangle -> index into `materials`
  materials: THREE.MeshStandardMaterial[];
}

/**
 * Build the deduped list of (cloned) source materials. Emissive is seeded from
 * each material's base colour at zero intensity so per-region "glow" keeps the
 * original colour. Cloning preserves texture maps + UVs.
 */
function cloneMaterial(m: THREE.Material): THREE.MeshStandardMaterial {
  const c = m.clone() as THREE.MeshStandardMaterial;
  if (c.color && c.emissive) {
    c.emissive = c.color.clone();
    c.emissiveIntensity = 0;
  }
  return c;
}

/** Resolve the global material index for a triangle of a (multi-material) mesh. */
function triMaterialIndex(
  geom: THREE.BufferGeometry,
  triLocal: number,
  meshMats: THREE.Material[],
  indexOf: Map<THREE.Material, number>,
): number {
  if (meshMats.length > 1 && geom.groups.length) {
    const vStart = triLocal * 3;
    for (const g of geom.groups) {
      if (vStart >= g.start && vStart < g.start + g.count) {
        return indexOf.get(meshMats[g.materialIndex ?? 0]) ?? 0;
      }
    }
  }
  return indexOf.get(meshMats[0]) ?? 0;
}

/** Flatten every mesh into world-space triangle soup, preserving material + uv. */
function collectTriangles(root: THREE.Object3D): TriangleSoup {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const tmat: number[] = [];
  const materials: THREE.MeshStandardMaterial[] = [];
  const indexOf = new Map<THREE.Material, number>();

  root.updateWorldMatrix(true, true);
  const v = new THREE.Vector3();
  const vn = new THREE.Vector3();

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!(mesh as any).isMesh) return;

    const meshMats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of meshMats) {
      if (!indexOf.has(m)) {
        indexOf.set(m, materials.length);
        materials.push(cloneMaterial(m));
      }
    }

    let g = mesh.geometry as THREE.BufferGeometry;
    g = g.index ? g.toNonIndexed() : g.clone();
    if (!g.getAttribute('normal')) g.computeVertexNormals();

    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const t = g.getAttribute('uv');
    const mw = mesh.matrixWorld;
    const nmat = new THREE.Matrix3().getNormalMatrix(mw);
    const triCount = Math.floor(p.count / 3);

    for (let tri = 0; tri < triCount; tri++) {
      for (let k = 0; k < 3; k++) {
        const i = tri * 3 + k;
        v.fromBufferAttribute(p, i).applyMatrix4(mw);
        pos.push(v.x, v.y, v.z);
        vn.fromBufferAttribute(n, i).applyMatrix3(nmat).normalize();
        nrm.push(vn.x, vn.y, vn.z);
        if (t) uv.push(t.getX(i), t.getY(i));
        else uv.push(0, 0);
      }
      tmat.push(triMaterialIndex(g, tri, meshMats, indexOf));
    }
    g.dispose();
  });

  return { pos, nrm, uv, tmat, materials };
}

/**
 * Shatter a model into `count` fragments by k-means clustering its triangles.
 * Fragments keep each triangle's original material (colour + texture) via
 * geometry groups indexing into the shared cloned-material array.
 */
export function fracture(
  root: THREE.Object3D,
  center: THREE.Vector3,
  count: number,
): { group: THREE.Group; fragments: Fragment[]; materials: THREE.MeshStandardMaterial[] } {
  const group = new THREE.Group();
  const fragments: Fragment[] = [];

  const soup = collectTriangles(root);
  const triCount = soup.tmat.length;
  if (triCount === 0) return { group, fragments, materials: soup.materials };

  const { pos, nrm, uv, tmat, materials } = soup;
  const N = Math.max(1, Math.min(count, triCount));

  // Per-triangle centroids.
  const cen = new Float32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    cen[t * 3] = (pos[o] + pos[o + 3] + pos[o + 6]) / 3;
    cen[t * 3 + 1] = (pos[o + 1] + pos[o + 4] + pos[o + 7]) / 3;
    cen[t * 3 + 2] = (pos[o + 2] + pos[o + 5] + pos[o + 8]) / 3;
  }

  // K-means: strided init, then refine.
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

  // Build one multi-material geometry per non-empty cluster.
  const bands: Band[] = ['low', 'mid', 'high'];
  for (let k = 0; k < N; k++) {
    const tris: number[] = [];
    for (let t = 0; t < triCount; t++) if (assign[t] === k) tris.push(t);
    if (tris.length === 0) continue;
    // Group contiguous runs by material so we can build geometry.groups.
    tris.sort((a, b) => tmat[a] - tmat[b]);

    const verts: number[] = [];
    const norms: number[] = [];
    const uvs: number[] = [];
    const groups: { start: number; count: number; materialIndex: number }[] = [];
    let curMat = -1;
    let runStart = 0;
    let vCount = 0;

    for (const t of tris) {
      if (tmat[t] !== curMat) {
        if (curMat !== -1) groups.push({ start: runStart, count: vCount - runStart, materialIndex: curMat });
        curMat = tmat[t];
        runStart = vCount;
      }
      const o = t * 9;
      const uo = t * 6;
      for (let j = 0; j < 9; j++) {
        verts.push(pos[o + j]);
        norms.push(nrm[o + j]);
      }
      for (let j = 0; j < 6; j++) uvs.push(uv[uo + j]);
      vCount += 3;
    }
    groups.push({ start: runStart, count: vCount - runStart, materialIndex: curMat });

    // Recentre on cluster centroid so the fragment pivots around itself.
    const ctr = new THREE.Vector3(cx[k], cy[k], cz[k]);
    for (let i = 0; i < verts.length; i += 3) {
      verts[i] -= ctr.x;
      verts[i + 1] -= ctr.y;
      verts[i + 2] -= ctr.z;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(norms, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    for (const g of groups) geo.addGroup(g.start, g.count, g.materialIndex);

    const mesh = new THREE.Mesh(geo, materials);
    mesh.position.copy(ctr);
    group.add(mesh);

    const dir = ctr.clone().sub(center);
    if (dir.lengthSq() < 1e-8) dir.set(0, 1, 0);
    dir.normalize();
    const axis = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
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
      vel: new THREE.Vector3(),
      angVel: new THREE.Vector3(),
      resting: true,
    });
  }

  return { group, fragments, materials };
}
