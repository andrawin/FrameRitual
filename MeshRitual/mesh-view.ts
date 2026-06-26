/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Analyser } from './analyser';
import { computeBands } from './audio-bands';
import { decompose, type Part } from './decompose';
import { fracture, type Fragment } from './fracture';
import type { Bands, MeshRitualConfig, PartInfo } from './types';

/**
 * Loads a .glb, decomposes it into parts (and optionally fractures it), then
 * drives each part/fragment from the live audio bands every frame.
 *
 * Emits a `parts-changed` CustomEvent (detail: PartInfo[]) whenever a new model
 * is decomposed, so the host UI can build the per-part menu.
 */
@customElement('mesh-ritual-view')
export class MeshRitualView extends LitElement {
  private analyser!: Analyser;
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private controls!: OrbitControls;
  private composer!: EffectComposer;
  private bloomPass!: UnrealBloomPass;
  private canvas!: HTMLCanvasElement;

  private modelRoot = new THREE.Group();
  private model: THREE.Object3D | null = null;
  private parts: Part[] = [];
  private partMap = new Map<string, Part>();
  private fractureGroup: THREE.Group | null = null;
  private fragments: Fragment[] = [];
  private fractureMaterial: THREE.MeshStandardMaterial | null = null;
  private fragmentCount = 0;
  private modelRadius = 1;
  private baseColor = new THREE.Color(0x8899aa);

  private prevTime = performance.now();
  private currentModelUrl = '';
  private lastBands: Bands = { low: 0, mid: 0, high: 0, rawLow: 0, rawMid: 0, rawHigh: 0 };

  @property({ type: Object }) config!: MeshRitualConfig;

  private _modelUrl = '';
  @property()
  set modelUrl(url: string) {
    this._modelUrl = url;
    if (this.renderer && url !== this.currentModelUrl) this.loadModel(url);
  }
  get modelUrl() {
    return this._modelUrl;
  }

  @property()
  set inputNode(node: AudioNode) {
    this.analyser = new Analyser(node);
  }

  static styles = css`
    canvas {
      width: 100% !important;
      height: 100% !important;
      position: absolute;
      inset: 0;
      display: block;
    }
  `;

  getBandData() {
    return this.lastBands;
  }

  protected firstUpdated() {
    this.canvas = this.shadowRoot!.querySelector('canvas')!;
    this.init();
  }

  updated(changed: Map<string, any>) {
    if (changed.has('config') && this.renderer) {
      if (this.analyser) this.analyser.smoothing = this.config.fftSmoothing;
      if (this.bloomPass) this.bloomPass.strength = this.config.bloom;
      this.syncFracture();
    }
  }

  private init() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05060a);
    this.scene.add(this.modelRoot);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(5, 8, 6);
    this.scene.add(key);

    this.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 2000);
    this.camera.position.set(0, 0, 5);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      this.config?.bloom ?? 0.6,
      0.5,
      0.2,
    );
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());

    this.resize();
    window.addEventListener('resize', () => this.resize());
    if (this.analyser) this.analyser.smoothing = this.config.fftSmoothing;

    if (this._modelUrl) this.loadModel(this._modelUrl);
    this.renderLoop();
  }

  private resize() {
    if (!this.renderer) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private clearModel() {
    for (const child of [...this.modelRoot.children]) {
      this.modelRoot.remove(child);
      child.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
      });
    }
    this.parts = [];
    this.model = null;
    this.partMap.clear();
    this.fractureGroup = null;
    this.fragments = [];
    this.fractureMaterial?.dispose();
    this.fractureMaterial = null;
    this.fragmentCount = 0;
    this.modelRoot.rotation.set(0, 0, 0);
  }

  private async loadModel(url: string) {
    this.currentModelUrl = url;
    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath('https://www.gstatic.com/draco/v1/decoders/');
    loader.setDRACOLoader(draco);

    try {
      const gltf: any = await loader.loadAsync(url);
      this.clearModel();

      const model: THREE.Object3D = gltf.scene;

      // Centre + fit.
      const box = new THREE.Box3().setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      this.modelRadius = Math.max(sphere.radius, 1e-3);
      model.position.sub(center); // centre at modelRoot origin
      this.modelRoot.add(model);
      this.model = model;

      // Frame the camera.
      const fitDist = (this.modelRadius / Math.sin((this.camera.fov * Math.PI) / 360)) * 1.25;
      this.camera.position.set(0, this.modelRadius * 0.2, fitDist);
      this.camera.near = fitDist / 100;
      this.camera.far = fitDist * 100;
      this.camera.updateProjectionMatrix();
      this.controls.target.set(0, 0, 0);
      this.controls.update();

      // Decompose. Note: model already centred at origin, so part centre is origin.
      this.parts = decompose(model, new THREE.Vector3(0, 0, 0));
      this.partMap.clear();
      for (const p of this.parts) this.partMap.set(p.id, p);

      // Pick a base colour for fracture fragments from the first material found.
      const firstMat = this.parts[0]?.materials[0];
      if (firstMat?.color) this.baseColor = firstMat.color.clone();

      this.dispatchEvent(
        new CustomEvent<PartInfo[]>('parts-changed', {
          detail: this.parts.map((p) => ({ id: p.id, name: p.name })),
          bubbles: true,
          composed: true,
        }),
      );

      this.syncFracture();
      this.applyMode();
    } catch (err: any) {
      this.dispatchEvent(
        new CustomEvent('model-error', {
          detail: err?.message || 'Failed to load model',
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  /** Rebuild fracture fragments if the requested count changed. */
  private syncFracture() {
    if (!this.parts.length) return;
    const want = this.config.mode === 'fracture' ? this.config.fracture.fragments : 0;
    if (want === this.fragmentCount && this.fractureGroup) {
      this.applyMode();
      return;
    }
    // Tear down old fracture group.
    if (this.fractureGroup) {
      this.modelRoot.remove(this.fractureGroup);
      this.fractureGroup.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      this.fractureGroup = null;
      this.fragments = [];
      this.fractureMaterial?.dispose();
      this.fractureMaterial = null;
    }
    if (want > 0 && this.model) {
      // Reset parts to their rest transform so fracture reads the model at rest,
      // not mid-animation (parts mode mutates these meshes each frame).
      for (const p of this.parts) {
        p.mesh.position.copy(p.basePosition);
        p.mesh.scale.copy(p.baseScale);
        p.mesh.quaternion.copy(p.baseQuaternion);
      }
      // Build fragments in the model's rest frame (no auto-rotation baked in):
      // fragments are parented to modelRoot and rotate with it afterwards.
      const savedRot = this.modelRoot.rotation.clone();
      this.modelRoot.rotation.set(0, 0, 0);
      this.modelRoot.updateWorldMatrix(true, true);
      const built = fracture(this.model, new THREE.Vector3(), want, this.baseColor);
      this.modelRoot.rotation.copy(savedRot);
      this.fractureGroup = built.group;
      this.fragments = built.fragments;
      this.fractureMaterial = built.material;
      this.modelRoot.add(this.fractureGroup);
    }
    this.fragmentCount = want;
    this.applyMode();
  }

  /** Show parts or fracture depending on mode. */
  private applyMode() {
    const showParts = this.config.mode === 'parts';
    for (const p of this.parts) p.mesh.visible = showParts && (this.config.parts[p.id]?.visible ?? true);
    if (this.fractureGroup) this.fractureGroup.visible = !showParts && this.config.fracture.visible;
  }

  private renderLoop = () => {
    requestAnimationFrame(this.renderLoop);
    if (!this.renderer) return;

    const now = performance.now();
    const dt = Math.min(0.05, (now - this.prevTime) / 1000);
    this.prevTime = now;

    if (this.analyser) {
      this.analyser.update();
      this.lastBands = computeBands(this.analyser.data, this.config.sensitivity, this.config.thresholds);
    }
    const bands = this.lastBands;

    if (this.config.autoRotate) {
      this.modelRoot.rotation.y += dt * this.config.rotateSpeed * 0.5;
    }

    if (this.config.mode === 'parts') this.animateParts(bands, dt);
    else this.animateFracture(bands, dt);

    this.controls.update();
    this.composer.render();
  };

  private animateParts(bands: Bands, dt: number) {
    const k = this.modelRadius;
    for (const part of this.parts) {
      const s = this.config.parts[part.id];
      part.mesh.visible = s ? s.visible : true;
      if (!part.mesh.visible) continue;

      // Reset to base each frame.
      part.mesh.position.copy(part.basePosition);
      part.mesh.scale.copy(part.baseScale);
      part.mesh.quaternion.copy(part.baseQuaternion);
      for (const m of part.materials) m.emissiveIntensity = 0;

      const v = !s || s.band === 'none' ? 0 : (bands as any)[s.band] * s.amount;
      if (v <= 0 && s?.target !== 'rotate') continue;

      switch (s?.target) {
        case 'scale':
          part.mesh.scale.copy(part.baseScale).multiplyScalar(1 + v);
          break;
        case 'explode':
          part.mesh.position.copy(part.basePosition).addScaledVector(part.explodeDir, v * k * 0.6);
          break;
        case 'emissive':
          for (const m of part.materials) m.emissiveIntensity = v * 2.5;
          break;
        case 'rotate':
          part.spin += v * dt * 4;
          part.mesh.quaternion.copy(part.baseQuaternion);
          part.mesh.rotateY(part.spin);
          break;
      }
    }
  }

  private animateFracture(bands: Bands, dt: number) {
    if (!this.fractureGroup) return;
    const f = this.config.fracture;
    this.fractureGroup.visible = f.visible;
    if (!f.visible) return;

    const k = this.modelRadius;
    const val = (b: string, amt: number) => (b === 'none' ? 0 : (bands as any)[b] * amt);

    let emissive = 0;
    for (const frag of this.fragments) {
      const explodeBand = f.distribute ? frag.band : f.explodeBand;
      const scaleBand = f.distribute ? frag.band : f.scaleBand;

      const ex = val(explodeBand, f.explodeAmount);
      const sc = val(scaleBand, f.scaleAmount);
      const sp = val(f.spinBand, f.spinAmount);

      frag.mesh.position
        .copy(frag.base)
        .addScaledVector(frag.dir, ex * k * (0.6 + frag.phase * 0.8));
      frag.mesh.scale.setScalar(1 + sc);
      frag.spin += sp * dt * (2 + frag.phase * 3);
      frag.mesh.quaternion.setFromAxisAngle(frag.axis, frag.spin);
      emissive = Math.max(emissive, ex, sc);
    }
    if (this.fractureMaterial) this.fractureMaterial.emissiveIntensity = emissive * 2.0;
  }

  protected render() {
    return html`<canvas></canvas>`;
  }
}
