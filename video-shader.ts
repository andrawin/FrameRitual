export const vs = `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const fs = `
uniform sampler2D map;
uniform float time;
uniform float bass;
uniform float mid;
uniform float high;
uniform int filterType;
uniform float filterIntensity;
uniform float opacity;
varying vec2 vUv;

void main() {
    vec2 uv = vUv;
    vec4 color = texture2D(map, uv);
    
    if (filterType == 1) { // Invert
        float inv = mix(0.0, 1.0, filterIntensity * bass);
        color.rgb = mix(color.rgb, 1.0 - color.rgb, inv);
    } else if (filterType == 2) { // Glitch
        float shift = filterIntensity * bass * 0.1;
        float r = texture2D(map, uv + vec2(shift, 0.0)).r;
        float g = texture2D(map, uv).g;
        float b = texture2D(map, uv - vec2(shift, 0.0)).b;
        color = vec4(r, g, b, color.a);
        if (mod(uv.y * 100.0 + time * 10.0, 2.0) < 1.0) {
            color.rgb *= (1.0 - filterIntensity * mid * 0.5);
        }
    } else if (filterType == 3) { // Pixelate
        float pixels = max(10.0, 100.0 - (filterIntensity * bass * 90.0));
        vec2 pUv = floor(uv * pixels) / pixels;
        color = texture2D(map, pUv);
    } else if (filterType == 4) { // Edge
        vec2 texel = vec2(1.0 / 1024.0, 1.0 / 1024.0);
        vec4 c00 = texture2D(map, uv + vec2(-texel.x, -texel.y));
        vec4 c10 = texture2D(map, uv + vec2(0.0, -texel.y));
        vec4 c20 = texture2D(map, uv + vec2(texel.x, -texel.y));
        vec4 c01 = texture2D(map, uv + vec2(-texel.x, 0.0));
        vec4 c21 = texture2D(map, uv + vec2(texel.x, 0.0));
        vec4 c02 = texture2D(map, uv + vec2(-texel.x, texel.y));
        vec4 c12 = texture2D(map, uv + vec2(0.0, texel.y));
        vec4 c22 = texture2D(map, uv + vec2(texel.x, texel.y));
        vec4 sx = -c00 - 2.0 * c01 - c02 + c20 + 2.0 * c21 + c22;
        vec4 sy = -c00 - 2.0 * c10 - c20 + c02 + 2.0 * c12 + c22;
        vec4 edge = sqrt(sx * sx + sy * sy);
        float intensity = filterIntensity * high;
        color.rgb = mix(color.rgb, edge.rgb, intensity);
    } else if (filterType == 5) { // Blob Distortion
        float intensity = filterIntensity * bass * 0.2;
        vec2 center = vec2(0.5, 0.5);
        float dist = distance(uv, center);
        vec2 dir = normalize(uv - center);
        float blob = sin(dist * 20.0 - time * 5.0) * intensity;
        vec2 bUv = uv + dir * blob;
        color = texture2D(map, bUv);
    }
    
    gl_FragColor = vec4(color.rgb, color.a * opacity);
}
`;
