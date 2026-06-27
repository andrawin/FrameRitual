/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import './mesh-view';
import type { Band, MeshRitualConfig, PartInfo, PartSetting, ReactTarget } from './types';

const STORAGE_KEY = 'mesh-ritual-settings-v1';
const MIDI_MAP_KEY = 'mesh-ritual-midi-map-v1';

interface MidiMapping {
  path: string;
  type: 'cc' | 'pb' | 'note';
}

function defaultConfig(): MeshRitualConfig {
  return {
    fftSmoothing: 0.7,
    sensitivity: { low: 1.5, mid: 1.5, high: 2.5 },
    thresholds: { low: 0.15, mid: 0.15, high: 0.15 },
    mode: 'parts',
    autoRotate: true,
    rotateSpeed: 1.0,
    bloom: 0.6,
    parts: {},
    fracture: {
      fragments: 40,
      explodeBand: 'low',
      explodeAmount: 1.0,
      spinBand: 'high',
      spinAmount: 1.0,
      scaleBand: 'mid',
      scaleAmount: 0.5,
      distribute: true,
      visible: true,
      physics: {
        enabled: false,
        gravity: 1.0,
        burstStrength: 1.0,
        spin: 2.0,
        restitution: 0.4,
        floor: true,
        beatBand: 'low',
        beatThreshold: 0.4,
        beatAction: 'pulse',
        implodeStrength: 6.0,
      },
    },
    capture: {
      opacity: 0.85,
      scale: 1.0,
      mode: 'background',
      reactive: true,
      reactiveBand: 'low',
      visible: true,
    },
  };
}

function defaultPart(): PartSetting {
  return { band: 'none', amount: 1.0, target: 'scale', visible: true };
}

@customElement('mesh-ritual-app')
export class MeshRitualApp extends LitElement {
  @state() isRecording = false;
  @state() status = 'Upload a .glb to begin';
  @state() error = '';
  @state() showSettings = true;

  @state() partInfos: PartInfo[] = [];
  @state() modelUrl = '';
  @state() modelName = '';

  @state() isCapturing = false;
  @state() private captureStream: MediaStream | null = null;

  // MIDI state
  @state() lastMidiMsg = 'Ready for MIDI...';
  @state() midiDevices: { id: string; name: string }[] = [];
  @state() selectedMidiId = 'all';
  @state() learningParam: string | null = null;
  @state() midiMappings: Record<string, MidiMapping> = JSON.parse(localStorage.getItem(MIDI_MAP_KEY) || '{}');
  @state() midiPulse = false;

  private pendingMidiUpdate = false;
  private saveTimeout: any = null;
  private monitorRaf = 0;

  @state() config: MeshRitualConfig = this.loadSavedConfig();

  private loadSavedConfig(): MeshRitualConfig {
    const base = defaultConfig();
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return base;
    try {
      const p = JSON.parse(saved);
      return {
        ...base,
        ...p,
        sensitivity: { ...base.sensitivity, ...(p.sensitivity || {}) },
        thresholds: { ...base.thresholds, ...(p.thresholds || {}) },
        fracture: {
          ...base.fracture,
          ...(p.fracture || {}),
          physics: { ...base.fracture.physics, ...(p.fracture?.physics || {}) },
        },
        capture: { ...base.capture, ...(p.capture || {}) },
        parts: {}, // parts are rebuilt per loaded model
      };
    } catch (e) {
      return base;
    }
  }

  private audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  @state() audioNode = this.audioContext.createGain();
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;

  static styles = css`
    :host { font-family: 'Segoe UI', Tahoma, sans-serif; }

    #status {
      position: absolute; bottom: 20px; right: 20px; z-index: 10;
      color: rgba(255,255,255,0.6); font-size: 11px; text-transform: uppercase;
      background: rgba(0,0,0,0.3); padding: 4px 8px; border-radius: 4px;
      backdrop-filter: blur(2px); font-family: monospace; letter-spacing: 1px;
    }

    .settings-btn {
      position: absolute; top: 20px; right: 20px; z-index: 20;
      background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2);
      color: rgba(255,255,255,0.7); cursor: pointer; padding: 10px; border-radius: 8px;
      backdrop-filter: blur(10px); transition: 0.2s;
    }
    .settings-btn:hover { background: rgba(255,255,255,0.2); color: white; }
    .settings-btn svg { width: 30px; height: 30px; fill: currentColor; }

    .settings-panel {
      position: absolute; top: 0; right: 0; bottom: 0; width: 370px;
      background: rgba(8,10,16,0.96); backdrop-filter: blur(35px); z-index: 30;
      padding: 20px; transform: translateX(100%);
      transition: transform 0.3s cubic-bezier(0.4,0,0.2,1);
      overflow-y: auto; color: #ddd; border-left: 1px solid rgba(255,255,255,0.1);
    }
    .settings-panel.open { transform: translateX(0); }

    .panel-header {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 18px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 10px;
    }
    .panel-header h2 { margin: 0; font-size: 1.1rem; font-weight: 500; color: white; }
    .icon-btn { background: none; border: none; color: #aaa; cursor: pointer; padding: 5px; border-radius: 4px; font-size: 1.2rem; line-height: 1; }
    .icon-btn:hover { color: white; background: rgba(255,255,255,0.1); }

    .monitor-container { background: #000; border: 1px solid #333; margin-bottom: 15px; border-radius: 4px; height: 70px; position: relative; overflow: hidden; }
    #monitorCanvas { width: 100%; height: 100%; display: block; }

    .setting-group { margin-bottom: 22px; }
    .group-title {
      text-transform: uppercase; font-size: 0.7rem; color: #22d3ee;
      margin-bottom: 12px; display: block; font-weight: bold;
      border-left: 3px solid #22d3ee; padding-left: 8px;
    }

    .control-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; font-size: 0.85rem; gap: 8px; }
    .control-row label { flex: 1; color: #bbb; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    input[type="range"] { width: 100px; accent-color: #22d3ee; }
    input[type="checkbox"] { accent-color: #22d3ee; }
    select { background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: white; padding: 4px 6px; border-radius: 4px; width: 110px; font-size: 0.8rem; }
    select.small { width: 84px; }

    .midi-learn-btn {
      width: 18px; height: 18px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.2);
      background: rgba(255,255,255,0.05); color: #888; font-size: 10px; display: flex;
      align-items: center; justify-content: center; cursor: pointer; transition: 0.2s; flex-shrink: 0;
    }
    .midi-learn-btn:hover { background: rgba(255,255,255,0.15); color: white; }
    .midi-learn-btn.active { background: #22d3ee; color: #001; border-color: #67e8f9; box-shadow: 0 0 8px #22d3ee; animation: pulse 1s infinite; }
    .midi-learn-btn.mapped { border-color: #10b981; color: #10b981; }

    @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.5; } 100% { opacity: 1; } }

    .midi-log { font-family: monospace; font-size: 0.7rem; color: #10b981; background: rgba(16,185,129,0.1); padding: 6px 10px; border-radius: 4px; margin-top: 8px; display: block; border: 1px solid rgba(16,185,129,0.2); min-height: 28px; }
    .midi-log.learning { color: #f59e0b; background: rgba(245,158,11,0.1); border-color: #f59e0b; font-weight: bold; animation: pulse 1s infinite; }
    .midi-log.pulse { background: rgba(255,255,255,0.3); color: #fff; }

    .mapping-table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 0.65rem; color: #999; }
    .mapping-table th { text-align: left; padding: 4px; border-bottom: 1px solid #333; color: #bbb; }
    .mapping-table td { padding: 4px; border-bottom: 1px solid #222; }
    .del-map { cursor: pointer; color: #ef4444; border: none; background: none; font-size: 0.75rem; padding: 2px 4px; }

    .device-select { width: 100% !important; margin-top: 8px; font-size: 0.7rem; }

    .action-row { gap: 8px; justify-content: flex-start !important; flex-wrap: wrap; }
    .action-btn { background: rgba(255,255,255,0.05); color: white; padding: 8px 12px; border-radius: 6px; cursor: pointer; border: 1px solid rgba(255,255,255,0.1); transition: 0.2s; font-size: 0.75rem; }
    .action-btn:hover { background: rgba(255,255,255,0.15); }
    .action-btn.active { border-color: #22d3ee; color: #22d3ee; }
    .action-btn.small { padding: 4px 8px; font-size: 0.65rem; }

    .mode-toggle { display: flex; gap: 0; margin-bottom: 8px; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; overflow: hidden; }
    .mode-toggle button { flex: 1; background: transparent; color: #aaa; border: none; padding: 8px; cursor: pointer; font-size: 0.78rem; }
    .mode-toggle button.active { background: #22d3ee; color: #001018; font-weight: 600; }

    .upload-box { border: 1px dashed rgba(255,255,255,0.25); border-radius: 8px; padding: 14px; text-align: center; font-size: 0.78rem; color: #999; }
    .upload-box input { display: block; margin: 8px auto 0; font-size: 0.7rem; color: #ccc; }
    .upload-box .model-name { color: #22d3ee; margin-top: 6px; word-break: break-all; }

    .element-card { border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; background: rgba(255,255,255,0.02); }
    .element-card.hidden-el { opacity: 0.45; }
    .element-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 6px; }
    .element-name { font-size: 0.82rem; color: #eee; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
    .vis-toggle { background: none; border: 1px solid rgba(255,255,255,0.2); color: #aaa; border-radius: 4px; cursor: pointer; font-size: 0.6rem; padding: 2px 6px; flex-shrink: 0; }
    .vis-toggle.on { color: #10b981; border-color: #10b981; }
    .vis-toggle.off { color: #ef4444; border-color: #ef4444; }
    .empty-hint { font-size: 0.72rem; color: #777; line-height: 1.4; }
  `;

  firstUpdated() {
    this.initMidi();
    this.startMonitor();
  }

  /* ----------------------------- MIDI ----------------------------- */

  private initMidi = async () => {
    if (!navigator.requestMIDIAccess) {
      this.lastMidiMsg = 'MIDI not supported in this browser.';
      return;
    }
    try {
      this.lastMidiMsg = 'Requesting MIDI access...';
      const access = await navigator.requestMIDIAccess({ sysex: true });
      const updateDevicesList = () => {
        const devs: { id: string; name: string }[] = [];
        access.inputs.forEach((input) => devs.push({ id: input.id, name: input.name || 'Unknown Device' }));
        this.midiDevices = devs;
        if (!this.learningParam) this.lastMidiMsg = devs.length > 0 ? `Ready. ${devs.length} devices.` : 'No devices found.';
        (this as any).requestUpdate();
      };
      const setupInput = (input: any) => {
        input.onmidimessage = (msg: any) => {
          const deviceId = msg.target?.id || msg.srcElement?.id;
          if (this.selectedMidiId !== 'all' && deviceId !== this.selectedMidiId) return;
          this.handleMidiMessage(msg);
        };
      };
      access.inputs.forEach(setupInput);
      updateDevicesList();
      access.onstatechange = (e: any) => {
        if (e.port.type === 'input') {
          if (e.port.state === 'connected') setupInput(e.port);
          updateDevicesList();
        }
      };
    } catch (err) {
      this.lastMidiMsg = 'MIDI Access Denied or busy.';
    }
  };

  private handleMidiMessage = (msg: any) => {
    const [status, data1, data2] = msg.data;
    if (status >= 0xf0) return;
    const channel = status & 0x0f;
    const msgType = status & 0xf0;
    if (msgType === 0xe0) this.processMidiEvent(`pb-${channel}`, (data2 << 7) | data1, 'pb');
    else if (msgType === 0xb0) this.processMidiEvent(`cc-${channel}-${data1}`, data2, 'cc');
    else if (msgType === 0x90 && data2 > 0) this.processMidiEvent(`note-${channel}-${data1}`, data2, 'note');
  };

  private processMidiEvent = (id: string, value: number, type: 'cc' | 'pb' | 'note') => {
    this.midiPulse = true;
    setTimeout(() => { this.midiPulse = false; (this as any).requestUpdate(); }, 80);
    if (this.learningParam) {
      this.midiMappings = { ...this.midiMappings, [id]: { path: this.learningParam, type } };
      localStorage.setItem(MIDI_MAP_KEY, JSON.stringify(this.midiMappings));
      this.lastMidiMsg = `BOUND: ${id.toUpperCase()} to ${this.learningParam.split('.').pop()}`;
      this.learningParam = null;
    } else {
      const mapping = this.midiMappings[id];
      if (mapping) {
        const normalized = type === 'pb' ? value / 16383 : value / 127;
        this.lastMidiMsg = `${id.toUpperCase()} [${Math.round(normalized * 100)}%]`;
        this.applyNormalizedValue(mapping.path, normalized);
      } else {
        this.lastMidiMsg = `${id.toUpperCase()} value: ${value} (Unmapped)`;
      }
    }
    (this as any).requestUpdate();
  };

  private getParamRange = (path: string) => {
    const rangeMap: Record<string, { min: number; max: number }> = {
      'sensitivity.low': { min: 0, max: 5 },
      'sensitivity.mid': { min: 0, max: 5 },
      'sensitivity.high': { min: 0, max: 10 },
      fftSmoothing: { min: 0, max: 0.95 },
      rotateSpeed: { min: 0, max: 5 },
      bloom: { min: 0, max: 2 },
      'fracture.fragments': { min: 4, max: 200 },
      'capture.scale': { min: 0.1, max: 4 },
      'fracture.physics.gravity': { min: 0, max: 4 },
      'fracture.physics.burstStrength': { min: 0, max: 4 },
      'fracture.physics.spin': { min: 0, max: 5 },
      'fracture.physics.restitution': { min: 0, max: 0.95 },
      'fracture.physics.implodeStrength': { min: 1, max: 20 },
      'fracture.physics.beatThreshold': { min: 0.05, max: 1 },
    };
    if (rangeMap[path]) return rangeMap[path];
    if (path.endsWith('.amount') || path.endsWith('Amount')) return { min: 0, max: 3 };
    if (path.includes('thresholds')) return { min: 0, max: 1 };
    return { min: 0, max: 1 };
  };

  private applyNormalizedValue = (path: string, norm: number) => {
    const range = this.getParamRange(path);
    let scaled = range.min + norm * (range.max - range.min);
    if (path === 'fracture.fragments') scaled = Math.round(scaled);
    const keys = path.split('.');
    let ref: any = this.config;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!ref[keys[i]]) ref[keys[i]] = {};
      ref = ref[keys[i]];
    }
    if (ref[keys[keys.length - 1]] !== scaled) {
      ref[keys[keys.length - 1]] = scaled;
      if (!this.pendingMidiUpdate) {
        this.pendingMidiUpdate = true;
        requestAnimationFrame(() => {
          this.config = { ...this.config };
          this.pendingMidiUpdate = false;
          clearTimeout(this.saveTimeout);
          this.saveTimeout = setTimeout(() => this.persist(), 1500);
        });
      }
    }
  };

  private toggleMidiLearn = (path: string) => {
    this.learningParam = this.learningParam === path ? null : path;
    this.lastMidiMsg = this.learningParam ? 'LEARN: Move slider/knob...' : 'Learn mode off.';
    (this as any).requestUpdate();
  };

  private deleteMapping = (id: string) => {
    const m = { ...this.midiMappings };
    delete m[id];
    this.midiMappings = m;
    localStorage.setItem(MIDI_MAP_KEY, JSON.stringify(this.midiMappings));
    (this as any).requestUpdate();
  };

  private isMapped(path: string) {
    return Object.values(this.midiMappings).some((m) => m.path === path);
  }

  /* --------------------------- Audio ----------------------------- */

  private startRecording = async () => {
    if (this.isRecording) return;
    try {
      this.status = 'Initializing mic...';
      if (this.audioContext.state === 'suspended') await this.audioContext.resume();
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false,
      });
      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.sourceNode.connect(this.audioNode);
      this.isRecording = true;
      this.error = '';
      this.status = 'Reactive';
    } catch (err: any) {
      this.error = `Microphone error: ${err.message}`;
      this.stopRecording();
    }
  };

  private stopRecording = () => {
    this.isRecording = false;
    if (this.sourceNode) { this.sourceNode.disconnect(); this.sourceNode = null; }
    if (this.mediaStream) { this.mediaStream.getTracks().forEach((t) => t.stop()); this.mediaStream = null; }
    this.status = 'Audio paused';
  };

  private startMonitor = () => {
    const draw = () => {
      this.monitorRaf = requestAnimationFrame(draw);
      if (!this.showSettings) return;
      const view = this.shadowRoot?.querySelector('mesh-ritual-view') as any;
      const canvas = this.shadowRoot?.querySelector('#monitorCanvas') as HTMLCanvasElement;
      if (!view || !canvas) return;
      const ctx = canvas.getContext('2d');
      const data = view.getBandData?.();
      if (!ctx || !data) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const bands = [
        { val: data.rawLow, threshold: this.config.thresholds.low, col: '#3b82f6', label: 'LOW' },
        { val: data.rawMid, threshold: this.config.thresholds.mid, col: '#10b981', label: 'MID' },
        { val: data.rawHigh, threshold: this.config.thresholds.high, col: '#ef4444', label: 'HIGH' },
      ];
      const w = canvas.width / 3;
      bands.forEach((b, i) => {
        const h = Math.min(1, b.val) * canvas.height;
        ctx.fillStyle = b.col + '66';
        ctx.fillRect(i * w, canvas.height - h, w - 2, h);
        const thY = (1 - b.threshold) * canvas.height;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 2]);
        ctx.beginPath();
        ctx.moveTo(i * w, thY);
        ctx.lineTo((i + 1) * w - 2, thY);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = b.val > b.threshold ? '#fff' : '#ffffff44';
        ctx.font = 'bold 10px monospace';
        ctx.fillText(b.label, i * w + 5, 14);
      });
    };
    draw();
  };

  /* --------------------------- Model ----------------------------- */

  private handleModelUpload = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (this.modelUrl) URL.revokeObjectURL(this.modelUrl);
    this.modelUrl = URL.createObjectURL(file);
    this.modelName = file.name;
    this.status = `Loading ${file.name}...`;
    this.error = '';
  };

  private onPartsChanged = (e: CustomEvent<PartInfo[]>) => {
    const infos = e.detail;
    this.partInfos = infos;
    const parts: Record<string, PartSetting> = {};
    for (const info of infos) parts[info.id] = this.config.parts[info.id] || defaultPart();
    this.config = { ...this.config, parts };
    this.status = `${infos.length} parts loaded`;
    this.persist();
  };

  private onModelError = (e: CustomEvent<string>) => {
    this.error = `Model error: ${e.detail}`;
    this.status = 'Load failed';
  };

  /* ----------------------- Screen capture ------------------------ */

  private toggleCapture = async () => {
    if (this.isCapturing) {
      this.captureStream?.getTracks().forEach((t) => t.stop());
      this.captureStream = null;
      this.isCapturing = false;
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      this.error = 'Screen capture not supported in this browser.';
      return;
    }
    try {
      this.error = '';
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'window' } as any,
        audio: false,
      });
      this.captureStream = stream;
      this.isCapturing = true;
      stream.getTracks()[0].addEventListener('ended', () => {
        this.captureStream = null;
        this.isCapturing = false;
      });
    } catch (err: any) {
      this.error = `Capture failed: ${err.message}`;
      this.isCapturing = false;
    }
  };

  private autoDistribute = () => {
    const bands: Band[] = ['low', 'mid', 'high'];
    const targets: ReactTarget[] = ['scale', 'emissive', 'explode'];
    const parts = { ...this.config.parts };
    this.partInfos.forEach((info, i) => {
      parts[info.id] = {
        ...(parts[info.id] || defaultPart()),
        band: bands[i % 3],
        target: targets[Math.floor(i / 3) % 3],
        visible: true,
      };
    });
    this.config = { ...this.config, parts };
    this.persist();
  };

  /* --------------------------- Physics --------------------------- */

  private triggerPhysics = (action: 'burst' | 'implode' | 'reset') => {
    const view = this.shadowRoot?.querySelector('mesh-ritual-view') as any;
    view?.[action]?.();
  };

  /* --------------------------- Config ---------------------------- */

  private persist = () => {
    const { parts, ...rest } = this.config;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rest));
  };

  private updateConfig = (key: string, value: any) => {
    const keys = key.split('.');
    let ref: any = this.config;
    for (let i = 0; i < keys.length - 1; i++) {
      ref[keys[i]] = { ...ref[keys[i]] };
      ref = ref[keys[i]];
    }
    ref[keys[keys.length - 1]] = value;
    this.config = { ...this.config };
    this.persist();
  };

  /* ----------------------------- UI ------------------------------ */

  private renderSlider = (label: string, path: string, min: number, max: number, step: number) => {
    const value = path.split('.').reduce((o, i) => o[i], this.config as any);
    return html`
      <div class="control-row">
        <label>${label}</label>
        <button class="midi-learn-btn ${this.learningParam === path ? 'active' : ''} ${this.isMapped(path) ? 'mapped' : ''}"
          @click=${() => this.toggleMidiLearn(path)}>●</button>
        <input type="range" min=${min} max=${max} step=${step} .value=${String(value)}
          @input=${(e: any) => this.updateConfig(path, parseFloat(e.target.value))} />
      </div>
    `;
  };

  private renderBandSelect = (path: string, value: Band) => html`
    <select class="small" .value=${value} @change=${(e: any) => this.updateConfig(path, e.target.value)}>
      <option value="none">None</option>
      <option value="low">Low</option>
      <option value="mid">Mid</option>
      <option value="high">High</option>
    </select>
  `;

  private renderPart = (info: PartInfo) => {
    const s = this.config.parts[info.id] || defaultPart();
    const base = `parts.${info.id}`;
    return html`
      <div class="element-card ${s.visible ? '' : 'hidden-el'}">
        <div class="element-head">
          <span class="element-name" title=${info.name}>${info.name}</span>
          <button class="vis-toggle ${s.visible ? 'on' : 'off'}"
            @click=${() => this.updateConfig(`${base}.visible`, !s.visible)}>${s.visible ? 'SHOWN' : 'HIDDEN'}</button>
        </div>
        <div class="control-row">
          <label>Band</label>
          ${this.renderBandSelect(`${base}.band`, s.band)}
          <select class="small" .value=${s.target} @change=${(e: any) => this.updateConfig(`${base}.target`, e.target.value)}>
            <option value="scale">Scale</option>
            <option value="emissive">Glow</option>
            <option value="explode">Explode</option>
            <option value="rotate">Rotate</option>
          </select>
        </div>
        <div class="control-row">
          <label>Amount</label>
          <button class="midi-learn-btn ${this.learningParam === `${base}.amount` ? 'active' : ''} ${this.isMapped(`${base}.amount`) ? 'mapped' : ''}"
            @click=${() => this.toggleMidiLearn(`${base}.amount`)}>●</button>
          <input type="range" min="0" max="3" step="0.05" .value=${String(s.amount)}
            @input=${(e: any) => this.updateConfig(`${base}.amount`, parseFloat(e.target.value))} />
        </div>
      </div>
    `;
  };

  private renderFractureControls() {
    const f = this.config.fracture;
    return html`
      <div class="control-row"><label>Visible</label>
        <button class="vis-toggle ${f.visible ? 'on' : 'off'}" @click=${() => this.updateConfig('fracture.visible', !f.visible)}>${f.visible ? 'SHOWN' : 'HIDDEN'}</button>
      </div>
      ${this.renderSlider('Fragments', 'fracture.fragments', 4, 200, 1)}
      <div class="control-row"><label>Distribute across bands</label>
        <input type="checkbox" ?checked=${f.distribute} @change=${(e: any) => this.updateConfig('fracture.distribute', e.target.checked)} />
      </div>
      <div class="control-row"><label>Explode${f.distribute ? ' (per-frag band)' : ''}</label>
        ${f.distribute ? '' : this.renderBandSelect('fracture.explodeBand', f.explodeBand)}
      </div>
      ${this.renderSlider('Explode Amt', 'fracture.explodeAmount', 0, 3, 0.05)}
      <div class="control-row"><label>Scale${f.distribute ? ' (per-frag band)' : ''}</label>
        ${f.distribute ? '' : this.renderBandSelect('fracture.scaleBand', f.scaleBand)}
      </div>
      ${this.renderSlider('Scale Amt', 'fracture.scaleAmount', 0, 3, 0.05)}
      <div class="control-row"><label>Spin band</label>
        ${this.renderBandSelect('fracture.spinBand', f.spinBand)}
      </div>
      ${this.renderSlider('Spin Amt', 'fracture.spinAmount', 0, 3, 0.05)}
      ${this.renderPhysics()}
    `;
  }

  private renderPhysics() {
    const p = this.config.fracture.physics;
    return html`
      <div style="margin-top:14px;border-top:1px solid rgba(255,255,255,0.08);padding-top:12px;">
        <div class="control-row"><label><strong>Physics</strong> (burst · fall · tumble)</label>
          <input type="checkbox" ?checked=${p.enabled} @change=${(e: any) => this.updateConfig('fracture.physics.enabled', e.target.checked)} />
        </div>
        ${!p.enabled
          ? html`<div class="empty-hint">When on, fragments fly apart and fall under gravity. Trigger a burst/implode by hand or on a beat.</div>`
          : html`
              <div class="control-row action-row" style="margin-bottom:10px;">
                <button class="action-btn small" @click=${() => this.triggerPhysics('burst')}>💥 Burst</button>
                <button class="action-btn small" @click=${() => this.triggerPhysics('implode')}>🧲 Implode</button>
                <button class="action-btn small" @click=${() => this.triggerPhysics('reset')}>↺ Reset</button>
              </div>
              ${this.renderSlider('Gravity', 'fracture.physics.gravity', 0, 4, 0.05)}
              ${this.renderSlider('Burst Force', 'fracture.physics.burstStrength', 0, 4, 0.05)}
              ${this.renderSlider('Tumble Spin', 'fracture.physics.spin', 0, 5, 0.05)}
              ${this.renderSlider('Implode Pull', 'fracture.physics.implodeStrength', 1, 20, 0.5)}
              <div class="control-row"><label>Floor collision</label>
                <input type="checkbox" ?checked=${p.floor} @change=${(e: any) => this.updateConfig('fracture.physics.floor', e.target.checked)} />
              </div>
              ${this.renderSlider('Bounce', 'fracture.physics.restitution', 0, 0.95, 0.05)}
              <div class="control-row"><label>Beat trigger</label>
                ${this.renderBandSelect('fracture.physics.beatBand', p.beatBand)}
                <select class="small" .value=${p.beatAction} @change=${(e: any) => this.updateConfig('fracture.physics.beatAction', e.target.value)}>
                  <option value="burst">Burst</option>
                  <option value="implode">Implode</option>
                  <option value="pulse">Pulse</option>
                  <option value="alternate">Alternate</option>
                </select>
              </div>
              ${this.renderSlider('Beat Sensitivity', 'fracture.physics.beatThreshold', 0.05, 1, 0.01)}
            `}
      </div>
    `;
  }

  private renderSettings() {
    const mode = this.config.mode;
    return html`
      <div class="settings-panel ${this.showSettings ? 'open' : ''}">
        <div class="panel-header">
          <h2>Mesh Ritual</h2>
          <button class="icon-btn" @click=${() => (this.showSettings = false)}>&times;</button>
        </div>

        <div class="monitor-container"><canvas id="monitorCanvas" width="300" height="70"></canvas></div>

        <!-- MODEL -->
        <div class="setting-group">
          <span class="group-title">Model</span>
          <div class="upload-box">
            Upload a <strong>.glb</strong> file
            <input type="file" accept=".glb,.gltf,model/gltf-binary" @change=${this.handleModelUpload} />
            ${this.modelName ? html`<div class="model-name">${this.modelName}</div>` : ''}
          </div>
        </div>

        <!-- MODE -->
        <div class="setting-group">
          <span class="group-title">Engine Mode</span>
          <div class="mode-toggle">
            <button class=${mode === 'parts' ? 'active' : ''} @click=${() => this.updateConfig('mode', 'parts')}>Split by Parts</button>
            <button class=${mode === 'fracture' ? 'active' : ''} @click=${() => this.updateConfig('mode', 'fracture')}>Fracture</button>
          </div>
        </div>

        ${mode === 'parts'
          ? html`
              <div class="setting-group">
                <span class="group-title">Parts · Audio Allocation</span>
                ${this.partInfos.length === 0
                  ? html`<div class="empty-hint">Upload a model to list its parts. Each mesh becomes an element you can wire to Low / Mid / High and hide.</div>`
                  : html`
                      <div class="control-row action-row" style="margin-bottom:10px;">
                        <button class="action-btn small" @click=${this.autoDistribute}>Auto-distribute bands</button>
                      </div>
                      ${this.partInfos.map((info) => this.renderPart(info))}
                    `}
              </div>
            `
          : html`
              <div class="setting-group">
                <span class="group-title">Fracture · Shatter Controls</span>
                ${this.partInfos.length === 0
                  ? html`<div class="empty-hint">Upload a model, then it shatters into reactive fragments — works even on a single fused mesh.</div>`
                  : this.renderFractureControls()}
              </div>
            `}

        <!-- SCREEN CAPTURE -->
        <div class="setting-group">
          <span class="group-title">Screen Capture</span>
          <div class="control-row action-row">
            <button class="action-btn ${this.isCapturing ? 'active' : ''}" @click=${this.toggleCapture}>
              ${this.isCapturing ? 'Stop Capture' : 'Share a Window'}
            </button>
            <button class="vis-toggle ${this.config.capture.visible ? 'on' : 'off'}"
              @click=${() => this.updateConfig('capture.visible', !this.config.capture.visible)}>${this.config.capture.visible ? 'SHOWN' : 'HIDDEN'}</button>
          </div>
          ${this.renderSlider('Opacity', 'capture.opacity', 0, 1, 0.05)}
          ${this.renderSlider('Scale', 'capture.scale', 0.1, 4, 0.1)}
          <div class="control-row"><label>Projection</label>
            <select class="small" .value=${this.config.capture.mode} @change=${(e: any) => this.updateConfig('capture.mode', e.target.value)}>
              <option value="background">Rear Wall</option>
              <option value="floating">Floating Plane</option>
            </select>
          </div>
          <div class="control-row"><label>Audio reactive</label>
            <input type="checkbox" ?checked=${this.config.capture.reactive} @change=${(e: any) => this.updateConfig('capture.reactive', e.target.checked)} />
            ${this.renderBandSelect('capture.reactiveBand', this.config.capture.reactiveBand)}
          </div>
        </div>

        <!-- SCENE -->
        <div class="setting-group">
          <span class="group-title">Scene</span>
          <div class="control-row"><label>Auto-rotate</label>
            <input type="checkbox" ?checked=${this.config.autoRotate} @change=${(e: any) => this.updateConfig('autoRotate', e.target.checked)} />
          </div>
          ${this.renderSlider('Rotate Speed', 'rotateSpeed', 0, 5, 0.1)}
          ${this.renderSlider('Bloom', 'bloom', 0, 2, 0.05)}
        </div>

        <!-- RESPONSE -->
        <div class="setting-group">
          <span class="group-title">Response Profile</span>
          ${this.renderSlider('FFT Smoothing', 'fftSmoothing', 0, 0.95, 0.05)}
          ${this.renderSlider('Low Gain', 'sensitivity.low', 0, 5, 0.1)}
          ${this.renderSlider('Mid Gain', 'sensitivity.mid', 0, 5, 0.1)}
          ${this.renderSlider('High Gain', 'sensitivity.high', 0, 10, 0.1)}
        </div>

        <!-- GATES -->
        <div class="setting-group">
          <span class="group-title">Noise Gates</span>
          ${this.renderSlider('Low Gate', 'thresholds.low', 0, 1, 0.01)}
          ${this.renderSlider('Mid Gate', 'thresholds.mid', 0, 1, 0.01)}
          ${this.renderSlider('High Gate', 'thresholds.high', 0, 1, 0.01)}
        </div>

        <!-- MIDI -->
        <div class="setting-group">
          <span class="group-title">MIDI Bridge</span>
          <div class="midi-log ${this.midiPulse ? 'pulse' : ''} ${this.learningParam ? 'learning' : ''}">
            ${this.learningParam ? 'LEARNING...' : this.lastMidiMsg}
          </div>
          <select class="device-select" @change=${(e: any) => (this.selectedMidiId = e.target.value)} .value=${this.selectedMidiId}>
            <option value="all">Listen to All Devices</option>
            ${this.midiDevices.map((d) => html`<option value=${d.id}>Only: ${d.name}</option>`)}
          </select>
          ${Object.keys(this.midiMappings).length > 0
            ? html`<table class="mapping-table">
                <thead><tr><th>ID</th><th>Target</th><th></th></tr></thead>
                <tbody>
                  ${Object.entries(this.midiMappings).map(
                    ([id, map]) => html`<tr>
                      <td>${id.toUpperCase()}</td>
                      <td>${map.path.split('.').slice(-2).join('.')}</td>
                      <td style="text-align:right;"><button class="del-map" @click=${() => this.deleteMapping(id)}>🗑️</button></td>
                    </tr>`,
                  )}
                </tbody>
              </table>`
            : ''}
          <div class="control-row action-row" style="margin-top:10px;">
            <button class="action-btn small" @click=${this.initMidi}>Hardware Scan</button>
            <button class="action-btn small" @click=${() => { this.midiMappings = {}; localStorage.removeItem(MIDI_MAP_KEY); (this as any).requestUpdate(); }}>Clear Mappings</button>
          </div>
        </div>

        <!-- SYSTEM -->
        <div class="setting-group">
          <span class="group-title">System</span>
          <div class="control-row action-row">
            <button class="action-btn ${this.isRecording ? 'active' : ''}" @click=${this.isRecording ? this.stopRecording : this.startRecording}>
              ${this.isRecording ? 'Kill Audio' : 'Ignite Audio'}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  render() {
    return html`
      <div>
        <button class="settings-btn" @click=${() => (this.showSettings = !this.showSettings)}>
          <svg viewBox="0 0 24 24"><path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87 C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z" /></svg>
        </button>
        ${this.renderSettings()}
        <div id="status">${this.error || this.status}</div>
        <mesh-ritual-view
          .config=${this.config}
          .inputNode=${this.audioNode}
          .modelUrl=${this.modelUrl}
          .captureStream=${this.captureStream}
          @parts-changed=${this.onPartsChanged}
          @model-error=${this.onModelError}></mesh-ritual-view>
      </div>
    `;
  }
}
