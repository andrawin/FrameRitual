/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import './shader-view';
import { SHADERS, getShader, sanitizeConfig } from './shader-registry';
import type { Band, ShaderRitualConfig } from './types';

const STORAGE_KEY = 'shader-ritual-settings-v1';
const MIDI_MAP_KEY = 'shader-ritual-midi-map-v1';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

interface MidiMapping {
  path: string;
  type: 'cc' | 'pb' | 'note';
}

@customElement('shader-ritual-app')
export class ShaderRitualApp extends LitElement {
  @state() isRecording = false;
  @state() status = 'Open the menu and ignite audio';
  @state() error = '';
  @state() showSettings = false;

  // MIDI state
  @state() midiActive = false;
  @state() lastMidiMsg = 'Ready for MIDI...';
  @state() midiDevices: { id: string; name: string }[] = [];
  @state() selectedMidiId = 'all';
  @state() learningParam: string | null = null;
  @state() midiMappings: Record<string, MidiMapping> = JSON.parse(
    localStorage.getItem(MIDI_MAP_KEY) || '{}',
  );
  @state() midiPulse = false;

  private pendingMidiUpdate = false;
  private saveTimeout: any = null;
  private monitorRaf = 0;

  @state() config: ShaderRitualConfig = this.loadSavedConfig();

  private loadSavedConfig(): ShaderRitualConfig {
    const saved = localStorage.getItem(STORAGE_KEY);
    try {
      return sanitizeConfig(saved ? JSON.parse(saved) : null);
    } catch (e) {
      return sanitizeConfig(null);
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
      position: absolute; top: 0; right: 0; bottom: 0; width: 360px;
      background: rgba(10,10,15,0.96); backdrop-filter: blur(35px); z-index: 30;
      padding: 20px; transform: translateX(100%);
      transition: transform 0.3s cubic-bezier(0.4,0,0.2,1);
      overflow-y: auto; color: #ddd; border-left: 1px solid rgba(255,255,255,0.1);
    }
    .settings-panel.open { transform: translateX(0); }

    .panel-header {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 20px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 10px;
    }
    .panel-header h2 { margin: 0; font-size: 1.1rem; font-weight: 500; color: white; }

    .icon-btn {
      background: none; border: none; color: #aaa; cursor: pointer; padding: 5px;
      border-radius: 4px; font-size: 1.2rem; line-height: 1;
    }
    .icon-btn:hover { color: white; background: rgba(255,255,255,0.1); }

    .monitor-container {
      background: #000; border: 1px solid #333; margin-bottom: 15px;
      border-radius: 4px; height: 80px; position: relative; overflow: hidden;
    }
    #monitorCanvas { width: 100%; height: 100%; display: block; }

    .setting-group { margin-bottom: 25px; }
    .group-title {
      text-transform: uppercase; font-size: 0.7rem; color: #a855f7;
      margin-bottom: 12px; display: block; font-weight: bold;
      border-left: 3px solid #a855f7; padding-left: 8px;
    }

    .control-row {
      display: flex; align-items: center; justify-content: space-between;
      margin-bottom: 10px; font-size: 0.85rem; gap: 8px;
    }
    .control-row label { flex: 1; color: #bbb; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    input[type="range"] { width: 100px; accent-color: #a855f7; }
    select, input[type="text"] {
      background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2);
      color: white; padding: 4px 6px; border-radius: 4px; width: 110px; font-size: 0.8rem;
    }
    input[type="checkbox"] { accent-color: #a855f7; }

    .midi-learn-btn {
      width: 18px; height: 18px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.2);
      background: rgba(255,255,255,0.05); color: #888; font-size: 10px; display: flex;
      align-items: center; justify-content: center; cursor: pointer; transition: 0.2s; flex-shrink: 0;
    }
    .midi-learn-btn:hover { background: rgba(255,255,255,0.15); color: white; }
    .midi-learn-btn.active {
      background: #a855f7; color: white; border-color: #c084fc;
      box-shadow: 0 0 8px #a855f7; animation: pulse 1s infinite;
    }
    .midi-learn-btn.mapped { border-color: #10b981; color: #10b981; }

    @keyframes pulse {
      0% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(1.1); }
      100% { opacity: 1; transform: scale(1); }
    }

    .midi-log {
      font-family: monospace; font-size: 0.7rem; color: #10b981;
      background: rgba(16,185,129,0.1); padding: 6px 10px; border-radius: 4px;
      margin-top: 8px; display: block; border: 1px solid rgba(16,185,129,0.2);
      transition: 0.1s; min-height: 28px;
    }
    .midi-log.learning {
      color: #f59e0b; background: rgba(245,158,11,0.1); border-color: #f59e0b;
      font-weight: bold; animation: pulse 1s infinite;
    }
    .midi-log.pulse { background: rgba(255,255,255,0.3); color: #fff; }

    .mapping-table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 0.65rem; color: #999; }
    .mapping-table th { text-align: left; padding: 4px; border-bottom: 1px solid #333; color: #bbb; }
    .mapping-table td { padding: 4px; border-bottom: 1px solid #222; }
    .del-map { cursor: pointer; color: #ef4444; border: none; background: none; font-size: 0.75rem; padding: 2px 4px; }
    .del-map:hover { color: white; }

    .device-select { width: 100% !important; margin-top: 8px; font-size: 0.7rem; }
    .shader-select { width: 100% !important; font-size: 0.85rem; }

    .action-row { gap: 8px; justify-content: flex-start !important; }
    .action-btn {
      background: rgba(255,255,255,0.05); color: white; padding: 8px 12px; border-radius: 6px;
      cursor: pointer; border: 1px solid rgba(255,255,255,0.1); transition: 0.2s; font-size: 0.75rem;
    }
    .action-btn:hover { background: rgba(255,255,255,0.15); }
    .action-btn.active { border-color: #a855f7; color: #a855f7; }
    .action-btn.small { padding: 4px 8px; font-size: 0.65rem; }

    .element-card {
      border: 1px solid rgba(255,255,255,0.08); border-radius: 8px;
      padding: 10px 12px; margin-bottom: 12px; background: rgba(255,255,255,0.02);
    }
    .element-card.hidden-el { opacity: 0.45; }
    .element-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
    .element-name { font-size: 0.85rem; color: #eee; font-weight: 600; }
    .element-desc { font-size: 0.65rem; color: #777; margin-bottom: 8px; line-height: 1.3; }
    .vis-toggle {
      background: none; border: 1px solid rgba(255,255,255,0.2); color: #aaa;
      border-radius: 4px; cursor: pointer; font-size: 0.65rem; padding: 2px 6px;
    }
    .vis-toggle.on { color: #10b981; border-color: #10b981; }
    .vis-toggle.off { color: #ef4444; border-color: #ef4444; }
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
      this.midiActive = true;

      const updateDevicesList = () => {
        const devs: { id: string; name: string }[] = [];
        access.inputs.forEach((input) => devs.push({ id: input.id, name: input.name || 'Unknown Device' }));
        this.midiDevices = devs;
        if (!this.learningParam) {
          this.lastMidiMsg = devs.length > 0 ? `Ready. ${devs.length} devices.` : 'No devices found.';
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
      this.lastMidiMsg = 'MIDI Access Denied or busy.';
    }
  };

  private handleMidiMessage = (msg: any) => {
    const [status, data1, data2] = msg.data;
    if (status >= 0xf0) return;
    const channel = status & 0x0f;
    const msgType = status & 0xf0;
    if (msgType === 0xe0) {
      this.processMidiEvent(`pb-${channel}`, (data2 << 7) | data1, 'pb');
    } else if (msgType === 0xb0) {
      this.processMidiEvent(`cc-${channel}-${data1}`, data2, 'cc');
    } else if (msgType === 0x90 && data2 > 0) {
      this.processMidiEvent(`note-${channel}-${data1}`, data2, 'note');
    }
  };

  private processMidiEvent = (id: string, value: number, type: 'cc' | 'pb' | 'note') => {
    this.midiPulse = true;
    setTimeout(() => {
      this.midiPulse = false;
      (this as any).requestUpdate();
    }, 80);

    if (this.learningParam) {
      this.midiMappings = { ...this.midiMappings, [id]: { path: this.learningParam, type } };
      localStorage.setItem(MIDI_MAP_KEY, JSON.stringify(this.midiMappings));
      this.lastMidiMsg = `BOUND: ${id.toUpperCase()} to ${this.learningParam.split('.').pop()}`;
      this.learningParam = null;
      (this as any).requestUpdate();
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
    };
    if (rangeMap[path]) return rangeMap[path];
    if (path.endsWith('.amount')) return { min: 0, max: 3 };
    if (path.includes('thresholds') || path.includes('Threshold')) return { min: 0, max: 1 };
    return { min: 0, max: 1 };
  };

  private applyNormalizedValue = (path: string, norm: number) => {
    const range = this.getParamRange(path);
    const scaled = range.min + norm * (range.max - range.min);
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
          this.saveTimeout = setTimeout(
            () => localStorage.setItem(STORAGE_KEY, JSON.stringify(this.config)),
            2000,
          );
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
    const newMaps = { ...this.midiMappings };
    delete newMaps[id];
    this.midiMappings = newMaps;
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
      this.status = 'Shader reactive';
    } catch (err: any) {
      this.error = `Microphone error: ${err.message}`;
      this.stopRecording();
    }
  };

  private stopRecording = () => {
    this.isRecording = false;
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
    this.status = 'Audio paused';
  };

  private startMonitor = () => {
    const draw = () => {
      this.monitorRaf = requestAnimationFrame(draw);
      if (!this.showSettings) return;
      const view = this.shadowRoot?.querySelector('shader-ritual-view') as any;
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
        ctx.fillText(b.label, i * w + 5, 15);
      });
    };
    draw();
  };

  /* --------------------------- Config ---------------------------- */

  private updateConfig = (key: string, value: any) => {
    const keys = key.split('.');
    let ref: any = this.config;
    for (let i = 0; i < keys.length - 1; i++) {
      ref[keys[i]] = { ...ref[keys[i]] };
      ref = ref[keys[i]];
    }
    ref[keys[keys.length - 1]] = value;
    this.config = { ...this.config };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.config));
  };

  /* ----------------------------- UI ------------------------------ */

  private renderSlider = (label: string, path: string, min: number, max: number, step: number) => {
    const value = path.split('.').reduce((o, i) => o[i], this.config as any);
    return html`
      <div class="control-row">
        <label>${label}</label>
        <button
          class="midi-learn-btn ${this.learningParam === path ? 'active' : ''} ${this.isMapped(path) ? 'mapped' : ''}"
          @click=${() => this.toggleMidiLearn(path)}>●</button>
        <input type="range" min=${min} max=${max} step=${step} .value=${value}
          @input=${(e: any) => this.updateConfig(path, parseFloat(e.target.value))} />
      </div>
    `;
  };

  private renderElement = (shaderId: string, elementId: string) => {
    const def = getShader(shaderId);
    const meta = def.elements.find((e) => e.id === elementId)!;
    const setting = this.config.shaders[shaderId].elements[elementId];
    const bandPath = `shaders.${shaderId}.elements.${elementId}.band`;
    const amountPath = `shaders.${shaderId}.elements.${elementId}.amount`;
    const visiblePath = `shaders.${shaderId}.elements.${elementId}.visible`;
    return html`
      <div class="element-card ${setting.visible ? '' : 'hidden-el'}">
        <div class="element-head">
          <span class="element-name">${meta.name}</span>
          ${meta.canHide
            ? html`<button
                class="vis-toggle ${setting.visible ? 'on' : 'off'}"
                @click=${() => this.updateConfig(visiblePath, !setting.visible)}>
                ${setting.visible ? 'SHOWN' : 'HIDDEN'}
              </button>`
            : ''}
        </div>
        <div class="element-desc">${meta.description}</div>
        <div class="control-row">
          <label>Audio band</label>
          <select
            .value=${setting.band}
            @change=${(e: any) => this.updateConfig(bandPath, e.target.value as Band)}>
            <option value="none">None</option>
            <option value="low">Low</option>
            <option value="mid">Mid</option>
            <option value="high">High</option>
          </select>
        </div>
        <div class="control-row">
          <label>Reactive amount</label>
          <button
            class="midi-learn-btn ${this.learningParam === amountPath ? 'active' : ''} ${this.isMapped(amountPath) ? 'mapped' : ''}"
            @click=${() => this.toggleMidiLearn(amountPath)}>●</button>
          <input type="range" min="0" max="3" step="0.05" .value=${setting.amount}
            @input=${(e: any) => this.updateConfig(amountPath, parseFloat(e.target.value))} />
        </div>
      </div>
    `;
  };

  private renderSettings() {
    const def = getShader(this.config.activeShader);
    return html`
      <div class="settings-panel ${this.showSettings ? 'open' : ''}">
        <div class="panel-header">
          <h2>Shader Ritual</h2>
          <button class="icon-btn" @click=${() => (this.showSettings = false)}>&times;</button>
        </div>

        <div class="monitor-container"><canvas id="monitorCanvas" width="300" height="80"></canvas></div>

        <!-- SHADER SELECT -->
        <div class="setting-group">
          <span class="group-title">Active Shader</span>
          <select
            class="shader-select"
            .value=${this.config.activeShader}
            @change=${(e: any) => this.updateConfig('activeShader', e.target.value)}>
            ${SHADERS.map((s) => html`<option value=${s.id}>${s.name}</option>`)}
          </select>
          <div class="element-desc" style="margin-top:8px;">${def.description}</div>
        </div>

        <!-- ELEMENT -> AUDIO ALLOCATION (per shader) -->
        <div class="setting-group">
          <span class="group-title">${def.name} · Element Allocation</span>
          ${def.elements.map((el) => this.renderElement(def.id, el.id))}
        </div>

        <!-- RESPONSE PROFILE -->
        <div class="setting-group">
          <span class="group-title">Response Profile</span>
          ${this.renderSlider('FFT Smoothing', 'fftSmoothing', 0, 0.95, 0.05)}
          ${this.renderSlider('Low Gain', 'sensitivity.low', 0, 5, 0.1)}
          ${this.renderSlider('Mid Gain', 'sensitivity.mid', 0, 5, 0.1)}
          ${this.renderSlider('High Gain', 'sensitivity.high', 0, 10, 0.1)}
        </div>

        <!-- NOISE GATES -->
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
          <select
            class="device-select"
            @change=${(e: any) => (this.selectedMidiId = e.target.value)}
            .value=${this.selectedMidiId}>
            <option value="all">Listen to All Devices</option>
            ${this.midiDevices.map((d) => html`<option value=${d.id}>Only: ${d.name}</option>`)}
          </select>
          ${Object.keys(this.midiMappings).length > 0
            ? html`
                <table class="mapping-table">
                  <thead><tr><th>ID</th><th>Target</th><th></th></tr></thead>
                  <tbody>
                    ${Object.entries(this.midiMappings).map(
                      ([id, map]) => html`
                        <tr>
                          <td>${id.toUpperCase()}</td>
                          <td>${map.path.split('.').slice(-2).join('.')}</td>
                          <td style="text-align:right;">
                            <button class="del-map" @click=${() => this.deleteMapping(id)}>🗑️</button>
                          </td>
                        </tr>
                      `,
                    )}
                  </tbody>
                </table>
              `
            : ''}
          <div class="control-row action-row" style="margin-top:10px;">
            <button class="action-btn small" @click=${this.initMidi}>Hardware Scan</button>
            <button
              class="action-btn small"
              @click=${() => {
                this.midiMappings = {};
                localStorage.removeItem(MIDI_MAP_KEY);
                (this as any).requestUpdate();
              }}>
              Clear Mappings
            </button>
          </div>
        </div>

        <!-- SYSTEM -->
        <div class="setting-group">
          <span class="group-title">System</span>
          <div class="control-row action-row">
            <button
              class="action-btn ${this.isRecording ? 'active' : ''}"
              @click=${this.isRecording ? this.stopRecording : this.startRecording}>
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
          <svg viewBox="0 0 24 24">
            <path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87 C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z" />
          </svg>
        </button>
        ${this.renderSettings()}
        <div id="status">${this.error || this.status}</div>
        <shader-ritual-view .config=${this.config} .inputNode=${this.audioNode}></shader-ritual-view>
      </div>
    `;
  }
}
