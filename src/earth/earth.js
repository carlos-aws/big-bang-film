// U.earth: a reusable, analytic (ray-sphere) Earth-globe renderer covering the planet's whole
// history: magma ocean, crust with glowing cracks, impacts, steam atmosphere, storms/lightning,
// oceans flooding procedural basins, cratons, plate-tectonic land from U.plates, Snowball ice,
// vegetation by paleolatitude, today's biomes, ocean glint, clouds with shadows, atmosphere,
// city lights, the Moon and a debris ring. Everything is a pure function of the parameters.
//
//   await U.earth.init(gl, ctx)
//   const P = U.earth.params();       // defaults (see DEFAULTS below), mutate per frame
//   U.earth.render(gl, s, P)          // draws a fullscreen pass into the currently bound target
//   U.earth.viewToEarth(lat, lon, roll, out?) -> mat3 (column-major): view space -> Earth-fixed
//   U.earth.earthPos(latDeg, lonDeg)  -> [x,y,z] Earth-fixed unit vector (CONTRACT convention)
//   U.earth.hasPlates                 -> true once real plate data is bound
//
// View space: x right, y up, z toward the viewer. Planet radius = 1 world unit. Screen units as
// in the contract (shorter side spans [-0.5,0.5]).
(function () {
  'use strict';
  const U = window.U;
  const M = U.math;

  const MAX_IMP = 12;
  const D2R = Math.PI / 180;

  const DEFAULTS = {
    center: [0, 0], radius: 0.30, fov: 30, // planet centre/radius in screen units, vertical-ish fov (deg)
    view: null,                            // mat3 view->earth (Float32Array 9); default from lat/lon/roll
    lat: 10, lon: 0, roll: 0,              // sub-viewer point (deg) + roll (deg), used if view is null
    light: [-1, 0.25, 0.6],                // view-space light direction (normalised internally)
    sun: 1.5,                              // sun irradiance (linear HDR)
    sky: null,                             // mat3 rotating the star field (camera orbit); null = identity
    ma: 0,                                 // plate reconstruction age (Ma), used when plateMix > 0
    magma: 0, crust: 1, crackGlow: 0, lavaHeat: 1, // molten surface 0..1, crust coverage 0..1
    sea: 0.6, seaOn: 1,                    // procedural sea level (height units, -1..1); seaOn 0 = no water at all
    plateMix: 1,                           // 0 procedural continents -> 1 plate land mask
    murk: 0, life: 0,                      // Archean murky ocean, coastal cyanobacteria tint
    cloud: 0.45, cloudAlpha: 0.9, storm: 0, lightning: 0,
    atmo: [0.30, 0.55, 1.0], atmoStrength: 1, atmoHeight: 0.028, haze: 0,
    iceLine: 0.93,                         // sin(paleolatitude) above which ice forms (<= -0.1 => all ice)
    green: 1, today: 1, rust: 0, basalt: 0,           // vegetation 0..1, present-day biome blend, rust-red barren land
    city: 0, stars: 1,
    impacts: [],                           // [{pos:[x,y,z] Earth-fixed, age (s since hit, may be <0), size (rad), energy}]
    moon: null,                            // {pos:[x,y,z] view space, radius, glow (molten 0..1), amount}
    ring: null,                            // {opacity, inner, outer, normal:[x,y,z] view space, glow}
    cyclones: null,                        // [[x,y,z Earth-fixed, strength], ...] up to 3
    cloudTime: null,                       // time driving cloud motion (default s.T)
    cloudEvolve: null,                     // 0..1 blend between the two baked weather fields (default from cloudTime)
    cirrus: 0.0, cloudShadow: 0.01,        // cirrus veil amount, cloud-shadow offset (rad)
    flashTint: 0,
    landClear: 0,                          // fewer clouds over land (plate era), 0..~0.2
    clear: null,                           // up to 3 cloud-clearing spots [{pos:[x,y,z] Earth-fixed, radius (rad), strength}]
    atmoB: [0.30, 0.55, 1.0], oxy: 1,      // post-oxygenation sky colour; progress 0..1 (atmo -> atmoB, patchy)
    glint: 1,                              // ocean sun-glint strength
    deepShelf: 0,                          // deep-time continental-shelf band around the plate blocks 0..1
    lifeBloom: 1,                          // offshore cyanobacteria blooms (with life)
  };

  // --------------------------------------------------------------- GLSL
  const FALLBACK_PLATES = `
#define PLATE_COUNT 1
float eLand(vec3 pos, out vec3 ppos, out int id, out float blur) { ppos = pos; id = 0; blur = 0.0; return 0.0; }
mat3 plateRotOf(int i) { return mat3(1.0); }
`;

  function platesGlsl() {
    const P = U.plates;
    if (!P || !P.glsl) return FALLBACK_PLATES;
    let src = P.glsl;
    if (!/#define\s+PLATE_COUNT/.test(src)) src = `#define PLATE_COUNT ${P.count}\n` + src;
    // Our own loop: best plate mask + that plate's present-day position (for textures that ride
    // on the plates) + a blurred land fraction (continental shelves / coastal shallows).
    return src + `
float eLand(vec3 pos, out vec3 ppos, out int id, out float blur) {
  float best = 0.0; ppos = pos; id = 0; blur = 0.0;
  vec3 dpx = dFdx(pos), dpy = dFdy(pos);
  float lodB = log2(float(textureSize(uPlateAtlas, 0).x)) - 7.3;
  for (int i = 0; i < PLATE_COUNT; i++) {
    // cull in the paleo frame before the per-pixel rotation (pos is unit length); the cap is
    // padded by ~0.12 rad so the blurred field is not clipped
    vec4 cap = uPlateCapP[i];
    float cr = cap.w * 0.9928 - sqrt(max(1.0 - cap.w * cap.w, 0.0)) * 0.1197;
    float cd = dot(pos, cap.xyz);
    if (cd < cr) continue;
    mat3 R = uPlateRot[i];
    vec3 pp = R * pos;
    vec2 uv = plateUV(pp);
    float bl = plateChannel(i, textureLod(uPlateAtlas, vec3(uv, float(i >> 2)), lodB));
    blur = max(blur, bl);
    if (cd < cap.w) continue;
    float m = plateChannel(i, textureGrad(uPlateAtlas, vec3(uv, float(i >> 2)), plateUVd(pp, R * dpx), plateUVd(pp, R * dpy)));
    if (m > best) { best = m; ppos = pp; id = i; }
  }
  return best;
}
mat3 plateRotOf(int i) { return uPlateRot[i]; }
`;
  }

  // Bake pass: equirect textures of expensive noise, rendered once at init.
  //   mode 0 (clouds):  R,G two domain-warped weather fields, B billows, A cirrus streaks
  //   mode 1 (terrain): R detail fbm, G ridged mountains, B moisture, A procedural height
  const BAKE_FS = `
out vec4 o;
uniform vec2 uSize;
uniform int uMode;
// The loops below run to uniform bounds (uOne = 1), so the compiler keeps them as loops: fully
// unrolled and inlined, this one-off shader took ~4x longer to compile (~0.9 s, at start-up).
uniform int uOne;
float fbmL(vec3 p, int oct) { // = fbm()
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < oct * uOne; i++) {
    s += a * snoise(p);
    n += a;
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return s / n;
}
float ridgedL(vec3 p, int oct) { // = ridged()
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < oct * uOne; i++) {
    float r = 1.0 - abs(snoise(p));
    s += a * r * r;
    n += a;
    p = p * 2.07 + vec3(4.3, 1.1, 7.7);
    a *= 0.5;
  }
  return s / n;
}
vec3 sph(vec2 uv) {
  float lat = PI * 0.5 - uv.y * PI, lon = uv.x * TAU - PI;
  return vec3(cos(lat) * cos(lon), sin(lat), -cos(lat) * sin(lon));
}
float fbmG(vec3 p, int oct, float gain) {
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < oct * uOne; i++) {
    s += a * snoise(p); n += a;
    p = p * 2.02 + vec3(1.7, 9.2, 3.1);
    a *= gain;
  }
  return s / n;
}
float billow(vec3 p, int oct, float gain) {
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < oct * uOne; i++) {
    s += a * (1.0 - abs(snoise(p))); n += a;
    p = p * 2.07 + vec3(4.3, 1.1, 7.7);
    a *= gain;
  }
  return s / n;
}
vec3 rotAxisB(vec3 p, vec3 a, float ang) {
  float c = cos(ang), s = sin(ang);
  return p * c + cross(a, p) * s + a * dot(a, p) * (1.0 - c);
}
// Weather systems: extratropical cyclones (big, loosely wound, opposite sense per hemisphere)
// twist the domain into spiral bands and comma-shaped fronts.
vec3 swirl(vec3 p, float seed) {
  for (int i = 0; i < 15 * uOne; i++) {
    vec3 h = hash33(vec3(float(i), seed, 5.0));
    float hemi = (i & 1) == 0 ? 1.0 : -1.0;
    float la = hemi * mix(0.62, 1.08, h.x);
    float lo = h.y * TAU;
    vec3 c = vec3(cos(la) * cos(lo), sin(la), -cos(la) * sin(lo));
    float d = acos(clamp(dot(p, c), -1.0, 1.0));
    float r = mix(0.13, 0.24, h.z);
    float ang = hemi * mix(1.3, 2.5, fract(h.x * 7.31)) * exp(-d * d / (r * r));
    p = rotAxisB(p, c, ang);
  }
  return p;
}
// large-scale weather: swirled, zonally stretched, gently warped; plus thin frontal bands
float weather(vec3 p, float seed) {
  vec3 w = swirl(p, seed);
  vec3 P = w * vec3(1.5, 2.6, 1.5) + seed * 2.3;
  vec3 q = vec3(fbmL(P * 0.6, 3), fbmL(P * 0.6 + vec3(5.2, 1.3, 2.8), 3), fbmL(P * 0.6 + vec3(1.7, 9.2, 7.1), 3));
  float n = fbmG(P * 1.3 + q * 0.8, 8, 0.56);
  float fr = 1.0 - abs(snoise(P * 0.55 + q * 0.6 + 17.0));
  n += pow(fr, 6.0) * 0.36 * smoothstep(0.2, 0.5, abs(w.y));
  return n;
}
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  vec3 p = sph(uv);
  if (uMode == 0) {
    float wv[2];
    for (int k = 0; k < 2 * uOne; k++) wv[k] = weather(p, float(k + 1));
    float r = wv[0], g = wv[1];
    // erosion detail: puffy cells (|noise|: rounded blobs parted by thin creases, not the
    // ridge lines of 1-|noise| that read as brush strokes) over fine fbm, mildly warped
    vec3 pd = p * 16.0 + vec3(fbmL(p * 5.0 + 20.0, 3), fbmL(p * 5.0 + 27.0, 3), fbmL(p * 5.0 + 33.0, 3)) * 0.9;
    // (kept low-contrast at the finest scales: the globe pans over it, fine speckle would shimmer)
    float b = (0.74 - billow(pd, 4, 0.5)) * 2.1 + fbmG(pd * 2.3 + 7.0, 4, 0.5) * 0.5;
    vec3 pc = p * vec3(2.0, 9.0, 2.0) + vec3(fbmL(p * 2.0 + 30.0, 3), 0.0, fbmL(p * 2.0 + 40.0, 3)) * 0.8;
    float ci = fbmG(pc + 50.0, 6, 0.6);
    o = vec4(saturate(r * 1.2 + 0.5), saturate(g * 1.2 + 0.5), saturate(b * 0.9 + 0.5), saturate(ci * 1.3 + 0.5));
  } else {
    float hDet = fbmL(p * 7.0 + 2.0, 6);
    float rg = ridgedL(p * 5.0 + 3.0, 6);
    float moist = fbmL(p * 2.3 + 40.0, 5) * 0.5 + 0.5;
    float h = fbmL(p * 1.25 + vec3(3.1, 1.7, 5.2), 6) + 0.25 * snoise(p * 0.7 + vec3(9.0, 2.0, 4.0));
    o = vec4(saturate(hDet * 0.5 + 0.5), rg, saturate(moist), saturate(h * 0.4 + 0.5));
  }
}
`;

  const FS_BODY = `
in vec2 vUv; out vec4 o;
uniform vec2 uRes;
uniform float uTime, uCloudTime, uMa;
uniform vec4 uCam;        // centre.xy, radius (screen units), k = 2 tan(fov/2)
uniform mat3 uV2E;        // view -> earth-fixed
uniform mat3 uSky;
uniform vec3 uL;          // light (view space)
uniform float uSun;
uniform vec4 uLava;       // magma, crust, crackGlow, lavaHeat
uniform vec4 uWater;      // sea level, seaOn, plateMix, murk
uniform vec4 uClouds;     // coverage, alpha, storm, lightning
uniform vec4 uCloudP;     // evolve 0..1, cirrus, shadow offset, landClear
uniform vec4 uClr[3];     // cloud-clearing spots: earth-fixed (paleo) centre, angular radius
uniform vec4 uClrA;       // their strengths, -
uniform vec4 uAtmo;       // rgb, strength
uniform vec4 uAtmoB;      // rgb after the oxygenation, progress 0..1 (patchy clearing)
uniform vec4 uAtmo2;      // height, haze, flashTint, glint
uniform vec4 uExtra;      // deep-time shelf band, life bloom, -, -
uniform vec4 uSurf;       // iceLine, green, life, today
uniform vec4 uMisc;       // city, stars, rust, basalt
uniform vec4 uImp[${MAX_IMP}];
uniform vec4 uImpB[${MAX_IMP}];
uniform int uImpN;
uniform vec4 uMoon;       // view-space centre, radius
uniform vec4 uMoonB;      // amount, glow
uniform vec4 uRing;       // opacity, inner, outer, glow
uniform vec3 uRingN;
uniform vec4 uCyc[3];
uniform sampler2D uCityTex;
uniform sampler2D uBiomeTex;
uniform sampler2D uCloudTex;
uniform sampler2D uTerrTex;
uniform sampler2D uSkyTex;   // cached star field (screen space)
uniform int uSkyPass;        // 1: render only the star field (into the cache)

vec3 rotAxis(vec3 p, vec3 a, float ang) {
  float c = cos(ang), s = sin(ang);
  return p * c + cross(a, p) * s + a * dot(a, p) * (1.0 - c);
}
vec2 equirect(vec3 p) {
  float lat = asin(clamp(p.y, -1.0, 1.0));
  float lon = atan(-p.z, p.x);
  return vec2((lon + PI) / TAU, (PI * 0.5 - lat) / PI);
}
// Equirect lookup without the seam artefact at lon = +-180 (explicit gradients, scaled by gs > 1
// for a blurred lookup).
vec4 texEqS(sampler2D t, vec3 p, float gs) {
  vec2 uv = equirect(p);
  vec2 uv2 = vec2(fract(uv.x + 0.5), uv.y);
  vec2 dx = dFdx(uv), dy = dFdy(uv), dx2 = dFdx(uv2), dy2 = dFdy(uv2);
  if (dot(dx2, dx2) + dot(dy2, dy2) < dot(dx, dx) + dot(dy, dy)) { dx = dx2; dy = dy2; }
  return textureGrad(t, uv, dx * gs, dy * gs);
}
vec4 texEq(sampler2D t, vec3 p) { return texEqS(t, p, 1.0); }

// ---------------------------------------------------------------- clouds
// uCloudTime is a bounded local time (seconds). Cyclone .w = twist angle at the eye (radians).
vec3 cloudRigid(vec3 p) {
  float ang = uCloudTime * 0.018;
  float c = cos(ang), s = sin(ang);
  return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}
vec3 cloudTwist(vec3 q) {
  for (int i = 0; i < 3; i++) {
    vec4 cy = uCyc[i];
    if (cy.w == 0.0) continue;
    float d = max(0.0, 1.0 - dot(q, cy.xyz));
    q = rotAxis(q, cy.xyz, cy.w * exp(-d * 30.0));
  }
  return q;
}
// x: opacity, y: thickness (0..1). cov ~ fraction of the sky covered.
// Soft coverage mask of the weather field, eroded by fine billows (frayed, wispy edges).
vec2 cloudAt(vec3 pe, float cov, float dry, float gs) {
  vec3 q = cloudTwist(cloudRigid(pe));
  vec4 c = texEqS(uCloudTex, q, gs);
  float n = mix(c.r, c.g, uCloudP.x);
  // climate bands: ITCZ, dry subtropics, stormy mid-latitudes
  float al = abs(pe.y);
  n += 0.07 * exp(-al * al * 90.0) - 0.08 * exp(-pow((al - 0.42) * 6.0, 2.0)) + 0.05 * smoothstep(0.55, 0.8, al) - dry;
  float th = 0.5 + 0.26 * (1.0 - 2.0 * cov);
  // fine cells fray the rims (strongest where the cloud is thin), soft translucent ramp
  float d0 = saturate((n - th) / 0.42);
  n += (c.b - 0.5) * 0.20 * (1.0 - 0.6 * d0);
  float d = saturate((n - th) / 0.42);
  d *= d * (3.0 - 2.0 * d);
  float op = 1.0 - exp(-d * 3.2);
  // thin cirrus veil
  op = max(op, smoothstep(0.62, 0.9, c.a) * uCloudP.y * 0.35 * (1.0 - d));
  return vec2(op, d);
}
// extra dryness (fewer clouds): over land, and around the clearing spots
float cloudDry(vec3 pe, float landB) {
  float dr = uCloudP.w * smoothstep(0.3, 0.85, landB);
  for (int i = 0; i < 3; i++) {
    float s = uClrA[i];
    if (s == 0.0) continue;
    float a = acos(clamp(dot(pe, uClr[i].xyz), -1.0, 1.0));
    dr += s * smoothstep(uClr[i].w, uClr[i].w * 0.45, a);
  }
  return dr;
}

// oxygenation front: 0 = old (orange) sky, 1 = blue; clears in growing patches
float oxyF(vec3 pE) {
  float w = uAtmoB.w;
  if (w <= 0.0) return 0.0;
  if (w >= 1.0) return 1.0;
  float nz = snoise(pE * 1.6 + 4.0) * 0.5 + 0.5;
  return smoothstep(nz - 0.1, nz + 0.1, w * 1.3 - 0.15);
}

// ---------------------------------------------------------------- lightning
float lightning(vec3 p) {
  if (uClouds.w <= 0.0) return 0.0;
  float acc = 0.0;
  for (int l = 0; l < 2; l++) {
    float sc = l == 0 ? 7.0 : 13.0;
    vec3 c = p * sc;
    vec3 cell = floor(c);
    float fr = uTime * (l == 0 ? 6.0 : 9.0);
    float tb = floor(fr);
    float h = hash13(cell + vec3(tb * 1.7, tb * 3.1, tb * 0.7) + float(l) * 31.0);
    float rate = uClouds.w * 0.06;
    if (h > 1.0 - rate) {
      vec3 jc = cell + 0.35 + 0.3 * hash33(cell + 5.0 + float(l));
      float d = length(c - jc);
      float ph = fract(fr);
      float flick = (0.55 + 0.45 * sin(ph * 40.0 + h * 90.0)) * (1.0 - ph);
      acc += (0.6 * exp(-d * d * 70.0) + 0.4 * exp(-d * d * 16.0)) * flick * (l == 0 ? 1.0 : 0.6);
    }
  }
  return acc;
}

// ---------------------------------------------------------------- impacts (surface)
// kind 0: Late Heavy Bombardment (glowing crater, ejecta ring, rays: surface emission e).
// kind 1: Chicxulub, an atmospheric event drawn over the clouds (eAir): a brief white-hot core, a
// rising fireball, a glowing ejecta curtain racing outward and, behind it, a dark soot/dust veil
// (soot 0..1) that keeps spreading and thinning.
vec3 impactsSurface(vec3 p, float wet, inout float crater, inout vec3 eAir, inout float soot) {
  vec3 e = vec3(0.0);
  for (int i = 0; i < ${MAX_IMP}; i++) {
    if (i >= uImpN) break;
    vec4 a = uImp[i]; vec4 b = uImpB[i];
    float age = a.w;
    if (age < 0.0) continue;
    float d = length(p - a.xyz);       // chord ~ angle (rad)
    float sz = b.x, en = b.y;
    float u = d / sz;
    if (b.z > 0.5) {
      float R = 1.3 + 8.0 * sqrt(age);                 // ejecta front (units of sz)
      float wR = 0.4 + 0.7 * sqrt(age);
      if (u > R + wR * 3.0) continue;
      float core = exp(-age * 16.0) * exp(-u * u * 4.0) * 4.0;
      float fb = 0.9 + 2.0 * sqrt(age);                // fireball radius
      float fire = exp(-u * u / (fb * fb) * 1.6) * exp(-age * 2.4);
      float front = exp(-pow((u - R) / wR, 2.0));
      vec3 tang = normalize(p - a.xyz * dot(p, a.xyz) + 1e-5);
      float rayN = smoothstep(-0.5, 0.6, snoise(tang * 3.5 + a.xyz * 5.0) * 0.65 + snoise(tang * 11.0 + p * 9.0) * 0.35);   // ragged fingers
      float tex = 0.5 + 0.5 * snoise(tang * 5.0 + p * 37.0 + a.xyz * 5.0);
      float curtain = front * exp(-age * 2.6) * (0.2 + 0.8 * rayN) * (0.5 + 0.7 * tex);
      eAir += blackbody(mix(1500.0, 6200.0, exp(-age * 2.2))) * (core + fire * 2.2 * en)
            + blackbody(1600.0) * curtain * 0.9 * en;
      // soot: a dark, ragged ring just behind the front that fills in, then a thinning veil
      float inside = smoothstep(R + wR * 0.5, R - wR * 2.2, u);
      float ring = exp(-pow((u - R + wR * 1.1) / (wR * 1.1), 2.0)) * (0.55 + 0.45 * rayN);
      float s = (inside * 0.55 + ring * 0.5) * smoothstep(0.1, 0.8, age);
      s *= exp(-max(age - 3.0, 0.0) * 0.32) * mix(1.0, 0.45, saturate(d / 0.9));
      s *= 0.65 + 0.35 * tex;
      soot = max(soot, saturate(s) * (1.0 - fire * 0.8));
      crater = max(crater, smoothstep(1.2, 0.5, u) * (1.0 - exp(-age * 1.5)));
      continue;
    }
    if (u > 12.0) continue;
    // flash: a short, local white-hot burst (kept moderate: bloom spreads it over the halo only)
    float fl = exp(-age * 9.0) * exp(-u * u * 2.5) * 3.2 * min(en, 1.5);
    // molten crater cooling
    float cool = exp(-age * 0.45);
    float pool = smoothstep(1.1, 0.4, u) * cool;
    // expanding ejecta ring
    float rr = 0.8 + 2.6 * sqrt(age);
    float ring = exp(-pow((u - rr) / (0.25 + 0.3 * age), 2.0)) * exp(-age * 2.2) * 0.7;
    // ejecta rays
    vec3 tang = normalize(p - a.xyz * dot(p, a.xyz) + 1e-5);
    float rays = pow(saturate(snoise(tang * 9.0 + a.xyz * 13.0) * 0.5 + 0.55), 4.0) * exp(-u * 0.6) * smoothstep(0.7, 1.4, u) * exp(-age * 0.9) * 1.2;
    // over water the melt is quenched at once (steam), only the flash and a short ring remain
    float heat = (pool * 1.6 * (1.0 - wet * 0.9) + ring * (1.0 - wet * 0.5) + rays * (1.0 - wet * 0.8)) * en * en;
    e += blackbody(mix(1300.0, 5200.0, saturate(fl * 0.25 + cool * 0.3))) * (heat + fl);
    crater = max(crater, smoothstep(1.2, 0.5, u) * (1.0 - cool));
  }
  return e;
}

// ---------------------------------------------------------------- star field / sky
vec3 sky(vec3 rd, float px) {
  vec3 d = uSky * rd;
  vec3 c = (starLayer(d, 180.0, px, 0.006, 1.0) + starLayer(d, 420.0, px, 0.0014, 2.0)) * 0.55;
  // faint Milky Way band
  float band = exp(-pow(dot(d, normalize(vec3(0.3, 0.9, -0.3))) * 3.2, 2.0));
  float n = fbm(d * 3.0 + 4.0, 3) * 0.5 + 0.5;
  c += vec3(0.010, 0.009, 0.012) * band * n * n;
  return c;
}

// ---------------------------------------------------------------- the Moon
// returns colour + coverage; sets tHit
vec4 moon(vec3 ro, vec3 rd, vec3 L, float px, out float tHit) {
  tHit = 1e9;
  if (uMoonB.x <= 0.0) return vec4(0.0);
  vec3 oc = ro - uMoon.xyz;
  float b = dot(oc, rd);
  float c = dot(oc, oc) - uMoon.w * uMoon.w;
  float h = b * b - c;
  float dist = length(oc - rd * b);
  float cov = saturate((uMoon.w - dist) / (px * max(-b, 0.1)) + 0.5);
  if (cov <= 0.0 || b > 0.0) return vec4(0.0);
  float t = -b - sqrt(max(h, 0.0));
  tHit = t;
  vec3 n = normalize(ro + rd * t - uMoon.xyz);
  vec3 mp = n * 3.0 + 11.0;
  vec3 alb;
  if (uMoonB.z < 1.0) {
    // young Moon (matches the theia scene's at the hand-off)
    float maria = smoothstep(0.05, 0.35, fbm(mp * 0.9, 4));
    float crat = ridged(mp * 3.0, 3);
    alb = mix(vec3(0.22, 0.21, 0.20), vec3(0.08, 0.08, 0.085), maria) * (0.8 + 0.35 * crat);
  }
  if (uMoonB.z > 0.0) {
    // today's Moon: broad, soft maria on bright highlands, faint large craters
    float mf = fbm(mp * 0.55 + 3.0, 3) + 0.25 * fbm(mp * 1.3 + 7.0, 2);
    float maria = smoothstep(0.02, 0.32, mf);
    float crat = ridged(mp * 1.6, 2);
    vec3 albT = mix(vec3(0.25, 0.245, 0.235), vec3(0.105, 0.10, 0.10), maria) * (0.93 + 0.12 * crat);
    alb = uMoonB.z >= 1.0 ? albT : mix(alb, albT, uMoonB.z);
  }
  float ndl = dot(n, L);
  // today's Moon gets a softer terminator (regolith scattering)
  float lam = mix(max(ndl, 0.0), max(ndl + 0.04, 0.0) * smoothstep(-0.04, 0.45, ndl), uMoonB.z);
  vec3 col = alb * uSun * lam * 0.9;
  float g = uMoonB.y;
  if (g > 0.0) {
    float lava = fbm(mp * 1.5 + uTime * 0.05, 4) * 0.5 + 0.5;
    vec3 em = blackbody(mix(1100.0, 1700.0, lava)) * (0.35 + 1.4 * pow(lava, 3.0));
    col = mix(col, col * 0.4 + em, g);
  }
  return vec4(col, cov * uMoonB.x);
}

void main() {
  vec2 q = (vUv - 0.5) * uRes / min(uRes.x, uRes.y);
  float px = 1.0 / min(uRes.x, uRes.y);
  float k = uCam.w;
  float tanA = uCam.z * k;
  float D = sqrt(1.0 + tanA * tanA) / tanA;
  vec3 ro = vec3(0.0, 0.0, D);
  vec2 sq = q - uCam.xy;
  vec3 rd = normalize(vec3(sq * k, -1.0));
  vec3 L = uL;
  float pxAng = px * k;                      // ~ one pixel in radians
  float rr = length(sq);
  float edge = (uCam.z - rr) / px;           // pixels inside the limb
  float cov = saturate(edge + 0.5);

  // background: the camera never moves relative to the stars, so the star field is rendered
  // once per size into a cache and fetched here
  if (uSkyPass == 1) { o = vec4(sky(rd, pxAng), 1.0); return; }
  vec3 col = cov < 1.0 ? texelFetch(uSkyTex, ivec2(gl_FragCoord.xy), 0).rgb * uMisc.y : vec3(0.0);

  // ---- atmosphere halo (outside + blended on the limb)
  float tc = -dot(ro, rd);
  vec3 m = ro + rd * tc;
  float bLen = length(m);
  vec3 mN = m / max(bLen, 1e-4);
  float H = uAtmo2.x;
  float cosT = dot(rd, L);
  float phase = 0.75 * (1.0 + cosT * cosT) * 0.6 + 2.2 * pow(saturate(cosT), 8.0) + 6.0 * pow(saturate(cosT), 60.0);
  float illum = smoothstep(-0.45, 0.55, dot(mN, L));
  float hgt = max(bLen - 1.0, 0.0);
  float halo = exp(-hgt / H) * 0.9 + exp(-hgt / (H * 4.0)) * 0.18;
  // (the halo turns blue evenly; patchy sectors would read as radial wedges off the limb)
  vec3 haloCol = mix(uAtmo.rgb, uAtmoB.rgb, smoothstep(0.1, 0.9, uAtmoB.w)) * uAtmo.w * halo * illum * phase * uSun * 0.32;

  // ---- moon
  float tMoon;
  vec4 mc = moon(ro, rd, L, pxAng, tMoon);

  // ---- debris ring
  vec3 ringCol = vec3(0.0); float ringA = 0.0; float tRing = 1e9;
  if (uRing.x > 0.0) {
    float dn = dot(rd, uRingN);
    if (abs(dn) > 1e-4) {
      float t = -dot(ro, uRingN) / dn;
      if (t > 0.0) {
        vec3 rp = ro + rd * t;
        float r = length(rp);
        float band = smoothstep(uRing.y, uRing.y + 0.15, r) * smoothstep(uRing.z, uRing.z - 0.4, r);
        if (band > 0.0) {
          vec3 rpN = rp / r;
          float dens = band * (0.45 + 0.55 * (fbm(vec3(r * 9.0, rpN.x * 2.0, rpN.y * 2.0 + rpN.z * 2.0), OCT_HI) * 0.5 + 0.5));
          dens *= 0.6 + 0.4 * sin(r * 37.0 + 1.3) * sin(r * 23.0);
          float s1 = dot(rp, L);
          vec3 perp = rp - L * s1;
          float shadow = s1 < 0.0 ? smoothstep(0.95, 1.05, length(perp)) : 1.0;
          vec3 lit = vec3(0.55, 0.42, 0.32) * uSun * 0.25 * (0.35 + 0.65 * shadow);
          vec3 glow = blackbody(1500.0) * uRing.w * dens;
          ringCol = lit * dens + glow;
          ringA = saturate(dens * uRing.x);
          tRing = t;
        }
      }
    }
  }

  // ---- planet
  float b = dot(ro, rd);
  float c = dot(ro, ro) - 1.0;
  float h = b * b - c;
  vec3 planet = vec3(0.0);
  float tPlanet = 1e9;
  if (cov > 0.0) {
    float t = -b - sqrt(max(h, 0.0));
    tPlanet = t;
    vec3 n = normalize(ro + rd * t);
    vec3 V = -rd;
    vec3 pe = uV2E * n;                       // earth-fixed (paleo) position
    vec3 Le = uV2E * L;                       // light in the earth frame
    float ndl = dot(n, L);
    float mu = saturate(dot(n, V));
    float dayW = smoothstep(-0.12, 0.18, ndl);
    float diff = max(ndl, 0.0) * 0.92 + 0.08 * saturate(ndl + 0.15);
    float lat = pe.y;                          // sin(paleolatitude)
    float absLat = abs(lat);

    // ---------------- oxygenation: the orange haze clears in growing patches (no grey midpoint)
    float oxF = oxyF(pe);
    vec3 atmoRGB = mix(uAtmo.rgb, uAtmoB.rgb, oxF);
    float murk = uWater.w * (1.0 - oxF);
    float hazeA = uAtmo2.y * (1.0 - 0.75 * oxF);

    // ---------------- land / water
    vec3 ppos = pe; int pid = 0;               // present-day position of the point (plate-riding textures)
    float landP = 0.0, landB = 0.0;
    if (uWater.z > 0.0) landP = eLand(pe, ppos, pid, landB);
    vec4 tP = texEq(uTerrTex, pe);                            // terrain fixed to the paleo frame
    vec4 tR = uWater.z > 0.0 ? texEq(uTerrTex, ppos) : tP;    // terrain riding on the plates
    float hProc = tP.a * 2.5 - 1.25;
    float hDet = tR.r * 2.0 - 1.0;
    float ridge = tR.g;
    float moist = tR.b;
    float coastN = hDet * 0.07;
    // (deep time: the coast sits slightly outside the 0.5 contour of today's coastlines)
    float landSoft = mix(hProc - uWater.x + (tP.r - 0.5) * 0.05, (landP - 0.5 + 0.05 * uExtra.x) * 1.6 + coastN, uWater.z);
    float aa = 0.006 + fwidth(landSoft) * 0.9;
    float land = uWater.y > 0.0 ? smoothstep(-aa, aa, landSoft) : 1.0;
    float depth = saturate(-landSoft * 2.2);   // 0 at coast, 1 deep ocean
    float shelf = exp(-max(-landSoft, 0.0) * 9.0) * (1.0 - land);
    // plate era: coastal shallows from the blurred land fraction
    float shelfV = smoothstep(0.25, 0.75, tP.b + (tP.r - 0.5) * 0.6);   // shelves vary in width
    depth = mix(depth, 1.0 - smoothstep(0.1, 0.75, landB) * mix(0.35, 1.0, shelfV), uWater.z);
    shelf = mix(shelf, smoothstep(0.2, 0.8, landB) * (1.0 - land) * mix(0.4, 1.0, shelfV), uWater.z);
    // deep time: a shallow continental-shelf band around the blocks (joins the supercontinents)
    float shelfBand = uExtra.x * uWater.z * smoothstep(0.16, 0.40, landP) * (1.0 - land);
    shelf = max(shelf, shelfBand);
    depth = min(depth, 1.0 - shelfBand);

    // relief: ridged height sampled one step toward the light (in the plate's frame)
    vec3 Lp = plateRotOf(pid) * Le;
    vec3 Lt = Lp - ppos * dot(Lp, ppos);
    Lt /= max(length(Lt), 1e-4);
    float ridgeL = texEq(uTerrTex, normalize(ppos + Lt * 0.004)).g;
    float slope = (ridgeL - ridge) * smoothstep(-0.1, 0.3, ndl);

    // ---------------- ice
    float iceN = (tP.b - 0.5) * 0.20 + (tP.r - 0.5) * 0.06;
    float iceLand = smoothstep(uSurf.x - 0.03, uSurf.x + 0.01, absLat + iceN + 0.06);
    float iceSea = smoothstep(uSurf.x - 0.01, uSurf.x + 0.03, absLat + iceN);

    // ---------------- biomes: climate (paleolatitude belts, continentality, moisture) drives the
    // procedural ones; today's map takes over toward the present
    vec4 bio = vec4(0.0);
    if (uSurf.w > 0.0) bio = texEq(uBiomeTex, ppos);
    float interior = smoothstep(0.6, 0.97, landB) * uWater.z;
    float itcz = exp(-absLat * absLat * 17.0);                   // wet tropics (|lat| < ~14 deg)
    float subt = exp(-pow((absLat - 0.44) * 6.5, 2.0));         // dry subtropical highs (~26 deg)
    float midl = exp(-pow((absLat - 0.74) * 7.0, 2.0));         // wet westerlies (~48 deg)
    // (the equatorial rain belt keeps continental interiors wet: Amazon/Congo-like basins)
    float rain = 0.30 + 0.75 * itcz + 0.40 * midl - 0.55 * subt - 0.40 * interior * (1.0 - 0.65 * itcz) + (moist - 0.5) * 0.7;
    float desertP = smoothstep(0.30, 0.06, rain) * smoothstep(0.92, 0.80, absLat);
    float forestP = smoothstep(0.42, 0.80, rain) * smoothstep(0.93, 0.82, absLat);
    float desert = mix(desertP, bio.r, uSurf.w);
    float forest = mix(forestP, bio.g, uSurf.w);
    float mount = bio.a * uSurf.w;
    float rocky = smoothstep(0.55, 0.9, ridge) * 0.5 * (1.0 - uSurf.w * 0.6) + mount * 0.6;

    vec3 barren = mix(vec3(0.060, 0.056, 0.052), vec3(0.11, 0.085, 0.065), saturate(hDet * 0.8 + 0.5));
    barren = mix(barren, vec3(0.16, 0.075, 0.040) * (0.8 + 0.4 * hDet), uMisc.z * (0.5 + 0.5 * saturate(moist)));
    vec3 grass = mix(vec3(0.050, 0.085, 0.028), vec3(0.12, 0.115, 0.05), saturate(0.85 - rain * 1.1));
    vec3 forestC = mix(vec3(0.020, 0.050, 0.016), vec3(0.028, 0.060, 0.022), saturate(hDet + 0.5));
    vec3 desertC = mix(vec3(0.36, 0.25, 0.14), vec3(0.44, 0.34, 0.21), saturate(hDet + 0.5));
    desertC = mix(desertC, vec3(0.30, 0.17, 0.09), smoothstep(0.55, 0.85, moist) * 0.6);
    vec3 tundra = vec3(0.10, 0.10, 0.085);
    vec3 veg = mix(grass, forestC, saturate(forest));
    veg = mix(veg, tundra, smoothstep(0.80, 0.90, absLat) * (1.0 - uSurf.w * 0.5));
    vec3 landC = mix(barren, veg, uSurf.y);
    landC = mix(landC, desertC, saturate(desert) * mix(0.35, 1.0, uSurf.y));
    landC = mix(landC, vec3(0.12, 0.105, 0.09) * (0.8 + 0.4 * ridge), rocky * 0.6);
    landC *= 0.85 + 0.3 * ridge;
    float relief = clamp(1.0 + slope * (2.5 + 14.0 * rocky), 0.35, 1.8);
    // snow on the high mountains today
    float snowPk = smoothstep(0.55, 0.9, mount * (0.7 + 0.5 * ridge)) * uSurf.w;
    landC = mix(landC, vec3(0.62, 0.64, 0.68), snowPk * 0.55);

    // ---------------- ocean
    vec3 deep = vec3(0.0035, 0.014, 0.045);
    vec3 shallow = vec3(0.012, 0.075, 0.105);
    vec3 oceanC = mix(shallow, deep, smoothstep(0.0, 0.7, depth));
    oceanC = mix(oceanC, vec3(0.028, 0.125, 0.135), shelfBand * 0.55);                   // shelf seas
    oceanC = mix(oceanC, vec3(0.013, 0.052, 0.044), murk * 0.8);                          // murky Archean
    // first life: cyanobacteria tint the coastal shallows and bloom in patches offshore
    if (uSurf.z > 0.0) {
      float bloomN = smoothstep(0.50, 0.78, tP.b * 0.75 + tP.r * 0.55 - 0.05);
      float lifeM = saturate(shelf * 1.5 + 0.10 + bloomN * uExtra.y);
      oceanC = mix(oceanC, mix(vec3(0.016, 0.105, 0.068), vec3(0.034, 0.15, 0.085), shelf), uSurf.z * lifeM);
    }

    // ---------------- crust / magma (Hadean)
    vec3 emis = vec3(0.0);
    float magma = uLava.x, crust = uLava.y;
    vec3 crustC = vec3(0.020, 0.018, 0.017) * (0.8 + 0.5 * ridge);
    if (magma > 0.0 || uLava.z > 0.0) {
      vec3 lp = pe * 3.0;
      vec3 wv = vec3(snoise(lp + uTime * 0.05), snoise(lp + 9.0 - uTime * 0.04), snoise(lp + 21.0));
      float conv = fbm(pe * 2.2 + wv * 0.4 + vec3(0.0, uTime * 0.02, 0.0), OCT_HI) * 0.5 + 0.5;
      float raft = smoothstep(0.68 - crust * 0.7, 0.72 - crust * 0.6, conv + 0.12 * snoise(pe * 9.0));
      float cr1 = abs(snoise(pe * 5.0 + wv * 0.25));
      float cr2 = abs(snoise(pe * 13.0 + 3.0 + wv * 0.15));
      float crackW = mix(0.10, 0.025, crust);
      float cracks = exp(-cr1 / crackW) + 0.6 * exp(-cr2 / (crackW * 0.8));
      float molten = (1.0 - raft) * magma;
      float tK = mix(1250.0, 2100.0, conv);
      vec3 lavaC = blackbody(tK) * (0.6 + 2.6 * pow(conv, 2.0)) * uLava.w;
      emis += lavaC * molten * 1.6;
      // cracks are quenched where the water floods
      emis += blackbody(mix(1100.0, 1500.0, conv)) * cracks * uLava.z * (1.0 - molten) * 1.2 * mix(1.0, land, uWater.y);
      crustC *= 1.0 - 0.5 * cracks * uLava.z;
      land = mix(land, 1.0, 1.0 - uWater.y); // no water before seaOn
    }

    // ---------------- impacts
    float crater = 0.0, soot = 0.0;
    vec3 eAir = vec3(0.0);
    if (uImpN > 0) emis += impactsSurface(pe, uWater.y * (1.0 - land), crater, eAir, soot);

    // ---------------- compose surface albedo
    float isLand = land;
    float crustAmt = max(saturate(1.0 - uWater.y), uMisc.w);
    vec3 landFinal = mix(landC, crustC, crustAmt);
    float ice = mix(iceSea, iceLand, isLand);
    ice = max(ice, bio.b * uSurf.w);
    // ice: brighter on land, bluer and cracked over the sea (pack ice / pressure ridges)
    vec3 iceC = mix(vec3(0.66, 0.73, 0.82), vec3(0.86, 0.89, 0.93), saturate(tR.r * 1.6 - 0.3));
    float crk = smoothstep(0.80, 0.97, tP.g) * (1.0 - isLand);
    iceC = mix(iceC, vec3(0.36, 0.50, 0.66), crk * 0.55);
    iceC = mix(iceC, iceC * vec3(0.78, 0.88, 1.0), (1.0 - isLand) * smoothstep(0.2, 0.9, depth) * 0.6);
    vec3 alb = mix(oceanC, landFinal * relief, isLand);
    alb = mix(alb, iceC * mix(1.0, relief, isLand * 0.6), saturate(ice));

    // ---------------- clouds: coverage, bump toward the sun, soft ground shadow
    float cloudCov = uClouds.x;
    float cl = 0.0, clShadow = 0.0, cThick = 0.0, cBump = 0.0;
    vec3 LtE = Le - pe * dot(Le, pe);
    LtE /= max(length(LtE), 1e-4);             // toward the sun along the surface
    if (cloudCov > 0.0) {
      float dryC = bio.r * uSurf.w * 0.22 + cloudDry(pe, landB);   // fewer clouds over deserts / land / spots
      vec2 cf = cloudAt(pe, cloudCov, dryC, 1.0);
      cl = cf.x * uClouds.y; cThick = cf.y;
#ifdef LITE
      clShadow = cl * 0.75;                    // phones: no offset samples
#else
      cBump = cThick - cloudAt(normalize(pe + LtE * 0.007), cloudCov, dryC, 1.0).y;
      // shadow cast from cloud height: offset grows toward the terminator; blurred lookup
      float tanZ = sqrt(max(1.0 - ndl * ndl, 0.0)) / max(ndl, 0.2);
      vec2 cs = cloudAt(normalize(pe + LtE * uCloudP.z * tanZ), cloudCov, dryC, 3.0);
      clShadow = cs.x * uClouds.y;
#endif
    }
    float shadowF = 1.0 - clShadow * 0.62;

    vec3 surf = alb * uSun * diff * shadowF;
    // ocean glint (dimmed under soot)
    float wet = (1.0 - isLand) * (1.0 - saturate(ice));
    if (wet > 0.0) {
      vec3 Hh = normalize(L + V);
      float ndh = saturate(dot(n, Hh));
      float fres = 0.02 + 0.98 * pow(1.0 - mu, 5.0);
      float spec = pow(ndh, 260.0) * 1.6 + pow(ndh, 36.0) * 0.08;
      surf += uSun * spec * wet * shadowF * (0.25 + fres) * smoothstep(0.0, 0.2, ndl) * (1.0 - murk * 0.25) * uAtmo2.w * (1.0 - soot);
    }
    // night-side city lights: sodium orange to whiter LED light, from the texture's G channel
    if (uMisc.x > 0.0) {
      vec2 ct = texEq(uCityTex, ppos).rg;
      float nightW = smoothstep(0.05, -0.18, ndl);
      vec3 cityC = mix(vec3(1.0, 0.56, 0.22), vec3(1.0, 0.86, 0.66), ct.g);
      emis += cityC * pow(ct.r, 1.7) * 1.7 * nightW * uMisc.x * isLand * (1.0 - cl * 0.75);
    }
    surf += emis * (1.0 - ice * 0.8);

    // clouds on top
    // low sun: reddened light on the cloud tops near the terminator
    float warm = smoothstep(-0.06, 0.05, ndl) * exp(-max(ndl, 0.0) * 7.0);
    if (cl > 0.0) {
      float cLit = saturate(ndl * 1.05 + 0.06);
      float storm = uClouds.z;
      // thin cloud reads grey and translucent, thick tops bright; slightly blue-grey bases
      vec3 base = mix(vec3(0.62, 0.66, 0.72), vec3(0.93, 0.935, 0.95), smoothstep(0.05, 0.8, cThick));
      base = mix(base, vec3(0.30, 0.31, 0.33), storm);
      vec3 cloudC = base * uSun * cLit * (0.64 + 0.38 * cThick);
      // relief of the cells: lit flanks toward the sun, shaded lee sides (stronger at low sun)
      float bumpK = mix(3.0, 6.5, 1.0 - smoothstep(0.1, 0.7, ndl));
      cloudC *= clamp(1.0 + cBump * bumpK * smoothstep(-0.02, 0.25, ndl), 0.5, 1.35);
      cloudC *= mix(vec3(1.0), vec3(1.0, 0.68, 0.42), warm * 0.85);
      // storms: dark, heavy cores
      cloudC *= mix(1.0, 0.35, storm * smoothstep(0.25, 1.0, cThick));
      // storms: towering convective cells, lit tops and dark troughs
      if (storm > 0.0) {
        vec3 sq = cloudRigid(pe) * 5.5 + vec3(0.0, uCloudTime * 0.015, 0.0);
        float cv = abs(snoise(sq + 0.6 * snoise(sq * 0.5 + 3.0))) * 0.65 + 0.35 * abs(snoise(sq * 2.3 + 11.0));
        cloudC *= mix(1.0, 0.45 + 0.9 * smoothstep(0.02, 0.55, cv), storm);
      }
      // lava light from below
      cloudC += emis * 0.25;
      float lt = lightning(pe);
      cloudC += vec3(0.62, 0.72, 1.0) * lt * 4.5 * saturate(cl * 1.5) * (0.6 + 0.4 * cThick);
      surf = mix(surf, cloudC, cl);
    }
    // the low sun also warms the bare surface a little
    surf *= mix(vec3(1.0), vec3(1.0, 0.82, 0.66), warm * 0.4 * (1.0 - cl));

    // soot / dust veil of a large impact (above the clouds), then its fireball and ejecta glow
    if (soot > 0.0) surf = mix(surf, vec3(0.085, 0.066, 0.05) * uSun * (0.08 + 0.32 * diff), soot * 0.85);
    surf += eAir;

    // atmosphere on the disc: rim scattering + haze
    float rim = pow(1.0 - mu, 2.6);
    float aIll = smoothstep(-0.30, 0.45, ndl);
    vec3 atmoC = atmoRGB * uAtmo.w;
    surf = mix(surf, atmoC * uSun * 0.3 * aIll, saturate(hazeA * (0.15 + 0.85 * rim)));
    surf *= 1.0 - rim * 0.3 * uAtmo.w;
    surf += atmoC * uSun * (rim * 0.5 + 0.012) * aIll * (0.6 + 0.4 * dayW);
    planet = surf;
  }

  // ---- composite
  if (mc.a > 0.0 && tMoon < tPlanet) col = mix(col, mc.rgb, mc.a);
  if (cov > 0.0) {
    if (mc.a > 0.0 && tMoon < tPlanet) {
      vec3 pc = mix(col, planet, cov);
      col = mix(pc, mc.rgb, mc.a);
    } else {
      col = mix(col, planet, cov);
    }
  }
  if (mc.a > 0.0 && tMoon >= tPlanet && cov < 1.0) col = mix(col, mc.rgb, mc.a * (1.0 - cov));
  col += haloCol * (1.0 - cov * 0.85);
  if (ringA > 0.0) {
    float vis = tRing < tPlanet ? 1.0 : 1.0 - cov;
    col = mix(col, ringCol / max(ringA, 1e-3) * min(ringA, 1.0), ringA * vis);
  }
  o = vec4(max(col, 0.0), 1.0);
}
`;

  // --------------------------------------------------------------- present-day data
  // Night lights: [lat, lon, weight, spread(deg), towns]
  const CITIES = [
    // Europe
    [51.5, -0.1, 1.0, 1.2, 260], [53.5, -2.3, 0.75, 1.3, 260], [55.9, -3.8, 0.45, 0.8, 80],
    [48.9, 2.35, 0.95, 1.2, 240], [45.7, 4.8, 0.55, 1.5, 150], [43.4, 5.2, 0.5, 1.2, 120],
    [51.2, 5.2, 1.0, 1.6, 520], [50.9, 7.2, 0.9, 1.4, 380], [50.5, 10.5, 0.6, 3.0, 650],
    [52.5, 13.4, 0.75, 1.0, 140], [48.2, 11.5, 0.6, 1.2, 140], [48.2, 16.4, 0.6, 1.0, 100],
    [47.4, 8.5, 0.55, 1.0, 120], [45.4, 9.4, 0.85, 1.6, 320], [41.9, 12.5, 0.6, 1.2, 140],
    [40.8, 14.3, 0.55, 0.9, 100], [38.0, 13.4, 0.35, 1.2, 70], [43.8, 11.2, 0.4, 1.2, 120],
    [40.4, -3.7, 0.75, 1.0, 150], [41.4, 2.2, 0.65, 0.9, 110], [39.5, -0.4, 0.45, 0.9, 70],
    [37.4, -5.9, 0.45, 1.0, 80], [39.5, -4.5, 0.25, 3.5, 300], [38.7, -9.1, 0.6, 0.8, 90], [41.2, -8.6, 0.5, 0.7, 70],
    [52.2, 21.0, 0.6, 1.0, 120], [51.5, 19.0, 0.4, 3.0, 380], [50.1, 14.4, 0.55, 1.2, 140],
    [47.5, 19.0, 0.55, 1.0, 110], [44.4, 26.1, 0.5, 1.0, 100], [45.5, 24.5, 0.3, 3.0, 260],
    [55.75, 37.6, 1.0, 1.3, 260], [54.5, 40.0, 0.35, 5.0, 650], [59.9, 30.3, 0.65, 0.9, 110],
    [50.4, 30.5, 0.6, 1.0, 110], [49.0, 33.0, 0.35, 3.5, 420], [47.0, 37.5, 0.4, 1.5, 120],
    [53.9, 27.6, 0.4, 0.9, 70], [44.8, 20.5, 0.45, 0.9, 70], [42.7, 23.3, 0.4, 0.8, 60],
    [37.98, 23.7, 0.65, 0.8, 90], [40.6, 22.9, 0.35, 0.6, 40], [41.0, 29.0, 0.9, 1.0, 160],
    [39.5, 33.5, 0.4, 3.5, 320], [40.2, 44.5, 0.35, 1.0, 50], [41.7, 44.8, 0.35, 0.8, 40],
    [59.3, 18.1, 0.45, 0.9, 60], [59.9, 10.7, 0.4, 0.8, 50], [55.7, 12.6, 0.5, 0.9, 70],
    [60.2, 24.9, 0.4, 0.8, 50], [57.5, 15.0, 0.18, 4.0, 180], [53.3, -6.3, 0.45, 0.8, 50],
    [56.9, 24.1, 0.3, 0.8, 40], [54.7, 25.3, 0.3, 0.8, 40],
    // Russia / Central Asia (sparse)
    [56.3, 44.0, 0.45, 1.0, 60], [55.8, 49.1, 0.45, 1.0, 60], [53.2, 50.1, 0.4, 1.0, 60],
    [56.8, 60.6, 0.5, 1.0, 70], [55.2, 61.4, 0.45, 1.0, 60], [55.0, 73.4, 0.4, 1.0, 50],
    [55.0, 82.9, 0.45, 1.0, 60], [56.0, 92.9, 0.35, 0.9, 40], [52.3, 104.3, 0.35, 0.9, 40],
    [43.1, 131.9, 0.35, 0.8, 30], [47.2, 39.7, 0.5, 1.0, 60], [48.7, 44.5, 0.4, 0.9, 50],
    [43.2, 76.9, 0.5, 1.0, 60], [41.3, 69.3, 0.55, 1.0, 80], [51.2, 71.4, 0.35, 0.8, 30],
    [40.4, 49.9, 0.5, 0.8, 50],
    // Middle East
    [33.9, 35.5, 0.55, 0.6, 50], [32.1, 34.8, 0.8, 0.7, 90], [31.9, 35.9, 0.5, 0.6, 40],
    [33.5, 36.3, 0.5, 0.7, 50], [36.2, 37.2, 0.45, 0.7, 40], [33.3, 44.4, 0.65, 1.0, 110],
    [30.5, 47.8, 0.5, 0.8, 50], [36.2, 44.0, 0.4, 0.8, 40], [29.4, 47.9, 0.65, 0.6, 50],
    [26.2, 50.2, 0.6, 0.6, 40], [25.3, 51.5, 0.65, 0.4, 35], [24.5, 54.4, 0.6, 0.5, 40],
    [25.2, 55.3, 0.85, 0.6, 80], [23.6, 58.4, 0.45, 0.6, 30], [24.7, 46.7, 0.75, 0.9, 90],
    [21.5, 39.2, 0.65, 0.7, 70], [21.4, 39.8, 0.4, 0.4, 20], [26.4, 50.0, 0.5, 0.5, 30],
    [15.4, 44.2, 0.3, 0.8, 40], [35.7, 51.4, 0.85, 1.0, 150], [32.0, 52.5, 0.3, 4.0, 300],
    [36.3, 59.6, 0.5, 0.8, 50], [38.1, 46.3, 0.45, 0.8, 50], [29.6, 52.5, 0.45, 0.8, 40],
    [32.6, 51.7, 0.5, 0.8, 50], [34.5, 69.2, 0.35, 0.8, 30],
    // Africa
    [30.05, 31.25, 1.0, 0.6, 220], [31.2, 29.9, 0.6, 0.5, 70], [30.8, 31.0, 0.55, 0.9, 140],
    [6.5, 3.4, 0.75, 0.9, 140], [9.0, 7.4, 0.4, 0.9, 60], [10.0, 7.0, 0.22, 3.5, 300], [12.0, 8.5, 0.4, 0.8, 50],
    [5.6, -0.2, 0.5, 0.8, 70], [5.35, -4.0, 0.5, 0.8, 60], [6.7, -1.6, 0.35, 0.6, 30],
    [14.7, -17.4, 0.45, 0.5, 40], [12.6, -8.0, 0.3, 0.5, 25], [12.4, -1.5, 0.25, 0.5, 20], [13.5, 2.1, 0.2, 0.5, 15],
    [-26.2, 28.0, 0.85, 1.1, 160], [-25.7, 28.2, 0.55, 0.6, 50], [-33.9, 18.5, 0.6, 0.6, 60],
    [-29.9, 30.9, 0.5, 0.6, 50], [-33.9, 25.6, 0.3, 0.5, 20], [-29.1, 26.2, 0.25, 0.5, 15],
    [-1.3, 36.8, 0.45, 0.6, 50], [-6.8, 39.3, 0.4, 0.6, 40], [0.3, 32.6, 0.35, 0.5, 30],
    [9.0, 38.7, 0.4, 0.6, 50], [15.6, 32.5, 0.45, 0.6, 50], [-4.3, 15.3, 0.4, 0.6, 50],
    [-8.8, 13.2, 0.35, 0.5, 30], [-17.8, 31.0, 0.3, 0.5, 25], [-15.4, 28.3, 0.25, 0.5, 20],
    [-25.9, 32.6, 0.3, 0.5, 20], [-18.9, 47.5, 0.25, 0.5, 20], [3.9, 11.5, 0.3, 0.5, 25], [4.05, 9.7, 0.35, 0.5, 30],
    [33.6, -7.6, 0.65, 0.8, 90], [34.0, -5.0, 0.4, 1.5, 120], [31.6, -8.0, 0.4, 0.6, 40], [35.7, -5.8, 0.4, 0.5, 30],
    [36.75, 3.05, 0.65, 0.8, 90], [36.0, 2.0, 0.35, 2.0, 150], [35.7, -0.6, 0.45, 0.6, 40],
    [36.8, 10.2, 0.55, 0.7, 60], [35.0, 10.5, 0.3, 1.0, 50], [32.9, 13.2, 0.4, 0.6, 30], [32.1, 20.1, 0.3, 0.5, 20],
    // South Asia
    [28.6, 77.2, 1.0, 1.2, 280], [26.5, 81.5, 0.55, 3.5, 950], [25.5, 85.0, 0.5, 2.0, 400],
    [19.05, 72.9, 0.95, 0.8, 200], [18.5, 73.9, 0.65, 0.7, 90], [22.6, 88.4, 0.85, 1.0, 220],
    [12.97, 77.6, 0.75, 0.9, 150], [13.08, 80.27, 0.75, 0.7, 120], [17.4, 78.5, 0.75, 0.9, 130],
    [23.0, 72.6, 0.7, 0.9, 120], [26.9, 75.8, 0.55, 0.9, 90], [21.1, 79.1, 0.45, 0.8, 70],
    [20.0, 78.0, 0.3, 5.0, 1300], [11.0, 77.0, 0.45, 1.5, 250], [9.9, 76.3, 0.5, 1.0, 140],
    [31.5, 74.3, 0.75, 1.2, 220], [30.7, 76.8, 0.5, 1.0, 100], [33.6, 73.1, 0.55, 0.7, 70],
    [24.9, 67.0, 0.75, 0.7, 100], [30.2, 71.5, 0.4, 1.5, 140], [23.8, 90.4, 0.7, 1.1, 300],
    [22.3, 91.8, 0.45, 0.6, 50], [6.9, 79.9, 0.4, 0.6, 50], [27.7, 85.3, 0.35, 0.5, 30],
    // East Asia
    [39.9, 116.4, 0.95, 1.2, 240], [39.1, 117.2, 0.75, 0.8, 120], [36.5, 116.5, 0.55, 3.0, 1100],
    [34.7, 113.6, 0.6, 1.0, 140], [31.2, 121.5, 1.0, 1.2, 300], [32.0, 118.8, 0.7, 1.0, 140],
    [30.3, 120.2, 0.75, 0.9, 140], [30.6, 114.3, 0.7, 1.0, 140], [29.0, 113.0, 0.4, 3.0, 450],
    [23.1, 113.3, 1.0, 1.0, 280], [22.5, 114.1, 1.0, 0.6, 140], [24.5, 118.1, 0.6, 1.0, 120],
    [26.1, 119.3, 0.5, 0.8, 80], [30.6, 104.1, 0.7, 1.2, 200], [29.6, 106.5, 0.65, 0.9, 120],
    [34.3, 108.9, 0.65, 0.9, 110], [38.0, 114.5, 0.55, 1.0, 110], [41.8, 123.4, 0.6, 1.0, 110],
    [45.8, 126.6, 0.5, 0.9, 80], [43.9, 125.3, 0.45, 0.9, 70], [36.1, 120.4, 0.6, 0.9, 90],
    [25.0, 102.7, 0.45, 0.8, 60], [22.8, 108.3, 0.4, 0.8, 50], [43.8, 87.6, 0.35, 0.6, 30],
    [37.55, 127.0, 1.0, 0.9, 200], [35.2, 129.0, 0.7, 0.7, 90], [36.0, 128.0, 0.4, 1.2, 120],
    [39.0, 125.7, 0.12, 0.4, 8],
    [35.7, 139.7, 1.0, 1.0, 300], [34.7, 135.5, 0.95, 0.8, 200], [35.2, 136.9, 0.75, 0.7, 120],
    [33.6, 130.4, 0.6, 0.7, 80], [35.5, 137.0, 0.4, 2.5, 320], [43.1, 141.3, 0.5, 0.7, 50], [38.3, 140.9, 0.45, 0.7, 50],
    [25.0, 121.5, 0.8, 0.8, 120], [23.0, 120.5, 0.6, 0.8, 90], [14.6, 121.0, 0.7, 0.8, 120],
    [10.3, 123.9, 0.4, 0.6, 40], [13.75, 100.5, 0.85, 0.9, 160], [21.0, 105.8, 0.6, 0.8, 100],
    [10.8, 106.7, 0.7, 0.8, 110], [16.0, 108.2, 0.35, 0.6, 30], [16.8, 96.2, 0.35, 0.6, 40],
    [3.1, 101.7, 0.65, 0.9, 100], [1.35, 103.8, 0.85, 0.35, 50], [-6.2, 106.8, 0.9, 1.0, 200],
    [-7.0, 110.0, 0.55, 2.0, 400], [-7.3, 112.7, 0.6, 0.8, 100], [3.6, 98.7, 0.45, 0.6, 50],
    [-5.1, 119.4, 0.35, 0.5, 30], [-8.6, 115.2, 0.35, 0.4, 20],
    // North America
    [40.7, -74.0, 1.0, 1.0, 360], [39.95, -75.2, 0.8, 0.8, 140], [42.36, -71.06, 0.8, 0.9, 140],
    [38.9, -77.0, 0.8, 0.8, 140], [39.3, -76.6, 0.6, 0.6, 60], [41.9, -87.6, 0.95, 1.0, 200],
    [42.3, -83.0, 0.7, 0.9, 110], [41.5, -81.7, 0.55, 0.8, 80], [40.4, -80.0, 0.55, 0.8, 70],
    [39.1, -84.5, 0.5, 0.7, 60], [39.8, -86.2, 0.5, 0.7, 60], [38.6, -90.2, 0.55, 0.8, 70],
    [39.1, -94.6, 0.5, 0.7, 60], [44.98, -93.3, 0.55, 0.8, 70], [43.0, -87.9, 0.45, 0.7, 50],
    [36.0, -86.0, 0.25, 6.0, 1500], [40.5, -89.0, 0.25, 4.0, 600], [33.75, -84.4, 0.75, 1.0, 140],
    [35.2, -80.8, 0.55, 0.9, 80], [35.8, -78.6, 0.45, 0.8, 60], [36.2, -86.8, 0.5, 0.7, 60],
    [29.76, -95.37, 0.85, 1.0, 150], [32.8, -96.8, 0.85, 1.0, 150], [29.4, -98.5, 0.6, 0.7, 70],
    [30.3, -97.7, 0.55, 0.6, 50], [29.95, -90.07, 0.5, 0.6, 50], [35.5, -97.5, 0.45, 0.7, 50],
    [25.8, -80.2, 0.85, 0.7, 120], [28.5, -81.4, 0.6, 0.8, 80], [27.9, -82.5, 0.6, 0.8, 80],
    [30.3, -81.7, 0.4, 0.6, 40], [34.05, -118.25, 1.0, 1.1, 260], [32.7, -117.15, 0.65, 0.6, 70],
    [37.7, -122.2, 0.85, 0.8, 150], [38.6, -121.5, 0.45, 0.6, 40], [36.7, -119.8, 0.35, 1.5, 80],
    [47.6, -122.3, 0.65, 0.8, 90], [45.5, -122.7, 0.5, 0.7, 50], [33.45, -112.07, 0.7, 0.8, 90],
    [36.17, -115.14, 0.7, 0.5, 50], [39.74, -104.99, 0.6, 0.7, 70], [40.76, -111.89, 0.5, 0.6, 40],
    [35.1, -106.6, 0.35, 0.5, 25], [31.8, -106.4, 0.45, 0.5, 30],
    [43.65, -79.38, 0.85, 0.9, 140], [45.5, -73.57, 0.75, 0.8, 100], [45.4, -75.7, 0.45, 0.5, 40],
    [49.28, -123.12, 0.6, 0.6, 60], [51.05, -114.07, 0.5, 0.5, 40], [53.55, -113.49, 0.45, 0.5, 35],
    [49.9, -97.1, 0.35, 0.5, 25], [46.8, -71.2, 0.4, 0.5, 30], [44.65, -63.6, 0.3, 0.5, 20],
    [19.43, -99.13, 1.0, 1.0, 230], [20.67, -103.35, 0.65, 0.6, 70], [25.67, -100.31, 0.65, 0.6, 70],
    [21.0, -101.0, 0.3, 3.0, 380], [19.0, -98.2, 0.5, 0.6, 50], [32.5, -117.0, 0.5, 0.5, 40],
    [21.16, -86.85, 0.35, 0.4, 20], [20.97, -89.62, 0.4, 0.5, 30], [14.6, -90.5, 0.45, 0.6, 40],
    [13.7, -89.2, 0.4, 0.5, 30], [14.1, -87.2, 0.3, 0.5, 25], [12.1, -86.3, 0.3, 0.5, 20],
    [9.93, -84.08, 0.35, 0.5, 25], [8.98, -79.52, 0.45, 0.5, 30], [23.1, -82.4, 0.4, 0.6, 30],
    [18.5, -69.9, 0.45, 0.6, 40], [18.4, -66.1, 0.55, 0.6, 50], [18.0, -76.8, 0.3, 0.4, 20], [18.6, -72.3, 0.2, 0.4, 15],
    // South America
    [-23.55, -46.63, 1.0, 1.1, 300], [-22.9, -43.2, 0.85, 0.9, 170], [-21.0, -46.0, 0.35, 3.5, 650],
    [-19.9, -43.9, 0.65, 0.7, 80], [-25.4, -49.3, 0.55, 0.7, 60], [-30.0, -51.2, 0.55, 0.7, 60],
    [-15.8, -47.9, 0.5, 0.6, 50], [-12.97, -38.5, 0.55, 0.6, 50], [-8.05, -34.9, 0.55, 0.6, 50],
    [-3.7, -38.5, 0.5, 0.6, 50], [-8.0, -37.0, 0.3, 2.0, 220], [-3.1, -60.0, 0.4, 0.5, 30], [-1.45, -48.5, 0.4, 0.5, 30],
    [-34.6, -58.4, 0.9, 1.0, 170], [-31.4, -64.2, 0.5, 0.6, 50], [-32.9, -60.7, 0.45, 0.6, 40],
    [-33.0, -62.0, 0.2, 3.0, 180], [-34.9, -56.2, 0.45, 0.5, 30], [-25.3, -57.6, 0.35, 0.5, 30],
    [-33.45, -70.67, 0.75, 0.7, 90], [-12.05, -77.04, 0.7, 0.6, 70], [4.7, -74.07, 0.65, 0.7, 70],
    [6.25, -75.56, 0.5, 0.5, 40], [3.45, -76.5, 0.4, 0.5, 30], [10.5, -66.9, 0.55, 0.7, 60],
    [10.6, -71.6, 0.4, 0.5, 30], [-0.2, -78.5, 0.4, 0.5, 30], [-2.2, -79.9, 0.45, 0.5, 30],
    [-16.5, -68.15, 0.35, 0.4, 25], [-17.8, -63.2, 0.3, 0.4, 20], [10.9, -74.8, 0.4, 0.5, 30],
    // Oceania
    [-33.87, 151.21, 0.8, 0.9, 100], [-37.81, 144.96, 0.75, 0.8, 90], [-27.47, 153.03, 0.6, 0.7, 60],
    [-31.95, 115.86, 0.55, 0.6, 40], [-34.93, 138.6, 0.45, 0.5, 30], [-35.3, 149.1, 0.3, 0.4, 15],
    [-36.85, 174.76, 0.45, 0.6, 40], [-41.3, 174.8, 0.3, 0.4, 15], [-43.5, 172.6, 0.3, 0.4, 15],
  ];
  // Nile valley & other linear features: [lat0, lon0, lat1, lon1, weight, towns]
  const LINES = [
    [24.1, 32.9, 30.0, 31.2, 0.55, 260], [30.0, 31.2, 31.4, 30.4, 0.6, 120],
    [55.0, 60.0, 52.0, 104.0, 0.25, 260], [45.0, 41.0, 40.0, 49.0, 0.2, 60],
    [35.0, 135.5, 35.7, 139.7, 0.6, 160], [40.7, -74.0, 42.4, -71.0, 0.6, 120],
  ];
  // Present-day biomes: ellipses [lat, lon, rLat, rLon, value]
  const DESERTS = [
    [23, 8, 9, 22, 1], [22, 25, 8, 12, 1], [17, 0, 4, 22, 0.55], [27, -8, 4, 7, 0.7],
    [23, 47, 7, 10, 1], [30, 58, 5, 9, 0.75], [27, 70, 3.5, 3.5, 0.55], [32, 65, 4, 6, 0.7],
    [41, 84, 4, 12, 0.85], [43, 104, 4.5, 11, 0.8], [33, 88, 4, 9, 0.5], [45, 60, 5, 12, 0.45],
    [-23, 19, 6, 6, 0.75], [-26, 134, 8.5, 15, 0.95], [-22, 122, 4, 6, 0.8],
    [33, -113, 5, 6, 0.75], [39, -116, 4, 4, 0.5], [28, -106, 4, 4, 0.6], [-24, -69.5, 6, 1.6, 0.9],
    [-44, -68, 6, 3, 0.6], [-13, -76, 6, 1.2, 0.6], [8, 46, 4, 5, 0.6], [15, 40, 4, 3, 0.35], [-36, -65, 4, 3, 0.3],
  ];
  const FORESTS = [
    [-4, -63, 9, 13, 1], [-12, -50, 6, 8, 0.6], [1, 22, 6, 10, 1], [7, -7, 3, 6, 0.6], [-8, 25, 5, 8, 0.6],
    [0, 112, 6, 12, 1], [-5, 140, 4, 8, 1], [15, 102, 6, 6, 0.75], [27, 112, 6, 8, 0.7], [37, 128, 4, 4, 0.6],
    [36, 137, 3, 4, 0.8], [60, -100, 7, 30, 0.85], [58, 60, 6, 20, 0.85], [58, 100, 8, 25, 0.8], [62, 130, 6, 20, 0.7],
    [38, -82, 6, 8, 0.85], [47, -72, 5, 10, 0.7], [48, -122, 6, 4, 0.7], [50, 15, 6, 18, 0.65], [60, 20, 5, 12, 0.8],
    [56, 35, 4, 10, 0.7], [44, 10, 3, 8, 0.4], [21, 79, 5, 6, 0.45], [26, 90, 3, 5, 0.6], [-20, -45, 6, 5, 0.6],
    [-18, 48, 4, 2, 0.4], [-30, 152, 4, 3, 0.5], [-41, -73, 4, 2, 0.6], [10, -75, 4, 6, 0.6], [15, -88, 4, 5, 0.75],
    [-38, 145, 3, 4, 0.4],
  ];
  const ICE = [[72.5, -40, 11, 19, 1]];
  const MOUNTAINS = [
    [31, 86, 3.2, 14, 1], [33, 82, 5, 10, 0.55], [35, 76, 2.5, 4, 0.9], [38, 72, 2.5, 4, 0.7],
    [46.3, 9, 1.0, 4.2, 0.9], [43, 43, 1.0, 4, 0.7], [33, 50, 2.0, 5, 0.45], [42.5, 0.5, 0.6, 2.5, 0.5],
    [42, 80, 1.5, 6, 0.6], [50, 88, 2, 5, 0.4], [9, 39, 3, 2.5, 0.45], [-3, 37, 2, 1.5, 0.35], [31, -7, 1.2, 4, 0.45],
  ];
  // polylines for long thin ranges: [[lat, lon], ...], width(deg), value
  const RANGES = [
    [[[8, -72.5], [2, -77], [-5, -79], [-12, -76], [-17, -70], [-23, -68], [-30, -70], [-37, -71], [-45, -72], [-52, -73]], 2.0, 1],
    [[[60, -137], [54, -127], [49, -117], [44, -111], [39, -106.5], [35, -106], [30, -107]], 2.4, 0.7],
    [[[42, -122], [37, -119], [35, -118]], 1.0, 0.5], [[[67, 60], [57, 59], [50, 58]], 1.0, 0.35],
  ];

  // Night lights (RG8): R = light, G = how white it is (0 sodium orange .. 1 LED white). Sharp
  // point-like towns, small bright cores, radial roads and faint lines between nearby cities.
  // A generator: it yields between small units of work so init can slice it (see sliced()), and
  // returns [data, U.gl.texture options] (the upload waits until the shaders have compiled).
  function* cityTextureGen(gl, tier) {
    const W = tier === 'high' ? 4096 : 2048, H = W / 2;
    const sc = W / 2048;                      // texel radii below are given for 2048 wide
    const acc = new Float32Array(W * H);
    yield;
    const accW = new Float32Array(W * H);
    yield;
    const rnd = M.rng(90210);
    const gauss = () => { let u = 0, v = 0; while (u === 0) u = rnd(); v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const splat = (lat, lon, w, rpx, white) => {
      rpx *= sc;
      const x = ((lon + 180) / 360) * W, y = ((90 - lat) / 180) * H;
      const sx = rpx / Math.max(0.15, Math.cos(lat * D2R));
      const rx = Math.ceil(sx * 2.5), ry = Math.ceil(rpx * 2.5);
      const x0 = Math.floor(x), y0 = Math.floor(y);
      for (let j = -ry; j <= ry; j++) {
        const yy = y0 + j; if (yy < 0 || yy >= H) continue;
        const dy = (yy + 0.5 - y) / rpx;
        for (let i = -rx; i <= rx; i++) {
          const xx = (((x0 + i) % W) + W) % W;
          const dx = (x0 + i + 0.5 - x) / sx;
          const v = w * Math.exp(-0.5 * (dx * dx + dy * dy));
          acc[yy * W + xx] += v;
          accW[yy * W + xx] += v * white;
        }
      }
    };
    // regional lighting mix: whiter (LED / mercury) in North America, Europe, Japan/Korea;
    // sodium orange elsewhere
    const whiteOf = (lat, lon) => {
      let w = 0.25;
      if (lat > 24 && lon > -130 && lon < -60) w = 0.5;
      if (lat > 35 && lon > -12 && lon < 40) w = 0.55;
      if (lat > 30 && lon > 125 && lon < 146) w = 0.75;
      return w;
    };
    const dot = (lat, lon, w, rpx, white) => splat(lat, lon, w, rpx, Math.min(1, Math.max(0, white + (rnd() - 0.5) * 0.5)));
    const line = (a0, o0, a1, o1, w, per, white) => {
      const len = Math.hypot(a1 - a0, (o1 - o0) * Math.cos(((a0 + a1) / 2) * D2R));
      const n = Math.max(2, Math.round(len * per));
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        dot(a0 + (a1 - a0) * u + gauss() * 0.03, o0 + (o1 - o0) * u + gauss() * 0.03, w * (0.5 + rnd()), 0.42, white);
      }
    };
    const town = (lat, lon, w, c0, c1, white) => {
      const r = rnd();
      const b = w * (0.08 + 0.92 * Math.pow(r, 5));
      dot(lat, lon, b * 0.85, 0.4 + 0.4 * Math.pow(r, 3), white);
      // the larger towns are joined to their city by a road
      if (r > 0.9) line(c0, c1, lat, lon, b * 0.07, 12, white);
    };
    for (const [lat, lon, w, sp, n] of CITIES) {
      const wh = whiteOf(lat, lon);
      // a compact bright core (whiter in the centre) + a ring of suburbs
      dot(lat, lon, w * 1.0, Math.max(0.7, sp * 0.6), wh + 0.25);
      dot(lat, lon, w * 0.35, Math.max(1.0, sp * 1.1), wh);
      for (let i = 0; i < n; i++) {
        const dl = gauss() * sp, dn = gauss() * sp / Math.max(0.2, Math.cos(lat * D2R));
        town(lat + dl, lon + dn, w * Math.exp(-0.5 * (dl * dl + dn * dn) / (sp * sp * 2.5)) + 0.06, lat, lon, wh);
        if ((i & 31) === 31) yield;
      }
      yield;
    }
    // highways between nearby cities
    for (let i = 0; i < CITIES.length; i++) {
      const [la, lo, wa] = CITIES[i];
      if (wa < 0.3) continue;
      for (let j = i + 1; j < CITIES.length; j++) {
        const [lb, lob, wb] = CITIES[j];
        if (wb < 0.3) continue;
        const d = Math.hypot(lb - la, (lob - lo) * Math.cos(((la + lb) / 2) * D2R));
        if (d > 8 || d < 0.8) continue;
        line(la, lo, lb, lob, 0.10 * Math.min(wa, wb) * (1.2 - d / 10), 9, whiteOf(la, lo));
      }
      yield;
    }
    for (const [a0, o0, a1, o1, w, n] of LINES) {
      const wh = whiteOf(a0, o0);
      for (let i = 0; i < n; i++) {
        const u = rnd();
        town(a0 + (a1 - a0) * u + gauss() * 0.12, o0 + (o1 - o0) * u + gauss() * 0.12, w, a0 + (a1 - a0) * u, o0 + (o1 - o0) * u, wh);
        if ((i & 63) === 63) yield;
      }
      yield;
    }
    const data = new Uint8Array(W * H * 2);
    yield;
    for (let y = 0; y < H; y++) {
      for (let i = y * W, e = i + W; i < e; i++) {
        const a = acc[i];
        data[i * 2] = Math.round(255 * (1 - Math.exp(-a * 1.25)));
        data[i * 2 + 1] = a > 1e-4 ? Math.round(255 * Math.min(1, accW[i] / a)) : 0;
      }
      if ((y & 31) === 31) yield;
    }
    return [data, { width: W, height: H, internalFormat: gl.RG8, format: gl.RG, wrap: ['repeat', 'clamp'], mipmap: true }];
  }

  function* biomeTextureGen(gl) {
    const W = 720, H = 360;
    const data = new Uint8Array(W * H * 4);
    const field = new Float32Array(W * H * 4);
    const ell = function* (list, ch) {
      for (const [lat, lon, rl, ro, v] of list) {
        const y0 = Math.floor(((90 - lat - rl * 2.2) / 180) * H), y1 = Math.ceil(((90 - lat + rl * 2.2) / 180) * H);
        const xr = Math.ceil((ro * 2.2 / 360) * W);
        const xc = ((lon + 180) / 360) * W;
        for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++) {
          const la = 90 - ((y + 0.5) / H) * 180;
          for (let i = -xr; i <= xr; i++) {
            const x = (((Math.floor(xc) + i) % W) + W) % W;
            const lo = -180 + ((Math.floor(xc) + i + 0.5) / W) * 360;
            const dl = (la - lat) / rl, dn = (lo - lon) / ro;
            const d2 = dl * dl + dn * dn;
            const e = v * Math.exp(-1.6 * d2 * d2);
            const k = (y * W + x) * 4 + ch;
            field[k] = Math.max(field[k], e);
          }
        }
        yield;
      }
    };
    yield* ell(DESERTS, 0);
    yield* ell(FORESTS, 1);
    yield* ell(ICE, 2);
    yield* ell(MOUNTAINS, 3);
    for (const [pts, wdt, v] of RANGES) {
      const seg = [];
      for (let i = 1; i < pts.length; i++) {
        const [a0, o0] = pts[i - 1], [a1, o1] = pts[i];
        const n = 30;
        for (let j = 0; j < n; j++) { const u = j / n; seg.push([a0 + (a1 - a0) * u, o0 + (o1 - o0) * u, wdt, wdt, v]); }
      }
      yield* ell(seg, 3);
    }
    const rnd = M.rng(4242);
    for (let y = 0; y < H; y++) {
      const la = 90 - ((y + 0.5) / H) * 180;
      for (let x = 0; x < W; x++) {
        const k = (y * W + x) * 4;
        // Antarctica + sea ice, Arctic sea ice
        let ice = field[k + 2];
        ice = Math.max(ice, M.smoothstep(-61, -66, la));
        ice = Math.max(ice, M.smoothstep(76, 81, la) * 0.95);
        // boreal default greenness, tundra at high latitudes
        const absLat = Math.abs(la);
        let green = field[k + 1];
        green = Math.max(green, 0.35 * M.smoothstep(68, 55, absLat));
        const desert = field[k] * (1 - green * 0.5);
        data[k] = Math.round(255 * M.saturate(desert));
        data[k + 1] = Math.round(255 * M.saturate(green));
        data[k + 2] = Math.round(255 * M.saturate(ice));
        data[k + 3] = Math.round(255 * M.saturate(field[k + 3] * (0.85 + 0.15 * rnd())));
      }
      if (y % 45 === 44) yield;
    }
    return [data, { width: W, height: H, wrap: ['repeat', 'clamp'], mipmap: true }];
  }

  // --------------------------------------------------------------- module
  const E = (U.earth = {
    hasPlates: false,
    prog: null,
    atlas: null,
    PLATE_UNIT: 2,
    CLOUD_UNIT: 3,
    TERRAIN_UNIT: 4,
    SKY_UNIT: 5,
    _ready: null,
  });

  E.earthPos = function (latDeg, lonDeg) {
    const la = latDeg * D2R, lo = lonDeg * D2R;
    return [Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)];
  };

  // mat3 (column-major) mapping view-space vectors to Earth-fixed ones such that the sub-viewer
  // point is (lat, lon), north is up (rotated by roll degrees, positive = counter-clockwise).
  E.viewToEarth = function (latDeg, lonDeg, rollDeg, out) {
    out = out || new Float32Array(9);
    const c = E.earthPos(latDeg, lonDeg);
    // up = north projected
    let ux = -c[1] * c[0], uy = 1 - c[1] * c[1], uz = -c[1] * c[2];
    let l = Math.hypot(ux, uy, uz);
    if (l < 1e-6) { ux = 1; uy = 0; uz = 0; l = 1; }
    ux /= l; uy /= l; uz /= l;
    // right = up x c
    let rx = uy * c[2] - uz * c[1], ry = uz * c[0] - ux * c[2], rz = ux * c[1] - uy * c[0];
    const a = (rollDeg || 0) * D2R, ca = Math.cos(a), sa = Math.sin(a);
    // rotate the (right, up) basis around c
    const r2 = [rx * ca + ux * sa, ry * ca + uy * sa, rz * ca + uz * sa];
    const u2 = [-rx * sa + ux * ca, -ry * sa + uy * ca, -rz * sa + uz * ca];
    out[0] = r2[0]; out[1] = r2[1]; out[2] = r2[2];
    out[3] = u2[0]; out[4] = u2[1]; out[5] = u2[2];
    out[6] = c[0]; out[7] = c[1]; out[8] = c[2];
    return out;
  };

  E.params = function () {
    const p = Object.assign({}, DEFAULTS);
    p.center = DEFAULTS.center.slice();
    p.light = DEFAULTS.light.slice();
    p.atmo = DEFAULTS.atmo.slice();
    p.atmoB = DEFAULTS.atmoB.slice();
    p.impacts = [];
    return p;
  };

  // mid/low tiers (phones) compile a lighter variant
  const tierDefs = (tier) => (tier === 'high' ? '#define OCT_HI 4\n' : '#define LITE 1\n#define OCT_HI 3\n');
  function compile(gl, tier) {
    const fs = U.glsl.frag(tierDefs(tier) + platesGlsl() + FS_BODY);
    return U.gl.program(gl, U.gl.FULLSCREEN_VS, fs, 'earth');
  }

  // Render the bake shader into a mipmapped equirect texture (in horizontal strips, so a slow
  // GPU never sees one huge draw). `hdr` only once caps.hdr says RGBA16F is renderable: the
  // engine checked that at boot, and asking again here would wait behind the shader compiles.
  // Leaves the viewport to whoever draws next.
  function bake(gl, prog, mode, W, H, hdr) {
    prog.use(); // (throws before any state changes if the shader failed)
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (hdr) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, W, H, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
    gl.viewport(0, 0, W, H);
    gl.enable(gl.SCISSOR_TEST);
    prog.setAll({ uSize: [W, H], uMode: mode, uOne: 1 });
    const strip = 128;
    for (let y = 0; y < H; y += strip) {
      gl.scissor(0, y, W, Math.min(strip, H - y));
      U.gl.drawFullscreen(gl);
    }
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    const aniso = U.gl.anisotropy(gl);
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.ext.TEXTURE_MAX_ANISOTROPY_EXT, aniso.max);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }

  // Init is laid out for KHR_parallel_shader_compile: every program is issued up front, the CPU
  // texture builds then run in short slices (the page stays responsive while the driver compiles
  // in parallel), and the GPU work waits until the programs report that they have linked.
  const SLICE_MS = 6;
  const pause = () => new Promise((r) => setTimeout(r, 0));
  async function sliced(gen) {
    let t0 = performance.now();
    for (;;) {
      const r = gen.next();
      if (r.done) return r.value;
      if (performance.now() - t0 > SLICE_MS) { await pause(); t0 = performance.now(); }
    }
  }
  // Without the extension this returns at once and the first use() links synchronously, as before.
  const linked = (gl, progs) => U.gl.compiled(gl, progs);

  E.init = function (gl, ctx) {
    if (E._ready) return E._ready;
    E._ready = (async () => {
      const tier = (ctx && ctx.tier) || 'high';
      const caps = (ctx && ctx.caps) || U.gl.caps || {};
      const fallback = () => U.gl.program(gl, U.gl.FULLSCREEN_VS, U.glsl.frag(tierDefs(tier) + FALLBACK_PLATES + FS_BODY), 'earth-fallback');
      // 1) all programs first (the plate GLSL is static, so the main shader need not wait for the data)
      const bakeProg = U.gl.program(gl, U.gl.FULLSCREEN_VS, U.glsl.frag(BAKE_FS), 'earth-bake');
      let main = null, platesMain = false;
      if (U.plates && U.plates.ready) {
        try { main = compile(gl, tier); platesMain = true; } // an older util.js throws compile errors right here
        catch (err) { console.warn('[earth] plate shader failed, using procedural continents', err); }
      }
      if (!main) main = fallback();
      // 2) CPU texture builds, sliced, while the driver compiles. No GL calls meanwhile: a
      //    synchronous one (a new getExtension, getParameter) would wait for the compiler.
      const city = await sliced(cityTextureGen(gl, tier));
      const biome = await sliced(biomeTextureGen(gl));
      await linked(gl, [bakeProg]);
      // 3) uploads and GPU bakes
      E.cityTex = U.gl.texture(gl, city[0], city[1]);
      await pause();
      E.biomeTex = U.gl.texture(gl, biome[0], biome[1]);
      await pause();
      const W = tier === 'high' ? 2048 : 1024, H = W / 2;
      E.cloudTex = bake(gl, bakeProg, 0, W, H, false);
      await pause();
      E.terrainTex = bake(gl, bakeProg, 1, W, H, !!caps.hdr);
      gl.deleteProgram(bakeProg.program);
      await pause();
      // 4) plate atlas + the main program (a failure on either falls back to procedural continents)
      E.hasPlates = false;
      if (platesMain) {
        try {
          await U.plates.ready;
          E.atlas = await U.plates.createAtlas(gl);
          await linked(gl, [main]);
          void main.uniforms; // finalize: throws here if the shader failed
          E.prog = main;
          E.hasPlates = true;
        } catch (err) {
          console.warn('[earth] plate data unavailable, using procedural continents', err);
          gl.deleteProgram(main.program);
          main = fallback();
        }
      }
      if (!E.hasPlates) {
        await linked(gl, [main]);
        E.prog = main;
      }
    })();
    return E._ready;
  };

  const _v2e = new Float32Array(9);
  const _impA = new Float32Array(MAX_IMP * 4), _impB = new Float32Array(MAX_IMP * 4);
  const _cyc = new Float32Array(12);
  const _clr = new Float32Array(12);
  const _id3 = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

  E.render = function (gl, s, P) {
    const prog = E.prog;
    if (!prog) return;
    prog.use();
    const L = P.light, ll = Math.hypot(L[0], L[1], L[2]) || 1;
    const view = P.view || E.viewToEarth(P.lat, P.lon, P.roll, _v2e);
    let n = 0;
    for (const im of P.impacts) {
      if (n >= MAX_IMP) break;
      _impA.set([im.pos[0], im.pos[1], im.pos[2], im.age], n * 4);
      _impB.set([im.size || 0.05, im.energy == null ? 1 : im.energy, im.kind || 0, 0], n * 4);
      n++;
    }
    _cyc.fill(0);
    if (P.cyclones) P.cyclones.slice(0, 3).forEach((c, i) => _cyc.set(c, i * 4));
    _clr.fill(0);
    const clrA = [0, 0, 0, 0];
    if (P.clear) P.clear.slice(0, 3).forEach((c, i) => { _clr.set([c.pos[0], c.pos[1], c.pos[2], c.radius], i * 4); clrA[i] = c.strength; });
    const moon = P.moon, ring = P.ring;
    const ct = P.cloudTime == null ? s.T : P.cloudTime;
    prog.setAll({
      uRes: [s.width, s.height],
      uTime: s.T, uCloudTime: ct, uMa: P.ma,
      uCam: [P.center[0], P.center[1], P.radius, 2 * Math.tan((P.fov * D2R) / 2)],
      uV2E: view, uSky: P.sky || _id3,
      uL: [L[0] / ll, L[1] / ll, L[2] / ll], uSun: P.sun,
      uLava: [P.magma, P.crust, P.crackGlow, P.lavaHeat],
      uWater: [P.sea, P.seaOn, E.hasPlates ? P.plateMix : 0, P.murk],
      uClouds: [P.cloud, P.cloudAlpha, P.storm, P.lightning],
      uCloudP: [P.cloudEvolve == null ? 0.5 - 0.5 * Math.cos(ct * 0.045) : P.cloudEvolve, P.cirrus, P.cloudShadow, P.landClear],
      uClr: _clr, uClrA: clrA,
      uAtmo: [P.atmo[0], P.atmo[1], P.atmo[2], P.atmoStrength],
      uAtmoB: [P.atmoB[0], P.atmoB[1], P.atmoB[2], P.oxy],
      uAtmo2: [P.atmoHeight, P.haze, P.flashTint, P.glint],
      uExtra: [P.deepShelf, P.lifeBloom, 0, 0],
      uSurf: [P.iceLine, P.green, P.life, P.today],
      uMisc: [P.city, P.stars, P.rust, P.basalt],
      uImp: _impA, uImpB: _impB, uImpN: n,
      uMoon: moon ? [moon.pos[0], moon.pos[1], moon.pos[2], moon.radius] : [0, 0, -100, 0],
      uMoonB: moon ? [moon.amount == null ? 1 : moon.amount, moon.glow || 0, moon.smooth || 0, 0] : [0, 0, 0, 0],
      uRing: ring ? [ring.opacity, ring.inner, ring.outer, ring.glow || 0] : [0, 0, 0, 0],
      uRingN: ring ? ring.normal : [0, 1, 0],
      uCyc: _cyc,
      uCityTex: 0, uBiomeTex: 1, uCloudTex: E.CLOUD_UNIT, uTerrTex: E.TERRAIN_UNIT, uSkyTex: E.SKY_UNIT, uSkyPass: 0,
    });
    U.gl.bindTexture(gl, 0, E.cityTex);
    U.gl.bindTexture(gl, 1, E.biomeTex);
    U.gl.bindTexture(gl, E.CLOUD_UNIT, E.cloudTex);
    U.gl.bindTexture(gl, E.TERRAIN_UNIT, E.terrainTex);
    if (E.hasPlates) U.plates.bind(prog, Math.min(Math.max(P.ma, 0), U.plates.maxMa), E.PLATE_UNIT);
    // star-field cache: a pure function of the render size and the camera
    const skyKey = s.width + 'x' + s.height + '|' + P.center[0] + ',' + P.center[1] + '|' + P.fov + '|' + (P.sky ? Array.prototype.join.call(P.sky, ',') : '');
    if (!E.skyT || E.skyKey !== skyKey) {
      if (!E.skyT || E.skyT.w !== s.width || E.skyT.h !== s.height) {
        if (E.skyT) U.gl.deleteTarget(gl, E.skyT);
        E.skyT = U.gl.target(gl, s.width, s.height, { hdr: true, filter: 'nearest' });
      }
      U.gl.bindTexture(gl, E.SKY_UNIT, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, E.skyT.fb);
      gl.viewport(0, 0, s.width, s.height);
      prog.set('uSkyPass', 1);
      U.gl.drawFullscreen(gl);
      prog.set('uSkyPass', 0);
      s.bindOutput();
      E.skyKey = skyKey;
    }
    U.gl.bindTexture(gl, E.SKY_UNIT, E.skyT.tex);
    U.gl.drawFullscreen(gl);
  };
})();
