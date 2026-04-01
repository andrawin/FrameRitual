
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
const vs = `#define STANDARD
varying vec3 vViewPosition;
#ifdef USE_TRANSMISSION
  varying vec3 vWorldPosition;
#endif
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>

uniform float time;
uniform vec4 inputData;
uniform vec4 outputData;

// Enhanced liquid displacement algorithm
float getDisplacement( vec3 pos ) {
  // outputData.x = bass, y = mid, z = high (normalized 0-1 range roughly)
  // Scaling factors to match the values sent from visual-3d.ts
  float b = outputData.x * 0.5;
  float m = outputData.y * 2.0;
  float h = outputData.z * 0.1;

  float disp = 0.0;

  // Layer 1: Bass Swells (Slow, broad movements)
  disp += b * (sin(pos.x * 1.5 + time * 0.8) * cos(pos.y * 1.2 + time * 0.6));
  
  // Layer 2: Mid Ripples (Complex interference)
  disp += m * (sin(pos.z * 4.0 - time * 1.5) * sin(pos.x * 3.0 + time * 1.2));
  
  // Layer 3: High Freq Surface Tension (Micro-vibrations)
  disp += h * (sin(pos.y * 12.0 + time * 4.0) * cos(pos.z * 10.0 - time * 3.0));

  return disp;
}

void main() {
  #include <uv_vertex>
  #include <color_vertex>
  #include <morphinstance_vertex>
  #include <morphcolor_vertex>
  #include <batching_vertex>
  #include <beginnormal_vertex>
  #include <morphnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>
  #include <normal_vertex>
  #include <begin_vertex>

  // Displace along the vertex normal for the volume effect
  float disp = getDisplacement(position);
  vec3 displacement = objectNormal * disp;
  
  transformed += displacement;

  // Perturb normal for accurate liquid lighting
  float delta = 0.02;
  float dX = getDisplacement(position + vec3(delta, 0.0, 0.0)) - disp;
  float dY = getDisplacement(position + vec3(0.0, delta, 0.0)) - disp;
  float dZ = getDisplacement(position + vec3(0.0, 0.0, delta)) - disp;
  
  vec3 grad = normalize(vec3(dX, dY, dZ));
  vNormal = normalize(vNormal - grad * 0.6); 

  #include <morphtarget_vertex>
  #include <skinning_vertex>
  #include <displacementmap_vertex>
  #include <project_vertex>
  #include <logdepthbuf_vertex>
  #include <clipping_planes_vertex>
  vViewPosition = - mvPosition.xyz;
  #include <worldpos_vertex>
  #include <shadowmap_vertex>
  #include <fog_vertex>
  #ifdef USE_TRANSMISSION
    vWorldPosition = worldPosition.xyz;
  #endif
}`;

export {vs};
