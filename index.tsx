
/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {LitElement, css, html, render as litRender} from 'lit';
import {customElement, state, query} from 'lit/decorators.js';
import './visual-3d';
import { VisualConfig } from './visual-3d';

const STORAGE_KEY = 'gdm-visualizer-settings-v5';
const MIDI_MAP_KEY = 'gdm-visualizer-midi-map-v2';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(err => console.log('SW registration failed:', err));
  });
}

interface MidiMapping {
    path: string;
    type: 'cc' | 'pb' | 'note';
}

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() isRecording = false;
  @state() isCapturing = false;
  @state() status = 'Click Start Audio in menu';
  @state() error = '';
  @state() showSettings = false;
  
  // MIDI State
  @state() midiActive = false;
  @state() lastMidiMsg = 'Ready for MIDI...';
  @state() midiDevices: {id: string, name: string}[] = [];
  @state() selectedMidiId = 'all';
  @state() learningParam: string | null = null;
  @state() midiMappings: Record<string, MidiMapping> = JSON.parse(localStorage.getItem(MIDI_MAP_KEY) || '{}');
  @state() midiPulse = false;

  private pendingMidiUpdate = false;
  private saveTimeout: any = null;

  @query('#monitorCanvas') monitorCanvas!: HTMLCanvasElement;

  private getDefaultConfig(): VisualConfig {
    return {
      fftSmoothing: 0.7,
      sensitivity: { 
        sphere: 1.0,
        bass: 1.5, mid: 1.5, high: 2.5,
        orbBass: 1.2, orbMid: 1.5, orbHigh: 2.0
      },
      modulation: {
        bassThreshold: 0.2, midThreshold: 0.2, highThreshold: 0.2,
        orbBassThreshold: 0.2, orbMidThreshold: 0.2, orbHighThreshold: 0.2,
        orbSize: 'bass', orbSizeAmt: 1.0,
        videoFilterIntensity: 'high', videoFilterAmt: 1.0
      },
      colors: { sphere: '#000010', background: '#000000' },
      reactivity: { colorCycle: false, rotationSpeed: 1.0, orbRotation: false },
      orbShape: 'sphere', orbVisible: true, orbSize: 1.0,
      image: { url: '', target: 'none' },
      video: { url: '', filter: 'normal', opacity: 1.0, scale: 1.0, mode: 'background' },
      capture: { opacity: 0.5, scale: 1.0, blendMode: 'normal', mode: 'background', reactive: true },
      text: { content: 'VISUALIZER', color: '#ffffff', size: 1.0, speed: 1.0, visible: false, reactive: true, depth: 0.5, curvature: 0.5, scroll: false }
    };
  }

  @state() config: VisualConfig = this.loadSavedConfig();

  private loadSavedConfig(): VisualConfig {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            const defaults = this.getDefaultConfig();
            return { 
                ...defaults, 
                ...parsed,
                sensitivity: { ...defaults.sensitivity, ...(parsed.sensitivity || {}) },
                modulation: { ...defaults.modulation, ...(parsed.modulation || {}) },
                colors: { ...defaults.colors, ...(parsed.colors || {}) },
                video: { ...defaults.video, ...(parsed.video || {}) },
                text: { ...defaults.text, ...(parsed.text || {}) },
                capture: { ...defaults.capture, ...(parsed.capture || {}) }
            };
        } catch (e) { console.warn("Failed to parse settings."); }
    }
    return this.getDefaultConfig();
  }

  private audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  @state() audioNode = this.audioContext.createGain();
  private mediaStream: MediaStream | null = null;
  @state() private captureStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private monitorRaf: number = 0;
  @state() private detachedWindow: Window | null = null;

  static styles = css`
    :host { font-family: 'Segoe UI', Tahoma, sans-serif; }
    
    #status { 
      position: absolute; bottom: 20px; right: 20px; z-index: 10; 
      color: rgba(255, 255, 255, 0.6); font-size: 11px; text-transform: uppercase; 
      background: rgba(0,0,0,0.3); padding: 4px 8px; border-radius: 4px; 
      backdrop-filter: blur(2px); font-family: monospace; letter-spacing: 1px;
    }

    .settings-btn { 
      position: absolute; top: 20px; right: 20px; z-index: 20; 
      background: rgba(255, 255, 255, 0.1); border: 1px solid rgba(255, 255, 255, 0.2); 
      color: rgba(255,255,255,0.7); cursor: pointer; padding: 10px; border-radius: 8px; 
      backdrop-filter: blur(10px); transition: 0.2s;
      &:hover { background: rgba(255, 255, 255, 0.2); color: white; }
      svg { width: 30px; height: 30px; fill: currentColor; }
    }

    .settings-panel { 
      position: absolute; top: 0; right: 0; bottom: 0; width: 340px; 
      background: rgba(10, 10, 15, 0.96); backdrop-filter: blur(35px); z-index: 30; 
      padding: 20px; transform: translateX(100%); transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1); 
      overflow-y: auto; color: #ddd; border-left: 1px solid rgba(255,255,255,0.1);
    }

    .settings-panel.open { transform: translateX(0); }

    .panel-header { 
      display: flex; justify-content: space-between; align-items: center; 
      margin-bottom: 20px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 10px;
      h2 { margin: 0; font-size: 1.1rem; font-weight: 500; color: white; }
    }

    .header-actions { display: flex; gap: 10px; align-items: center; }

    .icon-btn { 
      background: none; border: none; color: #aaa; cursor: pointer; padding: 5px; 
      border-radius: 4px; display: flex; align-items: center; justify-content: center;
      &:hover { color: white; background: rgba(255,255,255,0.1); }
      svg { width: 18px; height: 18px; fill: currentColor; }
    }

    .monitor-container { background: #000; border: 1px solid #333; margin-bottom: 15px; border-radius: 4px; height: 80px; position: relative; overflow: hidden; }
    #monitorCanvas { width: 100%; height: 100%; display: block; }

    .setting-group { margin-bottom: 25px; }
    .group-title { 
      text-transform: uppercase; font-size: 0.7rem; color: #3b82f6; 
      margin-bottom: 12px; display: block; font-weight: bold; 
      border-left: 3px solid #3b82f6; padding-left: 8px;
    }

    .control-row { 
      display: flex; align-items: center; justify-content: space-between; 
      margin-bottom: 10px; font-size: 0.85rem; gap: 8px;
      label { flex: 1; color: #bbb; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } 
    }
    
    input[type="range"] { width: 100px; accent-color: #3b82f6; }
    input[type="color"] { background: none; border: none; width: 26px; height: 26px; padding: 0; cursor: pointer; }
    select, input[type="text"] { 
      background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); 
      color: white; padding: 4px 6px; border-radius: 4px; width: 110px; font-size: 0.8rem;
    }
    
    .midi-learn-btn {
      width: 18px; height: 18px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.2);
      background: rgba(255,255,255,0.05); color: #888; font-size: 10px; display: flex; 
      align-items: center; justify-content: center; cursor: pointer; transition: 0.2s;
      flex-shrink: 0;
      &:hover { background: rgba(255, 255, 255, 0.15); color: white; }
      &.active { 
        background: #3b82f6; color: white; border-color: #60a5fa; 
        box-shadow: 0 0 8px #3b82f6; animation: pulse 1s infinite;
      }
      &.mapped { border-color: #10b981; color: #10b981; }
    }

    @keyframes pulse {
      0% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(1.1); } 100% { opacity: 1; transform: scale(1); }
    }

    .midi-log {
      font-family: monospace; font-size: 0.7rem; color: #10b981; 
      background: rgba(16, 185, 129, 0.1); padding: 6px 10px; border-radius: 4px;
      margin-top: 8px; display: block; border: 1px solid rgba(16, 185, 129, 0.2);
      transition: 0.1s; min-height: 28px;
      &.learning { color: #f59e0b; background: rgba(245, 158, 11, 0.1); border-color: #f59e0b; font-weight: bold; animation: pulse 1s infinite; }
      &.pulse { background: rgba(255, 255, 255, 0.3); color: #fff; }
    }

    .mapping-table {
      width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 0.65rem; color: #999;
      th { text-align: left; padding: 4px; border-bottom: 1px solid #333; color: #bbb; }
      td { padding: 4px; border-bottom: 1px solid #222; }
      .del-map { cursor: pointer; color: #ef4444; border: none; background: none; font-size: 0.75rem; padding: 2px 4px; &:hover { color: white; } }
    }

    .device-list { font-size: 0.65rem; color: #888; margin-top: 5px; font-family: monospace; }
    .device-select { width: 100% !important; margin-top: 8px; font-size: 0.7rem; }

    .action-row { gap: 8px; justify-content: flex-start !important; }
    .action-btn { 
      background: rgba(255,255,255,0.05); color: white; padding: 8px 12px; border-radius: 6px; 
      cursor: pointer; border: 1px solid rgba(255,255,255,0.1); transition: 0.2s; font-size: 0.75rem;
      &:hover:not(.disabled) { background: rgba(255, 255, 255, 0.15); }
      &.active { border-color: #3b82f6; color: #3b82f6; }
      &.disabled { opacity: 0.3; cursor: not-allowed; }
      &.small { padding: 4px 8px; font-size: 0.65rem; }
    }

    .matrix-pair {
      display: flex; flex-direction: column; gap: 2px; margin-bottom: 12px; 
      padding-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.05);
      .pair-label { font-size: 0.75rem; color: #eee; margin-bottom: 4px; }
    }
  `;

  firstUpdated() {
    this.initMidi();
  }

  private initMidi = async () => {
    if (!navigator.requestMIDIAccess) {
      this.lastMidiMsg = "MIDI not supported in this browser.";
      return;
    }
    try {
      this.lastMidiMsg = "Requesting MIDI access...";
      const access = await navigator.requestMIDIAccess({ sysex: true });
      this.midiActive = true;
      
      const updateDevicesList = () => {
        const devs: {id: string, name: string}[] = [];
        access.inputs.forEach(input => devs.push({id: input.id, name: input.name || 'Unknown Device'}));
        this.midiDevices = devs;
        if (!this.learningParam) {
            this.lastMidiMsg = devs.length > 0 ? `Ready. ${devs.length} devices.` : "No devices found.";
        }
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
      console.error("MIDI Error:", err);
      this.lastMidiMsg = "MIDI Access Denied or busy.";
    }
  }

  private handleMidiMessage = (msg: any) => {
    const [status, data1, data2] = msg.data;
    if (status >= 0xF0) return;

    const channel = status & 0x0F;
    const msgType = status & 0xF0;

    if (msgType === 0xE0) { // Pitch Bend (High-res sliders)
        const value = (data2 << 7) | data1;
        this.processMidiEvent(`pb-${channel}`, value, 'pb');
    } else if (msgType === 0xB0) { // CC (Control Change)
        this.processMidiEvent(`cc-${channel}-${data1}`, data2, 'cc');
    } else if (msgType === 0x90 && data2 > 0) { // Note On
        this.processMidiEvent(`note-${channel}-${data1}`, data2, 'note');
    }
  }

  private processMidiEvent = (id: string, value: number, type: 'cc' | 'pb' | 'note') => {
    this.midiPulse = true;
    setTimeout(() => { this.midiPulse = false; (this as any).requestUpdate(); }, 80);

    if (this.learningParam) {
        this.midiMappings = { ...this.midiMappings, [id]: { path: this.learningParam, type } };
        localStorage.setItem(MIDI_MAP_KEY, JSON.stringify(this.midiMappings));
        this.lastMidiMsg = `BOUND: ${id.toUpperCase()} to ${this.learningParam.split('.').pop()}`;
        this.learningParam = null;
        (this as any).requestUpdate();
    } else {
        const mapping = this.midiMappings[id];
        if (mapping) {
            const normalized = type === 'pb' ? (value / 16383) : (value / 127);
            this.lastMidiMsg = `${id.toUpperCase()} [${Math.round(normalized * 100)}%]`;
            this.applyNormalizedValue(mapping.path, normalized);
        } else {
            this.lastMidiMsg = `${id.toUpperCase()} value: ${value} (Unmapped)`;
        }
    }
    (this as any).requestUpdate();
  }

  private getParamRange = (path: string) => {
    // High-Precision Range Matrix for SINCO SMC / Hardware Controllers
    const rangeMap: Record<string, {min: number, max: number}> = {
        'sensitivity.high': { min: 0, max: 10 },
        'sensitivity.orbHigh': { min: 0, max: 10 },
        'sensitivity.bass': { min: 0, max: 5 },
        'sensitivity.mid': { min: 0, max: 5 },
        'sensitivity.orbBass': { min: 0, max: 5 },
        'sensitivity.orbMid': { min: 0, max: 5 },
        'orbSize': { min: 0.1, max: 5 },
        'fractal.scale': { min: 0.1, max: 10 },
        'fractal.complexity': { min: 0, max: 3 },
        'fractal.brightness': { min: 0.1, max: 5 },
        'tunnel.speed': { min: 0.1, max: 10 },
        'glitch.pixelSize': { min: 1, max: 50 },
        'text.size': { min: 0.1, max: 5 },
        'text.speed': { min: 0, max: 5 },
        'text.depth': { min: 0, max: 2 },
        'text.curvature': { min: -1, max: 1 },
        'capture.scale': { min: 0.1, max: 4 },
        'fftSmoothing': { min: 0, max: 0.95 }
    };

    if (rangeMap[path]) return rangeMap[path];
    
    // Fallback logic for Modulation Matrix Amounts
    if (path.includes('Amt')) return { min: 0, max: 5 };
    if (path.includes('Threshold') || path.includes('Gate') || path.includes('opacity') || path.includes('scanlines')) return { min: 0, max: 1 };
    if (path.includes('rotationSpeed')) return { min: 0, max: 5 };

    return { min: 0, max: 1 };
  }

  private applyNormalizedValue = (path: string, norm: number) => {
    const range = this.getParamRange(path);
    const scaled = range.min + norm * (range.max - range.min);
    
    const keys = path.split('.'); 
    let ref: any = this.config;
    for(let i=0; i<keys.length-1; i++) { 
        if (!ref[keys[i]]) ref[keys[i]] = {};
        ref = ref[keys[i]]; 
    }
    
    if (ref[keys[keys.length-1]] !== scaled) {
        ref[keys[keys.length-1]] = scaled;

        if (!this.pendingMidiUpdate) {
            this.pendingMidiUpdate = true;
            requestAnimationFrame(() => {
                this.config = { ...this.config };
                this.pendingMidiUpdate = false;
                clearTimeout(this.saveTimeout);
                this.saveTimeout = setTimeout(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(this.config)), 2000);
            });
        }
    }
  }

  private toggleMidiLearn = (path: string) => {
    this.learningParam = this.learningParam === path ? null : path;
    this.lastMidiMsg = this.learningParam ? `LEARN: Move slider/knob...` : "Learn mode off.";
    (this as any).requestUpdate();
  }

  private deleteMapping = (id: string) => {
    const newMaps = { ...this.midiMappings }; delete newMaps[id]; this.midiMappings = newMaps;
    localStorage.setItem(MIDI_MAP_KEY, JSON.stringify(this.midiMappings));
    (this as any).requestUpdate();
  }

  private startRecording = async () => {
    if (this.isRecording) return;
    try {
      this.updateStatus('Initializing mic...');
      if (this.audioContext.state === 'suspended') await this.audioContext.resume();
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
      this.updateStatus('Visualizer active');
      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.sourceNode.connect(this.audioNode);
      this.isRecording = true; this.error = ''; this.startMonitor();
    } catch (err: any) { this.error = `Microphone error: ${err.message}`; this.stopRecording(); }
  }

  private stopRecording = () => {
    this.isRecording = false;
    if (this.sourceNode) { this.sourceNode.disconnect(); this.sourceNode = null; }
    if (this.mediaStream) { this.mediaStream.getTracks().forEach(t => t.stop()); this.mediaStream = null; }
    this.updateStatus('Visualizer paused'); cancelAnimationFrame(this.monitorRaf);
  }

  private startMonitor = () => {
      const visualizer = ((this as any).shadowRoot?.querySelector('gdm-live-audio-visuals-3d') as any);
      const draw = () => {
          this.monitorRaf = requestAnimationFrame(draw);
          let currentCanvas: HTMLCanvasElement | null = null;
          if (this.detachedWindow && !this.detachedWindow.closed) {
              currentCanvas = this.detachedWindow.document.getElementById('monitorCanvas') as HTMLCanvasElement;
          } else if (this.showSettings) {
              currentCanvas = (this as any).shadowRoot?.querySelector('#monitorCanvas') as HTMLCanvasElement;
          }
          if (!currentCanvas || !visualizer) return;
          const ctx = currentCanvas.getContext('2d'); if (!ctx) return;
          const data = visualizer.getBandData(); if (!data) return;
          ctx.clearRect(0, 0, currentCanvas.width, currentCanvas.height);
          const bands = [
              { val: data.bass, threshold: this.config.modulation.bassThreshold, col: '#3b82f6', label: 'B' },
              { val: data.mid, threshold: this.config.modulation.midThreshold, col: '#10b981', label: 'M' },
              { val: data.high, threshold: this.config.modulation.highThreshold, col: '#ef4444', label: 'H' }
          ];
          const w = currentCanvas.width / 3;
          bands.forEach((b, i) => {
              const h = Math.min(1.0, b.val) * currentCanvas.height;
              ctx.fillStyle = b.col + '66'; ctx.fillRect(i * w, currentCanvas.height - h, w - 2, h);
              const thY = (1.0 - b.threshold) * currentCanvas.height;
              ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.setLineDash([3, 2]);
              ctx.beginPath(); ctx.moveTo(i * w, thY); ctx.lineTo((i + 1) * w - 2, thY); ctx.stroke(); ctx.setLineDash([]);
              ctx.fillStyle = b.val > b.threshold ? '#fff' : '#ffffff44';
              ctx.font = 'bold 10px monospace'; ctx.fillText(b.label, i * w + 5, 15);
          });
      };
      draw();
  }

  private toggleCapture = async () => {
    if (this.isCapturing) { if (this.captureStream) this.captureStream.getTracks().forEach(t => t.stop()); this.captureStream = null; this.isCapturing = false; return; }
    try {
        this.error = '';
        this.captureStream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'window' }, audio: false });
        this.isCapturing = true;
        this.captureStream.getTracks()[0].addEventListener('ended', () => { this.isCapturing = false; this.captureStream = null; });
    } catch (err: any) { this.error = `Capture failed: ${err.message}`; this.isCapturing = false; }
  }

  private updateStatus = (msg: string) => { this.status = msg; }
  
  private updateConfig = (key: string, value: any) => {
      const keys = key.split('.'); let ref: any = this.config;
      for(let i=0; i<keys.length-1; i++) { ref[keys[i]] = { ...ref[keys[i]] }; ref = ref[keys[i]]; }
      ref[keys[keys.length-1]] = value; this.config = { ...this.config };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.config));
  }

  private handleImageUpload = (e: Event) => {
      const input = e.target as HTMLInputElement; const file = input.files ? input.files[0] : null;
      if (file) {
          const reader = new FileReader();
          reader.onload = (event: any) => {
             if (event.target?.result) {
                 this.updateConfig('image.url', event.target.result);
                 if (this.config.image.target === 'none') this.updateConfig('image.target', 'background');
             }
          };
          reader.readAsDataURL(file);
      }
      input.value = '';
  }

  private handleVideoUpload = (e: Event) => {
      const input = e.target as HTMLInputElement; const file = input.files ? input.files[0] : null;
      if (file) {
          const url = URL.createObjectURL(file);
          this.updateConfig('video.url', url);
      }
      input.value = '';
  }

  private detachSettings = () => {
      if (this.detachedWindow && !this.detachedWindow.closed) { this.detachedWindow.focus(); return; }
      const width = 340, height = 950;
      const left = window.screenX + window.outerWidth - width, top = window.screenY;
      this.detachedWindow = window.open('', 'LiveAudioSettings', `width=${width},height=${height},left=${left},top=${top}`);
      if (!this.detachedWindow) return;
      const styleEl = this.detachedWindow.document.createElement('style');
      styleEl.textContent = GdmLiveAudio.styles.cssText + `
        * { box-sizing: border-box; }
        body { background: #0a0a0f; color: #ddd; margin: 0; padding: 0; overflow-x: hidden; font-family: 'Segoe UI', sans-serif; }
        .settings-panel { transform: none !important; position: relative !important; width: 100% !important; border-left: none !important; height: auto !important; min-height: 100vh !important; background: transparent !important; backdrop-filter: none !important; padding: 20px !important; }
        .close-btn, .popout-btn { display: none !important; }
      `;
      this.detachedWindow.document.head.appendChild(styleEl); this.detachedWindow.document.title = "Visual Settings";
      litRender(this.renderSettingsContent(true), this.detachedWindow.document.body);
      this.detachedWindow.addEventListener('beforeunload', () => { this.detachedWindow = null; });
      this.showSettings = false;
  }

  updated(changedProperties: any) {
      if (this.detachedWindow && !this.detachedWindow.closed) {
        litRender(this.renderSettingsContent(true), this.detachedWindow.document.body);
      }
  }

  private isMapped(path: string) { return Object.values(this.midiMappings).some(m => m.path === path); }

  private renderSlider = (label: string, path: string, min: number, max: number, step: number) => {
      const value = path.split('.').reduce((o, i) => o[i], this.config as any);
      return html`
        <div class="control-row">
            <label>${label}</label>
            <button class="midi-learn-btn ${this.learningParam === path ? 'active' : ''} ${this.isMapped(path) ? 'mapped' : ''}" 
                    @click=${() => this.toggleMidiLearn(path)}>●</button>
            <input type="range" min=${min} max=${max} step=${step} .value=${value} 
                   @input=${(e:any) => this.updateConfig(path, parseFloat(e.target.value))}>
        </div>
      `;
  }

  private renderModulationPair = (label: string, sourceKey: string, amountKey: string) => {
      const sourceValue = (this.config.modulation as any)[sourceKey];
      const amountValue = (this.config.modulation as any)[amountKey];
      const amountPath = `modulation.${amountKey}`;
      return html`
        <div class="matrix-pair">
            <div class="pair-label">${label}</div>
            <div class="control-row">
                <select @change=${(e:any) => this.updateConfig(`modulation.${sourceKey}`, e.target.value)} .value=${sourceValue}>
                    <option value="none">None</option><option value="bass">Bass</option><option value="mid">Mid</option><option value="high">High</option>
                </select>
                <button class="midi-learn-btn ${this.learningParam === amountPath ? 'active' : ''} ${this.isMapped(amountPath) ? 'mapped' : ''}" 
                        @click=${() => this.toggleMidiLearn(amountPath)}>●</button>
                <input type="range" min="0" max="5" step="0.1" .value=${amountValue} 
                       @input=${(e:any) => this.updateConfig(amountPath, parseFloat(e.target.value))}>
            </div>
        </div>
      `;
  }

  private renderSettingsContent = (isDetached: boolean = false) => {
      return html`
         <div class="settings-panel ${isDetached ? '' : (this.showSettings ? 'open' : '')}">
           <div class="panel-header">
             <h2>Visual Engine</h2>
             <div class="header-actions">
                ${!isDetached ? html`
                    <button class="icon-btn popout-btn" title="Pop out" @click=${this.detachSettings}><svg viewBox="0 0 24 24"><path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg></button>
                    <button class="icon-btn close-btn" @click=${() => this.showSettings = false}>&times;</button>
                ` : ''}
             </div>
           </div>

           <div class="monitor-container"><canvas id="monitorCanvas" width="300" height="80"></canvas></div>

           <!-- MIDI HUB -->
           <div class="setting-group">
             <span class="group-title">MIDI Bridge</span>
             <div class="midi-log ${this.midiPulse ? 'pulse' : ''} ${this.learningParam ? 'learning' : ''}">
                ${this.learningParam ? 'LEARNING...' : this.lastMidiMsg}
             </div>
             
             <select class="device-select" @change=${(e:any) => this.selectedMidiId = e.target.value} .value=${this.selectedMidiId}>
                <option value="all">Listen to All Devices</option>
                ${this.midiDevices.map(d => html`<option value=${d.id}>Only: ${d.name}</option>`)}
             </select>

             ${Object.keys(this.midiMappings).length > 0 ? html`
                <table class="mapping-table">
                    <thead><tr><th>ID</th><th>Target</th><th></th></tr></thead>
                    <tbody>
                        ${Object.entries(this.midiMappings).map(([id, map]) => html`
                            <tr><td>${id.toUpperCase()}</td><td>${map.path.split('.').pop()}</td><td style="text-align:right;"><button class="del-map" @click=${() => this.deleteMapping(id)}>🗑️</button></td></tr>
                        `)}
                    </tbody>
                </table>
             ` : ''}

             <div class="control-row action-row" style="margin-top: 10px;">
                <button class="action-btn small" @click=${this.initMidi}>Hardware Scan</button>
                <button class="action-btn small" @click=${() => { this.midiMappings = {}; localStorage.removeItem(MIDI_MAP_KEY); (this as any).requestUpdate(); }}>Clear Mappings</button>
             </div>
           </div>

           <!-- SYSTEM -->
           <div class="setting-group">
             <span class="group-title">System Actions</span>
             <div class="control-row action-row">
                <button class="action-btn" @click=${this.isRecording ? this.stopRecording : this.startRecording}>${this.isRecording ? 'Kill Audio' : 'Ignite Audio'}</button>
                <button class="action-btn ${this.isCapturing ? 'active' : ''}" @click=${this.toggleCapture}>Screen Hook</button>
             </div>
           </div>

           <!-- GAIN -->
           <div class="setting-group">
             <span class="group-title">Response Profile</span>
             ${this.renderSlider('FFT Smoothing', 'fftSmoothing', 0, 0.95, 0.05)}
             ${this.renderSlider('Bass Gain', 'sensitivity.bass', 0, 5, 0.1)}
             ${this.renderSlider('Mid Gain', 'sensitivity.mid', 0, 5, 0.1)}
             ${this.renderSlider('High Gain', 'sensitivity.high', 0, 10, 0.1)}
           </div>

           <!-- THRESHOLD -->
           <div class="setting-group">
             <span class="group-title">Noise Gates</span>
             ${this.renderSlider('Bass Gate', 'modulation.bassThreshold', 0, 1, 0.01)}
             ${this.renderSlider('Mid Gate', 'modulation.midThreshold', 0, 1, 0.01)}
             ${this.renderSlider('High Gate', 'modulation.highThreshold', 0, 1, 0.01)}
           </div>

           <!-- ORB DYNAMICS -->
           <div class="setting-group">
             <span class="group-title">Orb Response</span>
             ${this.renderSlider('Orb Bass Gain', 'sensitivity.orbBass', 0, 5, 0.1)}
             ${this.renderSlider('Orb Mid Gain', 'sensitivity.orbMid', 0, 5, 0.1)}
             ${this.renderSlider('Orb High Gain', 'sensitivity.orbHigh', 0, 10, 0.1)}
             ${this.renderSlider('Orb Bass Gate', 'modulation.orbBassThreshold', 0, 1, 0.01)}
             ${this.renderSlider('Orb Mid Gate', 'modulation.orbMidThreshold', 0, 1, 0.01)}
             ${this.renderSlider('Orb High Gate', 'modulation.orbHighThreshold', 0, 1, 0.01)}
           </div>

           <!-- SCREEN CAPTURE -->
           <div class="setting-group">
             <span class="group-title">Screen Capture</span>
             ${this.renderSlider('Visibility', 'capture.opacity', 0, 1, 0.05)}
             ${this.renderSlider('Plane Scale', 'capture.scale', 0.1, 4, 0.1)}
             <div class="control-row"><label>Projection</label>
                <select @change=${(e:any) => this.updateConfig('capture.mode', e.target.value)} .value=${this.config.capture.mode}>
                    <option value="background">Rear Wall</option><option value="floating">Floating Plane</option>
                </select>
             </div>
             <div class="control-row"><label>Kick Reactive</label><input type="checkbox" ?checked=${this.config.capture.reactive} @change=${(e:any) => this.updateConfig('capture.reactive', e.target.checked)}></div>
           </div>

           <!-- VIDEO INPUT -->
           <div class="setting-group">
             <span class="group-title">Video Input</span>
             <div class="control-row"><label>Upload Video</label><input type="file" accept="video/*" @change=${this.handleVideoUpload}></div>
             <div class="control-row"><label>Video Filter</label>
               <select @change=${(e:any) => this.updateConfig('video.filter', e.target.value)} .value=${this.config.video.filter}>
                 <option value="normal">None</option>
                 <option value="invert">Color Invert</option>
                 <option value="glitch">Glitch</option>
                 <option value="pixelate">Pixelate</option>
                 <option value="edge">Edge Detection</option>
                 <option value="blob">Blob Distortion</option>
               </select>
             </div>
             ${this.renderSlider('Video Opacity', 'video.opacity', 0, 1, 0.05)}
             ${this.renderSlider('Video Scale', 'video.scale', 0.1, 4, 0.1)}
             <div class="control-row"><label>Projection</label>
                <select @change=${(e:any) => this.updateConfig('video.mode', e.target.value)} .value=${this.config.video.mode}>
                    <option value="background">Rear Wall</option><option value="floating">Floating Plane</option>
                </select>
             </div>
           </div>

           <!-- MOD MATRIX -->
           <div class="setting-group">
             <span class="group-title">Modulation Matrix</span>
             ${this.renderModulationPair('Orb Scale Drive', 'orbSize', 'orbSizeAmt')}
             ${this.renderModulationPair('Video Filter Drive', 'videoFilterIntensity', 'videoFilterAmt')}
           </div>

           <!-- TEXT -->
           <div class="setting-group">
             <span class="group-title">Typography</span>
             <div class="control-row"><label>Overlay Active</label><input type="checkbox" ?checked=${this.config.text.visible} @change=${(e:any) => this.updateConfig('text.visible', e.target.checked)}></div>
             <div class="control-row"><label>String</label><input type="text" .value=${this.config.text.content} @input=${(e:any) => this.updateConfig('text.content', e.target.value)}></div>
             <div class="control-row"><label>Tint</label><input type="color" .value=${this.config.text.color} @input=${(e:any) => this.updateConfig('text.color', e.target.value)}></div>
             ${this.renderSlider('Point Size', 'text.size', 0.1, 5, 0.1)}
             ${this.renderSlider('Flow Speed', 'text.speed', 0, 5, 0.1)}
             ${this.renderSlider('Z-Depth', 'text.depth', 0, 2, 0.1)}
             ${this.renderSlider('Lens Arch', 'text.curvature', -1, 1, 0.1)}
             <div class="control-row"><label>Auto-Scroll</label><input type="checkbox" ?checked=${this.config.text.scroll} @change=${(e:any) => this.updateConfig('text.scroll', e.target.checked)}></div>
             <div class="control-row"><label>Audio Pulsing</label><input type="checkbox" ?checked=${this.config.text.reactive} @change=${(e:any) => this.updateConfig('text.reactive', e.target.checked)}></div>
           </div>

           <!-- MATERIALS -->
           <div class="setting-group">
             <span class="group-title">Material Palette</span>
             <div class="control-row"><label>Asset Load</label><input type="file" accept="image/*" @change=${this.handleImageUpload}></div>
             <div class="control-row"><label>Mapping Target</label>
                <select @change=${(e:any) => this.updateConfig('image.target', e.target.value)} .value=${this.config.image.target}>
                  <option value="none">Empty</option><option value="background">Environment</option><option value="orb">Orb Skin</option>
                </select>
             </div>
             <div class="control-row"><label>Orb Core</label><input type="color" .value=${this.config.colors.sphere} @input=${(e:any) => this.updateConfig('colors.sphere', e.target.value)}></div>
             ${this.renderSlider('Base Radius', 'orbSize', 0.1, 5, 0.1)}
             <div class="control-row"><label>Orb Geometry</label>
                <select @change=${(e:any) => this.updateConfig('orbShape', e.target.value)} .value=${this.config.orbShape}>
                    <option value="sphere">Liquid Sphere</option><option value="cube">Monolith</option><option value="ring">Singularity</option>
                    <option value="dna">Double Helix</option><option value="takraw">Takraw Cage</option><option value="knot">Torus Knot</option>
                    <option value="spiral">DNA Spiral</option><option value="hourglass">Chrono-Lens</option><option value="stump">Stump Core</option>
                    <option value="spikey">Octa-Cell</option><option value="cyber">Hex-Cyber</option>
                </select>
             </div>
             <div class="control-row"><label>Orb Render</label><input type="checkbox" ?checked=${this.config.orbVisible} @change=${(e:any) => this.updateConfig('orbVisible', e.target.checked)}></div>
             <div class="control-row"><label>Axis Drift</label><input type="checkbox" ?checked=${this.config.reactivity.orbRotation} @change=${(e:any) => this.updateConfig('reactivity.orbRotation', e.target.checked)}></div>
             ${this.renderSlider('Engine Spin', 'reactivity.rotationSpeed', 0, 5, 0.1)}
             <div class="control-row"><label>Hue Cycle</label><input type="checkbox" ?checked=${this.config.reactivity.colorCycle} @change=${(e:any) => this.updateConfig('reactivity.colorCycle', e.target.checked)}></div>
           </div>
         </div>
      `;
  }

  render() {
    return html`
      <div>
        <button class="settings-btn" @click=${() => this.showSettings = !this.showSettings}>
            <svg viewBox="0 0 24 24"><path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87 C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z"/></svg>
        </button>
        ${!this.detachedWindow ? this.renderSettingsContent(false) : ''}
        <div id="status">${this.error || this.status}</div>
        <gdm-live-audio-visuals-3d .config=${this.config} .inputNode=${this.audioNode} .outputNode=${this.audioNode} .captureStream=${this.captureStream}></gdm-live-audio-visuals-3d>
      </div>
    `;
  }
}
