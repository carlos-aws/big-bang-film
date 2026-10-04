// Scene "cosmicdawn" (T 30-47): the dark ages, the first stars, the first supernova and the
// first proto-galaxies.
//
// Rendering:
//   * gas: half-resolution fullscreen raymarch through a bounded volume (sphere r = GAS_R).
//     Density = baked filament/knot structure (3D texture, built once at init from a knot graph)
//     x tileable detail noise (3D texture) advected toward the knots with a two-phase flow map
//     (gas visibly falls into the knots). Lighting comes from a per-frame light volume (2D atlas):
//     ionised-bubble signed distance + star illumination + supernova illumination.
//   * supernova shell: full-res analytic shell segments with filament noise.
//   * stars / bubble glows / proto-galaxy clumps: instanced gaussian sprites, flux-conserving
//     (never smaller than ~1.1 px sigma, intensity fades instead -> no shimmer).
// Everything is a pure function of the film time.
(function () {
  'use strict';
  const U = window.U;
  const M = U.math;

  const REGION = 4.5; // structure / light volumes cover [-REGION, REGION]^3
  const GAS_R = 4.4; // raymarch bounding sphere
  const DETAIL_W = 2.0; // world size of one tile of the detail noise
  const FOCAL = 1.07; // focal length in shorter-side units (~50 deg across the short side)
  const NFS = 24; // first stars
  const NKNOT = 12; // local gas knots = future local proto-galaxies
  const LIGHT_SLOTS = 24;
  // ignition flare: sigma (world), peak radiance, decay (s), lingering peak
  const IGN_SIG = [0.032, 0.1, 0.27], IGN_PK = [16, 0.8, 0.13], IGN_TAU = [0.12, 0.09, 0.07], IGN_PK2 = [1.2, 0.22, 0.025];
  const INF_R = 1.15, INF_S = 0.85; // collapse onto the first-star knot: reach (world), strength by first light
  const CORE_GLOW = 0.9; // pre-ignition glow of the collapsing first-star core (see uCore)
  const DA_AZ = 0.55, DA_EL = 0.12, DA_DOLLY = 0.14; // dark-ages camera drift (see camera())
  const DA_FLOW = 1.5; // extra gas-flow speed during the dark ages (x real time), gone by ~36.5

  const S = { ready: false };

  // ================================================================== shaders
  const P3 = '\nprecision highp sampler3D;\n';

  // ---- periodic noise used to bake the tileable detail texture
  const PNOISE = `
vec3 pgrad(ivec3 c, int per, uint salt) {
  ivec3 m = (c + per * 4) % per;
  uint h = uhash(uvec3(m) + uvec3(salt, salt * 7u + 3u, salt * 13u + 5u));
  uint h2 = uhash(h), h3 = uhash(h2);
  vec3 g = vec3(float(h), float(h2), float(h3)) * (2.0 / 4294967296.0) - 1.0;
  return g / max(length(g), 1e-3);
}
float pnoise(vec3 p, int per, uint salt) {
  vec3 fi = floor(p); vec3 f = p - fi; ivec3 i = ivec3(fi);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = dot(pgrad(i, per, salt), f);
  float n100 = dot(pgrad(i + ivec3(1, 0, 0), per, salt), f - vec3(1, 0, 0));
  float n010 = dot(pgrad(i + ivec3(0, 1, 0), per, salt), f - vec3(0, 1, 0));
  float n110 = dot(pgrad(i + ivec3(1, 1, 0), per, salt), f - vec3(1, 1, 0));
  float n001 = dot(pgrad(i + ivec3(0, 0, 1), per, salt), f - vec3(0, 0, 1));
  float n101 = dot(pgrad(i + ivec3(1, 0, 1), per, salt), f - vec3(1, 0, 1));
  float n011 = dot(pgrad(i + ivec3(0, 1, 1), per, salt), f - vec3(0, 1, 1));
  float n111 = dot(pgrad(i + ivec3(1, 1, 1), per, salt), f - vec3(1, 1, 1));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
             mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
float pworley(vec3 p, int per, uint salt) {
  vec3 fi = floor(p); vec3 f = p - fi; ivec3 i = ivec3(fi);
  float d = 9.0;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    ivec3 c = i + ivec3(x, y, z);
    ivec3 m = (c + per * 4) % per;
    uint h = uhash(uvec3(m) + uvec3(salt));
    uint h2 = uhash(h), h3 = uhash(h2);
    vec3 o = vec3(float(h), float(h2), float(h3)) * (1.0 / 4294967296.0);
    vec3 r = vec3(float(x), float(y), float(z)) + o - f;
    d = min(d, dot(r, r));
  }
  return sqrt(d);
}
`;

  const GEN_DETAIL_FS = U.glsl.frag(P3 + PNOISE + `
in vec2 vUv; out vec4 o;
uniform float uZ;
void main() {
  vec3 p = vec3(vUv, uZ);
  // R: soft billows (fbm)
  float r = 0.5 * pnoise(p * 3.0, 3, 11u) + 0.25 * pnoise(p * 6.0, 6, 12u) + 0.125 * pnoise(p * 12.0, 12, 13u) + 0.0625 * pnoise(p * 24.0, 24, 14u);
  // G: ridged wisps
  float g = 0.0, a = 0.5;
  for (int k = 0; k < 3; k++) {
    int per = 5 << k;
    float n = 1.0 - abs(pnoise(p * float(per), per, 21u + uint(k)) * 1.7);
    g += a * n * n; a *= 0.5;
  }
  g /= 0.875;
  // B: fine fbm
  float b = 0.5 * pnoise(p * 8.0, 8, 31u) + 0.3 * pnoise(p * 16.0, 16, 32u) + 0.2 * pnoise(p * 32.0, 32, 33u);
  // A: cellular clumps
  float w = 1.0 - pworley(p * 6.0, 6, 41u) * 1.15;
  o = vec4(clamp(0.5 + r * 1.35, 0.0, 1.0), clamp(g, 0.0, 1.0), clamp(0.5 + b * 1.4, 0.0, 1.0), clamp(w, 0.0, 1.0));
}`);

  // Structure: MRT -> (filament, knot, mask, 0) and (flow*0.5+0.5, 1)
  const GEN_STRUCT_FS = U.glsl.frag(P3 + `
in vec2 vUv;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
uniform float uZ;
uniform vec4 uKnots[${NKNOT}];
uniform vec4 uSegA[40];
uniform vec4 uSegB[40];
uniform int uNSeg;
const float REGION = ${REGION.toFixed(2)};
float segDist(vec3 p, vec3 a, vec3 b) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}
void main() {
  vec3 p = (vec3(vUv, uZ) * 2.0 - 1.0) * REGION;
  vec3 w = vec3(snoise(p * 0.33 + vec3(1.3, 0.2, 4.1)), snoise(p * 0.33 + vec3(7.1, 3.3, 0.7)), snoise(p * 0.33 + vec3(3.7, 9.2, 2.2)));
  vec3 w2 = vec3(snoise(p * 0.9 + vec3(5.3, 1.2, 0.1)), snoise(p * 0.9 + vec3(2.1, 6.3, 8.7)), snoise(p * 0.9 + vec3(0.7, 3.2, 5.2)));
  vec3 pw = p + w * 0.42 + w2 * 0.12;
  float fil = 0.0;
  for (int i = 0; i < 40; i++) {
    if (i >= uNSeg) break;
    float d = segDist(pw, uSegA[i].xyz, uSegB[i].xyz);
    float th = uSegA[i].w;
    fil = max(fil, uSegB[i].w * exp(-0.5 * d * d / (th * th)));
  }
  // secondary tendrils, not tied to the knot graph
  float rg = ridged(pw * 0.55 + 3.3, 3);
  fil = max(fil, 0.42 * pow(rg, 4.0));
  float knot = 0.0;
  vec3 g = vec3(0.0);
  for (int k = 0; k < ${NKNOT}; k++) {
    vec3 d = uKnots[k].xyz - pw;
    float r2 = dot(d, d);
    knot = max(knot, uKnots[k].w * exp(-0.5 * r2 / (0.42 * 0.42)));
    g += uKnots[k].w * d / pow(r2 + 0.2, 1.5);
  }
  vec3 flow = g / (1.0 + length(g));
  float rr = length(p) + 0.55 * snoise(p * 0.42 + 2.0);
  float mask = 1.0 - smoothstep(2.4, 4.2, rr);
  mask *= 1.0 - smoothstep(${(GAS_R - 0.5).toFixed(2)}, ${GAS_R.toFixed(2)}, length(p));
  o0 = vec4(clamp(fil, 0.0, 1.0), clamp(knot, 0.0, 1.0), clamp(mask, 0.0, 1.0), 0.0);
  o1 = vec4(flow * 0.5 + 0.5, 1.0);
}`);

  // Per-frame light volume (2D atlas of N slices).
  const LIGHT_FS = U.glsl.frag(`
out vec4 o;
uniform vec4 uStar[${LIGHT_SLOTS}]; // xyz, bubble radius
uniform float uStarL[${LIGHT_SLOTS}];
uniform int uNStar;
uniform vec2 uStarE[${LIGHT_SLOTS}]; // light echo of the ignition flash: radius, strength
uniform vec4 uSNL; // xyz, strength
uniform vec4 uSNS; // shell radius, shell strength, echo radius, echo strength
uniform vec3 uAtlas; // N, tiles per row, atlas px
const float REGION = ${REGION.toFixed(2)};
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  int N = int(uAtlas.x), tiles = int(uAtlas.y);
  int tx = px.x / N, ty = px.y / N;
  int z = ty * tiles + tx;
  if (z >= N || tx >= tiles) { o = vec4(0.0); return; }
  vec3 uvw = (vec3(float(px.x - tx * N), float(px.y - ty * N), float(z)) + 0.5) / float(N);
  vec3 p = (uvw * 2.0 - 1.0) * REGION;
  float sd = -1.0, il = 0.0, ec = 0.0;
  for (int i = 0; i < ${LIGHT_SLOTS}; i++) {
    if (i >= uNStar) break;
    vec3 d = p - uStar[i].xyz;
    float r2 = dot(d, d);
    float r = sqrt(r2);
    if (uStar[i].w > 0.0) sd = max(sd, uStar[i].w - r);
    // light-travel: a newborn star only lights the gas its light front (radius uStarE.x) has reached
    float gate = uStarE[i].x > 0.0 ? 1.0 - smoothstep(uStarE[i].x - 0.15, uStarE[i].x + 0.15, r) : 1.0;
    il += gate * uStarL[i] / (r2 + 0.03);
    // the ignition flash travels outward through the neutral gas as a thin lit shell
    if (uStarE[i].y > 0.0) {
      float x = (r - uStarE[i].x) * 4.5;
      ec += uStarE[i].y * exp(-x * x) / (1.0 + uStarE[i].x * uStarE[i].x * 0.35);
    }
  }
  vec3 d = p - uSNL.xyz;
  float r2 = dot(d, d);
  float rs = sqrt(r2);
  float isn = uSNL.w / (r2 + 0.05) * (1.0 - smoothstep(uSNS.z - 0.2, uSNS.z + 0.2, rs));
  // the shock front itself lights its surroundings
  isn += uSNS.y * exp(-abs(rs - uSNS.x) * 5.0);
  if (uSNS.w > 0.0) { float x = (rs - uSNS.z) * 3.2; ec += uSNS.w * exp(-x * x); }
  o = vec4(clamp(sd, -1.0, 1.0) * 0.5 + 0.5, il / (1.0 + il), isn / (1.0 + isn), ec / (1.0 + ec));
}`);

  const CAMERA_GLSL = `
uniform vec3 uEye, uRight, uUp, uFwd;
uniform vec2 uRes;
const float FOCAL = ${FOCAL.toFixed(3)};
vec3 rayDir(vec2 uv) {
  vec2 q = (uv - 0.5) * uRes / min(uRes.x, uRes.y);
  return normalize(uRight * q.x + uUp * q.y + uFwd * FOCAL);
}
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
`;

  const GAS_FS = U.glsl.frag(P3 + CAMERA_GLSL + `
in vec2 vUv; out vec4 o;
uniform sampler3D uStruct, uFlow, uDetail;
uniform sampler2D uLight;
uniform vec3 uAtlas;
uniform float uSteps;
uniform float uFlowT;
uniform vec3 uDrift;
uniform float uFilK, uFilAmp, uKnotK, uKnotAmp, uBgAmp;
uniform float uNeutral, uRed, uIon, uFront, uScat, uSigma, uSNAmp;
uniform vec4 uSN; // center, radius (<=0: none)
uniform float uSNClear;
uniform vec4 uInfall; // collapse onto the first-star knot: centre, strength (structure scaled about it)
uniform float uEcho;
uniform vec2 uCore; // the collapsing first-star core heats up before ignition: glow, radius
const float REGION = ${REGION.toFixed(2)};
const float GAS_R = ${GAS_R.toFixed(2)};
const float W = ${DETAIL_W.toFixed(2)};
const float CYC = 3.2;   // flow-map cycle (s)
const float VEL = 0.2;   // flow speed scale (units/s)
const float INF_R = ${INF_R.toFixed(2)}; // reach of the collapse onto the first-star knot

vec4 lightAt(vec3 p) {
  vec3 uvw = clamp(p / (2.0 * REGION) + 0.5, 0.0, 1.0);
  float N = uAtlas.x, tiles = uAtlas.y, A = uAtlas.z;
  float z = uvw.z * N - 0.5;
  float z0 = clamp(floor(z), 0.0, N - 1.0);
  float z1 = min(z0 + 1.0, N - 1.0);
  float fz = clamp(z - z0, 0.0, 1.0);
  vec2 xy = clamp(uvw.xy * N, 0.5, N - 0.5);
  vec2 t0 = vec2(mod(z0, tiles), floor(z0 / tiles)) * N;
  vec2 t1 = vec2(mod(z1, tiles), floor(z1 / tiles)) * N;
  vec4 e = mix(texture(uLight, (t0 + xy) / A), texture(uLight, (t1 + xy) / A), fz);
  return vec4(e.r * 2.0 - 1.0, e.g / max(1.0 - e.g, 2e-3), e.b / max(1.0 - e.b, 2e-3), e.a / max(1.0 - e.a, 2e-3));
}

void main() {
  vec3 rd = rayDir(vUv);
  vec3 ro = uEye;
  float b = dot(ro, rd), c = dot(ro, ro) - GAS_R * GAS_R;
  float h = b * b - c;
  if (h <= 0.0) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
  h = sqrt(h);
  float t0 = max(-b - h, 0.0), t1 = -b + h;
  if (t1 <= 0.0) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
  int N = int(uSteps);
  float dt = (t1 - t0) / float(N);
  float t = t0 + dt * ign(gl_FragCoord.xy);

  float ph0 = fract(uFlowT / CYC), ph1 = fract(uFlowT / CYC + 0.5);
  float c0 = floor(uFlowT / CYC), c1 = floor(uFlowT / CYC + 0.5);
  vec3 off0 = fract(vec3(0.371, 0.613, 0.137) * c0);
  vec3 off1 = fract(vec3(0.529, 0.281, 0.773) * c1 + 0.5);
  float wB = abs(ph0 * 2.0 - 1.0);
  float d0 = ph0 * CYC * VEL, d1 = ph1 * CYC * VEL;

  const vec3 NEUTRAL = vec3(0.52, 0.52, 0.86);
  const vec3 RED = vec3(0.62, 0.26, 0.12);
  const vec3 ION = vec3(0.42, 0.46, 1.0);
  const vec3 FRONT = vec3(0.72, 0.48, 1.0);
  const vec3 SCAT = vec3(0.55, 0.65, 1.0);
  const vec3 SNC = vec3(1.0, 0.62, 0.34);
  const vec3 ECHO = vec3(0.62, 0.72, 1.0);
  const vec3 CORE = vec3(0.66, 0.62, 1.0);
  float coreK = uCore.x > 0.0 ? 1.0 / (uCore.y * uCore.y) : 0.0;

  vec3 col = vec3(0.0);
  float tr = 1.0;
  for (int i = 0; i < 64; i++) {
    if (i >= N) break;
    vec3 p = ro + rd * t;
    // q: where this gas sat before it fell toward the first-star knot (mass-conserving: denser by jac)
    vec3 q = p;
    float jac = 1.0;
    if (uInfall.w > 0.0) {
      vec3 dq = p - uInfall.xyz;
      float s = uInfall.w * exp(-dot(dq, dq) * (1.0 / (INF_R * INF_R)));
      q = uInfall.xyz + dq * (1.0 + s);
      jac = (1.0 + s) * (1.0 + s);
    }
    vec3 sp = q / (2.0 * REGION) + 0.5;
    vec4 st = texture(uStruct, sp);
    float mask = st.b * smoothstep(0.05, 0.6, t);
    float fil = pow(st.r, uFilK);
    float knot = pow(st.g, uKnotK);
    // empty voids: skip the detail / flow / light fetches entirely
    if (mask > 0.003 && fil + knot > 0.012) {
      vec3 fl = texture(uFlow, sp).xyz * 2.0 - 1.0;
      vec3 bp = q + uDrift;
      vec4 n0 = texture(uDetail, (bp - fl * d0) / W + off0);
      vec4 n1 = texture(uDetail, (bp - fl * d1) / W + off1);
      vec4 n = mix(n0, n1, wB);
      float ridge = n.g;
      float wisp = ridge * ridge * ridge;
      float bill = smoothstep(0.32, 0.86, n.r);
      float dens = fil * (0.12 + 1.9 * wisp) * (0.35 + bill) * uFilAmp
                 + knot * uKnotAmp * (0.25 + n.a) * (0.45 + 1.6 * wisp)
                 + uBgAmp * wisp * bill * n.b;
      dens *= mask;
      // supernova sweeps the gas inside its shell and piles it up at the front
      if (uSN.w > 0.0) {
        float rs = length(p - uSN.xyz) / uSN.w;
        dens *= mix(1.0, smoothstep(0.55, 1.0, rs) + 1.6 * exp(-pow((rs - 1.0) * 7.0, 2.0)), uSNClear);
      }
      vec4 L = lightAt(p);
      float ion = smoothstep(-0.09, 0.09, L.x + 0.28 * (n.g - 0.5) - 0.12 * (n.a - 0.5));
      float front = ion * (1.0 - ion) * 4.0;
      dens *= mix(jac, 1.0, ion); // the new star's radiation has blown its own infall back out
      vec3 em = NEUTRAL * uNeutral
              + RED * uRed * n.r * n.r * 2.0
              + ION * (ion * uIon * (0.02 + 0.11 * L.y))
              + FRONT * (front * uFront * (0.05 + 0.07 * L.y))
              + SCAT * ((1.0 - ion) * L.y * uScat)
              + SNC * (L.z * uSNAmp)
              + ECHO * (L.w * uEcho)
              + CORE * (uCore.x * exp(-dot(p - uInfall.xyz, p - uInfall.xyz) * coreK));
      col += tr * em * dens * dt;
      tr *= exp(-dens * uSigma * dt);
      if (tr < 0.03) break;
    }
    t += dt;
  }
  o = vec4(col, 1.0);
}`);

  const COPY_FS = U.glsl.frag(`
in vec2 vUv; out vec4 o;
uniform sampler2D uTex;
uniform vec2 uTexel;
// 4 bilinear taps = soft 4x4 tent on the half-res gas: hides the step-jitter pattern
void main() {
  vec2 e = uTexel * 0.75;
  vec3 c = texture(uTex, vUv + vec2(-e.x, -e.y)).rgb + texture(uTex, vUv + vec2(e.x, -e.y)).rgb
         + texture(uTex, vUv + vec2(-e.x, e.y)).rgb + texture(uTex, vUv + vec2(e.x, e.y)).rgb;
  o = vec4(c * 0.25, 1.0);
}`);

  const SHELL_FS = U.glsl.frag(P3 + CAMERA_GLSL + `
in vec2 vUv; out vec4 o;
uniform sampler3D uDetail;
uniform vec4 uSN;  // center, radius
uniform vec4 uSNp; // brightness, hotness, thickness (fraction of R), age
const int NS = 18;
vec3 shellEm(vec3 p) {
  vec3 d = p - uSN.xyz;
  float R = uSN.w;
  float r = length(d);
  vec3 nd = d / max(r, 1e-4);
  // large-scale blow-outs (fixed in angle: the pattern expands with the remnant)
  vec4 a = texture(uDetail, nd * 0.26 + vec3(0.21, 0.57, 0.11));
  float rr = R * (1.0 + 0.34 * (a.r - 0.5) + 0.12 * (a.b - 0.5));
  float w = uSNp.z * R;
  float u = (r - (rr - w)) / w; // 0 = inner edge, 1 = outer edge
  if (u < 0.0 || u > 1.05) return vec3(0.0);
  float prof = smoothstep(0.0, 0.7, u) * (1.0 - smoothstep(0.62, 1.05, u));
  // filaments: thin ridges of the ridged channel, mostly angular so they lie in the shell
  vec3 q = nd * 0.5 + d / R * 0.10 + vec3(0.63, 0.17, 0.39);
  vec4 f1 = texture(uDetail, q);
  vec4 f2 = texture(uDetail, q * 2.3 + vec3(0.31, 0.12, 0.74));
  float g1 = f1.g, g2 = f2.g;
  float fil = pow(g1, 8.0) * 4.0 + pow(g2, 9.0) * 2.6;
  fil *= 0.12 + 1.9 * smoothstep(0.3, 0.85, a.a);
  fil += 0.012 + 0.04 * uSNp.y;
  vec3 teal = vec3(0.12, 0.80, 0.85);
  vec3 orng = vec3(1.0, 0.34, 0.09);
  // ejecta knots inside run orange, the outer blast front teal
  vec3 c = mix(orng, teal, smoothstep(0.45, 0.95, u + 0.35 * (f2.b - 0.5)));
  c = mix(c, vec3(1.0, 0.93, 0.86) * 1.3, uSNp.y);
  return c * prof * fil;
}
vec3 seg(vec3 ro, vec3 rd, float a, float b, float j) {
  a = max(a, 0.0);
  if (b <= a) return vec3(0.0);
  float dt = (b - a) / float(NS);
  vec3 s = vec3(0.0);
  for (int i = 0; i < NS; i++) s += shellEm(ro + rd * (a + (float(i) + j) * dt));
  return s * dt;
}
void main() {
  vec3 rd = rayDir(vUv);
  vec3 oc = uEye - uSN.xyz;
  float R = uSN.w;
  float Ro = R * 1.25, Ri = max(R * (0.76 - uSNp.z), 0.0);
  float b = dot(oc, rd), cc = dot(oc, oc);
  float h = b * b - (cc - Ro * Ro);
  if (h <= 0.0) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
  h = sqrt(h);
  float ta = -b - h, tb = -b + h;
  float hi = b * b - (cc - Ri * Ri);
  float j = ign(gl_FragCoord.xy);
  vec3 col;
  if (hi > 0.0) {
    hi = sqrt(hi);
    col = seg(uEye, rd, ta, -b - hi, j) + seg(uEye, rd, -b + hi, tb, j);
  } else {
    col = seg(uEye, rd, ta, tb, j);
  }
  o = vec4(col * uSNp.x / R, 1.0);
}`);

  const SPRITE_VS = U.glsl.vert(`
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aC; // center.xyz, kind (0 star, 1 blob)
layout(location = 2) in vec4 aO; // offset.xyz, world sigma
layout(location = 3) in vec4 aP; // tStart, lum, temperature, seed
layout(location = 4) in vec4 aK; // fade-in, flare, tint (-1 violet .. +1 pink), contraction duration
uniform mat4 uView;
uniform vec2 uNdc;
uniform vec2 uRes;
uniform float uPxU;
uniform float uFlux;
uniform float uT;
uniform float uMinSig;
uniform float uNear;
uniform float uGain;
uniform float uHand; // hand-off to cosmicweb: clumps tighten into compact blue-white knots
out vec2 vL;
out vec3 vCol;
void main() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vL = vec2(0.0); vCol = vec3(0.0);
  float a = uT - aP.x;
  if (a < 0.0 || aP.y <= 0.0) return;
  float b = aP.y * smoothstep(0.0, max(aK.x, 1e-3), a) * (1.0 + aK.y * exp(-a * 4.0));
  float sd = aP.w * 6.2831853;
  if (aC.w > 1.5) b *= 1.0 - 0.75 * smoothstep(3.0, 6.0, a);
  if (aC.w < 0.5 || aC.w > 1.5) b *= 1.0 + 0.05 * sin(uT * (1.3 + fract(sd) * 1.9) + sd) + 0.03 * sin(uT * (3.7 + fract(sd * 3.1) * 2.3) + sd * 2.7);
  float g = aK.w > 0.0 ? smoothstep(0.0, aK.w, a) : 1.0;
  vec3 wp = aC.xyz + aO.xyz * mix(1.45, 1.0, g);
  vec4 vp = uView * vec4(wp, 1.0);
  float z = -vp.z;
  if (z < 0.03) return;
  b *= smoothstep(uNear * 0.25, uNear, z);
  float wsig = aO.w;
  float tint = aK.z;
  if (uHand > 0.0) {
    // the local group (|c| < 5) recedes into the field; far galaxies sharpen into points
    bool local = dot(aC.xyz, aC.xyz) < 25.0;
    // (the local clumps shrink hardest: no big soft blobs left to double-expose over the web's points)
    if (aC.w > 0.5 && aC.w < 1.5) { wsig *= mix(1.0, local ? 0.13 : 0.28, uHand); b *= mix(1.0, local ? 0.32 : 0.6, uHand); }
    else b *= local ? 1.0 - 0.55 * uHand : 1.0 + 0.6 * uHand;
    tint *= 1.0 - uHand;
  }
  float sig = max(wsig * uPxU / z, uMinSig);
  float flux = b * uFlux * uGain / (z * z);
  float peak = flux / (6.2831853 * sig * sig);
  if (peak < 0.0004) return;
  const float EXT = 3.0;
  vec2 c = vp.xy / z * uNdc;
  gl_Position = vec4(c + aCorner * (sig * EXT * 2.0) / uRes, 0.0, 1.0);
  vL = aCorner * EXT;
  vec3 col = blackbody(aP.z);
  col = tint > 0.0 ? mix(col, vec3(1.0, 0.34, 0.52), tint) : mix(col, vec3(0.45, 0.40, 1.0), -tint);
  col = mix(col, vec3(0.72, 0.82, 1.0) * dot(col, vec3(0.2126, 0.7152, 0.0722)) / 0.8, 0.45 * uHand);
  vCol = col * peak;
}`);

  const SPRITE_FS = U.glsl.frag(`
in vec2 vL; in vec3 vCol; out vec4 o;
void main() {
  float r2 = dot(vL, vL);
  float w = exp(-0.5 * r2) * (1.0 - smoothstep(5.5, 9.0, r2));
  o = vec4(vCol * w, 1.0);
}`);

  // ================================================================== helpers
  const v3 = {
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    len: (a) => Math.hypot(a[0], a[1], a[2]),
    norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    mix: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
  };
  function gauss(r) {
    let u = 0, v = 0;
    while (u === 0) u = r();
    v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  function randDir(r) {
    const z = r() * 2 - 1, a = r() * Math.PI * 2, s = Math.sqrt(1 - z * z);
    return [s * Math.cos(a), z, s * Math.sin(a)];
  }
  // integral of smoothstep(t0, t1, x) from t0 to t
  function smoothInt(t, t0, t1) {
    if (t <= t0) return 0;
    const L = t1 - t0;
    if (t >= t1) return L * 0.5 + (t - t1);
    const x = (t - t0) / L;
    return L * (x * x * x - 0.5 * x * x * x * x);
  }

  // ================================================================== camera
  // Pure function of T (needs the knots for its target). 'live' adds the dark-ages drift (a faster
  // orbit, a slow crane down and an earlier dolly-in) that has died out by ~36.5; world generation
  // uses the plain path so the knot layout does not depend on it.
  function camera(T, cues, out, live) {
    const tSN = cues.firstSupernova;
    const k0 = S.knots[0];
    const u = M.smootherstep(29.5, cues.firstStar + 1.0, T);
    const tgt = [k0[0] - 0.55 * (1 - u), k0[1] + 0.22 * (1 - u), k0[2] + 0.25 * (1 - u)];
    let az = 0.34 + 0.036 * (T - 30) + 0.25 * M.smoothstep(tSN, 47, T);
    let el = 0.15 + 0.05 * Math.sin((T - 30) * 0.23) - 0.08 * M.smoothstep(tSN, 47, T);
    let dolly = M.mix(3.95, 2.8, M.easeInOutSine(M.saturate((T - 30) / (tSN + 0.4 - 30))));
    if (live) {
      const w = 1 - M.smootherstep(30, 36.5, T);
      az -= DA_AZ * w;
      el += DA_EL * w;
      dolly *= 1 + DA_DOLLY * w;
    }
    const D = dolly * Math.exp(smoothInt(T, tSN + 0.35, tSN + 3.4, 0) * 0.56);
    const ce = Math.cos(el);
    const eye = [tgt[0] + D * ce * Math.sin(az), tgt[1] + D * Math.sin(el), tgt[2] + D * ce * Math.cos(az)];
    const fwd = v3.norm(v3.sub(tgt, eye));
    let right = v3.norm(v3.cross(fwd, [0, 1, 0]));
    let up = v3.cross(right, fwd);
    const roll = 0.05 * Math.sin((T - 30) * 0.17 + 0.4);
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const r2 = [right[0] * cr + up[0] * sr, right[1] * cr + up[1] * sr, right[2] * cr + up[2] * sr];
    const u2 = [up[0] * cr - right[0] * sr, up[1] * cr - right[1] * sr, up[2] * cr - right[2] * sr];
    right = r2; up = u2;
    out = out || {};
    out.eye = eye; out.fwd = fwd; out.right = right; out.up = up; out.D = D;
    const m = out.view || new Float32Array(16);
    m[0] = right[0]; m[4] = right[1]; m[8] = right[2]; m[12] = -v3.dot(right, eye);
    m[1] = up[0]; m[5] = up[1]; m[9] = up[2]; m[13] = -v3.dot(up, eye);
    m[2] = -fwd[0]; m[6] = -fwd[1]; m[10] = -fwd[2]; m[14] = v3.dot(fwd, eye);
    m[3] = 0; m[7] = 0; m[11] = 0; m[15] = 1;
    out.view = m;
    return out;
  }
  function toView(cam, p) {
    const d = v3.sub(p, cam.eye);
    return [v3.dot(d, cam.right), v3.dot(d, cam.up), v3.dot(d, cam.fwd)];
  }

  // ================================================================== world generation
  const CUES = () => U.timeline.cues;

  // Init-time cooperative slicing: resolves at once while under budget, otherwise yields to the
  // event loop so the intro keeps animating (the world itself does not depend on where it yields).
  const nextTask = () => new Promise((r) => setTimeout(r, 0));
  function slicer(budgetMs) {
    let t0 = performance.now();
    return async () => {
      if (performance.now() - t0 < budgetMs) return;
      await nextTask();
      t0 = performance.now();
    };
  }

  async function genWorld(ps, slice) {
    const cues = CUES();
    const r = M.rng(0x5eed1e5);
    // --- knots (gas clumps that become the local proto-galaxies)
    const knots = [[0.12, 0.06, -0.15, 1.0]];
    S.knots = knots;
    const camAt = (T) => camera(T, cues, {});
    const camChecks = [];
    for (let T = 30; T <= cues.firstSupernova + 0.5; T += 0.5) camChecks.push(camAt(T));
    const camMid = camAt(37.5);
    let tries = 0;
    while (knots.length < NKNOT && tries++ < 20000) {
      if ((tries & 255) === 0) await slice();
      const p = [(r() * 2 - 1) * 3.3, (r() * 2 - 1) * 2.3, (r() * 2 - 1) * 3.3];
      if (v3.len(p) > 3.4) continue;
      let ok = true;
      for (const k of knots) if (v3.len(v3.sub(p, k)) < 1.2) { ok = false; break; }
      if (!ok) continue;
      for (const c of camChecks) if (v3.len(v3.sub(p, c.eye)) < 1.5) { ok = false; break; }
      if (!ok) continue;
      const v = toView(camMid, p);
      if (v[2] < 1.4 || v[2] > 6.8) continue;
      const qx = v[0] / v[2] * FOCAL, qy = v[1] / v[2] * FOCAL;
      if (Math.hypot(qx, qy * 1.15) > 0.78) continue;
      knots.push([p[0], p[1], p[2], 0.55 + 0.45 * r()]);
    }
    // --- filament graph: connect each knot to its 2-3 nearest neighbours, plus outgoing strands
    const segA = [], segB = [];
    const seen = new Set();
    for (let i = 0; i < knots.length; i++) {
      const nb = knots.map((k, j) => [j, v3.len(v3.sub(k, knots[i]))]).filter((x) => x[0] !== i).sort((a, b) => a[1] - b[1]);
      const n = 2 + (r() < 0.4 ? 1 : 0);
      for (let q = 0; q < n && q < nb.length; q++) {
        const j = nb[q][0];
        const key = i < j ? i + ':' + j : j + ':' + i;
        if (seen.has(key)) continue;
        seen.add(key);
        if (nb[q][1] > 3.4) continue;
        segA.push([...knots[i].slice(0, 3), 0.16 + 0.12 * r()]);
        segB.push([...knots[j].slice(0, 3), 0.65 + 0.35 * r()]);
      }
    }
    for (let i = 0; i < knots.length && segA.length < 40; i++) {
      if (r() < 0.45) continue;
      const d = randDir(r);
      const e = v3.add(knots[i], v3.scale(d, 2.5 + 2.0 * r()));
      segA.push([...knots[i].slice(0, 3), 0.14 + 0.1 * r()]);
      segB.push([...e, 0.45 + 0.35 * r()]);
    }
    S.segA = segA.slice(0, 40); S.segB = segB.slice(0, 40);

    // --- first stars
    const fs = [];
    const order = [];
    for (let i = 1; i < knots.length; i++) order.push(i);
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    for (let i = 0; i < NFS; i++) {
      let k, pos;
      if (i === 0) { k = 0; pos = [knots[0][0], knots[0][1] + 0.03, knots[0][2]]; }
      else {
        k = i < 4 ? [0, order[0], order[1]][i - 1] : order[(i - 1) % order.length];
        if (i === 1) k = order[0];
        const d = randDir(r);
        pos = v3.add(knots[k], v3.scale(d, 0.16 + 0.42 * r()));
      }
      const tIg = i === 0 ? cues.firstStar
        : cues.firstStar + 1.15 + 3.75 * Math.pow((i - 1) / (NFS - 2), 0.78) + (r() - 0.5) * 0.08;
      const L = i === 0 ? 1.0 : 0.35 + 0.55 * r();
      fs.push({
        k, pos, tIg, L,
        temp: i === 0 ? 40000 : 28000 + 12000 * r(),
        rmax: i === 0 ? 1.05 : 0.45 + 0.55 * L,
        seed: r(),
      });
    }
    S.fs = fs;
    await slice();

    // --- static sprites: local cluster stars + galaxies (local + far)
    const inst = [];
    const push = (c, kind, off, sig, tS, lum, temp, seed, fade, flare, tint, contr) => {
      inst.push(c[0], c[1], c[2], kind, off[0], off[1], off[2], sig, tS, lum, temp, seed, fade, flare, tint, contr);
    };
    const SB = 3.73e6; // blob surface-brightness -> lum factor (lum = peak * r^2 * SB)
    const nLocalStars = Math.max(10, Math.round(44 * ps));
    for (let k = 0; k < knots.length; k++) {
      const c = knots[k];
      const tG = cues.firstSupernova - 0.6 + (k === 0 ? 1.7 : 0.25 * k + 0.4 * r());
      const nSub = 3 + Math.floor(r() * 4);
      const subs = [];
      for (let q = 0; q < nSub; q++) subs.push([gauss(r) * 0.13, gauss(r) * 0.1, gauss(r) * 0.13, 0.03 + 0.045 * Math.pow(r(), 1.5)]);
      for (let q = 0; q < nLocalStars; q++) {
        const sb = subs[Math.floor(r() * nSub)];
        const off = [sb[0] + gauss(r) * sb[3], sb[1] + gauss(r) * sb[3], sb[2] + gauss(r) * sb[3]];
        const tS = tG + 0.6 + 3.4 * Math.pow(r(), 1.3);
        push(c, 0, off, 0, tS, 40 + 150 * Math.pow(r(), 3), 11000 + 20000 * r(), r(), 0.6, 1.0, 0, 3.0);
      }
      for (let q = 0; q < nSub; q++) {
        const sb = subs[q];
        const rb = sb[3] * 1.6 + 0.03;
        const pk = 0.26 + 0.34 * r();
        push(c, 1, sb.slice(0, 3), rb, tG + 1.0 + 0.5 * r(), pk * rb * rb * SB, 15000 + 14000 * r(), r(), 2.6, 0, r() < 0.15 ? 0.25 : -0.2, 3.0);
      }
      // diffuse envelope
      const re = 0.16 + 0.05 * r();
      push(c, 1, [0, 0, 0], re, tG + 1.5, 0.09 * re * re * SB, 20000, r(), 3.0, 0, -0.35, 3.5);
    }

    // far galaxies: clustered along random filaments in a big sphere around the local group
    const nGal = Math.round(1700 * ps);
    const fil = [];
    for (let i = 0; i < 46; i++) {
      const a = v3.scale(randDir(r), 66 * Math.cbrt(r()));
      const b = v3.add(a, v3.scale(randDir(r), 14 + 26 * r()));
      fil.push([a, b]);
    }
    const nStarsPer = Math.max(3, Math.round(9 * ps));
    let made = 0, guard = 0;
    while (made < nGal && guard++ < nGal * 20) {
      let p;
      if (r() < 0.62) {
        const f = fil[Math.floor(r() * fil.length)];
        p = v3.add(v3.mix(f[0], f[1], r()), [gauss(r) * 2.6, gauss(r) * 2.6, gauss(r) * 2.6]);
      } else {
        p = v3.scale(randDir(r), 70 * Math.cbrt(r()));
      }
      const dl = v3.len(p);
      if (dl < 5.2 || dl > 72) continue;
      made++;
      if ((made & 63) === 0) await slice();
      const size = 0.18 + 0.36 * Math.pow(r(), 1.6);
      const tFirst = cues.firstStar + 1.4 + 4.0 * Math.pow(r(), 0.7);
      const tG = cues.firstSupernova + 0.3 + 3.2 * r();
      const temp0 = 15000 + 15000 * r();
      // first star (a single tiny point that appears early)
      if (r() < 0.4) push(p, 2, [0, 0, 0], 0, tFirst, 1500 + 2500 * r(), 30000, r(), 0.15, 2.5, 0, 0);
      const nSub = 2 + Math.floor(r() * 4);
      const subs = [];
      for (let q = 0; q < nSub; q++) {
        const sc = q === 0 ? 0.3 : 1.0;
        subs.push([gauss(r) * size * 0.5 * sc, gauss(r) * size * 0.4 * sc, gauss(r) * size * 0.5 * sc, size * (0.18 + 0.25 * r())]);
      }
      for (let q = 0; q < nSub; q++) {
        const sb = subs[q];
        const pk = (0.2 + 0.42 * r()) * (q === 0 ? 1.4 : 1.0);
        const pink = r() < 0.12 ? 0.15 + 0.15 * r() : -0.1;
        push(p, 1, sb.slice(0, 3), sb[3], tG + 0.6 * r(), pk * sb[3] * sb[3] * SB, temp0 + 4000 * (r() - 0.5), r(), 2.2, 0, pink, 3.5);
      }
      const ge = size * 0.75;
      push(p, 1, [0, 0, 0], ge, tG + 0.3, (0.05 + 0.05 * r()) * ge * ge * SB, temp0 + 3000, r(), 2.5, 0, -0.3, 3.5);
      for (let q = 0; q < nStarsPer; q++) {
        const sb = subs[Math.floor(r() * nSub)];
        const off = [sb[0] + gauss(r) * sb[3] * 0.8, sb[1] + gauss(r) * sb[3] * 0.8, sb[2] + gauss(r) * sb[3] * 0.8];
        push(p, 0, off, 0, tG + 1.5 * r(), 350 + 1100 * Math.pow(r(), 2), 9000 + 20000 * r(), r(), 0.4, 0.8, 0, 3.0);
      }
    }
    await slice();
    S.staticData = new Float32Array(inst);
    S.staticCount = inst.length / 16;
  }

  // ================================================================== per-frame state
  function bubbleR(f, T) {
    const a = T - f.tIg;
    if (a <= 0) return 0;
    return f.rmax * Math.pow(1 - Math.exp(-a / 1.6), 0.55);
  }
  function starPos(f, T, cues) {
    const g = M.smoothstep(cues.firstSupernova + 0.3, cues.firstSupernova + 5.0, T);
    const k = S.knots[f.k];
    return v3.mix(f.pos, k, g * 0.62);
  }
  // Intensity multiplier of first star i at T (ignition flare, death of star 0, late dimming).
  function starLum(i, f, T, cues) {
    const a = T - f.tIg;
    if (a < 0) return 0;
    // full flare on the ignition frame itself (no ramp): the event lands on its cue
    let L = f.L * (1 + 5.5 * Math.exp(-a / 0.14) + 1.2 * Math.exp(-a / 0.9));
    if (i === 0) {
      const tSN = cues.firstSupernova;
      const b = T - tSN;
      if (b < 0) {
        // the dying star swells, then its core collapses: a brief inhale right before the blast
        L *= 1 + 1.6 * Math.pow(M.smoothstep(tSN - 0.7, tSN - 0.12, T), 3);
        L *= 1 - 0.72 * M.smoothstep(tSN - 0.13, tSN - 0.015, T);
      } else L *= (60 * Math.exp(-b / 0.07) + 8 * Math.exp(-b / 0.35) + 2.4 * Math.exp(-b / 1.5)) * (1 - M.smoothstep(2.0, 5.0, b));
    }
    L *= 1 - 0.55 * M.smoothstep(cues.firstSupernova + 0.5, cues.firstSupernova + 5.5, T);
    return L;
  }

  // ================================================================== GL setup
  function make3D(gl, n, wrap) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.texStorage3D(gl.TEXTURE_3D, 1, gl.RGBA8, n, n, n);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const w = wrap === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, w);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, w);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, w);
    gl.bindTexture(gl.TEXTURE_3D, null);
    return tex;
  }
  // Resolves once the GPU has drained the commands issued so far (bounded wait).
  function gpuDrained(gl) {
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    if (!sync) return nextTask();
    const t0 = performance.now();
    return new Promise((res) => {
      const poll = () => {
        const done = gl.isContextLost() || gl.getSyncParameter(sync, gl.SYNC_STATUS) === gl.SIGNALED;
        if (done || performance.now() - t0 > 200) { gl.deleteSync(sync); res(); } else setTimeout(poll, 0);
      };
      setTimeout(poll, 0);
    });
  }
  // Resolves when the driver reports the programs compiled (KHR_parallel_shader_compile), so
  // their first use does not block the page. Without the extension: at once.
  const compiled = (gl, progs) => U.gl.compiled(gl, progs);
  // Bakes a 3D texture slice by slice, a few slices per task (GL state is re-bound per batch: the
  // intro loop may run in between).
  async function bake3D(gl, prog, texs, n, setup) {
    const fb = gl.createFramebuffer();
    const bufs = texs.map((_, i) => gl.COLOR_ATTACHMENT0 + i);
    const BATCH = 24;
    for (let z0 = 0; z0 < n; z0 += BATCH) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.drawBuffers(bufs);
      gl.viewport(0, 0, n, n);
      gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.SCISSOR_TEST);
      gl.colorMask(true, true, true, true);
      prog.use();
      if (setup) setup(prog);
      for (let z = z0; z < Math.min(n, z0 + BATCH); z++) {
        texs.forEach((t, i) => gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, t, 0, z));
        prog.set('uZ', (z + 0.5) / n);
        U.gl.drawFullscreen(gl);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      await gpuDrained(gl);
    }
    gl.deleteFramebuffer(fb);
  }

  function setupSprites(gl, data, count, dynamic) {
    const quad = S.quadBuf;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    const st = 64;
    const vao = U.gl.vao(gl, [
      { loc: 0, buffer: quad, size: 2 },
      { loc: 1, buffer: buf, size: 4, stride: st, offset: 0, divisor: 1 },
      { loc: 2, buffer: buf, size: 4, stride: st, offset: 16, divisor: 1 },
      { loc: 3, buffer: buf, size: 4, stride: st, offset: 32, divisor: 1 },
      { loc: 4, buffer: buf, size: 4, stride: st, offset: 48, divisor: 1 },
    ]);
    return { buf, vao, count };
  }

  function ensureTargets(gl, s) {
    const gs = s.tier === 'high' ? 0.5 : s.tier === 'mid' ? 0.42 : 0.34;
    const w = Math.max(8, Math.round(s.width * gs)), h = Math.max(8, Math.round(s.height * gs));
    if (!S.gasT || S.gasT.w !== w || S.gasT.h !== h) {
      if (S.gasT) U.gl.deleteTarget(gl, S.gasT);
      S.gasT = U.gl.target(gl, w, h, { hdr: true });
    }
  }

  // ================================================================== scene
  U.defineScene({
    id: 'cosmicdawn',
    async init(gl, ctx) {
      const tier = ctx.tier;
      S.tier = tier;
      // every program first: a driver with parallel compile builds them while the CPU works
      const VS = U.gl.FULLSCREEN_VS;
      const genD = U.gl.program(gl, VS, GEN_DETAIL_FS, 'cosmicdawn-gen-detail');
      const genS = U.gl.program(gl, VS, GEN_STRUCT_FS, 'cosmicdawn-gen-struct');
      S.progLight = U.gl.program(gl, VS, LIGHT_FS, 'cosmicdawn-light');
      S.progGas = U.gl.program(gl, VS, GAS_FS, 'cosmicdawn-gas');
      S.progCopy = U.gl.program(gl, VS, COPY_FS, 'cosmicdawn-copy');
      S.progShell = U.gl.program(gl, VS, SHELL_FS, 'cosmicdawn-shell');
      S.progSprite = U.gl.program(gl, SPRITE_VS, SPRITE_FS, 'cosmicdawn-sprite');

      // CPU: the world (knots, filament graph, first stars, sprite instances), in ~6 ms slices
      await genWorld(ctx.particleScale, slicer(6));

      // GPU: detail noise (tileable) and structure volumes
      const nD = tier === 'low' ? 64 : 96;
      const nS = tier === 'low' ? 64 : tier === 'mid' ? 80 : 96;
      S.detail = make3D(gl, nD, 'repeat');
      S.struct = make3D(gl, nS, 'clamp');
      S.flow = make3D(gl, nS, 'clamp');
      await compiled(gl, [genD, genS]);
      await bake3D(gl, genD, [S.detail], nD);
      const knotsF = new Float32Array(NKNOT * 4);
      S.knots.forEach((k, i) => knotsF.set(k, i * 4));
      const sa = new Float32Array(40 * 4), sb = new Float32Array(40 * 4);
      S.segA.forEach((v, i) => sa.set(v, i * 4));
      S.segB.forEach((v, i) => sb.set(v, i * 4));
      await bake3D(gl, genS, [S.struct, S.flow], nS, (p) => p.setAll({ uKnots: knotsF, uSegA: sa, uSegB: sb, uNSeg: S.segA.length }));
      gl.deleteProgram(genD.program);
      gl.deleteProgram(genS.program);

      // light atlas
      const nL = tier === 'high' ? 48 : tier === 'mid' ? 40 : 32;
      const tiles = Math.ceil(Math.sqrt(nL));
      S.atlas = [nL, tiles, nL * tiles];
      S.lightT = U.gl.target(gl, nL * tiles, nL * tiles, { hdr: true });

      S.quadBuf = U.gl.buffer(gl, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]));
      S.stat = setupSprites(gl, S.staticData, S.staticCount, false);
      S.dynData = new Float32Array((NFS * 5 + 8) * 16);
      S.dyn = setupSprites(gl, S.dynData, 0, true);
      S.lightStar = new Float32Array(LIGHT_SLOTS * 4);
      S.lightL = new Float32Array(LIGHT_SLOTS);
      S.lightE = new Float32Array(LIGHT_SLOTS * 2);
      S.cam = {};
      S.steps = tier === 'high' ? 34 : tier === 'mid' ? 28 : 20;
      S.ready = true;
    },

    render(gl, s) {
      if (!S.ready) return;
      const T = s.T, cues = s.cues;
      const tFS = cues.firstStar, tSN = cues.firstSupernova;
      const cam = camera(T, cues, S.cam, true);
      ensureTargets(gl, s);

      // ---------------- per-frame star state
      const dyn = S.dynData;
      let nd = 0;
      const put = (c, kind, sig, lum, temp, seed, tint) => {
        const o = nd * 16;
        dyn[o] = c[0]; dyn[o + 1] = c[1]; dyn[o + 2] = c[2]; dyn[o + 3] = kind;
        dyn[o + 4] = 0; dyn[o + 5] = 0; dyn[o + 6] = 0; dyn[o + 7] = sig;
        dyn[o + 8] = -1e4; dyn[o + 9] = lum; dyn[o + 10] = temp; dyn[o + 11] = seed;
        dyn[o + 12] = 0; dyn[o + 13] = 0; dyn[o + 14] = tint; dyn[o + 15] = 0;
        nd++;
      };
      const SB = 3.73e6;
      const gasFade = 1 - M.smoothstep(tSN + 1.0, tSN + 4.3, T);
      let nl = 0;
      const ls = S.lightStar, ll = S.lightL, le = S.lightE;
      for (let i = 0; i < NFS; i++) {
        const f = S.fs[i];
        if (T < f.tIg) continue;
        const pos = starPos(f, T, cues);
        const L = starLum(i, f, T, cues);
        const R = bubbleR(f, T);
        if (L > 0) {
          put(pos, 0, 0, L * 5200, f.temp, f.seed, 0);
          // soft, diffraction-free glow around the star (world-sized -> depth cue)
          put(pos, 1, 0.045, Math.min(L, 8) * 0.9 * 0.045 * 0.045 * SB, f.temp, f.seed, -0.1);
        }
        // ignition flare: a local bloom burst around the new star (no full-frame flash)
        const ai = T - f.tIg;
        // (three nested gaussians ~ a point with a power-law halo; a lone gaussian reads as a ball)
        if (ai < 1.6 && !(i === 0 && T >= tSN)) {
          const k = i === 0 ? 1.0 : 0.45 * f.L, sc = i === 0 ? 1.0 : 0.6;
          for (let g = 0; g < 3; g++) {
            const sg = IGN_SIG[g] * sc;
            const pk = k * (IGN_PK[g] * Math.exp(-ai / IGN_TAU[g]) + IGN_PK2[g] * Math.exp(-ai / 0.55));
            if (pk > 0.003) put(pos, 1, sg, pk * sg * sg * SB, f.temp, f.seed, -0.12 - 0.1 * g);
          }
        }
        // ionised-bubble glow (faint; the volumetric gas carries the structure)
        const gr = Math.max(0.05, R * 0.4);
        const bub = gasFade * (i === 0 && T > tSN ? Math.exp(-(T - tSN) / 1.0) : 1);
        if (R > 0.01 && bub > 0.001) put(pos, 1, gr, 0.012 * gr * gr * SB * bub * (1 + 4.0 * Math.exp(-(T - f.tIg) / 0.35)), 30000, f.seed, -0.7);
        if (nl < LIGHT_SLOTS) {
          ls[nl * 4] = pos[0]; ls[nl * 4 + 1] = pos[1]; ls[nl * 4 + 2] = pos[2];
          ls[nl * 4 + 3] = i === 0 && T > tSN ? R * (1 + 0.3 * M.smoothstep(tSN, tSN + 3, T)) : R;
          ll[nl] = Math.min(L, f.L * 3.0, 6) * 0.35;
          // light echo: the ignition flash sweeping outward through the neutral gas
          const ae = T - f.tIg;
          // (the radius doubles as the light-travel front; 0 once it has passed the whole gas volume)
          const eR = i === 0 ? 0.1 + 4.6 * ae : 0.05 + 2.4 * ae;
          const eOn = ae < (i === 0 ? 1.8 : 1.2);
          le[nl * 2] = eR < 9.5 ? eR : 0;
          le[nl * 2 + 1] = eOn ? (i === 0 ? 1.7 * Math.exp(-ae / 0.6) : 0.55 * f.L * Math.exp(-ae / 0.32)) * M.smoothstep(0.02, 0.14, ae) : 0;
          nl++;
        }
      }
      // supernova
      const b = T - tSN;
      const snOn = b >= 0;
      const snC = S.fs[0].pos;
      const snR = snOn ? 0.04 + 0.42 * Math.pow(b, 0.6) : 0;
      const snFade = snOn ? Math.exp(-b / 1.5) * (1 - M.smoothstep(2.8, 5.0, b)) : 0;
      if (snOn) {
        const core = 10 * Math.exp(-b / 0.12) + 0.6 * Math.exp(-b / 0.9);
        const cr = 0.03 + snR * 0.18;
        put(snC, 1, cr, core * cr * cr * SB, 14000, 0.5, 0);
        // the blast lights its surroundings: local radial glow instead of a lingering full-frame veil
        const g1 = 0.3 + 0.35 * snR, g2 = 0.85;
        // (faded out and dropped once faint: they are near full-screen quads)
        const p1 = (4.0 * Math.exp(-b / 0.15) + 0.22 * Math.exp(-b / 0.6)) * (1 - M.smoothstep(1.0, 1.6, b));
        const p2 = (1.0 * Math.exp(-b / 0.08) + 0.03 * Math.exp(-b / 0.6)) * (1 - M.smoothstep(0.3, 0.6, b));
        if (p1 > 0) put(snC, 1, g1, p1 * g1 * g1 * SB, 9000, 0.5, 0);
        if (p2 > 0) put(snC, 1, g2, p2 * g2 * g2 * SB, 12000, 0.5, 0);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, S.dyn.buf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, dyn.subarray(0, nd * 16));
      gl.bindBuffer(gl.ARRAY_BUFFER, null);

      const camU = { uEye: cam.eye, uRight: cam.right, uUp: cam.up, uFwd: cam.fwd };
      const gasOn = gasFade > 0.002 && T < tSN + 4.5;

      // ---------------- light volume + gas + supernova shell (half res, soft upsample)
      const shellOn = snOn && snFade > 0.01;
      if (gasOn || shellOn) {
        const gt = S.gasT;
        if (gasOn) {
          const lt = S.lightT;
          gl.bindFramebuffer(gl.FRAMEBUFFER, lt.fb);
          gl.viewport(0, 0, lt.w, lt.h);
          S.progLight.use().setAll({
            uStar: ls, uStarL: ll, uStarE: le, uNStar: nl,
            uSNL: [snC[0], snC[1], snC[2], snOn ? (14 * Math.exp(-b / 0.1) + 2.2 * Math.exp(-b / 0.6) + 0.4 * Math.exp(-b / 2.5)) : 0],
            uSNS: [snR, snOn ? 2.0 * snFade : 0, snOn ? 0.1 + 5.5 * b : 0, snOn && b < 2.5 ? 2.0 * Math.exp(-b / 0.45) : 0],
            uAtlas: S.atlas,
          });
          U.gl.drawFullscreen(gl);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, gt.fb);
        gl.viewport(0, 0, gt.w, gt.h);
        if (gasOn) {
          const ramp = (a, b2, x) => M.smoothstep(a, b2, x);
          // gas-flow clock: runs faster through the dark ages (the gas visibly streams onto its
          // knots), then real time once the stars are on; an analytic integral, so still a pure f(T)
          const tc = M.clamp(T, 30, 36.5);
          const fT = (T - 30) + DA_FLOW * ((tc - 30) - smoothInt(tc, 34.5, 36.5));
          S.progGas.use().setAll(Object.assign({
            uRes: [gt.w, gt.h],
            uStruct: 0, uFlow: 1, uDetail: 2, uLight: 3,
            uAtlas: S.atlas, uSteps: S.steps,
            uFlowT: fT,
            uDrift: [0.035 * fT, -0.012 * fT, 0.02 * fT],
            uFilK: M.mix(2.0, 2.3, ramp(30, 40, T)),
            uFilAmp: 1.0,
            uKnotK: M.mix(2.0, 3.2, ramp(31, 41, T)),
            uKnotAmp: M.mix(1.0, 1.5, ramp(31, 41, T)),
            uBgAmp: 0.06,
            uNeutral: M.mix(0.3, 0.1, ramp(tFS, tFS + 3, T)) * ramp(30.6, 33.5, T) * gasFade,
            uRed: 0.13 * (1 - ramp(30.4, 33.0, T)),
            uIon: 2.7 * gasFade,
            uFront: 3.6 * gasFade,
            uScat: 0.012 * gasFade,
            uSigma: 2.2,
            uSNAmp: 0.05 * gasFade,
            uSN: snOn ? [snC[0], snC[1], snC[2], snR] : [0, 0, 0, 0],
            uSNClear: snOn ? M.smoothstep(0, 0.6, b) : 0,
            uInfall: [S.knots[0][0], S.knots[0][1], S.knots[0][2], INF_S * M.smootherstep(30.4, tFS + 0.2, T) * (1 - M.smoothstep(tFS + 0.2, tFS + 2.4, T))],
            uEcho: 4.0 * gasFade,
            uCore: [CORE_GLOW * Math.pow(ramp(32.2, tFS, T), 2) * (1 - ramp(tFS, tFS + 0.5, T)), M.mix(0.75, 0.24, ramp(32.0, tFS, T))],
          }, camU));
          gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_3D, S.struct);
          gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_3D, S.flow);
          gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_3D, S.detail);
          U.gl.bindTexture(gl, 3, S.lightT.tex);
          U.gl.drawFullscreen(gl);
          gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_3D, null);
          gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_3D, null);
          gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_3D, null);
        } else {
          gl.clearColor(0, 0, 0, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
        }
        if (shellOn) {
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE);
          S.progShell.use().setAll(Object.assign({
            uRes: [gt.w, gt.h], uDetail: 0,
            uSN: [snC[0], snC[1], snC[2], snR],
            uSNp: [snFade * (3.4 + 10 * Math.exp(-b / 0.25)), Math.exp(-b / 0.5), M.mix(0.3, 0.13, M.smoothstep(0, 2.5, b)), b],
          }, camU));
          gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_3D, S.detail);
          U.gl.drawFullscreen(gl);
          gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_3D, null);
          gl.disable(gl.BLEND);
        }
        s.bindOutput();
        S.progCopy.use().setAll({ uTex: 0, uTexel: [1 / gt.w, 1 / gt.h] });
        U.gl.bindTexture(gl, 0, gt.tex);
        U.gl.drawFullscreen(gl);
      } else {
        s.bindOutput();
      }

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);

      // ---------------- sprites
      const minRes = Math.min(s.width, s.height);
      S.progSprite.use().setAll({
        uView: cam.view,
        uNdc: [2 * FOCAL * minRes / s.width, 2 * FOCAL * minRes / s.height],
        uRes: [s.width, s.height],
        uPxU: FOCAL * minRes,
        uFlux: (minRes / 720) * (minRes / 720),
        uT: T,
        uMinSig: 1.1 * Math.max(0.75, minRes / 720),
        uNear: 1.6,
        uGain: 1,
        uHand: M.smoothstep(43.9, 46.2, T),
      });
      gl.bindVertexArray(S.stat.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, S.stat.count);
      if (nd > 0) {
        S.progSprite.set('uNear', 0.4);
        gl.bindVertexArray(S.dyn.vao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nd);
      }
      gl.bindVertexArray(null);

      // ---------------- post
      const P = s.post;
      // Star ignitions are sold locally (flare sprites, bloom, light echo in the gas): no full-frame
      // flash, so the black level never pumps. Only the supernova whites out the frame, on its cue.
      let flash = 0, shake = 0;
      if (snOn) {
        // white on the cue (3 frames), gone by +0.2 s: no lingering veil over the young remnant
        flash = 9.0 * Math.exp(-b / 0.035) * (1 - M.smoothstep(0.07, 0.2, b));
        shake = 0.5 * Math.exp(-b / 0.55);
      }
      P.flash = flash;
      P.shake = shake;
      P.exposure = 1.0;
      P.bloom = 0.85 + (snOn ? 0.5 * Math.exp(-b / 1.0) : 0);
      P.bloomThreshold = 0.85;
      P.vignette = 0.6;
      P.grain = 0.04;
      P.contrast = 0.14;
      P.aberration = 0.1;
      P.saturation = 1.05;
    },
  });
})();
