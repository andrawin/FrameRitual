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
  private fractureMaterials: THREE.MeshStandardMaterial[] = [];
  private fragmentCount = 0;
  private modelRadius = 1;

  private captureMesh!: THREE.Mesh;
  private captureTexture: THREE.VideoTexture | null = null;
  private captureVideo: HTMLVideoElement | null = null;

  private prevTime = performance.now();
  private currentModelUrl = '';

  // Physics state.
  private prevBeatVal = 0;
  private lastBeat = 0;
  private imploding = false;
  private beatToggle = false;
  private pulseImplodeAt = 0;
  private physicsWasEnabled = false;
  private readonly IDENTITY = new THREE.Quaternion();
  private tmpVec = new THREE.Vector3();
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

  private _captureStream: MediaStream | null = null;
  @property()
  set captureStream(stream: MediaStream | null) {
    if (this._captureStream === stream) return;
    this._captureStream = stream;
    if (this.renderer) this.initCapture();
  }
  get captureStream() {
    return this._captureStream;
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
      // Reset fragments to rest when physics is first switched on.
      const pe = this.config.fracture.physics?.enabled ?? false;
      if (pe && !this.physicsWasEnabled) this.reset();
      this.physicsWasEnabled = pe;
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
    // Camera is in the scene graph so a camera-attached capture plane renders.
    this.scene.add(this.camera);

    this.captureMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 1, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.captureMesh.visible = false;
    this.scene.add(this.captureMesh);

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

    if (this._captureStream) this.initCapture();
    if (this._modelUrl) this.loadModel(this._modelUrl);
    this.renderLoop();
  }

  private async initCapture() {
    const mat = this.captureMesh.material as THREE.MeshBasicMaterial;
    if (this.captureVideo) {
      this.captureVideo.pause();
      this.captureVideo.srcObject = null;
      this.captureVideo = null;
    }
    if (this.captureTexture) {
      this.captureTexture.dispose();
      this.captureTexture = null;
    }
    if (this._captureStream) {
      const video = document.createElement('video');
      video.srcObject = this._captureStream;
      video.muted = true;
      video.playsInline = true;
      video.autoplay = true;
      this.captureVideo = video;
      try {
        await video.play();
      } catch (e) {}
      this.captureTexture = new THREE.VideoTexture(video);
      this.captureTexture.colorSpace = THREE.SRGBColorSpace;
      this.captureTexture.minFilter = THREE.LinearFilter;
      this.captureTexture.magFilter = THREE.LinearFilter;
      mat.map = this.captureTexture;
      mat.needsUpdate = true;
    } else {
      mat.map = null;
      mat.needsUpdate = true;
      this.captureMesh.visible = false;
    }
  }

  private captureAspect(): number {
    const w = this.captureVideo?.videoWidth || 16;
    const h = this.captureVideo?.videoHeight || 9;
    return h > 0 ? w / h : 16 / 9;
  }

  private applyCapture(bands: Bands) {
    if (!this.captureMesh) return;
    const c = this.config.capture;
    if (!c) return;
    const mat = this.captureMesh.material as THREE.MeshBasicMaterial;
    this.captureMesh.visible = !!this.captureTexture && c.visible && c.opacity > 0;
    if (!this.captureMesh.visible) return;

    mat.opacity = c.opacity;
    const react = c.reactive ? 1 + (bands as any)[c.reactiveBand] * 0.2 : 1;

    if (c.mode === 'background') {
      if (this.captureMesh.parent !== this.camera) this.camera.add(this.captureMesh);
      const dist = this.camera.far * 0.5;
      const h = 2 * Math.tan((this.camera.fov * Math.PI) / 360) * dist;
      const w = h * this.camera.aspect;
      this.captureMesh.position.set(0, 0, -dist);
      this.captureMesh.quaternion.identity();
      this.captureMesh.scale.set(w * c.scale * react, h * c.scale * react, 1);
    } else {
      if (this.captureMesh.parent !== this.scene) this.scene.add(this.captureMesh);
      const base = this.modelRadius * 2.2 * c.scale * react;
      this.captureMesh.position.set(0, 0, 0);
      this.captureMesh.quaternion.copy(this.camera.quaternion); // billboard toward camera
      this.captureMesh.scale.set(base, base / this.captureAspect(), 1);
    }
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
    for (const m of this.fractureMaterials) m.dispose();
    this.fractureMaterials = [];
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
      for (const m of this.fractureMaterials) m.dispose();
      this.fractureMaterials = [];
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
      const built = fracture(this.model, new THREE.Vector3(), want);
      this.modelRoot.rotation.copy(savedRot);
      this.fractureGroup = built.group;
      this.fragments = built.fragments;
      this.fractureMaterials = built.materials;
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

    // Manual model size (scales parts + fragments uniformly).
    this.modelRoot.scale.setScalar(this.config.modelScale ?? 1);

    const physicsActive =
      this.config.mode === 'fracture' && this.config.fracture.physics?.enabled && !!this.fractureGroup;

    // Physics needs a non-rotating model frame so gravity stays "down".
    if (physicsActive) {
      this.modelRoot.rotation.set(0, 0, 0);
    } else if (this.config.autoRotate) {
      this.modelRoot.rotation.y += dt * this.config.rotateSpeed * 0.5;
    }

    if (this.config.mode === 'parts') {
      this.animateParts(bands, dt);
    } else if (physicsActive) {
      this.detectBeat(bands);
      if (this.pulseImplodeAt && now >= this.pulseImplodeAt) {
        this.implode();
        this.pulseImplodeAt = 0;
      }
      this.animateFracturePhysics(bands, dt);
    } else {
      this.animateFracture(bands, dt);
    }

    this.applyCapture(bands);

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
    for (const m of this.fractureMaterials) m.emissiveIntensity = emissive * 2.0;
  }

  /* --------------------------- Physics --------------------------- */

  /** Fire an action on the rising edge of the trigger band past its threshold. */
  private detectBeat(bands: Bands) {
    const p = this.config.fracture.physics;
    const v = (bands as any)[p.beatBand] ?? 0;
    const now = performance.now();
    if (v > p.beatThreshold && this.prevBeatVal <= p.beatThreshold && now - this.lastBeat > 120) {
      this.lastBeat = now;
      switch (p.beatAction) {
        case 'burst':
          this.burst();
          break;
        case 'implode':
          this.implode();
          break;
        case 'pulse':
          this.burst();
          this.pulseImplodeAt = now + 350;
          break;
        case 'alternate':
          this.beatToggle = !this.beatToggle;
          this.beatToggle ? this.burst() : this.implode();
          break;
      }
    }
    this.prevBeatVal = v;
  }

  /** Launch every fragment outward + upward with random tumble. Manual or beat. */
  burst() {
    if (!this.fragments.length) return;
    const p = this.config.fracture.physics;
    const r = this.modelRadius;
    this.imploding = false;
    for (const f of this.fragments) {
      f.resting = false;
      const lateral = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.3, Math.random() - 0.5).multiplyScalar(0.5 * r);
      f.vel.copy(f.dir).multiplyScalar(p.burstStrength * r * (1.2 + f.phase)).add(lateral);
      f.vel.y += p.burstStrength * r * 0.8;
      f.angVel.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(p.spin * (1 + f.phase) * 3);
    }
  }

  /** Spring every fragment back toward its rest position. Manual or beat. */
  implode() {
    if (!this.fragments.length) return;
    this.imploding = true;
    for (const f of this.fragments) f.resting = false;
  }

  /** Instantly snap all fragments back to rest. Manual reset. */
  reset() {
    this.imploding = false;
    this.pulseImplodeAt = 0;
    for (const f of this.fragments) {
      f.mesh.position.copy(f.base);
      f.mesh.quaternion.copy(this.IDENTITY);
      f.mesh.scale.setScalar(1);
      f.vel.set(0, 0, 0);
      f.angVel.set(0, 0, 0);
      f.resting = true;
    }
  }

  private animateFracturePhysics(bands: Bands, dt: number) {
    if (!this.fractureGroup) return;
    const f2 = this.config.fracture;
    const p = f2.physics;
    this.fractureGroup.visible = f2.visible;
    if (!f2.visible) return;

    const r = this.modelRadius;
    const g = p.gravity * r * 3.0;
    const floorY = -r;
    const val = (b: string, amt: number) => (b === 'none' ? 0 : (bands as any)[b] * amt);

    let maxSc = 0;
    let active = 0;

    for (const f of this.fragments) {
      // Scale stays audio-reactive even while the body simulates.
      const scaleBand = f2.distribute ? f.band : f2.scaleBand;
      const sc = val(scaleBand, f2.scaleAmount);
      f.mesh.scale.setScalar(1 + sc);
      maxSc = Math.max(maxSc, sc);

      if (f.resting && !this.imploding) continue;
      active++;

      if (this.imploding) {
        this.tmpVec.copy(f.base).sub(f.mesh.position);
        f.vel.addScaledVector(this.tmpVec, p.implodeStrength * dt);
        f.vel.multiplyScalar(Math.max(0, 1 - 4 * dt));
        f.mesh.position.addScaledVector(f.vel, dt);
        f.mesh.quaternion.slerp(this.IDENTITY, Math.min(1, 6 * dt));
        f.angVel.multiplyScalar(Math.max(0, 1 - 6 * dt));
        if (this.tmpVec.length() < 0.02 * r && f.vel.length() < 0.05 * r) {
          f.mesh.position.copy(f.base);
          f.mesh.quaternion.copy(this.IDENTITY);
          f.vel.set(0, 0, 0);
          f.angVel.set(0, 0, 0);
          f.resting = true;
        }
      } else {
        f.vel.y -= g * dt;
        f.vel.multiplyScalar(Math.max(0, 1 - 0.2 * dt)); // mild air drag
        f.mesh.position.addScaledVector(f.vel, dt);

        const sp = f.angVel.length();
        if (sp > 1e-5) {
          const dq = new THREE.Quaternion().setFromAxisAngle(this.tmpVec.copy(f.angVel).normalize(), sp * dt);
          f.mesh.quaternion.premultiply(dq);
        }

        if (p.floor && f.mesh.position.y < floorY) {
          f.mesh.position.y = floorY;
          f.vel.y *= -p.restitution;
          f.vel.x *= 0.78;
          f.vel.z *= 0.78;
          f.angVel.multiplyScalar(0.78);
          if (Math.abs(f.vel.y) < 0.05 * r) f.vel.y = 0;
          if (f.vel.lengthSq() < (0.01 * r) * (0.01 * r)) {
            f.vel.set(0, 0, 0);
            f.angVel.multiplyScalar(0.5);
            f.resting = true;
          }
        }
      }
    }

    if (this.imploding && active === 0) this.imploding = false;
    for (const m of this.fractureMaterials) m.emissiveIntensity = maxSc * 2.0;
  }

  protected render() {
    return html`<canvas></canvas>`;
  }
}
