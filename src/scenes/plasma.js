// Scene 'plasma' (T 15-32): the primordial plasma cools from white-gold to deep orange, a dense
// opaque luminous fog; at recombination the fog clears and the first light (the CMB) is revealed;
// it stretches, dims and redshifts towards the dark ages.
// Shares the noise volume, fireball field and its parameterisation with bigbang.js (U.bb).
(function () {
  'use strict';
  const U = window.U;
  const M = U.math;

  // Fallback copy of the shared U.bb library hosted by bigbang.js (same code), used only when
  // plasma is bundled without bigbang (e.g. `build.mjs --scenes plasma,cosmicdawn`). In the full
  // film bigbang.js is loaded first and this block is skipped. Keep it in sync with bigbang.js.
  if (!(U.bb && U.bb.GLSL_FIRE)) (function () {
    const BB = (U.bb = U.bb || {});
    // ------------------------------------------------------------------ shared noise volume
    const NOISE_N = 64;
    const GEN_FS = `
  in vec2 vUv; out vec4 o;
  uniform float uZ;
  const float PER = 8.0;
  vec3 g3(vec3 i, float s) {
    vec3 h = hash33(mod(i, PER) + vec3(s * 61.0, s * 17.0, s * 5.0));
    float z = h.x * 2.0 - 1.0, a = h.y * TAU, r = sqrt(max(0.0, 1.0 - z * z));
    return vec3(r * cos(a), r * sin(a), z);
  }
  float pn(vec3 p, float s) {
    vec3 i = floor(p), f = fract(p);
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    float n000 = dot(g3(i, s), f);
    float n100 = dot(g3(i + vec3(1, 0, 0), s), f - vec3(1, 0, 0));
    float n010 = dot(g3(i + vec3(0, 1, 0), s), f - vec3(0, 1, 0));
    float n110 = dot(g3(i + vec3(1, 1, 0), s), f - vec3(1, 1, 0));
    float n001 = dot(g3(i + vec3(0, 0, 1), s), f - vec3(0, 0, 1));
    float n101 = dot(g3(i + vec3(1, 0, 1), s), f - vec3(1, 0, 1));
    float n011 = dot(g3(i + vec3(0, 1, 1), s), f - vec3(0, 1, 1));
    float n111 = dot(g3(i + vec3(1, 1, 1), s), f - vec3(1, 1, 1));
    return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
               mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
  }
  void main() {
    vec3 p = vec3(vUv, uZ) * PER;
    vec4 n = vec4(pn(p, 1.0), pn(p, 2.0), pn(p, 3.0), pn(p, 4.0)) * 1.3;
    o = clamp(n * 0.5 + 0.5, 0.0, 1.0);
  }`;

    // Issue the generator's compile+link (no wait) so it can build in parallel with the scenes'
    // own programs; noiseTex() bakes with it later.
    BB.noiseProg = function (gl) {
      if (!BB._noise && !BB._noiseProg) BB._noiseProg = U.gl.program(gl, U.gl.FULLSCREEN_VS, U.glsl.frag(GEN_FS), 'bb-noisegen');
      return BB._noiseProg;
    };
    BB.noiseTex = function (gl) {
      if (BB._noise) return BB._noise;
      const N = NOISE_N;
      const prog = BB.noiseProg(gl);
      // RGBA8 is plenty for smooth noise (no visible banding) and fetches ~1.6x faster than RGBA16F.
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_3D, tex);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, N, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.bindTexture(gl.TEXTURE_3D, null);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.viewport(0, 0, N, N);
      gl.disable(gl.BLEND);
      prog.use();
      for (let z = 0; z < N; z++) {
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex, 0, z);
        prog.set('uZ', (z + 0.5) / N);
        U.gl.drawFullscreen(gl);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb);
      gl.deleteProgram(prog.program);
      BB._noiseProg = null;
      BB._noise = tex;
      return tex;
    };
    BB.bindNoise = function (gl, unit) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_3D, BB._noise);
    };

    // Sampling helpers. N3(p): 4 independent tileable gradient noises (period 1.0, 8 cells), ~[-1,1].
    BB.GLSL_NOISE = `
  precision highp sampler3D;
  uniform sampler3D uNoise;
  vec4 N3(vec3 p) { return texture(uNoise, p) * 2.0 - 1.0; }
  const mat3 OCT = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
  float ign(vec2 fc) { return fract(52.9829189 * fract(dot(fc, vec2(0.06711056, 0.00583715)))); }
  `;

    // ------------------------------------------------------------------ shared fireball field
    // A stack of NS emissive/absorbing plasma sheets at cycling depths; the camera flies through
    // them (uCamZ), so nearer sheets expand faster (parallax) and pass the camera.
    // Each sheet: two-level domain-warped fBm; hot pockets, bright filaments, dark cooler veins.
    BB.GLSL_FIRE = `
  uniform vec2 uRes;
  uniform float uCamZ, uEvo, uRoll, uTemp, uBright, uFog, uClear, uFireW, uGain, uDepth;

  vec4 fbmN(vec3 p) {
    // x: signed fBm, y: billowy (sum |n|), z: ridged (sum (1-|n|)^2), w: signed fBm
    vec4 s = vec4(0.0); float a = 0.5;
    for (int i = 0; i < FOCT; i++) {
      vec4 n = N3(p);
      float rz = 1.0 - abs(n.z);
      s += a * vec4(n.x, abs(n.y), rz * rz, n.w);
      p = OCT * p * 2.03 + vec3(0.131, 0.217, 0.073);
      a *= 0.56 - 0.12 * uFog;   // the fog phase: finer detail melts into a smoother glow
    }
    return s;
  }

  // rgb = radiance, a = remaining transmittance
  vec4 fireSheets(vec2 q) {
    vec3 col = vec3(0.0);
    float tr = 1.0;
    float fk = floor(uCamZ);
    vec2 qr = rot2(uRoll) * q;
    float soft = uFog;
    // depth reference: the first sheet that is substantially opaque (keeps the depth phase's overall
    // brightness steady while sheets pass the camera)
    float dF = fk + 1.0 - uCamZ;
    float dRef = dF + 1.0 - smoothstep(0.0, 0.9, dF);
    for (int i = 0; i < NS; i++) {
      float k = fk + 1.0 + float(i);
      float d = k - uCamZ;                                   // depth (0, NS]
      float w = smoothstep(0.0, 0.9, d) * smoothstep(float(NS), float(NS) - 1.5, d);
      vec3 h = hash33(vec3(k, 3.0, 11.0));
      vec2 x = rot2(h.x * TAU) * qr * (d * 0.17) + h.yz;
      vec3 p = vec3(x, h.x * 0.53 + uEvo);
      // two-level domain warp (large swirls, then smaller eddies)
      vec4 a = N3(p * 0.6 + vec3(0.0, 0.0, uEvo * 0.7));
      vec3 pw = p + vec3(a.xy, a.z * 0.6) * 0.09;
      vec4 a2 = N3(OCT * pw * 1.7 + vec3(0.3, 0.1, uEvo * 0.4));
      pw += vec3(a2.xy, 0.0) * 0.035;
      vec4 b = fbmN(pw * 1.7);
      float H = saturate(0.42 + 1.3 * b.x + 1.0 * (b.y - 0.22) + 0.45 * a.w);
      float lanes = 1.0 - smoothstep(0.015, 0.12 + 0.1 * soft, b.y);
      float fil = pow(saturate((b.z - 0.62) * 3.0), 4.0) * (1.0 - 0.6 * soft);
      float hot = H * H * H;
      float tK = uTemp * (0.68 + 0.5 * H + 0.8 * hot + 0.8 * fil) * (1.0 - 0.26 * lanes);
      float lum = uBright * (0.28 + 1.5 * H * H + 2.2 * hot * H * H + 2.4 * fil) * (1.0 - 0.7 * lanes);
      // depth: farther sheets glow dimmer and redder through the plasma in front of them
      float fade = mix(1.0, min(exp(-0.55 * (d - dRef)), 1.25), uDepth);
      vec3 e = blackbody(tK * mix(1.0, 0.72 + 0.28 * fade, uDepth)) * lum * fade;
      float al = w * saturate(0.3 + 0.5 * H + 0.3 * soft);
      // the dark lanes open into windows deeper into the fireball
      al *= 1.0 - uDepth * 0.7 * lanes;
      // recombination: the fog dissolves, thinnest parts first
      float thr = 0.5 + 0.5 * a.w + 0.25 * (H - 0.5);
      float dz = 1.0 - smoothstep(thr - 0.3, thr + 0.3, uClear * 1.6 - 0.3);
      al *= dz;
      // a thinning wisp also dims (no hot shreds left glowing in the cleared sky)
      col += tr * al * e * dz;
      tr *= 1.0 - al;
    }
    // the luminous deep plasma beyond the last sheet
    col += tr * blackbody(uTemp * 0.75) * uBright * 0.8 * (1.0 - 0.7 * uDepth) * (1.0 - smoothstep(0.0, 0.4, uClear));
    return vec4(col, tr);
  }
  `;

    BB.fireDefines = function (tier) {
      if (tier === 'low') return '#define NS 2\n#define FOCT 3\n';
      if (tier === 'mid') return '#define NS 3\n#define FOCT 3\n';
      return '#define NS 3\n#define FOCT 4\n';
    };

    // Camera travel through the sheets (sheet units), a pure function of T.
    function camZ(T, c) {
      const dt = Math.max(0, T - c.bang);
      const tau = 1.3;
      return 0.6 + 0.19 * dt + 2.4 * tau * (1 - Math.exp(-dt / tau)) + 0.05 * M.smoothstep(c.recombination - 1, c.recombination + 4, T) * (T - c.recombination + 1);
    }

    // Fireball parameters at film time T (shared by bigbang and plasma so the overlap is identical).
    BB.fireState = function (T, c) {
      const r = c.recombination;
      // the cooling arc: white-gold fireball -> gold -> orange (~17) -> orange-red -> deep red (~24.4)
      const temp = M.keyframes([[c.inflationEnd - 1, 2600], [c.inflationEnd, 2450], [10.5, 2400], [13.5, 2250], [17, 2080],
        [19.5, 1900], [22, 1720], [r - 0.6, 1560], [r + 2, 1480]], T);
      const bright = M.keyframes([[c.inflationEnd - 1, 2.9], [c.inflationEnd, 2.7], [17, 2.5], [21, 2.1], [r - 0.6, 1.7], [r + 2, 1.5]], T);
      return {
        uCamZ: camZ(T, c),
        uEvo: 0.018 * T + 0.004 * Math.sin(T * 0.37),
        uRoll: 0.012 * (T - c.bang) + 0.01 * Math.sin(T * 0.21),
        uTemp: temp,
        uBright: bright,
        uFog: M.smoothstep(17.5, 22.5, T),
        uClear: M.smootherstep(r, r + 1.6, T),
        // after nucleosynthesis the fireball opens up: we see deep into it, layer behind layer, until
        // the fog thickens again and traps the light
        uDepth: 0.8 * M.smoothstep(11.2, 14.5, T) * (1 - M.smoothstep(18.0, 22.0, T)),
      };
    };

    // Post settings for the fire phase.
    BB.firePost = function (T, c, post) {
      const r = c.recombination;
      // exposure eases down after the fireball's first seconds so the eye can rest; shaped against the
      // measured picture into one long, steady descent (meanL ~150 at 8 s, ~100 at 13.5, ~70 at 24)
      post.exposure = M.keyframes([[c.inflationEnd, 0.34], [9, 0.25], [10, 0.172], [12, 0.168], [13, 0.185], [14, 0.235],
        [15, 0.26], [16, 0.29], [17, 0.222], [18, 0.205], [19, 0.215], [20, 0.26], [21, 0.31], [22, 0.37], [23, 0.42],
        [r - 0.6, 0.54]], T);
      post.bloom = 0.55;
      post.bloomThreshold = 2.2;
      post.bloomKnee = 1.2;
      post.bloomRadius = 1.1;
      // a deeper vignette while the reheated fireball is at its brightest (calmer edges, legible counter)
      post.vignette = 0.68 + 0.17 * (1 - M.smoothstep(9.5, 11.5, T));
      post.grain = 0.022;
      post.aberration = 0.1;
      post.saturation = 1.2;
      post.contrast = 0.12;
    };

    // Radiance gain of the fireball phase. The scene output is multiplied by it and the post
    // exposure / bloom threshold are divided / multiplied by it, so the picture is unchanged while the
    // HDR radiance during the 15-17 hand-off sits at the contract's ~2-4 (mean, before exposure).
    const FIRE_GAIN = 3.0;
    BB.gain = function (T, c) {
      const up = M.smoothstep(c.inflationEnd - 1.0, c.inflationEnd + 1.0, T);
      const dn = M.smoothstep(17.5, 21.0, T);
      return 1 + (FIRE_GAIN - 1) * up * (1 - dn);
    };
    BB.applyGain = function (post, g) {
      post.exposure /= g;
      post.bloomThreshold *= g;
      post.bloomKnee *= g;
    };

    // Frame cache: lets plasma reuse this frame's picture during the 15-17 overlap.
    BB.cache = { T: -1, w: 0, h: 0, tex: null };
  })();

  const COPY_FS = `
uniform sampler2D uSrc;
out vec4 o;
void main() { o = vec4(texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0).rgb, 1.0); }`;

  // The cosmic microwave background: a frozen, multi-scale Gaussian-like random field on the
  // sky sphere around the camera (sampled along view rays so it has no screen-space distortion).
  // Before recombination the same field rings in the plasma as sound (acoustic oscillations): each
  // scale oscillates at its own period, all in phase at recombination, where the pattern freezes.
  const PLASMA_FS = `
in vec2 vUv; out vec4 o;
uniform float uCmbW, uCmbS, uCmbTemp, uCmbB, uYaw, uPitch, uRip, uRipT, uZoom, uBeat;

vec3 skyDir(vec2 q) {
  vec3 d = normalize(vec3(q * 1.15, -1.0));
  float cy = cos(uYaw), sy = sin(uYaw), cp = cos(uPitch), sp = sin(uPitch);
  d = vec3(cy * d.x + sy * d.z, d.y, -sy * d.x + cy * d.z);
  return vec3(d.x, cp * d.y - sp * d.z, sp * d.y + cp * d.z);
}

// the field's scales; their sum is the CMB pattern
vec4 cmbOct(vec3 d) {
  vec3 p = d * uCmbS;
  // the acoustic-peak scale is two rotated, incommensurate lattices, so the tileable noise never
  // visibly repeats across the sky, even when the camera has pulled back
  float pk = 0.74 * N3(p + vec3(0.37, 0.19, 0.71)).y + 0.6 * N3(OCT * p * 1.31 + vec3(0.71, 0.05, 0.37)).x;
  return vec4(0.36 * N3(p * 0.37 + vec3(0.11, 0.53, 0.29)).x,      // large-scale anisotropy
              0.85 * pk,
              0.48 * N3(OCT * p * 2.07 + vec3(0.23, 0.61, 0.05)).z,
              0.17 * N3(OCT * OCT * p * 4.3 + vec3(0.47, 0.13, 0.83)).w);
}

vec3 cmb(vec4 oc) {
  float dl = clamp((oc.x + oc.y + oc.z + oc.w) * 1.4, -1.5, 1.5);
  vec3 c = blackbody(uCmbTemp * (1.0 + 0.12 * dl)) * uCmbB * exp(1.05 * dl);
  // the coldest spots stay a dark red-brown: never grey, blue or black holes
  return max(c, uCmbB * vec3(0.17, 0.035, 0.012));
}

void main() {
  vec2 q = (vUv - 0.5) * uRes / min(uRes.x, uRes.y);
  vec4 oc = (uRip > 0.001 || uCmbW > 0.001) ? cmbOct(skyDir(q)) : vec4(0.0);
  vec3 col = vec3(0.0);
  float tr = 1.0;
  if (uFireW > 0.001) {
    vec4 f = fireSheets(q * uZoom);
    // periods 2.4 s, 1.5 s, 1.0 s; uRipT = 0 at recombination
    float F = oc.x + oc.y * cos(uRipT * 2.618) + oc.z * cos(uRipT * 4.189) + oc.w * cos(uRipT * 6.283);
    // as it clears, the fog also thins and dims (it is the light we are about to see through)
    col = f.rgb * uFireW * exp(uRip * 1.4 * F) * (1.0 + uBeat) * (1.0 - 0.55 * uClear);
    tr = mix(1.0, f.a, uFireW);
  }
  if (uCmbW > 0.001 && tr > 0.002) col += tr * uCmbW * cmb(oc);
  o = vec4(col * uGain, 1.0);
}`;

  // Tiny, short-lived sparks in the fog (scattering / annihilation flashes). Analytic in time.
  const SPARK_VS = `
layout(location = 0) in vec2 aC;
uniform vec2 uRes;
uniform float uT, uAmt, uTempK;
out vec2 vC;
out vec3 vCol;
void main() {
  int id = gl_InstanceID;
  float P = mix(0.7, 2.2, hashI(id, 21));
  float ph = uT / P + hashI(id, 22);
  float cyc = floor(ph), u = ph - cyc;
  int ci = id * 977 + int(cyc);
  float L = mix(0.05, 0.12, hashI(ci, 23)) * (2.2 / P) * 0.5;
  float env = u < L ? sin(3.14159265 * u / L) : 0.0;
  env *= env;
  float mr = min(uRes.x, uRes.y);
  vec2 hs = 0.5 * uRes / mr;
  vec2 c = (vec2(hashI(ci, 24), hashI(ci, 25)) * 2.0 - 1.0) * (hs + 0.02);
  // a little drift outward with the expansion while it lives
  c *= 1.0 + 0.03 * u;
  float hb = hashI(ci, 26);
  float b = (0.25 + 5.0 * pow(hb, 7.0)) * env * uAmt;
  float spx = 1.1 + 1.6 * hb;
  vec2 pos = c + aC * spx * 3.0 / mr;
  vC = aC * 3.0;
  vCol = blackbody(uTempK * mix(1.1, 1.6, hashI(ci, 27))) * b;
  gl_Position = b > 0.0 ? vec4(pos * 2.0 * mr / uRes, 0.0, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}`;
  const SPARK_FS = `
in vec2 vC;
in vec3 vCol;
out vec4 o;
void main() {
  float g = exp(-dot(vC, vC) * 0.9);
  o = vec4(vCol * g, 1.0);
}`;

  let progCopy, progPlasma, progSpark, quadVao, nSparks = 0;

  // The recombination beat: a slow swell under the roar, then one bright pulse of the fog on the cue.
  function beat(T, r) {
    const dt = T - r;
    const pre = 0.6 * Math.pow(M.smoothstep(r - 1.6, r, T), 2) * (1 - M.smoothstep(r, r + 0.7, T));
    const pulse = 0.85 * M.smoothstep(0, 0.05, dt) * Math.exp(-Math.max(0, dt - 0.05) * 2.6);
    return { pre, pulse };
  }

  // CMB parameters at T (reveal, pull-back, expansion, redshift and dimming).
  function cmbState(T, c) {
    const r = c.recombination;
    const dt = T - r;
    // as the fog clears the camera pulls back: the first light becomes a distant, finer pattern;
    // afterwards it slowly stretches with the expansion
    const x = M.saturate(dt / 2.8);
    const pull = 1 + 0.6 * (1 - Math.pow(1 - x, 3));
    const b = beat(T, r);
    return {
      uCmbW: M.smoothstep(r - 0.1, r + 0.5, T),
      uCmbS: 1.9 * pull * Math.exp(-0.02 * Math.max(0, dt - 2.8)),
      uCmbTemp: M.keyframes([[r, 1560], [r + 1.5, 1480], [r + 3.5, 1320], [r + 5.5, 1180], [r + 7, 1080]], T),
      uCmbB: M.keyframes([[r, 0.4], [r + 1, 0.4], [r + 2, 0.39], [r + 3, 0.355], [r + 4, 0.24], [r + 5, 0.143],
        [r + 6, 0.055], [r + 7, 0.04]], T),
      uYaw: 0.35 + 0.016 * dt,
      uPitch: 0.12 + 0.006 * dt,
      // the sound in the plasma grows louder until it freezes into the CMB at recombination
      uRip: 0.36 * M.smoothstep(18.0, 20.5, T) + 0.6 * M.smoothstep(20.5, 24.6, T),
      uRipT: Math.min(0, dt),
      uZoom: pull,
      uBeat: b.pre + b.pulse,
    };
  }

  function plasmaPost(T, c, p) {
    const r = c.recombination;
    U.bb.firePost(T, c, p);
    if (T < r - 0.6) return;
    // first light: one pulse of the fog (in the scene, uBeat) with a bloom swell, then the long,
    // steady fade into the dark; the exposure is held so the picture itself carries the fade
    const b = beat(T, r).pulse;
    const k = M.smoothstep(r - 0.6, r + 1.2, T);
    p.flash = 0.01 * b;
    p.exposure = M.mix(p.exposure, 0.55, k);
    p.bloom = M.mix(0.55, 0.7, k) + 0.35 * b;
    p.bloomThreshold = M.mix(2.2, 1.5, k);
    p.bloomKnee = M.mix(1.2, 0.8, k);
    p.bloomRadius = 1.1 + 0.2 * k;
    p.saturation = M.mix(1.2, 1.15, k);
    p.vignette = M.mix(0.68, 0.6, M.smoothstep(r + 2, r + 6, T));
    p.grain = M.mix(0.022, 0.03, k);
    p.aberration = 0.1 + 0.1 * b;
  }

  function post(T, c, p) {
    plasmaPost(T, c, p);
    U.bb.applyGain(p, U.bb.gain(T, c));
  }

  U.defineScene({
    id: 'plasma',
    async init(gl, ctx) {
      // programs first (parallel compile), then buffers, then the shared bake (a no-op when
      // bigbang has already baked the noise volume)
      const BB = U.bb;
      const defs = BB.fireDefines(ctx.tier);
      const progNoise = BB.noiseProg(gl);
      progCopy = U.gl.program(gl, U.gl.FULLSCREEN_VS, U.glsl.frag(COPY_FS), 'plasma-copy');
      progPlasma = U.gl.program(gl, U.gl.FULLSCREEN_VS, U.glsl.frag(defs + BB.GLSL_NOISE + BB.GLSL_FIRE + PLASMA_FS), 'plasma-main');
      progSpark = U.gl.program(gl, U.glsl.vert(SPARK_VS), U.glsl.frag(SPARK_FS), 'plasma-sparks');
      const quad = U.gl.buffer(gl, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]));
      quadVao = U.gl.vao(gl, [{ loc: 0, buffer: quad, size: 2 }]);
      nSparks = Math.round(420 * ctx.particleScale);
      if (progNoise) await U.gl.compiled(gl, [progNoise]);
      BB.noiseTex(gl);
    },
    render(gl, s) {
      const BB = U.bb;
      const c = s.cues, T = s.T, r = c.recombination;
      post(T, c, s.post);
      // 15-17: bigbang has just rendered this very frame; reuse it (identical picture).
      const cache = BB.cache;
      if (T < 17 && cache.T === T && cache.w === s.width && cache.h === s.height && cache.tex && cache.tex !== s.target.tex) {
        progCopy.use().set('uSrc', 0);
        U.gl.bindTexture(gl, 0, cache.tex);
        U.gl.drawFullscreen(gl);
        return;
      }
      const fs = BB.fireState(T, c);
      const cm = cmbState(T, c);
      const fireW = fs.uClear >= 0.999 ? 0 : 1;
      const gain = BB.gain(T, c);
      BB.bindNoise(gl, 0);
      progPlasma.use().setAll(fs).setAll(cm).setAll({ uNoise: 0, uRes: [s.width, s.height], uFireW: fireW, uGain: gain });
      U.gl.drawFullscreen(gl);
      gl.bindTexture(gl.TEXTURE_3D, null);

      const amt = M.smoothstep(17.2, 19.0, T) * (1 - M.smoothstep(r - 0.8, r + 0.4, T));
      if (amt > 0.001 && nSparks > 0) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        progSpark.use().setAll({ uRes: [s.width, s.height], uT: T, uAmt: amt * 6.0 * gain, uTempK: fs.uTemp });
        gl.bindVertexArray(quadVao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nSparks);
        gl.bindVertexArray(null);
        gl.disable(gl.BLEND);
      }
    },
  });
})();
