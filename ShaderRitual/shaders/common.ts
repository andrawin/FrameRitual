/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Full-screen-quad vertex shader shared by every pass. Used with a 2x2
 * PlaneGeometry so `position.xy` already spans clip space [-1, 1].
 */
export const commonVertex = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;
