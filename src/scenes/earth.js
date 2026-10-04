// Scene 'earth' (T 108-190): the film's climax. Hadean magma ocean -> crust + Late Heavy
// Bombardment -> the rains and the first oceans -> Archean water world with cratons -> life ->
// oxygenation -> Rodinia -> Snowball Earth -> thaw and continental drift (real plate data from
// U.plates, driven by the counter's years) -> Pangaea -> breakup -> Chicxulub -> India meets Asia
// -> today (Africa/Europe, then the Atlantic and the Americas as the Earth turns) -> night side
// with city lights, the Moon, fade.
(function () {
  'use strict';
  const U = window.U;
  const M = U.math;
  const D2R = Math.PI / 180;

  // ---------------------------------------------------------------- small helpers
  const ss = (a, b, x) => M.smoothstep(a, b, x);
  const lerp = M.mix;
  // piecewise keys with smoothstep easing per segment
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
  // Catmull-Rom spline through keys (C1 continuous, for camera paths)
  function spline(k, x) {
    const n = k.length;
    if (x <= k[0][0]) return k[0][1];
    if (x >= k[n - 1][0]) return k[n - 1][1];
    let i = 1;
    while (x > k[i][0]) i++;
    const p0 = k[Math.max(0, i - 2)], p1 = k[i - 1], p2 = k[i], p3 = k[Math.min(n - 1, i + 1)];
    const h = p2[0] - p1[0];
    const u = (x - p1[0]) / h;
    const m1 = i - 2 >= 0 ? ((p2[1] - p0[1]) / (p2[0] - p0[0])) * h : (p2[1] - p1[1]);
    const m2 = i + 1 <= n - 1 ? ((p3[1] - p1[1]) / (p3[0] - p1[0])) * h : (p2[1] - p1[1]);
    const u2 = u * u, u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * p1[1] + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * p2[1] + (u3 - u2) * m2;
  }
  const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  // mat3 (column-major) * vec3
  const mulM3 = (m, v) => [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]];
  // smooth upper limit: identity below lim - w, eases into lim
  const softMax = (x, lim, w) => (x < lim - w ? x : lim - w * Math.exp(-(x - lim + w) / w));

  const LIGHT0 = norm3([-1, 0.25, 0.6]);
  const FOV_K = 2 * Math.tan(15 * D2R);     // U.earth default fov 30

  let C = null; // cues
  let impacts = [];
  let chicxulub = null;
  let europe = null, greenland = null, natl = null;

  // ---------------------------------------------------------------- camera / framing
  // Sub-viewer longitude/latitude (deg) of the globe over time. Procedural era: slow spin.
  // Drift era: frames the action (tuned against the plate data).
  function viewAt(T) {
    const lon = spline(LON_KEYS, T);
    const lat = spline(LAT_KEYS, T);
    const roll = spline(ROLL_KEYS, T);
    return { lat, lon, roll };
  }
  let LON_KEYS, LAT_KEYS, ROLL_KEYS;
  function buildCameraKeys() {
    // 108-131 matches the theia scene's spin (surface moving right to left, ~9 deg/s, axis tilted
    // like its debris-ring normal). From Rodinia on the camera stays on the land (<= ~13 deg/s):
    // the Gondwana/Laurussia assembly in the south, Pangaea centred, the Atlantic opening, then
    // Yucatan (left of centre, below the sun glint) for Chicxulub. It then swings east to catch
    // India's final run into Asia, and for today turns west again with the Earth's own spin
    // (features move left to right): Africa/Arabia/India -> Europe and the Mediterranean -> the
    // Atlantic with the Americas in daylight and Europe/Africa's lights on the night side.
    LON_KEYS = [
      [108, -85], [110, -67], [113, -40], [116, -12], [120, 25], [124, 62], [128, 98], [131, 127],
      [133, 139], [134.5, 142], [136, 140], [137.5, 133], [140, 115], [143, 88], [146, 55], [148.5, 22],
      [150.5, 0], [153, -6], [156, -10], [159, -16], [162, -25], [165, -36], [165.6, -33], [166.4, -18], [167.3, 8],
      [168.2, 36], [169.2, 54], [170.5, 63], [172.2, 61], [174, 53], [176.5, 31], [179, 5], [182, -27], [185, -55], [190, -80],
    ];
    LAT_KEYS = [
      [108, 15], [115, 15], [122, 10], [128, 5], [131, 0], [133, -5], [135, -10], [137, -16], [140, -30],
      [143, -40], [146, -45], [148.5, -36], [150.5, -22], [153, -10], [156, 0], [159, 8], [162, 15],
      [165, 28], [165.6, 27], [166.4, 23.5], [167.3, 19], [168.2, 16.5], [169.2, 16], [170.5, 16], [172.2, 17], [174, 18], [176.5, 25], [179, 27],
      [182, 23], [185, 13], [190, 4],
    ];
    ROLL_KEYS = [[108, -7], [116, -3], [131, 4], [150, 0], [174, 4], [190, 8]];
  }

  function radiusAt(T) {
    return keys([[108, 0.30], [110, 0.30], [131, 0.335], [137, 0.37], [145, 0.405], [174, 0.415], [184, 0.385], [190, 0.375]], T);
  }
  function lightAt(T) {
    const front = norm3([-0.66, 0.30, 0.70]);
    const back = norm3([-0.78, 0.26, -0.30]);
    let L = LIGHT0;
    L = norm3(mix3(L, front, ss(117.5, 124, T)));
    L = norm3(mix3(L, back, ss(177, 188, T)));
    return L;
  }
  // camera distance for a planet of screen radius R (as in the shader)
  const camDist = (R) => { const tA = R * FOV_K; return Math.sqrt(1 + tA * tA) / tA; };

  // ---------------------------------------------------------------- impacts (Late Heavy Bombardment)
  const BIG_T = 111.3;
  function buildImpacts() {
    const rnd = M.rng(4567);
    const list = [];
    let t = 109.6;
    while (t < 117.2) {
      const dens = 1.0 - ss(110, 117, t) * 0.75; // fewer late
      t += (0.42 + rnd() * 0.55) / dens;         // >= 0.42 s apart: separate events, no strobing
      if (t > 117.2) break;
      // pick a visible spot on the day-ish side
      let x, y, z;
      for (;;) {
        x = -0.85 + rnd() * 1.4; y = -0.8 + rnd() * 1.6;
        const r2 = x * x + y * y;
        if (r2 < 0.82) { z = Math.sqrt(1 - r2); break; }
      }
      const big = rnd() < 0.18;
      const im = { t, v: [x, y, z], size: big ? 0.07 + rnd() * 0.05 : 0.025 + rnd() * 0.035, energy: big ? 1.3 + rnd() * 0.5 : 0.55 + rnd() * 0.5 };
      if (Math.abs(t - BIG_T) > 0.4) list.push(im);
    }
    // one large, well placed impact early in the bombardment
    list.push({ t: BIG_T, v: norm3([-0.35, 0.22, 0.91]), size: 0.13, energy: 2.0, big: true });
    list.sort((a, b) => a.t - b.t);
    for (const im of list) {
      const v = viewAt(im.t);
      const m = U.earth.viewToEarth(v.lat, v.lon, v.roll);
      im.pos = mulM3(m, im.v);
    }
    return list;
  }

  // ---------------------------------------------------------------- init / render
  const scene = {
    id: 'earth',
    async init(gl, ctx) {
      C = U.timeline.cues;
      await U.earth.init(gl, ctx);
      buildCameraKeys();
      impacts = buildImpacts();
      // Chicxulub: Yucatán (21.3N, 89.5W) carried back to its 66 Ma position.
      chicxulub = { present: U.earth.earthPos(21.3, -89.5), block: -1 };
      if (U.earth.hasPlates && U.plates.names) chicxulub.block = U.plates.names.indexOf('North America');
      europe = U.earth.earthPos(51, 14);
      greenland = U.earth.earthPos(62, -38);
      natl = U.earth.earthPos(41, -60);
    },
    render(gl, s) {
      const T = s.T;
      const yrs = s.years;
      const ma = yrs / 1e6;
      const P = U.earth.params();
      const post = s.post;
      const aspect = s.width / s.height;

      // ---- camera
      const v = viewAt(T);
      P.lat = v.lat; P.lon = v.lon; P.roll = v.roll;
      P.radius = radiusAt(T);
      P.center = [0, 0];
      P.light = lightAt(T);
      P.ma = ma;

      // ---- Hadean: magma ocean -> crust
      P.magma = keys([[108, 1.0], [110, 0.85], [112.5, 0.25], [114.5, 0.0]], T);
      P.crust = keys([[108, 0.25], [110, 0.4], [113, 1.0]], T);
      P.crackGlow = keys([[108, 0.4], [110.5, 1.0], [113.5, 0.8], [115.2, 0.35], [117, 0.0]], T);
      P.lavaHeat = 1.0;

      // ---- water
      P.seaOn = ss(114.9, 115.2, T);
      P.sea = keys([[115, -0.9], [115.6, -0.35], [117.6, 0.48], [119, 0.5], [122, 0.45], [125.5, 0.40], [128, 0.36], [130, 0.3]], T);
      P.plateMix = ss(129.7, 130.45, T);
      P.basalt = keys([[115, 1], [119, 0.85], [124, 0.45], [129, 0.2], [131, 0]], T);
      // the murk clears with the oxygenation front (patchy, in the shader)
      P.murk = keys([[115, 0.25], [118, 0.35], [121, 0.65], [129.5, 0.6], [131, 0.0]], T);
      P.life = keys([[122, 0], [123.2, 0.9], [127, 0.8], [130, 0.3], [133, 0.12]], T);
      P.lifeBloom = keys([[122, 0.4], [123.5, 1.0], [128, 0.9], [131, 0.3]], T);
      // deep time: shallow shelf seas join the blocks of the supercontinents; gone today
      P.deepShelf = ss(40, 160, ma);

      // ---- clouds / storms
      P.cloud = keys([[111.5, 0], [113.5, 0.35], [114.8, 0.55], [115.4, 0.8], [117.4, 0.8], [119, 0.5], [121, 0.28],
        [128, 0.26], [129.3, 0.55], [129.9, 0.95], [130.35, 0.95], [131.05, 0.38], [133, 0.3], [135, 0.12], [137, 0.15], [139, 0.26],
        [150, 0.27], [165, 0.3], [174, 0.36], [190, 0.38]], T);
      P.cloudAlpha = keys([[111.5, 0.0], [113, 0.7], [115, 0.95], [131, 0.9], [137, 0.75], [174, 0.85]], T);
      P.storm = keys([[112, 0.45], [114.8, 0.6], [115.3, 1], [117.6, 1], [119.5, 0.15], [131, 0.1], [140, 0]], T);
      P.lightning = keys([[114.9, 0], [115.2, 1], [117.4, 0.8], [118.6, 0]], T);
      P.cloudTime = s.t;
      P.cloudShadow = 0.012;
      // fewer clouds over the continents once they are the subject (plate era)
      P.landClear = keys([[130.3, 0], [131.1, 0.06], [141, 0.07], [143, 0.14], [147.5, 0.14], [150, 0.08], [174, 0.06]], T);
      // extra storm-era cyclones (the baked weather has its own); gone once the world calms
      const twist = (0.4 + 1.2 * ss(115, 118.5, T)) * (1 - ss(120, 125, T));
      P.cyclones = [
        [...U.earth.earthPos(28, 10), twist],
        [...U.earth.earthPos(-22, -60), -twist * 0.9],
        [...U.earth.earthPos(14, -40), twist * 0.7],
      ];

      // ---- atmosphere: orange Hadean/Archean sky; at the oxygenation it clears to blue in patches
      const hadeanAtmo = [0.95, 0.55, 0.32], archean = [1.0, 0.52, 0.20], modern = [0.30, 0.55, 1.0];
      P.atmo = mix3(hadeanAtmo, archean, ss(115, 118, T));
      P.atmoB = modern;
      P.oxy = ss(C.oxygenation, C.oxygenation + 2.2, T);
      P.atmoStrength = keys([[108, 0.35], [112, 0.6], [115, 1.0], [127, 1.05], [130, 1.0]], T);
      P.atmoHeight = keys([[108, 0.022], [114, 0.04], [118, 0.035], [127, 0.032], [130, 0.026]], T);
      // (the shader keeps 25% of the haze once the sky is blue)
      P.haze = keys([[110, 0.0], [113.5, 0.14], [115, 0.12], [118, 0.08], [127, 0.065], [129.5, 0.065], [131, 0.08]], T);

      // ---- ice
      P.iceLine = keys([[130.5, 1.3], [131.2, 0.94], [133, 0.9], [134.7, -0.2], [137, -0.2], [138.8, 0.93],
        [146, 0.9], [149, 0.82], [152, 0.86], [156, 0.95], [168, 0.94], [174, 0.95]], T);

      // ---- surface biology / chemistry
      P.green = ss(430, 360, ma) * (1 - ss(C.snowball - 0.5, C.snowball, T) * (T < C.thaw ? 1 : 0));
      P.rust = ss(C.oxygenation, C.oxygenation + 3, T) * 0.7;
      P.today = ss(55, 4, ma);
      P.city = ss(C.today + 1.5, C.today + 6, T);

      // ---- Moon + debris ring (hand-off from the theia scene: path and look unchanged to 110)
      const Dc = camDist(P.radius);
      const xMax = 0.5 * Math.max(aspect, 1), yMax = 0.5 * Math.max(1 / aspect, 1);
      const mT = ss(108, 113, T);
      const mp = [lerp(1.45, 2.4, mT), lerp(1.15, 1.9, mT), lerp(-1.0, -3.0, mT)];
      if (T > 110) {
        // receding: keep it inside the frame on every aspect (portrait would clip it)
        const den = (Dc - mp[2]) * FOV_K, rS = 0.27 / den;
        const k = ss(110, 111, T);
        const sx = mp[0] / den, sy = mp[1] / den;
        mp[0] = lerp(sx, softMax(sx, xMax - rS - 0.03, 0.05), k) * den;
        mp[1] = lerp(sy, softMax(sy, yMax - rS - 0.03, 0.05), k) * den;
      }
      P.moon = { pos: mp, radius: 0.27, glow: 0.35 * (1 - ss(108, 114, T)), amount: 1 - ss(111.2, 113, T) };
      if (T > C.today + 2) {
        // today's Moon: small, upper left at ~1.7 Earth radii, a crescent under the back light
        const f = ss(C.today + 2, C.today + 6, T);
        const ang = (aspect >= 1 ? 150 : 116) * D2R + (T - 182) * 0.25 * D2R;
        const dist = P.radius * (1.68 + 0.004 * (T - 176));
        const mz = -2.0, den = (Dc - mz) * FOV_K, rS = 0.27 / den;
        let sx = Math.cos(ang) * dist, sy = Math.sin(ang) * dist;
        sx = Math.max(sx, -(xMax - rS - 0.04));
        sy = Math.min(sy, yMax - rS - 0.04);
        P.moon = { pos: [sx * den, sy * den, mz], radius: 0.27, glow: 0, amount: f, smooth: 1 };
      }
      const ringO = 1 - ss(108, 112, T);
      if (ringO > 0) P.ring = { opacity: 0.55 * ringO, inner: 1.35, outer: 2.5, normal: norm3([0.12, 0.96, 0.26]), glow: 0.25 * ringO };

      // ---- impacts: light stays on the planet (the shader keeps the flashes local); only the big
      // one gets a short frame-level pulse and a small shake
      const act = [];
      let flash = 0, shake = 0;
      for (const im of impacts) {
        const age = T - im.t;
        if (age < -0.2 || age > 7) continue;
        act.push({ pos: im.pos, age, size: im.size, energy: im.energy });
        if (im.big && age >= 0) { flash += 0.004 * Math.exp(-age * 14); shake += 0.2 * Math.exp(-age * 6); }
      }
      // Chicxulub: a localised fireball, a glowing ejecta curtain and a spreading dark soot veil
      const chxA = T - C.dinosaursEnd;
      let yuc = null;
      if (chicxulub && chxA > -2.5 && chxA < 9) {
        yuc = chicxulub.present;
        if (U.earth.hasPlates && chicxulub.block >= 0) yuc = U.plates.toPaleo(chicxulub.block, chicxulub.present, Math.max(0, ma), [0, 0, 0]);
        if (chxA > -0.2) act.push({ pos: yuc, age: chxA, size: 0.035, energy: 1.6, kind: 1 });
        if (chxA >= 0) shake += 0.12 * Math.exp(-chxA * 5);
      }
      act.sort((a, b) => a.age - b.age);
      P.impacts = act.slice(0, 12);

      // ---- cloud-clearing spots: clear sky over Yucatán for the impact; today over Europe, then
      // Greenland and the North Atlantic/North America as the Atlantic turns into view
      const clear = [];
      if (yuc) clear.push({ pos: yuc, radius: 0.36 + 0.25 * ss(0, 4, chxA), strength: 0.28 * ss(-2.5, -1.2, chxA) * (1 - ss(5, 9, chxA)) });
      else if (T > C.today + 1) clear.push({ pos: greenland, radius: 0.42, strength: 0.34 * ss(C.today + 1, C.today + 3.5, T) });
      if (T > C.today - 3) clear.push({ pos: europe, radius: 0.5, strength: 0.34 * ss(C.today - 3, C.today - 0.5, T) });
      if (T > C.today + 2.5) clear.push({ pos: natl, radius: 0.6, strength: 0.3 * ss(C.today + 2.5, C.today + 6.5, T) });
      P.clear = clear;
      // the ocean glint sits next to Yucatán under the front light: dim it for the impact
      P.glint = 1 - 0.7 * ss(-3, -1.5, chxA) * (1 - ss(1.5, 3, chxA));

      // ---- the rains: a thick steam/storm atmosphere dims the sunlight; Chicxulub's dust veil
      P.sun = 1.5 * (1 - 0.45 * ss(114.6, 115.4, T) * (1 - ss(117.2, 119.5, T)));
      P.sun *= 1 - 0.10 * ss(0.6, 1.8, chxA) * (1 - ss(2.5, 5, chxA));

      // ---- final fade of the stars/atmosphere is done by the engine
      U.earth.render(gl, s, P);

      // ---- post
      post.flash = flash;
      post.shake = Math.min(0.3, shake);
      post.bloom = 0.85;
      post.vignette = 0.5;
      post.exposure = keys([[108, 1.0], [133, 1.0], [134.5, 0.82], [137, 0.82], [138.5, 1.0]], T);
      post.saturation = keys([[133, 1.0], [134.5, 0.85], [137, 0.85], [138.5, 1.05], [174, 1.08]], T);
    },
  };
  U.defineScene(scene);
})();
