
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {LitElement, css, html} from 'lit';
import {customElement, property} from 'lit/decorators.js';
import {Analyser} from './analyser';
import * as THREE from 'three';

import {EXRLoader} from 'three/examples/jsm/loaders/EXRLoader.js';
import {EffectComposer} from 'three/examples/jsm/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/examples/jsm/postprocessing/RenderPass.js';
import {UnrealBloomPass} from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import {vs as sphereVS} from './sphere-shader';
import {vs as videoVS, fs as videoFS} from './video-shader';

export type VisualShape = 'stump' | 'sphere' | 'cube' | 'ring' | 'dna' | 'takraw' | 'spiral' | 'knot' | 'hourglass' | 'spikey' | 'cyber';
export type VideoFilter = 'normal' | 'invert' | 'glitch' | 'pixelate' | 'edge' | 'blob';
export type ModulationSource = 'bass' | 'mid' | 'high' | 'none';

export interface VisualConfig {
  fftSmoothing: number;
  sensitivity: {
    sphere: number;
    bass: number;
    mid: number;
    high: number;
    orbBass: number;
    orbMid: number;
    orbHigh: number;
  };
  modulation: {
    bassThreshold: number;
    midThreshold: number;
    highThreshold: number;
    orbBassThreshold: number;
    orbMidThreshold: number;
    orbHighThreshold: number;
    orbSize: ModulationSource;
    orbSizeAmt: number;
    videoFilterIntensity: ModulationSource;
    videoFilterAmt: number;
  };
  colors: {
    sphere: string;
    background: string;
  };
  reactivity: {
    colorCycle: boolean;
    rotationSpeed: number;
    orbRotation: boolean;
  };
  orbShape: VisualShape;
  orbVisible: boolean;
  orbSize: number;
  image: { url: string, target: 'none' | 'orb' | 'background' };
  video: { url: string, filter: VideoFilter, opacity: number, scale: number, mode: 'background' | 'floating' };
  capture: { opacity: number, scale: number, blendMode: string, mode: 'background' | 'floating', reactive: boolean };
  text: { content: string, color: string, size: number, speed: number, visible: boolean, reactive: boolean, depth: number, curvature: number, scroll: boolean };
}

@customElement('gdm-live-audio-visuals-3d')
export class GdmLiveAudioVisuals3D extends LitElement {
  private inputAnalyser!: Analyser;
  private outputAnalyser!: Analyser;
  private camera!: THREE.PerspectiveCamera;
  private scene!: THREE.Scene;
  private renderer!: THREE.WebGLRenderer;
  
  private captureMesh!: THREE.Mesh;
  private captureTexture: THREE.VideoTexture | null = null;
  private captureVideo: HTMLVideoElement | null = null;
  private videoMesh!: THREE.Mesh;
  private videoTexture: THREE.VideoTexture | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private textMesh!: THREE.Mesh;
  private textCanvas = document.createElement('canvas');
  private textCtx = this.textCanvas.getContext('2d');
  private textTexture!: THREE.CanvasTexture;
  private audioTexture!: THREE.DataTexture;
  private composer!: EffectComposer;
  private sphere!: THREE.Mesh;
  private miniOrbs: THREE.Mesh[] = [];
  private sphereMaterial!: THREE.MeshStandardMaterial;
  private prevTime = 0;
  private rotation = new THREE.Vector3(0, 0, 0);
  private currentOrbShape: VisualShape = 'sphere';
  private lastBands = { bass: 0, mid: 0, high: 0 };
  private textureLoader = new THREE.TextureLoader();
  private loadedTexture: THREE.Texture | null = null;
  private currentImageUrl = '';
  private currentImageTarget = '';
  private currentVideoUrl = '';
  private textScrollOffset = 0;

  @property({type: Object})
  config: VisualConfig = {
    fftSmoothing: 0,
    sensitivity: {sphere: 1, bass: 1.5, mid: 1.5, high: 2.5, orbBass: 1.2, orbMid: 1.5, orbHigh: 2.0},
    modulation: {
      bassThreshold: 0.2, midThreshold: 0.2, highThreshold: 0.2,
      orbBassThreshold: 0.2, orbMidThreshold: 0.2, orbHighThreshold: 0.2,
      orbSize: 'bass', orbSizeAmt: 1.0,
      videoFilterIntensity: 'bass', videoFilterAmt: 1.0
    },
    colors: {sphere: '#000010', background: '#000000'},
    reactivity: {colorCycle: false, rotationSpeed: 1, orbRotation: false},
    orbShape: 'sphere', orbVisible: true, orbSize: 1.0,
    image: { url: '', target: 'none' },
    video: { url: '', filter: 'normal', opacity: 0.5, scale: 1.0, mode: 'background' },
    capture: { opacity: 0.5, scale: 1.0, blendMode: 'normal', mode: 'background', reactive: true },
    text: { content: '', color: '#ffffff', size: 1.0, speed: 1.0, visible: false, reactive: true, depth: 0.5, curvature: 0.5, scroll: false }
  };

  private _captureStream: MediaStream | null = null;
  @property()
  set captureStream(stream: MediaStream | null) {
      if (this._captureStream === stream) return;
      this._captureStream = stream;
      this.initCapture();
  }
  get captureStream() { return this._captureStream; }

  private _videoStream: MediaStream | null = null;
  @property()
  set videoStream(stream: MediaStream | null) {
      if (this._videoStream === stream) return;
      this._videoStream = stream;
      this.initVideo();
  }
  get videoStream() { return this._videoStream; }

  @property()
  set outputNode(node: AudioNode) {
    this.outputAnalyser = new Analyser(node);
  }

  @property()
  set inputNode(node: AudioNode) {
    this.inputAnalyser = new Analyser(node);
  }

  private canvas!: HTMLCanvasElement;

  static styles = css`
    canvas {
      width: 100% !important; height: 100% !important; position: absolute; inset: 0; image-rendering: pixelated;
    }
  `;

  updated(changedProperties: Map<string, any>) {
    if (changedProperties.has('config')) this.updateConfig();
  }

  getBandData() { return this.lastBands; }

  private async initCapture() {
      if (!this.renderer) return;
      if (this.captureVideo) { this.captureVideo.pause(); this.captureVideo.srcObject = null; this.captureVideo = null; }
      if (this.captureTexture) { this.captureTexture.dispose(); this.captureTexture = null; }
      if (this._captureStream) {
          const video = document.createElement('video');
          video.srcObject = this._captureStream; video.muted = true; video.playsInline = true; video.crossOrigin = 'anonymous'; video.autoplay = true;
          this.captureVideo = video;
          try { await video.play(); } catch (err) {}
          this.captureTexture = new THREE.VideoTexture(video);
          this.captureTexture.minFilter = THREE.LinearFilter; this.captureTexture.magFilter = THREE.LinearFilter;
          if (this.captureMesh) (this.captureMesh.material as THREE.MeshBasicMaterial).map = this.captureTexture;
      } else if (this.captureMesh) (this.captureMesh.material as THREE.MeshBasicMaterial).map = null;
  }

  private async initVideo() {
      if (!this.renderer) return;
      if (this.videoElement) { this.videoElement.pause(); this.videoElement.srcObject = null; this.videoElement.src = ''; this.videoElement = null; }
      if (this.videoTexture) { this.videoTexture.dispose(); this.videoTexture = null; }
      
      const video = document.createElement('video');
      video.muted = true; video.playsInline = true; video.crossOrigin = 'anonymous'; video.autoplay = true;
      video.loop = true;
      
      if (this._videoStream) {
          video.srcObject = this._videoStream;
      } else if (this.config.video.url) {
          video.src = this.config.video.url;
      } else {
          if (this.videoMesh) (this.videoMesh.material as THREE.ShaderMaterial).uniforms.map.value = null;
          return;
      }
      
      this.videoElement = video;
      try { await video.play(); } catch (err) {}
      this.videoTexture = new THREE.VideoTexture(video);
      this.videoTexture.minFilter = THREE.LinearFilter; this.videoTexture.magFilter = THREE.LinearFilter;
      if (this.videoMesh) (this.videoMesh.material as THREE.ShaderMaterial).uniforms.map.value = this.videoTexture;
  }

  private updateConfig() {
    if (!this.renderer || !this.outputAnalyser) return;
    
    this.outputAnalyser.smoothing = this.config.fftSmoothing;
    if (this.inputAnalyser) this.inputAnalyser.smoothing = this.config.fftSmoothing;
    
    if (this.config.orbShape !== this.currentOrbShape) this.initOrbGeometry();
    
    if (this.config.image.url !== this.currentImageUrl) {
        this.currentImageUrl = this.config.image.url;
        if (this.currentImageUrl) {
            this.textureLoader.load(this.currentImageUrl, (tex) => { 
                tex.colorSpace = THREE.SRGBColorSpace; 
                this.loadedTexture = tex; 
                this.applyTexture(); 
            });
        } else { 
            this.loadedTexture = null; 
            this.applyTexture(); 
        }
    } else if (this.config.image.target !== this.currentImageTarget) {
        this.applyTexture();
    }

    if (this.config.video.url !== this.currentVideoUrl) {
        this.currentVideoUrl = this.config.video.url;
        if (!this._videoStream) this.initVideo();
    }

    if (this.textMesh && this.config.text.visible) this.updateTextCanvas();

    if (this.captureMesh) {
        this.captureMesh.visible = (this.captureTexture !== null && this.config.capture.opacity > 0);
        if (this.config.capture.mode === 'background') {
            if (this.captureMesh.parent !== this.camera) this.camera.add(this.captureMesh);
        } else {
            if (this.captureMesh.parent !== this.scene) this.scene.add(this.captureMesh);
        }
    }

    if (this.videoMesh) {
        this.videoMesh.visible = (this.videoTexture !== null && this.config.video.opacity > 0);
        if (this.config.video.mode === 'background') {
            if (this.videoMesh.parent !== this.camera) this.camera.add(this.videoMesh);
        } else {
            if (this.videoMesh.parent !== this.scene) this.scene.add(this.videoMesh);
        }
    }

    if (this.sphereMaterial) {
        this.sphereMaterial.color.set(this.config.colors.sphere);
        // Keep emissive very dark so it doesn't wash out the chrome reflections
        this.sphereMaterial.emissive.set(this.config.colors.sphere).multiplyScalar(0.1);
    }
  }

  private applyTexture() {
      if (!this.renderer) return;
      this.currentImageTarget = this.config.image.target;
      const target = this.config.image.target, tex = this.loadedTexture;
      if (this.sphereMaterial) { this.sphereMaterial.map = tex && target === 'orb' ? tex : null; this.sphereMaterial.needsUpdate = true; }
      if (target === 'background' && tex) this.scene.background = tex;
      else this.scene.background = new THREE.Color(this.config.colors.background);
  }

  private updateTextCanvas() {
      if (!this.textCtx || !this.textTexture) return;
      const ctx = this.textCtx;
      const content = (this.config.text.content || '').toUpperCase();
      this.textCanvas.width = 1024;
      this.textCanvas.height = 128;
      ctx.clearRect(0, 0, 1024, 128);
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${64 * this.config.text.size}px "Segoe UI", sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.shadowColor = '#ffffff'; ctx.shadowBlur = 1;
      ctx.fillText(content, 512, 64);
      this.textTexture.needsUpdate = true;
  }

  private init() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000); 
    this.scene.fog = new THREE.FogExp2(0x000000, 0.02);
    
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    this.scene.add(ambientLight);
    const dirLight = new THREE.DirectionalLight(0xffffff, 2.0);
    dirLight.position.set(5, 5, 5);
    this.scene.add(dirLight);
    const dirLight2 = new THREE.DirectionalLight(0xffffff, 1.0);
    dirLight2.position.set(-5, -5, -5);
    this.scene.add(dirLight2);
    
    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    this.camera.position.set(0, 0, 10);
    this.scene.add(this.camera);

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    
    this.audioTexture = new THREE.DataTexture(new Uint8Array(1024), 1024, 1, THREE.RedFormat); 

    this.initCaptureMesh(); 
    this.initVideoMesh();
    this.initTextOverlay();

    this.sphereMaterial = new THREE.MeshStandardMaterial({ color: 0x000010, metalness: 1.0, roughness: 0.0, emissive: 0x000010, emissiveIntensity: 1.5, envMapIntensity: 2.0 });
    this.sphereMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.time = {value: 0}; shader.uniforms.outputData = {value: new THREE.Vector4()};
      this.sphereMaterial.userData.shader = shader; shader.vertexShader = sphereVS;
    };
    
    new EXRLoader().load('/piz_compressed.exr', (texture: THREE.Texture) => {
        texture.mapping = THREE.EquirectangularReflectionMapping;
        const pmremGenerator = new THREE.PMREMGenerator(this.renderer); 
        const exrCubeRenderTarget = pmremGenerator.fromEquirectangular(texture);
        this.scene.environment = exrCubeRenderTarget.texture;
        if (this.sphereMaterial) {
            this.sphereMaterial.envMap = exrCubeRenderTarget.texture;
            this.sphereMaterial.needsUpdate = true;
        }
    });

    this.initOrbGeometry();
    this.composer = new EffectComposer(this.renderer); 
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.5, 0.4, 0.2));
    
    window.addEventListener('resize', () => { 
        this.camera.aspect = window.innerWidth / window.innerHeight; 
        this.camera.updateProjectionMatrix(); 
        this.renderer.setSize(window.innerWidth, window.innerHeight); 
        this.composer.setSize(window.innerWidth, window.innerHeight); 
    });
    
    this.animation();
  }

  private initVideoMesh() {
      const mat = new THREE.ShaderMaterial({
          uniforms: {
              map: { value: null },
              time: { value: 0 },
              bass: { value: 0 },
              mid: { value: 0 },
              high: { value: 0 },
              filterType: { value: 0 },
              filterIntensity: { value: 0 },
              opacity: { value: 1.0 }
          },
          vertexShader: videoVS,
          fragmentShader: videoFS,
          transparent: true,
          side: THREE.DoubleSide,
          depthWrite: false
      });
      this.videoMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      this.videoMesh.visible = false;
      this.scene.add(this.videoMesh);
  }

  private initCaptureMesh() {
    this.captureMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ transparent: true, opacity: 1, side: THREE.DoubleSide, depthWrite: false }));
    this.captureMesh.visible = false; this.scene.add(this.captureMesh);
  }

  private initOrbGeometry() {
      if (this.sphere) { this.scene.remove(this.sphere); this.sphere.geometry.dispose(); }
      this.miniOrbs.forEach(o => { this.scene.remove(o); o.geometry.dispose(); });
      this.miniOrbs = [];

      let geo: THREE.BufferGeometry;
      switch (this.config.orbShape) {
          case 'cube': geo = new THREE.BoxGeometry(2, 2, 2, 32, 32, 32); break;
          case 'ring': geo = new THREE.TorusGeometry(1.5, 0.4, 32, 100); break;
          case 'dna': geo = new THREE.TorusKnotGeometry(1, 0.3, 100, 16, 2, 3); break;
          case 'takraw': geo = new THREE.IcosahedronGeometry(1.5, 2); break;
          case 'spiral': geo = new THREE.TorusKnotGeometry(1.2, 0.4, 100, 16, 3, 7); break;
          case 'knot': geo = new THREE.TorusKnotGeometry(1.2, 0.4, 100, 16); break;
          case 'hourglass': geo = new THREE.CylinderGeometry(1.5, 1.5, 3, 32, 32, false, 0, Math.PI * 2); break;
          case 'spikey': geo = new THREE.OctahedronGeometry(1.5, 0); break;
          case 'cyber': geo = new THREE.DodecahedronGeometry(1.5, 1); break;
          case 'sphere': default: geo = new THREE.SphereGeometry(1.5, 64, 64); break;
      }
      this.sphere = new THREE.Mesh(geo, this.sphereMaterial);
      this.scene.add(this.sphere);
      this.currentOrbShape = this.config.orbShape;

      for (let i = 0; i < 3; i++) {
          const miniOrb = new THREE.Mesh(geo, this.sphereMaterial);
          this.scene.add(miniOrb);
          this.miniOrbs.push(miniOrb);
      }
  }

  private initTextOverlay() {
      this.textTexture = new THREE.CanvasTexture(this.textCanvas);
      this.textTexture.minFilter = THREE.LinearFilter;
      this.textTexture.magFilter = THREE.LinearFilter;
      
      const mat = new THREE.ShaderMaterial({
          uniforms: {
              map: { value: this.textTexture },
              time: { value: 0 },
              scrollOffset: { value: 0 },
              depth: { value: 0.5 },
              curvature: { value: 0.5 },
              color: { value: new THREE.Color(0xffffff) }
          },
          vertexShader: `
              varying vec2 vUv;
              uniform float time;
              uniform float depth;
              uniform float curvature;
              void main() {
                  vUv = uv;
                  vec3 pos = position;
                  float curve = sin(uv.x * 3.14159) * curvature;
                  pos.z += curve * 10.0;
                  pos.z += sin(time * 2.0 + uv.x * 10.0) * depth * 2.0;
                  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
              }
          `,
          fragmentShader: `
              uniform sampler2D map;
              uniform float scrollOffset;
              uniform vec3 color;
              varying vec2 vUv;
              void main() {
                  vec2 uv = vUv;
                  uv.x = fract(uv.x + scrollOffset);
                  vec4 texColor = texture2D(map, uv);
                  gl_FragColor = vec4(color * texColor.rgb, texColor.a);
              }
          `,
          transparent: true,
          side: THREE.DoubleSide,
          depthWrite: false,
          blending: THREE.AdditiveBlending
      });
      
      this.textMesh = new THREE.Mesh(new THREE.PlaneGeometry(20, 2.5, 64, 1), mat);
      this.textMesh.position.set(0, -3, 2);
      this.scene.add(this.textMesh);
      this.updateTextCanvas();
  }

  private animation() {
    requestAnimationFrame(() => this.animation());
    if (!this.renderer) return;
    
    if (this.outputAnalyser) this.outputAnalyser.update();
    const t = performance.now(); const dt = (t - this.prevTime) / 16.6; this.prevTime = t;
    
    let b=0, m=0, h=0;
    if (this.outputAnalyser) {
        const d = this.outputAnalyser.data;
        for(let i=0; i<1024; i++) { 
            let v = d[i] * (i < 20 ? this.config.sensitivity.bass : (i < 100 ? this.config.sensitivity.mid : this.config.sensitivity.high)); 
            this.audioTexture.image.data[i]=Math.min(255,v); 
        } 
        this.audioTexture.needsUpdate = true;
        let bSum=0, mSum=0, hSum=0;
        for(let i=1; i<=7; i++) bSum += d[i]; b = bSum / 7;
        for(let i=8; i<=93; i++) mSum += d[i]; m = mSum / 86;
        for(let i=94; i<=465; i++) hSum += d[i]; h = (hSum / 372) * 3.5;
    }

    const rawB = b / 255.0; const rawM = m / 255.0; const rawH = h / 255.0;
    this.lastBands = { bass: Math.min(1.0, rawB * this.config.sensitivity.bass), mid: Math.min(1.0, rawM * this.config.sensitivity.mid), high: Math.min(1.0, rawH * this.config.sensitivity.high) };

    const nB = Math.max(0, this.lastBands.bass - this.config.modulation.bassThreshold) / (1.0 - Math.max(0.01, this.config.modulation.bassThreshold));
    const nM = Math.max(0, this.lastBands.mid - this.config.modulation.midThreshold) / (1.0 - Math.max(0.01, this.config.modulation.midThreshold));
    const nH = Math.max(0, this.lastBands.high - this.config.modulation.highThreshold) / (1.0 - Math.max(0.01, this.config.modulation.highThreshold));
    const oB = Math.max(0, rawB * this.config.sensitivity.orbBass - this.config.modulation.orbBassThreshold) / (1.0 - Math.max(0.01, this.config.modulation.orbBassThreshold));
    const oM = Math.max(0, rawM * this.config.sensitivity.orbMid - this.config.modulation.orbMidThreshold) / (1.0 - Math.max(0.01, this.config.modulation.orbMidThreshold));
    const oH = Math.max(0, rawH * this.config.sensitivity.orbHigh - this.config.modulation.orbHighThreshold) / (1.0 - Math.max(0.01, this.config.modulation.orbHighThreshold));
    
    const getMod = (src: ModulationSource, amt: number) => {
        if (src === 'bass') return nB * amt; if (src === 'mid') return nM * amt; if (src === 'high') return nH * amt; return 0;
    };

    // Uniform Updates
    if (this.sphere && this.sphere.visible) {
        const scaleFactor = (1.0 + getMod(this.config.modulation.orbSize, this.config.modulation.orbSizeAmt));
        this.sphere.scale.setScalar(this.config.orbSize * scaleFactor);
        if (this.config.reactivity.orbRotation) this.sphere.rotation.y += (0.001 * this.config.reactivity.rotationSpeed) * dt;
        if (this.sphereMaterial.userData.shader) { this.sphereMaterial.userData.shader.uniforms.time.value = t * 0.001; this.sphereMaterial.userData.shader.uniforms.outputData.value.set(oB, oM, oH, 0); }
        this.miniOrbs.forEach((orb, i) => {
            const orbitRadius = 3.5 * this.config.orbSize;
            if (i === 0) orb.position.set(Math.cos(t*0.0015) * orbitRadius, 0, Math.sin(t*0.0015) * orbitRadius);
            if (i === 1) orb.position.set(0, Math.sin(t*0.0018+1.0) * orbitRadius, Math.cos(t*0.0018+1.0) * orbitRadius);
            if (i === 2) { const angle = t*0.0012 + 2.0; orb.position.set(Math.cos(angle) * orbitRadius, Math.sin(angle) * orbitRadius, Math.sin(angle) * 0.5 * orbitRadius); }
            orb.scale.setScalar(this.config.orbSize * 0.08 * scaleFactor);
            if (this.config.reactivity.orbRotation) orb.rotation.y += 0.01 * dt;
        });
    }

    if (this.captureMesh && this.captureMesh.visible) {
        const mat = this.captureMesh.material as THREE.MeshBasicMaterial; mat.opacity = this.config.capture.opacity;
        const capScale = this.config.capture.scale * (this.config.capture.reactive ? (1.0 + nB * 0.15) : 1.0);
        if (this.config.capture.mode === 'background') {
            const h = 2 * Math.tan((this.camera.fov * Math.PI / 180) / 2) * 49; const w = h * this.camera.aspect;
            this.captureMesh.position.set(0, 0, -49); this.captureMesh.scale.set(w * capScale, h * capScale, 1);
        } else {
            this.captureMesh.position.set(0, 0, 0.1); this.captureMesh.scale.set(1.6 * 4 * capScale, 0.9 * 4 * capScale, 1);
        }
    }

    if (this.videoMesh && this.videoMesh.visible) {
        const mat = this.videoMesh.material as THREE.ShaderMaterial;
        mat.uniforms.time.value = t * 0.001;
        mat.uniforms.bass.value = nB;
        mat.uniforms.mid.value = nM;
        mat.uniforms.high.value = nH;
        
        let filterType = 0;
        if (this.config.video.filter === 'invert') filterType = 1;
        else if (this.config.video.filter === 'glitch') filterType = 2;
        else if (this.config.video.filter === 'pixelate') filterType = 3;
        else if (this.config.video.filter === 'edge') filterType = 4;
        else if (this.config.video.filter === 'blob') filterType = 5;
        
        mat.uniforms.filterType.value = filterType;
        mat.uniforms.filterIntensity.value = getMod(this.config.modulation.videoFilterIntensity, this.config.modulation.videoFilterAmt);
        mat.uniforms.opacity.value = this.config.video.opacity;

        const capScale = this.config.video.scale;
        if (this.config.video.mode === 'background') {
            const h = 2 * Math.tan((this.camera.fov * Math.PI / 180) / 2) * 50; const w = h * this.camera.aspect;
            this.videoMesh.position.set(0, 0, -50); this.videoMesh.scale.set(w * capScale, h * capScale, 1);
        } else {
            this.videoMesh.position.set(0, 0, 0); this.videoMesh.scale.set(1.6 * 4 * capScale, 0.9 * 4 * capScale, 1);
        }
    }

    if (this.textMesh && this.textMesh.visible) {
        const mat = this.textMesh.material as THREE.ShaderMaterial; mat.uniforms.time.value = t * 0.001;
        if (this.config.text.scroll) { this.textScrollOffset += 0.001 * this.config.text.speed * dt; mat.uniforms.scrollOffset.value = this.textScrollOffset; }
        this.textMesh.scale.setScalar(this.config.text.reactive ? (1.0 + nB * 0.2) : 1.0);
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, this.rotation.y * 0.5, 0));
        this.textMesh.position.copy(new THREE.Vector3(0, 0, 6.0).applyQuaternion(q)); this.textMesh.lookAt(0, 0, 0);
    }

    this.rotation.y += (0.001 * this.config.reactivity.rotationSpeed) * dt;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, this.rotation.y, 0));
    this.camera.position.copy(new THREE.Vector3(0, 0, 10).applyQuaternion(q)); this.camera.lookAt(0, 0, 0);
    if (this.composer) this.composer.render();
  }

  protected firstUpdated() { this.canvas = (this as any).shadowRoot!.querySelector('canvas')!; this.init(); this.updateConfig(); }
  protected render() { return html`<canvas></canvas>`; }
}
