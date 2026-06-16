/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef, ShaderRitualConfig, ShaderSetting } from './types';
import { sanctum } from './shaders/sanctum';

/** All registered shaders. Add new shaders here. */
export const SHADERS: ShaderDef[] = [sanctum];

export function getShader(id: string): ShaderDef {
  return SHADERS.find((s) => s.id === id) || SHADERS[0];
}

/** Build the per-shader element settings from a shader's declared defaults. */
function defaultShaderSetting(def: ShaderDef): ShaderSetting {
  const elements: ShaderSetting['elements'] = {};
  for (const el of def.elements) {
    elements[el.id] = {
      band: el.defaultBand,
      amount: el.defaultAmount,
      visible: el.defaultVisible,
    };
  }
  return { elements };
}

/** Fresh configuration covering every registered shader. */
export function defaultConfig(): ShaderRitualConfig {
  const shaders: Record<string, ShaderSetting> = {};
  for (const def of SHADERS) shaders[def.id] = defaultShaderSetting(def);
  return {
    activeShader: SHADERS[0].id,
    fftSmoothing: 0.7,
    sensitivity: { low: 1.5, mid: 1.5, high: 2.5 },
    thresholds: { low: 0.15, mid: 0.15, high: 0.15 },
    shaders,
  };
}

/**
 * Merge a (possibly stale) saved config over current registry defaults so new
 * shaders / elements always appear with sane defaults.
 */
export function sanitizeConfig(saved: any): ShaderRitualConfig {
  const base = defaultConfig();
  if (!saved || typeof saved !== 'object') return base;

  const merged: ShaderRitualConfig = {
    ...base,
    ...saved,
    sensitivity: { ...base.sensitivity, ...(saved.sensitivity || {}) },
    thresholds: { ...base.thresholds, ...(saved.thresholds || {}) },
    shaders: { ...base.shaders },
  };

  for (const def of SHADERS) {
    const savedShader = saved.shaders?.[def.id];
    const baseShader = base.shaders[def.id];
    const elements = { ...baseShader.elements };
    for (const el of def.elements) {
      const savedEl = savedShader?.elements?.[el.id];
      if (savedEl) elements[el.id] = { ...elements[el.id], ...savedEl };
    }
    merged.shaders[def.id] = { elements };
  }

  if (!getShader(merged.activeShader)) merged.activeShader = base.activeShader;
  return merged;
}
