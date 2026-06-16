/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import * as THREE from 'three';
import { Analyser } from './analyser';
import { computeBands } from './audio-bands';
import { commonVertex } from './shaders/common';
import { getShader } from './shader-registry';
import type { Bands, ShaderDef, ShaderRitualConfig } from './types';

/**
 * Renders the active shader as a Shadertoy-style two-pass pipeline:
 *   Buffer A (offscreen render target) -> Image pass (samples it -> screen).
 * Per-element uniforms are refreshed every frame from the live audio bands.
 */
@customElement('shader-ritual-view')
export class ShaderRitualView extends LitElement {
  private analyser!: Analyser;
  private renderer!: THREE.WebGLRenderer;
  private camera!: THREE.OrthographicCamera;
  private bufferScene!: THREE.Scene;
  private imageScene!: THREE.Scene;
  private bufferTarget!: THREE.WebGLRenderTarget;
  private uniforms: Record<string, { value: any }> = {};
  private currentShaderId = '';
  private startTime = performance.now();
  private lastBands: Bands = { low: 0, mid: 0, high: 0, rawLow: 0, rawMid: 0, rawHigh: 0 };
  private canvas!: HTMLCanvasElement;

  @property({ type: Object }) config!: ShaderRitualConfig;

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
      if (this.config.activeShader !== this.currentShaderId) this.buildShader();
      if (this.analyser) this.analyser.smoothing = this.config.fftSmoothing;
    }
  }

  private init() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.bufferScene = new THREE.Scene();
    this.imageScene = new THREE.Scene();
    this.bufferTarget = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
    });

    this.buildShader();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    if (this.analyser) this.analyser.smoothing = this.config.fftSmoothing;
    this.renderLoop();
  }

  /** (Re)build materials and quads for the active shader. */
  private buildShader() {
    const def: ShaderDef = getShader(this.config.activeShader);
    this.currentShaderId = def.id;

    // Dispose previous quads/materials.
    this.disposeScene(this.bufferScene);
    this.disposeScene(this.imageScene);

    // Shared uniform set — both passes read from the same object.
    this.uniforms = {
      iResolution: { value: new THREE.Vector3(1, 1, 1) },
      iTime: { value: 0 },
      iChannel0: { value: this.bufferTarget.texture },
    };
    for (const el of def.elements) {
      this.uniforms[`${el.id}_react`] = { value: 0 };
      this.uniforms[`${el.id}_visible`] = { value: 1 };
    }

    const bufferMat = new THREE.RawShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: commonVertex,
      fragmentShader: def.bufferShader,
    });
    const imageMat = new THREE.RawShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: commonVertex,
      fragmentShader: def.imageShader,
    });

    const quad = new THREE.PlaneGeometry(2, 2);
    this.bufferScene.add(new THREE.Mesh(quad, bufferMat));
    this.imageScene.add(new THREE.Mesh(quad.clone(), imageMat));
    this.resize();
  }

  private disposeScene(scene: THREE.Scene | undefined) {
    if (!scene) return;
    for (const child of [...scene.children]) {
      scene.remove(child);
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
      (mesh.material as THREE.Material)?.dispose();
    }
  }

  private resize() {
    if (!this.renderer) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    const dpr = this.renderer.getPixelRatio();
    this.bufferTarget.setSize(Math.floor(w * dpr), Math.floor(h * dpr));
    (this.uniforms.iResolution.value as THREE.Vector3).set(w * dpr, h * dpr, 1);
  }

  private renderLoop = () => {
    requestAnimationFrame(this.renderLoop);
    if (!this.renderer) return;

    if (this.analyser) {
      this.analyser.update();
      this.lastBands = computeBands(
        this.analyser.data,
        this.config.sensitivity,
        this.config.thresholds,
      );
    }

    const def = getShader(this.config.activeShader);
    const elemCfg = this.config.shaders[def.id]?.elements || {};
    for (const el of def.elements) {
      const c = elemCfg[el.id];
      const bandVal = !c || c.band === 'none' ? 0 : (this.lastBands as any)[c.band];
      this.uniforms[`${el.id}_react`].value = (bandVal || 0) * (c ? c.amount : 0);
      this.uniforms[`${el.id}_visible`].value = c ? (c.visible ? 1 : 0) : 1;
    }

    this.uniforms.iTime.value = (performance.now() - this.startTime) / 1000;

    this.renderer.setRenderTarget(this.bufferTarget);
    this.renderer.render(this.bufferScene, this.camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.imageScene, this.camera);
  };

  protected render() {
    return html`<canvas></canvas>`;
  }
}
