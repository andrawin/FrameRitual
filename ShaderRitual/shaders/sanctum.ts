/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Sanctum" — a raymarched reflective chamber.
 *
 * Adapted from a Shadertoy multi-pass shader (Buffer A + Image bloom pass).
 * The scene's distinct parts have been broken out into addressable ELEMENTS,
 * each driven by an audio band via two auto-generated uniforms:
 *   <id>_react   -> band value * amount   (reactivity)
 *   <id>_visible -> 1.0 / 0.0             (hide toggle)
 *
 * Elements:
 *   core   -> the morphing fractal object at the centre (drives morph + spin)
 *   beams  -> the moving emissive light bars (drives emission + glow)
 *   walls  -> the surrounding chamber architecture (drives surface brightness)
 *   bloom  -> the Image-pass blur/atmosphere (drives bloom spread)
 */

const bufferShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform float iTime;

uniform float core_react;
uniform float core_visible;
uniform float beams_react;
uniform float beams_visible;
uniform float walls_react;
uniform float walls_visible;

vec3 ov(vec3 a, vec3 b){
    return mix(2.*a*b,1.-2.*(1.-a)*(1.-b),step(a,vec3(0.5)));}
float rd(vec2 uv ) { return fract(sin(dot(floor(uv),vec2(84.266,95.248)))*4587.236);}
float hs(vec2 uv ) { return fract(sin(dot((uv),vec2(84.266,95.248)))*4587.236+iTime*5.);}
float no(vec2 uv) {vec2 e=vec2(1.,0.);float a =rd(uv);
  float b=rd(uv+e.xy);
  float c=rd(uv+e.yx);
  float d=rd(uv+e.xx);
  vec2 h = smoothstep(0.,1.,fract(uv));
  return mix(mix(a,b,h.x),mix(c,d,h.x),h.y);}
float it(vec2 uv){float r=0.;float amp = 0.5;
  for(int i =0; i < 5 ; i++){r += no(uv/amp)*amp;
    amp*=0.5;}return r;}
float rd(float uv ) { return fract(sin(dot(floor(uv),95.236))*4587.236);}
float no(float t){return mix(rd(t),rd(t+1.),smoothstep(0.,1.,fract(t)));}
float it(float uv){float r=0.;float amp = 0.5;
  for(int i =0; i < 4 ; i++){r += no(uv/amp)*amp;
    amp*=0.5;}return r;}
mat2 rot(float t){float c= cos(t);float s=sin(t);return mat2(c,s,-s,c);}
float box (vec3 p, vec3 b){
  vec3 q = abs(p)-b;
  return length(max(vec3(0.),q))+min(max(q.x,max(q.y,q.z)),0.);
}
float cyl( vec3 p, float h, float r )
{
  vec2 d = abs(vec2(length(p.xy),p.z)) - vec2(h,r);
  return min(max(d.x,d.y),0.0) + length(max(d,0.0));
}
float mat = 0.;
float mata = 0.;
float lit = 0.;
float map(vec3 p) {
  vec3 p2 = p;
  p2 = abs(p);
  vec3 p3 = p+vec3(0.,0.5,0.);
  for (int i = 0 ;  i < 5 ; i ++ ) {
    p3 -=0.2;
    p3.xy *= rot (it(iTime*0.2 + core_react*0.5)*10.);
    p3.xz *= rot (it(iTime*0.2+15.236 + core_react*0.5)*10.);
    p3 = abs(p3);
  }
  vec3 rp4 = vec3(0.8,0.,2.);
  vec3 p4 = mod(p+vec3(-0.2,-1.9,0.)+0.5*rp4,rp4)-0.5*rp4;

  float c1 = box(p2+vec3(0.,0.,-6.),vec3(6.,3.5,1.));
  float c2 = box(p2+vec3(-5.,0.,0.),vec3(1.,3.5,6.));
  float c3 = box(p2+vec3(0.,-3.-step(0.5,fract(p.x*5.))*0.2,0.),vec3(6.5,1.,6.5));
  float c4 = length(p3)-0.2;
  float c5 = box(p3,vec3(0.2));
  float c6 = mix(c4,c5,smoothstep(0.7,1.,fract(iTime*2.5 + core_react)));

  float sa = min(min(c1,c2),c3);
  if (walls_visible < 0.5) sa = 1e5;
  float el1 = box(p4,vec3(0.1,0.05,0.8));
  if (beams_visible < 0.5) el1 = 1e5;
  if (core_visible < 0.5) c6 = 1e5;
  float sf = min(sa,el1);

  mat = c6;
  mata = el1;

  lit += (0.05 + beams_react*0.25)/(0.05+el1);
  return min(sf,c6);
}
vec3 nor (vec3 p) { vec2 e = vec2 (0.01,0.); return normalize(map(p)-vec3(map(p-e.xyy),map(p-e.yxy),map(p-e.yyx)));}
void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
    vec2 uv = fragCoord/iResolution.xy;
    float time = iTime;
    uv -= 0.5;
  uv *=2.;
  uv *= vec2(iResolution.x /iResolution.y, 1.);
  float t = (it(time*0.1)-0.5)*30.+time*0.1;

  vec3 e = vec3(0.,-0.5,-3.5);
  vec3 r = normalize(vec3(uv,1.6));
  e.xz *= rot(t);
  r.xz *= rot(t);

vec3 col = vec3(0.);
  vec3 p = e;
   float prod = 1.;
  float dd = 0.;
  float cli = mix(0.,1.,smoothstep(0.1,0.5,it(time*8.)));
  for(int i = 0 ; i < 64 ; i ++ ){
    float d = map(p);
    if(dd>64.){dd=64.;break;}
    if(d<0.001){
        vec3 n = nor(p);
      float br =smoothstep(0.1,0.,mat);
      float pla =smoothstep(0.06,0.,mata)*smoothstep(-0.5,0.2,mata);
      float lite = lit;
      float li = (smoothstep(2.5,0.,mata)*0.5+smoothstep(0.5,0.,mata)*0.6)*smoothstep(0.,0.05,mata);
      float bao = map(p+n);
      float ao = mix(0.1,1.,smoothstep(-1.8,0.4,bao))*mix(0.95,1.,smoothstep(0.,1.,bao));
      float ao2 = smoothstep(0.2,1.,bao);
      float ao3 = smoothstep(0.,0.1,bao);
      float sol = smoothstep(-2.,-1.97,p.y);
      float plaf = smoothstep(2.,1.97,p.y);
        float flati = smoothstep(-2.,-0.5,p.y);
       vec3 bb = mix(vec3(0.07)*ao,mix(vec3(0.08,0.09,0.09),vec3(0.11,0.11,0.13),flati)*ao,sol*plaf);
       bb *= (1.0 + walls_react*1.5);
       float bs = clamp(dot(n,-r),0.,1.);
       float spec = smoothstep(0.995,1.,bs)*ao2;
      vec3 hb = mix(3.*(1.-2.*fract(bs*2.+vec3(0.,-1./3.,1./3.)))-1.,vec3(0.5),mix(0.6,1.,bs))+(1.-ao3)*0.8;
      vec3 n2 = abs(n);
      float bm = mix(it(p.xy)-it(p.xy+vec2(0.,0.01)),it(p.zy)-it(p.zy+vec2(0.,0.01)),n2.x);
      col += (li*0.2*mix(0.9,1.,ao3)*mix(0.5,1.,plaf)+bm*0.5);
      col += (pla*(1.0+beams_react)*mix(vec3(0.8,0.7,0.6),vec3(1.),bs));
      col += spec*br*ao2;
      col += lite*0.01*cli;
      col *=cli;
      col += prod *bb*mix(vec3(1.),hb,br);
      col = clamp(col,0.,1.);

     prod *=br*mix(0.1,1.,ao2)+(1.-sol)*(it(p.xz)*hs(p.xz)*0.03*ao);
    if(prod<0.01){break;}
    r = reflect(r,n);
    d = 0.01;
    }

    p += r*d;
    dd +=d;
  }
 	vec3 colf = ov(col,mix(vec3(hs(uv),hs(uv),hs(uv)),vec3(0.5),0.97));
    fragColor = vec4(colf,1.);
}
void main(){ vec4 c; mainImage(c, vUv*iResolution.xy); gl_FragColor = c; }
`;

const imageShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform sampler2D iChannel0;
uniform float bloom_react;
uniform float bloom_visible;

vec3 bl(vec2 uv){
 vec2 r  = iResolution.xy;
    vec2 f = uv*r;
    vec3 col = vec3(0.);
    float spread = 1.0 + bloom_react*2.0;
    const int B = 4;
    for(int i = -B; i<=B; i++)
    for(int j= -B; j<=B; j++)
    {
        vec2 o = vec2(float(i), float(j));
        col += texture2D(iChannel0,uv+o*spread*mix(3.,12.,2.*abs(uv.y-.5))*exp(-abs(1.e-2*length(f.xy)/r.y-.5))/8.0/r.xy).xyz;
    }
    col /= 64.;
    return col;
}
void mainImage( out vec4 fragColor, in vec2 fragCoord )
{
    vec2 uv = fragCoord/iResolution.xy;
    vec3 src = (bloom_visible > 0.5) ? bl(uv) : texture2D(iChannel0,uv).xyz;
    vec3 t = smoothstep(vec3(-0.05,-0.1,-0.05),vec3(1.,1.,0.95),src);
    fragColor = vec4(t,1.);
}
void main(){ vec4 c; mainImage(c, vUv*iResolution.xy); gl_FragColor = c; }
`;

export const sanctum: ShaderDef = {
  id: 'sanctum',
  name: 'Sanctum',
  description: 'Raymarched reflective chamber with a morphing core and scanning beams.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'core',
      name: 'Reactor Core',
      description: 'Morphing fractal object at the centre. React drives morph + spin.',
      defaultBand: 'mid',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'beams',
      name: 'Scanning Beams',
      description: 'Moving emissive light bars. React drives emission + glow.',
      defaultBand: 'low',
      defaultAmount: 1.5,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'walls',
      name: 'Chamber Walls',
      description: 'Surrounding architecture. React drives surface brightness.',
      defaultBand: 'high',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'bloom',
      name: 'Atmosphere',
      description: 'Post-process bloom haze. React drives bloom spread.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
  ],
};
