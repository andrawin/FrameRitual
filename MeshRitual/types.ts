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
}

export interface MeshRitualConfig {
  fftSmoothing: number;
  sensitivity: { low: number; mid: number; high: number };
  thresholds: { low: number; mid: number; high: number };
  mode: 'parts' | 'fracture';
  autoRotate: boolean;
  rotateSpeed: number;
  bloom: number;
  /** Per-part settings, keyed by part id (rebuilt when a model loads). */
  parts: Record<string, PartSetting>;
  fracture: FractureSetting;
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
