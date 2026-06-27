/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/** Audio frequency band a part/fragment can be wired to. */
export type Band = 'none' | 'low' | 'mid' | 'high';

/** What an audio band drives on a model part. */
export type ReactTarget = 'scale' | 'emissive' | 'explode' | 'rotate';

/** Per-part audio-reactive allocation (parts mode). */
export interface PartSetting {
  band: Band;
  amount: number;
  target: ReactTarget;
  visible: boolean;
}

/** Screen-capture projection plane settings. */
export interface CaptureSetting {
  opacity: number;
  scale: number;
  mode: 'background' | 'floating';
  reactive: boolean;
  reactiveBand: Band;
  visible: boolean;
}

/** What a detected beat does to the fragments in physics mode. */
export type BeatAction = 'burst' | 'implode' | 'pulse' | 'alternate';

/** Rigid-body-ish simulation settings for fracture fragments. */
export interface PhysicsSetting {
  enabled: boolean;
  gravity: number;
  burstStrength: number;
  spin: number;
  restitution: number;
  floor: boolean;
  /** Beat trigger: rising edge of this band past the threshold fires an action. */
  beatBand: Band;
  beatThreshold: number;
  beatAction: BeatAction;
  /** Spring strength used to suck fragments back to rest on implode. */
  implodeStrength: number;
}

/** Group settings for procedural fracture mode. */
export interface FractureSetting {
  fragments: number;
  explodeBand: Band;
  explodeAmount: number;
  spinBand: Band;
  spinAmount: number;
  scaleBand: Band;
  scaleAmount: number;
  /** Distribute fragments across low/mid/high (each third driven by one band). */
  distribute: boolean;
  visible: boolean;
  physics: PhysicsSetting;
}

export interface MeshRitualConfig {
  fftSmoothing: number;
  sensitivity: { low: number; mid: number; high: number };
  thresholds: { low: number; mid: number; high: number };
  mode: 'parts' | 'fracture';
  modelScale: number;
  autoRotate: boolean;
  rotateSpeed: number;
  bloom: number;
  /** Per-part settings, keyed by part id (rebuilt when a model loads). */
  parts: Record<string, PartSetting>;
  fracture: FractureSetting;
  capture: CaptureSetting;
}

/** Live audio band readout (post-sensitivity raw + post-gate values). */
export interface Bands {
  low: number;
  mid: number;
  high: number;
  rawLow: number;
  rawMid: number;
  rawHigh: number;
}

/** Lightweight descriptor emitted to the UI when a model is decomposed. */
export interface PartInfo {
  id: string;
  name: string;
}
