/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Bands } from './types';

/**
 * Split a raw FFT frame into low / mid / high energy, apply per-band
 * sensitivity, then a noise gate. Returns both the post-sensitivity raw
 * values (useful for metering) and the gated values used to drive shaders.
 *
 * Bin ranges mirror FrameRitual: ~bass 1-7, mid 8-93, high 94-465 (with a
 * high-band boost since treble energy reads low on the byte FFT).
 */
export function computeBands(
  data: Uint8Array,
  sensitivity: { low: number; mid: number; high: number },
  thresholds: { low: number; mid: number; high: number },
): Bands {
  let bSum = 0;
  for (let i = 1; i <= 7; i++) bSum += data[i];
  const b = bSum / 7;

  let mSum = 0;
  for (let i = 8; i <= 93; i++) mSum += data[i];
  const m = mSum / 86;

  let hSum = 0;
  for (let i = 94; i <= 465; i++) hSum += data[i];
  const h = (hSum / 372) * 3.5;

  const rawLow = Math.min(1, (b / 255) * sensitivity.low);
  const rawMid = Math.min(1, (m / 255) * sensitivity.mid);
  const rawHigh = Math.min(1, (h / 255) * sensitivity.high);

  const gate = (v: number, t: number) =>
    Math.max(0, v - t) / (1 - Math.max(0.01, t));

  return {
    rawLow,
    rawMid,
    rawHigh,
    low: gate(rawLow, thresholds.low),
    mid: gate(rawMid, thresholds.mid),
    high: gate(rawHigh, thresholds.high),
  };
}
