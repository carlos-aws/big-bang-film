// Scene 'milkyway' (T 60-77): the Milky Way, a dive into the Orion Spur, a stellar nursery, the
// supernova whose shock compresses the molecular cloud that becomes the solar nebula.
//
// One continuous world. Galaxy frame: unit ~ galaxy radius, disk in the xz plane, y = north.
// Local frame (nebula): unit LU galaxy units, centred on the hero molecular cloud, axes aligned
// with the camera at the supernova (x right, y up, z toward the viewer).
//
// Passes (all a pure function of time):
//   0. (init) bake the galaxy surface maps (old stars, young stars, dust, HII) into a 2D texture
//   1. "far" point particles (galaxy stars + local stars beyond the hero cloud), full resolution
//   2. volume pass at reduced resolution (MRT): nebula + shock + galaxy disk/bulge emission,
//      transmittances
//   3. full-resolution composite: upsampled volume, distant star layers, the massive star;
//      blended as dst * T_nebula + emission
//   4. "near" particles (in front of the hero cloud)
(function () {
  'use strict';
  const U = window.U;
  const M = U.math;
  const DEG = Math.PI / 180;

  // ------------------------------------------------------------------ world constants
  const OMEGA = 0.045; // galaxy rotation as seen by the camera (rad/s), trailing arms
  const PT_R = 0.62; // Orion Spur target radius
  const PT_TH = 74 * DEG; // Orion Spur target azimuth (galaxy frame, theta = atan(z, x))
  const LU = 0.0125; // local (nebula) unit in galaxy units
  const PT = [PT_R * Math.cos(PT_TH), 0.0, PT_R * Math.sin(PT_TH)];
  const S_LOC = [-0.66, 0.4, -0.12]; // the massive star (local units)
  const MAP_EXT = 1.2; // galaxy map covers xz in [-MAP_EXT, MAP_EXT]^2
  const MW_DBG = '';

  // ------------------------------------------------------------------ helpers
  // Monotone cubic (Fritsch-Carlson) through [[x, y], ...]; linear end slopes (keeps moving).
  function mono(keys) {
    const n = keys.length, xs = keys.map((k) => k[0]), ys = keys.map((k) => k[1]);
    const d = [], m = [];
    for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) {
      if (d[i - 1] * d[i] <= 0) m[i] = 0;
      else {
        const h0 = xs[i] - xs[i - 1], h1 = xs[i + 1] - xs[i];
        const w1 = 2 * h1 + h0, w2 = h1 + 2 * h0;
        m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
      }
    }
    return function (x) {
      if (x <= xs[0]) return ys[0] + m[0] * (x - xs[0]);
      if (x >= xs[n - 1]) return ys[n - 1] + m[n - 1] * (x - xs[n - 1]);
      let i = 0;
      while (x > xs[i + 1]) i++;
      const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
      return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] +
        (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
    };
  }
  const v3 = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
    mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    len: (a) => Math.hypot(a[0], a[1], a[2]),
    norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
    mix: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
  };
  function xform(m, p) { // column-major mat4 * vec4(p, 1)
    return [
      m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
      m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
      m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
      m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15],
    ];
  }

  // ------------------------------------------------------------------ camera path (global T)
  // Orbit parameters around a look-at point: distance D (log), elevation eps, azimuth alpha.
  const kLogD = mono([
    [60, Math.log(3.45)], [62, Math.log(3.3)], [63.5, Math.log(2.6)], [65, Math.log(1.3)],
    [66.2, Math.log(0.32)], [67.2, Math.log(0.08)], [68.4, Math.log(4.4 * LU)],
    [70, Math.log(2.9 * LU)], [73.5, Math.log(2.0 * LU)], [77, Math.log(1.5 * LU)],
  ]);
  const kEps = mono([[60, 30], [62, 31], [63.8, 38], [65.2, 30], [66.4, 15], [67.6, 6], [70, 3.5], [77, 1.5]]);
  const kAlpha = mono([[60, 0], [62, 0.6], [64, 4], [66, 13], [68, 21], [70, 24], [77, 31]]);
  const kLook = mono([[60, 0], [63.2, 0], [64.6, 0.3], [65.8, 0.8], [66.8, 1], [77, 1]]);
  const kFov = mono([[60, 40], [63, 40], [65.5, 44], [67.5, 54], [70, 56], [77, 52]]);
  // Look-at offset in local units (applied once the look-at has reached the target).
  const kLookOffX = mono([[66, 0.25], [70, 0.06], [77, 0.0]]);
  const kLookOffY = mono([[66, 0.05], [70, 0.03], [77, 0.0]]);
  // Portrait: around the supernova the frame pans toward the star so the young remnant and the
  // globule both sit inside the narrow width (and less of the dust bank fills the bottom). Back
  // to zero before the hand-off at 75, so hand-off 5 is identical in every orientation.
  function portraitOff(T, aspect) {
    const w = M.smoothstep(1.0, 0.6, aspect) * M.smoothstep(68.0, 69.6, T) * (1 - M.smoothstep(72.3, 74.8, T));
    return [-0.55 * w, 0.2 * w];
  }

  // Integral of the "unlocked" fraction: the galaxy rotates in front of the camera early on;
  // the camera gradually co-rotates while it dives into the disk.
  const LOCK_A = 63, LOCK_B = 67.5;
  function unlockedTime(T) {
    const w = LOCK_B - LOCK_A;
    let s = 0;
    if (T > LOCK_A) {
      const u = M.clamp((T - LOCK_A) / w, 0, 1);
      s = w * (u * u * u - 0.5 * u * u * u * u) + Math.max(0, T - LOCK_B);
    }
    return (T - 60) - s;
  }
  function orbitDir(alpha, eps) {
    return [Math.cos(eps) * Math.sin(alpha), Math.sin(eps), Math.cos(eps) * Math.cos(alpha)];
  }
  const alphaAt = (T) => kAlpha(T) * DEG + OMEGA * unlockedTime(T);

  // Local frame: camera orientation at the supernova cue.
  let LF = null;
  function localFrame(Tref) {
    const dir = orbitDir(alphaAt(Tref), kEps(Tref) * DEG);
    const F = v3.mul(dir, -1);
    const R = v3.norm(v3.cross(F, [0, 1, 0]));
    const Up = v3.cross(R, F);
    return { R, U: Up, Z: dir };
  }
  const toGal = (pl) => v3.add(PT, v3.mul(v3.add(v3.add(v3.mul(LF.R, pl[0]), v3.mul(LF.U, pl[1])), v3.mul(LF.Z, pl[2])), LU));
  const toLocalDir = (d) => [v3.dot(d, LF.R), v3.dot(d, LF.U), v3.dot(d, LF.Z)];

  function cameraAt(T, aspect) {
    const D = Math.exp(kLogD(T));
    const eps = kEps(T) * DEG, alpha = alphaAt(T);
    const lm = M.clamp(kLook(T), 0, 1);
    const po = portraitOff(T, aspect);
    const offL = [kLookOffX(T) + po[0], kLookOffY(T) + po[1], 0];
    const target = v3.mix([0, 0, 0], toGal(offL), lm);
    const dir = orbitDir(alpha, eps);
    const eye = v3.add(target, v3.mul(dir, D));
    const F = v3.mul(dir, -1);
    const R = v3.norm(v3.cross(F, [0, 1, 0]));
    const Up = v3.cross(R, F);
    return { eye, F, R, U: Up, D, fov: kFov(T) * DEG, target };
  }

  // ------------------------------------------------------------------ GLSL
  // Tileable 3D noise volume (period 8 in lookup units): R = noise, G = fbm, B = ridged, A = low noise
  const NOISE_GEN_FS = `
in vec2 vUv; out vec4 o;
uniform float uZ, uN;
vec3 pgrad(ivec3 c, int period, uint seed) {
  ivec3 w = ((c % period) + period) % period;
  uint h = uhash(uvec3(w) + uvec3(seed * 7919u, seed * 104729u, seed * 1299709u));
  uint h2 = uhash(h ^ 0x9e3779b9u);
  float z = float(h & 0xffffu) / 65535.0 * 2.0 - 1.0;
  float a = float(h2 & 0xffffu) / 65535.0 * TAU;
  float s = sqrt(max(0.0, 1.0 - z * z));
  return vec3(s * cos(a), s * sin(a), z);
}
float pnoise(vec3 p, int period, uint seed) {
  vec3 i = floor(p), f = p - i;
  ivec3 c = ivec3(i);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = dot(pgrad(c, period, seed), f);
  float n100 = dot(pgrad(c + ivec3(1, 0, 0), period, seed), f - vec3(1, 0, 0));
  float n010 = dot(pgrad(c + ivec3(0, 1, 0), period, seed), f - vec3(0, 1, 0));
  float n110 = dot(pgrad(c + ivec3(1, 1, 0), period, seed), f - vec3(1, 1, 0));
  float n001 = dot(pgrad(c + ivec3(0, 0, 1), period, seed), f - vec3(0, 0, 1));
  float n101 = dot(pgrad(c + ivec3(1, 0, 1), period, seed), f - vec3(1, 0, 1));
  float n011 = dot(pgrad(c + ivec3(0, 1, 1), period, seed), f - vec3(0, 1, 1));
  float n111 = dot(pgrad(c + ivec3(1, 1, 1), period, seed), f - vec3(1, 1, 1));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
void main() {
  vec3 p = vec3(gl_FragCoord.xy, uZ) / uN;
  float a = pnoise(p * 8.0, 8, 1u);
  float f = pnoise(p * 8.0, 8, 2u) * 0.62 + pnoise(p * 16.0, 16, 3u) * 0.38;
  float r1 = 1.0 - abs(pnoise(p * 8.0, 8, 4u) * 1.6);
  float r2 = 1.0 - abs(pnoise(p * 16.0, 16, 5u) * 1.6);
  float rg = (r1 * r1 * 0.62 + r2 * r2 * 0.38);
  float b = pnoise(p * 4.0, 4, 6u);
  o = vec4(clamp(a * 0.85 + 0.5, 0.0, 1.0), clamp(f * 1.0 + 0.5, 0.0, 1.0), clamp(rg, 0.0, 1.0), clamp(b * 0.85 + 0.5, 0.0, 1.0));
}`;

  const SPIRAL = `
const float GR0 = 0.21;  // arms start at the bar ends
const float GPB = 0.287; // tan(16 deg) arm pitch
const float SPB = 0.45;  // spur pitch
const float MAP_EXT = ${MAP_EXT.toFixed(3)};
uniform highp sampler3D uNoise;
uniform vec2 uSpur;   // (theta, radius) of the Orion Spur target
vec4 nz(vec3 p) { return textureLod(uNoise, p * 0.125, 0.0); }
float wrapPi(float a) { return a - TAU * floor((a + PI) / TAU); }
`;

  // Galaxy surface maps, baked once: (old stars, young stars, dust column, HII)
  const MAP_FS = `
in vec2 vUv; out vec4 o;
uniform float uInvK;
${SPIRAL}
void main() {
  vec2 xz = (vUv * 2.0 - 1.0) * MAP_EXT;
  float r = length(xz);
  float th = atan(xz.y, xz.x);
  vec4 nA = nz(vec3(xz * 1.3, 0.37));
  vec4 nB = nz(vec3(xz * 4.1, 2.71));
  vec4 nC = nz(vec3(xz * 11.0, 5.13));
  vec4 nD = nz(vec3(xz * 27.0, 3.91));
  float warp = (nA.r - 0.5) * 0.5 + (nB.r - 0.5) * 0.16;
  float lr = log(max(r, 0.03) / GR0) / GPB;
  float minor = 0.45 * smoothstep(0.28, 0.5, r);
  float aS = 0.0, aY = 0.0, aD = 0.0, aH = 0.0;
  for (int m = 0; m < 4; m++) {
    float amp = (m & 1) == 0 ? 1.0 : minor;
    float psi = wrapPi(th - float(m) * 1.5707963 - lr + warp);
    // gas enters each arm from +psi: dust lane, then HII, then the young stars drift downstream
    float py = psi + 0.06;
    aS += amp * exp(-psi * psi * 3.0);
    aY += amp * exp(-py * py * 12.0);
    float pd = psi - 0.17; aD += amp * exp(-pd * pd * 110.0);
    float ph = psi - 0.07; aH += amp * exp(-ph * ph * 90.0);
  }
  // the Orion Spur: a short, more open arm segment through the target
  float ps = wrapPi(th - uSpur.x - log(max(r, 0.03) / uSpur.y) / SPB);
  float sw = exp(-pow((r - uSpur.y) / 0.12, 2.0));
  aS += 0.3 * sw * exp(-ps * ps * 8.0);
  aY += 0.55 * sw * exp(-ps * ps * 40.0);
  float pds = ps - 0.1; aD += 0.6 * sw * exp(-pds * pds * 200.0);
  float phs = ps - 0.04; aH += 0.6 * sw * exp(-phs * phs * 150.0);

  float armEnv = smoothstep(0.12, 0.26, r) * (1.0 - smoothstep(0.8, 1.12, r));
  float disk = exp(-r / 0.3);
  float dustEnv = smoothstep(0.06, 0.16, r) * (1.0 - smoothstep(0.85, 1.12, r));
  float lane = dustEnv * aD * (0.35 + 1.3 * nC.b);
  float dust = lane * 2.0 + dustEnv * (0.15 * aS + 0.04) * (0.3 + 1.4 * nC.b * nB.b);
  // bar dust lanes (leading edges of the bar; the bar lies along x)
  float side = xz.x >= 0.0 ? 1.0 : -1.0;
  float bl = exp(-pow((xz.y - side * 0.035 - xz.x * 0.12) / 0.012, 2.0)) * smoothstep(0.24, 0.14, abs(xz.x)) * smoothstep(0.02, 0.07, abs(xz.x));
  dust += bl * 0.9 * (0.4 + nC.b);
  float lm = clamp(lane, 0.0, 1.0);
  float oldS = disk * (0.4 + 0.6 * aS * armEnv) * (1.0 - 0.25 * lm);
  float young = armEnv * smoothstep(0.2, 0.36, r) * aY * (0.3 + 1.4 * nB.g * nB.g) * (0.3 + 1.4 * nA.g) * (1.0 - 0.7 * lm) * (0.5 + 0.9 * nD.g);
  float hii = armEnv * aH * pow(clamp(nD.g * 2.2 - 0.95, 0.0, 1.0), 2.0) * smoothstep(0.22, 0.38, r);
  float edge = 1.0 - smoothstep(1.06, 1.18, r);
  o = vec4(oldS, young, dust, hii) * edge * uInvK;
}`;

  // Arm warp (low frequency), baked once; encoded 0.5 + warp / 2.
  const WARP_FS = `
in vec2 vUv; out vec4 o;
${SPIRAL}
void main() {
  vec2 xz = (vUv * 2.0 - 1.0) * MAP_EXT;
  float w = (nz(vec3(xz * 1.3, 0.37)).r - 0.5) * 0.5 + (nz(vec3(xz * 4.1, 2.71)).r - 0.5) * 0.16;
  o = vec4(0.5 + 0.5 * w, 0.0, 0.0, 1.0);
}`;

  // Shared galaxy lookups (particles and volume).
  const GALMAP = `
${SPIRAL}
uniform sampler2D uMap, uWarp;
uniform float uCoreK;       // central bulge dimming (hidden behind disk dust from inside)
uniform float uKnot, uMapK; // uKnot: galaxy-scale stand-in for the nebula (fades as the real one appears)
float galWarp(vec2 xz) {
  return textureLod(uWarp, xz * (0.5 / MAP_EXT) + 0.5, 0.0).r * 2.0 - 1.0;
}
vec4 gmap(vec2 xz, float lod) {
  vec4 m = textureLod(uMap, xz * (0.5 / MAP_EXT) + 0.5, lod) * uMapK;
  vec2 dk = xz - uSpur.y * vec2(cos(uSpur.x), sin(uSpur.x));
  m.w += uKnot * exp(-dot(dk, dk) / 0.00008);
  return m;
}
float Fexp(float y, float h) { return 0.5 * sign(y) * (1.0 - exp(-abs(y) / h)); }
// Mean of the normalised exponential profile exp(-|y|/h)/(2h) over a straight segment y0..y1.
float segAvg(float y0, float y1, float h) {
  float dy = y1 - y0;
  if (abs(dy) < 2e-3 * h) return exp(-abs(0.5 * (y0 + y1)) / h) / (2.0 * h);
  return (Fexp(y1, h) - Fexp(y0, h)) / dy;
}
const float HD = 0.007; // dust scale height
const float KD = 3.2;   // dust opacity per unit column
`;

  const GAL_VS = `
uniform mat4 uVP;
uniform vec3 uEye;
uniform float uTime, uExpo, uEps2, uPx, uFocalPx, uSplit, uOmega, uMaxPt, uNearCut;
uniform int uPass;
uniform ivec4 uRange; // cumulative ends: bulge, disk, arms, hii
out vec3 vCol;
out float vSig, vSize;
${GALMAP}
vec2 gauss2(int id, int salt) {
  float u1 = max(hashI(id, salt), 1e-7), u2 = hashI(id, salt + 1);
  return sqrt(-2.0 * log(u1)) * vec2(cos(TAU * u2), sin(TAU * u2));
}
vec3 armPos(float r, float m, float psi, float y) {
  float th0 = m * 1.5707963 + log(max(r, 0.03) / GR0) / GPB + psi;
  vec2 xz = r * vec2(cos(th0), sin(th0));
  float th = th0 - galWarp(xz);
  return vec3(r * cos(th), y, r * sin(th));
}
vec3 spurPos(float r, float psi, float y) {
  float th = uSpur.x + log(max(r, 0.03) / uSpur.y) / SPB + psi;
  return vec3(r * cos(th), y, r * sin(th));
}
float pickArm(float h, float r) {
  float m = h < 0.38 ? 0.0 : h < 0.76 ? 2.0 : h < 0.88 ? 1.0 : 3.0;
  if (r < 0.32 && (m == 1.0 || m == 3.0)) m -= 1.0;
  return m;
}
void main() {
  int id = gl_VertexID;
  vec3 pos; vec3 col; float lum; float ext = 0.0; // ext: physical radius (extended sources)
  float diffK = 0.0; // differential rotation factor
  if (id < uRange.x) {
    // bulge + bar (bar along x)
    vec2 g1 = gauss2(id, 3), g2 = gauss2(id, 5);
    if (hashI(id, 7) < 0.45) {
      pos = vec3(g1.x * 0.1, g2.x * 0.024, g1.y * 0.036);
    } else {
      vec3 d = normalize(vec3(g1, g2.x) + 1e-4);
      float rr = -log(max(hashI(id, 9), 1e-6)) * 0.055;
      pos = d * rr * vec3(1.0, 0.7, 1.0);
    }
    float h = hashI(id, 13);
    col = blackbody(mix(3300.0, 5600.0, h * h));
    lum = 0.32 * (0.3 + 6.0 * pow(hashI(id, 17), 9.0)) * uCoreK;
  } else if (id < uRange.y) {
    // old disk
    float u1 = max(hashI(id, 3), 1e-6), u2 = max(hashI(id, 4), 1e-6);
    float r = -0.3 * log(u1 * u2);
    if (r > 1.15) r = 0.2 + fract(r * 3.71) * 0.9; // fold the tail back (no edge ring)
    float y = (hashI(id, 6) < 0.5 ? -1.0 : 1.0) * -log(max(hashI(id, 8), 1e-6)) * 0.02;
    if (hashI(id, 5) < 0.42 && r > 0.18) {
      pos = armPos(r, pickArm(hashI(id, 10), r), gauss2(id, 11).x * 0.36, y);
    } else {
      float th = TAU * hashI(id, 12);
      pos = vec3(r * cos(th), y, r * sin(th));
    }
    diffK = 1.0;
    float h = hashI(id, 13);
    col = blackbody(mix(4300.0, 7000.0, h));
    lum = 0.12 * (0.3 + 4.0 * pow(hashI(id, 17), 12.0));
  } else if (id < uRange.z) {
    // young arm stars, many in clusters, just downstream of the dust lanes
    int k = id - uRange.y;
    int cl = k / 24;
    float hs = hashI(id, 30);
    float r, m, psi, y;
    bool spur = hashI(cl, 41) < 0.07;
    if (hs < 0.45) {
      r = 0.22 + -0.33 * log(max(hashI(id, 31), 1e-6));
      m = pickArm(hashI(id, 32), r);
      psi = -0.06 + gauss2(id, 33).x * 0.2;
      y = gauss2(id, 35).x * 0.006;
    } else {
      r = 0.22 + -0.33 * log(max(hashI(cl, 31), 1e-6));
      m = pickArm(hashI(cl, 32), r);
      psi = -0.06 + gauss2(cl, 33).x * 0.11;
      float cs = mix(0.002, 0.009, hashI(cl, 37));
      vec2 go = gauss2(id, 38);
      r += go.x * cs;
      psi += go.y * cs / max(r, 0.1) * 0.6;
      y = gauss2(id, 35).x * 0.003 + gauss2(cl, 39).x * 0.003;
    }
    if (r > 1.1) r = 0.3 + fract(r * 7.13) * 0.7;
    if (spur) {
      float rs = uSpur.y + gauss2(cl, 43).x * 0.06 + gauss2(id, 44).x * 0.006;
      pos = spurPos(rs, gauss2(id, 45).x * 0.06, y);
    } else {
      pos = armPos(r, m, psi, y);
    }
    float h = hashI(id, 13);
    col = h < 0.05 ? blackbody(3900.0) : blackbody(mix(9000.0, 30000.0, pow(hashI(id, 14), 0.7)));
    lum = 0.3 * (0.3 + 9.0 * pow(hashI(id, 17), 9.0));
    if (h < 0.05) lum *= 2.0;
    diffK = 0.12;
  } else if (id < uRange.w) {
    // HII regions (small pink knots) between the dust lanes and the young stars
    int k = id - uRange.z;
    int cl = k / 16;
    float r = 0.3 + -0.3 * log(max(hashI(cl, 51), 1e-6));
    if (r > 1.0) r = 0.35 + fract(r * 5.31) * 0.6;
    float m = pickArm(hashI(cl, 52), r);
    float psi = 0.07 + gauss2(cl, 53).x * 0.03;
    vec2 go = gauss2(id, 54);
    float cs = mix(0.0015, 0.005, hashI(cl, 55));
    r += go.x * cs;
    psi += go.y * cs / r;
    pos = armPos(r, m, psi, gauss2(id, 56).x * 0.002);
    col = mix(vec3(1.0, 0.2, 0.42), vec3(1.0, 0.4, 0.6), hashI(id, 57));
    lum = 0.6 * (0.3 + hashI(id, 58));
    ext = mix(0.001, 0.0028, hashI(id, 59));
    diffK = 0.1;
  } else {
    // halo stars and globular clusters
    vec2 g1 = gauss2(id, 3), g2 = gauss2(id, 5);
    bool glob = hashI(id, 61) < 0.06;
    vec3 d = normalize(vec3(g1, g2.x) + 1e-4);
    float rr = glob ? 0.15 + hashI(id, 62) * 0.9 : 0.1 - log(max(hashI(id, 63), 1e-6)) * 0.35;
    pos = d * rr;
    col = blackbody(mix(3800.0, 5500.0, hashI(id, 64)));
    lum = glob ? 0.35 : 0.05;
    ext = glob ? 0.0025 : 0.0;
  }
  // differential rotation (relative to the pattern frame), trailing direction -theta
  if (diffK > 0.0) {
    float rr = max(length(pos.xz), 0.08);
    float a = -uOmega * (0.72 / rr - 1.0) * uTime * 0.35 * diffK;
    pos.xz = mat2(cos(a), sin(a), -sin(a), cos(a)) * pos.xz;
  }
  vec3 rel = pos - uEye;
  float d = length(rel);
  bool keep = uPass == 0 || (uPass == 1 && d > uSplit) || (uPass == 2 && d <= uSplit);
  vec4 clip = uVP * vec4(rel, 1.0);
  if (!keep || clip.w <= 1e-6) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vCol = vec3(0.0); vSig = 1.0; vSize = 1.0;
    return;
  }
  // dust extinction between the particle and the camera
  vec4 mp = gmap(pos.xz, 0.0);
  float dy = uEye.y - pos.y;
  float colm;
  if (abs(dy) < 1e-3 * d) colm = d * exp(-abs(pos.y) / HD) / (2.0 * HD);
  else colm = (Fexp(uEye.y, HD) - Fexp(pos.y, HD)) / dy * d;
  float hd = length(rel.xz);
  float sig = mix(mp.z, 0.3 * smoothstep(0.07, 0.22, length(pos.xz)), smoothstep(0.02, 0.3, hd));
  vec3 tr = exp(-colm * sig * KD * 1.4 * vec3(0.78, 1.0, 1.3));
  tr *= exp(-max(mp.z - 0.3, 0.0) * 1.2 * vec3(0.8, 1.0, 1.25)); // embedded in the dust lanes
  float b = lum * uExpo / (d * d + uEps2);
  if (uNearCut > 0.0) b *= smoothstep(0.25 * uNearCut, uNearCut, d);
  float sg = 0.62 + 0.2 * log(1.0 + b * 0.5);
  if (ext > 0.0) {
    sg = max(sg, min(ext * uFocalPx / d, 4.0));
    b *= smoothstep(0.004, 0.04, d); // extended knots dissolve as the camera passes them
  }
  sg = min(sg, uMaxPt / 6.0);
  float size = min(ceil(sg * 4.8), uMaxPt);
  gl_Position = clip;
  gl_PointSize = size;
  vSig = sg; vSize = size;
  vCol = col * tr * b * uPx / (6.2831853 * sg * sg);
}`;

  const PT_FS = `
in vec3 vCol; in float vSig, vSize;
out vec4 o;
void main() {
  vec2 pc = (gl_PointCoord - 0.5) * vSize;
  float w = exp(-dot(pc, pc) / (2.0 * vSig * vSig));
  o = vec4(vCol * w, 1.0);
}`;

  // Local stars (nebula neighbourhood), in local units.
  const LOC_VS = `
uniform mat4 uVP;
uniform vec3 uEyeL, uS;
uniform float uExpo, uEps2, uPx, uSplit, uFade, uMaxPt;
uniform int uPass, uNField, uNCluster;
out vec3 vCol;
out float vSig, vSize;
vec2 gauss2(int id, int salt) {
  float u1 = max(hashI(id, salt), 1e-7), u2 = hashI(id, salt + 1);
  return sqrt(-2.0 * log(u1)) * vec2(cos(TAU * u2), sin(TAU * u2));
}
void main() {
  int id = gl_VertexID;
  vec3 pos, col; float lum;
  if (id < uNField) {
    vec2 g1 = gauss2(id, 3), g2 = gauss2(id, 5);
    vec3 d = normalize(vec3(g1, g2.x) + 1e-4);
    float rr = 0.8 + pow(hashI(id, 7), 0.6) * 26.0;
    pos = d * rr * vec3(1.0, 0.45, 1.0);
    float h = hashI(id, 13);
    col = blackbody(mix(3400.0, 12000.0, h));
    lum = 0.2 + 12.0 * pow(hashI(id, 17), 14.0);
  } else if (id < uNField + uNCluster) {
    // the young cluster around the massive star
    vec2 g1 = gauss2(id, 3), g2 = gauss2(id, 5);
    pos = uS + vec3(g1, g2.x) * vec3(0.22, 0.18, 0.22) * (0.4 + hashI(id, 8));
    col = blackbody(mix(9000.0, 30000.0, hashI(id, 13)));
    lum = 0.04 + 1.0 * pow(hashI(id, 17), 6.0);
  } else {
    // embedded young stellar objects (reddened, faint) in the nebula
    vec2 g1 = gauss2(id, 3), g2 = gauss2(id, 5);
    pos = vec3(-0.2, -0.1, -0.7) + vec3(g1, g2.x) * vec3(0.9, 0.6, 0.6);
    col = blackbody(mix(1800.0, 3200.0, hashI(id, 13)));
    lum = 0.03 + 0.25 * pow(hashI(id, 17), 4.0);
  }
  vec3 rel = pos - uEyeL;
  float d = length(rel);
  bool keep = uPass == 0 || (uPass == 1 && d > uSplit) || (uPass == 2 && d <= uSplit);
  vec4 clip = uVP * vec4(rel, 1.0);
  if (!keep || clip.w <= 1e-6) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vCol = vec3(0.0); vSig = 1.0; vSize = 1.0;
    return;
  }
  float b = lum * uExpo / (d * d + uEps2);
  b /= 1.0 + b / 120.0; // soft cap: a passing neighbour must not steal the shot
  float sg = 0.62 + 0.2 * log(1.0 + b * 0.5);
  sg = min(sg, uMaxPt / 6.0);
  float size = min(ceil(sg * 4.8), uMaxPt);
  gl_Position = clip;
  gl_PointSize = size;
  vSig = sg; vSize = size;
  vCol = col * b * uPx * uFade / (6.2831853 * sg * sg);
}`;

  // Volume pass (reduced resolution, two render targets).
  //   o0 = (emission, mean nebula transmittance)    o1 = (galaxy*nebula transmittance, T to the star)
  const VOL_FS = `
in vec2 vUv;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
uniform vec2 uRes;
uniform float uFocal;          // projection focal (short side)
uniform vec3 uEye, uCamR, uCamU, uCamF; // galaxy frame
uniform vec3 uEyeL;            // camera in local units
uniform mat3 uG2L;             // galaxy dir -> local dir
uniform float uInside, uNearFade, uNebOn, uHeroDt;
uniform int uGalSteps, uNebSteps;
uniform vec3 uS, uSdir;        // massive star (local), direction from the cloud
uniform float uShR, uShW, uShA, uShHot, uComp, uGlow, uSpin, uFlashL, uHot, uIon;
${GALMAP}

// --------------------------------------------------------------- galaxy
// Analytic line integral (from t = 0) of the anisotropic gaussian exp(-|p/s|^2); tc = closest approach.
float gaussLineA(vec3 ro, vec3 rd, vec3 s, out float tc) {
  vec3 a = ro / s, b = rd / s;
  float bb = dot(b, b), ab = dot(a, b);
  tc = -ab / bb;
  float m = max(dot(a, a) - ab * ab / bb, 0.0);
  float cover = 0.5 + 0.5 * tanh(tc * sqrt(bb) * 1.2);
  return 1.7725 * inversesqrt(bb) * exp(-m) * cover;
}
// Disk march (old + young stars, HII, dust); Tc = transmittance up to distance tcB.
vec3 galaxyMarch(vec3 ro, vec3 rd, float jit, float tcB, out vec3 Tout, out vec3 Tc) {
  Tout = vec3(1.0); Tc = vec3(1.0);
  const float H = 0.1, RC = 1.16;
  float t0 = 0.0, t1 = 1e4;
  if (abs(rd.y) < 1e-6) { if (abs(ro.y) > H) return vec3(0.0); }
  else {
    float ta = (-H - ro.y) / rd.y, tb = (H - ro.y) / rd.y;
    t0 = max(min(ta, tb), 0.0); t1 = max(ta, tb);
  }
  vec2 o2 = ro.xz, d2 = rd.xz;
  float a = dot(d2, d2), bq = dot(o2, d2), c = dot(o2, o2) - RC * RC;
  float disc = bq * bq - a * c;
  if (disc <= 0.0 || a < 1e-9) return vec3(0.0);
  float sq = sqrt(disc);
  t0 = max(t0, (-bq - sq) / a);
  t1 = min(t1, (-bq + sq) / a);
  t0 = max(t0, uNearFade * 0.25);
  if (t1 <= t0) return vec3(0.0);
  float k = clamp(log(1.0 + (t1 - t0) / (t0 + 0.01)) * 1.1, 0.0, 6.0);
  float ek = exp(k) - 1.0;
  vec3 C = vec3(0.0);
  vec3 T = vec3(1.0);
  const vec3 cOld = vec3(1.0, 0.74, 0.48);
  const vec3 cYoung = vec3(0.32, 0.52, 1.0);
  const vec3 cHii = vec3(1.0, 0.24, 0.45);
  float N = float(uGalSteps);
  float lxz = length(rd.xz);
  float texInv = float(textureSize(uMap, 0).x) / (2.0 * MAP_EXT);
  float tPrev = t0;
  bool tcDone = tcB < t0;
  for (int i = 0; i < 40; i++) {
    if (i >= uGalSteps) break;
    float x1 = (float(i) + 1.0) / N;
    float xs = (float(i) + jit) / N;
    float tb = k < 1e-3 ? mix(t0, t1, x1) : t0 + (t1 - t0) * (exp(k * x1) - 1.0) / ek;
    float ts = k < 1e-3 ? mix(t0, t1, xs) : t0 + (t1 - t0) * (exp(k * xs) - 1.0) / ek;
    float ta = tPrev; tPrev = tb;
    float ds = tb - ta;
    vec3 pa = ro + rd * ta, pb = ro + rd * tb, ps = ro + rd * ts;
    float rr = length(ps.xz);
    if (rr > RC) continue;
    float fe = segAvg(pa.y, pb.y, 0.024);
    float fy = segAvg(pa.y, pb.y, 0.009);
    float fd = segAvg(pa.y, pb.y, HD);
    // prefiltered map over the step's footprint (no speckle from undersampled dust lanes)
    vec4 mp = gmap(ps.xz, clamp(log2(max(ds * lxz, 1e-6) * texInv) - 0.3, 0.0, 7.0));
    float nf = smoothstep(0.0, uNearFade, ts);
    vec3 e = (mp.x * fe * 0.3 * cOld + mp.y * fy * 0.22 * cYoung + mp.w * fy * 0.6 * cHii) * nf;
    vec3 tau = vec3(0.78, 1.0, 1.3) * (mp.z * fd * KD * nf * ds);
    vec3 tr = exp(-tau);
    vec3 w = mix(vec3(ds), (1.0 - tr) / max(tau / ds, vec3(1e-5)), step(vec3(1e-4), tau));
    if (!tcDone && tcB < tb) { Tc = T * exp(-tau * clamp((tcB - ta) / ds, 0.0, 1.0)); tcDone = true; }
    C += T * e * w;
    T *= tr;
  }
  if (!tcDone) Tc = T;
  Tout = T;
  return C;
}

// --------------------------------------------------------------- nebula (local units)
const vec3 NC = vec3(-0.15, -0.15, -0.5);
const float NR = 2.7;
const vec3 GC = vec3(-0.35, 0.15, -1.1);
const vec3 cHa = vec3(1.0, 0.13, 0.3);
const vec3 cO3 = vec3(0.12, 0.8, 0.75);
const float HR = 0.62; // fine-step sphere around the hero cloud
// The hero globule: soft lobes (head, body, tapering tail, side lumps), domain-warped, its
// outskirts eroded into streamers combed away from the star. Outputs: rim = the thin ionised
// skin on its ragged edge, wisp = tenuous outskirts, lit = starlight reaching p (self-shadowed
// by the smooth lobe field), halo = photo-evaporation glow off the lit face, core = inner glow.
const float HRAD = 0.35;
// globule space: shrunk and flattened along the shock axis by the compression, slowly turning
vec3 heroQ(vec3 p) {
  vec3 a = uSdir;
  vec3 q = p / (1.0 - 0.35 * uComp);
  q += a * dot(q, a) * 0.45 * uComp;
  float cs = cos(uSpin), sn = sin(uSpin);
  q.xz = mat2(cs, sn, -sn, cs) * q.xz;
  return q;
}
// cometary head-and-tail radius: downstream of the star the cross-section tapers into a tail
// (the shock later folds it back onto the head)
vec3 heroQt(vec3 q, out float aq, out float tl, out vec3 pv) {
  vec3 a = uSdir;
  aq = dot(q, a);
  tl = max(-aq, 0.0) * (1.0 - 0.75 * uComp);
  pv = q - a * aq;
  return pv * (1.0 + tl * 1.6) + a * (aq + tl * 0.55);
}
// smooth coverage of the globule (light march only; no texture lookups): the opaque heart plus
// a little of the translucent envelope, so its inner layers sit in partial shadow
float heroBase(vec3 p) {
  float aq, tl; vec3 pv;
  float e = length(heroQt(heroQ(p), aq, tl, pv)) / (HRAD * mix(1.0, 1.12, uComp));
  return smoothstep(0.9, 0.45, e) + 0.12 * smoothstep(1.6, 0.8, e);
}
float heroCloud(vec3 p, out float rim, out float wisp, out float lit, out float halo, out float core) {
  rim = 0.0; wisp = 0.0; lit = 0.0; halo = 0.0; core = 0.0;
  float pp = dot(p, p);
  if (pp > 0.384) return 0.0;
  float sc = 1.0 - 0.35 * uComp;
  vec3 a = uSdir;
  vec3 q = heroQ(p);
  float aq, tl; vec3 pv;
  vec3 qt = heroQt(q, aq, tl, pv);
  float rq = length(qt);
  if (rq > 0.79) return 0.0;                     // beyond the widest envelope
  vec4 n = nz(q * 2.0 + vec3(3.1, 7.7, 1.9));
  vec3 qw = q + (n.rgb - 0.5) * 0.24;            // domain warp: swirling, sheared edges
  vec4 n2 = nz(qw * 5.5 + vec3(9.1, 2.3, 4.4));
  vec4 n3 = nz(qw * 13.0 + vec3(1.7, 5.3, 2.9));
  // streamer noise: stretched along the star axis (combed downstream), bent by the warp
  vec4 ns = nz(pv * (5.0 + 4.0 * tl) + a * (aq * 1.2) + (n.rgb - 0.5) * 0.7 + vec3(6.3, 0.7, 2.2));
  float Rn = HRAD * mix(1.0, 1.12, uComp);
  float rS = rq + (n.g - 0.5) * 0.3 * (1.0 - 0.4 * uComp) + (n2.b - 0.55) * 0.1;
  float e = rS / Rn;                             // 1 at the nominal surface
  float fade = smoothstep(0.62, 0.5, sqrt(pp));
  float fil = ns.b * 0.5 + n3.b * 0.25 + n2.g * 0.25;          // filament ridges (high = gas)
  float mu = dot(q, a) * inversesqrt(dot(q, q) + 1e-4);
  float lee = 1.0 - smoothstep(-0.3, 0.55, mu);                // downstream side (away from the star)
  // A cloud, not a rock: a smaller opaque heart whose boundary is eaten by the filament texture,
  // inside a broad translucent envelope (optical depth ~0.5-1 in the filaments, ~0.1 between
  // them) that is combed into streamers trailing away from the star. The darkness therefore
  // grades from black through reddened, half-transparent layers into the nebula behind.
  float ec = e + (0.56 - fil) * mix(0.7, 1.7, lee) * mix(1.0, 0.6, uComp) * smoothstep(0.2, 0.85, e);
  float dC = smoothstep(0.9, 0.42, ec);
  float filM = smoothstep(0.44, 0.8, fil);
  // (after the shock: stripped on the windward face first, then swept up into the compressed
  // heart, so by the hand-off only a thin skin of wisps is left around the collapsing core)
  float cE = uComp * uComp;
  float envR = smoothstep(mix(1.6 + 0.5 * lee, 1.2, cE), 0.62, e);
  float dE = envR * (0.1 + 0.9 * filM * filM) * (1.0 - dC) * mix(1.0, 0.25 + 0.35 * lee, cE);
  float dens = (dC * dC * (0.55 + 0.9 * n2.r) + dE * 0.32) * fade;
  // starlight reaching p: a short march toward the star through the smooth coverage
  vec3 ld = normalize(uS - p);
  float tauL = heroBase(p + ld * 0.035) * 0.07 + heroBase(p + ld * 0.11) * 0.1
             + heroBase(p + ld * 0.23) * 0.16 + heroBase(p + ld * 0.42) * 0.2;
  lit = exp(-tauL * 14.0 * (0.6 + 0.6 * n2.g));
  // ionised skin: a thin, knotted band on the heart's lit boundary plus the lit envelope
  // filaments (bright-rimmed wisps), so the light edge is broken rather than one crescent
  float band = dC * (1.0 - dC) * 4.0;
  rim = (band * (0.1 + 1.8 * smoothstep(0.48, 0.82, fil)) + dE * filM * filM * filM * 2.0) * lit * fade;
  wisp = (dE * 0.6 + dC * (1.0 - smoothstep(0.7, 1.0, dC))) * fade;
  // photo-evaporation glow streaming off the lit face (streaked along the star axis)
  float sb = ns.b * ns.b;
  halo = envR * (1.0 - dC) * lit * (1.0 - lee) * (0.05 + 1.4 * sb * sb) * fade;
  core = exp(-dot(q, q) / 0.025) + 0.08 * exp(-dot(q, q) / 0.1);
  return dens / (sc * sc * sc);
}
float pillar(vec3 p, vec3 base, vec3 tip, float r0, float r1, out float rimP) {
  rimP = 0.0;
  vec3 ax = tip - base;
  float h = clamp(dot(p - base, ax) / dot(ax, ax), 0.0, 1.0);
  vec3 ap = base + ax * h;
  vec3 dv = p - ap;
  float dist = length(dv);
  float rad = mix(r0, r1, h);
  if (dist > rad * 1.9 + 0.08) return 0.0;
  vec4 n = nz(p * 3.6 + vec3(1.3, 5.1, 8.2));
  float rr = rad * (0.5 + 0.95 * n.g) + (n.b - 0.6) * 0.07;
  float dd = dist - rr;
  float body = smoothstep(0.025, -0.04, dd);
  float fc = dot(dv / max(dist, 1e-4), normalize(uS - ap));
  rimP = smoothstep(0.025, -0.005, dd) * smoothstep(-0.05, -0.01, dd) * smoothstep(-0.2, 0.7, fc)
       + smoothstep(0.85, 1.0, h) * body * 0.4;
  return body;
}
// A soft, frayed dust streamer: a column flaring from r0 to r1 whose edges are eaten into wisps,
// translucent rather than solid; rimS = its edge facing the star.
float streamer(vec3 p, vec3 base, vec3 tip, float r0, float r1, out float rimS) {
  rimS = 0.0;
  vec3 ax = tip - base;
  float h = clamp(dot(p - base, ax) / dot(ax, ax), 0.0, 1.0);
  vec3 ap = base + ax * h;
  vec3 dv = p - ap;
  float dist = length(dv);
  float rad = mix(r0, r1, h * h);
  if (dist > rad * 1.8) return 0.0;
  vec4 n = nz(p * 4.2 + vec3(4.2, 0.9, 3.3));
  float x = dist / rad + (n.g - 0.5) * 0.9 + (n.b - 0.55) * 0.7;
  float body = smoothstep(1.15, 0.25, x) * (0.3 + 0.9 * n.r);
  float fc = dot(dv / max(dist, 1e-4), normalize(uS - ap));
  rimS = body * smoothstep(0.1, 0.9, fc) * smoothstep(0.35, 0.9, x);
  return body;
}
// Returns dust density; writes emission, the hero cloud's share of the dust and its inner glow.
float nebDensity(vec3 p, out vec3 emis, out float clD, out vec3 eCore) {
  vec3 dv = p - uS;
  float dS2 = dot(dv, dv);
  float dS = sqrt(dS2);
  vec4 n1 = nz(p * 0.85 + vec3(0.3, 0.1, 0.7));
  vec4 n2 = nz(p * 2.4 + vec3(5.2, 1.3, 7.7));
  float bnd = smoothstep(NR, NR * 0.55, length(p - NC) + (n1.a - 0.5) * 1.6);
  float illum = 1.0 / (1.0 + dS2 * 3.0);
  // ------- ionized gas: wind-blown cavity around the star, bright walls, filaments
  vec3 q = (p - GC) * vec3(0.4, 0.6, 0.8);
  float env = exp(-dot(q, q) * 1.3) * bnd;
  float f = n1.g * 0.42 + n2.b * 0.68;
  float gas = smoothstep(0.42, 0.95, f + 0.25 * env) * env;
  gas *= smoothstep(0.1, 0.45, dS) * (1.0 + 1.5 * exp(-pow((dS - 0.6) / 0.22, 2.0)));
  float swept = 0.0, front = 0.0;
  if (uShR > 0.0) {
    swept = smoothstep(uShR - 0.02, uShR - 0.3, dS);
    front = exp(-pow((dS - uShR) / 0.1, 2.0));
  }
  gas *= (1.0 - 0.75 * swept) * (1.0 + 1.4 * front * min(uShA, 1.2));
  float ion = (0.3 + 0.55 / (1.0 + dS2 * 1.5)) * uIon;
  float o3 = exp(-dS2 * 2.2);
  float o3c = 1.0 - o3;
  emis = gas * (cHa * ion * 0.55 * o3c * o3c + cO3 * o3 * 0.65 * uIon);
  emis += env * (cHa * 0.035 + cO3 * o3 * 0.03) * uIon * (1.0 - 0.6 * swept); // unresolved glow
  emis += env * swept * uHot * vec3(0.25, 0.5, 1.0) * 0.1;
  // a faint glow lobe around the dust bank: the bank is embedded in the nebula, not hanging below it
  vec3 qb = (p - vec3(0.1, -1.45, -0.7)) * vec3(0.55, 1.2, 0.75);
  emis += exp(-dot(qb, qb) * 1.4) * bnd * (0.5 + n1.g) * cHa * 0.018 * uIon * (1.0 - 0.6 * swept);
  // ------- dust: wisps, a dark bank below rising into pillars toward the star, the globule
  float wisps = smoothstep(0.6, 0.98, n1.b * 0.5 + n2.b * 0.6) * env * 1.3 * (1.0 - 0.6 * swept);
  float cy = p.y + 1.12 + (n1.r - 0.5) * 0.55 + (n2.g - 0.5) * 0.3 - 0.08 * p.x;
  float bank = 0.0, bankRim = 0.0;
  if (cy < 0.12 && cy > -1.1) {   // (below -1.1 the depth cap has removed it all)
    float zf = smoothstep(-2.6, -1.6, p.z) * smoothstep(0.9, 0.0, p.z);
    vec4 n3 = nz(p * 3.5 + vec3(2.7, 4.1, 0.6));
    float cyr = cy + (n3.b - 0.6) * 0.1;
    // the bank dissolves into wisps at its ends (no floating-island silhouette)
    float side = smoothstep(2.4, 0.9, abs(p.x - 0.1) + (n1.a - 0.5) * 1.4 + (n3.g - 0.5) * 0.5);
    // a thick sheet rather than a solid: densest just under its lit top, thinning and breaking up
    // into wisps toward its underside (no boulder silhouette against the stars)
    float dep = -cyr + (n1.g - 0.5) * 0.6;
    float ax = abs(p.x - 0.1) + (n1.a - 0.5) * 0.8;
    // (and toward its near face, so seen from afar it shows no solid front wall)
    float fz = p.z + (n1.b - 0.5) * 0.9;
    float er = max(max(smoothstep(0.2, 1.0, dep), smoothstep(0.7, 1.9, ax)), smoothstep(-0.4, 0.7, fz));
    float tex = n3.g * 0.6 + n2.b * 0.55;
    float keep = smoothstep(0.32 + 0.5 * er, 0.56 + 0.5 * er, tex);
    bank = smoothstep(0.04, -0.14, cyr) * exp(-max(dep - 0.15, 0.0) * 3.4) * smoothstep(0.75, 0.3, dep)
         * mix(1.0, keep, max(max(smoothstep(0.05, 0.6, dep), smoothstep(0.5, 1.5, ax)), smoothstep(-0.6, 0.4, fz)))
         * (0.6 + 0.6 * n2.g) * zf * side * side;
    bankRim = smoothstep(0.05, 0.0, cyr) * smoothstep(-0.13, -0.02, cyr) * zf * side
            * (0.2 + 1.4 * smoothstep(0.42, 0.8, tex));   // knotted, not one continuous ridge
  }
  float rp, rimP = 0.0;
  float pil = pillar(p, vec3(0.9, -1.45, -0.6), vec3(0.42, -0.66, -0.45), 0.3, 0.1, rp); rimP += rp;
  pil += pillar(p, vec3(1.5, -1.5, -0.95), vec3(1.12, -0.86, -0.85), 0.26, 0.06, rp); rimP += rp;
  pil += pillar(p, vec3(-1.3, -1.45, -0.75), vec3(-1.05, -0.92, -0.6), 0.22, 0.06, rp); rimP += rp;
  // a translucent dusty streamer flares from the tallest pillar's tip into the globule's envelope
  // (the globule is the pillar's detached head); the shock sweeps it downstream and tears it
  float stw = 1.0 - smoothstep(0.1, 0.6, uComp), stD = 0.0;
  if (stw > 0.0) {
    float shk = uShR > 0.0 ? smoothstep(uShR + 0.1, uShR - 0.35, dS) : 0.0;
    vec3 ps = p + (dv / max(dS, 1e-4)) * (-0.35 * shk);
    stD = streamer(ps, vec3(0.46, -0.74, -0.46), vec3(0.16, -0.1, -0.04), 0.14, 0.3, rp) * stw * (1.0 - 0.8 * shk);
    rimP += rp * stw * (1.0 - 0.8 * shk) * 0.5;
  }
  float rim, wspC, lit, halo, core;
  float cl = heroCloud(p, rim, wspC, lit, halo, core);
  clD = cl * 7.5;
  float dust = wisps + (bank * 1.6 + pil * 4.5 + stD * 3.0) * bnd + clD;
  // ------- lighting
  float rims = (bankRim + rimP) * bnd;
  emis += wisps * vec3(0.25, 0.38, 0.75) * illum * 0.35 * uIon;             // reflection
  emis += (wisps + (bank + pil + stD) * 0.3) * vec3(0.03, 0.012, 0.008);    // ambient brown
  emis += rims * (cHa * 1.5 + vec3(0.7, 0.5, 0.4)) * (0.15 + illum) * 0.6 * uIon; // ionisation fronts
  // the globule: ionised skin on its ragged face, rim-lit wisps, evaporation flow, dark body
  emis += (rim * 4.0 + halo * 0.3) * (cHa * 1.6 + vec3(0.6, 0.45, 0.4)) * (0.3 + illum * 1.5);
  emis += cl * vec3(0.05, 0.021, 0.011) * (1.0 + 1.5 * uComp) * (0.6 + 0.8 * lit);
  // supernova flash illumination (light echo)
  emis += (dust * 0.04 + gas * 0.3) * uFlashL / (0.1 + dS2) * vec3(0.85, 0.9, 1.0);
  // shock contact: rims light up and stay hot
  if (uShR > 0.0) {
    float hit = front * min(uShA, 1.0) * 1.5 + smoothstep(uShR + 0.05, uShR - 0.3, dS) * 0.12;
    emis += ((rim + wspC * (0.1 + 0.5 * lit)) + rims * 0.5) * hit * (cHa * 1.8 + vec3(0.9, 0.5, 0.3));
  }
  // the collapse begins: the core glows from within (seen through the cloud's own dust)
  eCore = core * mix(0.08, 1.0, uGlow) * vec3(1.0, 0.26, 0.07) * 1.8; // a faint smoulder even before
  return dust;
}
// Analytic thin shock shell around S: per-crossing line integral (limb brightened).
vec3 shellEmis(vec3 p, float g, float g2) {
  vec4 ns = nz(p * 3.3 + vec3(2.2, 0.4, 6.6));
  vec4 ns2 = nz(p * 8.0 + vec3(1.2, 7.4, 3.6));
  float fil = 0.03 + 2.5 * pow(ns.b, 8.0) + 0.8 * pow(ns2.b, 6.0);
  vec3 v = p - uS; float r = max(length(v), 1e-4); vec3 sd = v / r;
  float along = dot(-uS, sd);
  float perp = length(-uS - sd * along);
  float shadow = (along > 0.0 && r > along) ? mix(0.1, 1.0, smoothstep(0.2, 0.42, perp)) : 1.0;
  float gn = nz(p * 0.85 + vec3(0.3, 0.1, 0.7)).g;
  float gasK = 0.12 + 2.0 * smoothstep(0.35, 0.8, gn);
  vec3 c = mix(cHa * 1.3, vec3(0.25, 0.8, 1.0), smoothstep(0.3, 0.7, ns2.g));
  vec3 e = g * fil * (c + vec3(1.2) * uShHot) + g2 * ns.g * cHa * 0.12;
  return e * shadow * gasK * uShA;
}
float shellLine(float b2, float R, float w) {
  float l02 = R * R - b2;
  float g = 1.7725 * w * R * inversesqrt(max(l02, 0.0) + 0.5 * R * w);
  float bi = sqrt(b2);
  if (bi > R) g *= exp(-pow((bi - R) / w, 2.0));
  return g;
}
vec3 nebulaMarch(vec3 ro, vec3 rd, float jit, float tStar, out vec3 Tout, out float Tstar) {
  Tout = vec3(1.0); Tstar = 1.0;
  // shock shell crossings
  float tA = -1.0, tB = -1.0;
  vec3 eA = vec3(0.0), eB = vec3(0.0);
  if (uShR > 0.0) {
    vec3 os = ro - uS;
    float bb = dot(os, rd);
    vec3 pc = os - rd * bb;
    float b2 = dot(pc, pc);
    // ragged limb: the radius varies with direction
    float R = uShR * (1.0 + 0.14 * (nz(normalize(pc + 1e-5) * 1.8 + vec3(4.0, 1.0, 2.0)).r - 0.5));
    float l0 = sqrt(max(R * R - b2, 0.0));
    float g = shellLine(b2, R, uShW);
    float g2 = shellLine(b2, max(R - 1.8 * uShW, 0.01), 2.5 * uShW);
    tA = -bb - l0; tB = -bb + l0;
    if (tA > 0.0) eA = shellEmis(ro + rd * tA, g, g2);
    if (tB > 0.0) eB = shellEmis(ro + rd * tB, g, g2);
  }
  vec3 oc = ro - NC;
  float b = dot(oc, rd), c = dot(oc, oc) - NR * NR;
  float disc = b * b - c;
  vec3 C = vec3(0.0), T = vec3(1.0), Tx = vec3(1.0);
  float t0 = 0.0, t1 = -1.0;
  if (disc > 0.0) {
    float sq = sqrt(disc);
    t0 = max(-b - sq, 0.0); t1 = -b + sq;
  }
  if (t1 <= t0) return eA + eB;
  if (tA > 0.0 && tA < t0) { C += eA; tA = -1.0; }
  if (tB > 0.0 && tB < t0) { C += eB; tB = -1.0; }
  // fine steps inside the hero sphere
  float hb = dot(ro, rd), hdisc = hb * hb - dot(ro, ro) + HR * HR;
  float h0 = 1e9, h1 = -1e9;
  if (hdisc > 0.0) { float hs = sqrt(hdisc); h0 = -hb - hs; h1 = -hb + hs; }
  float dtO = (t1 - t0) / float(uNebSteps);
  float dtH = min(dtO, uHeroDt);
  float t = t0 + dtO * jit;
  bool starDone = false;
  for (int i = 0; i < 64; i++) {
    if (t > t1) break;
    bool inH = t >= h0 && t < h1;
    float ds = inH ? dtH : dtO;
    if (!inH && t < h0 && t + ds > h0) ds = h0 - t + dtH * jit;
    vec3 p = ro + rd * t;
    vec3 e, eC; float clD;
    float dd = nebDensity(p, e, clD, eC);
    if (!starDone && t > tStar) { Tstar = (T.r + T.g + T.b) / 3.0; starDone = true; }
    if (tA > 0.0 && tA < t + ds) { C += T * eA; tA = -1.0; }
    if (tB > 0.0 && tB < t + ds) { C += T * eB; tB = -1.0; }
    vec3 ext = vec3(0.72, 1.0, 1.32) * 1.6 * ds;
    vec3 tau = ext * dd;
    vec3 tr = exp(-tau);
    vec3 w = mix(vec3(ds), (1.0 - tr) / max(tau / ds, vec3(1e-5)), step(vec3(1e-4), tau));
    C += T * e * w + Tx * eC * ds;
    T *= tr;
    Tx *= exp(-ext * (dd - clD * 0.8));
    if (max(T.r, max(T.g, T.b)) < 0.005 && dot(eC, eC) < 1e-6) { T = vec3(0.0); break; }
    t += ds;
  }
  if (!starDone) Tstar = (T.r + T.g + T.b) / 3.0;
  if (tA > 0.0) C += T * eA;
  if (tB > 0.0) C += T * eB;
  Tout = T;
  return C;
}

void main() {
  vec2 q = (vUv - 0.5) * uRes / min(uRes.x, uRes.y);
  vec3 rd = normalize(uCamF + (q.x * uCamR + q.y * uCamU) * (2.0 / uFocal));
  float jit = hash12(gl_FragCoord.xy);
  vec3 col = vec3(0.0);
  vec3 Tn = vec3(1.0);
  float Ts = 1.0;
  if (uNebOn > 0.0) {
    vec3 rdl = uG2L * rd;
    float tStar = dot(uS - uEyeL, rdl);
    vec3 cn = nebulaMarch(uEyeL, rdl, jit, tStar, Tn, Ts);
    Tn = mix(vec3(1.0), Tn, uNebOn);
    Ts = mix(1.0, Ts, uNebOn);
    col = cn * uNebOn;
  }
  vec3 Tg = vec3(1.0);
  if (max(Tn.r, max(Tn.g, Tn.b)) > 0.01) {
    // bulge, bar, core (analytic), dimmed by the dust in front of their closest approach
    float tc0, tc1, tc2, tc3;
    float bul = gaussLineA(uEye, rd, vec3(0.075, 0.05, 0.075), tc0) * 3.0;
    float bar = gaussLineA(uEye, rd, vec3(0.15, 0.035, 0.045), tc1) * 2.4;
    float cor = gaussLineA(uEye, rd, vec3(0.022), tc2) * mix(7.0, 3.0, uInside);
    float nuc = gaussLineA(uEye, rd, vec3(0.006), tc3) * mix(13.0, 4.0, uInside);
    vec3 Tc;
    vec3 cg = galaxyMarch(uEye, rd, jit, tc0, Tg, Tc);
    vec3 Tcore = mix(0.35 + 0.65 * Tc, Tc, uInside);
    cg += ((bul + bar) * vec3(1.0, 0.64, 0.33) + (cor + nuc) * vec3(1.0, 0.74, 0.46)) * Tcore * uCoreK;
    float tch;
    cg += gaussLineA(uEye, rd, vec3(0.8, 0.6, 0.8), tch) * 0.012 * vec3(0.55, 0.62, 0.8);
    col += cg * Tn;
  }
  float tn = (Tn.r + Tn.g + Tn.b) / 3.0;
  o0 = vec4(col, tn);
  o1 = vec4(Tg * Tn, Ts);
}`;

  // Full-resolution composite: upsampled volume + distant stars + the massive star.
  const COMP_FS = `
in vec2 vUv; out vec4 o;
uniform sampler2D uA, uB;
uniform vec3 uStarP;   // pixel position, on/off
uniform vec2 uStarUv;
uniform float uStarI, uStarH, uStarScale;
void main() {
  // 4 bilinear taps = 3x3 tent over the reduced-resolution volume (hides the march jitter)
  vec2 h = 0.5 / vec2(textureSize(uA, 0));
  vec4 A = 0.25 * (texture(uA, vUv + vec2(-h.x, -h.y)) + texture(uA, vUv + vec2(h.x, -h.y)) +
                   texture(uA, vUv + vec2(-h.x, h.y)) + texture(uA, vUv + vec2(h.x, h.y)));
  vec3 col = A.rgb;
  if (uStarP.z > 0.0) {
    vec2 dv = (gl_FragCoord.xy - uStarP.xy) / uStarScale;
    float r2 = dot(dv, dv);
    if (r2 < 40000.0) {
      float Ts = texture(uB, uStarUv).a;
      float pc = exp(-r2 / 1.45) / 4.55;
      float glow = 0.02 / (1.0 + r2 / 25.0) + 0.003 / (1.0 + r2 / 900.0);
      float sp = 0.0;
      for (int k = 0; k < 4; k++) {
        float a = float(k) * 0.7853982 + 0.3;
        vec2 ax = vec2(cos(a), sin(a));
        float al = abs(dot(dv, ax)), pr = abs(dot(dv, vec2(-ax.y, ax.x)));
        sp += exp(-pr * pr / 0.7) * exp(-al / ((k & 1) == 0 ? 50.0 : 22.0)) * ((k & 1) == 0 ? 0.004 : 0.0015);
      }
      col += vec3(0.72, 0.85, 1.0) * ((pc + sp) * uStarI + glow * uStarH) * Ts * uStarP.z * smoothstep(40000.0, 20000.0, r2);
    }
  }
  o = vec4(col, A.a);
}`;

  // Distant stars at infinity (galaxy frame), dimmed by the volume's transmittance (uB).
  const SKY_VS = `
uniform mat4 uVP;
uniform sampler2D uB;
uniform float uInside, uPx, uMaxPt;
uniform int uNUni;
out vec3 vCol;
out float vSig, vSize;
void main() {
  int id = gl_VertexID;
  vec3 dir; float lum;
  if (id < uNUni) {
    float z = hashI(id, 3) * 2.0 - 1.0, a = TAU * hashI(id, 4);
    float r = sqrt(max(0.0, 1.0 - z * z));
    dir = vec3(r * cos(a), z, r * sin(a));
    float h = hashI(id, 5);
    lum = (0.02 + 0.12 * h * h + 12.0 * pow(h, 10.0)) * mix(0.28, 0.8, uInside);
  } else {
    // the Milky Way band, seen from inside the disk
    float a = TAU * hashI(id, 3);
    float u1 = max(hashI(id, 4), 1e-7), u2 = hashI(id, 6);
    float y = sqrt(-2.0 * log(u1)) * cos(TAU * u2) * 0.1;
    dir = vec3(cos(y) * cos(a), sin(y), cos(y) * sin(a));
    float h = hashI(id, 5);
    lum = (0.02 + 0.1 * h * h + 6.0 * pow(h, 12.0)) * 0.75 * uInside;
  }
  vec4 clip = uVP * vec4(dir * 10.0, 1.0);
  if (clip.w <= 1e-6 || lum <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0;
    vCol = vec3(0.0); vSig = 1.0; vSize = 1.0;
    return;
  }
  vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
  vec3 tr = textureLod(uB, clamp(uv, 0.0, 1.0), 0.0).rgb;
  float b = lum * 4.5;
  float sg = 0.62 + 0.2 * log(1.0 + b * 0.5);
  sg = min(sg, uMaxPt / 6.0);
  float size = min(ceil(sg * 4.8), uMaxPt);
  gl_Position = clip;
  gl_PointSize = size;
  vSig = sg; vSize = size;
  vec3 col = blackbody(mix(3400.0, 12000.0, pow(hashI(id, 7), 1.3)));
  vCol = col * tr * b * uPx / (6.2831853 * sg * sg);
}`;

  // ------------------------------------------------------------------ state
  let progGal = null, progLoc = null, progVol = null, progComp = null, progSky = null;
  let nSkyUni = 0, nSkyBand = 0;
  let noiseTex = null, mapTex = null, warpTex = null, mapK = 1;
  let nGal = 0, ranges = [0, 0, 0, 0], nLocField = 0, nLocCluster = 0, nLocYso = 0;
  let emptyVao = null;
  let maxPt = 64;
  let hdr = true;
  let vol = null; // { fb, a, b, w, h }

  function makeNoise(gl, prog) {
    const N = 64;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.texStorage3D(gl.TEXTURE_3D, 1, hdr ? gl.RGBA16F : gl.RGBA8, N, N, N);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.REPEAT);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.viewport(0, 0, N, N);
    gl.disable(gl.BLEND);
    prog.use();
    for (let z = 0; z < N; z++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex, 0, z);
      prog.setAll({ uZ: z + 0.5, uN: N });
      U.gl.drawFullscreen(gl);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    gl.bindTexture(gl.TEXTURE_3D, null);
    gl.deleteProgram(prog.program);
    return tex;
  }

  function makeMap(gl, prog, res, float, mips) {
    const tex = gl.createTexture();
    const levels = mips ? Math.floor(Math.log2(res)) + 1 : 1;
    gl.activeTexture(gl.TEXTURE7);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, levels, float ? gl.RGBA16F : gl.RGBA8, res, res);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, res, res);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, noiseTex);
    prog.use().setAll({ uNoise: 0, uSpur: [PT_TH, PT_R], uInvK: 1 / mapK });
    U.gl.drawFullscreen(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    gl.bindTexture(gl.TEXTURE_3D, null);
    if (mips) {
      gl.activeTexture(gl.TEXTURE7);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE0);
    }
    gl.deleteProgram(prog.program);
    return tex;
  }

  function volTex(gl, w, h) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, hdr ? gl.RGBA16F : gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  function ensureVol(gl, w, h) {
    if (vol && vol.w === w && vol.h === h) return;
    gl.activeTexture(gl.TEXTURE7);
    if (vol) { gl.deleteFramebuffer(vol.fb); gl.deleteTexture(vol.a); gl.deleteTexture(vol.b); }
    const a = volTex(gl, w, h), b = volTex(gl, w, h);
    gl.bindTexture(gl.TEXTURE_2D, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, a, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, b, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    vol = { fb, a, b, w, h };
  }

  // ------------------------------------------------------------------ per-frame parameters
  const STAR_I = 28;
  function shockParams(T, cues) {
    const tau = T - cues.solarSupernova;
    const P = { tau, shR: 0, shW: 0.05, shA: 0, shHot: 0, comp: 0, glow: 0, spin: 0, flashL: 0, hot: 0, ion: 1, starI: STAR_I, starH: STAR_I };
    if (tau < 0) {
      // the star swells and flickers in its last moments
      P.starI = STAR_I * (1 + 0.6 * M.smoothstep(-1.2, 0, tau) * (0.6 + 0.4 * Math.sin(tau * 31)));
      P.starH = P.starI;
      return P;
    }
    P.shR = 0.05 + 0.42 * Math.pow(tau, 0.6);
    P.shW = 0.03 + 0.02 * Math.sqrt(tau);
    P.shA = 2.6 * Math.exp(-tau * 0.45) * M.smoothstep(0, 0.1, tau) + 0.05 * Math.exp(-tau * 0.2);
    P.shHot = Math.exp(-tau * 2.5);
    P.comp = M.smoothstep(0.9, 5.5, tau);
    P.glow = M.smoothstep(2.5, 6.5, tau);
    P.spin = 0.12 * Math.max(0, tau - 1) * M.smoothstep(1, 4, tau);
    P.flashL = 1.2 * Math.exp(-tau * 4.0);
    P.hot = Math.exp(-tau * 0.4) * M.smoothstep(0, 0.3, tau);
    P.ion = 1 - 0.3 * M.smoothstep(0, 5, tau);
    // the star: blinding flash, then a fading remnant point
    P.starI = 1800 * Math.exp(-tau * 9.0) + 70 * Math.exp(-tau * 1.2) + 1.0;
    P.starH = 400 * Math.exp(-tau * 12.0) + 30 * Math.exp(-tau * 1.5) + 1.0;
    return P;
  }

  const mats = { proj: new Float32Array(16), view: new Float32Array(16), vp: new Float32Array(16), viewL: new Float32Array(16), vpL: new Float32Array(16) };

  function proj(out, fov, aspect) {
    M.perspective(out, fov, aspect, 1e-5, 50);
    if (aspect < 1) { out[0] *= aspect; out[5] *= aspect; }
    return out;
  }

  U.defineScene({
    id: 'milkyway',
    async init(gl, ctx) {
      hdr = !!(ctx.caps && ctx.caps.hdr);
      // Every program first (the driver compiles them in parallel), the bakes once theirs are done.
      const progNoise = U.gl.program(gl, U.gl.FULLSCREEN_VS, U.glsl.frag(NOISE_GEN_FS), 'milkyway-noise');
      const progMap = U.gl.program(gl, U.gl.FULLSCREEN_VS, U.glsl.frag(MAP_FS), 'milkyway-map');
      const progWarp = U.gl.program(gl, U.gl.FULLSCREEN_VS, U.glsl.frag(WARP_FS), 'milkyway-warp');
      progGal = U.gl.program(gl, U.glsl.vert(GAL_VS), U.glsl.frag(PT_FS), 'milkyway-gal');
      progLoc = U.gl.program(gl, U.glsl.vert(LOC_VS), U.glsl.frag(PT_FS), 'milkyway-loc');
      progVol = U.gl.program(gl, U.gl.FULLSCREEN_VS, U.glsl.frag(VOL_FS), 'milkyway-vol');
      progComp = U.gl.program(gl, U.gl.FULLSCREEN_VS, U.glsl.frag(COMP_FS), 'milkyway-comp');
      progSky = U.gl.program(gl, U.glsl.vert(SKY_VS), U.glsl.frag(PT_FS), 'milkyway-sky');
      mapK = hdr ? 1 : 4;
      maxPt = Math.max(8, Math.min(96, (ctx.caps && ctx.caps.maxPointSize) || 64));
      const ps = ctx.particleScale || 1;
      const nBulge = Math.round(40000 * ps), nDisk = Math.round(90000 * ps), nArm = Math.round(160000 * ps);
      const nHii = Math.round(8000 * ps), nHalo = Math.round(5000 * ps);
      ranges = [nBulge, nBulge + nDisk, nBulge + nDisk + nArm, nBulge + nDisk + nArm + nHii];
      nGal = ranges[3] + nHalo;
      nLocField = Math.round(30000 * ps);
      nLocCluster = Math.round(500 * Math.max(ps, 0.6));
      nLocYso = Math.round(900 * ps);
      nSkyUni = Math.round(9000 * Math.max(ps, 0.5));
      nSkyBand = Math.round(50000 * ps);
      emptyVao = gl.createVertexArray();
      LF = localFrame(U.timeline.cues.solarSupernova);
      await U.gl.compiled(gl, [progNoise, progMap, progWarp]);
      noiseTex = makeNoise(gl, progNoise);
      await new Promise((r) => setTimeout(r, 0));
      mapTex = makeMap(gl, progMap, ctx.tier === 'low' ? 512 : 1024, hdr, true);
      await new Promise((r) => setTimeout(r, 0));
      warpTex = makeMap(gl, progWarp, 256, false);
    },

    render(gl, s) {
      const T = s.T;
      const cues = s.cues;
      const W = s.width, H = s.height, aspect = s.aspect;
      const minDim = Math.min(W, H);
      const cam = cameraAt(T, aspect);
      const f = 1 / Math.tan(cam.fov / 2);
      proj(mats.proj, cam.fov, aspect);
      // rotation-only view (camera-relative rendering)
      M.lookAt(mats.view, [0, 0, 0], cam.F, cam.U);
      M.multiply(mats.vp, mats.proj, mats.view);

      // local camera
      const eyeL = toLocalDir(v3.mul(v3.sub(cam.eye, PT), 1 / LU));
      const FL = toLocalDir(cam.F), UL = toLocalDir(cam.U);
      M.lookAt(mats.viewL, [0, 0, 0], FL, UL);
      M.multiply(mats.vpL, mats.proj, mats.viewL);

      const D = cam.D;
      const lnD = Math.log(D);
      const camH = Math.abs(cam.eye[1]);
      const inside = 1 - M.smoothstep(0.012, 0.06, camH);
      const sh = shockParams(T, cues);
      const S = S_LOC;
      const distToCloud = v3.len(eyeL);
      const nebOn = M.smoothstep(Math.log(0.25), Math.log(0.1), lnD);
      const localFade = M.smoothstep(Math.log(0.2), Math.log(0.06), lnD);
      const split = nebOn > 0;
      const pxScale = (minDim / 720) * (minDim / 720);
      const focalPx = 0.5 * f * minDim;
      const hi = s.tier === 'high', mid = s.tier === 'mid';
      const knot = 1 - nebOn;
      // from inside the arm the galactic centre is mostly hidden behind the disk's dust
      const coreK = 1 - 0.78 * M.smoothstep(66.9, 68.3, T);

      // --------------------------------------------------- far particles
      const bindGalTex = () => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_3D, noiseTex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, mapTex);
        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, warpTex);
      };
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      bindGalTex();

      const galExpo = 0.5 * D * D * Math.pow(3.3 / D, 0.75);
      const galEps2 = Math.pow(0.25 * D, 2);
      const drawGal = (pass) => {
        progGal.use().setAll({
          uVP: mats.vp, uEye: cam.eye, uTime: T - 60, uExpo: galExpo, uEps2: galEps2, uPx: pxScale,
          uFocalPx: focalPx, uSplit: distToCloud * LU, uOmega: OMEGA, uPass: pass, uMaxPt: maxPt,
          uNearCut: 0.06 * localFade, uRange: ranges, uNoise: 0, uMap: 1, uWarp: 4, uMapK: mapK,
          uSpur: [PT_TH, PT_R], uKnot: knot, uCoreK: coreK,
        });
        gl.bindVertexArray(emptyVao);
        gl.drawArrays(gl.POINTS, 0, nGal);
      };
      const drawLoc = (pass) => {
        if (localFade <= 0) return;
        progLoc.use().setAll({
          uVP: mats.vpL, uEyeL: eyeL, uS: S, uExpo: 40, uEps2: 0.05, uPx: pxScale,
          uSplit: distToCloud, uFade: localFade, uPass: pass, uMaxPt: maxPt,
          uNField: nLocField, uNCluster: nLocCluster,
        });
        gl.bindVertexArray(emptyVao);
        gl.drawArrays(gl.POINTS, 0, nLocField + nLocCluster + nLocYso);
      };
      // once the camera is inside the nursery, galaxy stars nearer than the hero cloud are cut anyway
      const galSplit = split && localFade < 0.999;
      if (!MW_DBG.includes('nopart')) {
        drawGal(galSplit ? 1 : 0);
        drawLoc(split ? 1 : 0);
      }
      gl.bindVertexArray(null);

      // --------------------------------------------------- volume pass (reduced resolution)
      const div = hi ? 2.2 : mid ? 2.5 : 3;
      ensureVol(gl, Math.max(1, Math.ceil(W / div)), Math.max(1, Math.ceil(H / div)));
      bindGalTex();
      gl.bindFramebuffer(gl.FRAMEBUFFER, vol.fb);
      gl.viewport(0, 0, vol.w, vol.h);
      gl.disable(gl.BLEND);
      const G2L = new Float32Array([LF.R[0], LF.U[0], LF.Z[0], LF.R[1], LF.U[1], LF.Z[1], LF.R[2], LF.U[2], LF.Z[2]]);
      progVol.use().setAll({
        uRes: [W, H], uFocal: f, uEye: cam.eye, uCamR: cam.R, uCamU: cam.U, uCamF: cam.F,
        uEyeL: eyeL, uG2L: G2L, uInside: inside, uNearFade: M.clamp(1.5 * D, 0.04, 0.6),
        uNebOn: MW_DBG.includes('noneb') ? 0 : nebOn,
        // the galaxy is only a backdrop once the camera is inside the nursery
        uGalSteps: MW_DBG.includes('nogal') ? 0 : Math.round((hi ? 26 : mid ? 18 : 12) * (1 - 0.6 * nebOn)),
        uNebSteps: hi ? 22 : mid ? 16 : 11, uHeroDt: hi ? 0.055 : mid ? 0.09 : 0.12,
        uS: S, uSdir: v3.norm(S), uShR: MW_DBG.includes('noshell') ? 0 : sh.shR, uShW: sh.shW, uShA: sh.shA, uShHot: sh.shHot,
        uComp: sh.comp, uGlow: sh.glow, uSpin: sh.spin, uFlashL: sh.flashL, uHot: sh.hot, uIon: sh.ion,
        uNoise: 0, uMap: 1, uWarp: 4, uMapK: mapK, uSpur: [PT_TH, PT_R], uKnot: knot, uCoreK: coreK,
      });
      if (!MW_DBG.includes('novol')) U.gl.drawFullscreen(gl);

      // --------------------------------------------------- composite (full resolution)
      s.bindOutput();
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.SRC_ALPHA);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, vol.a);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, vol.b);
      // the massive star on screen
      let starP = [0, 0, 0], starUv = [0.5, 0.5];
      if (nebOn > 0) {
        const c = xform(mats.vpL, v3.sub(S, eyeL));
        if (c[3] > 1e-6) {
          const nx = c[0] / c[3], ny = c[1] / c[3];
          starUv = [nx * 0.5 + 0.5, ny * 0.5 + 0.5];
          starP = [starUv[0] * W, starUv[1] * H, nebOn];
        }
      }
      progComp.use().setAll({
        uA: 2, uB: 3, uStarP: MW_DBG.includes('nostar') ? [0, 0, 0] : starP, uStarUv: starUv, uStarI: sh.starI, uStarH: sh.starH, uStarScale: minDim / 720,
      });
      U.gl.drawFullscreen(gl);

      // --------------------------------------------------- distant sky stars (dimmed by dust/nebula)
      gl.blendFunc(gl.ONE, gl.ONE);
      if (!MW_DBG.includes('nopart')) {
        progSky.use().setAll({
          uVP: mats.vp, uB: 3, uInside: inside, uPx: pxScale, uMaxPt: maxPt, uNUni: nSkyUni,
        });
        gl.bindVertexArray(emptyVao);
        gl.drawArrays(gl.POINTS, 0, inside > 0.001 ? nSkyUni + nSkyBand : nSkyUni);
      }

      // --------------------------------------------------- near particles
      if (split && !MW_DBG.includes('nopart')) {
        bindGalTex();
        if (galSplit) drawGal(2);
        drawLoc(2);
      }
      gl.bindVertexArray(null);

      // --------------------------------------------------- post
      const P = s.post;
      if (sh.tau >= 0) {
        P.flash = 9 * Math.exp(-sh.tau * 18) + 0.08 * Math.exp(-sh.tau * 5);
        P.shake = 0.5 * Math.exp(-sh.tau * 2.5);
        P.bloom = 0.8 + 0.6 * Math.exp(-sh.tau * 1.0);
      }
    },
  });
})();
