// Scene 'cosmicweb' (T 45-62): proto-galaxies -> pull back to reveal the cosmic web -> swing into a
// cluster while galaxies stream along the filaments -> a galaxy merger in the foreground -> fly to
// the young Milky Way while its disk settles and its arms wind up (hand-off 4).
//
// Layers (all additive into the HDR target):
//   gas    : volumetric filament / cluster gas: a 3D density texture splatted from the web graph at
//            init, ray-marched at reduced resolution and composited
//   dm     : faint dark-matter points (the Millennium-style filigree), only when far
//   gal    : ~10^5 galaxies as instanced sprites; filament galaxies drift / stream analytically
//   merger : restricted 3-body (Toomre) simulation precomputed at init into a float texture,
//            interpolated in the vertex shader
//   mw     : the Milky Way = analytic thin disk + bulge ray shader + star-cluster particles
// The final framing (60-62) reproduces the 'milkyway' scene's opening camera (distance, elevation,
// field of view, arm pattern and its apparent rotation) so the cross-fade is seamless.
(function () {
  'use strict';
  const U = window.U;
  const M = U.math;
  const DEG = Math.PI / 180;

  const FOV0 = 46 * DEG, FOV1 = 40 * DEG; // short-side field of view (FOV1 = 'milkyway' at 60 s)
  const WEB_R = 70; // radius of the populated web sphere
  const NODE_R = 84; // nodes are scattered beyond it so filaments run out of the volume
  const VOL_HALF = 74; // gas volume covers [-VOL_HALF, VOL_HALF]^3
  const MW_R = 0.15; // galaxy unit (Milky Way disk radius) in world units
  const MG_R = 0.14; // merger: 1 simulation length unit in world units
  const STREAM = 10000; // aP.w offset that flags streaming galaxies
  const ARM_R0 = 0.21, ARM_PITCH = 16; // 'milkyway' arm geometry (log spiral, 4 arms)

  // ------------------------------------------------------------------ small vector helpers
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len = (a) => Math.sqrt(dot(a, a));
  const nrm = (a) => scl(a, 1 / (len(a) || 1));
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  const madd = (...terms) => terms.reduce((acc, [v, s]) => add(acc, scl(v, s)), [0, 0, 0]);

  function gauss(rng) {
    let u = rng(); if (u < 1e-9) u = 1e-9;
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(6.283185307 * rng());
  }
  function inSphere(rng, R) {
    for (;;) {
      const x = rng() * 2 - 1, y = rng() * 2 - 1, z = rng() * 2 - 1;
      if (x * x + y * y + z * z <= 1) return [x * R, y * R, z * R];
    }
  }
  function randDir(rng) {
    const z = rng() * 2 - 1, a = rng() * 6.283185307, r = Math.sqrt(1 - z * z);
    return [r * Math.cos(a), z, r * Math.sin(a)];
  }

  // Monotone cubic (Fritsch-Carlson) through (xs, ys); linear outside. mEnd optionally fixes the
  // slope at the last key (used to join the 'milkyway' camera with a continuous velocity).
  function monotone(xs, ys, mEnd) {
    const n = xs.length, m = new Array(n), d = [];
    for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
      if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
    }
    if (mEnd !== undefined) m[n - 1] = mEnd;
    return (x) => {
      if (x <= xs[0]) return ys[0] + m[0] * (x - xs[0]);
      if (x >= xs[n - 1]) return ys[n - 1] + m[n - 1] * (x - xs[n - 1]);
      let i = 0;
      while (x > xs[i + 1]) i++;
      const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
      return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
    };
  }
  // The 'milkyway' scene's spline flavour (harmonic-mean interior slopes), to reproduce its camera.
  function monoH(keys) {
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
    const f = (x) => {
      if (x <= xs[0]) return ys[0] + m[0] * (x - xs[0]);
      if (x >= xs[n - 1]) return ys[n - 1] + m[n - 1] * (x - xs[n - 1]);
      let i = 0;
      while (x > xs[i + 1]) i++;
      const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
      return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
    };
    f.m0 = m[0];
    return f;
  }
  // 'milkyway' opening camera (galaxy units, degrees): orbit distance, elevation, azimuth.
  const MWC = {
    logD: monoH([[60, Math.log(3.45)], [62, Math.log(3.3)], [63.5, Math.log(2.6)], [65, Math.log(1.3)]]),
    eps: monoH([[60, 30], [62, 31], [63.8, 38], [65.2, 30]]),
    alpha: monoH([[60, 0], [62, 0.6], [64, 4], [66, 13]]),
    OMEGA: 0.045,
  };
  // its camera azimuth around the galaxy (rad); camera at theta = pi/2 - alpha of the galaxy frame
  const alphaMW = (T) => MWC.alpha(T) * DEG + MWC.OMEGA * (T - 60);

  // ------------------------------------------------------------------ the web graph
  function bezier(A, C, B, s) {
    const u = 1 - s;
    return [u * u * A[0] + 2 * u * s * C[0] + s * s * B[0], u * u * A[1] + 2 * u * s * C[1] + s * s * B[1], u * u * A[2] + 2 * u * s * C[2] + s * s * B[2]];
  }
  function bezierT(A, C, B, s) {
    return nrm(add(scl(sub(C, A), 2 * (1 - s)), scl(sub(B, C), 2 * s)));
  }

  function* buildWeb(rng) {
    const NN = 240;
    const nodes = [];
    for (let i = 0; i < NN; i++) {
      if ((i & 31) === 31) yield;
      let best = null, bd = -1;
      for (let c = 0; c < 3; c++) {
        const p = inSphere(rng, NODE_R);
        let dm = 1e9;
        for (const n of nodes) { const d = d2(p, n.p); if (d < dm) dm = d; }
        if (dm > bd) { bd = dm; best = p; }
      }
      nodes.push({ p: best, m: 0.1 + 0.9 * Math.pow(rng(), 3.2), fils: [] });
    }
    // the hero cluster: the node closest to a point a little off-centre
    let star = 0, bestD = 1e9;
    for (let i = 0; i < NN; i++) { const d = d2(nodes[i].p, [6, -4, 4]); if (d < bestD) { bestD = d; star = i; } }
    nodes[star].m = 1.6;
    // beta-skeleton edges (beta smaller between massive nodes -> more filaments around clusters)
    const fils = [];
    for (let i = 0; i < NN; i++) {
      yield;
      for (let j = i + 1; j < NN; j++) {
        const a = nodes[i].p, b = nodes[j].p;
        const dd = Math.sqrt(d2(a, b));
        if (dd > 44) continue;
        const mm = Math.sqrt(nodes[i].m * nodes[j].m);
        const beta = 1.85 - 0.55 * Math.min(1, mm);
        const r = beta * dd / 2;
        const c1 = lerp3(a, b, beta / 2), c2 = lerp3(b, a, beta / 2);
        let ok = true;
        for (let k = 0; k < NN && ok; k++) {
          if (k === i || k === j) continue;
          const p = nodes[k].p;
          if (d2(p, c1) < r * r && d2(p, c2) < r * r) ok = false;
        }
        if (!ok) continue;
        const t = nrm(sub(b, a));
        const ref = nrm(cross(t, Math.abs(t[1]) < 0.85 ? [0, 1, 0] : [1, 0, 0]));
        const ref2 = cross(t, ref);
        const ang = rng() * 6.283;
        const bend = dd * (0.05 + 0.12 * rng());
        const C = add(lerp3(a, b, 0.5), add(scl(ref, Math.cos(ang) * bend), scl(ref2, Math.sin(ang) * bend)));
        fils.push({
          a: i, b: j, A: a, B: b, C, ref, len: dd,
          rad: 0.55 + 1.05 * Math.sqrt(mm) * (0.75 + 0.5 * rng()),
          w: (0.35 + 1.25 * mm) * (24 / Math.max(dd, 10)) * (0.6 + 0.8 * rng()),
        });
        nodes[i].fils.push(fils.length - 1); nodes[j].fils.push(fils.length - 1);
      }
    }
    // walls: triangles of mutually connected nodes
    const adj = nodes.map(() => new Set());
    fils.forEach((f) => { adj[f.a].add(f.b); adj[f.b].add(f.a); });
    const walls = [];
    for (let i = 0; i < NN; i++) {
      for (const j of adj[i]) {
        if (j <= i) continue;
        for (const k of adj[j]) if (k > j && adj[i].has(k)) walls.push([i, j, k]);
      }
    }
    return { nodes, fils, walls, star };
  }

  function filOffset(rng, s, sigma) {
    // radius widens near the nodes (where the filament merges into the cluster halo)
    const widen = 1 + 0.8 * Math.pow(Math.abs(2 * s - 1), 6);
    return [gauss(rng) * sigma * widen, gauss(rng) * sigma * widen];
  }
  function filPoint(f, s, o1, o2) {
    const t = bezierT(f.A, f.C, f.B, s);
    const n1 = nrm(sub(f.ref, scl(t, dot(f.ref, t))));
    const n2 = cross(t, n1);
    return add(bezier(f.A, f.C, f.B, s), add(scl(n1, o1), scl(n2, o2)));
  }
  const nodeRadius = (n) => 0.9 + 2.0 * n.m;
  function weightedPick(cum, rng) {
    const x = rng() * cum[cum.length - 1];
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < x) lo = mid + 1; else hi = mid; }
    return lo;
  }
  const webFade = (p) => 1 - M.smoothstep(WEB_R - 16, WEB_R, len(p));
  // filament galaxies drift toward the nodes (same law as the vertex shader)
  const DRIFT_K = 0.035;
  function driftS(s0, tau) {
    const side = s0 < 0.5 ? -1 : 1;
    const dn = (1 - Math.abs(2 * s0 - 1)) * Math.exp(-DRIFT_K * tau);
    return 0.5 + side * 0.5 * (1 - dn);
  }

  // Galaxies. Per instance aP + aQ:
  //   filament  : aP = (s0, o1, o2, fil)              drifts toward the filament's nodes
  //   stream    : aP = (phase, o1, o2, fil + STREAM)  conveyor flow into the hero cluster
  //   static    : aP = (x, y, z, -1)
  //   cluster   : aP = (dx, dy, dz, -2 - node)        offset from the node, contracts with time
  //   aQ = (radius, lum, oldness (2 = brightest cluster galaxy), seed)
  function* buildGalaxies(rng, W, count, excl) {
    const P = [], Q = [];
    const { nodes, fils, walls } = W;
    const filCum = [], nodeCum = [], wallCum = [];
    let acc = 0;
    for (const f of fils) { acc += f.w * f.len * (0.5 + f.rad); filCum.push(acc); }
    acc = 0;
    for (const n of nodes) { acc += Math.pow(n.m, 1.4) + 0.02; nodeCum.push(acc); }
    acc = 0;
    for (const w of walls) {
      const a = nodes[w[0]].p, b = nodes[w[1]].p, c = nodes[w[2]].p;
      acc += len(cross(sub(b, a), sub(c, a))) * 0.5; wallCum.push(acc);
    }
    const push = (px, py, pz, pw, rad, lum, old) => { P.push(px, py, pz, pw); Q.push(rad, lum, old, rng()); };
    const lumf = () => 0.5 + 0.9 * rng() + 7 * Math.pow(rng(), 14);
    const radf = () => 0.011 * Math.exp(0.45 * gauss(rng));
    const ok = (p) => {
      for (const e of excl) if (d2(p, e.p) < e.r * e.r) return false;
      return len(p) < WEB_R;
    };
    let n = 0, guard = 0;
    while (n < count && guard++ < count * 6) {
      if ((guard & 1023) === 0) yield;
      const r = rng();
      if (r < 0.44) {
        const fi = weightedPick(filCum, rng);
        const f = fils[fi];
        let s = rng();
        if (rng() < 0.35) s = Math.floor(s * 7) / 7 + 0.04 * gauss(rng) + 0.07; // groups
        s = M.clamp(s, 0.02, 0.98);
        const [o1, o2] = filOffset(rng, s, f.rad * 0.55);
        const p = filPoint(f, s, o1, o2);
        if (!ok(p) || rng() > webFade(p)) continue;
        push(s, o1, o2, fi, radf(), lumf(), 0.25 * rng());
      } else if (r < 0.86) {
        const ni = weightedPick(nodeCum, rng);
        const nd = nodes[ni];
        const rc = nodeRadius(nd);
        const rr = rc * Math.pow(rng(), 1.7) * 1.6;
        const off = scl(randDir(rng), rr);
        const p = add(nd.p, off);
        if (!ok(p) || rng() > webFade(p)) continue;
        const core = Math.exp(-rr / (rc * 0.35));
        push(off[0], off[1], off[2], -2 - ni, radf() * (1.5 + 1.2 * core), lumf() * (1 + core), 0.45 + 0.55 * rng());
      } else if (r < 0.95 && walls.length) {
        const w = walls[weightedPick(wallCum, rng)];
        let a = rng(), b = rng();
        if (a + b > 1) { a = 1 - a; b = 1 - b; }
        const A = nodes[w[0]].p, B = nodes[w[1]].p, C = nodes[w[2]].p;
        const nn = nrm(cross(sub(B, A), sub(C, A)));
        let p = add(A, add(scl(sub(B, A), a), scl(sub(C, A), b)));
        p = add(p, scl(nn, gauss(rng) * 1.2));
        if (!ok(p) || rng() > webFade(p)) continue;
        push(p[0], p[1], p[2], -1, radf(), lumf() * 0.7, 0.3 * rng());
      } else {
        const p = inSphere(rng, WEB_R);
        if (!ok(p)) continue;
        push(p[0], p[1], p[2], -1, radf() * 0.8, lumf() * 0.5, 0.15 * rng());
      }
      n++;
    }
    // brightest cluster galaxies: one big golden elliptical at each massive node
    nodes.forEach((nd, k) => {
      if (nd.m < 0.35 || len(nd.p) > WEB_R - 4) return;
      push(0, 0, 0, -2 - k, 0.03 + 0.03 * nd.m, 3 + 4 * nd.m, 2);
    });
    return { P, Q };
  }

  // Galaxies streaming along the hero cluster's filaments.
  function addStreams(rng, W, G, ps) {
    W.nodes[W.star].fils.forEach((fi) => {
      const f = W.fils[fi];
      const n = Math.round(Math.min(f.len, 30) * 22 * ps);
      for (let k = 0; k < n; k++) {
        const o1 = gauss(rng) * f.rad * 0.4, o2 = gauss(rng) * f.rad * 0.4;
        G.P.push(rng(), o1, o2, fi + STREAM);
        G.Q.push(0.011 * Math.exp(0.4 * gauss(rng)), 0.9 + 1.2 * rng() + 5 * Math.pow(rng(), 10), 0.15 * rng(), rng());
      }
    });
  }

  // The opening field: groups of young proto-galaxies along the filament through F.
  function addOpening(rng, W, G, ps) {
    const f = W.f0, fi = W.fils.indexOf(f);
    const nGroups = 46, sigS = 2.6 / f.len;
    const q = Math.max(ps, 0.5);
    for (let g = 0; g < nGroups; g++) {
      const sg = W.sF + gauss(rng) * sigS;
      const g1 = gauss(rng) * 0.9, g2 = gauss(rng) * 0.9;
      const members = Math.round((4 + rng() * 18) * q);
      const spread = 0.12 + 0.25 * rng();
      for (let k = 0; k < members; k++) {
        const s = M.clamp(sg + gauss(rng) * spread / f.len, 0.02, 0.98);
        G.P.push(s, g1 + gauss(rng) * spread, g2 + gauss(rng) * spread, fi);
        G.Q.push(0.016 * Math.exp(0.45 * gauss(rng)), 0.7 + 1.0 * rng() + 3 * Math.pow(rng(), 8), 0.05 * rng(), rng());
      }
    }
    const nField = Math.round(500 * q);
    for (let k = 0; k < nField; k++) {
      const s = M.clamp(W.sF + gauss(rng) * sigS * 2.2, 0.02, 0.98);
      G.P.push(s, gauss(rng) * 1.6, gauss(rng) * 1.6, fi);
      G.Q.push(0.013 * Math.exp(0.45 * gauss(rng)), 0.5 + 0.9 * rng(), 0.05 * rng(), rng());
    }
  }

  // DM / faint gas points, static (xyz, weight)
  function* buildDM(rng, W, count) {
    const P = new Float32Array(count * 4);
    const { nodes, fils, walls } = W;
    const filCum = [], nodeCum = [], wallCum = [];
    let acc = 0;
    for (const f of fils) { acc += f.w * f.len; filCum.push(acc); }
    acc = 0;
    for (const n of nodes) { acc += Math.pow(n.m, 1.2) + 0.03; nodeCum.push(acc); }
    acc = 0;
    for (const w of walls) {
      const a = nodes[w[0]].p, b = nodes[w[1]].p, c = nodes[w[2]].p;
      acc += len(cross(sub(b, a), sub(c, a))); wallCum.push(acc);
    }
    let i = 0, guard = 0;
    while (i < count && guard++ < count * 6) {
      if ((guard & 2047) === 0) yield;
      const r = rng();
      let p, w = 1;
      if (r < 0.58) {
        const f = fils[weightedPick(filCum, rng)];
        const s = rng();
        const [o1, o2] = filOffset(rng, s, f.rad * (rng() < 0.6 ? 0.22 : 0.6));
        p = filPoint(f, s, o1, o2);
        w = 0.6 + 0.6 * f.w;
      } else if (r < 0.8) {
        const n = nodes[weightedPick(nodeCum, rng)];
        p = add(n.p, scl(randDir(rng), nodeRadius(n) * Math.pow(rng(), 1.5) * 2.2));
        w = 1.2;
      } else if (r < 0.97 && walls.length) {
        const wl = walls[weightedPick(wallCum, rng)];
        let a = rng(), b = rng();
        if (a + b > 1) { a = 1 - a; b = 1 - b; }
        const A = nodes[wl[0]].p, B = nodes[wl[1]].p, C = nodes[wl[2]].p;
        const nn = nrm(cross(sub(B, A), sub(C, A)));
        p = add(add(A, add(scl(sub(B, A), a), scl(sub(C, A), b))), scl(nn, gauss(rng) * 0.7));
        w = 0.45;
      } else {
        p = inSphere(rng, WEB_R);
        w = 0.3;
      }
      const fade = webFade(p);
      if (fade <= 0.01) continue;
      P[i * 4] = p[0]; P[i * 4 + 1] = p[1]; P[i * 4 + 2] = p[2]; P[i * 4 + 3] = w * fade;
      i++;
    }
    return { P, count: i };
  }

  // Gas volume (RG8): R = filament gas, G = hot cluster gas. Stored as sqrt(density).
  function* buildVolume(rng, W, N) {
    const R = new Float32Array(N * N * N), G = new Float32Array(N * N * N);
    const vox = (2 * VOL_HALF) / N;
    const toV = (x) => (x + VOL_HALF) / vox - 0.5;
    function splat(arr, p, sigma, w) {
      const cx = toV(p[0]), cy = toV(p[1]), cz = toV(p[2]);
      const sv = Math.max(sigma / vox, 0.6);
      const rad = Math.ceil(sv * 2.4);
      const inv = 1 / (2 * sv * sv);
      const x0 = Math.max(0, Math.floor(cx - rad)), x1 = Math.min(N - 1, Math.ceil(cx + rad));
      const y0 = Math.max(0, Math.floor(cy - rad)), y1 = Math.min(N - 1, Math.ceil(cy + rad));
      const z0 = Math.max(0, Math.floor(cz - rad)), z1 = Math.min(N - 1, Math.ceil(cz + rad));
      const norm = w / (sv * sv); // keeps the column density roughly independent of the width
      for (let z = z0; z <= z1; z++) {
        const dz = (z - cz) * (z - cz);
        for (let y = y0; y <= y1; y++) {
          const dy = (y - cy) * (y - cy) + dz;
          const row = (z * N + y) * N;
          for (let x = x0; x <= x1; x++) {
            const dd = (x - cx) * (x - cx) + dy;
            if (dd > rad * rad) continue;
            arr[row + x] += norm * Math.exp(-dd * inv);
          }
        }
      }
    }
    for (const f of W.fils) {
      yield;
      const n = Math.ceil(f.len / (vox * 0.5));
      const ph = rng() * 10, ph2 = rng() * 10;
      for (let k = 0; k <= n; k++) {
        const s = k / n;
        const p = bezier(f.A, f.C, f.B, s);
        if (len(p) > WEB_R + 4) continue;
        const bead = 0.55 + 0.45 * Math.sin(s * f.len * 0.55 + ph) * Math.sin(s * f.len * 0.23 + ph2);
        const widen = 1 + 0.9 * Math.pow(Math.abs(2 * s - 1), 6);
        splat(R, p, f.rad * 0.6 * widen, f.w * bead * webFade(p) * (vox * 0.5));
      }
    }
    for (const nd of W.nodes) {
      yield;
      if (len(nd.p) > WEB_R + 6) continue;
      const rc = nodeRadius(nd);
      splat(G, nd.p, rc * 0.75, nd.m * 2.2 * webFade(nd.p));
      splat(R, nd.p, rc * 1.1, nd.m * 1.2 * webFade(nd.p));
    }
    const pct = (arr) => {
      const sample = [];
      for (let k = 0; k < arr.length; k += 97) if (arr[k] > 0) sample.push(arr[k]);
      sample.sort((a, b) => a - b);
      return sample.length ? sample[Math.floor(sample.length * 0.995)] : 1;
    };
    const mr = pct(R) || 1;
    yield;
    const mg = pct(G) || 1;
    yield;
    const out = new Uint8Array(N * N * N * 2);
    for (let k = 0; k < N * N * N; k++) {
      if ((k & 16383) === 0) yield;
      out[k * 2] = Math.min(255, Math.round(Math.sqrt(R[k] / mr) * 200));
      out[k * 2 + 1] = Math.min(255, Math.round(Math.sqrt(G[k] / mg) * 200));
    }
    return out;
  }

  // Tileable 3D value-noise fbm, N^3 R8.
  function* buildNoise3(rng, N) {
    const lat = (P) => { const a = new Float32Array(P * P * P); for (let k = 0; k < a.length; k++) a[k] = rng(); return a; };
    const octs = [[4, lat(4), 0.5], [8, lat(8), 0.3], [16, lat(16), 0.2]];
    const out = new Uint8Array(N * N * N);
    const sm = (t) => t * t * (3 - 2 * t);
    for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      if (x === 0 && (y & 7) === 0) yield;
      let v = 0;
      for (const [P, L, amp] of octs) {
        const fx = x * P / N, fy = y * P / N, fz = z * P / N;
        const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
        const tx = sm(fx - ix), ty = sm(fy - iy), tz = sm(fz - iz);
        const g = (a, b, c) => L[((c % P) * P + (b % P)) * P + (a % P)];
        const a0 = M.mix(M.mix(g(ix, iy, iz), g(ix + 1, iy, iz), tx), M.mix(g(ix, iy + 1, iz), g(ix + 1, iy + 1, iz), tx), ty);
        const a1 = M.mix(M.mix(g(ix, iy, iz + 1), g(ix + 1, iy, iz + 1), tx), M.mix(g(ix, iy + 1, iz + 1), g(ix + 1, iy + 1, iz + 1), tx), ty);
        v += amp * M.mix(a0, a1, tz);
      }
      out[(z * N + y) * N + x] = Math.round(M.clamp(v, 0, 1) * 255);
    }
    return out;
  }

  // ------------------------------------------------------------------ merger simulation
  // Restricted 3-body (Toomre & Toomre 1972): two softened point masses on a parabolic orbit with a
  // little dynamical friction so they coalesce; massless disk particles. Positions are recorded
  // every FRAME_DT simulation units into an RGB32F texture (SIM_W particles per row; 2048 keeps the
  // texture height under WebGL2's guaranteed 2048 on every tier).
  const SIM = { M1: 1.0, M2: 0.8, E2: 0.09, RP: 1.0, R0: 5.0, GAM: 0.3, GS: 1.2, DT: 0.025, FRAME_DT: 0.125, T_END: 18.0 };
  const SIM_W = 2048;
  // film seconds -> simulation time after the first pericentre (at the galaxyMerger cue): 2.5 units/s
  // on the approach, easing up to 3.2 units/s after the cue so the nuclei coalesce ~1.6 s later.
  function mergerSince(tm) {
    if (tm <= 0) return 2.5 * tm;
    const L = 1.2, x = Math.min(tm, L) / L;
    const ramp = tm < L ? L * (x * x * x - 0.5 * x * x * x * x) : tm - L / 2;
    return 2.5 * tm + 0.7 * ramp;
  }
  function* simulateMerger(rng, nPer) {
    const { M1, M2, E2, RP, R0, GAM, GS, DT, FRAME_DT, T_END } = SIM;
    const mu = M1 + M2;
    const f0 = -Math.acos(2 * RP / R0 - 1), h = Math.sqrt(2 * mu * RP);
    const rh = [Math.cos(f0), Math.sin(f0), 0], th = [-Math.sin(f0), Math.cos(f0), 0];
    const vr = mu / h * Math.sin(f0), vt = mu / h * (1 + Math.cos(f0));
    const rel = scl(rh, R0), vrel = add(scl(rh, vr), scl(th, vt));
    const c = [scl(rel, -M2 / mu), scl(rel, M1 / mu)];
    const cv = [scl(vrel, -M2 / mu), scl(vrel, M1 / mu)];
    const masses = [M1, M2];
    const NP = 2 + 2 * nPer;
    const pos = new Float64Array(NP * 3), vel = new Float64Array(NP * 3);
    // galaxy, r0, kind, seed; two extra instances (kind 4) draw the starburst halo around each nucleus
    const info = new Float32Array((NP + 2) * 4);
    // galaxy 0 nearly prograde in the orbital plane (long tails), galaxy 1 inclined (but seen at
    // ~45 deg, not edge-on, from the camera)
    const tilt = [[0.3, 0.0], [1.0, 1.0]];
    for (let g = 0; g < 2; g++) {
      info[g * 4] = g; info[g * 4 + 1] = 0; info[g * 4 + 2] = 3; info[g * 4 + 3] = rng();
      const [inc, om] = tilt[g];
      const ci = Math.cos(inc), si = Math.sin(inc), co = Math.cos(om), so = Math.sin(om);
      const rot = (x, y, z) => {
        const y1 = y * ci - z * si, z1 = y * si + z * ci;
        return [x * co - y1 * so, x * so + y1 * co, z1];
      };
      const scale = g === 0 ? 1 : 0.88;
      for (let k = 0; k < nPer; k++) {
        if ((k & 2047) === 2047) yield;
        const id = 2 + g * nPer + k;
        let r;
        do { r = 0.16 + -0.3 * Math.log(Math.max(1e-9, rng() * rng())); } while (r > 1.45);
        r *= scale;
        const ph = rng() * 6.283185;
        const v = Math.sqrt(masses[g] * r * r / Math.pow(r * r + E2, 1.5));
        const z = gauss(rng) * 0.02 * (0.4 + r);
        const p = rot(r * Math.cos(ph), r * Math.sin(ph), z);
        const vv = rot(-v * Math.sin(ph), v * Math.cos(ph), 0);
        for (let a = 0; a < 3; a++) { pos[id * 3 + a] = c[g][a] + p[a]; vel[id * 3 + a] = cv[g][a] + vv[a]; }
        const kind = r < 0.38 * scale ? 0 : rng() < 0.2 ? 2 : 1; // 0 old inner, 1 disk star, 2 gas -> starburst knot
        info[id * 4] = g; info[id * 4 + 1] = r / scale; info[id * 4 + 2] = kind; info[id * 4 + 3] = rng();
      }
    }
    for (let g = 0; g < 2; g++) info.set([g, 0, 4, rng()], (NP + g) * 4);
    const nFrames = Math.round(T_END / FRAME_DT) + 1;
    const W = SIM_W, rowsPer = Math.ceil(NP / W);
    const tex = new Float32Array(W * rowsPer * nFrames * 3);
    const record = (fi) => {
      const base = fi * rowsPer * W * 3;
      for (let k = 0; k < 2; k++) { tex[base + k * 3] = c[k][0]; tex[base + k * 3 + 1] = c[k][1]; tex[base + k * 3 + 2] = c[k][2]; }
      for (let id = 2; id < NP; id++) {
        tex[base + id * 3] = pos[id * 3]; tex[base + id * 3 + 1] = pos[id * 3 + 1]; tex[base + id * 3 + 2] = pos[id * 3 + 2];
      }
    };
    const coreAcc = () => {
      const d = sub(c[1], c[0]);
      const r2 = dot(d, d);
      const inv = 1 / Math.pow(r2 + E2 * 2, 1.5);
      const dv = sub(cv[1], cv[0]);
      const g = GAM * Math.exp(-r2 / (2 * GS * GS));
      return [add(scl(d, M2 * inv), scl(dv, M2 / mu * g)), add(scl(d, -M1 * inv), scl(dv, -M1 / mu * g)), Math.sqrt(r2)];
    };
    const stepsPerFrame = Math.round(FRAME_DT / DT);
    let tPeri = 0, minD = 1e9, phase = 0, step = 0;
    record(0);
    for (let fi = 1; fi < nFrames; fi++) {
      for (let s = 0; s < stepsPerFrame; s++, step++) {
        yield;
        let [a0, a1] = coreAcc();
        for (let a = 0; a < 3; a++) { cv[0][a] += a0[a] * DT / 2; cv[1][a] += a1[a] * DT / 2; }
        const cOld = [c[0].slice(), c[1].slice()];
        for (let a = 0; a < 3; a++) { c[0][a] += cv[0][a] * DT; c[1][a] += cv[1][a] * DT; }
        let r;
        [a0, a1, r] = coreAcc();
        for (let a = 0; a < 3; a++) { cv[0][a] += a0[a] * DT / 2; cv[1][a] += a1[a] * DT / 2; }
        if (phase === 0) {
          if (r < minD) { minD = r; tPeri = (step + 1) * DT; } else if (r > minD + 0.05) phase = 1;
        }
        // particles: kick with the old core positions, drift, kick with the new ones
        const g0x = cOld[0][0], g0y = cOld[0][1], g0z = cOld[0][2], g1x = cOld[1][0], g1y = cOld[1][1], g1z = cOld[1][2];
        const h0x = c[0][0], h0y = c[0][1], h0z = c[0][2], h1x = c[1][0], h1y = c[1][1], h1z = c[1][2];
        for (let id = 2; id < NP; id++) {
          const i3 = id * 3;
          let px = pos[i3], py = pos[i3 + 1], pz = pos[i3 + 2];
          let dx = g0x - px, dy = g0y - py, dz = g0z - pz;
          let q = dx * dx + dy * dy + dz * dz + E2;
          let ir = M1 / (q * Math.sqrt(q));
          let ax = dx * ir, ay = dy * ir, az = dz * ir;
          dx = g1x - px; dy = g1y - py; dz = g1z - pz;
          q = dx * dx + dy * dy + dz * dz + E2;
          ir = M2 / (q * Math.sqrt(q));
          ax += dx * ir; ay += dy * ir; az += dz * ir;
          const vx = vel[i3] + ax * DT / 2, vy = vel[i3 + 1] + ay * DT / 2, vz = vel[i3 + 2] + az * DT / 2;
          px += vx * DT; py += vy * DT; pz += vz * DT;
          dx = h0x - px; dy = h0y - py; dz = h0z - pz;
          q = dx * dx + dy * dy + dz * dz + E2;
          ir = M1 / (q * Math.sqrt(q));
          ax = dx * ir; ay = dy * ir; az = dz * ir;
          dx = h1x - px; dy = h1y - py; dz = h1z - pz;
          q = dx * dx + dy * dy + dz * dz + E2;
          ir = M2 / (q * Math.sqrt(q));
          ax += dx * ir; ay += dy * ir; az += dz * ir;
          vel[i3] = vx + ax * DT / 2; vel[i3 + 1] = vy + ay * DT / 2; vel[i3 + 2] = vz + az * DT / 2;
          pos[i3] = px; pos[i3 + 1] = py; pos[i3 + 2] = pz;
        }
      }
      record(fi);
    }
    return { tex, info, NP, NI: NP + 2, W, rowsPer, nFrames, tPeri, nPer };
  }

  // ------------------------------------------------------------------ shaders
  const CAM_GLSL = `
uniform mat3 uViewRot;   // world -> view rotation
uniform vec3 uEye;
uniform mat4 uProj;
uniform float uPxScale;  // pixels per unit at view distance 1
`;

  const GAL_VS = U.glsl.vert(CAM_GLSL + `
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 aP;
layout(location=2) in vec4 aQ;
uniform sampler2D uFil, uNodes;
uniform float uTau, uK, uBoost, uStar, uAge, uFogL, uGain, uFluxPow, uColl, uBCG, uStream, uStreamT, uStarDim;
uniform vec4 uExcl0, uExcl1;
out vec2 vC;
out vec3 vCol;
out float vI;
out vec3 vEll;
out float vRpx;
out vec4 vMisc;  // resolved, bulge, arms, young
flat out float vSeed;
vec3 bez(vec3 a, vec3 c, vec3 b, float s) { float u = 1.0 - s; return u * u * a + 2.0 * u * s * c + s * s * b; }
vec3 bezT(vec3 a, vec3 c, vec3 b, float s) { return 2.0 * (1.0 - s) * (c - a) + 2.0 * s * (b - c); }
void main() {
  vec3 wp;
  float seed = aQ.w;
  float fade = 1.0;
  float lum = aQ.y;
  float old = min(aQ.z, 1.0);
  if (aP.w > -0.5) {
    bool stream = aP.w > 9999.5;
    int fi = int((stream ? aP.w - 10000.0 : aP.w) + 0.5);
    vec4 A = texelFetch(uFil, ivec2(0, fi), 0);
    vec4 C = texelFetch(uFil, ivec2(1, fi), 0);
    vec4 B = texelFetch(uFil, ivec2(2, fi), 0);
    vec4 R = texelFetch(uFil, ivec2(3, fi), 0);
    float s, sink;
    if (stream) {
      bool atA = abs(A.w - uStar) < 0.5;
      float v = 1.1 + 1.1 * hash11(seed * 13.7 + 2.1);
      float u = fract(aP.x + uStreamT * v / R.w);
      float d = 1.0 - pow(u, 1.8);
      s = atA ? 0.03 + 0.92 * d : 0.97 - 0.92 * d;
      sink = mix(0.3, 1.0, d);
      fade = smoothstep(0.0, 0.2, u) * (1.0 - smoothstep(0.9, 1.0, u)) * uStream;
    } else {
      float s0 = aP.x;
      float side = s0 < 0.5 ? -1.0 : 1.0;
      float node = side < 0.0 ? A.w : B.w;
      float tau = uTau + (abs(node - uStar) < 0.5 ? uBoost : 0.0);
      float dn = (1.0 - abs(2.0 * s0 - 1.0)) * exp(-uK * tau);
      s = 0.5 + side * 0.5 * (1.0 - dn);
      sink = mix(0.55, 1.0, smoothstep(0.0, 0.25, dn));
    }
    vec3 tg = normalize(bezT(A.xyz, C.xyz, B.xyz, s));
    vec3 n1 = normalize(R.xyz - dot(R.xyz, tg) * tg);
    vec3 n2 = cross(tg, n1);
    float widen = 1.0 + 0.8 * pow(abs(2.0 * s - 1.0), 6.0);
    wp = bez(A.xyz, C.xyz, B.xyz, s) + (aP.y * n1 + aP.z * n2) * widen * sink;
  } else if (aP.w < -1.5) {
    float ni = -aP.w - 2.0;
    vec4 nd = texelFetch(uNodes, ivec2(0, int(ni + 0.5)), 0);
    wp = nd.xyz + aP.xyz * uColl;
    if (aQ.z > 1.5) lum *= uBCG;
    if (abs(ni - uStar) < 0.5) lum *= uStarDim; // the hero cluster is context behind the merger
  } else {
    wp = aP.xyz;
  }
  vec3 rel = wp - uEye;
  vec3 vp = uViewRot * rel;
  float z = -vp.z;
  float dist = length(rel);
  old *= mix(0.3, 1.0, smoothstep(0.2, 0.62, uAge));
  float rad = aQ.x * mix(0.7, 1.0, uAge) * (1.0 + 0.35 * old);
  float rpx = rad / max(z, 1e-4) * uPxScale;
  // galaxies sweeping right past the lens: fade them out before their sprites get huge (bounded
  // overdraw, and no big blobs whipping across the frame)
  fade *= 1.0 - smoothstep(60.0, 120.0, rpx);
  const float PSF = 0.8;
  float ext = max(rpx * 1.8, PSF * 2.8);
  float res = smoothstep(1.5, 5.0, rpx);
  float fluxPt = pow(min(1.0, 0.16 * rpx * rpx), uFluxPow);
  fade *= smoothstep(0.05, 0.3, dist) * exp(-dist / uFogL);
  fade *= smoothstep(uExcl0.w * 0.55, uExcl0.w, length(wp - uExcl0.xyz));
  fade *= smoothstep(uExcl1.w * 0.55, uExcl1.w, length(wp - uExcl1.xyz));
  if (z < 0.02 || fade < 1e-4) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  // disk orientation -> screen ellipse
  float h1 = hash11(seed * 91.7 + 0.3), h2 = hash11(seed * 53.1 + 1.7);
  float cz = h1 * 2.0 - 1.0, ph = h2 * TAU;
  vec3 nrm = vec3(sqrt(1.0 - cz * cz) * cos(ph), cz, sqrt(1.0 - cz * cz) * sin(ph));
  vec3 nv = uViewRot * nrm;
  vec2 md = length(nv.xy) > 1e-3 ? normalize(nv.xy) : vec2(0.0, 1.0);
  float isDisk = step(old, 0.62);
  float q = isDisk > 0.5 ? max(abs(nv.z), 0.18) : 0.62 + 0.38 * h1;
  float young = (1.0 - smoothstep(0.35, 0.75, uAge)) * (1.0 - smoothstep(0.1, 0.4, old));
  q = mix(q, 0.7 + 0.3 * h2, young);
  q = mix(1.0, q, res);
  vEll = vec3(md, q);
  vec3 cY = vec3(0.6, 0.74, 1.0);
  vec3 cO = vec3(1.0, 0.76, 0.5);
  vCol = mix(cY, cO, smoothstep(0.2, 0.8, old));
  vI = lum * uGain * mix(fluxPt, 1.0, res) * fade;
  vRpx = rpx;
  vMisc = vec4(res, mix(0.25, 1.0, old), isDisk * (1.0 - smoothstep(0.4, 0.8, old)), young);
  vSeed = seed;
  vC = aCorner * ext;
  gl_Position = uProj * vec4(vp.xy + aCorner * ext * z / uPxScale, vp.z, 1.0);
}`);

  const GAL_FS = U.glsl.frag(`
in vec2 vC;
in vec3 vCol;
in float vI;
in vec3 vEll;
in float vRpx;
in vec4 vMisc;
flat in float vSeed;
out vec4 o;
void main() {
  const float PSF = 0.8;
  float pt = exp(-0.5 * dot(vC, vC) / (PSF * PSF));
  vec3 col = vCol * pt;
  if (vMisc.x > 0.001) {
    vec2 d = vEll.xy;
    vec2 m = vec2(dot(vC, vec2(-d.y, d.x)), dot(vC, d) / vEll.z) / max(vRpx, 1e-3);
    float rr = length(m);
    float bulge = exp(-rr * rr * 30.0) * vMisc.y * 1.6;
    float disk = exp(-rr / 0.26);
    float th = atan(m.y, m.x);
    float arms = 0.45 + 0.55 * pow(0.5 + 0.5 * cos(2.0 * th - 5.5 * log(rr + 0.04) + vSeed * 40.0), 2.0);
    disk *= mix(1.0, arms * 1.4, vMisc.z * smoothstep(0.08, 0.3, rr));
    vec3 g = vCol * disk + vec3(1.0, 0.8, 0.55) * bulge;
    // young proto-galaxies: a few bright star-forming knots in a faint irregular haze
    if (vMisc.w > 0.01) {
      float kn = 0.0;
      for (int k = 0; k < 5; k++) {
        float a = hash11(vSeed * 17.3 + float(k) * 3.1) * TAU;
        float rk = 0.5 * sqrt(hash11(vSeed * 29.1 + float(k) * 5.7));
        vec2 c = vec2(cos(a), sin(a)) * rk;
        float sz = 0.1 + 0.12 * hash11(vSeed * 7.7 + float(k));
        float w = 0.4 + 0.9 * hash11(vSeed * 3.9 + float(k) * 1.3);
        vec2 dd = m - c;
        kn += w * exp(-dot(dd, dd) / (sz * sz));
      }
      vec3 y = vec3(0.62, 0.76, 1.0) * (exp(-rr / 0.38) * 0.35 + kn * 0.9) + vec3(0.9, 0.95, 1.0) * kn * kn * 0.15;
      g = mix(g, y, vMisc.w);
    }
    g *= smoothstep(1.7, 1.0, rr);
    col = mix(col, g, vMisc.x);
  }
  o = vec4(col * vI, 1.0);
}`);

  const DM_VS = U.glsl.vert(CAM_GLSL + `
layout(location=0) in vec4 aP;
uniform float uDM, uFogL, uPtSize, uNearFade;
out float vI;
void main() {
  vec3 rel = aP.xyz - uEye;
  vec3 vp = uViewRot * rel;
  float dist = length(rel);
  float f = aP.w * uDM * smoothstep(uNearFade * 0.4, uNearFade, dist) * exp(-dist / uFogL);
  vI = f;
  gl_PointSize = uPtSize;
  gl_Position = (f < 1e-4 || vp.z > -0.01) ? vec4(2.0, 2.0, 2.0, 1.0) : uProj * vec4(vp, 1.0);
}`);
  const DM_FS = U.glsl.frag(`
in float vI;
out vec4 o;
uniform vec3 uCol;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  o = vec4(uCol * exp(-dot(c, c) * 2.6) * vI, 1.0);
}`);

  const GAS_FS = U.glsl.frag(`
precision highp sampler3D;
in vec2 vUv;
out vec4 o;
uniform sampler3D uVol, uNoise;
uniform mat3 uCamRot;
uniform vec3 uEye;
uniform vec2 uTan;
uniform float uHalf, uSphere, uGas, uFogL, uHot;
uniform int uSteps;
uniform vec3 uColFil, uColFil2, uColNode;
void main() {
  vec3 rd = normalize(uCamRot * vec3((vUv * 2.0 - 1.0) * uTan, -1.0));
  float b = dot(uEye, rd), c = dot(uEye, uEye) - uSphere * uSphere, h = b * b - c;
  if (h < 0.0) { o = vec4(0.0); return; }
  h = sqrt(h);
  float t0 = max(-b - h, 0.0), t1 = -b + h;
  if (t1 <= 0.0) { o = vec4(0.0); return; }
  float L = t1 - t0;
  // exponentially spaced samples (dense near the camera when inside the volume)
  float ce = clamp(log(1.0 + L / max(t0 + 1.5, 1.5)), 0.05, 4.5);
  float E = exp(ce) - 1.0;
  float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  vec3 acc = vec3(0.0);
  float fs = float(uSteps);
  for (int i = 0; i < 48; i++) {
    if (i >= uSteps) break;
    float x = (float(i) + jit) / fs;
    float ex = exp(ce * x);
    float t = t0 + L * (ex - 1.0) / E;
    float dt = L * ce * ex / E / fs;
    vec3 p = uEye + rd * t;
    vec2 g = texture(uVol, p / (2.0 * uHalf) + 0.5).rg;
    if (g.r + g.g < 0.004) continue;
    float n1 = texture(uNoise, p * 0.045).r;
    float n2 = texture(uNoise, p * 0.17 + 0.37).r;
    float fil = g.r * g.r * (0.15 + 2.2 * n1 * n2 * (0.6 + 0.8 * n1));
    float hot = g.g * g.g;
    vec3 e = mix(uColFil, uColFil2, n2) * fil + uColNode * hot * uHot * (0.7 + 0.6 * n1);
    acc += e * dt * exp(-t / uFogL) * smoothstep(0.3, 3.0, t);
  }
  o = vec4(acc * uGas, 1.0);
}`);

  const COPY_FS = U.glsl.frag(`
in vec2 vUv;
out vec4 o;
uniform sampler2D uSrc;
uniform vec2 uTexel;
void main() {
  vec3 c = texture(uSrc, vUv + uTexel * vec2(0.5, 0.5)).rgb + texture(uSrc, vUv + uTexel * vec2(-0.5, 0.5)).rgb +
           texture(uSrc, vUv + uTexel * vec2(0.5, -0.5)).rgb + texture(uSrc, vUv + uTexel * vec2(-0.5, -0.5)).rgb;
  o = vec4(c * 0.25, 1.0);
}`);

  // Shared soft sprite fragment shader (merger and Milky Way particles).
  const SPRITE_FS = U.glsl.frag(`
in vec2 vC;
in vec3 vCol;
in float vI;
out vec4 o;
void main() {
  o = vec4(vCol * exp(-0.5 * dot(vC, vC)) * vI, 1.0);
}`);

  // Sprite helper: world-space gaussian sigma -> quad; conserves flux below minSig px.
  const SPRITE_GLSL = `
out vec2 vC;
out vec3 vCol;
out float vI;
void sprite(vec3 vp, float sigW, float I, vec3 col, float minSig) {
  float z = -vp.z;
  if (z < 0.0005 || I < 1e-5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float sig = sigW / z * uPxScale;
  float sg = max(sig, minSig);
  I *= (sig / sg) * (sig / sg);
  float ext = sg * 3.0;
  vC = aCorner * 3.0;
  vCol = col;
  vI = I;
  gl_Position = uProj * vec4(vp.xy + aCorner * ext * z / uPxScale, vp.z, 1.0);
}`;

  // merger particles
  const MG_VS = U.glsl.vert(CAM_GLSL + `
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 aInfo; // galaxy, r0, kind, seed
uniform highp sampler2D uSim;
uniform float uFrame, uFrames;
uniform int uRowsPer;
uniform vec3 uOff;      // object origin relative to the eye (world)
uniform mat3 uObj;      // object axes * scale
uniform float uSince, uTm, uBright, uScale, uPN;
` + SPRITE_GLSL + `
vec3 fetchP(int id, int f) {
  return texelFetch(uSim, ivec2(id & ${SIM_W - 1}, f * uRowsPer + (id >> ${Math.log2(SIM_W)})), 0).xyz;
}
void main() {
  int id = gl_InstanceID;
  float f = clamp(uFrame, 0.0, uFrames - 1.001);
  int f0 = int(f);
  float fr = f - float(f0);
  float kind = aInfo.z, r0 = aInfo.y, seed = aInfo.w, gal = aInfo.x;
  int sid = kind > 3.5 ? int(gal + 0.5) : id; // halo sprites ride on their nucleus
  vec3 p = mix(fetchP(sid, f0), fetchP(sid, f0 + 1), fr);
  vec3 c0 = mix(fetchP(0, f0), fetchP(0, f0 + 1), fr);
  vec3 c1 = mix(fetchP(1, f0), fetchP(1, f0 + 1), fr);
  if (kind < 1.5) {          // stars: concentrate toward their own nucleus (a continuous bulge -> disk profile)
    vec3 cg = gal > 0.5 ? c1 : c0, dp = p - cg;
    float d = length(dp);
    p = cg + dp * (0.3 + 0.7 * smoothstep(0.0, 0.7, d));
  }
  vec3 vp = uViewRot * (uOff + uObj * p);
  float h = hash11(seed * 7.1 + 0.5);
  // starburst envelopes: dark before the cue, already lit on the cue frame, sharp rise, slow decay
  float tm = max(uTm, 0.0), on = step(0.0, uTm);
  float atk = on * (1.0 - 0.5 * exp(-tm / 0.035));
  float flare = atk * exp(-tm / 0.5);
  float sustain = on * smoothstep(0.0, 0.7, tm) * exp(-tm / 6.0);
  float dCore = min(length(p - c0), length(p - c1));
  float tail = smoothstep(0.9, 3.2, dCore);
  // the tidal bridge between the nuclei, where the compressed gas ignites first
  vec3 v = c1 - c0;
  float vv = max(dot(v, v), 1e-4);
  float tb = dot(p - c0, v) / vv;
  vec3 q = p - c0 - v * clamp(tb, 0.0, 1.0);
  float bridge = smoothstep(-0.15, 0.2, tb) * (1.0 - smoothstep(0.8, 1.15, tb)) * exp(-dot(q, q) / 0.09)
               * smoothstep(0.25, 0.6, sqrt(vv));
  float nuc = exp(-dCore * dCore / 0.1);
  float sigW, I;
  vec3 col;
  if (kind > 3.5) {          // soft bulge glow; on the cue it becomes the localized starburst halo
    float burst = 0.36 * flare + 0.03 * sustain, bulge = 0.08;
    sigW = 0.28 + 0.14 * smoothstep(0.0, 0.3, tm);
    I = (bulge + burst) * (gal > 0.5 ? 0.8 : 1.0);
    vec3 bc = mix(vec3(1.0, 0.5, 0.72), vec3(0.78, 0.86, 1.0), exp(-tm / 0.25));
    col = (vec3(1.0, 0.78, 0.52) * bulge + bc * burst) / (bulge + burst);
  } else if (kind > 2.5) {   // nucleus
    sigW = 0.05; I = 0.9 * (gal > 0.5 ? 0.8 : 1.0);
    col = mix(vec3(1.0, 0.8, 0.56), vec3(0.88, 0.92, 1.0), flare);
    I *= 1.0 + 4.5 * flare + 1.2 * smoothstep(3.5, 8.0, uSince);
  } else if (kind > 1.5) {   // gas: faint before, then starburst knots + diffuse pink HII glow
    float hk = hash11(seed * 5.9 + 0.7);
    float zone = max(bridge, nuc);
    float w = flare * (0.1 + 2.4 * zone) + sustain * (0.25 + 0.5 * zone + 0.6 * tail);
    float s = smoothstep(0.0, 0.25, w);
    vec3 pink = vec3(1.0, 0.24, 0.52), blue = vec3(0.5, 0.68, 1.0), white = vec3(0.85, 0.9, 1.0);
    if (hk < 0.4) {          // compact young clusters
      sigW = mix(0.03, mix(0.009, 0.018, hk * 2.5), s);
      I = 0.01 + w * 0.42 * (0.3 + 0.7 * h * h) * (1.0 - 0.4 * tail);
      col = mix(vec3(0.6, 0.72, 1.0), hash11(seed * 3.3) < 0.5 ? pink : (h > 0.6 ? white : blue), s);
    } else {                 // diffuse ionised gas: continuous glow along the bridge and the tails
      sigW = mix(0.035, 0.055 + 0.03 * tail, s);
      I = 0.004 + w * 0.009 * (1.0 - 0.5 * tail);
      col = mix(vec3(0.6, 0.72, 1.0), mix(vec3(1.0, 0.36, 0.6), vec3(1.0, 0.55, 0.72), h), s);
    }
  } else if (kind > 0.5) {   // disk light (young, outer): wider, fainter sprites where the tails thin out
    float wid = 1.0 + 1.4 * tail;
    sigW = 0.03 * wid; I = 0.012 * (0.6 + 0.8 * h) * uPN * (1.0 + 1.8 * tail) / (wid * wid);
    col = mix(vec3(1.0, 0.88, 0.74), vec3(0.58, 0.72, 1.0), smoothstep(0.3, 0.9, r0));
    if (h > 0.97) { sigW = 0.008; I = 0.06 * (h - 0.96) * 25.0 * mix(1.0, 0.4, tail); } // a few young clusters
  } else {                   // inner (old) light
    sigW = 0.04; I = 0.013 * (0.6 + 0.8 * h) * uPN;
    col = vec3(1.0, 0.8, 0.58);
  }
  sprite(vp, sigW * uScale, I * uBright, col, 0.7);
}`);

  // Milky Way maps shared by the disk shader and the particles. Galaxy frame: unit = galaxy radius,
  // disk in xz, normal +y; the arm pattern frame is rotated by uPhi (theta_pattern = theta - uPhi).
  const MW_MAPS = `
uniform sampler2D uTex;
uniform float uPhi, uTanP, uAsm, uMinor, uArmK;
const float ARM_R0 = ${ARM_R0.toFixed(3)};
float wrapPi(float a) { return a - TAU * floor((a + PI) / TAU); }
float mwWarp(vec2 xzp) {
  return (textureLod(uTex, xzp * 0.2 + vec2(0.13, 0.71), 0.0).r - 0.5) * 0.5 + (textureLod(uTex, xzp * 0.65 + vec2(0.37, 0.21), 0.0).r - 0.5) * 0.16;
}
`;

  // Milky Way: ray-traced thin disk + bulge (fullscreen, early-out outside the bounding sphere).
  const MW_FS = U.glsl.frag(MW_MAPS + `
in vec2 vUv;
out vec4 o;
uniform mat3 uCamRot;
uniform vec2 uTan;
uniform vec3 uO;        // eye in galaxy units
uniform float uBright, uDust, uBulge, uProto;
float erfA(float x) {
  float x2 = x * x;
  const float a = 0.147;
  return sign(x) * sqrt(1.0 - exp(-x2 * (1.2732395 + a * x2) / (1.0 + a * x2)));
}
// gaussian blob (flattened by q in y) integrated along the ray; returns (total, fraction behind tp)
vec2 blob(vec3 ro, vec3 rd, float sig, float q, float tp) {
  vec3 s = vec3(1.0, 1.0 / q, 1.0);
  vec3 o2 = ro * s, d2 = rd * s;
  float L = length(d2);
  vec3 u = d2 / L;
  float tc = -dot(o2, u);
  float b2 = max(dot(o2, o2) - tc * tc, 0.0);
  float tot = exp(-b2 / (2.0 * sig * sig)) * sig * 2.5066 / L;
  float behind = 0.5 - 0.5 * erfA((tp * L - tc) / (sig * 1.41421));
  return vec2(tot, behind);
}
void main() {
  vec3 rd = normalize(uCamRot * vec3((vUv * 2.0 - 1.0) * uTan, -1.0));
  float b = dot(uO, rd), c = dot(uO, uO) - 2.6, h = b * b - c;
  if (h < 0.0 || -b + sqrt(max(h, 0.0)) < 0.0) discard;
  float tp = -uO.y / rd.y;
  vec3 col = vec3(0.0);
  float trans = 1.0;
  float a = uAsm;
  if (tp > 0.0) {
    vec3 hp = uO + rd * tp;
    vec2 xzp = rot2(-uPhi) * hp.xz; // pattern frame
    float r = length(xzp);
    float th = atan(xzp.y, xzp.x);
    vec4 nA = texture(uTex, xzp * 0.55 + vec2(0.71, 0.29));
    vec4 nB = texture(uTex, xzp * 1.6 + vec2(0.37, 0.21));
    vec4 nC = texture(uTex, xzp * 4.4 + vec2(0.61, 0.43));
    float warp = mwWarp(xzp);
    float lr = log(max(r, 0.03) / ARM_R0) / uTanP;
    float minor = 0.42 * smoothstep(0.28, 0.5, r) * uMinor;
    float aS = 0.0, aY = 0.0, aD = 0.0, aH = 0.0;
    for (int m = 0; m < 4; m++) {
      float amp = (m & 1) == 0 ? 1.0 : minor;
      float psi = wrapPi(th - float(m) * 1.5707963 - lr + warp);
      aS += amp * exp(-psi * psi * 3.2);
      aY += amp * exp(-psi * psi * 9.0);
      float pd = psi - 0.27; aD += amp * exp(-pd * pd * 30.0);
      float ph = psi - 0.12; aH += amp * exp(-ph * ph * 30.0);
    }
    aS = mix(0.45, aS, uArmK); aY = mix(0.3, aY, uArmK); aD = mix(0.25, aD, uArmK); aH *= uArmK;
    float edgeR = mix(0.75, 1.0, a) + 0.08 * (nA.b - 0.5);
    float armEnv = smoothstep(0.12, 0.26, r) * (1.0 - smoothstep(0.8 * edgeR, 1.15 * edgeR, r));
    float disk = exp(-r / 0.3) * (1.0 - smoothstep(0.9 * edgeR, 1.3 * edgeR, r));
    float oldS = disk * (0.35 + 0.65 * aS * armEnv);
    float young = armEnv * aY * (0.25 + 1.5 * nB.g * nB.g) * (0.2 + 1.6 * nA.g);
    float dustEnv = smoothstep(0.08, 0.2, r) * (1.0 - smoothstep(0.85 * edgeR, 1.12 * edgeR, r));
    float dust = dustEnv * (aD * 1.1 + 0.18 * aS + 0.05) * (0.2 + 1.6 * nC.b * nB.b);
    // bar dust lanes (the bar lies along x of the pattern frame)
    float side = xzp.x >= 0.0 ? 1.0 : -1.0;
    float bl = exp(-pow((xzp.y - side * 0.035 - xzp.x * 0.12) / 0.012, 2.0)) * smoothstep(0.24, 0.14, abs(xzp.x)) * smoothstep(0.02, 0.07, abs(xzp.x));
    dust += bl * 0.9 * (0.4 + nC.b) * uBulge;
    float hii = armEnv * aH * pow(clamp(nC.g * 2.0 - 0.55, 0.0, 1.0), 2.5) * smoothstep(0.22, 0.38, r);
    // proto disk: clumpy, puffy, young
    float protoD = exp(-r / 0.4) * (0.35 + 1.3 * nB.b * nA.g) * (1.0 - smoothstep(0.55, 1.05, r));
    float bar = exp(-(xzp.x * xzp.x / 0.026 + xzp.y * xzp.y / 0.0036)) * uBulge;
    float slab = 1.0 / max(abs(rd.y), 0.28);
    vec3 emit = vec3(1.0, 0.8, 0.56) * (oldS * 1.1 + bar * 0.8) * a
              + vec3(0.62, 0.76, 1.0) * young * 1.5 * a
              + vec3(1.0, 0.3, 0.48) * hii * 0.4 * a
              + vec3(0.55, 0.68, 1.0) * protoD * 0.45 * (1.0 - a);
    trans = exp(-dust * 1.6 * uDust / max(abs(rd.y), 0.3));
    col += emit * slab * 0.5 * mix(1.0, trans, 0.85);
  }
  // bulge: two flattened gaussians; the far half is seen through the dusty disk
  float tpp = tp > 0.0 ? tp : 1e9;
  vec2 b1 = blob(uO, rd, 0.045, 0.75, tpp);
  vec2 b2 = blob(uO, rd, 0.12, 0.6, tpp);
  vec2 b0 = blob(uO, rd, 0.022, 0.8, tpp);
  vec2 b5 = blob(uO, rd, 0.26, 0.5, tpp);
  float w1 = b1.x * 50.0 + b0.x * 60.0, w2 = b2.x * 12.0 + b5.x * 3.0;
  float bul = w1 + w2;
  float behind = (b1.x * 50.0 * b1.y + b0.x * 60.0 * b0.y + b2.x * 12.0 * b2.y + b5.x * 3.0 * b5.y) / max(bul, 1e-6);
  bul *= (1.0 - behind) + behind * trans;
  col += vec3(1.0, 0.74, 0.44) * bul * uBulge;
  // proto halo glow (young gas) and a faint stellar halo
  vec2 b3 = blob(uO, rd, 0.45, 0.8, tpp);
  col += vec3(0.5, 0.62, 1.0) * b3.x * 0.18 * uProto;
  vec2 b4 = blob(uO, rd, 0.6, 0.55, tpp);
  col += vec3(0.9, 0.85, 0.85) * b4.x * 0.02 * a;
  o = vec4(col * uBright, 1.0);
}`);

  // Milky Way star clusters / proto clumps
  const MWP_VS = U.glsl.vert(CAM_GLSL + MW_MAPS + `
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 aA; // r, arm (-1 = field), dpsi, kind (0 young cluster, 1 HII, 2 old star)
uniform vec3 uOff;
uniform float uScale, uT, uBright, uThick, uDiff;
` + SPRITE_GLSL + `
void main() {
  int id = gl_InstanceID;
  float r = aA.x, m = aA.y, dpsi = aA.z, kind = aA.w;
  float h1 = hashI(id, 3), h2 = hashI(id, 7), h3 = hashI(id, 11), h4 = hashI(id, 13);
  // disk position (pattern frame) on the arm locus th = m*pi/2 + lr - warp + dpsi
  float lr = log(max(r, 0.03) / ARM_R0) / uTanP;
  float th0 = m < -0.5 ? h1 * TAU : m * 1.5707963 + lr + dpsi;
  float w = mwWarp(r * vec2(cos(th0), sin(th0)));
  float th = (m < -0.5 ? th0 : th0 - w) + uPhi + uDiff * (0.7 / max(r, 0.15) - 1.0);
  float y = (h3 - 0.5) * 0.035 * (0.3 + r) * uThick;
  vec3 pDisk = vec3(r * cos(th), y, r * sin(th));
  // proto: star-forming clumps on inclined orbits
  int ci = id % 14;
  float ang = hashI(ci, 21) * TAU + uT * (0.7 + 0.5 * hashI(ci, 23));
  float inc = (hashI(ci, 25) - 0.5) * 2.0;
  float rr = 0.2 + 0.55 * hashI(ci, 27);
  vec3 cc = vec3(rr * cos(ang), 0.0, rr * sin(ang));
  cc = vec3(cc.x, cc.z * sin(inc), cc.z * cos(inc));
  vec2 ga = sqrt(-2.0 * log(max(hashI(id, 41), 1e-6))) * vec2(cos(TAU * hashI(id, 43)), sin(TAU * hashI(id, 43)));
  vec2 gb = sqrt(-2.0 * log(max(hashI(id, 45), 1e-6))) * vec2(cos(TAU * hashI(id, 47)), sin(TAU * hashI(id, 47)));
  vec3 g3 = vec3(ga, gb.x);
  float wide = step(0.7, h4);
  vec3 pProto = cc * (1.0 - wide) + g3 * mix(0.035 + 0.03 * hashI(ci, 29), 0.3, wide);
  float k = smoothstep(0.05 + 0.45 * h2, 0.45 + 0.5 * h2, uAsm);
  vec3 p = mix(pProto, pDisk, k);
  vec3 vp = uViewRot * (uOff + uScale * p);
  float sigW, I;
  vec3 col;
  if (kind < 0.5) {          // young stars / clusters
    sigW = 0.0035; I = 0.1 * (0.35 + 2.5 * h1 * h1 * h1 * h1 * h1 * h1);
    col = mix(vec3(0.62, 0.74, 1.0), vec3(0.85, 0.9, 1.0), h2);
  } else if (kind < 1.5) {   // HII regions
    sigW = 0.0055; I = 0.075 * (0.4 + h1) * uArmK;
    col = mix(vec3(1.0, 0.28, 0.5), vec3(1.0, 0.42, 0.6), h2);
  } else {                   // old disk stars
    sigW = 0.003; I = 0.04 * (0.4 + h1);
    col = mix(vec3(1.0, 0.82, 0.62), vec3(1.0, 0.94, 0.86), h2);
  }
  I *= mix(2.2, 1.0, k) * smoothstep(0.0, 0.25, uAsm + 0.1);
  sprite(vp, sigW * uScale, I * uBright, col, 0.7);
}`);

  // bake a tileable noise atlas for the galaxy disk: r = fbm, g = ridged, b = fbm, a = fine fbm
  const BAKE_FS = U.glsl.frag(`
in vec2 vUv;
out vec4 o;
float pv(vec2 p, int P, int salt) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  ivec2 c0 = ivec2(i) % P, c1 = (ivec2(i) + 1) % P;
  float a = hashI(c0.x + c0.y * 4096, salt), b = hashI(c1.x + c0.y * 4096, salt);
  float c = hashI(c0.x + c1.y * 4096, salt), d = hashI(c1.x + c1.y * 4096, salt);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float pfbm(vec2 p, int P, int salt, int oct, bool ridge) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 7; i++) {
    if (i >= oct) break;
    float v = pv(p, P, salt + i * 17);
    if (ridge) { v = 1.0 - abs(2.0 * v - 1.0); v *= v; }
    s += a * v; n += a;
    p *= 2.0; P *= 2; a *= 0.5;
  }
  return s / n;
}
void main() {
  vec2 p = vUv * 8.0;
  float r = pfbm(p, 8, 1, 6, false);
  float g = pfbm(p * 2.0, 16, 101, 5, true);
  float b = pfbm(p * 2.0, 16, 201, 5, false);
  float a = pfbm(p * 4.0, 32, 301, 4, false);
  vec4 v = vec4(r, g, b, a);
  v.rba = (v.rba - 0.5) * 2.0 + 0.5;
  v.g = (v.g - 0.35) * 1.8 + 0.35;
  o = clamp(v, 0.0, 1.0);
}`);

  // ------------------------------------------------------------------ state
  let W = null, cam = null;
  let progGal, progDM, progGas, progCopy, progMG, progMW, progMWP;
  let galVao, galCount = 0, dmVao, dmCount = 0, filTex, nodeTex, volTex, noiseTex;
  let mg = null, mgVao, simTex, mwTex, mwVao, mwCount = 0;
  let gasDiv = 2, gasSteps = 40;
  // half-res gas targets, cached by size (two slots: the engine's tiny warm-up render must not evict
  // the full-size one, or the first real gas frame would allocate a new target mid-playback)
  const gasCache = [];
  function gasTarget(gl, w, h) {
    let i = gasCache.findIndex((e) => e.w === w && e.h === h);
    if (i < 0) {
      if (gasCache.length >= 2) U.gl.deleteTarget(gl, gasCache.shift().t);
      gasCache.push({ w, h, t: U.gl.target(gl, w, h, { hdr: true }) });
      i = gasCache.length - 1;
    }
    const e = gasCache.splice(i, 1)[0];
    gasCache.push(e); // most recently used last
    return e.t;
  }
  const gasSize = (w, h) => [Math.max(16, Math.round(w / gasDiv)), Math.max(16, Math.round(h / gasDiv))];
  const view = new Float32Array(16), proj = new Float32Array(16), rot3 = new Float32Array(9), camRot = new Float32Array(9);

  // ------------------------------------------------------------------ camera path
  const dirOf = (az, el) => [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];
  const fovAt = (T) => M.mix(FOV0, FOV1, M.smoothstep(57.0, 60.0, T));
  const T_MW = 60; // from here on the camera follows the 'milkyway' opening path exactly

  function buildCamera() {
    const cues = U.timeline.cues;
    const Ns = W.nodes[W.star].p;
    const az0 = W.az0;
    const keys = [];
    const key = (T, tgt, D, az, el) => keys.push({ T, tgt, D, az, el });
    // the opening target follows the drifting proto-galaxy group
    const Fat = (T) => bezier(W.f0.A, W.f0.C, W.f0.B, driftS(W.sF, T - 45));
    const F = Fat(cues.webReveal);
    const toNs = sub(Ns, F);
    key(45.0, Fat(45), 2.0, az0, 6 * DEG);
    key(47.0, Fat(47), 3.2, az0 + 4 * DEG, 7 * DEG);
    key(48.2, add(Fat(48.2), scl(toNs, 0.05)), 5.4, az0 + 7.5 * DEG, 8.5 * DEG);
    // the pull-back doubles its speed on the webReveal cue, so the web widens as it lights up
    key(cues.webReveal, add(F, scl(toNs, 0.12)), 8.8, az0 + 11 * DEG, 10 * DEG);
    key(50.0, add(F, scl(toNs, 0.3)), 25, az0 + 17 * DEG, 13.5 * DEG);
    key(51.0, add(F, scl(toNs, 0.5)), 50, az0 + 24 * DEG, 16 * DEG);
    key(51.9, add(F, scl(toNs, 0.72)), 68, az0 + 30 * DEG, 18 * DEG);
    // The merger happens in the infall region ~10 units in front of the hero cluster, which stays
    // in the background, upper right, as context. The dive comes to rest on the pair exactly on the
    // galaxyMerger cue, then the camera eases back while the tails unfurl and holds on the remnant.
    const azA = az0 + 52 * DEG, elA = 14 * DEG;
    const a = dirOf(azA, elA), fwd = scl(a, -1);
    const right = nrm(cross(fwd, [0, 1, 0])), up = cross(right, fwd);
    W.basis = { a, fwd, right, up };
    W.Pmg = madd([Ns, 1], [a, 10.5], [right, -3.0], [up, -2.9]);
    // the young Milky Way lies off to the left, so the camera pans to it without crossing the tails
    W.Pmw = madd([W.Pmg, 1], [fwd, 0.6], [right, -1.8], [up, 0.1]);
    key(53.6, W.Pmg, 2.2, azA - 3 * DEG, elA + 1.5 * DEG);
    key(cues.galaxyMerger, W.Pmg, 1.05, azA, elA);
    key(55.6, W.Pmg, 1.3, azA + 1.6 * DEG, elA);
    key(56.7, W.Pmg, 1.7, azA + 3.2 * DEG, elA + 0.5 * DEG);
    key(58.6, W.Pmw, 5.8 * MW_R, azA + 18.5 * DEG, 24 * DEG);
    key(59.3, W.Pmw, 3.85 * MW_R, azA + 20.5 * DEG, 28 * DEG);
    key(T_MW, W.Pmw, Math.exp(MWC.logD(T_MW)) * MW_R, azA + 22 * DEG, MWC.eps(T_MW) * DEG);
    const ts = keys.map((k) => k.T);
    const AZ_RATE = 1.0 * DEG; // world azimuth drift after 60 s (only the background sees it)
    const c = {
      tx: monotone(ts, keys.map((k) => k.tgt[0])), ty: monotone(ts, keys.map((k) => k.tgt[1])), tz: monotone(ts, keys.map((k) => k.tgt[2])),
      ld: monotone(ts, keys.map((k) => Math.log(k.D)), MWC.logD.m0),
      az: monotone(ts, keys.map((k) => k.az), AZ_RATE),
      el: monotone(ts, keys.map((k) => k.el), MWC.eps.m0 * DEG),
      az60: keys[keys.length - 1].az, azRate: AZ_RATE,
    };
    return c;
  }

  function camAt(T) {
    let tgt, D, az, el;
    if (T >= T_MW) {
      tgt = W.Pmw;
      D = Math.exp(MWC.logD(T)) * MW_R;
      el = MWC.eps(T) * DEG;
      az = cam.az60 + cam.azRate * (T - T_MW);
    } else {
      tgt = [cam.tx(T), cam.ty(T), cam.tz(T)];
      D = Math.exp(cam.ld(T));
      az = cam.az(T);
      el = cam.el(T);
    }
    const eye = add(tgt, scl(dirOf(az, el), D));
    return { eye, tgt, D, az };
  }
  const azAt = (T) => (T >= T_MW ? cam.az60 + cam.azRate * (T - T_MW) : cam.az(T));

  // Pattern angle of the Milky Way: locked so that 'milkyway' sees the same arms at 60-62 (its camera
  // sits at theta = pi/2 - alpha of its galaxy frame), with extra spin while the disk assembles.
  function phiAt(T) {
    const lock = (t) => azAt(t) - Math.PI / 2 + alphaMW(t);
    if (T >= T_MW) return lock(T);
    const w60 = (lock(T_MW + 0.01) - lock(T_MW)) / 0.01;
    const k = 1 - M.smoothstep(55, T_MW, T);
    return lock(T_MW) + w60 * (T - T_MW) - 1.1 * k * k;
  }

  // ------------------------------------------------------------------ init
  function tex3D(gl, data, N, ifmt, fmt, wrap) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, ifmt, N, N, N, 0, fmt, gl.UNSIGNED_BYTE, data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    const w = wrap === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, w);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, w);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, w);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.bindTexture(gl.TEXTURE_3D, null);
    return t;
  }

  // The CPU bakes are generators that yield every fraction of a millisecond; run() drives them in
  // slices of <= SLICE_MS separated by a macrotask, so init never blocks the page for long and the
  // driver compiles the programs in the meantime. Same code and rng call order as a synchronous
  // run, so the baked data (and every rendered pixel) is identical.
  const SLICE_MS = 6;
  let sliceT0 = 0, sliceMax = 0, slices = 0;
  async function pause() {
    sliceMax = Math.max(sliceMax, performance.now() - sliceT0);
    slices++;
    await new Promise((r) => setTimeout(r, 0));
    sliceT0 = performance.now();
  }
  async function tick() { if (performance.now() - sliceT0 > SLICE_MS) await pause(); }
  async function run(gen) {
    for (;;) {
      const r = gen.next();
      if (r.done) return r.value;
      if (performance.now() - sliceT0 > SLICE_MS) await pause();
    }
  }

  // Milky Way particles: (r, arm, dpsi, kind)
  function* buildMWParticles(rng, nMW) {
    const mwA = new Float32Array(nMW * 4);
    const pickArm = (h, r) => {
      let m = h < 0.38 ? 0 : h < 0.76 ? 2 : h < 0.88 ? 1 : 3;
      if (r < 0.32 && (m === 1 || m === 3)) m -= 1;
      return m;
    };
    const armR = () => { let r; do { r = 0.13 - 0.27 * Math.log(Math.max(1e-9, rng() * rng())); } while (r > 1.08); return r; };
    let kk = 0;
    const put = (r, m, dpsi, kind) => { if (kk < nMW) { mwA.set([r, m, dpsi, kind], kk * 4); kk++; } };
    const nHII = Math.round(nMW * 0.05), nCl = nHII + Math.round(nMW * 0.3), nYo = nCl + Math.round(nMW * 0.35);
    while (kk < nHII) { // HII regions: pink clumps just inside the arm crests
      const rc = 0.28 + 0.75 * Math.pow(rng(), 0.8), m = pickArm(rng(), rc), pc = 0.12 + gauss(rng) * 0.05;
      const n = 10 + Math.floor(rng() * 22), sz = 0.004 + 0.008 * rng();
      for (let j = 0; j < n; j++) put(Math.max(0.05, rc + gauss(rng) * sz), m, pc + gauss(rng) * sz / rc, 1);
    }
    yield;
    while (kk < nCl) { // young star clusters / OB associations along the arms
      const rc = armR(), m = pickArm(rng(), rc), pc = gauss(rng) * 0.13;
      const n = 10 + Math.floor(rng() * 30), sz = 0.008 + 0.014 * rng();
      for (let j = 0; j < n; j++) put(Math.max(0.05, rc + gauss(rng) * sz), m, pc + gauss(rng) * sz / rc, 0);
    }
    yield;
    while (kk < nYo) { const r = armR(); put(r, pickArm(rng(), r), gauss(rng) * 0.17, 0); } // diffuse arm stars
    yield;
    while (kk < nMW) { // old disk stars
      let r; do { r = -0.3 * Math.log(Math.max(1e-9, rng())); } while (r > 1.05 || r < 0.05);
      put(r, -1, 0, 2);
    }
    return { mwA, count: kk };
  }

  async function init(gl, ctx) {
    const t0 = performance.now();
    sliceT0 = t0; sliceMax = 0; slices = 0;
    const ps = ctx.particleScale || 1;
    const tier = ctx.tier;

    // 1. every program first (the driver compiles them in parallel while the CPU work below runs;
    //    none of them is used before step 3)
    progGal = U.gl.program(gl, GAL_VS, GAL_FS, 'cosmicweb-gal');
    progDM = U.gl.program(gl, DM_VS, DM_FS, 'cosmicweb-dm');
    progGas = U.gl.program(gl, U.gl.FULLSCREEN_VS, GAS_FS, 'cosmicweb-gas');
    progCopy = U.gl.program(gl, U.gl.FULLSCREEN_VS, COPY_FS, 'cosmicweb-copy');
    progMG = U.gl.program(gl, MG_VS, SPRITE_FS, 'cosmicweb-merger');
    progMW = U.gl.program(gl, U.gl.FULLSCREEN_VS, MW_FS, 'cosmicweb-mw');
    progMWP = U.gl.program(gl, MWP_VS, SPRITE_FS, 'cosmicweb-mwp');
    const progBake = U.gl.program(gl, U.gl.FULLSCREEN_VS, BAKE_FS, 'cosmicweb-bake');

    // 2. CPU work, chunked (the rng call order is the original one: web, galaxies, streams,
    //    opening, DM, gas volume, noise, Milky Way particles; the merger has its own rng)
    const rng = M.rng(0xC05317);
    W = await run(buildWeb(rng));
    // the opening shot: a filament attached to the hero cluster, ~45% of the way out
    const sfils = W.nodes[W.star].fils.map((i) => W.fils[i]).filter((f) => {
      const other = f.a === W.star ? f.b : f.a;
      return len(W.nodes[other].p) < WEB_R - 15;
    });
    sfils.sort((x, y) => y.w - x.w);
    const f0 = sfils[0] || W.fils[0];
    W.f0 = f0;
    W.sF = f0.a === W.star ? 0.55 : 0.45;
    const tF = bezierT(f0.A, f0.C, f0.B, W.sF);
    W.az0 = Math.atan2(tF[2], tF[0]) + Math.PI / 2;

    cam = buildCamera();
    const excl = [{ p: W.Pmw, r: 1.1 }, { p: W.Pmg, r: 0.6 }];
    const G = await run(buildGalaxies(rng, W, Math.round(130000 * ps), excl));
    addStreams(rng, W, G, ps);
    await tick();
    addOpening(rng, W, G, ps);
    await tick();
    galCount = G.Q.length / 4;
    const galP = new Float32Array(G.P), galQ = new Float32Array(G.Q);
    await tick();
    const DM = await run(buildDM(rng, W, Math.round(260000 * ps)));
    const VN = tier === 'low' ? 96 : 128;
    const vol = await run(buildVolume(rng, W, VN));
    const noise = await run(buildNoise3(rng, 32));
    const MWP = await run(buildMWParticles(rng, Math.round(30000 * ps)));
    const t1 = performance.now();
    mg = await run(simulateMerger(M.rng(0xBADA55), Math.round(8000 * ps)));
    {
      // orbital plane tilted ~43 deg from face-on as seen at the collision (both disks and the
      // tails read clearly; neither disk is edge-on)
      const { fwd, right, up } = W.basis;
      const ez = nrm(add(scl(fwd, -Math.cos(0.75)), scl(up, Math.sin(0.75))));
      const ex = nrm(sub(right, scl(ez, dot(right, ez))));
      const ey = cross(ez, ex);
      W.mgObj = new Float32Array([...scl(ex, MG_R), ...scl(ey, MG_R), ...scl(ez, MG_R)]);
    }
    const t2 = performance.now();
    await pause();

    // 3. GPU: buffers, textures, the Milky Way texture bake, then a pre-warm of every program
    const quadBuf = U.gl.buffer(gl, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]));
    const galPBuf = U.gl.buffer(gl, galP);
    await tick();
    const galQBuf = U.gl.buffer(gl, galQ);
    await tick();
    galVao = U.gl.vao(gl, [
      { loc: 0, buffer: quadBuf, size: 2 },
      { loc: 1, buffer: galPBuf, size: 4, divisor: 1 },
      { loc: 2, buffer: galQBuf, size: 4, divisor: 1 },
    ]);
    dmCount = DM.count;
    dmVao = U.gl.vao(gl, [{ loc: 0, buffer: U.gl.buffer(gl, DM.P.subarray(0, DM.count * 4)), size: 4 }]);
    await tick();

    // filament texture: 4 texels per filament; node texture: position + mass
    const nf = W.fils.length;
    const ft = new Float32Array(4 * nf * 4);
    W.fils.forEach((f, i) => {
      const o = i * 16;
      ft.set([f.A[0], f.A[1], f.A[2], f.a], o);
      ft.set([f.C[0], f.C[1], f.C[2], f.rad], o + 4);
      ft.set([f.B[0], f.B[1], f.B[2], f.b], o + 8);
      ft.set([f.ref[0], f.ref[1], f.ref[2], f.len], o + 12);
    });
    filTex = U.gl.texture(gl, ft, { width: 4, height: nf, internalFormat: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT, filter: 'nearest' });
    const nt = new Float32Array(W.nodes.length * 4);
    W.nodes.forEach((n, i) => nt.set([n.p[0], n.p[1], n.p[2], n.m], i * 4));
    nodeTex = U.gl.texture(gl, nt, { width: 1, height: W.nodes.length, internalFormat: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT, filter: 'nearest' });
    await tick();
    volTex = tex3D(gl, vol, VN, gl.RG8, gl.RG, 'clamp');
    noiseTex = tex3D(gl, noise, 32, gl.R8, gl.RED, 'repeat');
    await tick();

    // The merger frames (~28 MB of RGB32F on high) are staged in a pixel-unpack buffer in 2 MB
    // pieces, then copied into the texture in one full-level call (a band-wise texSubImage2D would
    // make the browser zero-fill the whole texture first, ~30 ms in one go).
    {
      const simH = mg.rowsPer * mg.nFrames, n = mg.tex.length, STEP = 1 << 19;
      const pbo = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, pbo);
      gl.bufferData(gl.PIXEL_UNPACK_BUFFER, mg.tex.byteLength, gl.STATIC_DRAW);
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
      for (let o = 0; o < n; o += STEP) {
        await tick();
        gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, pbo);
        gl.bufferSubData(gl.PIXEL_UNPACK_BUFFER, o * 4, mg.tex, o, Math.min(STEP, n - o));
        gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
      }
      await tick();
      simTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, simTex);
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, pbo);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB32F, mg.W, simH, 0, gl.RGB, gl.FLOAT, 0);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
      gl.deleteBuffer(pbo);
      for (const [k, v] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    mg.tex = null;
    await tick();
    mgVao = U.gl.vao(gl, [
      { loc: 0, buffer: quadBuf, size: 2 },
      { loc: 1, buffer: U.gl.buffer(gl, mg.info), size: 4, divisor: 1 },
    ]);
    mwCount = MWP.count;
    mwVao = U.gl.vao(gl, [
      { loc: 0, buffer: quadBuf, size: 2 },
      { loc: 1, buffer: U.gl.buffer(gl, MWP.mwA), size: 4, divisor: 1 },
    ]);
    await pause();
    {
      const t = U.gl.target(gl, 1024, 1024, { hdr: false });
      await U.gl.compiled(gl, [progBake]);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
      gl.viewport(0, 0, 1024, 1024);
      for (const cap of [gl.BLEND, gl.DEPTH_TEST, gl.CULL_FACE, gl.SCISSOR_TEST]) gl.disable(cap);
      progBake.use();
      U.gl.drawFullscreen(gl);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteProgram(progBake.program);
      gl.deleteFramebuffer(t.fb);
      mwTex = t.tex;
      await pause();
      gl.bindTexture(gl.TEXTURE_2D, mwTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    await pause();

    gasDiv = tier === 'high' ? 2.5 : 3;
    gasSteps = tier === 'high' ? 34 : tier === 'mid' ? 26 : 20;
    // Pre-warm: draw every program once at a few times into a tiny target, so that no driver-side
    // compile/link or resource allocation is left for the first frames in which each one appears
    // (the engine's own warm-up only renders the scene's midpoint, where the Milky Way is not drawn).
    await U.gl.compiled(gl, [progGal, progDM, progGas, progCopy, progMG, progMW, progMWP]);
    const t3 = performance.now();
    if (ctx.width > 0 && ctx.height > 0) { const [gw, gh] = gasSize(ctx.width, ctx.height); gasTarget(gl, gw, gh); }
    const wt = U.gl.target(gl, 64, 64, { hdr: true, depth: true });
    const bind = () => { gl.bindFramebuffer(gl.FRAMEBUFFER, wt.fb); gl.viewport(0, 0, 64, 64); };
    for (const T of [54.0, 58.0]) {
      bind();
      for (const cap of [gl.BLEND, gl.DEPTH_TEST, gl.CULL_FACE, gl.SCISSOR_TEST]) gl.disable(cap);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      render(gl, { T, t: T - 45, cues: U.timeline.cues, width: 64, height: 64, aspect: 1, post: {}, tier, particleScale: ps, bindOutput: bind });
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.bindVertexArray(null);
      gl.useProgram(null);
      for (let u = 0; u < 2; u++) {
        gl.activeTexture(gl.TEXTURE0 + u);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.bindTexture(gl.TEXTURE_3D, null);
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      await pause();
    }
    U.gl.deleteTarget(gl, wt);
    const t4 = performance.now();
    sliceMax = Math.max(sliceMax, t4 - sliceT0);
    // init timing for profiling tools (read-only diagnostics; nothing depends on it)
    U.cosmicwebInitMs = { cpu: Math.round(t1 - t0), merger: Math.round(t2 - t1), warm: Math.round(t4 - t3), total: Math.round(t4 - t0), slices, sliceMax: Math.round(sliceMax * 10) / 10 };
  }

  // ------------------------------------------------------------------ render
  function render(gl, s) {
    const T = s.T, cues = s.cues;
    const ss = M.smoothstep;
    const c = camAt(T);
    const aspect = s.aspect;
    const tanS = Math.tan(fovAt(T) / 2);
    const tanY = tanS / Math.min(aspect, 1), tanX = tanY * aspect;
    // view rotation (world -> view); everything is rendered eye-relative
    M.lookAt(view, [0, 0, 0], sub(c.tgt, c.eye), [0, 1, 0]);
    rot3[0] = view[0]; rot3[1] = view[1]; rot3[2] = view[2];
    rot3[3] = view[4]; rot3[4] = view[5]; rot3[5] = view[6];
    rot3[6] = view[8]; rot3[7] = view[9]; rot3[8] = view[10];
    camRot[0] = rot3[0]; camRot[1] = rot3[3]; camRot[2] = rot3[6];
    camRot[3] = rot3[1]; camRot[4] = rot3[4]; camRot[5] = rot3[7];
    camRot[6] = rot3[2]; camRot[7] = rot3[5]; camRot[8] = rot3[8];
    M.perspective(proj, 2 * Math.atan(tanY), aspect, Math.max(1e-4, c.D * 0.005), 600);
    const pxScale = s.height / (2 * tanY);
    const camU = { uViewRot: rot3, uEye: c.eye, uProj: proj, uPxScale: pxScale };

    // ---------------------------------------------------------------- gas
    // webReveal: before the cue only the galaxies (and a ghost of gas) are seen; on the cue the gas
    // switches on within ~0.2 s with an overshoot, while the pull-back speeds up
    const tr = T - cues.webReveal;
    const rev = tr >= 0 ? 1 - 0.8 * Math.exp(-tr / 0.16) : 0; // 20% already on the cue frame
    const revPulse = tr >= 0 ? 0.6 * (tr / 0.3) * Math.exp(1 - tr / 0.3) : 0;
    const gas = (0.06 * ss(47.4, 48.9, T) * (1 - rev) + rev) * (1 + revPulse) * (1 - ss(53.2, 55.0, T));
    if (gas > 0.002) {
      const [gw, gh] = gasSize(s.width, s.height);
      const gasT = gasTarget(gl, gw, gh);
      gl.bindFramebuffer(gl.FRAMEBUFFER, gasT.fb);
      gl.viewport(0, 0, gw, gh);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      progGas.use().setAll({
        uVol: 0, uNoise: 1, uCamRot: camRot, uEye: c.eye, uTan: [tanX, tanY], uHalf: VOL_HALF, uSphere: WEB_R + 2,
        uGas: gas * 0.055, uFogL: 150, uSteps: gasSteps, uHot: 0.55,
        uColFil: [0.2, 0.28, 1.0], uColFil2: [0.52, 0.22, 1.0], uColNode: [1.0, 0.72, 0.85],
      });
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_3D, volTex);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_3D, noiseTex);
      U.gl.drawFullscreen(gl);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_3D, null);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_3D, null);
      s.bindOutput();
      progCopy.use().setAll({ uSrc: 0, uTexel: [1 / gw, 1 / gh] });
      U.gl.bindTexture(gl, 0, gasT.tex);
      U.gl.drawFullscreen(gl);
    }

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    // ---------------------------------------------------------------- dark-matter filigree
    const dm = ss(cues.webReveal, cues.webReveal + 1.1, T) * (1 - ss(53.6, 54.6, T));
    if (dm > 0.002) {
      progDM.use().setAll(camU).setAll({ uDM: dm * 0.05, uFogL: 140, uPtSize: Math.max(1.5, s.height / 600), uNearFade: 9, uCol: [0.5, 0.56, 1.0] });
      gl.bindVertexArray(dmVao);
      gl.drawArrays(gl.POINTS, 0, dmCount);
    }

    // ---------------------------------------------------------------- galaxies
    const boost = Math.max(0, 2.2 * ss(52.0, 55.0, T) * (T - 52));
    progGal.use().setAll(camU).setAll({
      uFil: 0, uNodes: 1, uTau: T - 45, uK: DRIFT_K, uBoost: boost, uStar: W.star, uAge: M.linstep(45, 62, T), uFogL: 120,
      uGain: 1.4 * (1 - 0.85 * ss(57.5, 61.8, T)), uFluxPow: M.mix(0.55, 0.62, ss(48, 52, T)),
      uColl: M.mix(2.0, 1.0, ss(45.5, 53.5, T)), uBCG: ss(47.5, 51.5, T),
      uStream: ss(51.4, 52.6, T) * (1 - ss(55.0, 56.5, T)), uStreamT: T - 45, uStarDim: (1 - 0.8 * ss(52.8, 54.2, T)) * (1 - 0.5 * ss(58.5, 60.5, T)),
      uExcl0: [W.Pmw[0], W.Pmw[1], W.Pmw[2], 1.1], uExcl1: [W.Pmg[0], W.Pmg[1], W.Pmg[2], 0.6],
    });
    U.gl.bindTexture(gl, 0, filTex);
    U.gl.bindTexture(gl, 1, nodeTex);
    gl.bindVertexArray(galVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, galCount);

    // ---------------------------------------------------------------- merger
    const tm = T - cues.galaxyMerger;
    const since = mergerSince(tm);
    const mgVis = ss(52.8, 53.6, T) * (1 - ss(57.9, 58.8, T));
    if (mgVis > 0.002) {
      progMG.use().setAll(camU).setAll({
        uSim: 0, uFrame: (mg.tPeri + since) / SIM.FRAME_DT, uFrames: mg.nFrames, uRowsPer: mg.rowsPer,
        uOff: sub(W.Pmg, c.eye), uObj: W.mgObj, uSince: since, uTm: tm, uBright: mgVis, uScale: MG_R,
        uPN: 5000 / mg.nPer,
      });
      U.gl.bindTexture(gl, 0, simTex);
      gl.bindVertexArray(mgVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, mg.NI);
    }

    // ---------------------------------------------------------------- Milky Way
    // The young Milky Way fades in while the camera turns toward it, and only once its disk is inside
    // the frame (in portrait it enters later), so it never shows up as a bright sliver cut by the edge.
    let mwVis = ss(57.1, 58.1, T);
    if (mwVis > 0.002 && T < T_MW) {
      const d = sub(W.Pmw, c.eye);
      const vx = rot3[0] * d[0] + rot3[3] * d[1] + rot3[6] * d[2];
      const vz = rot3[2] * d[0] + rot3[5] * d[1] + rot3[8] * d[2];
      const z = Math.max(-vz, 1e-4), rX = MW_R / (len(d) * tanX);
      mwVis *= -vz > 0 ? ss(0.0, 1.5, (1 - Math.abs(vx / (z * tanX))) / Math.max(rX, 0.02)) : 0;
    }
    if (mwVis > 0.002) {
      const asm = ss(55.4, 60.0, T);
      const tanP = Math.tan(M.mix(36, ARM_PITCH, ss(56.2, 60.0, T)) * DEG);
      const phi = phiAt(T);
      const shared = {
        uTex: 0, uPhi: phi, uTanP: tanP, uAsm: asm, uMinor: ss(57.4, 59.8, T), uArmK: ss(56.2, 59.4, T),
      };
      U.gl.bindTexture(gl, 0, mwTex);
      progMW.use().setAll(shared).setAll({
        uCamRot: camRot, uTan: [tanX, tanY], uO: scl(sub(c.eye, W.Pmw), 1 / MW_R),
        uBright: mwVis * 0.24, uDust: ss(56.8, 59.8, T), uBulge: M.mix(0.25, 1.0, ss(56.2, 60.0, T)), uProto: 1 - ss(56.0, 59.5, T),
      });
      U.gl.drawFullscreen(gl);
      progMWP.use().setAll(camU).setAll(shared).setAll({
        uOff: sub(W.Pmw, c.eye), uScale: MW_R, uT: T - 55, uBright: mwVis, uThick: M.mix(5, 1, asm),
        uDiff: 0.25 * (1 - ss(55, 60, T)),
      });
      gl.bindVertexArray(mwVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, mwCount);
    }
    gl.bindVertexArray(null);

    // ---------------------------------------------------------------- post
    // no full-screen flash for the merger: the starburst itself (HDR nuclei + halo sprites) lights
    // the frame locally; bloom swells with it. Nothing happens before the cue.
    const post = s.post;
    post.shake = tm >= 0 ? 0.08 * Math.exp(-tm * 4) : 0;
    post.bloom = 0.9 + 0.25 * ss(cues.webReveal, cues.webReveal + 0.8, T) - 0.25 * ss(55, 60, T)
      + (tm >= 0 ? 0.55 * Math.exp(-tm * 1.6) : 0);
    const hand = ss(57.5, 60.0, T); // converge on the engine defaults that 'milkyway' uses
    post.bloom = M.mix(post.bloom, 0.8, hand);
    post.bloomThreshold = M.mix(0.75, 0.9, hand);
    post.vignette = M.mix(0.6, 0.55, hand);
    post.saturation = M.mix(1.1 + 0.12 * ss(cues.webReveal, cues.webReveal + 0.8, T) * (1 - ss(53, 54.5, T)), 1.0, hand);
    post.aberration = M.mix(0.1, 0.12, hand);
  }

  // allocate the gas target for the new size right away (e.g. when the film goes fullscreen), not
  // on the first gas frame during playback
  function resize(gl, ctx) {
    if (!progGas || !(ctx.width > 0 && ctx.height > 0)) return;
    const [gw, gh] = gasSize(ctx.width, ctx.height);
    gasTarget(gl, gw, gh);
  }

  U.defineScene({ id: 'cosmicweb', init, resize, render });
})();
