// Scene 'bigbang' (T 0-17): the void, a quantum spark, the Big Bang, inflation, the fireball.
//
// This file also hosts U.bb, shared with src/scenes/plasma.js (which is bundled after it):
//   * a tileable 64^3 RGBA gradient-noise volume generated on the GPU (4 independent noises),
//   * the fireball "plasma sheets" field shader + its time-parameterisation (fireState / firePost),
//   * a frame cache so plasma can reuse this scene's identical picture during the 15-17 overlap.
(function () {
  'use strict';
  const U = window.U;
  const M = U.math;
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

  // ------------------------------------------------------------------ bigbang shaders
  const SPARK_FS = `
in vec2 vUv; out vec4 o;
uniform vec2 uRes, uJit;
uniform float uT, uCore, uHalo, uHaloR, uRing, uFoam;
uniform vec4 uPairs[6];
uniform vec2 uPairDir[6];
void main() {
  float mr = min(uRes.x, uRes.y);
  vec2 fc = gl_FragCoord.xy - 0.5 * uRes - uJit;
  vec2 q = fc / mr;
  vec3 col = vec3(0.0);
  float d2 = dot(fc, fc);
  col += blackbody(16000.0) * uCore * exp(-d2 / (2.0 * 0.72 * 0.72));
  float r = length(q);
  vec2 dir = q / max(r, 1e-6);
  if (r < uHaloR * 12.0) {
    // spacetime shimmering around the point: a soft breathing glow, gently wobbling
    float wob = 1.0 + 0.07 * snoise(vec3(dir * 1.3, uT * 0.8)) + 0.025 * snoise(vec3(dir * 2.6, uT * 1.9 + 4.0));
    float x = r / (uHaloR * wob);
    float halo = uHalo * (exp(-x * x * 2.2) * 0.6 + 0.4 / (1.0 + x * x * 5.0));
    // faint, broken lensing arcs drifting around it
    float wob2 = 1.0 + 0.03 * snoise(vec3(dir * 1.6 + 7.0, uT * 1.3));
    float rx = (x * wob2 - 1.9) / 0.17;
    float arcs = smoothstep(-0.35, 0.6, snoise(vec3(dir * 0.8, uT * 0.5 + 2.0)));
    float ring = uRing * exp(-rx * rx) * arcs;
    // the barest seething of the vacuum near the point
    float foam = uFoam * smoothstep(0.1, 1.0, snoise(vec3(q * 38.0, uT * 3.0))) * exp(-x * 0.8);
    col += blackbody(9500.0) * halo + blackbody(12000.0) * max(ring, 0.0) + blackbody(11000.0) * foam;
  }
  for (int i = 0; i < 6; i++) {
    vec4 P = uPairs[i];
    if (P.w <= 0.0) continue;
    vec2 off = uPairDir[i] * P.z;
    vec2 a = (q - P.xy - off) * mr, b = (q - P.xy + off) * mr;
    col += blackbody(11000.0) * P.w * (exp(-dot(a, a) * 0.9) + exp(-dot(b, b) * 0.9));
  }
  o = vec4(col, 1.0);
}`;

  const BANG_FS = `
in vec2 vUv; out vec4 o;
uniform int uNT;
uniform float uInfW, uE, uBlur, uShockR, uShockI, uInfTemp, uInfBright, uCoreI, uFoamEvo, uT, uCoolTint, uReheat, uGlowI, uCollI, uCollR;

vec3 inflation(vec2 q) {
  float r = length(q);
  vec2 dir = q / max(r, 1e-6);
  float rho = log(max(r, 1e-4));
  float rpx = r * min(uRes.x, uRes.y);
  float jit = hash12(gl_FragCoord.xy + vec2(floor(fract(uT * 7.13) * 64.0) * 1031.0, 17.0));
  vec2 c0 = vec2(0.13, 0.71) + vec2(cos(uFoamEvo), sin(uFoamEvo * 0.77)) * 0.06;
  float foam = 0.0, fil = 0.0;
  for (int t = 0; t < NT; t++) {
    if (t >= uNT) break;
    float rr = rho - uE - (float(t) + jit) / float(uNT) * uBlur;
    for (int j = 0; j < 3; j++) {
      float A = 0.3 * exp2(float(j) * 1.05);
      float aa = smoothstep(1.0, 3.5, rpx / (8.0 * A));
      vec4 n = N3(vec3(dir * A + c0 + float(j) * 0.37, rr * A + float(j) * 0.21));
      float bx = uBlur * A * 3.0;
      float amp = 1.0 / (exp2(float(j) * 0.55) * (1.0 + bx * bx));   // motion blur eats fine detail
      foam += amp * aa * abs(n.x);
      fil += amp * aa * pow(saturate(1.0 - abs(n.y) * 2.2), 5.0);
    }
  }
  float wn = 0.0;
  for (int j = 0; j < 3; j++) {
    float bx = uBlur * 0.3 * exp2(float(j) * 1.05) * 3.0;
    wn += 1.0 / (exp2(float(j) * 0.55) * (1.0 + bx * bx));
  }
  float norm = mix(1.0, 2.15 / wn, 0.7) / float(uNT);
  foam *= norm;
  fil *= norm;
  vec3 hot = blackbody(uInfTemp * (1.0 - 0.25 * uReheat));   // reheating glows golden
  vec3 cool = blackbody(uInfTemp * mix(0.62, 1.8, uCoolTint)) * mix(vec3(1.0), vec3(0.55, 0.68, 1.0), uCoolTint);
  float e = 0.05 + 1.5 * foam * foam * foam + 2.2 * fil * fil;
  // reheating: the end of inflation floods space with hot radiation
  e = mix(e, 0.42 + 0.62 * e, uReheat);
  vec3 col = mix(cool, hot, saturate(foam * 1.1)) * uInfBright * e;
  col += blackbody(uInfTemp * 1.2) * uCoreI * (exp(-r * 22.0) + 0.25 * exp(-r * 5.0));
  // the shock front: the edge of the newborn universe racing outward
  float wob = 1.0 + 0.07 * N3(vec3(dir * 0.9 + 0.5, uE * 0.03)).x + 0.025 * N3(vec3(dir * 3.0, 0.4)).y;
  float rs = r * wob;
  float inside = smoothstep(uShockR * 1.01, uShockR * 0.84, rs);
  float sw = 0.004 + 0.06 * uShockR;
  float rd = (rs - uShockR) / sw;
  float ring = exp(-rd * rd) + 0.35 * exp(-max(rs - uShockR, 0.0) / (sw * 3.0)) * smoothstep(uShockR * 0.8, uShockR * 1.0, rs);
  // the light of the bang pouring out of the ball: a blue-white falloff, black beyond it
  float outR = max(rs - uShockR * 0.9, 0.0);
  float L = 0.05 + 0.4 * uShockR;
  vec3 glow = blackbody(17000.0) * uGlowI * (exp(-outR / L) + 0.25 * exp(-outR / (2.5 * L)));
  // the white of the bang withdraws into the ball: edges go dark first
  glow += blackbody(17000.0) * uCollI * exp(-r * r / (uCollR * uCollR));
  return col * inside + blackbody(32000.0) * uShockI * ring * (0.7 + 0.6 * foam) + glow;
}

void main() {
  vec2 q = (vUv - 0.5) * uRes / min(uRes.x, uRes.y);
  vec3 col = vec3(0.0);
  if (uInfW > 0.001) col += inflation(q) * uInfW;
  if (uFireW > 0.001) col += fireSheets(q).rgb * uFireW;
  o = vec4(col * uGain, 1.0);
}`;

  const STREAK_VS = `
layout(location = 0) in vec2 aC;
uniform vec2 uRes;
uniform float uE, uH, uShockR, uAmt, uShutter, uTempK;
out vec3 vC;
out vec3 vCol;
void main() {
  int id = gl_InstanceID;
  float h0 = hashI(id, 11), h1 = hashI(id, 12), h2 = hashI(id, 13), h3 = hashI(id, 14);
  float m = mix(0.6, 1.4, h1);
  const float RMIN = -5.6, SPAN = 6.4;
  float ph = h0 + m * uE / SPAN;
  float cyc = floor(ph), u = ph - cyc;
  float ang = TAU * hashI(id * 131 + int(cyc), 15);
  vec2 dir = vec2(cos(ang), sin(ang));
  float mr = min(uRes.x, uRes.y);
  float rh = exp(RMIN + u * SPAN);
  float wpx = (1.2 + 1.8 * h2 * h2) * (1.0 + 1.2 * rh);
  float dl = max(m * uH * uShutter, 1.2 * wpx / (rh * mr));
  float rt = rh * exp(-dl);
  float hw = wpx * 0.5 / mr;
  vec2 tail = dir * rt - dir * hw, head = dir * rh + dir * hw;
  vec2 perp = vec2(-dir.y, dir.x);
  vec2 pos = mix(tail, head, aC.x) + perp * aC.y * hw * 2.0;
  float lpx = (rh - rt) * mr + wpx;
  float b = (0.3 + 3.0 * pow(h3, 4.0)) * uAmt;
  b *= smoothstep(0.0, 0.1, u) * smoothstep(uShockR * 1.02, uShockR * 0.75, rh);
  b *= mix(1.0, 10.0 / (lpx + 10.0), 0.6);
  vC = vec3(aC.x, aC.y * 2.0, wpx / lpx);
  vCol = blackbody(uTempK * mix(0.8, 1.3, hashI(id, 16))) * b;
  gl_Position = vec4(pos * 2.0 * mr / uRes, 0.0, 1.0);
}`;
  const STREAK_FS = `
in vec3 vC;
in vec3 vCol;
out vec4 o;
void main() {
  float across = exp(-vC.y * vC.y * 1.2);
  float x = saturate(vC.x);
  float along = pow(x, 1.6) * (1.0 - smoothstep(1.0 - vC.z, 1.0, x));
  o = vec4(vCol * across * along, 1.0);
}`;

  // Nucleosynthesis (~10-13 s): pairs of blue-white glints spiral together and fuse in a flare with a
  // small expanding ring of light. One instanced quad per event, analytic in time.
  const FUSE_VS = `
layout(location = 0) in vec2 aC;
uniform vec2 uRes;
uniform float uT, uT0, uSpan, uAmt;
out vec2 vP;
out vec4 vE;   // x: local time u, y: size scale (px), z: spin, w: pair separation (px)
out vec3 vCol;
void main() {
  int id = gl_InstanceID;
  float te = uT0 + uSpan * (0.5 + 0.5 * (hashI(id, 31) + hashI(id, 32) - 1.0));
  float u = uT - te;
  if (u < -0.6 || u > 0.75) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float z = mix(0.3, 1.0, pow(hashI(id, 33), 0.7));     // depth: 1 = near
  float mr = min(uRes.x, uRes.y);
  vec2 hs = 0.5 * uRes / mr;
  vec2 c = (vec2(hashI(id, 34), hashI(id, 35)) * 2.0 - 1.0) * hs * 0.97;
  c *= 1.0 + 0.06 * z * (u + 0.6);                     // drifting outward with the expansion
  float sc = mix(0.5, 1.7, z * z) * mr / 720.0;        // px scale
  float R = 26.0 * sc / mr;
  vP = aC * 26.0 * sc;
  vE = vec4(u, sc, TAU * hashI(id, 36), (5.0 + 7.0 * hashI(id, 37)) * sc);
  vCol = blackbody(mix(11000.0, 24000.0, hashI(id, 38))) * uAmt * mix(0.3, 1.0, z) * (0.35 + 1.6 * pow(hashI(id, 39), 4.0));
  gl_Position = vec4((c + aC * R) * 2.0 * mr / uRes, 0.0, 1.0);
}`;
  const FUSE_FS = `
in vec2 vP;
in vec4 vE;
in vec3 vCol;
out vec4 o;
void main() {
  float u = vE.x, sc = vE.y;
  float e = 0.0;
  if (u < 0.0) {
    // the approach: two glints spiralling in, brightening
    float k = -u / 0.6;
    float sep = vE.w * pow(k, 1.4);
    float a = vE.z + 7.0 * pow(k, 0.7);
    vec2 d = vec2(cos(a), sin(a)) * sep;
    float s2 = 1.0 / (2.0 * pow(1.1 * sc, 2.0));
    vec2 p1 = vP - d, p2 = vP + d;
    e = (exp(-dot(p1, p1) * s2) + exp(-dot(p2, p2) * s2)) * 0.22 * smoothstep(1.0, 0.55, k) * (1.0 + 1.5 * (1.0 - k));
  } else {
    // fusion: a flare, a soft halo and a thin ring of light racing outward
    float r = length(vP);
    float sig = (1.4 + 1.6 * u) * sc;
    e = exp(-u * 6.0) * exp(-r * r / (2.0 * sig * sig)) * 2.2;
    e += 0.2 * exp(-u * 4.5) * exp(-r / (4.0 * sc));
    // a faint, quick ring of light, broken by the turbulence
    float rr = 20.0 * sc * sqrt(u / 0.75);
    float x = (r - rr) / (0.9 * sc);
    float brk = 0.55 + 0.45 * sin(atan(vP.y, vP.x) * 3.0 + vE.z * 5.0);
    e += 0.05 * exp(-x * x) * pow(saturate(1.0 - u / 0.45), 2.0) * brk;
    e *= smoothstep(26.0 * sc, 18.0 * sc, r);
  }
  o = vec4(vCol * e, 1.0);
}`;

  // ------------------------------------------------------------------ CPU helpers
  function h1(i, c) {
    return M.rng(((i + 1) * 0x9e3779b1 + (c + 7) * 0x85ebca77) >>> 0)();
  }
  function vnoise1(x, salt) {
    const i = Math.floor(x), f = x - i;
    const u = f * f * (3 - 2 * f);
    return M.mix(h1(salt, i), h1(salt, i + 1), u);
  }

  // ------------------------------------------------------------------ scene
  let progSpark, progBang, progStreak, progFuse, quadVao, cquadVao, nStreaks = 0, nFuse = 0, maxTaps = 5;
  const FUSE_T0 = 9.6, FUSE_SPAN = 3.4;
  const pairs = new Float32Array(24), pairDir = new Float32Array(12);

  // Inflation rate (e-folds/s) and accumulated e-folds since the bang.
  const H0 = 9.0, TAU_I = 0.9, HF = 0.12;
  const rateH = (dt) => H0 * Math.exp(-dt / TAU_I) + HF;
  const efolds = (dt) => H0 * TAU_I * (1 - Math.exp(-dt / TAU_I)) + HF * dt;

  // The spark (cues.spark .. cues.bang). It grows like the score's rising tone (level doubling every
  // ~1.25 s) and breathes with an accelerating pulse; its tremble deepens with the tone's vibrato.
  // The inhale collapses everything to a pin-point exactly as the music cuts to silence (4.71) and
  // holds it there, barely alive, until the bang.
  function sparkUniforms(s) {
    const c = s.cues, T = s.T;
    const tS = T - c.spark;
    const span = c.bang - c.spark - 0.4;                          // 3.0 s of growth
    const appear = M.smoothstep(0, 0.35, tS);
    // ignition: the point is already lit on the cue frame and rings like the score's bell, then the
    // slow swell takes over
    const lit = M.smoothstep(-0.03, 0.02, tS), ping = lit * Math.exp(-Math.max(0, tS) / 0.32);
    const g = M.saturate((Math.pow(2, Math.max(0, tS) / 1.25) - 1) / (Math.pow(2, span / 1.25) - 1));
    const collapse = M.smootherstep(c.bang - 0.5, c.bang - 0.24, T);   // 4.50 -> 4.76
    const squeeze = collapse * (1 - collapse) * 4;                    // peaks mid-collapse
    const shiver = M.smoothstep(0.9, span, tS) * (1 - collapse);
    const flick = 1 + (0.42 + 0.3 * shiver) * (vnoise1(T * 13.0, 1) - 0.5) + 0.3 * (vnoise1(T * 31.0, 2) - 0.5) +
      0.18 * (vnoise1(T * 3.1, 3) - 0.5) + 0.25 * shiver * Math.sin(T * 32.0);
    // an accelerating breath: ~0.5 Hz at the spark, ~1.1 Hz just before the inhale
    const bph = 6.2832 * (0.5 * tS + 0.1 * tS * tS);
    const breathe = 1 + (0.18 + 0.12 * g) * Math.sin(bph - 1.2) + 0.06 * Math.sin(tS * 5.1);
    const core = (appear + 1.3 * ping) * M.mix(5, 44, g) * flick * (1 + 0.6 * squeeze) * (1 - 0.88 * collapse);
    const halo = (appear + 0.8 * ping) * M.mix(0.08, 0.85, g) * breathe * (1 + 0.8 * squeeze) * (1 - 0.95 * collapse);
    const haloR = M.mix(0.005, 0.03, Math.sqrt(g)) * (0.88 + 0.12 * breathe) * (1 - 0.93 * collapse);
    const ring = M.smoothstep(0.6, 2.6, tS) * 0.06 * breathe * (1 + 1.5 * squeeze) * (1 - collapse * collapse);
    const foam = M.smoothstep(0.8, 2.8, tS) * 0.05 * (1 - collapse);
    const jA = 0.32 + 0.6 * shiver;
    const jit = [jA * (vnoise1(T * 23, 4) - 0.5), jA * (vnoise1(T * 23, 5) - 0.5)];
    const push = 0.55 + 0.9 * Math.sqrt(g);
    // virtual particle pairs popping out of the vacuum and annihilating
    const env = M.smoothstep(0.4, 2.2, tS) * (1 - collapse);
    for (let i = 0; i < 6; i++) {
      const P = 0.62 + 0.13 * i;
      const x = (tS + i * 0.271) / P;
      const cyc = Math.floor(x), u = x - cyc;
      const life = 0.55;
      let w = 0, sep = 0, px = 0, py = 0, dx = 1, dy = 0;
      if (u < life && tS > 0) {
        const k = Math.sin(Math.PI * u / life);
        const rr = (0.014 + 0.075 * Math.pow(h1(i * 17 + 3, cyc), 1.4)) * push * (1 - 0.8 * collapse);
        const a = 6.2832 * h1(i * 17 + 4, cyc);
        px = Math.cos(a) * rr; py = Math.sin(a) * rr;
        const b = 6.2832 * h1(i * 17 + 5, cyc);
        dx = Math.cos(b); dy = Math.sin(b);
        sep = k * (0.0018 + 0.0025 * h1(i * 17 + 6, cyc)) * (0.8 + 0.5 * g);
        w = k * k * env * (0.4 + 0.7 * h1(i * 17 + 7, cyc));
      }
      pairs.set([px, py, sep, w], i * 4);
      pairDir.set([dx, dy], i * 2);
    }
    return { uCore: core, uHalo: halo, uHaloR: haloR, uRing: ring, uFoam: foam, uJit: jit, uPairs: pairs, uPairDir: pairDir };
  }

  function bangPost(s) {
    const c = s.cues, T = s.T, p = s.post;
    const dt = T - c.bang;
    if (T < c.spark) {
      p.grain = 0.006; p.vignette = 0.6; p.aberration = 0; p.bloom = 0.6;
      return;
    }
    if (dt < 0) {
      p.grain = 0.009; p.vignette = 0.6; p.aberration = 0.04;
      p.bloom = 1.1; p.bloomThreshold = 0.5; p.bloomKnee = 0.5; p.bloomRadius = 1.2;
      return;
    }
    // the bang and inflation, blending into the fireball post
    // blinding white on the cue, held through ~5.25, then the uniform flash collapses quickly and the
    // remaining light is the radial glow of the ball itself (uGlowI), so space reads black, not grey
    const flash = 18 * Math.exp(-Math.pow(dt / 0.17, 2)) * (1 - M.smoothstep(0.2, 0.32, dt));
    const inf = {
      exposure: 0.34, bloom: 0.7, bloomThreshold: 2.0, bloomKnee: 1.0, bloomRadius: 1.2,
      vignette: 0.5 + 0.25 * M.smoothstep(0.15, 0.4, dt) * (1 - M.smoothstep(0.7, 1.3, dt)), grain: 0.02,
      aberration: 0.12 + 0.9 * Math.exp(-dt * 1.6), saturation: 1.12, contrast: 0.12,
    };
    const fire = {};
    BB.firePost(T, c, fire);
    const w = M.smoothstep(c.inflationEnd - 1.2, c.inflationEnd + 0.6, T);
    for (const k in inf) p[k] = M.mix(inf[k], fire[k], w);
    BB.applyGain(p, BB.gain(T, c));
    p.flash = flash;
    p.shake = Math.min(1, 1.2 * Math.exp(-dt * 1.5)) * (dt < 2.5 ? 1 : 0) + 0.12 * Math.exp(-dt * 0.4);
  }

  U.defineScene({
    id: 'bigbang',
    async init(gl, ctx) {
      // 1. issue every program first (they can compile in parallel), 2. buffers, 3. the GPU bake,
      // which only waits for the small noise-generator program.
      maxTaps = ctx.tier === 'high' ? 5 : ctx.tier === 'mid' ? 4 : 3;
      const defs = BB.fireDefines(ctx.tier) + `#define NT ${maxTaps}\n`;
      const progNoise = BB.noiseProg(gl);
      progSpark = U.gl.program(gl, U.gl.FULLSCREEN_VS, U.glsl.frag(SPARK_FS), 'bigbang-spark');
      progBang = U.gl.program(gl, U.gl.FULLSCREEN_VS, U.glsl.frag(defs + BB.GLSL_NOISE + BB.GLSL_FIRE + BANG_FS), 'bigbang-bang');
      progStreak = U.gl.program(gl, U.glsl.vert(STREAK_VS), U.glsl.frag(STREAK_FS), 'bigbang-streak');
      progFuse = U.gl.program(gl, U.glsl.vert(FUSE_VS), U.glsl.frag(FUSE_FS), 'bigbang-fuse');
      const quad = U.gl.buffer(gl, new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]));
      quadVao = U.gl.vao(gl, [{ loc: 0, buffer: quad, size: 2 }]);
      nStreaks = Math.round(5200 * ctx.particleScale);
      const cquad = U.gl.buffer(gl, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]));
      cquadVao = U.gl.vao(gl, [{ loc: 0, buffer: cquad, size: 2 }]);
      nFuse = Math.max(28, Math.round(95 * ctx.particleScale));
      if (progNoise) await U.gl.compiled(gl, [progNoise]);
      BB.noiseTex(gl);
    },
    render(gl, s) {
      const c = s.cues, T = s.T;
      bangPost(s);
      if (T < c.spark) return; // the void
      if (T < c.bang) {
        progSpark.use().setAll(sparkUniforms(s)).setAll({ uRes: [s.width, s.height], uT: T });
        U.gl.drawFullscreen(gl);
        return;
      }
      const dt = T - c.bang;
      const E = efolds(dt), H = rateH(dt);
      const infW = 1 - M.smoothstep(c.inflationEnd - 1.0, c.inflationEnd + 0.8, T);
      const fireW = M.smoothstep(c.inflationEnd - 1.6, c.inflationEnd + 0.2, T);
      const shockR = 0.012 * Math.exp(E * 0.75);
      const infTemp = Math.exp(M.mix(Math.log(40000), Math.log(2700), M.smoothstep(0.4, 2.9, dt)));
      const coolTint = 1 - M.smoothstep(c.bang + 0.9, c.inflationEnd - 1.0, T);
      const reheat = M.smoothstep(c.inflationEnd - 1.9, c.inflationEnd - 1.0, T) * (1 - M.smoothstep(c.inflationEnd - 1.0, c.inflationEnd + 0.2, T));
      const infBright = 2.4 * Math.exp(-dt * 0.35) + 0.4;
      const fs = BB.fireState(T, c);
      const gain = BB.gain(T, c);
      BB.bindNoise(gl, 0);
      const blur = Math.min(1.4, H * 0.07 + 0.02);
      progBang.use().setAll(fs).setAll({
        uNoise: 0, uRes: [s.width, s.height], uT: T,
        uNT: Math.max(1, Math.min(maxTaps, Math.ceil(blur / 0.05))),
        uInfW: infW, uFireW: fireW, uE: E, uBlur: blur,
        uShockR: shockR, uShockI: 14 * Math.exp(-dt * 1.2) * (1 - M.smoothstep(0.9, 1.6, shockR)),
        uInfTemp: infTemp, uInfBright: infBright, uCoolTint: coolTint, uReheat: reheat,
        uCoreI: 40 * Math.exp(-dt * 2.0) + 2.0 * Math.exp(-dt * 0.5),
        uGlowI: 4.5 * Math.exp(-dt * 2.6) * M.smoothstep(0.0, 0.2, dt),
        uCollI: 25 * M.smoothstep(0.12, 0.22, dt) * (1 - M.smoothstep(0.32, 0.55, dt)),
        uCollR: M.mix(0.75, 0.1, M.smoothstep(0.27, 0.46, dt)),
        uFoamEvo: dt * 1.4 + 0.3 * Math.sin(dt * 2.0), uGain: gain,
      });
      U.gl.drawFullscreen(gl);

      // hyper-speed streaks of the unfolding space
      const amt = M.smoothstep(0, 0.06, dt) * (1 - M.smoothstep(c.inflationEnd - 1.6, c.inflationEnd + 0.6, T));
      if (amt > 0.001 && nStreaks > 0) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        progStreak.use().setAll({
          uRes: [s.width, s.height], uE: E, uH: H, uShockR: shockR,
          uAmt: amt * (3.0 + 6.0 * Math.exp(-dt * 1.2)) * gain, uShutter: 0.05, uTempK: infTemp * 1.1,
        });
        gl.bindVertexArray(quadVao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nStreaks);
        gl.bindVertexArray(null);
        gl.disable(gl.BLEND);
      }
      // nucleosynthesis: the first nuclei fuse
      if (T > FUSE_T0 - 0.7 && T < FUSE_T0 + FUSE_SPAN + 0.8 && nFuse > 0) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        progFuse.use().setAll({ uRes: [s.width, s.height], uT: T, uT0: FUSE_T0, uSpan: FUSE_SPAN, uAmt: 40.0 * gain });
        gl.bindVertexArray(cquadVao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nFuse);
        gl.bindVertexArray(null);
        gl.disable(gl.BLEND);
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_3D, null);
      BB.cache.T = T; BB.cache.w = s.width; BB.cache.h = s.height; BB.cache.tex = s.target.tex;
    },
  });
})();
