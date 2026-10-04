// Scene 'theia' (T 93-110): the molten proto-Earth, the approach of Theia, the giant impact,
// the circumplanetary debris disk and the coalescence of the Moon.
//
// Everything is a pure function of film time:
//  * a fullscreen ray-traced pass renders the sky, the proto-Earth, Theia, the Moon, the analytic
//    debris disk, the impact fireball and the vapour halo, and writes gl_FragDepth for the bodies;
//  * the impact plume is a set of instanced, motion-stretched particles on analytic Kepler orbits
//    (osculating elements that circularise into the disk), depth-tested against the bodies.
//
// View space throughout: camera at the origin looking down -z, light fixed at
// normalize(-1, .25, .6). Camera moves are done by moving the Earth's centre. Unit = Earth radius.
(function () {
  'use strict';
  const U = window.U;
  const M = U.math;

  // ------------------------------------------------------------------ small vector helpers
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const len = (a) => Math.hypot(a[0], a[1], a[2]);
  const norm = (a) => mul(a, 1 / (len(a) || 1));
  const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const ss = M.smoothstep;
  // Rotation matrix (column-major mat3) about unit axis k by angle th.
  function rotMat(k, th) {
    const c = Math.cos(th), s = Math.sin(th), t = 1 - c;
    const [x, y, z] = k;
    const o = new Float32Array(9);
    o[0] = c + x * x * t; o[1] = y * x * t + z * s; o[2] = z * x * t - y * s;
    o[3] = x * y * t - z * s; o[4] = c + y * y * t; o[5] = z * y * t + x * s;
    o[6] = x * z * t + y * s; o[7] = y * z * t - x * s; o[8] = c + z * z * t;
    return o;
  }
  const mat3Vec = (m, v) => [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]];

  // ------------------------------------------------------------------ constants & geometry
  // Camera: tan(half fov) across the shorter screen side. It starts at 17 degrees and eases to
  // the earth scene's 15 degrees (fov 30) before hand-off 7, so that 108-110 is the same camera.
  const TH_A = Math.tan((17 * Math.PI) / 180);
  const TH_B = Math.tan((15 * Math.PI) / 180);
  const thAt = (T) => M.mix(TH_A, TH_B, ss(103.5, 107.5, T));
  const distFor = (th) => Math.sqrt(1 + 1 / (0.36 * th * th)); // camera distance for radius 0.30
  const TH = TH_A, D0 = distFor(TH_A);
  const LIGHT = norm([-1, 0.25, 0.6]);
  const NEAR = 0.05, FAR = 400;
  const DEPTH_A = (FAR + NEAR) / (NEAR - FAR), DEPTH_B = (2 * FAR * NEAR) / (NEAR - FAR);
  const P1 = 1.5; // circular orbital period at the surface (orbital-clock seconds)
  const MU = (2 * Math.PI / P1) ** 2;
  const SQMU = Math.sqrt(MU);
  const THEIA_R = 0.5;
  const MOON_R = 0.27;

  // Hand-off 7 conventions shared with the 'earth' scene (src/scenes/earth.js): fov 30, the
  // debris-ring normal below, its ring/Moon parameters and globe orientation.
  const N_UP = norm([0.12, 0.96, 0.26]);
  function earthSceneMoon(T) {
    const m = ss(108, 113, T);
    return [M.mix(1.45, 2.4, m), M.mix(1.15, 1.9, m), M.mix(-1.0, -3.0, m)];
  }
  const MOON_108 = earthSceneMoon(108);
  // smoothstep-interpolated keys (same as the earth scene's keys())
  function keys(k, x) {
    if (x <= k[0][0]) return k[0][1];
    for (let i = 1; i < k.length; i++) {
      if (x <= k[i][0]) {
        const a = k[i - 1], b = k[i];
        const u = (x - a[0]) / (b[0] - a[0]);
        return a[1] + (b[1] - a[1]) * u * u * (3 - 2 * u);
      }
    }
    return k[k.length - 1][1];
  }
  // view -> Earth-fixed rotation (same construction as U.earth.viewToEarth)
  function viewToEarth(latDeg, lonDeg, rollDeg) {
    const D2R = Math.PI / 180;
    const la = latDeg * D2R, lo = lonDeg * D2R;
    const c = [Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)];
    const u = norm([-c[1] * c[0], 1 - c[1] * c[1], -c[1] * c[2]]);
    const r = cross(u, c);
    const a = rollDeg * D2R, ca = Math.cos(a), sa = Math.sin(a);
    const r2 = add(mul(r, ca), mul(u, sa)), u2 = add(mul(r, -sa), mul(u, ca));
    return new Float32Array([r2[0], r2[1], r2[2], u2[0], u2[1], u2[2], c[0], c[1], c[2]]);
  }

  // Disk plane = the earth scene's ring plane. ND is oriented so that prograde rotation carries
  // the contact point (right limb) toward the camera.
  function inPlane(v) { return norm(sub(v, mul(N_UP, dot(v, N_UP)))); }
  const PA = inPlane([1, 0, 0]);
  const PC = inPlane([0, 0, 1]);
  const CONTACT_A = 0.0; // contact azimuth in the disk plane (0 = on the right limb)
  const NC = inPlane(add(mul(PA, Math.cos(CONTACT_A)), mul(PC, Math.sin(CONTACT_A)))); // contact normal
  let ND = mul(N_UP, -1);
  if (cross(ND, NC)[2] < 0) ND = N_UP;
  const D1 = NC; // disk basis: phi = 0 at the contact, increasing prograde
  const D2 = cross(ND, D1);
  const UPV = dot(ND, [0, 1, 0]) < 0 ? mul(ND, -1) : ND; // disk normal pointing up on screen

  // Theia's path: a gravity-bent arc from the upper-right background ending with an oblique
  // (55 degrees from vertical) contact on the right limb, moving prograde.
  const IMPACT_ANG = (55 * Math.PI) / 180; // from the local vertical
  const TANG_B = 0.5; // tilt of the approach out of the disk plane
  const TANG = norm(add(mul(D2, -Math.cos(TANG_B)), mul(UPV, Math.sin(TANG_B)))); // back along the tangent
  const BHAT = norm(add(mul(NC, Math.cos(IMPACT_ANG)), mul(TANG, Math.sin(IMPACT_ANG)))); // back along the path
  const FWD = norm(lerp3(D2, mul(TANG, -1), 0.5)); // tangential direction the ejecta are thrown
  const P_C = mul(NC, 1 + THEIA_R);
  const LAMBDA = 2.0;
  const P_CTRL = add(P_C, mul(BHAT, LAMBDA));
  // Where Theia first appears (screen position, deep in the background); framed per aspect.
  const FAR_Z = 34;
  function farPoint(aspect) {
    const pf = 1 - ss(0.7, 1.2, aspect);
    const qx = M.mix(0.64, 0.3, pf), qy = M.mix(0.38, 0.44, pf);
    return [qx * 2 * TH * FAR_Z, qy * 2 * TH * FAR_Z, D0 - FAR_Z];
  }
  // The solarsystem scene's protoplanetary disk is seen exactly edge-on at the hand-off: its
  // midplane (view space, through the camera) is the plane with this normal.
  const BAND_N = norm([0.24258, 0.97013, 0.00008]);
  // Its camera co-orbits with the planet (src/scenes/solarsystem.js, cameraAt for T >= 93): view
  // basis XL, YL, ZL in the orbit's local frame (e_r, e_t, e_n), angle PHI0 + OMEGA1 (T - 75).
  // Its star field therefore drifts at the orbital rate; here the drift eases to rest over 95-97
  // so that the impact happens under a locked-off sky (the late field is static).
  const SS_OMEGA1 = (2 * Math.PI) / 90, SS_PHI0 = 0.6;
  const SS_RV = mul(LIGHT, -1);
  const SS_NV = (() => { const nt = [0, 1, 0.14128]; return norm(sub(nt, mul(SS_RV, dot(nt, SS_RV)))); })();
  const SS_TV = cross(SS_NV, SS_RV);
  const SS_B = [0, 1, 2].map((i) => [SS_RV[i], SS_TV[i], SS_NV[i]]); // XL, YL, ZL
  function earlySky(T) {
    const u = M.clamp((T - 95) / 2, 0, 1);
    const te = Math.min(T, 95) + 2 * u - 2 * (u * u * u - 0.5 * u * u * u * u);
    const ph = SS_PHI0 + SS_OMEGA1 * (te - 75), c = Math.cos(ph), sn = Math.sin(ph);
    const l2w = (v) => [c * v[0] - sn * v[1], v[2], -sn * v[0] - c * v[1]];
    return new Float32Array([...l2w(SS_B[0]), ...l2w(SS_B[1]), ...l2w(SS_B[2])]);
  }
  // The early field is drawn as sprites from a catalogue of its stars: those of the core
  // starLayer() (same hashes, ported) whose cell can light a pixel inside the cone the camera sees
  // over 93-99 at aspect ratios up to STAR_AMAX (wider screens fall back to the per-pixel field).
  const STAR_AMAX = 2.4;
  const STAR_CONE = (() => {
    const v0 = mul(earlySky(93).slice(6, 9), -1), v1 = mul(earlySky(97).slice(6, 9), -1);
    const axis = norm(add(v0, v1));
    const drift = Math.acos(M.clamp(dot(v0, v1), -1, 1)) / 2;
    const beta = Math.atan(TH_A * Math.sqrt(STAR_AMAX * STAR_AMAX + 1)) + drift + 0.02;
    return { axis, drift, beta };
  })();
  const f32 = Math.fround;
  function uh32(x) {
    x ^= x >>> 16; x = Math.imul(x, 0x7feb352d); x ^= x >>> 15; x = Math.imul(x, 0x846ca68b); x ^= x >>> 16;
    return x >>> 0;
  }
  // (a generator: init() runs it in time slices, see sliced())
  function* starCatalogue(out, scale, density, seed, axis, beta) {
    const INV = 1 / 4294967296;
    // (+ the Gaussian's reach and the jitter range around the cell centre, in cells)
    const cosB = Math.cos(beta + 3.0 / scale);
    const off = f32(seed * f32(17.13)), dens = f32(density), R = scale, R2 = R * R, s131 = seed * 131;
    const lim = R * 0.75 + 3, iLo = Math.floor(-lim + off), iHi = Math.ceil(lim + off);
    const capC = Math.cos(Math.min(Math.acos(cosB) + 0.9553 + 0.02, Math.PI));
    // a cell can light the pixels whose p = dir * scale + off lies in [cell - 0.5, cell + 1.5)^3;
    // scan columns of cells along each cube-face axis, each cell owned by its dominant axis
    for (let k = 0; k < 3; k++) {
      const a = (k + 1) % 3, b = (k + 2) % 3;
      const axA = axis[a], axB = axis[b], axK = axis[k];
      for (let sg = -1; sg <= 1; sg += 2) {
        if (sg * axK < capC) continue;
        for (let i = iLo; i <= iHi; i++) {
          const u0 = i - 0.5 - off, u1 = i + 1.5 - off, cu = i + 0.5 - off;
          if (Math.abs(cu) > R * 0.72 + 3) continue;
          const uMin2 = u0 > 0 ? u0 * u0 : u1 < 0 ? u1 * u1 : 0, uMax2 = Math.max(u0 * u0, u1 * u1);
          for (let j = iLo; j <= iHi; j++) {
            const v0 = j - 0.5 - off, v1 = j + 1.5 - off, cv = j + 0.5 - off;
            if (Math.abs(cv) > R * 0.72 + 3) continue;
            const vMin2 = v0 > 0 ? v0 * v0 : v1 < 0 ? v1 * v1 : 0, vMax2 = Math.max(v0 * v0, v1 * v1);
            const rMin2 = uMin2 + vMin2, rMax2 = uMax2 + vMax2;
            if (rMin2 > R2) continue;
            const zHi = Math.sqrt(R2 - rMin2), zLo = rMax2 < R2 ? Math.sqrt(R2 - rMax2) : 0;
            const ck = sg * 0.5 * (zLo + zHi);
            const ca = cu * axA + cv * axB + ck * axK;
            if (ca / Math.sqrt(cu * cu + cv * cv + ck * ck) < cosB - 4 / R - (zHi - zLo) / R) continue;
            const pLo = sg > 0 ? zLo : -zHi, pHi = sg > 0 ? zHi : -zLo;
            const cEnd = Math.floor(pHi + off + 0.5);
            const au = Math.abs(cu), av = Math.abs(cv);
            for (let c = Math.ceil(pLo + off - 1.5); c <= cEnd; c++) {
              const cc = c + 0.5 - off;
              if ((cc > 0 ? 1 : -1) !== sg) continue;
              // owned by axis k: |cc| is the largest component (ties as in the reference scan)
              const ak = Math.abs(cc);
              if (k === 0 ? !(ak >= au && ak >= av) : k === 1 ? !(ak > av && ak >= au) : !(ak > au && ak > av)) continue;
              const x = k === 0 ? c : k === 1 ? j : i, y = k === 0 ? i : k === 1 ? c : j, z = k === 0 ? j : k === 1 ? i : c;
              const h1 = uh32(((x + s131) >>> 0) ^ uh32(((y + s131) >>> 0) ^ uh32((z + s131) >>> 0)));
              if (f32(h1) * INV > dens) continue;
              const h2 = uh32(h1), h3 = uh32(h2);
              const s0 = x + 0.5 - off, s1 = y + 0.5 - off, s2 = z + 0.5 - off; // (cell centre)
              const sl = Math.sqrt(s0 * s0 + s1 * s1 + s2 * s2);
              if ((s0 * axis[0] + s1 * axis[1] + s2 * axis[2]) / sl < cosB) continue;
              out.push(s0 / sl, s1 / sl, s2 / sl, scale, x, y, z, seed, f32(h2) * INV, f32(h3) * INV);
            }
          }
          yield;
        }
      }
    }
    return out;
  }
  const T_PATH0 = 93.0;
  const TAU0 = 0.45;

  // ------------------------------------------------------------------ time functions
  // Warped orbital clock (seconds since impact); motion settles as the film moves on.
  const W_SPLIT = 2.5, W_MIN = 0.14, W_K = 3.0;
  function orbClock(tau) {
    if (tau <= W_SPLIT) return tau;
    const x = tau - W_SPLIT;
    return W_SPLIT + W_MIN * x + (1 - W_MIN) * W_K * (1 - Math.exp(-x / W_K));
  }

  function theiaPath(T, tImp, aspect) {
    const P_FAR = farPoint(aspect);
    // free-fall-like acceleration toward the contact
    const tau = Math.max(0, tImp - T);
    const remK = Math.pow(tImp - T_PATH0 + TAU0, 2 / 3) - Math.pow(TAU0, 2 / 3);
    const rem = (Math.pow(tau + TAU0, 2 / 3) - Math.pow(TAU0, 2 / 3)) / remK;
    const u = 1 - Math.min(1, rem);
    const a = (1 - u) * (1 - u), b = 2 * u * (1 - u), c = u * u;
    return add(add(mul(P_FAR, a), mul(P_CTRL, b)), mul(P_C, c));
  }
  function contactSpeed(tImp) {
    const remK = Math.pow(tImp - T_PATH0 + TAU0, 2 / 3) - Math.pow(TAU0, 2 / 3);
    return 2 * LAMBDA * ((2 / 3) * Math.pow(TAU0, -1 / 3) / remK);
  }

  // Theia after contact: ploughs on along its path, sinks, flattens and dissolves.
  function theiaAfter(tau, vC) {
    const td = 0.4;
    const s = vC * td * (1 - Math.exp(-tau / td));
    const raw = add(P_C, mul(BHAT, -s));
    const sink = ss(0, 1.8, tau);
    const dist = M.mix(1 + THEIA_R, 0.62, sink);
    return {
      c: mul(norm(raw), dist),
      r: THEIA_R * (1 - 0.35 * ss(0.1, 1.6, tau)),
      k: 1 - 0.45 * ss(0.0, 0.9, tau),
    };
  }

  // Earth spin (rad), spun up by the impact to the earth scene's 9 deg/s.
  const W_PRE = 0.1, W_POST = (9 * Math.PI) / 180;
  function spinAngle(T, tImp) {
    let ramp = 0;
    if (T > tImp) {
      const u = Math.min(1, T - tImp);
      ramp = u * u * u - (u * u * u * u) / 2;
      if (T > tImp + 1) ramp = 0.5 + (T - tImp - 1);
    }
    return W_PRE * (T - 93) + (W_POST - W_PRE) * ramp;
  }
  // Globe orientation: identical to the earth scene's (lat 15, lon -85 + 9 deg/s, roll -7) from 108.
  function earthRot(T, tImp) {
    const lon = -85 + ((spinAngle(T, tImp) - spinAngle(108, tImp)) * 180) / Math.PI;
    const roll = -7 + (T > 108 ? 0.5 * (T - 108) : 0);
    return viewToEarth(15, lon, roll);
  }

  // The Moon (and the clump it grows from): drifts out to the hand-off position, then follows
  // the earth scene's path.
  const MOON_START = add(mul(inPlane(MOON_108), 2.15), mul(UPV, 0.45));
  function moonRel(T) {
    if (T >= 108) return earthSceneMoon(T);
    const u = M.clamp((T - 101.5) / (108 - 101.5), 0, 1);
    const f = (1 - u) * (1 - u) * (1 - u);
    return lerp3(MOON_108, MOON_START, f);
  }

  // Catmull-Rom (Hermite) through camera keys [T, distFactor, qx, qy].
  const CAM_KEYS = [
    [91, 1.01, 0, 0],
    [93, 1.0, 0, 0],
    [95, 0.985, 0, 0],
    [97, 0.95, -0.035, -0.012],
    [99, 0.885, -0.1, -0.03],
    [100.3, 0.9, -0.09, -0.025],
    [102.6, 1.1, -0.03, 0.0],
    [104.6, 1.12, 0.0, 0.0],
    [106.6, 1.04, 0, 0],
    [108, 1.0, 0, 0],
    [110, 1.0, 0, 0],
    [112, 1.0, 0, 0],
  ];
  function camKey(T, idx) {
    const k = CAM_KEYS;
    let i = 1;
    while (i < k.length - 2 && T > k[i + 1][0]) i++;
    const p0 = k[i - 1], p1 = k[i], p2 = k[i + 1], p3 = k[Math.min(k.length - 1, i + 2)];
    const u = M.clamp((T - p1[0]) / (p2[0] - p1[0]), 0, 1);
    const h = p2[0] - p1[0];
    const m1 = ((p2[idx] - p0[idx]) / (p2[0] - p0[0])) * h;
    const m2 = ((p3[idx] - p1[idx]) / (p3[0] - p1[0] || 1)) * h;
    const u2 = u * u, u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * p1[idx] + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * p2[idx] + (u3 - u2) * m2;
  }
  // Earth centre in view space. Portrait pulls back and shifts during the action so both bodies
  // and the plume stay in frame.
  function earthCentre(T, aspect) {
    const pf = 1 - ss(0.7, 1.2, aspect);
    const act = ss(94.6, 98.6, T) * (1 - ss(102.2, 107.4, T));
    let df = camKey(T, 1), qx = camKey(T, 2), qy = camKey(T, 3);
    df *= 1 + pf * 0.5 * act;
    qx = M.mix(qx, -0.13 * act, pf);
    qy = M.mix(qy, -0.16 * act, pf);
    const th = thAt(T);
    const D = distFor(th) * df;
    return [qx * 2 * th * D, qy * 2 * th * D, -D];
  }

  // ------------------------------------------------------------------ shaders
  const COMMON = `
float bright(float k) {           // radiance scale of incandescent rock (shared with the solarsystem scene's planet)
  float x = k / 1500.0;
  return x < 1.27 ? 1.6 * x * x * x * x : 4.161 * pow(x / 1.27, 1.5);
}
vec3 emitK(float k) { return blackbody(k) * bright(k); }
`;

  // A star's direction from its cell (the core starLayer() jitter). Shared verbatim by the
  // per-pixel field and the star sprites so that both compile to the same float arithmetic.
  const STAR_DIR = `
vec3 starDir(vec3 cell, float seed) {
  vec3 sp = cell + 0.2 + 0.6 * hash33(cell * 1.7 + 11.0 + seed);
  return normalize(sp - seed * 17.13);
}
`;

  // The star field (its own small program renders it into a cache while the camera holds still).
  const STARS = `
${STAR_DIR}
uniform mat3 uSkyE;    // view -> world of the solarsystem scene's camera (its star field)
uniform vec4 uSkyP;    // early stars, late stars, dust band, atmosphere strength (late)
uniform vec2 uSkyTH;   // tan(half fov) of the early and of the late star field
uniform vec3 uBandN;   // view-space normal of the edge-on protoplanetary dust band
float sqS(float x) { return x * x; }
// The core starLayer() with the per-cell hash split, so an empty cell costs one hash chain
// instead of three (bit-identical output).
vec3 starL(vec3 dir, float scale, float px, float density, float seed) {
  vec3 p = dir * scale + seed * 17.13;
  vec3 base = floor(p - 0.5);
  vec3 col = vec3(0.0);
  float sigma = max(px * scale * 0.85, 0.02);
  for (int k = 0; k < 8; k++) {
    vec3 cell = base + vec3(float(k & 1), float((k >> 1) & 1), float((k >> 2) & 1));
    uint h1 = uhash(uvec3(ivec3(floor(cell + seed * 131.0))));
    float hx = float(h1) * (1.0 / 4294967296.0);
    if (hx > density) continue;
    uint h2 = uhash(h1), h3 = uhash(h2);
    vec3 h = vec3(hx, float(h2) * (1.0 / 4294967296.0), float(h3) * (1.0 / 4294967296.0));
    float d = length(dir - starDir(cell, seed)) * scale;
    float mag = pow(h.y, 5.0);
    float bright = 0.02 + 0.12 * h.y * h.y + 12.0 * mag * mag;
    float w = exp(-0.5 * (d * d) / (sigma * sigma));
    vec3 tint = blackbody(mix(3200.0, 12000.0, h.z * h.z));
    col += tint * bright * w * (px * scale < 0.5 ? 1.0 : 0.5 / (px * scale));
  }
  return col;
}

// The star fields at screen position q (unweighted). The early one is the solarsystem scene's,
// seen through its co-orbiting camera; it is normally drawn as sprites from a star catalogue
// (see starCatalogue), this is the reference / fallback. The late one is the earth scene's field
// and faint Milky Way, drawn with the final (hand-off 7) fov throughout: it appears under the
// impact flash and then stays put through the push-in (cached).
vec3 earlyStars(vec2 q, float minRes) {
  vec3 rd = normalize(vec3(q * 2.0 * uSkyTH.x, -1.0));
  float px = 2.0 * uSkyTH.x / minRes;
  vec3 d = uSkyE * rd;
  vec3 s = starL(d, 200.0, px, 0.014, 1.0);
#if Q > 1
  s += starL(d, 470.0, px, 0.0055, 3.0);
#endif
  return s * 0.75;
}
vec3 lateStars(vec2 q, float minRes) {
  vec3 rd = normalize(vec3(q * 2.0 * uSkyTH.y, -1.0));
  float px = 2.0 * uSkyTH.y / minRes;
  vec3 e = (starL(rd, 180.0, px, 0.006, 1.0) + starL(rd, 420.0, px, 0.0014, 2.0)) * 0.55;
  float mw = exp(-sqS(dot(rd, normalize(vec3(0.3, 0.9, -0.3))) * 3.2));
  float n = fbm(rd * 3.0 + 4.0, 3) * 0.5 + 0.5;
  return e + vec3(0.010, 0.009, 0.012) * mw * n * n;
}

// The protoplanetary disk seen edge-on (93-99): a soft dusty band through the planet.
// Returns (dust radiance, star dimming).
vec4 dustBand(vec3 rd) {
  float b = dot(rd, uBandN);
  float n = fbm(rd * vec3(5.0, 9.0, 5.0) + vec3(1.0, 2.0, 3.0), 3);
  // (thicker to the right, where the line of sight runs outward through the nearby ring)
  float wB = 1.0 + 1.1 * smoothstep(-0.2, 0.35, rd.x / max(-rd.z, 1e-3));
  float g = exp(-sqS((b + 0.004 * n) / (0.018 * wB)));
  float g2 = exp(-sqS(b / (0.06 * wB)));
  vec3 dust = vec3(0.165, 0.05, 0.0075) * g * (0.85 + 0.3 * n) + vec3(0.02, 0.006, 0.0015) * g2;
  dust += vec3(0.006, 0.0024, 0.0016) * (0.7 + 0.3 * n); // faint warm glow of the inner system
  return vec4(dust, 0.45 * g);
}

`;
  const SKY_FS = (q) => U.glsl.frag(`
#define Q ${q}
in vec2 vUv;
out vec4 o;
uniform vec2 uRes;
uniform float uTH;
uniform int uMode;     // 0: star field, 1: dust band
${STARS}
void main() {
  vec2 q = (vUv - 0.5) * uRes / min(uRes.x, uRes.y);
  if (uMode == 0) o = vec4(lateStars(q, min(uRes.x, uRes.y)), 1.0);
  else o = dustBand(normalize(vec3(q * 2.0 * uTH, -1.0)));
}
`);

  // A periodic gradient-noise volume for the debris disk (one texture fetch per octave instead
// of a simplex evaluation). Period NOISE_C cells, NOISE_R texels per cell; the noise is stored
// as n * 0.75 + 0.5 and read back as 2n, which matches the core snoise() in standard deviation
// (0.38), and is sampled 1.75x finer, which matches its correlation length.
  const NOISE_C = [32, 32, 8], NOISE_R = 8;
  const NOISE_FS = U.glsl.frag(`
in vec2 vUv;
out vec4 o;
uniform float uZ;
const vec3 NP = vec3(${NOISE_C.map((v) => v.toFixed(1)).join(', ')});
vec3 gradP(vec3 i) {
  uint h = uhash(uvec3(mod(i, NP)));
  float u = float(h & 0xffffu) * (2.0 / 65535.0) - 1.0;
  float a = float(h >> 16) * (6.2831853 / 65535.0);
  float s = sqrt(max(1.0 - u * u, 0.0));
  return vec3(s * cos(a), s * sin(a), u);
}
float corner(vec3 i, vec3 f, vec3 o) { return dot(gradP(i + o), f - o); }
void main() {
  vec3 p = vec3(vUv, uZ) * NP;
  vec3 i = floor(p), f = p - i;
  vec3 w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float x00 = mix(corner(i, f, vec3(0, 0, 0)), corner(i, f, vec3(1, 0, 0)), w.x);
  float x10 = mix(corner(i, f, vec3(0, 1, 0)), corner(i, f, vec3(1, 1, 0)), w.x);
  float x01 = mix(corner(i, f, vec3(0, 0, 1)), corner(i, f, vec3(1, 0, 1)), w.x);
  float x11 = mix(corner(i, f, vec3(0, 1, 1)), corner(i, f, vec3(1, 1, 1)), w.x);
  float n = mix(mix(x00, x10, w.y), mix(x01, x11, w.y), w.z);
  o = vec4(n * 0.75 + 0.5, 0.0, 0.0, 1.0);
}`);

  const FS = (q) => U.glsl.frag(`
#define Q ${q}
${COMMON}
in vec2 vUv;
out vec4 o;
uniform vec2 uRes;
uniform float uTH;
uniform vec2 uDepthAB;
uniform vec3 uL;
uniform float uT;
uniform vec3 uE;
uniform mat3 uERot;
uniform vec3 uCB;
uniform vec3 uCV;
uniform vec3 uCN;
uniform vec4 uShock;   // front angle, ring amp, melt (0/1), base temperature K
uniform vec4 uEarthP;  // plate crust coverage, atmosphere height (late), -, halo intensity
uniform vec4 uEarthP2; // wound heat K, raft crust (late), halo temperature, halo scale height
uniform vec4 uTh;      // centre, radius
uniform vec4 uThAx;    // squash axis, axis scale
uniform mat3 uThRot;
uniform vec4 uThP;     // heat, visibility, seam glow, disintegration
uniform vec4 uMo;      // centre, radius
uniform mat3 uMoRot;
uniform vec4 uMoP;     // heat, visibility, glow, -
uniform vec3 uNd;
uniform vec3 uD1;
uniform vec3 uD2;
uniform vec4 uDisk;    // brightness, inner radius, outer radius, orbital clock
uniform vec4 uDisk2;   // temperature K, sqrt(mu), clump, late ring (0..1)
uniform vec4 uGlow;    // fireball intensity, fireball radius, point light, pre-contact glow
uniform vec4 uGlow2;   // fireball temperature K
uniform int uEarlyS;   // 1: the early star field is drawn by the star sprites (alpha = their transmittance)
uniform int uSkyC;     // 1: the late star field is read from its cache
uniform sampler2D uSkyTex;
uniform int uBandC;    // 1: the dust band is read from its cache
uniform sampler2D uBandTex;
uniform highp sampler3D uNoise; // periodic noise volume (disk)
uniform mat3 uERotA;   // body frame of the pre-impact plates (the solarsystem scene's)
uniform vec4 uLate;    // blend to the earth scene's Hadean look, crust, crack glow, magma
uniform vec4 uCool;    // dark basalt plates (pre-impact), sunlit day side / night limb, magma-ocean glow, magma-ocean night limb

const vec3 SUN = vec3(1.0, 0.93, 0.84);
const float SUN_E = 1.5;              // the earth scene's sun intensity
#define ATMO_E (vec3(0.95, 0.55, 0.32) * uSkyP.w) // its Hadean atmosphere colour * strength
float sq(float x) { return x * x; }
float phiN(float x) { return 1.0 / (1.0 + exp(-2.407 * x)); } // ~0.5*(1+erf(x))

// F1, F2 and a per-cell hash.
vec3 worley(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  float d1 = 9.0, d2 = 9.0, id = 0.0;
  for (int z = -1; z <= 1; z++)
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec3 g = vec3(float(x), float(y), float(z));
    vec3 h = hash33(i + g);
    vec3 r = g + 0.1 + h * 0.8 - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; id = fract(h.x * 7.13 + h.y * 3.1); }
    else if (d < d2) { d2 = d; }
  }
  return vec3(sqrt(d1), sqrt(d2), id);
}

// Ray (from the origin) vs ellipsoid: sphere radius r squashed by factor k along unit axis ax.
// Returns (t, coverage); anti-aliased silhouette from the closest-approach distance.
vec2 ellipsoid(vec3 rd, vec3 c, float r, vec3 ax, float k, float pxw, out vec3 nrm) {
  vec3 oc = -c;
  float kk = 1.0 / k;
  vec3 o2 = oc + ax * dot(ax, oc) * (kk - 1.0);
  vec3 d2 = rd + ax * dot(ax, rd) * (kk - 1.0);
  float A = dot(d2, d2), B = dot(o2, d2), C = dot(o2, o2) - r * r;
  float tc = -B / A;
  float dist = sqrt(max(dot(o2, o2) - B * B / A, 0.0) / A);
  float w = pxw * max(tc, 0.1) * 0.9;
  float cov = smoothstep(r + w, r - w, dist * sqrt(A));
  float h = B * B - A * C;
  float t = h > 0.0 ? (-B - sqrt(h)) / A : tc;
  if (tc < 0.0) { cov = 0.0; t = 1e9; }
  vec3 p = rd * t - c;
  nrm = normalize(p + ax * dot(ax, p) * (kk * kk - 1.0));
  return vec2(t, cov);
}

${STARS}
vec3 sky(vec2 q, vec3 rd, out float tS) {
  float minRes = min(uRes.x, uRes.y);
  ivec2 pc = ivec2(gl_FragCoord.xy);
  vec3 c = vec3(0.0);
  if (uSkyP.x > 0.0 && uEarlyS == 0) c += earlyStars(q, minRes) * uSkyP.x;
  if (uSkyP.y > 0.0) c += (uSkyC == 1 ? texelFetch(uSkyTex, pc, 0).rgb : lateStars(q, minRes)) * uSkyP.y;
  tS = 1.0;
  if (uSkyP.z > 0.0) {
    vec4 bd = uBandC == 1 ? texelFetch(uBandTex, pc, 0) : dustBand(rd);
    tS = 1.0 - bd.a * uSkyP.z;
    c = c * tS + bd.rgb * uSkyP.z;
  }
  return c;
}

// --------------------------------------------------------------- the proto-Earth
vec3 impactLight(vec3 p, vec3 nv) {
  vec3 lp = uCV + uCN * 0.3 - p;
  float ld2 = dot(lp, lp);
  return emitK(4500.0) * (uGlow.z / (ld2 + 0.08)) * max(dot(nv, lp * inversesqrt(ld2)), 0.0) * 0.0015;
}

vec3 shadeEarth(vec3 p, vec3 nv, vec3 rd) {
  vec3 nb = uERot * nv;     // earth-fixed frame of the earth scene (magma ocean)
  vec3 na = uERotA * nv;    // frame of the pre-impact plates (as in the solarsystem scene)
  float mu = max(dot(nv, -rd), 0.0);
  float ndl = dot(nv, uL);
  float diff = max(ndl, 0.0);
  // after the impact, as it cools (uCool.y, ~101.5-108): the night limb darkens, the day side is sunlit
  float dayF = smoothstep(-0.3, 0.5, ndl);
  float nightK = mix(1.0, mix(0.3, 1.0, smoothstep(-0.25, 0.8, ndl)), uCool.y);

  // shock front / melting (after the impact)
  float ang = 0.0, front = 0.0, melt = 0.0;
  if (uShock.z > 0.0) {
    ang = acos(clamp(dot(nb, uCB), -1.0, 1.0));
    front = uShock.x * (1.0 + 0.12 * snoise(nb * 2.5 + 5.0)) + 0.04 * snoise(nb * 9.0);
    melt = smoothstep(front + 0.03, front - 0.3, ang);
  }
  vec3 plates = vec3(0.0);
  float Tm = 1500.0;
  if (melt < 1.0) {
  // ---- plates (pre-impact). With uCool.x = 0 this is exactly the solarsystem scene's proto-Earth
  // (its planetShade), which it hands over at 93-95; uCool.x -> 1 (93-96) cools the plates to dark
  // basalt: near-black sunlit rock with a dull red glow that brightens toward the seams, the seams
  // the brightest orange, and a few dark rafts floating on the open magma.
  float dk = uCool.x;
  vec3 wa = vec3(snoise(na * 1.15 + vec3(0.2, 0.4, 0.1)), snoise(na * 1.15 + vec3(5.1, 1.3, 2.7)), snoise(na * 1.15 + vec3(9.4, 7.2, 3.3)));
  vec3 w = na + wa * 0.3;
  vec3 v = worley(w * 2.7);
  float edge = v.y - v.x;
  float nB = 0.5 + 0.5 * snoise(w * 0.9 + vec3(0.5, 0.1, 0.7));
  float nC = 0.5 + 0.6 * fbm(w * 2.6 + vec3(0.1, 0.6, 0.3) - uT * 0.006, Q > 1 ? 4 : 3);
  float nD = 0.5 + 0.5 * snoise(w * 7.0 + vec3(0.7, 0.3, 0.5));
  float crustSel = v.z * 0.65 + nB * 0.7 - 0.35;
  float crust = smoothstep(0.0, 0.05, uEarthP.x - crustSel);
  // (the dark plates' seams are of uneven width: wide open rifts in places, near-closed in others)
  float crW = mix(0.035 + 0.05 * nD, 0.024 + 0.075 * nD * nD + 0.035 * smoothstep(0.55, 0.85, nB), dk);
  float crack = 1.0 - smoothstep(0.0, crW, edge);
  crust *= 1.0 - crack;
  float heat = clamp(nC * 0.9 + nD * 0.35 - 0.3, 0.0, 1.0);
  heat = mix(heat, 1.0, crack * 0.7);
  Tm = 1150.0 + 750.0 * heat;
  float rough = 0.6 + 0.8 * nD;
  vec3 crustRad = vec3(0.075, 0.068, 0.062) * rough * SUN * 2.6 * diff + blackbody(950.0) * 0.06 * (0.5 + nB);
  float cover = crust;
  if (dk > 0.0) {
    // rafts: crust floes on the open magma
    float rn = snoise(w * 4.6 + vec3(2.1, 7.7, 4.4)) + 0.3 * nD - 0.15 * nB;
    float raft = smoothstep(0.42, 0.5, rn) * (1.0 - crust) * (1.0 - crack);
    cover = mix(crust, crust + raft, dk);
    // the open magma a little cooler than the seams, which stay the brightest
    Tm -= 160.0 * dk * (1.0 - crack) * (1.0 - heat * 0.5);
    float thin = exp(-edge / 0.024) * (0.4 + 0.6 * nD);  // thin, hot crust right along the seams
    float rim = smoothstep(0.42, 0.5, rn) * (1.0 - smoothstep(0.5, 0.62, rn)) * (1.0 - crust); // raft edges
    // hairline cracks in the plates, glowing dull red where the crust is thinnest
    float hc = pow(1.0 - abs(snoise(w * 10.0 + vec3(3.1, 0.4, 8.2))), 10.0) * smoothstep(0.35, 0.8, nB);
    vec3 basalt = vec3(0.009, 0.0085, 0.008) * (0.7 + 0.6 * nD) * SUN * 2.6 * diff
                + blackbody(1000.0) * (0.002 + 0.02 * nB * smoothstep(0.45, 0.95, nC))
                + emitK(1000.0 + 120.0 * hc) * hc * 0.12
                + emitK(1080.0 + 250.0 * thin) * (thin * 0.3 + rim * 0.2);
    crustRad = mix(crustRad, basalt, dk);
  }
  vec3 magma = emitK(Tm);
  plates = mix(magma, crustRad, cover) + (1.0 - cover) * SUN * 0.12 * diff * nD;
  }

  vec3 col = plates;
  float late = uLate.x;
  if (uShock.z > 0.0) {
    // ---- after the impact: shock front, global melting, magma ocean
    float ring = exp(-sq((ang - front) / 0.08)) * uShock.y;
    // convecting magma ocean (the earth scene's convection field)
    vec3 lp = nb * 3.0;
    vec3 wv = vec3(snoise(lp + uT * 0.05), snoise(lp + 9.0 - uT * 0.04), snoise(lp + 21.0));
    float conv = fbm(nb * 2.2 + wv * 0.4 + vec3(0.0, uT * 0.02, 0.0), Q > 1 ? 4 : 3) * 0.5 + 0.5; // (the earth's OCT_HI)
    float Tk = mix(1150.0, 1950.0, conv) + uShock.w * (0.6 + 0.8 * conv) + uEarthP2.x * exp(-ang * ang / 0.25);
    Tk += 350.0 * (1.0 - melt) * smoothstep(front + 0.5, front, ang); // compression-heated ahead of the front
    // as it cools the glow dims (uCool.z) and the Sun shows: a darker night limb and a lit day side
    // under the rock-vapour haze
    float cw = mix(0.3 + 0.45 * conv * conv, 0.12 + 0.8 * conv * conv, uCool.y); // cooler, darker lanes
    // (the ocean's own night limb, uCool.w, stays dark while the late look takes over: that one is
    // the earth scene's)
    float nightO = mix(1.0, mix(0.12, 1.0, smoothstep(-0.35, 0.75, ndl)), uCool.w);
    vec3 ocean = emitK(Tk) * cw * uCool.z * nightO
               + SUN * (0.05 + vec3(0.13, 0.09, 0.065) * uCool.y * (0.5 + 0.5 * conv)) * diff;
    if (late > 0.0) {
      // the earth scene's Hadean surface: crust rafts and glowing cracks on the magma ocean
      float crust = uLate.y, crackGlow = uLate.z;
      float raft = smoothstep(0.68 - crust * 0.7, 0.72 - crust * 0.6, conv + 0.12 * snoise(nb * 9.0));
      float cr1 = abs(snoise(nb * 5.0 + wv * 0.25));
      float cr2 = abs(snoise(nb * 13.0 + 3.0 + wv * 0.15));
      float crackW = mix(0.10, 0.025, crust);
      float cracks = exp(-cr1 / crackW) + 0.6 * exp(-cr2 / (crackW * 0.8));
      float molten = (1.0 - raft) * uLate.w;
      float tK = mix(1250.0, 2100.0, conv);
      vec3 emis = blackbody(tK) * (0.6 + 2.6 * conv * conv) * molten * 1.6;
      emis += blackbody(mix(1100.0, 1500.0, conv)) * cracks * crackGlow * (1.0 - molten) * 1.2;
      emis *= nightK;
      vec3 crustC = vec3(0.020, 0.018, 0.017) * 1.05 * (1.0 - 0.5 * cracks * crackGlow);
      float diffE = max(ndl, 0.0) * 0.92 + 0.08 * saturate(ndl + 0.15);
      ocean = mix(ocean, crustC * SUN_E * diffE + emis, late);
    }
    col = mix(plates + emitK(Tm + 400.0) * 0.4 * smoothstep(front + 0.6, front, ang), ocean, melt);
    col += emitK(max(Tk, 2600.0) + 400.0) * ring;
  }
  // early: emission limb darkening, hot rock-vapour rim, sun glint on the limb
  vec3 colA = col * (0.55 + 0.45 * sqrt(mu));
  float fr = pow(1.0 - mu, 3.0);
  float dkP = uCool.x * (1.0 - melt);    // the dark plates: a thinner, redder vapour rim
  colA += mix(vec3(1.0, 0.38, 0.12) * 0.55, vec3(1.0, 0.28, 0.07) * 0.4, dkP) * fr * uEarthP.w * mix(1.0, mix(0.3, 1.0, dayF), uCool.y);
  colA += SUN * vec3(1.0, 0.75, 0.55) * pow(1.0 - mu, 5.0) * smoothstep(-0.2, 0.6, ndl) * 1.2 * (1.0 - 0.8 * dkP);
  // late: the earth scene's thin Hadean atmosphere on the disc
  vec3 colB = col;
  if (late > 0.0) {
    float rim = pow(1.0 - mu, 2.6);
    float aIll = smoothstep(-0.30, 0.45, ndl);
    float dayW = smoothstep(-0.12, 0.18, ndl);
    colB *= 1.0 - rim * 0.3 * uSkyP.w;
    colB += ATMO_E * SUN_E * (rim * 0.5 + 0.012) * aIll * (0.6 + 0.4 * dayW);
  }
  col = mix(colA, colB, late);
  col += impactLight(p, nv);
  return col;
}

// --------------------------------------------------------------- Theia
vec3 shadeTheia(vec3 p, vec3 nv, vec3 rd) {
  vec3 nb = uThRot * nv;
  float n1 = fbm(nb * 2.4, Q > 1 ? 4 : 3);
  float big = snoise(nb * 1.3 + vec3(3.0, 1.0, 7.0));
  float rr = ridged(nb * 4.0 + n1 * 0.8, Q > 1 ? 4 : 3);
  float crack = smoothstep(0.8, 0.95, rr);
  vec3 toE0 = normalize(uE - p);
  float heat = uThP.x * mix(0.4, 1.0, smoothstep(-0.5, 0.6, dot(nv, toE0)));
  float mu = max(dot(nv, -rd), 0.0);
  vec3 alb = mix(vec3(0.05, 0.026, 0.019), vec3(0.11, 0.058, 0.038), 0.5 + 0.5 * n1);
  float ndl = dot(nv, uL);
  vec3 col = alb * SUN * 2.6 * max(ndl, 0.0);
  // partly molten: lava seas and glowing fissures, hotter as tides and the impact heat it
  float lake = smoothstep(0.25, 0.45, big + 0.25 * n1);
  float molten = max(crack, lake) * (1.0 - 0.7 * smoothstep(0.6, 0.98, rr) * lake);
  molten = mix(molten, 1.0, smoothstep(0.3, 0.85, heat));
  float Tk = mix(1100.0, 1900.0, heat) + 200.0 * n1 + 150.0 * crack;
  col = mix(col, col * 0.3 + emitK(Tk) * 0.75, molten * mix(0.75, 1.0, heat));
  // the glowing proto-Earth lights the facing hemisphere
  vec3 toE = uE - p;
  float dE2 = dot(toE, toE);
  col += vec3(1.0, 0.3, 0.06) * alb * max(dot(nv, toE * inversesqrt(dE2)), 0.0) * (5.0 / dE2);
  col *= 0.6 + 0.4 * sqrt(mu);
  col += impactLight(p, nv);
  return col;
}

// --------------------------------------------------------------- the Moon
vec3 shadeMoon(vec3 p, vec3 nv, vec3 rd) {
  vec3 nb = uMoRot * nv;
  vec3 mp = nb * 3.0 + 11.0;
  float maria = smoothstep(0.05, 0.35, fbm(mp * 0.9, 4));
  float crat = ridged(mp * 3.0, 3);
  // (the earth scene's Moon: same albedo, lighting and lava glow once the heat has gone)
  vec3 alb = mix(vec3(0.22, 0.21, 0.20), vec3(0.08, 0.08, 0.085), maria) * (0.8 + 0.35 * crat);
  float ndl = dot(nv, uL);
  vec3 col = alb * SUN_E * 0.9 * max(ndl, 0.0);
  float heat = uMoP.x;
  float lava = fbm(mp * 1.5 + uT * 0.05, 4) * 0.5 + 0.5;
  // newborn (heat 1): a deep orange-red magma ball, dimmer than the Earth, its night limb darker;
  // cooled (heat 0): the earth scene's Moon
  float Tk = mix(1100.0, 1700.0, lava) - 220.0 * heat * (1.0 - 0.5 * lava);
  vec3 em = blackbody(Tk) * (0.35 + 1.4 * pow(lava, 3.0)) * (1.0 - 0.35 * heat);
  em *= mix(1.0, mix(0.15, 1.0, smoothstep(-0.35, 0.55, ndl)), heat);
  float g = max(heat, uMoP.w);
  col = mix(col, col * (0.4 - 0.25 * heat) + em, saturate(g));
  col += alb * SUN * vec3(1.0, 0.6, 0.35) * max(ndl, 0.0) * heat * 0.3; // sunlit vapour on the day side
  vec3 toE = uE - p;
  float dE2 = dot(toE, toE);
  col += vec3(1.0, 0.32, 0.08) * alb * max(dot(nv, toE * inversesqrt(dE2)), 0.0) * (3.0 / dE2) * (1.0 - uLate.x);
  return col;
}

// --------------------------------------------------------------- debris disk (analytic)
// fbm() with the noise volume (same octave transform and normalisation)
float fbmT(vec3 p, int oct) {
  const vec3 TS = 1.75 / vec3(${NOISE_C.map((v) => v.toFixed(1)).join(', ')});
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 3; i++) {
    if (i >= oct) break;
    s += a * texture(uNoise, p * TS).r;
    n += a;
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return (s / n - 0.5) * (2.0 / 0.75);
}
float armMask(float rel, float head, float span) {
  float m = 0.0;
  for (int k = -1; k <= 2; k++) {
    float x = rel + TAU * float(k);
    m += smoothstep(-0.25, 0.55, head - x) * smoothstep(-0.2, 0.9, x - (head - span));
  }
  return min(m, 1.0);
}
// The earth scene's thin debris ring (premultiplied colour, alpha).
vec4 lateRing(vec3 pd, float r) {
  float band = smoothstep(1.35, 1.5, r) * smoothstep(2.5, 2.1, r);
  if (band <= 0.0) return vec4(0.0);
  vec3 rpN = pd / r;
  float dens = band * (0.45 + 0.55 * (fbm(vec3(r * 9.0, rpN.x * 2.0, rpN.y * 2.0 + rpN.z * 2.0), 4) * 0.5 + 0.5));
  dens *= 0.6 + 0.4 * sin(r * 37.0 + 1.3) * sin(r * 23.0);
  float s1 = dot(pd, uL);
  float shadow = s1 < 0.0 ? smoothstep(0.95, 1.05, length(pd - uL * s1)) : 1.0;
  vec3 lit = vec3(0.55, 0.42, 0.32) * SUN_E * 0.25 * (0.35 + 0.65 * shadow);
  float a = saturate(dens * uDisk2.w * 0.55);
  return vec4((lit + blackbody(1500.0) * 0.25 * uDisk2.w) * dens * a, a);
}

vec4 diskLayer(vec3 rd, float tSolid, out float td) {
  td = 1e9;
  if (uDisk.x <= 0.0 && uDisk2.w <= 0.0) return vec4(0.0);
  float dn = dot(rd, uNd);
  float t = dot(uE, uNd) / dn;
  if (t <= 0.0 || t > tSolid) return vec4(0.0); // (hidden behind a solid body)
  vec3 pd = rd * t - uE;
  float r = length(pd);
  if (r < 1.0 || r > max(uDisk.z + 0.4, 2.6)) return vec4(0.0);
  td = t;
  vec4 lr = uDisk2.w > 0.0 ? lateRing(pd, r) : vec4(0.0);
  if (uDisk.x <= 0.0) return lr;
  float x = dot(pd, uD1), y = dot(pd, uD2);
  float phi = atan(y, x);
  float rel = phi < 0.0 ? phi + TAU : phi;
  float W = uDisk.w;
  float Om = uDisk2.y * pow(r, -1.5);
  float travel = Om * W;
  float arm = armMask(rel, travel * 1.08 + 0.35, 0.9 + 0.8 * travel);
  float prof = smoothstep(uDisk.y, uDisk.y + 0.2, r) * (1.0 - smoothstep(uDisk.z - 0.7, uDisk.z + 0.2, r));
  vec3 mrel = uMo.xyz - uE;
  float clump = uDisk2.z * exp(-sq(length(pd - mrel) / 0.6));
  if (prof * arm < 1e-3 && clump < 1e-3) return lr; // empty part of the disk: skip the noise
  // co-rotating noise with a bounded shear (two phases of a periodic clock, cross-faded)
  const float PER = 1.6;
  float ph = W / PER;
  float fa = fract(ph), fb = fract(ph + 0.5);
  float wa = 1.0 - abs(2.0 * fa - 1.0);
  float na, nb2;
  {
    float a = phi - Om * fa * PER;
    vec2 cp = vec2(cos(a), sin(a)) * r;
    float k = floor(ph);
    na = fbmT(vec3(cp * 1.8 + k * vec2(7.3, 3.1), r * 1.1 + k * 3.7), Q > 1 ? 3 : 2);
  }
  {
    float a = phi - Om * fb * PER;
    vec2 cp = vec2(cos(a), sin(a)) * r;
    float k = floor(ph + 0.5);
    nb2 = fbmT(vec3(cp * 1.8 + k * vec2(7.3, 3.1) + 4.1, r * 1.1 + k * 3.7 + 1.9), Q > 1 ? 3 : 2);
  }
  float n = mix(nb2, na, wa) / mix(1.0, 0.75, 4.0 * wa * (1.0 - wa));
  float ringlets = 0.75 + 0.25 * sin(r * 21.0 + n * 3.0);
  float dens = prof * arm * smoothstep(-0.55, 0.6, n + 0.15) * ringlets;
  dens += clump * (0.6 + 0.4 * n); // the moonlet clump
  float colD = dens / max(abs(dn), 0.15);
  float alpha = (1.0 - exp(-colD * 0.6)) * uDisk.x;
  // source function: incandescent melt droplets and vapour (hot inside, cooling outward)
  // plus a little sunlight on the dust, shadowed by the planet
  float Tk = uDisk2.x * (1.0 + 0.1 * n) * mix(1.12, 0.8, saturate((r - 1.0) / 1.8));
  float sl = dot(pd, uL);
  float shadow = sl < 0.0 ? smoothstep(0.95, 1.06, length(pd - uL * sl)) : 1.0;
  vec3 src = emitK(Tk) * 0.1 + vec3(0.55, 0.42, 0.32) * 0.06 * (0.25 + 0.75 * shadow);
  vec4 ed = vec4(src * alpha, alpha);
  return ed + lr * (1.0 - ed.a);
}

void main() {
  vec2 q = (vUv - 0.5) * uRes / min(uRes.x, uRes.y);
  vec3 rd = normalize(vec3(q * 2.0 * uTH, -1.0));
  float px = 2.0 * uTH / min(uRes.x, uRes.y);

  // layers: (t, alpha) + premultiplied colour, composited back to front
  vec2 L0, L1, L2, L3; vec3 C0, C1, C2, C3;
  float tOpaque = 1e9;

  // Earth + glowing rock-vapour halo
  vec3 nE;
  vec2 hE = ellipsoid(rd, uE, 1.0, vec3(0.0, 1.0, 0.0), 1.0, px, nE);
  float tcE = dot(uE, rd);
  vec3 mE = rd * tcE - uE;
  float bE = length(mE);
  vec3 cE = vec3(0.0);
  float tSolid = hE.y > 0.999 ? hE.x : 1e9;
  if (hE.y > 0.0) cE = shadeEarth(rd * hE.x - uE, nE, rd) * hE.y;
  float hgt = max(bE - 1.0, 0.0);
  vec3 mN = mE / max(bE, 1e-3);
  float H = uEarthP2.w;
  float halo = exp(-hgt / H) * 0.8 + exp(-hgt / (H * 4.0)) * 0.25;
  halo *= 0.7 + 0.3 * smoothstep(-0.6, 0.6, dot(mN, uL));
  halo *= mix(1.0, 0.45 + 0.55 * smoothstep(-0.4, 0.5, dot(mN, uL)), uCool.y);
  vec3 haloA = emitK(uEarthP2.z) * halo * uEarthP.w * 0.25 * (1.0 - hE.y * mix(0.6, 0.97, uCool.x));
  vec3 haloB = vec3(0.0);
  if (uLate.x > 0.0) { // the earth scene's atmosphere halo
    float cosT = dot(rd, uL);
    float phase = 0.75 * (1.0 + cosT * cosT) * 0.6 + 2.2 * pow(saturate(cosT), 8.0) + 6.0 * pow(saturate(cosT), 60.0);
    float illum = smoothstep(-0.45, 0.55, dot(mN, uL));
    float hb = exp(-hgt / uEarthP.y) * 0.9 + exp(-hgt / (uEarthP.y * 4.0)) * 0.18;
    haloB = ATMO_E * hb * illum * phase * SUN_E * 0.32 * (1.0 - hE.y * 0.85);
  }
  cE += mix(haloA, haloB, uLate.x);
  L0 = vec2(hE.y > 0.0 ? hE.x : tcE, hE.y); C0 = cE;
  if (hE.y > 0.5) tOpaque = min(tOpaque, hE.x);

  // Theia
  L1 = vec2(1e9, 0.0); C1 = vec3(0.0);
  if (uThP.y > 0.0) {
    vec3 nT;
    vec2 hT = ellipsoid(rd, uTh.xyz, uTh.w, uThAx.xyz, uThAx.w, px, nT);
    if (hT.y > 0.0) {
      vec3 pT = rd * hT.x;
      vec3 cT = shadeTheia(pT, nT, rd);
      float dS = length(pT - uE) - 1.0;
      cT += emitK(3000.0) * exp(-abs(dS) / 0.05) * uThP.z * 0.6;
      float a = hT.y * uThP.y;
      if (uThP.w > 0.0) {
        // disintegration: the body breaks up from the contact side, glowing at the torn edges
        vec3 nb = uThRot * nT;
        float dn = fbm(nb * 3.2 + 7.0, 3) * 0.5 + 0.5 + 0.25 * dot(nT, normalize(uE - pT));
        float dth = uThP.w * 1.5 - 0.2;
        a *= smoothstep(dth - 0.03, dth + 0.05, dn);
        cT += emitK(2000.0) * exp(-sq((dn - dth - 0.04) / 0.06)) * 0.6;
      }
      L1 = vec2(hT.x, a); C1 = cT * a;
      if (a > 0.5) tOpaque = min(tOpaque, hT.x);
      if (a > 0.999) tSolid = min(tSolid, hT.x);
    }
  }

  // Moon
  L2 = vec2(1e9, 0.0); C2 = vec3(0.0);
  if (uMoP.y > 0.0 || uMoP.z > 0.0) {
    vec3 nM;
    vec2 hM = ellipsoid(rd, uMo.xyz, uMo.w, vec3(0.0, 1.0, 0.0), 1.0, px * (1.0 + 5.0 * (1.0 - uMoP.y)), nM);
    float tcM = dot(uMo.xyz, rd);
    float bM = length(rd * tcM - uMo.xyz) / uMo.w;
    vec3 cM = vec3(0.0);
    float a = hM.y * uMoP.y;
    if (a > 0.0) cM = shadeMoon(rd * hM.x, nM, rd) * a;
    cM += emitK(1700.0) * uMoP.z * exp(-max(bM - 1.0, 0.0) * 4.0) * 0.06 * (1.0 - a * 0.7);
    L2 = vec2(a > 0.0 ? hM.x : tcM, a); C2 = cM;
    if (a > 0.5) tOpaque = min(tOpaque, hM.x);
    if (a > 0.999) tSolid = min(tSolid, hM.x);
  }

  // Disk
  float tD;
  vec4 dsk = diskLayer(rd, tSolid, tD);
  L3 = vec2(tD, dsk.a); C3 = dsk.rgb;

  // the sky only where no opaque body covers the pixel; tB: its transmittance to the eye
  float tS = 0.0;
  vec3 bg = max(L0.y, max(L1.y, L2.y)) > 0.999 ? vec3(0.0) : sky(q, rd, tS);
  float tB = tS * (1.0 - L0.y) * (1.0 - L1.y) * (1.0 - L2.y) * (1.0 - L3.y);

  #define SWP(A, B, CA, CB) if (A.x < B.x) { vec2 tl = A; A = B; B = tl; vec3 tc = CA; CA = CB; CB = tc; }
  SWP(L0, L1, C0, C1) SWP(L2, L3, C2, C3) SWP(L0, L2, C0, C2) SWP(L1, L3, C1, C3) SWP(L1, L2, C1, C2)
  vec3 col = bg;
  col = C0 + col * (1.0 - L0.y);
  col = C1 + col * (1.0 - L1.y);
  col = C2 + col * (1.0 - L2.y);
  col = C3 + col * (1.0 - L3.y);

  // impact fireball (volumetric gaussian, occluded by the opaque bodies) + pre-contact glow
  if (uGlow.x > 0.0 || uGlow.w > 0.0) {
    vec3 fc = uCV + uCN * uGlow.y * 0.5;
    float tcF = dot(fc, rd);
    float b2 = dot(fc, fc) - tcF * tcF;
    float sig = uGlow.y;
    float vis = phiN((tOpaque - tcF) / (sig * 0.7));
    float g = exp(-b2 / (sig * sig));
    float g2 = 1.0 / (1.0 + b2 / (sig * sig * 0.05));
    col += emitK(uGlow2.x) * uGlow.x * (g * vis + 0.05 * g2 * max(vis, 0.35)) * 0.03;
    col += emitK(3600.0) * uGlow.w * exp(-b2 / 0.015) * max(vis, 0.4) * 0.05;
  }

  o = vec4(max(col, 0.0), tB);
  if (tOpaque < 1e8) {
    float z = tOpaque * rd.z;
    gl_FragDepth = 0.5 * (uDepthAB.x * z + uDepthAB.y) / (-z) + 0.5;
  } else {
    gl_FragDepth = 1.0;
  }
}
`);

  // Star sprites: one small quad per catalogue star, evaluating exactly the starL() term of that
  // star (including its cell-block truncation), added with the main pass's sky transmittance.
  // The star's position inside its cell is computed here on the GPU with the same code as the
  // per-pixel field (a CPU port of the jitter hash disagrees with the GPU's float rounding for a
  // few percent of the stars), so the quad is centred on the cell and covers the whole jitter range.
  const STAR_VS = U.glsl.vert(`
in vec4 aS;  // world direction of the centre of the star's cell, layer scale
in vec4 aC;  // its cell, layer seed
in vec2 aH;  // the cell's hashes h.y, h.z
uniform mat3 uSkyE;
uniform vec2 uRes;
uniform float uTH;
uniform float uW;
flat out vec3 vCol;
flat out vec4 vCell;
void main() {
  vec3 v = transpose(uSkyE) * aS.xyz;
  float mn = min(uRes.x, uRes.y);
  float px = 2.0 * uTH / mn;
  float scale = aS.w;
  float sigma = max(px * scale * 0.85, 0.02);
  vec2 t = v.xy / max(-v.z, 1e-4);
  // half size in pixels: the Gaussian's reach plus the jitter range around the cell centre
  // (<= 0.3 * sqrt(3) cells), stretched by the perspective projection away from the axis
  float hs = (min(4.0 * sigma, 2.4) + 0.53) / (px * scale) * (1.0 + dot(t, t)) + 1.5;
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;
  vec2 q = t / (2.0 * uTH);
  gl_Position = v.z < -0.1 ? vec4(q * 2.0 * mn / uRes + corner * hs * 2.0 / uRes, 0.0, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
  float mag = pow(aH.x, 5.0);
  float bright = 0.02 + 0.12 * aH.x * aH.x + 12.0 * mag * mag;
  vCol = blackbody(mix(3200.0, 12000.0, aH.y * aH.y)) * bright * (px * scale < 0.5 ? 1.0 : 0.5 / (px * scale)) * uW;
  vCell = vec4(aC.xyz, aS.w);
}`);
  const STAR_FS = U.glsl.frag(`
${STAR_DIR}
flat in vec3 vCol;
flat in vec4 vCell;   // cell, layer scale (seed 1 for scale 200, 3 for scale 470)
uniform mat3 uSkyE;
uniform vec2 uRes;
uniform float uTH;
out vec4 o;
void main() {
  vec2 q = (gl_FragCoord.xy / uRes - 0.5) * uRes / min(uRes.x, uRes.y);
  vec3 dir = uSkyE * normalize(vec3(q * 2.0 * uTH, -1.0));
  float px = 2.0 * uTH / min(uRes.x, uRes.y);
  float scale = vCell.w;
  bool l1 = scale < 300.0;
  vec3 p = dir * scale + (l1 ? 1.0 : 3.0) * 17.13;
  vec3 dc = vCell.xyz - floor(p - 0.5);
  if (any(lessThan(dc, vec3(-0.5))) || any(greaterThan(dc, vec3(1.5)))) discard; // (outside its cell block)
  vec3 sdir = l1 ? starDir(vCell.xyz, 1.0) : starDir(vCell.xyz, 3.0);
  float sigma = max(px * scale * 0.85, 0.02);
  float d = length(dir - sdir) * scale;
  o = vec4(vCol * exp(-0.5 * (d * d) / (sigma * sigma)), 0.0);
}`);

  const PVS = U.glsl.vert(`
${COMMON}
in vec4 aA; // t0, type (0 fallback, 1 disk, 2 far-flung), damping k, seed
in vec4 aB; // P.xyz, a0
in vec4 aC; // Q.xyz, e0
in vec4 aD; // M0, n0, a_final, e_final
in vec4 aF; // death (orbital tau), world radius, cooling time, gather (0 or 1+delay)
uniform vec2 uRes;
uniform float uTH;
uniform vec2 uDepthAB;
uniform vec3 uE;
uniform vec3 uEp;
uniform vec3 uNd;
uniform vec3 uD1;
uniform vec3 uD2;
uniform float uMu;
uniform vec4 uClock;   // orbital clock now, orbital clock at shutter open, real tau, film T
uniform vec4 uMoonA;   // moon pos rel Earth (now), gather end time
uniform vec4 uMoonB;   // moon pos rel Earth (shutter), gather start time
uniform vec4 uPart;    // gain, global fade, temperature floor, absorbed into the Moon 0..1
out vec3 vCol;
out vec3 vLoc; // x along, y across (px), z radius px
out float vLen;

float keplerE(float Mn, float e) {
  Mn = mod(Mn + PI, TAU) - PI;
  float E = Mn + 0.85 * e * (Mn >= 0.0 ? 1.0 : -1.0);
  for (int i = 0; i < 7; i++) {
    float f = E - e * sin(E) - Mn;
    E -= f / (1.0 - e * cos(E));
  }
  return E;
}

vec3 orbitPos(float tau) {
  float type = aA.y, k = aA.z;
  bool disk = type > 0.5 && type < 1.5;
  float eps = disk ? exp(-tau / k) : 1.0;
  float a = mix(aD.z, aB.w, eps), e = mix(aD.w, aC.w, eps);
  float Mn;
  if (disk) {
    float nf = sqrt(uMu / (aD.z * aD.z * aD.z));
    Mn = aD.x + nf * tau - (nf - aD.y) * k * (1.0 - eps);
  } else {
    Mn = aD.x + aD.y * tau;
  }
  float E = keplerE(Mn, e);
  float x = a * (cos(E) - e), y = a * sqrt(max(1.0 - e * e, 0.0)) * sin(E);
  vec3 P = aB.xyz, Qv = aC.xyz;
  if (disk) {
    vec3 h0 = cross(P, Qv);
    vec3 h = normalize(mix(uNd, h0, eps));
    P = normalize(P - h * dot(P, h));
    Qv = cross(h, P);
  }
  return x * P + y * Qv;
}

vec3 gathered(vec3 p, float T, vec3 moon, float seed) {
  if (aF.w <= 0.0) return p;
  float delay = aF.w - 1.0;
  float st = uMoonB.w + 2.0 * delay;
  float g = smoothstep(st, uMoonA.w, T);
  g = g * g * (3.0 - 2.0 * g);
  float ang = seed * TAU + (T - st) * (2.0 + 1.6 * fract(seed * 7.13));
  float rad = mix(0.9, 0.2, g) * (0.35 + 0.65 * fract(seed * 13.7));
  vec3 off = (uD1 * cos(ang) + uD2 * sin(ang)) * rad + uNd * rad * 0.3 * sin(ang * 1.7 + seed * 9.0);
  return mix(p, moon + off, g);
}

vec2 toPx(vec3 v) {
  vec2 qq = v.xy / (-v.z) / (2.0 * uTH);
  return qq * min(uRes.x, uRes.y) + 0.5 * uRes;
}

void main() {
  int vid = gl_VertexID;
  vec2 corner = vec2(float(vid & 1) * 2.0 - 1.0, float((vid >> 1) & 1) * 2.0 - 1.0);
  vCol = vec3(0.0); vLoc = vec3(0.0); vLen = 0.0;
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);

  float t0 = aA.x;
  float tauW = uClock.x - t0;
  float age = uClock.z - t0;
  if (tauW < 0.0 || age < 0.0) return;
  if (tauW > aF.x) return;
  float tauP = max(uClock.y - t0, 0.0);

  float seed = aA.w;
  vec3 p1 = orbitPos(tauW);
  vec3 p0 = orbitPos(tauP);
  p1 = gathered(p1, uClock.w, uMoonA.xyz, seed);
  p0 = gathered(p0, uClock.w - 0.03, uMoonB.xyz, seed);
  vec3 v1 = uE + p1, v0 = uEp + p0;
  if (v1.z > -1.2 || v0.z > -1.2) return;

  // temperature & brightness
  float Tk = mix(uPart.z, 3400.0, exp(-age / aF.z));
  float type = aA.y;
  float fade = smoothstep(0.0, 0.04, age) * uPart.y;
  if (type < 0.5) fade *= smoothstep(aF.x, aF.x - 0.08, tauW);   // falls back onto the Earth
  if (type > 1.5) fade *= 1.0 - smoothstep(1.5, 4.0, age);       // far-flung spray thins out
  if (aF.w > 0.0) {                                              // absorbed into the Moon; dimmer
    float g = smoothstep(uMoonB.w + 2.0 * (aF.w - 1.0), uMoonA.w, uClock.w); // as they crowd together,
    fade *= (1.0 - uPart.w) * (1.0 - 0.6 * g * g);               // so the moonlet stays a dull red
  }
  fade *= 0.3 + 2.2 * pow(fract(seed * 31.7), 4.0);       // a few bright clots, many faint
  fade *= smoothstep(-1.8, -3.2, v1.z);                          // nothing right in the lens

  vec2 s1 = toPx(v1), s0 = toPx(v0);
  float minR = min(uRes.x, uRes.y);
  float rTrue = aF.y / (-v1.z) / (2.0 * uTH) * minR;
  float r = max(rTrue, 1.3);
  vec2 d = s1 - s0;
  float L = length(d);
  if (L > 90.0) { d *= 90.0 / L; L = 90.0; s0 = s1 - d; }
  vec2 dir = L > 1e-3 ? d / L : vec2(1.0, 0.0);
  vec2 perp = vec2(-dir.y, dir.x);
  float rr = r * 1.4 + 0.8;
  float along = corner.x * 0.5 + 0.5;
  vec2 pos = mix(s0, s1, along) + dir * corner.x * rr + perp * corner.y * rr;
  // energy of a disc of radius rTrue spread over a capsule of radius r and length L
  float en = (rTrue * rTrue) / (0.5 * r * r + 0.399 * r * L);
  float big = 1.0 - smoothstep(6.0, 16.0, r);
  float amp = en * fade * big * uPart.x;
  if (amp < 2e-4) return;                                        // too faint to matter: skip the raster work
  vCol = blackbody(Tk) * sqrt(bright(Tk)) * amp;
  vLoc = vec3(along * L + corner.x * rr, corner.y * rr, r);
  vLen = L;
  vec2 ndc = pos / uRes * 2.0 - 1.0;
  float z = v1.z;
  gl_Position = vec4(ndc, (uDepthAB.x * z + uDepthAB.y) / (-z), 1.0);
}
`);

  const PFS = U.glsl.frag(`
in vec3 vCol;
in vec3 vLoc;
in float vLen;
out vec4 o;
void main() {
  float dx = max(0.0, max(-vLoc.x, vLoc.x - vLen));
  float d2 = dx * dx + vLoc.y * vLoc.y;
  float f = exp(-2.0 * d2 / (vLoc.z * vLoc.z));
  o = vec4(vCol * f, 1.0);
}
`);

  // ------------------------------------------------------------------ particles (CPU init)
  function elements(r0, v0) {
    const rm = len(r0);
    const h = cross(r0, v0);
    const hm = len(h);
    const energy = dot(v0, v0) / 2 - MU / rm;
    const a = -MU / (2 * energy);
    const ev = sub(mul(cross(v0, h), 1 / MU), mul(r0, 1 / rm));
    const e = len(ev);
    const P = e > 1e-6 ? mul(ev, 1 / e) : mul(r0, 1 / rm);
    const Qv = cross(mul(h, 1 / hm), P);
    const cn = dot(r0, P) / rm, sn = dot(r0, Qv) / rm;
    const E0 = Math.atan2(Math.sqrt(1 - e * e) * sn, e + cn);
    const M0 = E0 - e * Math.sin(E0);
    const n0 = Math.sqrt(MU / (a * a * a));
    return { a, e, P, Q: Qv, M0, n0 };
  }
  function keplerE(Mn, e) {
    Mn = ((Mn + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    let E = Mn + 0.85 * e * (Mn >= 0 ? 1 : -1);
    for (let i = 0; i < 7; i++) {
      const En = E - (E - e * Math.sin(E) - Mn) / (1 - e * Math.cos(E));
      if (En === E) break; // (a fixed point: the remaining iterations would not change it)
      E = En;
    }
    return E;
  }
  // Orbital radius of a disk particle (same model as the vertex shader).
  function diskRadius(el, af, ef, k, tau) {
    const eps = Math.exp(-tau / k);
    const a = af + (el.a - af) * eps, e = ef + (el.e - ef) * eps;
    const nf = Math.sqrt(MU / (af * af * af));
    const Mn = el.M0 + nf * tau - (nf - el.n0) * k * (1 - eps);
    const E = keplerE(Mn, e);
    return a * (1 - e * Math.cos(E));
  }
  // diskRadius(...) < 1, skipping the Kepler solve where the periapsis is outside the planet:
  // every operation in diskRadius() rounds monotonically, so its result is then >= 1 as well.
  function diskInside(el, af, ef, k, tau) {
    const eps = Math.exp(-tau / k);
    const a = af + (el.a - af) * eps, e = ef + (el.e - ef) * eps;
    if (a > 0 && e >= 0 && a * (1 - e) >= 1) return false;
    return diskRadius(el, af, ef, k, tau) < 1.0;
  }

  // (a generator: init() runs it in time slices, see sliced())
  function* buildParticles(N, seed, vC) {
    const rnd = M.rng(seed);
    const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd()))) * Math.cos(2 * Math.PI * rnd());
    const data = new Float32Array(N * 20);
    let o = 0;
    for (let i = 0; i < N; i++) {
      if ((i & 15) === 15) yield;
      const rt = rnd();
      const type = rt < 0.45 ? 0 : rt < 0.9 ? 1 : 2;
      const t0 = type === 1 ? 0.75 * Math.pow(rnd(), 1.4) : type === 0 ? 1.1 * Math.pow(rnd(), 1.6) : 0.3 * rnd() * rnd();
      // launch site follows Theia as it ploughs along the surface
      const site = norm(theiaAfter(t0, vC).c);
      const fwd0 = norm(sub(FWD, mul(site, dot(FWD, site))));
      const sideA = norm(cross(site, fwd0));
      const spreadF = gauss() * 0.08, spreadS = gauss() * (type === 1 ? 0.07 : 0.12);
      const up = norm(add(add(site, mul(fwd0, spreadF)), mul(sideA, spreadS)));
      const fwd = norm(sub(fwd0, mul(up, dot(fwd0, up))));
      const side = cross(up, fwd);
      let speed, el, az;
      if (type === 0) {
        speed = 0.3 + 0.62 * Math.pow(rnd(), 0.8);
        el = (16 + 62 * rnd()) * Math.PI / 180;
        az = gauss() * 0.7;
      } else if (type === 1) {
        speed = 1.02 + 0.28 * Math.pow(rnd(), 1.1);
        el = (2 + 12 * rnd()) * Math.PI / 180;
        az = gauss() * 0.12;
      } else {
        speed = 1.3 + 0.1 * rnd();
        el = (4 + 26 * rnd()) * Math.PI / 180;
        az = gauss() * 0.3;
      }
      const hdir = add(mul(fwd, Math.cos(az)), mul(side, Math.sin(az)));
      const dir = norm(add(mul(up, Math.sin(el)), mul(hdir, Math.cos(el))));
      const r0 = mul(up, 1.0 + 0.015 * rnd());
      const v0 = mul(dir, speed * SQMU);
      const elm = elements(r0, v0);
      let af = elm.a, ef = elm.e, k = 1;
      let death = 1e9;
      let gather = 0;
      if (type === 0) {
        death = (2 * Math.PI - 2 * elm.M0) / elm.n0; // back at the launch radius
      } else if (type === 1) {
        const apo = elm.a * (1 + elm.e);
        af = M.clamp(1 + (apo - 1) * 0.5, 1.2, 3.2);
        ef = 0.01 + 0.04 * rnd();
        k = 0.55 + 0.7 * rnd();
        for (let tau = 0.04; tau < 4.0; tau += 0.04) {
          if (diskInside(elm, af, ef, k, tau)) { death = tau; break; }
        }
        if (af > 2.2 && rnd() < 0.7) gather = 1 + rnd() * 0.999;
      }
      const size = type === 0 ? 0.008 + 0.02 * Math.pow(rnd(), 2) : type === 1 ? 0.007 + 0.015 * Math.pow(rnd(), 2) : 0.006 + 0.01 * rnd();
      const cool = type === 0 ? 0.35 + 0.7 * rnd() : type === 1 ? 0.8 + 1.6 * rnd() : 0.5 + 0.8 * rnd();
      data[o++] = t0; data[o++] = type; data[o++] = k; data[o++] = rnd();
      data[o++] = elm.P[0]; data[o++] = elm.P[1]; data[o++] = elm.P[2]; data[o++] = elm.a;
      data[o++] = elm.Q[0]; data[o++] = elm.Q[1]; data[o++] = elm.Q[2]; data[o++] = elm.e;
      data[o++] = elm.M0; data[o++] = elm.n0; data[o++] = af; data[o++] = ef;
      data[o++] = death; data[o++] = size; data[o++] = cool; data[o++] = gather;
    }
    return data;
  }

  // ------------------------------------------------------------------ per-frame state
  function frameState(T, aspect, cues) {
    const tImp = cues.theiaImpact, tMoon = cues.moonFormed;
    const vC = contactSpeed(tImp);
    const tau = T - tImp;
    const tp = Math.max(0, tau);
    const hit = tau >= 0;
    const S = {};

    S.E = earthCentre(T, aspect);
    S.Ep = earthCentre(T - 0.03, aspect);

    // camera, Earth spin (plates: the solarsystem scene's body frame; ocean: the earth scene's)
    S.TH = thAt(T);
    S.ERot = earthRot(T, tImp);
    S.ERotA = rotMat(ND, -0.06 * (T - 93));
    S.CB = mat3Vec(earthRot(tImp, tImp), NC);

    // the late blend to the earth scene's look (complete at 108)
    const late = ss(104.0, 107.6, T);
    const crust = keys([[108, 0.25], [110, 0.4], [113, 1.0]], T);
    const crackGlow = T < 108 ? M.mix(0.15, 0.4, ss(104.0, 108.0, T)) : keys([[108, 0.4], [110.5, 1.0], [113.5, 0.8]], T);
    const magma = keys([[108, 1.0], [110, 0.85], [112.5, 0.25], [114.5, 0.0]], T);
    S.Late = [late, crust, crackGlow, magma];

    // cooling looks: dark basalt plates from the start (the solarsystem scene's paler plates
    // dissolve into them during the 93-95 hand-off, with the same plate geometry), then after the
    // impact the Sun's lit side / night limb and a dimmer magma glow
    // (the lit side / night limb fades out by 108: the earth scene's Hadean globe has none)
    S.Cool = [1, ss(101.3, 103.2, T) * (1 - ss(106.0, 108.0, T)), 1 - 0.3 * ss(101.3, 103.5, T), ss(101.0, 102.8, T)];

    // Theia
    let thC, thR = THEIA_R, thAx, thK = 1, thHeat, thVis, seam = 0, dissolve = 0;
    if (!hit) {
      thC = theiaPath(T, tImp, aspect);
      const dist = len(thC);
      thHeat = 0.08 + 0.3 * ss(5, 1.6, dist) + 0.25 * ss(2.0, 1.5, dist);
      thAx = norm(thC);
      thK = 1 + 0.06 * ss(2.6, 1.5, dist); // tidal stretch in the last moments
      thVis = ss(94.3, 95.6, T);
    } else {
      const a = theiaAfter(tau, vC);
      thC = a.c; thR = a.r; thAx = norm(a.c); thK = a.k;
      thHeat = ss(0, 0.9, tau);
      seam = ss(0, 0.1, tau) * (1 - ss(0.5, 1.5, tau));
      thVis = 1 - ss(1.3, 1.6, tau);
      dissolve = ss(0.25, 1.5, tau);
    }
    S.Th = [...add(S.E, thC), thR];
    S.ThAx = [...thAx, thK];
    S.ThRot = rotMat(norm([0.3, 1, 0.2]), -0.22 * (T - 93));
    S.ThP = [thHeat, thVis, seam, dissolve];

    // contact point / fireball
    const site = norm(theiaAfter(Math.min(tp, 1.2), vC).c);
    S.CN = site;
    S.CV = add(S.E, site);
    const fireI = hit ? 16 * Math.exp(-tp / 0.1) + 3 * Math.exp(-tp / 0.5) + 0.5 * Math.exp(-tp / 2.0) : 0;
    const fireR = 0.1 + 0.75 * (1 - Math.exp(-tp / 0.5));
    const fireT = 2400 + 3400 * Math.exp(-tp / 0.6);
    const pointI = hit ? 10 * Math.exp(-tp / 0.2) + 1.5 * Math.exp(-tp / 1.0) : 0;
    const pre = hit ? 0 : 3 * ss(-0.35, 0, tau) ** 2;
    S.Glow = [fireI, fireR, pointI, pre];
    S.Glow2 = [fireT, 0, 0, 0];

    // shock front + melting; extra heat of the magma ocean (K) on top of its convection range
    const front = hit ? Math.PI * 1.05 * (1 - Math.exp(-tp / 0.7)) + 0.6 * ss(2.5, 4.0, tp) : 0;
    const ringA = hit ? 0.2 * ss(0, 0.05, tp) * (1 - ss(0.9, 2.2, tp)) : 0;
    const heatX = hit ? (500 * Math.exp(-tp / 0.5) + 200 * Math.exp(-tp / 2.0)) * ss(0, 0.2, tp) : 0;
    S.Shock = [front, ringA, hit ? 1 : 0, heatX];
    const plateCrust = 0.62;
    const haloI = hit ? 1 + 0.6 * Math.exp(-tp / 1.8) * ss(0, 0.3, tp) : 1;
    S.EarthP = [plateCrust, T < 108 ? 0.022 : keys([[108, 0.022], [114, 0.04]], T), 0, haloI];
    const wound = hit ? 900 * Math.exp(-tp / 1.6) * ss(0, 0.3, tp) : 0;
    S.EarthP2 = [wound, 0, hit ? 1500 + 600 * Math.exp(-tp / 1.5) : 1500, hit ? 0.04 + 0.05 * Math.exp(-tp / 2.5) : 0.04];

    // orbital clock
    const W = hit ? orbClock(tau) : 0;
    const Wp = tau < 0.03 ? 0 : orbClock(tau - 0.03);
    S.W = W; S.Wp = Wp; S.tau = tau;

    // spiral debris disk -> the earth scene's thin ring
    const dB = hit ? ss(0.2, 1.8, tau) * (1 - ss(104.0, 107.8, T)) : 0;
    const rOut = hit ? M.mix(1.4, 3.0, ss(0.2, 2.8, tau)) - 0.4 * ss(103.5, 107.5, T) : 1;
    const rIn = 1.05 + 0.3 * ss(103.0, 107.0, T);
    const dT = 1050 + 1000 * Math.exp(-Math.max(0, tau - 0.4) / 1.6);
    const clump = ss(101.5, 104.3, T) * (1 - ss(104.7, 105.6, T)) * 1.2;
    const ringO = ss(104.5, 107.8, T) * (1 - ss(108, 112, T));
    S.Disk = [dB, rIn, rOut, W];
    S.Disk2 = [dT, SQMU, clump, ringO];

    // Moon
    const mRel = moonRel(T), mRelP = moonRel(T - 0.03);
    const form = ss(tMoon - 0.7, tMoon, T);
    const mHeat = T < tMoon ? 1 : Math.exp(-(T - tMoon) / 0.9) * (1 - ss(106.0, 107.8, T));
    S.Mo = [...add(S.E, mRel), MOON_R * (0.6 + 0.4 * form)];
    S.MoRot = rotMat(norm([0.1, 1, 0.1]), -0.1 * Math.min(T - 108, 0));
    const mGlow = ss(tMoon - 3, tMoon - 0.2, T) * (1 - ss(tMoon, tMoon + 1.6, T));
    const mSurfGlow = 0.35 * (1 - ss(108, 114, T));
    S.MoP = [mHeat, form, mGlow, mSurfGlow];
    S.moonRel = mRel; S.moonRelP = mRelP;

    // particles
    S.partFade = hit ? 1 - ss(104.5, 108.5, T) : 0;
    S.absorb = ss(tMoon - 0.25, tMoon + 0.4, T);

    // sky: the solarsystem scene's (drifting) star field early, the earth scene's (static) late
    S.SkyE = earlySky(T);
    // the star field switches to the earth scene's while the impact flash whites out the frame
    const lateSky = ss(99.0, 99.04, T);
    S.SkyP = [1 - lateSky, lateSky, 1 - ss(95.5, 99, T), T < 108 ? 0.35 : keys([[108, 0.35], [112, 0.6], [115, 1.0]], T)];

    // post
    const post = {};
    post.flash = hit ? 14 * Math.exp(-tp / 0.03) + 0.5 * Math.exp(-tp / 0.1) : 0;
    post.shake = hit ? 0.9 * Math.exp(-tp / 0.8) + 0.12 * Math.exp(-tp / 3) : 0.1 * ss(97.8, 99, T);
    // the dark plates read as dark only with a softer bloom (back to full under the impact white-out)
    const soft = 1 - ss(99.0, 99.08, T);
    const dim = ss(101.3, 103.2, T) * (1 - ss(105.5, 108.0, T));
    post.bloom = M.mix(0.8, 0.85, ss(105, 108, T)) - 0.4 * soft - 0.25 * dim + (hit ? 0.25 * Math.exp(-tp / 1.2) : 0.1 * ss(98, 99, T));
    post.bloomThreshold = 0.9 + 0.7 * soft;
    post.aberration = 0.12 + (hit ? 0.35 * Math.exp(-tp / 0.8) : 0);
    post.exposure = hit ? 1 - 0.4 * ss(0.02, 0.25, tp) * (1 - ss(0.8, 3.8, tp)) : 1;
    if (T > tMoon - 0.3) post.bloom += 0.15 * ss(tMoon - 0.3, tMoon, T) * Math.exp(-Math.max(0, T - tMoon) / 0.8);
    S.post = post;
    return S;
  }

  // ------------------------------------------------------------------ init scheduling
  // init() keeps the main thread responsive (the intro title is animating meanwhile): it issues
  // every program first (with KHR_parallel_shader_compile they compile in the background), then
  // runs the CPU-heavy generators in slices of <= ~8 ms with a yield to the event loop in between,
  // and only then does the GPU work that needs linked programs.
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
  // Waits, without blocking, until the programs have linked, where the browser can tell
  // (KHR_parallel_shader_compile); otherwise (or once linked) their first use proceeds as usual.
  const linked = (gl, progs) => U.gl.compiled(gl, progs);

  // ------------------------------------------------------------------ scene
  let prog = null, sprog = null, pprog = null, vao = null, nPart = 0, partGain = 1, noiseTex = null;
  let stprog = null, starVao = null, nStars = 0;
  // Bakes the noise volume with the (linked) program np, which it then deletes.
  function makeNoise(gl, np) {
    const [nx, ny, nz] = NOISE_C.map((c) => c * NOISE_R);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.texStorage3D(gl.TEXTURE_3D, 1, gl.R8, nx, ny, nz);
    for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, w, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.bindTexture(gl.TEXTURE_3D, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.viewport(0, 0, nx, ny);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    np.use();
    for (let z = 0; z < nz; z++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex, 0, z);
      np.set('uZ', (z + 0.5) / nz);
      U.gl.drawFullscreen(gl);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    gl.deleteProgram(np.program);
    return tex;
  }
  // Sky caches (screen-size HDR targets): the late star field (static) and the dust band (its key
  // is the fov, which holds over 93-99). Without HDR targets they are evaluated inline.
  const caches = { sky: { t: null, cur: '' }, band: { t: null, cur: '' } };
  function ensureCaches(gl, s) {
    let made = false;
    for (const k in caches) {
      const c = caches[k];
      if (c.t && c.t.w === s.width && c.t.h === s.height) continue;
      if (c.t) U.gl.deleteTarget(gl, c.t);
      c.t = U.gl.target(gl, s.width, s.height, { hdr: true, filter: 'nearest' });
      c.cur = '';
      made = true;
    }
    if (made) s.bindOutput(); // (target() leaves the default framebuffer bound)
  }
  function useCache(gl, s, c, key, draw) {
    if (!c.t.hdr) return false;
    if (c.cur === key) return true;
    U.gl.bindTexture(gl, 0, null);
    U.gl.bindTexture(gl, 1, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, c.t.fb);
    gl.viewport(0, 0, s.width, s.height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    draw();
    s.bindOutput();
    c.cur = key;
    return true;
  }

  U.defineScene({
    id: 'theia',
    _debug: { frameState, TH, D0, ND, NC, D1, D2, UPV, MOON_108, MOON_START, BHAT, TANG, P_C, P_CTRL },
    async init(gl, ctx) {
      const q = ctx.tier === 'high' ? 2 : ctx.tier === 'mid' ? 1 : 0;
      // 1. every program, in the order they are needed (the noise bake, the instance buffers'
      //    attributes, then the first frame). (Yields in between: where linking blocks, each
      //    program is its own task.)
      const np = U.gl.program(gl, U.gl.FULLSCREEN_VS, NOISE_FS, 'theia-noise');
      await pause();
      stprog = U.gl.program(gl, STAR_VS, STAR_FS, 'theia-starsprites');
      await pause();
      pprog = U.gl.program(gl, PVS, PFS, 'theia-particles');
      await pause();
      sprog = U.gl.program(gl, U.gl.FULLSCREEN_VS, SKY_FS(q), 'theia-stars');
      await pause();
      prog = U.gl.program(gl, U.gl.FULLSCREEN_VS, FS(q), 'theia-planets');
      await pause();
      // 2. CPU work, in slices: the star catalogue and the plume particles
      const cat = [];
      await sliced(starCatalogue(cat, 200, 0.014, 1, STAR_CONE.axis, STAR_CONE.beta));
      if (q > 1) await sliced(starCatalogue(cat, 470, 0.0055, 3, STAR_CONE.axis, STAR_CONE.beta));
      const ps = ctx.particleScale || 1;
      const nP = Math.round(28000 * ps);
      const data = await sliced(buildParticles(nP, 0x7e1a, contactSpeed(U.timeline.cues.theiaImpact)));
      // 3. GPU work: the noise volume, the instance buffers
      await linked(gl, [np, stprog, pprog]);
      noiseTex = makeNoise(gl, np);
      const sbuf = U.gl.buffer(gl, new Float32Array(cat));
      const SA = stprog.attribs;
      starVao = U.gl.vao(gl, [
        { loc: SA.aS, buffer: sbuf, size: 4, stride: 40, offset: 0, divisor: 1 },
        { loc: SA.aC, buffer: sbuf, size: 4, stride: 40, offset: 16, divisor: 1 },
        { loc: SA.aH, buffer: sbuf, size: 2, stride: 40, offset: 32, divisor: 1 },
      ]);
      nStars = cat.length / 10;
      const buf = U.gl.buffer(gl, data);
      const A = pprog.attribs;
      const stride = 80;
      vao = U.gl.vao(gl, [
        { loc: A.aA, buffer: buf, size: 4, stride, offset: 0, divisor: 1 },
        { loc: A.aB, buffer: buf, size: 4, stride, offset: 16, divisor: 1 },
        { loc: A.aC, buffer: buf, size: 4, stride, offset: 32, divisor: 1 },
        { loc: A.aD, buffer: buf, size: 4, stride, offset: 48, divisor: 1 },
        { loc: A.aF, buffer: buf, size: 4, stride, offset: 64, divisor: 1 },
      ]);
      nPart = nP;
      partGain = 0.105 / Math.pow(ps, 0.8);
    },

    render(gl, s) {
      const DBG = window.__THEIA_DBG || {};
      const T = DBG.T != null ? DBG.T : s.T;
      const S = frameState(T, s.aspect, s.cues);
      const res = [s.width, s.height];
      if (DBG.noDisk) S.Disk[0] = 0;
      if (DBG.noPart) S.partFade = 0;
      if (DBG.cool) S.Cool = DBG.cool;

      ensureCaches(gl, s);

      // ---- bodies, disk, sky (writes depth)
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.ALWAYS);
      gl.depthMask(true);
      prog.use().setAll({
        uRes: res, uTH: S.TH, uDepthAB: [DEPTH_A, DEPTH_B], uL: LIGHT, uT: T,
        uE: S.E, uERot: S.ERot, uCB: S.CB, uCV: S.CV, uCN: S.CN,
        uShock: S.Shock, uEarthP: S.EarthP, uEarthP2: S.EarthP2,
        uTh: S.Th, uThAx: S.ThAx, uThRot: S.ThRot, uThP: S.ThP,
        uMo: S.Mo, uMoRot: S.MoRot, uMoP: S.MoP,
        uNd: ND, uD1: D1, uD2: D2, uDisk: S.Disk, uDisk2: S.Disk2,
        uGlow: S.Glow, uGlow2: S.Glow2, uSkyE: S.SkyE, uSkyP: S.SkyP,
        uBandN: BAND_N, uERotA: S.ERotA, uLate: S.Late, uCool: S.Cool,
        uSkyTH: [S.TH, TH_B], uSkyTex: 0, uBandTex: 1, uNoise: 2,
      });
      const size = s.width + 'x' + s.height;
      const live = DBG.sky === 'live';
      const skyC = S.SkyP[1] > 0 && !live && useCache(gl, s, caches.sky, size, () => {
        sprog.use().setAll({ uRes: res, uTH: S.TH, uMode: 0, uSkyTH: [S.TH, TH_B] });
        U.gl.drawFullscreen(gl);
      });
      const bandC = S.SkyP[2] > 0 && !live && useCache(gl, s, caches.band, size + '|' + S.TH, () => {
        sprog.use().setAll({ uRes: res, uTH: S.TH, uMode: 1, uBandN: BAND_N });
        U.gl.drawFullscreen(gl);
      });
      const asp = Math.max(s.aspect, 1 / s.aspect);
      const sprites = S.SkyP[0] > 0 && !live && nStars > 0 &&
        Math.atan(S.TH * Math.sqrt(asp * asp + 1)) + STAR_CONE.drift < STAR_CONE.beta - 0.015;
      gl.enable(gl.DEPTH_TEST);
      prog.use().setAll({ uEarlyS: sprites ? 1 : 0, uSkyC: skyC ? 1 : 0, uBandC: bandC ? 1 : 0 });
      U.gl.bindTexture(gl, 0, caches.sky.t.tex);
      U.gl.bindTexture(gl, 1, caches.band.t.tex);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_3D, noiseTex);
      U.gl.drawFullscreen(gl);
      gl.bindTexture(gl.TEXTURE_3D, null);

      // ---- the early star field: sprites, weighted by the sky transmittance left in alpha
      if (sprites) {
        gl.disable(gl.DEPTH_TEST);
        gl.depthMask(false);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.DST_ALPHA, gl.ONE);
        gl.colorMask(true, true, true, false);
        stprog.use().setAll({ uSkyE: S.SkyE, uRes: res, uTH: S.TH, uW: 0.75 * S.SkyP[0] });
        gl.bindVertexArray(starVao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nStars);
        gl.bindVertexArray(null);
        gl.colorMask(true, true, true, true);
        gl.disable(gl.BLEND);
        gl.enable(gl.DEPTH_TEST);
      }

      // ---- impact plume / debris particles
      if (S.tau >= 0 && S.partFade > 0.001) {
        gl.depthFunc(gl.LEQUAL);
        gl.depthMask(false);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        const cues = s.cues;
        pprog.use().setAll({
          uRes: res, uTH: S.TH, uDepthAB: [DEPTH_A, DEPTH_B], uE: S.E, uEp: S.Ep,
          uNd: ND, uD1: D1, uD2: D2, uMu: MU,
          uClock: [S.W, S.Wp, S.tau, T],
          uMoonA: [...S.moonRel, cues.moonFormed - 0.2],
          uMoonB: [...S.moonRelP, cues.theiaImpact + 2.4],
          uPart: [partGain, S.partFade, 1050, S.absorb],
        });
        gl.bindVertexArray(vao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nPart);
        gl.bindVertexArray(null);
      }

      Object.assign(s.post, S.post);
      if (DBG.post) Object.assign(s.post, DBG.post);
    },
  });
})();
