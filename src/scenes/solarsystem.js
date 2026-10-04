// Scene 'solarsystem' (T 75-95): the molecular cloud core collapses and spins up into a disk,
// the Sun ignites (flash, stellar-wind shock, T Tauri jets), an HL-Tauri-like ringed
// protoplanetary disk, planetesimals colliding, and the molten proto-Earth emerging from its gap.
// Everything is a pure function of film time: one fullscreen volumetric shader + two point passes.
(function () {
  'use strict';
  const U = window.U;
  const M = U.math;

  // ------------------------------------------------------------------ constants
  // Field of view across the SHORTER screen side. It narrows to the theia scene's 34 degrees
  // during the final approach so the planet's perspective matches at the hand-off.
  const FOV_A = 40 * Math.PI / 180, FOV_B = 34 * Math.PI / 180;
  const fovAt = (T) => M.mix(FOV_A, FOV_B, M.smoothstep(88, 93, T));
  const KF_B = 2 * Math.tan(FOV_B / 2);
  const OMEGA1 = (2 * Math.PI) / 90;         // Keplerian angular speed at rho = 1 (rad/s)
  const PHI0 = 0.6;                          // Earth's orbital angle at T = 75
  const PLANET_R = 0.02;                     // proto-Earth radius (world units; orbit radius = 1)
  const HANDOFF_R = 0.30;                    // screen radius of the planet at the hand-off
  const D_FINAL = PLANET_R / Math.sin(Math.atan(HANDOFF_R * KF_B));
  const RC = 24;                             // initial cloud radius
  const RD = 6.6;                            // disk outer bound
  const LUT_N = 512;
  const NOISE_N = 128;
  const N_IMP = 16;

  // Gaps carved by forming planets: [radius, width, depth, brightness of the ring outside it].
  // The third is the proto-Earth's.
  const GAPS = [
    [0.40, 0.030, 0.75, 0.9], [0.67, 0.045, 0.85, 0.45], [1.00, 0.075, 0.97, 1.0], [1.42, 0.045, 0.6, 0.3],
    [2.22, 0.120, 0.93, 1.15], [2.88, 0.060, 0.55, 0.35], [3.58, 0.130, 0.90, 0.95], [4.32, 0.085, 0.70, 0.5],
    [5.02, 0.120, 0.60, 0.65],
  ];
  const EARTH_GAP = 2;

  // ------------------------------------------------------------------ small vector helpers
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

  // Monotone cubic (Fritsch-Carlson) through [[x, y], ...]: C1-smooth, no overshoot.
  function curve(keys) {
    const n = keys.length, xs = keys.map((k) => k[0]), ys = keys.map((k) => k[1]);
    const d = [], m = new Array(n).fill(0);
    for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
      if (s > 9) { const tt = 3 / Math.sqrt(s); m[i] = tt * a * d[i]; m[i + 1] = tt * b * d[i]; }
    }
    return function (x) {
      if (x <= xs[0]) return ys[0];
      if (x >= xs[n - 1]) return ys[n - 1];
      let i = 0;
      while (x > xs[i + 1]) i++;
      const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
      return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
    };
  }

  // ------------------------------------------------------------------ hand-off camera frame
  // Local frame at the planet: e_r (outward), e_t (prograde), e_n (disk normal = +y).
  // At the hand-off the view-space light direction must be normalize(-1, .25, .6) and the light
  // comes from the Sun at the origin, i.e. -e_r. Solve for the view basis in local coordinates.
  const LV = norm([-1, 0.25, 0.6]);
  const RV = scl(LV, -1);                                  // e_r in view coordinates
  // The disk normal is chosen with no view-z component: the camera sits in the midplane, so the
  // disk is seen exactly edge-on as a thin band through the planet, tilted ~14 degrees.
  const NV = (() => { const nt = [0, 1, 0.14128]; return norm(sub(nt, scl(RV, dot(nt, RV)))); })();
  const TV = cross(NV, RV);
  const XL = [RV[0], TV[0], NV[0]], YL = [RV[1], TV[1], NV[1]], ZL = [RV[2], TV[2], NV[2]];
  const EL_F = Math.asin(ZL[2]);
  const AZ_F = Math.atan2(ZL[1], ZL[0]);

  // Camera curves (film time T). Distances are interpolated in log space.
  const L = Math.log;
  const cLogD = curve([
    [75, L(262)], [76, L(228)], [77, L(178)], [78.5, L(104)], [79.5, L(50)], [80, L(31)], [81, L(21)], [82.5, L(16.5)],
    [84.5, L(11.5)], [86.5, L(4.0)], [88, L(1.55)], [89, L(0.75)], [91, L(0.24)], [93, L(D_FINAL)],
    [95, L(D_FINAL * 0.985)],
  ]);
  const cEl = curve([[75, 0.62], [78, 0.66], [80, 0.72], [82, 0.62], [84, 0.5], [85.5, 0.4], [86.5, 0.33], [88, 0.25],
    [89, 0.19], [91, 0.14], [93, EL_F], [95, EL_F]]);
  const cAz = curve([[75, AZ_F - 0.75], [80, AZ_F - 0.6], [84, AZ_F - 0.42], [89, AZ_F - 0.12], [93, AZ_F], [95, AZ_F]]);
  const cWt = curve([[75, 0], [84, 0], [86.5, 0.5], [88.6, 1], [95, 1]]);
  const cUp = curve([[75, 0], [86, 0], [91.5, 1], [95, 1]]);
  const cWide = curve([[75, 0], [77.5, 0.1], [79.5, 0.6], [81, 1], [85, 1], [88, 0.3], [89.5, 0], [95, 0]]);

  function frameAt(T) {
    const phi = PHI0 + OMEGA1 * (T - 75);
    const c = Math.cos(phi), s = Math.sin(phi);
    const er = [c, 0, -s], et = [-s, 0, -c], en = [0, 1, 0];
    const L2W = (v) => [er[0] * v[0] + et[0] * v[1] + en[0] * v[2], er[1] * v[0] + et[1] * v[1] + en[1] * v[2], er[2] * v[0] + et[2] * v[1] + en[2] * v[2]];
    return { phi, er, et, en, L2W };
  }

  function cameraAt(T, aspect) {
    const F = frameAt(T);
    const halfW = aspect >= 1 ? 0.5 * aspect : 0.5;
    const fit = Math.pow(M.clamp(0.89 / halfW, 1, 1.8), 0.55);
    const d = Math.exp(cLogD(T)) * M.mix(1, fit, cWide(T));
    const el = cEl(T), az = cAz(T), wt = cWt(T), ub = cUp(T);
    const tgt = scl(F.er, wt);
    const off = F.L2W([Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)]);
    const eye = add(tgt, scl(off, d));
    const up = F.L2W(norm(lerp3([0, 0, 1], YL, ub)));
    const Z = norm(off);
    const X = norm(cross(up, Z));
    const Y = cross(Z, X);
    return { eye, X, Y, Z, tgt, F, d };
  }

  // ------------------------------------------------------------------ the sky's own (slower) turn
  // The camera co-orbits with the planet and also swings around the disk, so the star field
  // would sweep across the screen at ~100 px/s while the disk itself is nearly still. The
  // background is therefore drawn through a "sky basis" that turns slower than the camera,
  // reaching its full rate from 91 to 93 so that from 93 on it is the camera's own basis (the theia
  // scene continues this very star field). Integrated backwards from 93 at init, interpolated at runtime.
  // The camera's turn is split into its part about the disk axis (world y: the co-orbit and the
  // swing round the disk, which leave the ringed disk looking the same, so the stars would slide
  // past a still disk) and the rest (tilt, pan, roll: the disk visibly turns with it). The stars
  // follow the first only a little and the second mostly, so they move with the disk.
  const SKY_T0 = 74.5, SKY_T1 = 93, SKY_H = 0.02, SKY_KA = 0.08, SKY_KP = 0.35;
  const skyGain = (T, k) => M.mix(k, 1, M.smoothstep(91, 93, T));
  const basisAt = (T) => { const c = cameraAt(T, 16 / 9); return [c.X, c.Y, c.Z]; }; // (aspect-free)
  function rodrigues(v, k, ang) {
    const c = Math.cos(ang), s = Math.sin(ang), kv = cross(k, v), kd = dot(k, v) * (1 - c);
    return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
  }
  function orthoBasis(X, Y) {
    const x = norm(X), z = norm(cross(x, Y)), y = cross(z, x);
    return [x, y, z];
  }
  const skyTab = (() => {
    const n = Math.round((SKY_T1 - SKY_T0) / SKY_H);
    const tab = new Float64Array((n + 1) * 6);
    let B = basisAt(SKY_T1), S = B.map((v) => v.slice());
    const put = (i, S) => { tab.set(S[0], i * 6); tab.set(S[1], i * 6 + 3); };
    put(n, S);
    for (let i = n - 1; i >= 0; i--) {
      const Tp = SKY_T0 + i * SKY_H;
      const Bp = basisAt(Tp);
      // world rotation R taking the camera basis at Tp + h to the one at Tp: R = Bp B^T
      const R = (r, c) => Bp[0][r] * B[0][c] + Bp[1][r] * B[1][c] + Bp[2][r] * B[2][c];
      const w = [0.5 * (R(2, 1) - R(1, 2)), 0.5 * (R(0, 2) - R(2, 0)), 0.5 * (R(1, 0) - R(0, 1))];
      const sn = Math.hypot(w[0], w[1], w[2]);
      if (sn > 1e-12) {
        const a0 = Math.atan2(sn, 0.5 * (R(0, 0) + R(1, 1) + R(2, 2) - 1)) / sn;
        const Tm = Tp + 0.5 * SKY_H, gA = skyGain(Tm, SKY_KA), gP = skyGain(Tm, SKY_KP);
        const v = [w[0] * a0 * gP, w[1] * a0 * gA, w[2] * a0 * gP];   // rotation vector, scaled
        const ang = Math.hypot(v[0], v[1], v[2]);
        if (ang > 1e-12) {
          const k = scl(v, 1 / ang);
          S = orthoBasis(rodrigues(S[0], k, ang), rodrigues(S[1], k, ang));
        }
      }
      B = Bp;
      put(i, S);
    }
    return tab;
  })();
  function skyAt(T) {
    if (T >= SKY_T1) return basisAt(T);
    const u = (Math.max(T, SKY_T0) - SKY_T0) / SKY_H;
    const i = Math.min(Math.floor(u), Math.round((SKY_T1 - SKY_T0) / SKY_H) - 1), f = u - i;
    const g = (o) => lerp3([skyTab[i * 6 + o], skyTab[i * 6 + o + 1], skyTab[i * 6 + o + 2]],
      [skyTab[i * 6 + 6 + o], skyTab[i * 6 + 7 + o], skyTab[i * 6 + 8 + o]], f);
    return orthoBasis(g(0), g(3));
  }

  // 64x64 blue-noise ranks (void and cluster), deterministic: the per-pixel jitter of the ray
  // march, so undersampling reads as fine, even grain instead of a hatched pattern.
  function makeBlueNoise() {
    const N = 64, NN = N * N, R = 5, SIG2 = 2 * 1.5 * 1.5;
    const kern = [];
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) kern.push(dx, dy, Math.exp(-(dx * dx + dy * dy) / SIG2));
    const E = new Float64Array(NN), bits = new Uint8Array(NN);
    const splat = (i, s) => {
      const x = i & (N - 1), y = i >> 6;
      for (let k = 0; k < kern.length; k += 3) E[((y + kern[k + 1]) & (N - 1)) * N + ((x + kern[k]) & (N - 1))] += s * kern[k + 2];
    };
    const pick = (want, most) => {
      let bi = -1, bv = most ? -Infinity : Infinity;
      for (let i = 0; i < NN; i++) {
        if (bits[i] !== want) continue;
        if (most ? E[i] > bv : E[i] < bv) { bv = E[i]; bi = i; }
      }
      return bi;
    };
    const rng = M.rng(0xb1e5e);
    const n0 = NN >> 4;
    for (let placed = 0; placed < n0;) { const i = Math.floor(rng() * NN); if (!bits[i]) { bits[i] = 1; splat(i, 1); placed++; } }
    for (let it = 0; it < NN; it++) { // relax: move the tightest cluster into the largest void
      const c = pick(1, true); bits[c] = 0; splat(c, -1);
      const v = pick(0, false); bits[v] = 1; splat(v, 1);
      if (v === c) break;
    }
    const rank = new Int32Array(NN), proto = bits.slice(), eProto = E.slice();
    for (let r = n0 - 1; r >= 0; r--) { const c = pick(1, true); bits[c] = 0; splat(c, -1); rank[c] = r; }
    bits.set(proto); E.set(eProto);
    for (let r = n0; r < NN; r++) { const v = pick(0, false); bits[v] = 1; splat(v, 1); rank[v] = r; }
    const out = new Uint8Array(NN);
    for (let i = 0; i < NN; i++) out[i] = Math.floor((rank[i] + 0.5) * 256 / NN);
    return out;
  }

  function rotMat(axis, ang) { // column-major 3x3 rotating vectors by ang about axis
    const [x, y, z] = axis, c = Math.cos(ang), s = Math.sin(ang), C = 1 - c;
    return [
      c + x * x * C, y * x * C + z * s, z * x * C - y * s,
      x * y * C - z * s, c + y * y * C, z * y * C + x * s,
      x * z * C + y * s, y * z * C - x * s, c + z * z * C,
    ];
  }
  const mulMat3 = (m, v) => [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]];
  function mulMat33(a, b) { // column-major a * b
    const o = new Float32Array(9);
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) o[j * 3 + i] = a[i] * b[j * 3] + a[3 + i] * b[j * 3 + 1] + a[6 + i] * b[j * 3 + 2];
    return o;
  }

  // Planet spin, matched to the theia scene, whose body frame is nb = rotMat(ND, -0.06 (T - 93)) * nv
  // (nv = view-space normal, ND derived from its disk normal as below). Here nb = E(T) * V(T) * nw
  // with V the world->view rotation of the settled hand-off camera (constant in the orbiting
  // frame): from T = 93 on both scenes show the very same plates; before, a slow rigid rotation.
  const TH_NUP = norm([0.12, 0.96, 0.26]);
  const TH_ND = (() => {
    const inPlane = (v) => norm(sub(v, scl(TH_NUP, dot(v, TH_NUP))));
    const PA = inPlane([1, 0, 0]), PC = inPlane([0, 0, 1]);
    const NC = inPlane(add(scl(PA, Math.cos(0.33)), scl(PC, Math.sin(0.33))));
    const ND = scl(TH_NUP, -1);
    return cross(ND, NC)[2] < 0 ? TH_NUP : ND;
  })();
  function bodyRot(T, F) {
    const E = rotMat(TH_ND, -0.06 * (T - 93));
    const X = F.L2W(XL), Y = F.L2W(YL), Z = F.L2W(ZL);
    return mulMat33(E, [X[0], Y[0], Z[0], X[1], Y[1], Z[1], X[2], Y[2], Z[2]]);
  }

  // ------------------------------------------------------------------ shaders
  const NOISE_FS = U.glsl.frag(`
in vec2 vUv; out vec4 o;
uniform float uZ, uN;
vec3 g3(vec3 i, float per, float seed) {
  i = mod(i, per);
  return hash33(i + vec3(seed * 37.0, seed * 71.0, seed * 113.0)) * 2.0 - 1.0;
}
float pn(vec3 p, float per, float seed) {
  vec3 i = floor(p), f = p - i;
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(g3(i, per, seed), f);
  float b = dot(g3(i + vec3(1, 0, 0), per, seed), f - vec3(1, 0, 0));
  float c = dot(g3(i + vec3(0, 1, 0), per, seed), f - vec3(0, 1, 0));
  float d = dot(g3(i + vec3(1, 1, 0), per, seed), f - vec3(1, 1, 0));
  float e = dot(g3(i + vec3(0, 0, 1), per, seed), f - vec3(0, 0, 1));
  float ff = dot(g3(i + vec3(1, 0, 1), per, seed), f - vec3(1, 0, 1));
  float g = dot(g3(i + vec3(0, 1, 1), per, seed), f - vec3(0, 1, 1));
  float h = dot(g3(i + vec3(1, 1, 1), per, seed), f - vec3(1, 1, 1));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, ff, u.x), mix(g, h, u.x), u.y), u.z);
}
float pfbm(vec3 p, float per, float seed, int oct) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    s += a * pn(p * per, per, seed + float(i) * 3.0);
    n += a; per *= 2.0; a *= 0.5;
  }
  return s / n;
}
float pridge(vec3 p, float per, float seed, int oct) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    float r = 1.0 - abs(pn(p * per, per, seed + float(i) * 5.0)) * 1.6;
    s += a * r * r;
    n += a; per *= 2.0; a *= 0.55;
  }
  return s / n;
}
void main() {
  vec3 p = vec3(gl_FragCoord.xy / uN, uZ);
  float r = pfbm(p, 4.0, 1.0, 5);
  float g = pfbm(p, 8.0, 2.0, 4);
  float b = pridge(p, 4.0, 3.0, 5);
  float a = pfbm(p, 16.0, 4.0, 3);
  o = clamp(vec4(0.5 + r * 1.25, 0.5 + g * 1.25, b, 0.5 + a * 1.25), 0.0, 1.0);
}`);

  const MAIN_FS = U.glsl.frag(`
precision highp sampler3D;
in vec2 vUv; out vec4 o;
uniform vec2 uRes;
uniform float uT, uK, uPix, uNT;
uniform vec3 uEye, uX, uY, uZ;
uniform sampler3D uNoise;
uniform sampler2D uLut;
uniform int uSteps, uHQ;

uniform vec3 uSunCol;
uniform float uSunLum, uSunCore, uSunHalo, uCorona;

uniform float uCloudW, uRc, uSc, uG, uFy, uSpin, uTauC, uClearR, uRimI, uCloudK, uAmb, uInGlow, uDrain, uArm, uWarp, uEdge, uRimC;
uniform vec3 uRimDir, uRimL;

uniform float uDiskW, uDiskTime, uDustK, uThermK, uScatK, uHd, uWake, uInL, uBandK;
uniform vec4 uPlAng;   // orbital angles of the forming planets at rho = 1, 2.25

uniform float uShockR, uShockI;
uniform float uJetI, uJetLen, uJetAge;

uniform vec3 uPPos;
uniform float uPR, uPW, uCrust, uDk, uMagT, uPTime, uPGlow, uBurst, uEAge, uEnv, uEnvR, uEnvGlow, uPLum;
uniform mat3 uPRot;
uniform vec4 uImp[${N_IMP}];
uniform float uImpF;   // the melt pools and splash rings crust over before the hand-off

uniform float uNeb, uStarB, uHK, uStarOcc, uEvap;
uniform vec3 uNebDir, uNebX, uNebY;
uniform vec3 uSX, uSY, uSZ;   // the sky basis (see skyAt)
uniform vec4 uStarP;          // densities of the two star layers, faint-layer gain, star width
uniform highp sampler2D uBlue;
uniform float uCoreG;
uniform vec3 uCoreC;

const float OM1 = ${OMEGA1.toFixed(6)};
const float RD = ${RD.toFixed(2)};
const float CONE = 0.2;

float phiN(float x) { return 1.0 / (1.0 + exp(-1.702 * x)); }
float wrapPi(float a) { return a - TAU * floor((a + PI) / TAU); }
vec3 emitK(float k) { return blackbody(k) * pow(k / 1500.0, 2.6); }

// ---------------------------------------------------------------- background
// The core starLayer() with the per-cell hash split (the theia scene's early field, which
// continues this one, uses the same: bit-identical at full density, dens = 1.25 cap). A lower
// density keeps an exact subset of its stars, those just under the threshold fading, so the
// field thins and fills again without popping. sK widens the star at constant flux.
vec3 starS(vec3 dir, float scale, float px, float dens, float cap, float seed, float sK) {
  vec3 p = dir * scale + seed * 17.13;
  vec3 base = floor(p - 0.5);
  vec3 col = vec3(0.0);
  float sigma = max(px * scale * 0.85, 0.02) * sK;
  float fw = 0.25 * cap, lim = min(dens, cap);
  for (int k = 0; k < 8; k++) {
    vec3 cell = base + vec3(float(k & 1), float((k >> 1) & 1), float((k >> 2) & 1));
    uint h1 = uhash(uvec3(ivec3(floor(cell + seed * 131.0))));
    float hx = float(h1) * (1.0 / 4294967296.0);
    if (hx > lim) continue;
    uint h2 = uhash(h1), h3 = uhash(h2);
    vec3 h = vec3(hx, float(h2) * (1.0 / 4294967296.0), float(h3) * (1.0 / 4294967296.0));
    vec3 sp = cell + 0.2 + 0.6 * hash33(cell * 1.7 + 11.0 + seed);
    vec3 sdir = normalize(sp - seed * 17.13);
    float d = length(dir - sdir) * scale;
    float mag = pow(h.y, 5.0);
    float bright = 0.02 + 0.12 * h.y * h.y + 12.0 * mag * mag;
    float w = exp(-0.5 * (d * d) / (sigma * sigma)) * min((dens - hx) / fw, 1.0);
    vec3 tint = blackbody(mix(3200.0, 12000.0, h.z * h.z));
    col += tint * bright * w * (px * scale < 0.5 ? 1.0 : 0.5 / (px * scale));
  }
  return col / (sK * sK);
}

// d: direction in the sky basis; returns the nebula (rgb) and the star field separately so the
// stars can be hidden behind the disk
vec3 background(vec3 d, out vec3 stars) {
  vec3 s = starS(d, 200.0, uPix, uStarP.x, 0.014, 1.0, uStarP.w);
  if (uHQ > 0) s += starS(d, 470.0, uPix, uStarP.y, 0.0055, 3.0, uStarP.w) * uStarP.z;   // the faint, fine stars
  s *= uStarB;
  vec3 col = vec3(0.0);
  if (uNeb > 0.001) {
    // smooth H-alpha haze of the star-forming region, brightest behind the cloud
    float a = textureLod(uNoise, d * 0.32 + vec3(0.13, 0.71, 0.37), 0.0).r;
    float b = textureLod(uNoise, d * 0.85 + vec3(0.5, 0.2, 0.9), 0.0).r;
    float n = a * 0.7 + b * 0.3;
    float fd = dot(d, uNebDir);
    float focus = smoothstep(-0.5, 0.95, fd);
    float em = smoothstep(0.22, 0.9, n);
    vec3 ha = vec3(1.0, 0.24, 0.42) * (0.012 + 0.08 * em + 0.1 * em * em) * (0.2 + 0.9 * focus);
    // a few faint supernova-remnant filaments: teal OIII cores with H-alpha skins
    float f1 = textureLod(uNoise, d * 0.6 + vec3(0.77, 0.05, 0.4), 0.0).b;
    float fil = pow(f1, 10.0);
    vec3 fc = mix(vec3(1.0, 0.25, 0.4), vec3(0.3, 0.8, 0.85), smoothstep(0.82, 0.97, f1)) * fil * (0.1 + 0.4 * focus) * 0.18;
    float dg = textureLod(uNoise, d * 0.5 + vec3(0.8, 0.4, 0.2), 0.0).g;
    float dust = smoothstep(0.42, 0.85, dg);
    col = (ha + fc) * uNeb * (1.0 - 0.75 * dust);
    float hk = uHK;
    if (hk > 0.0) {
      // the milky way scene's look at the hand-off: a smooth glow in a broad band behind the
      // globule, greyer to the left (towards the remnant), darker to the right and the top.
      // (u, v): screen position at T = 75 (uNebX, uNebY carry 1 / K)
      float zz = max(fd, 0.3);
      float u = dot(d, uNebX) / zz, v = dot(d, uNebY) / zz;
      float lf = smoothstep(0.0, -0.8, u);
      vec3 hc = vec3(0.07, 0.033, 0.05) + vec3(0.035, 0.026, 0.035) * lf
              + vec3(0.13 * exp(-u * u / 0.23), 0.04 * exp(-(u + 0.15) * (u + 0.15) / 0.2), 0.05 * exp(-(u + 0.1) * (u + 0.1) / 0.25));
      hc *= (1.0 - 0.22 * smoothstep(0.1, 0.45, v)) * (0.72 + 0.56 * n) * (1.0 - 0.3 * dust);
      // its grey-teal glow to the upper left, the dusty dark below
      hc += vec3(0.045, 0.042, 0.056) * smoothstep(0.15, -0.55, u) * smoothstep(-0.3, 0.3, v) * (0.5 + n);
      hc *= 1.0 - 0.3 * smoothstep(-0.12, -0.5, v);
      hc += mix(vec3(1.0, 0.25, 0.4), vec3(0.45, 0.6, 0.7), lf) * fil * (0.1 + 0.4 * focus) * 0.12;
      col = mix(col, hc, hk);
    }
    s *= 1.0 - dust * mix(min(0.5 * uNeb, 0.9), 0.25, hk);
  }
  stars = s;
  return col;
}

// ---------------------------------------------------------------- intersections
vec2 sphereSeg(vec3 ro, vec3 rd, float R) {
  float b = dot(ro, rd), c = dot(ro, ro) - R * R, h = b * b - c;
  if (h < 0.0) return vec2(1e9, -1e9);
  h = sqrt(h);
  return vec2(max(-b - h, 0.0), -b + h);
}
// the chord through the spheroid with radius a round the y axis and half-height c
vec2 spheroidSeg(vec3 ro, vec3 rd, float a, float c) {
  vec3 s = vec3(1.0 / a, 1.0 / c, 1.0 / a);
  vec3 o = ro * s, d = rd * s;
  float A = dot(d, d), b = dot(o, d), h = b * b - A * (dot(o, o) - 1.0);
  if (h < 0.0) return vec2(1e9, -1e9);
  h = sqrt(h);
  return vec2(max((-b - h) / A, 0.0), (-b + h) / A);
}
// spiral density wakes launched by the forming planets
float wakes(float rho, float th) {
  float x = rho - 1.0;
  float dw = wrapPi(th - (uPlAng.x - sign(x) * 13.0 * pow(abs(x), 1.5)));
  float w = exp(-pow(dw / (0.05 + 0.35 * abs(x)), 2.0)) * exp(-abs(x) * 2.2) * smoothstep(0.05, 0.13, abs(x));
  float x2 = (rho - 2.25) / 2.25;
  float dw2 = wrapPi(th - (uPlAng.y - sign(x2) * 12.0 * pow(abs(x2), 1.5)));
  w += 0.8 * exp(-pow(dw2 / (0.06 + 0.4 * abs(x2)), 2.0)) * exp(-abs(x2) * 2.5) * smoothstep(0.03, 0.08, abs(x2));
  return w;
}

// ---------------------------------------------------------------- media
float gCoreW = 0.0;
// The collapsing cloud core: an inverse map takes the point back to the cloud as it was at
// T = 75 (radial contraction, vertical flattening, differential spin-up) and samples it there.
void cloudSample(vec3 p, float t, float dt, inout float sig, inout vec3 ssrc) {
  float Rs = uRc * uSc;
  float r = length(p);
  // (the domain reaches past the nominal radius while the edge is ragged: r0 <= R1)
  float R1 = 1.0 + 0.3 * uEdge;
  if (r > Rs * max(uFy * R1, pow(R1, uG))) return;
  float rho = length(p.xz);
  float th = atan(-p.z, p.x);
  float rho0 = uRc * pow(max(rho / Rs, 1e-5), 1.0 / uG);
  float y0 = p.y / (uSc * uFy);
  float xw = rho0 / uRc + 0.05;
  float spr = pow(xw, -1.5);
  float sp = uSpin * min(spr, 14.0);
  float th0 = th - sp;
  vec3 p0 = vec3(rho0 * cos(th0), y0, -rho0 * sin(th0)) / uRc;
  float r0 = length(p0);
  if (r0 > R1) return;
  // pre-filter the noise by the footprint of a world step in the pre-collapse coordinates:
  // radial compression (and the winding shear d(sp)/d(rho0)), tangential and vertical squeeze
  float dsp = spr < 14.0 ? 1.5 * uSpin * spr / (xw * uRc) : 0.0;
  float jr0 = rho0 / max(rho, 1e-4);
  float wind = max(jr0 / uRc * max(1.0, sqrt(1.0 + rho0 * rho0 * dsp * dsp) / uG), 1.0 / (Rs * uFy));
  float lod = max(log2(max(uPix * t * uNT * 0.6 * wind, 1e-6)), 0.0);
  float n1 = textureLod(uNoise, p0 * 0.55 + vec3(0.31, 0.17, 0.53), lod).r;
  float n2 = textureLod(uNoise, p0 * 1.6 + vec3(0.71, 0.29, 0.11), lod + 1.0).b;
  // (rotated, so no lattice-aligned facets show in the silhouette)
  float ng = textureLod(uNoise, mat3(0.0, 0.8, 0.6, -0.8, 0.36, -0.48, -0.6, -0.48, 0.64) * p0 * 0.47 + vec3(0.13, 0.57, 0.83), lod + 0.4).g;
  float turb = n1 * 0.65 + n2 * 0.35;
  float nf = 0.5;
  if (uHQ > 0) { nf = textureLod(uNoise, p0 * 4.2 + vec3(0.2, 0.9, 0.4), lod + 2.2).a; turb += (nf - 0.5) * 0.18; }
  float nfr = nf;
  nf = mix(nf, 0.5, 0.6 * uHK);
  // irregular, multi-scale boundary (a Bok-globule-like core): the radius is displaced by large
  // lobes, medium bumps and fine fraying, and the density fades out over a wide, ragged shell
  float rr = r0 * (1.0 + 0.36 * (0.5 - n1) + 0.42 * (0.5 - ng) + 0.2 * (0.5 - nf)) + 0.1 * (0.5 - n2);
  float shape = smoothstep(1.0 + 0.2 * uEdge, 0.45, rr) / (1.0 + rr * rr * 8.0);
  // wispy, tattered outskirts: before the collapse winds them up, the outer shell is eroded into
  // streamers and thin veils (the more, the farther out), so the globule has no hard silhouette
  float er = smoothstep(0.45, 1.05, rr);
  float fil = n2 * 0.6 + ng * 0.25 + nfr * 0.15;
  float keep = smoothstep(0.25 + 0.35 * er, 0.62 + 0.3 * er, fil) * (1.0 - 0.6 * er) + 0.04;
  shape *= mix(1.0, mix(2.2 * n2 * n2 * (0.6 + 0.8 * ng), 1.6 * keep, uEdge), smoothstep(0.5, 0.92, rr));
  shape *= smoothstep(R1, R1 - 0.14 - 0.3 * uEdge, r0);
  // an m = 2 perturbation of the initial cloud, wound into trailing spiral streamers by the
  // differential spin-up of the collapse. The windings tighten inwards: fade them where the
  // ray steps can no longer resolve them (no concentric step banding at the centre).
  float armF = 2.0 * dsp * jr0 / uG;
  // (an m = 2 mode vanishes on the axis: no pinwheel singularity, no streak along the axis)
  float armA = uArm * exp(-pow(armF * max(dt, uPix * t) * 0.22, 2.0)) * smoothstep(0.02, 0.16, rho0 / uRc);
  float arm = 1.0 + armA * cos(2.0 * th0 + 5.0 * (n1 - 0.5) + 1.3);
  float d = shape * (0.4 + 1.2 * turb) * max(arm, 0.04);
  float jr = rho / max(rho0, 1e-5);
  float comp = min(1.0 / max(uG * uSc * uFy * jr * jr, 1e-4), 80.0);
  d *= pow(comp, 0.45);
  float rn = r / Rs;
  // the inner envelope drains onto the forming disk and star
  d *= mix(1.0, smoothstep(0.03, 0.42, rn), uDrain);
  // stellar wind clears the envelope from the inside out, piling it into a shell
  if (uClearR > 0.0) {
    float w = 0.16 * uClearR + 0.05;
    float re = r * (1.0 + 0.45 * (turb - 0.5));   // ragged, uneven blow-out
    d *= smoothstep(uClearR - w, uClearR + 0.2 * w, re) * (1.0 + 2.0 * exp(-pow((re - uClearR) / w, 2.0)));
  }
  float s = uCloudW * uCloudK * d / Rs;
  if (s <= 0.0) return;
  // light from the embedded protostar, reddened by the dust between it and the point
  float tauc = uTauC * atan(rn * 6.0) * 0.6366;
  vec3 ext = exp(-tauc * vec3(0.62, 1.0, 1.55));
  vec3 S = uSunCol * uSunLum * ext / (rn * rn * 10.0 + 0.1) * 0.3;
  // dust heated by the contraction glows faintly from within; the dense, compressed streamers
  // glow most, so the inspiralling structure shows
  float dens = clamp(max(arm, 0.0) * turb * 1.25, 0.0, 2.0);
  S += uInGlow * vec3(1.0, 0.26, 0.07) * exp(-rn * 4.0) * (0.12 + 1.5 * dens * dens);
  // rim of the shock-compressed, photo-evaporating edge facing the remnant: pink-white
  // H-alpha (as in the milky way scene's globule it continues), warmer inside
  float edge = smoothstep(0.66, 0.95, rr);
  vec3 nr = p0 / max(r0, 1e-4);
  float facing = clamp(dot(nr, uRimDir) * 0.5 + 0.5, 0.0, 1.0);
  // the lit face: a soft coral-red glow over the outskirts towards uRimL, brightest on the limb
  // and on the denser streamers (no crisp crescent)
  float vz = dot(nr, uZ);
  float limb = 1.0 - 0.85 * vz * vz;
  float fl = clamp(dot(nr, uRimL) * 0.5 + 0.5, 0.0, 1.0);
  float cres = limb * fl * fl * mix(fl, 1.0, 0.5 * uHK) * smoothstep(mix(0.6, 0.45, uHK), 0.92, rr);
  S += uRimI * (vec3(1.0, 0.33, 0.14) * 0.05 * edge * edge + mix(vec3(0.8, 0.19, 0.2), vec3(0.84, 0.2, 0.28), uHK) * uRimC * cres) * (0.4 + n2) * (0.7 + 0.6 * ng);
  // the warm core seen through the globule (a per-ray term: brightest along the rays that pass
  // closest to it, mottled by the dust in front)
  S += uCoreC * gCoreW * (0.25 + 1.1 * n2 * (0.5 + ng));
  // dark, dusty interior: only a little diffuse (reddened) light
  S += uAmb * vec3(0.011, 0.0046, 0.0028) * (0.3 + 1.4 * n2) * (0.45 + 1.3 * facing * facing);
  // (at the hand-off, as in the milky way scene: even the shadowed side glows a deep dusky red)
  S += uHK * vec3(0.06, 0.013, 0.012) * (0.3 + 1.4 * n2) * (1.0 - 0.5 * facing);
  sig += s;
  ssrc += s * S;
}

float dustH(float rho) { return uHd * 0.018 * pow(rho, 1.12); }

// Clumpy, sheared fine structure of the dust rings (plus the planets' wakes and a large-scale
// lopsidedness), as a multiplier of the surface density.
float dustClump(float rho, float th, float lod, bool fine) {
  float rc = max(rho, 0.25);
  float om = OM1 / (rc * sqrt(rc));
  float thp = th - om * uDiskTime;
  vec3 nc = vec3(thp * (3.0 / TAU), log(rho) * 2.6 + 0.37, 0.41);
  vec4 nz = textureLod(uNoise, nc, lod);
  float clump = 0.45 + 1.1 * nz.r * nz.g + 0.4 * (nz.b - 0.5);
  if (fine) {
    float fn = textureLod(uNoise, nc * vec3(2.0, 4.0, 1.0) + vec3(0.3, 0.1, 0.27), lod + 1.5).a;
    clump *= 0.75 + 0.5 * fn;
  }
  float wk = uWake > 0.0 ? wakes(rho, th) : 0.0;
  float lop = 1.0 + 0.22 * cos(th - 0.9 + 0.35 * rho) * smoothstep(0.8, 2.5, rho);
  return max(clump, 0.05) * (1.0 + uWake * 0.8 * wk) * lop;
}

// Emission of the dust at p: thermal glow (warm inside, cool and red outside), starlight
// scattered off the grains, the accreting proto-Earth lighting its gap, the ignition shock.
vec3 dustSrc(vec3 p, float rho, vec3 rd, float clump) {
  vec3 S = textureLod(uLut, vec2(sqrt(rho / RD), 0.75), 0.0).rgb * uThermK * (0.75 + 0.5 * clump);
  float cs = dot(normalize(p), -rd);
  float g = 0.35;
  float hg = 1.0 + g * g - 2.0 * g * cs;
  float ph = (1.0 - g * g) / (hg * sqrt(hg));
  S += uSunCol * vec3(1.0, 0.66, 0.4) * uSunLum * uScatK * ph / (rho * rho + 0.25);
  vec3 dp = p - uPPos;
  S += vec3(1.0, 0.5, 0.2) * uPLum / (dot(dp, dp) * 60.0 + 0.02);
  if (uShockI > 0.0) {
    float w = 0.15 + 0.06 * uShockR;
    S += vec3(1.0, 0.72, 0.42) * uShockI * exp(-pow((rho - uShockR) / w, 2.0)) * 1.5;
  }
  if (uBurst > 0.0) {   // the birth of the proto-Earth sends a glowing ring through its gap
    float rr = 0.03 + 0.32 * (1.0 - exp(-uEAge / 0.45));
    float w = 0.012 + 0.06 * uEAge;
    S += vec3(1.0, 0.55, 0.25) * uBurst * exp(-pow((length(dp.xz) - rr) / w, 2.0)) * 1.6 * clump;
  }
  return S;
}

// Thin settled dust layer with the rings, integrated analytically where the ray crosses the
// midplane (camera outside the layer). Returns the emission (already weighted by opacity);
// trans = transmittance, tc = where along the ray the layer sits.
vec3 dustLayer(vec3 ro, vec3 rd, out vec3 trans, out float tc) {
  trans = vec3(1.0); tc = 1e9;
  float ry = abs(rd.y) > 1e-5 ? rd.y : 1e-5;
  float t = -ro.y / ry;
  vec3 p = ro;
  if (t > 0.0) p = ro + rd * t; else t = 0.0;
  float rho = length(p.xz);
  if (rho > RD || rho < 0.05) return vec3(0.0);
  float hd = dustH(rho);
  float sgn = rd.y > 0.0 ? 1.0 : -1.0;
  float frac = phiN(-sgn * ro.y / hd);
  if (frac < 0.002) return vec3(0.0);
  vec4 lut = textureLod(uLut, vec2(sqrt(rho / RD), 0.25), 0.0);
  if (lut.r < 1e-4) return vec3(0.0);
  float th = atan(-p.z, p.x);
  float om = OM1 * pow(max(rho, 0.25), -1.5);
  float ady = max(abs(rd.y), 0.03);
  float fp = uPix * max(t, 0.02) / ady;
  float grad = max(2.6, 0.72 * om * uDiskTime) / rho;
  float lod = max(log2(max(fp * grad * uNT * 0.6, 1e-6)), 0.0);
  float clump = dustClump(rho, th, lod, uHQ > 0);
  float tau = min(uDiskW * uDustK * lut.r * clump * frac / ady, 40.0);
  if (tau < 1e-4) return vec3(0.0);
  trans = exp(-tau * vec3(0.8, 1.0, 1.25));
  tc = t;
  return dustSrc(p, rho, rd, clump) * (1.0 - exp(-tau));
}

// Camera inside the thin layer (the hand-off): march it with geometric steps; within each step
// the vertical profile is integrated analytically, so grazing and steep rays both work.
vec3 dustMarch(vec3 ro, vec3 rd, float tMax, out vec3 trans, out float tc) {
  trans = vec3(1.0); tc = 1e9;
  float ady = max(abs(rd.y), 1e-5);
  float sgn = rd.y >= 0.0 ? 1.0 : -1.0;
  // where the ray leaves the layer (|y| = 4.5 scale heights; the layer flares outwards):
  // a few conservative fixed-point steps
  float tl = 0.0;
  for (int i = 0; i < 3; i++) {
    vec2 pe = ro.xz + rd.xz * tl;
    tl = max(tl, (4.5 * dustH(max(length(pe), 0.05)) + 0.002 - sgn * ro.y) / ady);
  }
  float a = dot(rd.xz, rd.xz), b = dot(ro.xz, rd.xz), c = dot(ro.xz, ro.xz) - RD * RD;
  float h = b * b - a * c;
  float tr = (h > 0.0 && a > 1e-8) ? (-b + sqrt(h)) / a : 0.0;
  float t0 = 0.003;
  float t1 = min(min(tMax, tl), tr);
  if (t1 <= t0) return vec3(0.0);
  // geometric steps, no coarser than x1.6 (short paths through the layer get few steps)
  int nMax = uHQ > 0 ? 12 : 9;
  int n = clamp(int(ceil(log(t1 / t0) * 2.13)), 2, nMax);
  float k = pow(t1 / t0, 1.0 / float(n));
  float ta = t0, ws = 0.0, tws = 0.0;
  vec3 E = vec3(0.0);
  for (int i = 0; i < 12; i++) {
    if (i >= n) break;
    float tb = ta * k;
    float tm = sqrt(ta * tb);
    vec3 p = ro + rd * tm;
    float rho = length(p.xz);
    if (rho > 0.05 && rho < RD) {
      float hd = dustH(rho);
      float colm;
      if (ady * (tb - ta) > 0.3 * hd) colm = abs(phiN((ro.y + rd.y * tb) / hd) - phiN((ro.y + rd.y * ta) / hd)) / ady;
      else { float ym = p.y / hd; colm = exp(-0.5 * ym * ym) * 0.39894 / hd * (tb - ta); }
      float sd = uDiskW * uDustK * colm * textureLod(uLut, vec2(sqrt(rho / RD), 0.25), 0.0).r;
      if (sd > 4e-6) {   // (clump <= ~2.5: nothing to see in the cleared gaps)
        float th = atan(-p.z, p.x);
        float lod = max(log2(max(uPix * tm * 2.6 / rho * uNT * 0.6, 1e-6)), 0.0);
        float clump = dustClump(rho, th, lod, false);
        float tau = min(sd * clump, 40.0);
        if (tau > 1e-5) {
          vec3 a3 = exp(-tau * vec3(0.8, 1.0, 1.25));
          E += trans * dustSrc(p, rho, rd, clump) * (1.0 - a3);
          float w = (1.0 - a3.g) * trans.g;
          ws += w; tws += w * tm;
          trans *= a3;
        }
      }
    }
    ta = tb;
  }
  if (ws > 1e-5) tc = tws / ws;
  return E * uBandK;
}

// ---------------------------------------------------------------- planet
vec3 voronoi(vec3 x) {
  vec3 p = floor(x), f = x - p;
  float d1 = 8.0, d2 = 8.0, id = 0.0;
  for (int k = -1; k <= 1; k++)
  for (int j = -1; j <= 1; j++)
  for (int i = -1; i <= 1; i++) {
    vec3 g = vec3(float(i), float(j), float(k));
    vec3 h = hash33(p + g);
    vec3 r = g + 0.1 + 0.8 * h - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; id = fract(h.x * 7.13 + h.y * 3.1); }
    else if (d < d2) d2 = d;
  }
  return vec3(sqrt(d1), sqrt(d2), id);
}

// Incandescent rock: same radiance scale and plate styling as the theia scene, so the two
// pictures coincide during the hand-off (theia's body frame is reproduced by uPRot).
const vec3 SUNP = vec3(1.0, 0.93, 0.84);
float brightK(float k) { float x = k / 1500.0; return x < 1.27 ? 1.6 * x * x * x * x : 4.161 * pow(x / 1.27, 1.5); }
vec3 emitP(float k) { return blackbody(k) * brightK(k); }

vec3 planetShade(vec3 pw, vec3 rd) {
  vec3 nw = normalize(pw - uPPos);
  vec3 L = normalize(-uPPos);
  vec3 nb = uPRot * nw;
  float mu = max(dot(nw, -rd), 0.0);
  float ndl = dot(nw, L);
  float diff = max(ndl, 0.0);
  vec3 wa = vec3(snoise(nb * 1.15 + vec3(0.2, 0.4, 0.1)), snoise(nb * 1.15 + vec3(5.1, 1.3, 2.7)), snoise(nb * 1.15 + vec3(9.4, 7.2, 3.3)));
  vec3 w = nb + wa * 0.3;
  vec3 v = voronoi(w * 2.7);
  float edge = v.y - v.x;
  float nB = 0.5 + 0.5 * snoise(w * 0.9 + vec3(0.5, 0.1, 0.7));
  float nC = 0.5 + 0.6 * fbm(w * 2.6 + vec3(0.1, 0.6, 0.3) - uT * 0.006, uHQ > 0 ? 4 : 3);
  float nD = 0.5 + 0.5 * snoise(w * 7.0 + vec3(0.7, 0.3, 0.5));
  // plates crust over as the body cools (uCrust = coverage)
  float crustSel = v.z * 0.65 + nB * 0.7 - 0.35;
  float crust = smoothstep(0.0, 0.05, uCrust - crustSel);
  // As they cool (uDk, 90.5-93) the plates darken to the theia scene's basalt: near-black sunlit
  // rock with a dull red glow, seams of uneven width (the brightest orange) and a few dark rafts
  // on the open magma. At uDk = 1 this is exactly the theia scene's pre-impact proto-Earth.
  float dk = uDk;
  float crW = mix(0.035 + 0.05 * nD, 0.024 + 0.075 * nD * nD + 0.035 * smoothstep(0.55, 0.85, nB), dk);
  float crack = 1.0 - smoothstep(0.0, crW, edge);
  crust *= 1.0 - crack;
  float heat = clamp(nC * 0.9 + nD * 0.35 - 0.3, 0.0, 1.0);
  heat = mix(heat, 1.0, crack * 0.7);
  float Tm = 1150.0 + 750.0 * heat + uMagT;   // uMagT: extra heat of the young, accreting body
  float rough = 0.6 + 0.8 * nD;
  vec3 crustRad = vec3(0.075, 0.068, 0.062) * rough * SUNP * 2.6 * diff + blackbody(950.0) * 0.06 * (0.5 + nB);
  float cover = crust;
  if (dk > 0.0) {
    float rn = snoise(w * 4.6 + vec3(2.1, 7.7, 4.4)) + 0.3 * nD - 0.15 * nB;
    float raft = smoothstep(0.42, 0.5, rn) * (1.0 - crust) * (1.0 - crack);
    cover = mix(crust, crust + raft, dk);
    Tm -= 160.0 * dk * (1.0 - crack) * (1.0 - heat * 0.5);
    float thin = exp(-edge / 0.024) * (0.4 + 0.6 * nD);
    float rim = smoothstep(0.42, 0.5, rn) * (1.0 - smoothstep(0.5, 0.62, rn)) * (1.0 - crust);
    float hc = pow(1.0 - abs(snoise(w * 10.0 + vec3(3.1, 0.4, 8.2))), 10.0) * smoothstep(0.35, 0.8, nB);
    vec3 basalt = vec3(0.009, 0.0085, 0.008) * (0.7 + 0.6 * nD) * SUNP * 2.6 * diff
                + blackbody(1000.0) * (0.002 + 0.02 * nB * smoothstep(0.45, 0.95, nC))
                + emitP(1000.0 + 120.0 * hc) * hc * 0.12
                + emitP(1080.0 + 250.0 * thin) * (thin * 0.3 + rim * 0.2);
    crustRad = mix(crustRad, basalt, dk);
  }
  vec3 magma = emitP(Tm);
  vec3 col = mix(magma, crustRad, cover) + (1.0 - cover) * SUNP * 0.12 * diff * nD;
  // impacts: flash, melt pool and a splash ring (all over by the hand-off)
  if (uImpF > 0.0) for (int k = 0; k < ${N_IMP}; k++) {
    vec4 im = uImp[k];
    float age = uT - im.w;
    if (age < 0.0 || age > 3.0) continue;
    float sz = fract(im.w * 13.37) * 0.6 + 0.4;
    vec3 dir = normalize(im.xyz);
    float dd = length(nb - dir);
    float big = k == 2 ? 2.0 : 1.0;
    float fl = exp(-age / 0.06) * 14.0 * big * exp(-dd * dd / (0.0016 * sz * big));
    float pool = exp(-dd * dd / ((0.003 + 0.006 * age) * sz * big)) * exp(-age / 0.8) * 2.0;
    float rr = 0.17 * sqrt(age) * sz * big;
    float ring = exp(-pow((dd - rr) / (0.01 + 0.012 * age), 2.0)) * exp(-age / 0.45) * 1.8;
    col += vec3(1.0, 0.9, 0.75) * fl + emitP(2100.0) * (pool + ring) * 0.3 * uImpF;
  }
  // emission limb darkening, hot rock-vapour rim, sun glint on the limb
  col *= 0.55 + 0.45 * sqrt(mu);
  float fr = pow(1.0 - mu, 3.0);
  col += mix(vec3(1.0, 0.38, 0.12) * 0.55, vec3(1.0, 0.28, 0.07) * 0.4, dk) * fr * uPGlow;   // (dark plates: thinner, redder)
  col += SUNP * vec3(1.0, 0.75, 0.55) * pow(1.0 - mu, 5.0) * smoothstep(-0.2, 0.6, ndl) * 1.2 * (1.0 - 0.8 * dk);
  return col;
}

// ---------------------------------------------------------------- volume march
vec3 gAcc = vec3(0.0), gTr = vec3(1.0), gTrSun = vec3(1.0), gTrH = vec3(1.0);
vec3 gLE = vec3(0.0), gLT = vec3(1.0);
bool gSunRec = false, gLayerDone = true;
float gTSun = 0.0, gTc = 1e9, gHR = 1.0;

// the screen-space glare is attenuated by the media near the star's depth with a soft weight,
// so the thin disk crossing in front of / behind the star leaves no hard edge across the glare
float haloW(float t) { return 1.0 - smoothstep(gTSun - gHR, gTSun + gHR, t); }
void layerAt() {
  gAcc += gTr * gLE; gTr *= gLT;
  gTrH *= mix(vec3(1.0), gLT, haloW(gTc));
  gLayerDone = true;
}
// The steps are spread as t = tm + w tan(u), u uniform: finer near the ray's closest approach to
// the protostar tm, where the light and the drained, flattened core change fastest (w large =
// nearly uniform steps).
void marchSeg(vec3 ro, vec3 rd, float a, float b, int n, float jit, float tm, float w) {
  if (b <= a || n <= 0 || max(gTr.r, max(gTr.g, gTr.b)) < 0.004) return;
  float ua = atan((a - tm) / w), ub = atan((b - tm) / w);
  float du = (ub - ua) / float(n);
  for (int i = 0; i < 64; i++) {
    if (i >= n) break;
    float x = tan(ua + du * (float(i) + jit));
    float t = tm + w * x, dt = w * (1.0 + x * x) * du;
    vec3 p = ro + rd * t;
    float sg = 0.0; vec3 ss = vec3(0.0);
    cloudSample(p, t, dt, sg, ss);
    vec3 e = sg * vec3(0.82, 1.0, 1.22) * dt;
    // the transmittance to the star's depth, interpolated within the step (not stepped with
    // the jitter, which would speckle the small, bright protostar)
    if (!gSunRec && t + 0.5 * dt >= gTSun) {
      if (!gLayerDone && gTc <= gTSun) layerAt();
      gTrSun = gTr * exp(-e * clamp((gTSun - t) / dt + 0.5, 0.0, 1.0)); gSunRec = true;
    }
    if (!gLayerDone && t >= gTc) layerAt();
    if (sg > 1e-6) {
      vec3 a3 = exp(-e);
      gAcc += gTr * (ss / sg) * (1.0 - a3);
      gTr *= a3;
      gTrH *= exp(-e * haloW(t));
    }
    if (max(gTr.r, max(gTr.g, gTr.b)) < 0.004) break;
  }
}

// ---------------------------------------------------------------- main
void main() {
  vec2 q = (vUv - 0.5) * uRes / min(uRes.x, uRes.y);
  vec3 rd = normalize(uX * (q.x * uK) + uY * (q.y * uK) - uZ);
  vec3 ro = uEye;
  float jit = texelFetch(uBlue, ivec2(gl_FragCoord.xy) & 63, 0).r;

  // the proto-Earth: anti-aliased silhouette from the closest-approach distance
  float tP = 1e9, cov = 0.0;
  vec3 oc = ro - uPPos;
  float pb = dot(oc, rd);
  float bb2 = sqrt(max(dot(oc, oc) - pb * pb, 0.0));
  if (uPW > 0.0 && -pb > 0.0) {
    float pxw = uPix * (-pb);
    cov = clamp((uPR - bb2) / pxw + 0.5, 0.0, 1.0);
    if (cov > 0.0) {
      float Re = uPR + 0.5 * pxw;
      tP = -pb - sqrt(max(pb * pb - dot(oc, oc) + Re * Re, 0.0));
    }
  }

  // ------------------------------------------------ thin dust layer (composited during the march)
  vec3 lT = vec3(1.0), lE = vec3(0.0);
  float tc = 1e9;
  if (uDiskW > 0.0) {
    if (uInL < 1.0) {
      lE = dustLayer(ro, rd, lT, tc);
      if (tc > tP) { lE = vec3(0.0); lT = vec3(1.0); tc = 1e9; }
    }
    if (uInL > 0.0) {
      vec3 T2; float tc2;
      vec3 E2 = dustMarch(ro, rd, tP, T2, tc2);
      lE = mix(lE, E2, uInL); lT = mix(lT, T2, uInL); tc = min(tc, tc2);
    }
  }
  bool layerDone = tc > 1e8;

  // ------------------------------------------------ volume: the cloud core
  gTSun = max(dot(-ro, rd), 0.0);
  gHR = 0.3 * length(ro);
  gTc = tc; gLE = lE; gLT = lT; gLayerDone = layerDone;
  if (uCloudW > 0.0) {
    float Rs = uRc * uSc;
    if (uCoreG > 0.0) {
      vec3 cw = cross(ro - uRimDir * (0.26 * Rs), rd) / Rs;
      gCoreW = uCoreG * exp(-dot(cw, cw) * 4.5);
    }
    float R1 = 1.0 + 0.3 * uEdge;
    // (the inverse map takes r0 <= R1 to inside this spheroid, as uG >= 1)
    vec2 sC = spheroidSeg(ro, rd, Rs * pow(R1, uG), Rs * uFy * R1);
    sC.y = min(sC.y, tP);
    if (sC.y > sC.x) {
      // short chords need fewer steps; the wind-blown cavity inside the shell is skipped
      int n = max(int(float(uSteps) * clamp((sC.y - sC.x) / Rs * 0.65, 0.3, 1.0) + 0.5), 6);
      float wW = uWarp * Rs;   // (finer steps near the protostar, see marchSeg)
      float rIn = (0.84 * uClearR - 0.05) / 1.27;
      vec2 sI = rIn > 0.0 ? sphereSeg(ro, rd, rIn) : vec2(1e9, -1e9);
      // (the flattened bound can lie partly inside the cavity: only the parts outside are marched)
      if (sI.y > sI.x && sI.y > sC.x && sI.x < sC.y) {
        float a1 = max(sI.x, sC.x), b1 = min(sI.y, sC.y);
        float la = a1 - sC.x, lb = sC.y - b1;
        if (la + lb > 1e-4 * Rs) {
          int na = la > 0.0 ? max(int(float(n) * la / (la + lb) + 0.5), 3) : 0;
          int nb = lb > 0.0 ? max(n - na, 3) : 0;
          marchSeg(ro, rd, sC.x, a1, na, jit, gTSun, wW);
          marchSeg(ro, rd, b1, sC.y, nb, jit, gTSun, wW);
        }
      } else marchSeg(ro, rd, sC.x, sC.y, n, jit, gTSun, wW);
    }
  }
  if (!gLayerDone) {
    if (!gSunRec && gTSun < gTc) { gTrSun = gTr; gSunRec = true; }
    layerAt();
  }
  if (!gSunRec) gTrSun = gTr;
  vec3 acc = gAcc, tr = gTr, trSun = gTrSun;
  float tSun = gTSun;

  vec3 col = acc;
  float pv = cov * uPW;
  if (pv > 0.0) col += tr * pv * planetShade(ro + rd * tP, rd);
  if (pv < 1.0) {
    vec3 rdS = normalize(uSX * (q.x * uK) + uSY * (q.y * uK) - uSZ);
    vec3 st;
    vec3 bg = background(rdS, st);
    if (uHK > 0.0 && uCloudW > 0.0) {
      // round the globule (as in the milky way scene): on the side facing the remnant, gas
      // photo-evaporated off its face glows pink; away from it, a faint smoky dust tail
      float Rs = uRc * uSc;
      vec3 cp = ro + rd * max(-dot(ro, rd), 0.0);
      vec3 e = vec3(cp.x, cp.y / max(uFy, 1.0), cp.z) / Rs;
      float sm = textureLod(uNoise, e * 0.9 + vec3(0.41, 0.23, 0.67), 0.0).r;
      float lit = dot(cp / max(length(cp), 1e-4), uRimL);
      float le = length(e) + 0.35 * (sm - 0.5);
      float att = exp(-0.4 * uHK * smoothstep(0.2, -0.7, lit) * smoothstep(1.45, 0.85, le));
      vec3 glow = vec3(1.0, 0.36, 0.45) * uHK * uEvap * smoothstep(-0.5, 0.8, lit) * smoothstep(0.55, 0.95, le)
                * exp(-max(le - 0.95, 0.0) * 2.4) * (0.45 + 1.1 * sm * sm);
      bg = bg * att + glow; st *= att;
    }
    // the stars are lost behind the glowing disk (not only dimmed by it)
    if (uStarOcc > 0.0) st *= pow(max(lT.g, 1e-4), 5.0 * uStarOcc);
    col += tr * tr * tr * (1.0 - pv) * (bg + st);
  }

  // ------------------------------------------------ the (proto)star
  vec3 sd = -ro; float sdist = length(sd); sd /= sdist;
  float cs = dot(rd, sd);
  float ang = sqrt(max(2.0 * (1.0 - cs), 0.0));
  if (cs > 0.0 && sdist < tP) {
    float coreR = 0.0018;
    float core = exp(-ang * ang / (coreR * coreR)) * uSunCore;
    float halo = uSunHalo * (0.0006 / (ang * ang + 0.0006) + 0.04 * 0.015 / (ang + 0.015));
    vec3 sc = uSunCol * halo;
    if (uCorona > 0.0) {
      vec3 sx = normalize(cross(sd, uY)), sy = cross(sx, sd);
      float pa = atan(dot(rd, sy), dot(rd, sx));
      float streak = textureLod(uNoise, vec3(pa / TAU * 2.0, ang * 4.0 - uT * 0.05, 0.3), 0.0).b;
      sc += uSunCol * uCorona * exp(-ang / 0.025) * (0.4 + 1.2 * streak * streak);
    }
    // the glare is only softly cut by the thin disk (no hard edge across the star)
    col += trSun * uSunCol * core + gTrH * sc;
  }

  // ------------------------------------------------ ignition shock (faint, turbulent, limb-brightened)
  if (uShockI > 0.0 && cs > 0.0) {
    float bb = sdist * sqrt(max(1.0 - cs * cs, 0.0));
    float w = 0.15 + 0.1 * uShockR;
    float Ro = uShockR + w, Ri = max(uShockR - w, 0.0);
    float L = sqrt(max(Ro * Ro - bb * bb, 0.0)) - sqrt(max(Ri * Ri - bb * bb, 0.0));
    float nn = 0.5;
    float hS = uShockR * uShockR - bb * bb;
    if (hS > 0.0) {
      hS = sqrt(hS);
      vec3 c0 = ro + rd * tSun;
      nn = 0.5 * (textureLod(uNoise, (c0 - rd * hS) / uShockR * 0.9 + vec3(0.3, 0.6, 0.1), 0.0).r
                + textureLod(uNoise, (c0 + rd * hS) / uShockR * 0.9 + vec3(0.3, 0.6, 0.1), 0.0).r);
    }
    vec3 shc = mix(vec3(1.0, 0.8, 0.55), vec3(1.0, 0.42, 0.2), clamp(uShockR / 7.0, 0.0, 1.0));
    col += shc * uShockI * L / w * 0.03 * (0.2 + 1.6 * nn * nn) * mix(vec3(1.0), tr, 0.5);
  }

  // ------------------------------------------------ T Tauri bipolar jets along the disk axis
  if (uJetI > 0.0) {
    float dd = dot(rd, ro);
    float den = max(1.0 - rd.y * rd.y, 1e-4);
    float tj = (rd.y * ro.y - dd) / den;
    float sj = (ro.y - rd.y * dd) / den;
    if (tj > 0.0) {
      vec3 P = ro + rd * tj;
      float as = abs(sj);
      // slightly precessing, knotty, collimated flow with a bow shock at its head
      vec2 wob = 0.035 * as * vec2(sin(as * 0.8 + sign(sj) * 1.7), cos(as * 0.6 + 0.4));
      float dist = length(P - vec3(wob.x, sj, wob.y));
      float rj = 0.02 + 0.028 * as;
      float along = smoothstep(uJetLen, uJetLen * 0.86, as) * smoothstep(0.05, 0.5, as) / (1.0 + 0.22 * as);
      float kn = textureLod(uNoise, vec3(as * 0.42 - uJetAge * 1.1, sign(sj) * 0.31 + 0.1, 0.7), 0.0).r;
      float kn2 = textureLod(uNoise, vec3(as * 1.3 - uJetAge * 3.0, sign(sj) * 0.23, 0.2), 0.0).g;
      float knots = 0.12 + 1.6 * pow(kn, 4.0) + 0.5 * pow(kn2, 3.0);
      float hx = (as - uJetLen * 0.9) / (0.15 + 0.05 * as);
      float head = exp(-hx * hx);
      float sinA = max(sqrt(den), 0.25);
      float k = uJetI * along / (rj * sinA) * 0.02;
      float kh = uJetI * smoothstep(0.05, 0.5, as) / (rj * sinA) * 0.02;
      vec3 jc = vec3(0.65, 0.8, 1.0) * exp(-dist * dist / (rj * rj)) * knots * k
              + vec3(1.0, 0.3, 0.45) * exp(-dist * dist / (4.0 * rj * rj)) * (0.25 * knots * k + head * kh * 0.35)
              + vec3(0.8, 0.85, 1.0) * exp(-dist * dist / (2.0 * rj * rj)) * head * kh * 0.25;
      if (tj > tc) jc *= lT;
      if (tj > tP) jc *= 0.0;
      col += jc;
    }
  }

  // ------------------------------------------------ the accreting proto-Earth: cocoon, halo, burst
  if (-pb > 0.0) {
    if (uEnv > 0.0) {
      vec3 cpt = ro + rd * (-pb) - uPPos;
      float nn = textureLod(uNoise, cpt / uEnvR * 0.18 + vec3(0.3, 0.1, uT * 0.02), 0.0).r;
      float tauE = uEnv * 3.0 * exp(-bb2 * bb2 / (uEnvR * uEnvR)) * (0.6 + 0.8 * nn);
      vec3 eE = vec3(1.0, 0.38, 0.12) * uEnvGlow * (1.0 - exp(-tauE)) * (0.7 + 0.6 * nn);
      col = col * exp(-tauE * vec3(0.8, 1.0, 1.25)) + eE;
    }
    if (uPW > 0.0) {
      // glowing rock-vapour halo (as in the theia scene)
      float x = max(bb2 / uPR - 1.0, 0.0);
      vec3 mE = (oc + rd * (-pb)) / max(bb2, 1e-7);
      float halo = exp(-x / 0.04) * 0.8 + exp(-x / 0.16) * 0.25;
      halo *= 0.7 + 0.3 * smoothstep(-0.6, 0.6, dot(mE, normalize(-uPPos)));
      col += emitP(1500.0) * halo * uPGlow * 0.25 * (1.0 - cov * mix(0.6, 0.97, uDk)) * uPW;
    }
    if (uBurst > 0.0) {
      float x = max(bb2 - uPR, 0.0) / uPR;
      col += vec3(1.0, 0.58, 0.28) * uBurst * (exp(-x / 0.25) * 1.8 + exp(-x / 1.5) * 0.25);
    }
  }

  o = vec4(max(col, 0.0), 1.0);
}`);

  const PART_VS = U.glsl.vert(`
in vec4 aSeed;   // rho, theta0, z (in scale heights), seed
uniform mat4 uVP;
uniform vec3 uEye, uPPos;
uniform float uT, uDiskTime, uVis, uPR, uMaxPt, uFlashRate, uHd;
out vec3 vCol;
out float vI;
const float OM1 = ${OMEGA1.toFixed(6)};
void main() {
  float rho = aSeed.x;
  float om = OM1 * pow(max(rho, 0.25), -1.5);
  float th = aSeed.y + om * uDiskTime;
  float h = uHd * 0.018 * pow(rho, 1.12);
  vec3 p = vec3(rho * cos(th), aSeed.z * h, -rho * sin(th));
  // collisions: at most one flash per particle and time slot
  float slot = 1.6 + 2.4 * fract(aSeed.w * 7.13);
  float u = uT / slot + aSeed.w * 13.7;
  float k = floor(u);
  uint hk = uhash(uvec2(uint(k + 4096.0), uint(gl_VertexID)));
  float r1 = float(hk) * (1.0 / 4294967296.0);
  float r2 = float(uhash(hk)) * (1.0 / 4294967296.0);
  float at = 0.1 + 0.8 * r1;
  float dtf = (fract(u) - at) * slot;
  float fl = step(r2, uFlashRate) * exp(-dtf * dtf / 0.0035) * (0.3 + 2.2 * r2 / max(uFlashRate, 1e-4));
  vec3 toP = p - uEye;
  float dist = length(toP);
  // hidden behind the planet?
  vec3 rd = toP / dist;
  vec3 oc = uEye - uPPos;
  float b = dot(oc, rd), c = dot(oc, oc) - uPR * uPR, hh = b * b - c;
  float occl = (hh > 0.0 && -b - sqrt(hh) < dist && -b > 0.0) ? 0.0 : 1.0;
  float rel = clamp(5.0 / dist, 0.35, 2.5);
  float I = (0.0036 * rel + fl * 1.3) * uVis * occl;
  gl_Position = uVP * vec4(p, 1.0);
  // small, warm grains; a collision is a brief orange glint (not a white star-like dot)
  float px = clamp(1.5 + 0.5 * fl, 1.5, uMaxPt);
  gl_PointSize = px;
  vI = I * 2.25 / (px * px) * (1.0 + fl);
  vCol = mix(vec3(1.0, 0.5, 0.24), vec3(1.0, 0.68, 0.4), clamp(fl, 0.0, 1.0));
  if (I < 1e-4) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`);

  const PART_FS = U.glsl.frag(`
in vec3 vCol; in float vI; out vec4 o;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d) * 4.0;
  float w = exp(-r2 * 3.0) * (1.0 - smoothstep(0.7, 1.0, r2));
  o = vec4(vCol * vI * w * 3.0, 1.0);
}`);

  // Impactor streaks (head + trail) hitting the proto-Earth.
  const IMP_VS = U.glsl.vert(`
uniform mat4 uVP;
uniform vec4 uHead[${N_IMP}];   // xyz current head position, w visibility
uniform vec4 uVel[${N_IMP}];    // xyz velocity, w size
uniform float uMaxPt;
uniform vec3 uEye;
out vec3 vCol; out float vI;
const int TRAIL = 14;
void main() {
  int k = gl_VertexID / TRAIL;
  int j = gl_VertexID - k * TRAIL;
  vec4 hd = uHead[k];
  vec4 vl = uVel[k];
  float f = float(j) / float(TRAIL);
  vec3 p = hd.xyz - vl.xyz * f * 0.22;
  gl_Position = uVP * vec4(p, 1.0);
  float dist = length(p - uEye);
  float px = clamp(0.012 * vl.w / dist * 900.0, 1.5, min(uMaxPt, 6.0));
  gl_PointSize = px;
  float I = hd.w * (1.0 - f) * (1.0 - f) * vl.w * (j == 0 ? 3.0 : 1.0);
  vI = I / (px * px) * 4.0;
  vCol = mix(vec3(1.0, 0.92, 0.8), vec3(1.0, 0.45, 0.15), f);
  if (hd.w <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`);

  // ------------------------------------------------------------------ state
  let progMain = null, progPart = null, progImp = null;
  let noiseTex = null, lutTex = null, partVao = null, partCount = 0;
  const lutData = new Float32Array(LUT_N * 4);
  let impacts = [];          // { t, dirW, dirB, vin, size }
  const impUniform = new Float32Array(N_IMP * 4);
  const headU = new Float32Array(N_IMP * 4), velU = new Float32Array(N_IMP * 4);
  let maxPt = 64;
  let emptyVao = null;
  let nebDir = [0, 0, -1], nebX = [1, 0, 0], nebY = [0, 1, 0], rimDir = [-1, 0, 0], rimL = [-1, 0, 0];
  let blueTex = null;

  function makeNoise(gl, prog) {
    const N = NOISE_N;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, tex);
    const levels = Math.floor(Math.log2(N)) + 1;
    gl.texStorage3D(gl.TEXTURE_3D, levels, gl.RGBA8, N, N, N);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.viewport(0, 0, N, N);
    gl.disable(gl.BLEND);
    prog.use();
    prog.set('uN', N);
    for (let z = 0; z < N; z++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex, 0, z);
      prog.set('uZ', (z + 0.5) / N);
      U.gl.drawFullscreen(gl);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    gl.deleteProgram(prog.program);
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.generateMipmap(gl.TEXTURE_3D);
    gl.bindTexture(gl.TEXTURE_3D, null);
    return tex;
  }

  // Radial disk profile (row 0), a pure function of the gap growth parameters:
  // R = dust surface density incl. rings/gaps, G = ring factor.
  // The proto-Earth's gap is flat-bottomed and widens as the planet clears its feeding zone.
  function updateLut(gl, gapGrow, gap3, cav, w3) {
    for (let i = 0; i < LUT_N; i++) {
      const u = (i + 0.5) / LUT_N;
      const rho = u * u * RD;
      const base = Math.pow(Math.max(rho, 0.05), -0.55) * Math.exp(-Math.pow(rho / 5.7, 5)) * M.smoothstep(cav * 0.6, cav * 1.4, rho);
      let ring = 1;
      for (let g = 0; g < GAPS.length; g++) {
        const [r0, w0, dep0, amp] = GAPS[g];
        const earth = g === EARTH_GAP;
        const w = earth ? w3 : w0;
        const dep = Math.min(dep0 * gapGrow * (earth ? gap3 : 1), 0.997);
        const x = (rho - r0) / w;
        ring *= 1 - dep * (earth ? Math.exp(-x * x * x * x) : Math.exp(-x * x));
        const xb = (rho - r0 - 2.2 * w0) / (1.3 * w0);
        ring *= 1 + 0.8 * amp * gapGrow * dep0 * Math.exp(-xb * xb);
      }
      lutData[i * 4] = base * ring;
      lutData[i * 4 + 1] = ring;
      lutData[i * 4 + 2] = 0;
      lutData[i * 4 + 3] = 1;
    }
    gl.bindTexture(gl.TEXTURE_2D, lutTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LUT_N, 1, gl.RGBA, gl.FLOAT, lutData);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  // Row 1: thermal glow of the dust (blackbody of the radial temperature profile, warm inside,
  // cool and red outside), static.
  function initThermalLut(gl) {
    const row = new Float32Array(LUT_N * 4);
    for (let i = 0; i < LUT_N; i++) {
      const u = (i + 0.5) / LUT_N;
      const rho = Math.max(u * u * RD, 1e-4);
      const Td = M.clamp(2000 * Math.pow(rho, -0.35), 900, 2500);
      const bb = blackbodyJS(Td);
      const k = Math.pow(Math.max(rho, 0.2), -0.45);
      row.set([bb[0] * k, bb[1] * k, bb[2] * k, 1], i * 4);
    }
    gl.bindTexture(gl.TEXTURE_2D, lutTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 1, LUT_N, 1, gl.RGBA, gl.FLOAT, row);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  function buildParticles(gl, ctx) {
    const rng = M.rng(0x5017a5);
    const n = Math.round(14000 * (ctx.particleScale || 1));
    const data = new Float32Array(n * 4);
    // sample radii from the ringed density (rejection against the gap profile at full growth)
    let i = 0;
    while (i < n) {
      const rho = 0.3 + Math.pow(rng(), 1.35) * 5.4;
      let ring = 1;
      for (const [r0, w, dep] of GAPS) {
        const x = (rho - r0) / w;
        ring *= 1 - dep * Math.exp(-x * x);
        const xb = (rho - r0 - 2.3 * w) / (1.4 * w);
        ring *= 1 + 0.75 * dep * Math.exp(-xb * xb);
      }
      if (rng() * 1.8 > ring) continue;
      const z = (rng() + rng() + rng() - 1.5) * 1.4;
      data.set([rho, rng() * Math.PI * 2, z, rng()], i * 4);
      i++;
    }
    const buf = U.gl.buffer(gl, data);
    partVao = U.gl.vao(gl, [{ loc: progPart.attribs.aSeed, buffer: buf, size: 4 }]);
    partCount = n;
  }

  function buildImpacts() {
    const rng = M.rng(0xea271);
    // (over by 92.6: the theia scene's proto-Earth at the hand-off has no fresh impact scars)
    const times = [88.55, 88.82, 89.0, 89.28, 89.6, 89.9, 90.25, 90.6, 90.95, 91.3, 91.6, 91.85, 92.05, 92.25, 92.42, 92.6];
    const sizes = [0.5, 0.6, 1.0, 0.55, 0.7, 0.5, 0.65, 0.45, 0.6, 0.5, 0.55, 0.4, 0.45, 0.35, 0.3, 0.25];
    impacts = times.map((t, k) => {
      const cam = cameraAt(t, 16 / 9);
      // visible hemisphere, avoiding the very limb
      let v;
      for (;;) {
        v = [rng() * 2 - 1, rng() * 2 - 1, rng()];
        const l = Math.hypot(v[0], v[1], v[2]);
        if (l > 0.2 && l < 1 && v[2] / l > 0.35) break;
      }
      v = norm(v);
      if (k === 2) v = norm([-0.25, 0.3, 0.92]); // the cue impact: big and near the centre
      const dirW = norm(add(add(scl(cam.X, v[0]), scl(cam.Y, v[1])), scl(cam.Z, v[2])));
      const dirB = mulMat3(bodyRot(t, cam.F), dirW);
      // oblique incoming direction
      let perp = norm(cross(dirW, [rng() - 0.5, rng() - 0.5, rng() - 0.5]));
      const vin = norm(add(scl(dirW, -0.55), scl(perp, 0.85)));
      return { t, dirW, dirB, vin, size: sizes[k] };
    });
    for (let k = 0; k < N_IMP; k++) {
      const im = impacts[k];
      impUniform.set([im.dirB[0], im.dirB[1], im.dirB[2], im.t], k * 4);
    }
  }

  // ------------------------------------------------------------------ per-frame parameters
  function params(T, cues) {
    const ign = cues.sunIgnition, eF = cues.earthFormed;
    const ss = M.smoothstep;
    const P = {};
    // ---- collapse of the cloud core
    const cp = M.clamp((T - 75) / (ign - 75), 0, 1);
    const c = cp * cp;
    // (taller and a little narrower at first: the milky way scene's egg-shaped globule)
    const egg = 1 - ss(76.6, 79.2, T);
    // (and a little smaller at first: the camera of the milky way scene closes in on it faster)
    P.sc = Math.pow(0.25, c) * M.mix(1, 0.92, egg) * M.mix(0.86, 1, ss(75.3, 77.3, T));
    P.g = 1 + 0.75 * c;
    P.fy = Math.pow(0.3, c) * M.mix(1, 1.4, egg);
    P.spin = 3.2 * Math.pow(cp, 3) + Math.max(0, T - ign) * 0.4;
    P.arm = 0.85 * ss(76.5, 79.2, T);
    P.cloudW = 1 - ss(ign + 0.8, ign + 3.0, T);
    P.clearR = T > ign ? 8.5 * (1 - Math.exp(-(T - ign) / 1.1)) : 0;
    P.tauC = M.mix(4.5, 2.2, ss(76.5, ign, T));
    P.rimI = M.mix(1.8, 6.0, 1 - ss(76.6, 78.0, T)) * (1 - ss(76.8, 78.8, T));
    P.cloudK = 32;
    P.amb = 1.0;
    P.inGlow = 0.06 + 0.9 * Math.pow(ss(76.3, ign, T), 2);
    P.drain = 0.9 * ss(77.3, ign - 0.3, T);
    P.warp = M.mix(4, 0.4, ss(77.3, 78.8, T));   // ray steps concentrated at the core (see marchSeg)
    P.edge = 1 - ss(77.6, 79.6, T);               // ragged, translucent outskirts before the spin-up
    P.rimC = M.mix(0.2, 0.3, 1 - ss(76.6, 78, T));
    P.evap = 0.14;
    // ---- protostar / Sun
    const di = T - ign;
    if (di < 0) {
      const u3 = cp * cp * cp;
      P.temp = 1800 + 2700 * u3;
      P.lum = 0.04 + 1.2 * u3 + 0.8 * Math.exp(di / 0.15);
      P.core = 0.5 + 25 * u3 + 40 * Math.exp(di / 0.12);
      P.halo = 0.05 + 0.6 * u3;
      P.corona = 0;
    } else {
      P.temp = 5800 + 3200 * Math.exp(-di / 0.35);
      P.lum = 2.4 + 6 * Math.exp(-di / 0.2) + 1.2 * Math.exp(-di / 1.5);
      P.core = 60 + 90 * Math.exp(-di / 0.15);
      P.halo = 0.8 + 2.2 * Math.exp(-di / 0.25) + 0.8 * Math.exp(-di / 1.4);
      P.corona = 0.5 + 1.5 * Math.exp(-di / 0.8);
      P.lum *= 1 + 0.06 * Math.sin(T * 5.1) * Math.sin(T * 1.7); // T Tauri variability
    }
    // ---- disk
    P.diskW = ss(78.3, 80.2, T);
    P.hd = M.mix(1.0, 0.22, ss(84, 91, T));
    P.gapGrow = ss(79.5, 83.5, T);
    P.gap3 = M.mix(0.6, 1.0, ss(83, 88.5, T));
    P.w3 = M.mix(0.075, 0.13, ss(88.5, 92.5, T));
    P.cav = M.mix(0.06, 0.2, ss(ign, ign + 2.5, T));
    P.dustK = M.mix(0.55, 0.28, ss(88, 92, T));
    P.thermK = M.mix(0.32, 0.22, ss(85, 90, T));
    P.scatK = M.mix(0.05, 0.035, ss(85, 90, T));
    P.wake = ss(82, 86, T) * (1 - ss(90.5, 92.5, T));
    P.bandK = M.mix(1, 0.55, ss(91, 93, T));
    // ---- shock and jets
    P.shockR = di > 0 ? 7.5 * (1 - Math.exp(-di / 0.9)) + 0.6 * di : 0;
    P.shockI = di > 0 ? 1.6 * Math.exp(-di / 0.7) * ss(0, 0.05, di) : 0;
    P.jetI = di > 0 ? 1.3 * ss(0, 0.25, di) * (1 - ss(1.0, 2.8, di)) : 0;
    P.jetLen = di > 0 ? 0.4 + 11 * (1 - Math.exp(-di / 0.8)) : 0;
    P.jetAge = Math.max(di, 0);
    // ---- the proto-Earth
    const de = T - eF;
    P.env = ss(84.5, 87, T) * (1 - ss(eF, eF + 0.7, T));
    P.envR = 0.045 + 0.08 * ss(eF, eF + 0.7, T);
    P.envGlow = 0.6;
    P.plum = 0.22 * ss(84, 87.5, T) * (1 - 0.6 * ss(eF, eF + 2, T)) * (1 - 0.8 * ss(91, 93, T));
    P.pw = ss(eF - 0.25, eF + 0.05, T);
    P.crust = M.mix(0.0, 0.62, ss(eF + 0.1, 93.0, T));
    P.magT = 90 * (1 - ss(eF, 93.0, T));
    P.pglow = 1.0;
    P.dk = ss(90.5, 93.0, T);                          // the plates cool to dark basalt (theia's look)
    P.burst = de >= 0 ? Math.exp(-de / 0.35) : 0;
    P.eAge = de;
    // ---- background
    P.neb = M.mix(1.9, 0.25, ss(78, 83, T)) * (1 - ss(90.5, 93, T));   // (none in the theia scene's sky)
    P.stars = M.mix(0.6, 0.75, ss(79, 82, T)) * (1 - 0.3 * (1 - ss(76.6, 78.6, T)));
    P.hk = 1 - ss(76.6, 78.6, T);                       // the milky way scene's look (hand-off 5)
    P.coreG = 0.26 * (1 - ss(77.0, 79.2, T));
    // star field: thinned (an exact subset of the full one) over the disk, back to the full field
    // of the theia scene by 93; densities are given as 1.25 x cap = full (see starS)
    P.thin = ss(76.4, 78.4, T) * (1 - ss(90.5, 93, T));
    P.thinB = M.mix(0.9, 1, ss(76.4, 78.4, T)) * (1 - ss(90.5, 93, T));   // (bright layer: few bright stars at the hand-off too)
    P.starOcc = ss(80.5, 82.5, T) * (1 - ss(90.5, 92.5, T));
    // ---- particles
    P.partVis = ss(80.6, 82.5, T) * (1 - 0.8 * ss(90, 92.5, T));
    P.flashRate = 0.035;
    return P;
  }

  // ------------------------------------------------------------------ scene
  U.defineScene({
    id: 'solarsystem',

    async init(gl, ctx) {
      maxPt = (ctx.caps && ctx.caps.maxPointSize) || 64;
      // Every program first (the driver compiles them in parallel), the noise bake once its
      // program is done.
      const progNoise = U.gl.program(gl, U.gl.FULLSCREEN_VS, NOISE_FS, 'solarsystem-noise');
      progMain = U.gl.program(gl, U.gl.FULLSCREEN_VS, MAIN_FS, 'solarsystem-main');
      progPart = U.gl.program(gl, PART_VS, PART_FS, 'solarsystem-particles');
      progImp = U.gl.program(gl, IMP_VS, PART_FS, 'solarsystem-impactors');
      lutTex = U.gl.texture(gl, null, { width: LUT_N, height: 2, internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.FLOAT, filter: 'linear', wrap: 'clamp' });
      initThermalLut(gl);
      buildImpacts();
      await new Promise((r) => setTimeout(r, 0));
      blueTex = U.gl.texture(gl, makeBlueNoise(), {
        width: 64, height: 64, internalFormat: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE, filter: 'nearest', wrap: 'repeat',
      });
      // The nebula glows behind the cloud's initial direction (sky basis; nebX, nebY give the
      // T = 75 screen position); the shock arrives from screen-left.
      const c0 = cameraAt(75, 16 / 9);
      const s0 = skyAt(75), k0 = 2 * Math.tan(fovAt(75) / 2);
      nebDir = scl(s0[2], -1);
      nebX = scl(s0[0], 1 / k0); nebY = scl(s0[1], 1 / k0);
      rimDir = norm(add(add(scl(c0.X, -1), scl(c0.Y, 0.35)), scl(c0.Z, 0.25)));
      rimL = norm(add(scl(c0.X, -1), scl(c0.Y, 0.55)));
      // (the particle VAO reads progPart's attribute locations: those block until it is linked)
      await U.gl.compiled(gl, [progNoise, progPart]);
      buildParticles(gl, ctx);
      noiseTex = makeNoise(gl, progNoise);
    },

    render(gl, s) {
      const T = s.T, cues = s.cues;
      const P = params(T, cues);
      const cam = cameraAt(T, s.aspect);
      const tier = s.tier;
      const steps = tier === 'high' ? 36 : tier === 'mid' ? 26 : 18;

      updateLut(gl, P.gapGrow, P.gap3, P.cav, P.w3);

      // planet
      const F = cam.F;
      const pPos = F.er; // rho = 1
      const sunCol = blackbodyJS(P.temp);
      const KF = 2 * Math.tan(fovAt(T) / 2);
      // camera inside the thin dust layer? (switch the layer integration to the march)
      const rhoC = Math.hypot(cam.eye[0], cam.eye[2]);
      const hdC = P.hd * 0.018 * Math.pow(Math.max(rhoC, 0.05), 1.12);
      const inL = M.smoothstep(3.2, 1.6, Math.abs(cam.eye[1]) / hdC);

      // planets' orbital angles (theta = atan(-z, x))
      const thE = Math.atan2(-pPos[2], pPos[0]);
      const om = (r) => OMEGA1 * Math.pow(r, -1.5);
      const plAng = [thE, 2.1 + om(2.25) * (T - 75), 0, 0];

      // the sky, and how thin the star field is (thinner still on small screens, where the same
      // field of view holds the same stars on far fewer pixels)
      const sky = skyAt(T);
      const resK = M.smoothstep(400, 720, Math.min(s.width, s.height));
      const th = P.thin;
      // At the hand-off from the milky way scene its finer, fainter field: dimmer bright stars,
      // more faint ones (faint gain relative to the bright layer), narrower
      // (on small screens the same field crowds far fewer pixels: fewer, fainter stars there too)
      const hk = P.hk;
      const thinB = Math.min(P.thinB + 0.08 * hk * (1 - resK), 1);
      const starP = [
        M.mix(0.0175, M.mix(0.0027, 0.0045, resK), thinB),
        M.mix(0.006875, M.mix(0.001, 0.0017, resK), th),
        M.mix(M.mix(1, 0.45, th), M.mix(3, 6.5, resK), hk),
        M.mix(M.mix(1, 1.2, th), 0.75, hk),
      ];
      const starB = P.stars * M.mix(1, 0.4, hk);

      progMain.use().setAll({
        uRes: [s.width, s.height], uT: T, uK: KF, uPix: KF / Math.min(s.width, s.height), uNT: NOISE_N,
        uEye: cam.eye, uX: cam.X, uY: cam.Y, uZ: cam.Z,
        uNoise: 0, uLut: 1, uSteps: steps, uHQ: tier === 'high' ? 1 : 0,
        uSunCol: sunCol, uSunLum: P.lum, uSunCore: P.core, uSunHalo: P.halo, uCorona: P.corona,
        uCloudW: P.cloudW, uRc: RC, uSc: P.sc, uG: P.g, uFy: P.fy, uSpin: P.spin, uTauC: P.tauC, uArm: P.arm,
        uClearR: P.clearR, uRimI: P.rimI, uCloudK: P.cloudK, uAmb: P.amb, uRimDir: rimDir, uRimL: rimL,
        uInGlow: P.inGlow, uDrain: P.drain, uWarp: P.warp, uEdge: P.edge, uRimC: P.rimC,
        uDiskW: P.diskW, uDiskTime: T - 75, uDustK: P.dustK, uThermK: P.thermK, uScatK: P.scatK, uHd: P.hd,
        uWake: P.wake, uPlAng: plAng, uInL: inL, uBandK: P.bandK,
        uShockR: P.shockR, uShockI: P.shockI, uJetI: P.jetI, uJetLen: P.jetLen, uJetAge: P.jetAge,
        uPPos: pPos, uPR: PLANET_R, uPW: P.pw, uCrust: P.crust, uDk: P.dk, uMagT: P.magT, uPTime: T - 75, uPGlow: P.pglow,
        uBurst: P.burst, uEAge: P.eAge, uEnv: P.env, uEnvR: P.envR, uEnvGlow: P.envGlow, uPLum: P.plum,
        uPRot: bodyRot(T, F), uImp: impUniform, uImpF: 1 - M.smoothstep(92.5, 93.1, T),
        uNeb: P.neb, uEvap: P.evap, uStarB: starB, uNebDir: nebDir, uHK: P.hk, uNebX: nebX, uNebY: nebY,
        uSX: sky[0], uSY: sky[1], uSZ: sky[2], uStarP: starP, uStarOcc: P.starOcc, uBlue: 2,
        uCoreG: P.coreG, uCoreC: [1.0, 0.22, 0.07],
      });
      U.gl.bindTexture(gl, 0, noiseTex, gl.TEXTURE_3D);
      U.gl.bindTexture(gl, 1, lutTex);
      U.gl.bindTexture(gl, 2, blueTex);
      U.gl.drawFullscreen(gl);

      // ---- point passes
      const aspect = s.aspect;
      const fov = fovAt(T);
      const fovy = aspect >= 1 ? fov : 2 * Math.atan(Math.tan(fov / 2) / aspect);
      const proj = M.perspective(new Float32Array(16), fovy, aspect, 0.002, 500);
      const view = M.lookAt(new Float32Array(16), cam.eye, cam.tgt, cam.Y);
      const vp = M.multiply(new Float32Array(16), proj, view);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      if (P.partVis > 0) {
        progPart.use().setAll({
          uVP: vp, uEye: cam.eye, uPPos: pPos, uT: T, uDiskTime: T - 75, uVis: P.partVis * P.diskW,
          uPR: P.pw > 0 ? PLANET_R : 0, uMaxPt: Math.min(maxPt, 32), uFlashRate: P.flashRate, uHd: P.hd,
        });
        gl.bindVertexArray(partVao);
        gl.drawArrays(gl.POINTS, 0, partCount);
        gl.bindVertexArray(null);
      }
      // impactors
      let any = false;
      for (let k = 0; k < N_IMP; k++) {
        const im = impacts[k];
        const dtk = im.t - T; // seconds until impact
        let vis = 0;
        const speed = 0.075;
        let head = [0, 0, 0];
        if (dtk > 0 && dtk < 1.4) {
          vis = M.smoothstep(1.4, 0.9, dtk) * 1.5;
          const surf = add(pPos, scl(im.dirW, PLANET_R));
          head = sub(surf, scl(im.vin, speed * dtk));
          any = true;
        }
        headU.set([head[0], head[1], head[2], vis], k * 4);
        velU.set([im.vin[0] * speed, im.vin[1] * speed, im.vin[2] * speed, im.size], k * 4);
      }
      if (any) {
        progImp.use().setAll({ uVP: vp, uHead: headU, uVel: velU, uMaxPt: maxPt, uEye: cam.eye });
        if (!emptyVao) emptyVao = gl.createVertexArray(); // gl_VertexID only
        gl.bindVertexArray(emptyVao);
        gl.drawArrays(gl.POINTS, 0, N_IMP * 14);
        gl.bindVertexArray(null);
      }
      gl.disable(gl.BLEND);
      U.gl.bindTexture(gl, 0, null, gl.TEXTURE_3D);

      // ---- post
      const post = s.post;
      const di = T - cues.sunIgnition;
      // (the theia scene's softer, higher-threshold bloom, under which its dark plates read as dark)
      post.bloom = M.mix(0.85, 0.4, M.smoothstep(91, 93, T));
      post.bloomThreshold = M.mix(0.9, 1.6, M.smoothstep(91, 93, T));
      // the close pass over the sunlit disk is dimmed a little; back to neutral for the hand-off
      post.exposure = 1 - 0.15 * M.smoothstep(84, 87, T) * (1 - M.smoothstep(90.5, 92.5, T));
      if (di >= 0) {
        post.flash = 10 * Math.exp(-di / 0.04) + 0.15 * Math.exp(-di / 0.1);
        post.shake = 0.7 * Math.exp(-di / 0.45);
      } else {
        post.flash = 0;
      }
      const de = T - cues.earthFormed;
      if (de >= 0) {
        post.shake = Math.max(post.shake, 0.18 * Math.exp(-de / 0.35));
        post.flash += 0.03 * Math.exp(-de / 0.06);
      }
      // less colour fringing on the drifting stars over the disk (the default again at the hand-offs)
      post.aberration = 0.12 - 0.085 * M.smoothstep(78, 80, T) * (1 - M.smoothstep(90.5, 92.8, T));
    },
  });

  // CPU blackbody (matches U.glsl blackbody), linear RGB
  function blackbodyJS(k) {
    const t = M.clamp(k, 1000, 40000) / 100;
    const r = t <= 66 ? 1 : M.clamp(1.292936186 * Math.pow(t - 60, -0.1332047592), 0, 1);
    const g = t <= 66 ? M.clamp(0.390081579 * Math.log(t) - 0.631841444, 0, 1) : M.clamp(1.129890861 * Math.pow(t - 60, -0.0755148492), 0, 1);
    const b = t >= 66 ? 1 : t <= 19 ? 0 : M.clamp(0.543206789 * Math.log(t - 10) - 1.196254089, 0, 1);
    return [Math.pow(r, 2.2), Math.pow(g, 2.2), Math.pow(b, 2.2)];
  }
})();
