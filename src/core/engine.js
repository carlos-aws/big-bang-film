// Engine: owns the canvas, the film clock, scene scheduling/cross-fades, HDR post-processing,
// the intro/pause/fullscreen interaction and the years-ago counter. Loaded last.
(function () {
  'use strict';
  const U = window.U;
  const M = U.math;
  const TL = U.timeline;

  // ------------------------------------------------------------------ options
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  const DEBUG_T = hash.has('t') ? parseFloat(hash.get('t')) : null;
  const STILL = hash.has('still'); // render only on demand (automation)
  const DEBUG_PLAY = hash.has('play');
  const FIXED_SCALE = hash.has('scale') ? parseFloat(hash.get('scale')) : STILL ? 1 : null;

  const ua = navigator.userAgent;
  const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
  let tier = hash.get('q') || (isMobile ? 'mid' : 'high');
  if (!['low', 'mid', 'high'].includes(tier)) tier = 'high';
  const TIER = {
    low: { maxDpr: 1, maxPixels: 0.8e6, particleScale: 0.3 },
    mid: { maxDpr: 1.5, maxPixels: 1.5e6, particleScale: 0.6 },
    high: { maxDpr: 1.5, maxPixels: 2.8e6, particleScale: 1.0 },
  }[tier];

  // ------------------------------------------------------------------ DOM / GL
  const canvas = document.getElementById('gl');
  const introEl = document.getElementById('intro');
  const counterEl = document.getElementById('counter');

  const gl = canvas.getContext('webgl2', {
    alpha: false, antialias: false, depth: false, stencil: false,
    premultipliedAlpha: false, preserveDrawingBuffer: STILL, powerPreference: 'high-performance',
  });
  if (!gl) {
    console.error('WebGL2 is not available');
    return;
  }
  // Enabled before any program exists: lets the driver compile on background threads and
  // lets init poll for completion instead of blocking the page.
  const parallelCompile = gl.getExtension('KHR_parallel_shader_compile');
  U.gl.anisotropy(gl); // before any program exists, so later texture() calls never block on it
  const caps = (U.gl.caps = {
    hdr: !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float')),
    floatLinear: !!gl.getExtension('OES_texture_float_linear'),
    maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    maxPointSize: gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1],
  });

  // ------------------------------------------------------------------ post shaders
  const H = U.glsl.header;
  const VS = U.gl.FULLSCREEN_VS;

  const progMix = U.gl.program(gl, VS, H + `
in vec2 vUv; out vec4 o;
uniform sampler2D uA, uB; uniform float uW;
void main() { o = vec4(mix(texture(uA, vUv).rgb, texture(uB, vUv).rgb, uW), 1.0); }`, 'post-mix');

  // 13-tap downsample (Jimenez 2014). First pass applies a soft threshold and Karis average.
  const progDown = U.gl.program(gl, VS, H + `
in vec2 vUv; out vec4 o;
uniform sampler2D uSrc; uniform vec2 uTexel; uniform float uFirst, uThreshold, uKnee;
vec3 s(vec2 off) { return texture(uSrc, vUv + off * uTexel).rgb; }
float karis(vec3 c) { return 1.0 / (1.0 + dot(c, vec3(0.2126, 0.7152, 0.0722))); }
vec3 prefilter(vec3 c) {
  float br = max(c.r, max(c.g, c.b));
  float rq = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  rq = rq * rq / (4.0 * uKnee + 1e-4);
  return c * max(rq, br - uThreshold) / max(br, 1e-4);
}
void main() {
  vec3 a = s(vec2(-2, 2)), b = s(vec2(0, 2)), c = s(vec2(2, 2));
  vec3 d = s(vec2(-2, 0)), e = s(vec2(0, 0)), f = s(vec2(2, 0));
  vec3 g = s(vec2(-2, -2)), h = s(vec2(0, -2)), i = s(vec2(2, -2));
  vec3 j = s(vec2(-1, 1)), k = s(vec2(1, 1)), l = s(vec2(-1, -1)), m = s(vec2(1, -1));
  vec3 col;
  if (uFirst > 0.5) {
    vec3 g0 = (a + b + d + e) * 0.25, g1 = (b + c + e + f) * 0.25, g2 = (d + e + g + h) * 0.25, g3 = (e + f + h + i) * 0.25, g4 = (j + k + l + m) * 0.25;
    float w0 = karis(g0), w1 = karis(g1), w2 = karis(g2), w3 = karis(g3), w4 = karis(g4);
    col = (g0 * w0 * 0.125 + g1 * w1 * 0.125 + g2 * w2 * 0.125 + g3 * w3 * 0.125 + g4 * w4 * 0.5) /
          (w0 * 0.125 + w1 * 0.125 + w2 * 0.125 + w3 * 0.125 + w4 * 0.5);
    col = prefilter(col);
  } else {
    col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  o = vec4(max(col, 0.0), 1.0);
}`, 'post-down');

  const progUp = U.gl.program(gl, VS, H + `
in vec2 vUv; out vec4 o;
uniform sampler2D uSrc; uniform vec2 uTexel; uniform float uRadius;
void main() {
  vec2 r = uTexel * uRadius;
  vec3 c = texture(uSrc, vUv).rgb * 4.0;
  c += (texture(uSrc, vUv + vec2(-r.x, 0)).rgb + texture(uSrc, vUv + vec2(r.x, 0)).rgb +
        texture(uSrc, vUv + vec2(0, -r.y)).rgb + texture(uSrc, vUv + vec2(0, r.y)).rgb) * 2.0;
  c += texture(uSrc, vUv + vec2(-r.x, -r.y)).rgb + texture(uSrc, vUv + vec2(r.x, -r.y)).rgb +
       texture(uSrc, vUv + vec2(-r.x, r.y)).rgb + texture(uSrc, vUv + vec2(r.x, r.y)).rgb;
  o = vec4(c / 16.0, 1.0);
}`, 'post-up');

  const progFinal = U.gl.program(gl, VS, H + `
in vec2 vUv; out vec4 o;
uniform sampler2D uScene, uBloom;
uniform vec2 uRes;
uniform float uExposure, uBloomStrength, uVignette, uGrain, uAberration, uFlash, uSaturation, uContrast;
uniform float uFade, uDim, uTime, uZoom;
uniform vec3 uTint, uLift;
uniform vec2 uShake;
uniform vec4 uCounter;
uniform float uCounterFeather, uCounterOn;
const mat3 ACESIn = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
const mat3 ACESOut = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
vec3 rrt(vec3 v) { vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
vec3 aces(vec3 c) { return clamp(ACESOut * rrt(ACESIn * c), 0.0, 1.0); }
float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void main() {
  vec2 uv = (vUv - 0.5) / uZoom + 0.5 + uShake;
  vec2 d = uv - 0.5;
  vec3 col;
  if (uAberration > 0.0) {
    vec2 off = d * uAberration * 0.012;
    col = vec3(texture(uScene, uv + off).r, texture(uScene, uv).g, texture(uScene, uv - off).b);
    col += vec3(texture(uBloom, uv + off * 2.0).r, texture(uBloom, uv).g, texture(uBloom, uv - off * 2.0).b) * uBloomStrength;
  } else {
    col = texture(uScene, uv).rgb + texture(uBloom, uv).rgb * uBloomStrength;
  }
  col = max(col, 0.0) * uExposure * uTint / 0.6 + uLift;
  col += uFlash;
  col = aces(col);
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = max(mix(vec3(l), col, uSaturation), 0.0);
  float aspect = uRes.x / uRes.y;
  float r = length(d * vec2(max(aspect, 1.0), max(1.0 / aspect, 1.0))) * 1.41421;
  col *= mix(1.0, 1.0 - smoothstep(0.45, 1.25, r) * 0.85, uVignette);
  col = pow(col, vec3(1.0 / 2.2));
  col = mix(col, smoothstep(0.0, 1.0, col), uContrast);
  vec2 fc = gl_FragCoord.xy;
  if (uCounterOn > 0.0) {
    vec2 q = max(abs(fc - uCounter.xy) - uCounter.zw, 0.0);
    float m = uCounterOn * (1.0 - smoothstep(0.0, 1.0, length(q) / uCounterFeather));
    col *= 1.0 - m * 0.5 * smoothstep(0.25, 0.8, dot(col, vec3(0.2126, 0.7152, 0.0722)));
  }
  float n = h12(fc + fract(uTime * 7.31) * 517.0) + h12(fc * 1.37 + fract(uTime * 3.17) * 911.0) - 1.0;
  col += n * uGrain * (0.35 + 0.65 * (1.0 - l));
  col += (h12(fc + 0.5) - 0.5) / 255.0;
  o = vec4(col * uFade * uDim, 1.0);
}`, 'post-final');

  const POST_DEFAULTS = {
    exposure: 1, bloom: 0.8, bloomThreshold: 0.9, bloomKnee: 0.6, bloomRadius: 1.0,
    vignette: 0.55, grain: 0.035, aberration: 0.12, flash: 0, shake: 0,
    saturation: 1, contrast: 0.12, zoom: 1,
  };
  const VEC_POST = { tint: [1, 1, 1], lift: [0, 0, 0] };
  function freshPost() {
    const p = Object.assign({}, POST_DEFAULTS);
    for (const k in VEC_POST) p[k] = VEC_POST[k].slice();
    return p;
  }

  // ------------------------------------------------------------------ targets
  let cssW = 1, cssH = 1, outW = 1, outH = 1, renderScale = FIXED_SCALE || (tier === 'high' ? 1 : 0.85);
  let sceneW = 1, sceneH = 1;
  let tA = null, tB = null, tMix = null, bloomMips = [];
  let counterBox = [0, 0, 1, 1], counterFeather = 1, counterBoxDirty = true;

  function computeSizes() {
    cssW = Math.max(1, window.innerWidth);
    cssH = Math.max(1, window.innerHeight);
    const dpr = window.devicePixelRatio || 1;
    let pr = Math.min(dpr, TIER.maxDpr);
    pr = Math.min(pr, Math.sqrt(TIER.maxPixels / (cssW * cssH)));
    if (STILL) pr = 1;
    outW = Math.max(1, Math.round(cssW * pr));
    outH = Math.max(1, Math.round(cssH * pr));
  }

  function rebuildTargets() {
    computeSizes();
    counterBoxDirty = true;
    if (canvas.width !== outW || canvas.height !== outH) {
      canvas.width = outW;
      canvas.height = outH;
    }
    const w = Math.max(16, Math.round(outW * renderScale));
    const h = Math.max(16, Math.round(outH * renderScale));
    if (w === sceneW && h === sceneH && tA) return false;
    sceneW = w; sceneH = h;
    for (const t of [tA, tB, tMix, ...bloomMips]) U.gl.deleteTarget(gl, t);
    tA = U.gl.target(gl, w, h, { depth: true });
    tB = U.gl.target(gl, w, h, { depth: true });
    tMix = U.gl.target(gl, w, h);
    bloomMips = [];
    let bw = w >> 1, bh = h >> 1;
    for (let i = 0; i < 7 && bw >= 4 && bh >= 4; i++) {
      bloomMips.push(U.gl.target(gl, bw, bh));
      bw >>= 1; bh >>= 1;
    }
    return true;
  }

  // ------------------------------------------------------------------ scenes
  const entries = TL.scenes.map((e) => ({ ...e, def: U.scenesById[e.id] || null, ok: false, failed: false }));
  const sceneCtx = {
    gl, caps, tier, isMobile,
    particleScale: TIER.particleScale,
    get width() { return sceneW; },
    get height() { return sceneH; },
  };
  const reported = new Set();
  function reportError(id, phase, err) {
    const key = id + ':' + phase;
    if (reported.has(key)) return;
    reported.add(key);
    console.error(`[scene ${id}] ${phase} failed:`, err && err.stack ? err.stack : err);
  }

  let ready = false;
  const readyWaiters = [];
  const yieldTask = (ms) => new Promise((r) => setTimeout(r, ms || 0));
  // Every scene's init starts at once: one scene's CPU work fills the time the others wait for
  // the driver's shader compiles. (Programs created after an init's first await carry no owner;
  // settlePrograms() finds their scene by label.)
  async function initScenes() {
    const runs = [];
    for (const e of entries) {
      if (!e.def) { console.warn(`[engine] scene "${e.id}" not defined; it will render black`); continue; }
      U.gl.owner = e.id;
      let run;
      try {
        run = Promise.resolve(e.def.init && e.def.init(gl, sceneCtx));
      } catch (err) {
        run = Promise.reject(err);
      }
      U.gl.owner = null;
      resetState();
      runs.push(run.then(() => { e.ok = !e.failed; }, (err) => { e.failed = true; reportError(e.id, 'init', err); }));
    }
    await Promise.all(runs);
    resetState();
    await yieldTask();
    await settlePrograms();
    // Warm-up: render each scene once so drivers finish shader work before playback.
    const warm = U.gl.target(gl, 64, 64, { depth: true });
    for (const e of entries) {
      if (!e.ok) continue;
      renderSceneInto(e, warm, (e.start + e.end) / 2, 0, 1);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      await yieldTask();
    }
    U.gl.deleteTarget(gl, warm);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    ready = true;
    readyWaiters.splice(0).forEach((f) => f());
  }

  // Wait (without blocking the page) until the driver has compiled every program, then check
  // them. A program that failed to compile takes its scene down (it renders black).
  async function settlePrograms() {
    if (parallelCompile) {
      // (gives up once no program has linked for 30 s)
      const t0 = performance.now();
      while (performance.now() - Math.max(t0, U.gl.progressAt) < 30000 && !gl.isContextLost()) {
        const busy = U.gl.pendingPrograms().some((P) => !P.done());
        if (!busy) break;
        await yieldTask(16);
      }
    }
    for (const P of U.gl.pendingPrograms()) {
      try {
        P.finalize();
      } catch (err) {
        const e = entries.find((x) => x.id === P.owner) ||
          entries.find((x) => P.label === x.id || (P.label && P.label.startsWith(x.id + '-')));
        if (e) {
          // (an init that used the program has already reported it)
          if (!e.failed) reportError(e.id, 'init', err);
          e.ok = false; e.failed = true;
        } else console.error(err);
      }
    }
  }
  const whenReady = () => (ready ? Promise.resolve() : new Promise((r) => readyWaiters.push(r)));

  function resetState() {
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    gl.depthMask(true);
    gl.colorMask(true, true, true, true);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.blendEquation(gl.FUNC_ADD);
    gl.bindVertexArray(null);
    gl.useProgram(null);
    for (let i = 7; i >= 0; i--) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  }

  // Renders one scene at film time T into target. Returns its post params.
  function renderSceneInto(e, target, T, dt, weight) {
    const post = freshPost();
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
    gl.viewport(0, 0, target.w, target.h);
    gl.clearColor(0, 0, 0, 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!e.ok) return post;
    const dur = e.end - e.start;
    const t = T - e.start;
    const s = {
      gl, T, t, dur, p: t / dur, dt, weight,
      start: e.start, end: e.end,
      width: target.w, height: target.h, aspect: target.w / target.h,
      years: TL.yearsAgo(T), cues: TL.cues,
      tier, particleScale: TIER.particleScale, isMobile, caps,
      target, post,
      bindOutput() { gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb); gl.viewport(0, 0, target.w, target.h); },
    };
    try {
      e.def.render(gl, s);
    } catch (err) {
      reportError(e.id, 'render', err);
    }
    resetState();
    return post;
  }

  function activeAt(T) {
    const list = [];
    for (const e of entries) if (T >= e.start && T < e.end) list.push(e);
    if (!list.length) {
      // Past the end: keep the last scene; before the start: the first.
      list.push(T >= entries[entries.length - 1].end ? entries[entries.length - 1] : entries[0]);
    }
    return list.slice(-2);
  }

  // ------------------------------------------------------------------ frame
  let lastPost = freshPost();
  function renderFrame(T, dt, dim, fade) {
    rebuildTargets();
    const act = activeAt(T);
    let src, post;
    if (act.length === 2) {
      const [a, b] = act;
      const w = M.smoothstep(b.start, a.end, T);
      const pa = renderSceneInto(a, tA, T, dt, 1 - w);
      const pb = renderSceneInto(b, tB, T, dt, w);
      post = {};
      for (const k in pa) {
        post[k] = Array.isArray(pa[k]) ? pa[k].map((v, i) => M.mix(v, pb[k][i], w)) : M.mix(pa[k], pb[k], w);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, tMix.fb);
      gl.viewport(0, 0, tMix.w, tMix.h);
      progMix.use().setAll({ uA: 0, uB: 1, uW: w });
      U.gl.bindTexture(gl, 0, tA.tex);
      U.gl.bindTexture(gl, 1, tB.tex);
      U.gl.drawFullscreen(gl);
      src = tMix;
    } else {
      post = renderSceneInto(act[0], tA, T, dt, 1);
      src = tA;
    }
    lastPost = post;

    // Bloom chain
    let prev = src;
    progDown.use();
    for (let i = 0; i < bloomMips.length; i++) {
      const m = bloomMips[i];
      gl.bindFramebuffer(gl.FRAMEBUFFER, m.fb);
      gl.viewport(0, 0, m.w, m.h);
      progDown.setAll({ uSrc: 0, uTexel: [1 / prev.w, 1 / prev.h], uFirst: i === 0 ? 1 : 0, uThreshold: post.bloomThreshold, uKnee: Math.max(0.01, post.bloomKnee) });
      U.gl.bindTexture(gl, 0, prev.tex);
      U.gl.drawFullscreen(gl);
      prev = m;
    }
    progUp.use();
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = bloomMips.length - 1; i > 0; i--) {
      const s = bloomMips[i], d = bloomMips[i - 1];
      gl.bindFramebuffer(gl.FRAMEBUFFER, d.fb);
      gl.viewport(0, 0, d.w, d.h);
      progUp.setAll({ uSrc: 0, uTexel: [1 / s.w, 1 / s.h], uRadius: post.bloomRadius });
      U.gl.bindTexture(gl, 0, s.tex);
      U.gl.drawFullscreen(gl);
    }
    gl.disable(gl.BLEND);

    // Final composite to the screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, outW, outH);
    const sh = post.shake;
    const shake = sh > 0
      ? [sh * 0.006 * (Math.sin(T * 41.3) + 0.6 * Math.sin(T * 73.9 + 1.3)), sh * 0.006 * (Math.sin(T * 37.7 + 2.1) + 0.6 * Math.sin(T * 67.1))]
      : [0, 0];
    const counterOn = counterOpacity() * (1 - U.math.smoothstep(1, 4, post.flash));
    progFinal.use().setAll({
      uScene: 0, uBloom: 1, uRes: [outW, outH],
      uExposure: post.exposure, uBloomStrength: bloomMips.length ? post.bloom / bloomMips.length * 2 : 0,
      uVignette: post.vignette, uGrain: post.grain, uAberration: post.aberration, uFlash: post.flash,
      uSaturation: post.saturation, uContrast: post.contrast, uTint: post.tint, uLift: post.lift,
      uFade: fade, uDim: dim, uTime: T, uShake: shake, uZoom: post.zoom * (1 + sh * 0.02),
      uCounter: counterBox, uCounterFeather: counterFeather,
      uCounterOn: counterOn,
    });
    U.gl.bindTexture(gl, 0, src.tex);
    U.gl.bindTexture(gl, 1, bloomMips.length ? bloomMips[0].tex : src.tex);
    U.gl.drawFullscreen(gl);
    resetState();
    updateCounter(T);
  }

  // ------------------------------------------------------------------ counter
  let counterText = '';
  function updateCounter(T) {
    const y = Math.max(0, Math.round(TL.yearsAgo(T)));
    const txt = y.toLocaleString('en-US');
    if (txt !== counterText) {
      if (txt.length !== counterText.length) counterBoxDirty = true;
      counterText = txt;
      counterEl.textContent = txt;
    }
  }

  // Soft backing behind the counter: the final pass darkens a feathered box around the number,
  // only where the picture is bright, so it stays legible over the fireball and is a no-op on
  // dark frames. The box is measured in output pixels (GL origin bottom-left).
  function counterOpacity() {
    if (counterBoxDirty) {
      counterBoxDirty = false;
      const r = counterEl.getBoundingClientRect(), k = outW / cssW, h = r.height;
      counterBox = [(r.left + r.width / 2) * k, (cssH - r.top - r.height / 2) * k, (r.width / 2) * k, (h * 0.15) * k];
      counterFeather = Math.max(4, h * 3.5 * k);
    }
    return parseFloat(getComputedStyle(counterEl).opacity) || 0;
  }

  // ------------------------------------------------------------------ clock & state
  // state: 'loading' | 'intro' | 'playing' | 'paused' | 'ended'
  let state = 'intro';
  let T = 0;
  let anchorT = 0, anchorWall = 0;
  let dim = 1, dimTarget = 1;
  let lastWall = performance.now();
  let needsRender = true;
  const audio = () => (U.audio && typeof U.audio.init === 'function' ? U.audio : null);

  function now() { return performance.now() / 1000; }

  function setPlaying(fromT) {
    T = fromT;
    anchorT = T;
    anchorWall = now();
    state = 'playing';
    dimTarget = 1;
    document.body.classList.add('playing');
    document.body.classList.remove('paused');
    if (T < TL.cues.outroStart + 1.5) counterEl.classList.add('on');
    requestWakeLock();
    kick();
  }

  let audioStarted = false, silentPlay = false;
  let beganAt = -1e9;
  let contextLost = false, refullscreen = false;
  function startAudio(fromT) {
    const a = audio();
    if (!a) return;
    try { a.init(); a.start(fromT); audioStarted = true; } catch (err) { console.error('[audio] start failed', err); }
  }

  // The click on the title. Fullscreen and the audio context need the user gesture, so they
  // happen now; the film itself starts once every scene is ready (the title stays up, dimmed,
  // if the click came early).
  function begin() {
    if ((state !== 'intro' && state !== 'ended') || contextLost) return;
    requestFullscreen();
    const a = audio();
    if (a) {
      try { a.init(); } catch (err) { console.error('[audio] init failed', err); }
    }
    beganAt = performance.now();
    state = 'loading';
    if (!ready) introEl.classList.add('waiting');
    whenReady().then(startFilm);
  }
  // Also called when the tab becomes visible again (the film never starts in a hidden tab).
  function startFilm() {
    if (state !== 'loading' || !ready || contextLost || document.hidden) return;
    introEl.classList.remove('waiting');
    introEl.classList.add('gone');
    counterEl.classList.add('on');
    setPlaying(0);
    startAudio(0);
    beganAt = performance.now();
  }

  function pause() {
    if (state !== 'playing') return;
    T = anchorT + (now() - anchorWall);
    state = 'paused';
    dimTarget = 0.72;
    document.body.classList.add('paused');
    const a = audio();
    if (a) try { a.pause(T); } catch (err) { console.error('[audio] pause failed', err); }
    releaseWakeLock();
    kick();
  }

  function resume() {
    if (state !== 'paused' || contextLost) return;
    if (refullscreen) { refullscreen = false; requestFullscreen(); }
    setPlaying(T);
    const a = audio();
    if (!a) return;
    if (!audioStarted) { startAudio(T); return; } // e.g. after a debug seek or a context restore
    try { a.resume(T); } catch (err) { console.error('[audio] resume failed', err); }
  }

  function finish() {
    state = 'ended';
    T = TL.duration;
    document.body.classList.remove('playing', 'paused');
    counterEl.classList.remove('on');
    introEl.classList.remove('gone');
    introEl.classList.add('again');
    // Restart the title's blur-in (its animations would otherwise just carry on).
    const span = introEl.firstElementChild;
    if (span) { span.style.animation = 'none'; void span.offsetWidth; span.style.animation = ''; }
    const a = audio();
    if (a) try { a.stop(); } catch (err) { console.error('[audio] stop failed', err); }
    audioStarted = false;
    releaseWakeLock();
    kick();
  }

  function toggle() {
    // A double click/tap on the title must not start and then immediately pause the film.
    if (performance.now() - beganAt < 600) return;
    if (state === 'intro' || state === 'ended') begin();
    else if (state === 'playing') {
      if (silentPlay) { silentPlay = false; startAudio(T); } // started via #t=..&play: the first click turns the sound on
      else pause();
    } else if (state === 'paused') resume();
  }

  // ------------------------------------------------------------------ fullscreen / wake lock
  function requestFullscreen() {
    const el = document.documentElement;
    const isFs = document.fullscreenElement || document.webkitFullscreenElement;
    if (isFs) return;
    try {
      const fn = el.requestFullscreen || el.webkitRequestFullscreen;
      if (fn) {
        const r = fn.call(el, { navigationUI: 'hide' });
        if (r && r.catch) r.catch(() => {});
      }
    } catch (_) { /* not supported (e.g. iPhone Safari) */ }
  }

  let wakeLock = null;
  function requestWakeLock() {
    if (!navigator.wakeLock || wakeLock) return;
    navigator.wakeLock.request('screen').then((l) => {
      wakeLock = l;
      l.addEventListener('release', () => { wakeLock = null; });
    }).catch(() => {});
  }
  function releaseWakeLock() {
    if (wakeLock) wakeLock.release().catch(() => {});
    wakeLock = null;
  }

  // ------------------------------------------------------------------ loop
  let rafId = 0;
  let frameTimes = [];
  let lastScaleChange = 0, lastScaleDrop = -1e9;
  function kick() {
    needsRender = true;
    if (!rafId && !STILL) rafId = requestAnimationFrame(loop);
  }

  function loop() {
    rafId = 0;
    const wall = performance.now();
    const dtWall = Math.min(0.25, (wall - lastWall) / 1000);
    lastWall = wall;

    let dt = 0;
    if (state === 'playing') {
      const nt = anchorT + (now() - anchorWall);
      dt = Math.max(0, nt - T);
      T = nt;
      if (T >= TL.duration) finish();
      else if (T > TL.cues.outroStart + 1.5) counterEl.classList.remove('on');
      const a = audio();
      if (a && state === 'playing') try { a.update(T); } catch (err) { reportError('audio', 'update', err); }
      adaptResolution(dtWall);
    }

    dim += (dimTarget - dim) * Math.min(1, dtWall * 6);
    if (Math.abs(dim - dimTarget) < 0.002) dim = dimTarget;

    const fade = state === 'intro' || state === 'loading' ? 1 : 1 - M.smoothstep(TL.cues.outroStart, TL.duration, T);
    const animating = state === 'playing' || dim !== dimTarget || needsRender || state === 'loading';
    if (animating && !contextLost) {
      needsRender = false;
      if (state === 'intro' || state === 'loading' || state === 'ended') {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        if (state === 'ended') updateCounter(TL.duration);
      } else {
        renderFrame(T, dt, dim, fade);
      }
    }
    if (state === 'playing' || state === 'loading' || dim !== dimTarget) rafId = requestAnimationFrame(loop);
  }

  // Dynamic resolution: keep the frame rate up on slower GPUs.
  function adaptResolution(dtWall) {
    if (FIXED_SCALE) return;
    frameTimes.push(dtWall);
    if (frameTimes.length < 45) return;
    const sorted = frameTimes.slice().sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    frameTimes = [];
    const t = now();
    if (t - lastScaleChange < 1.5) return;
    let next = renderScale;
    if (med > 1 / 40) next = Math.max(0.5, renderScale - 0.12);
    else if (med > 1 / 52) next = Math.max(0.5, renderScale - 0.06);
    else if (med < 1 / 58 && renderScale < 1 && t - lastScaleDrop > 10) next = Math.min(1, renderScale + 0.05);
    if (Math.abs(next - renderScale) > 1e-3) {
      if (next < renderScale) lastScaleDrop = t;
      renderScale = next;
      lastScaleChange = t;
    }
  }

  // ------------------------------------------------------------------ input
  window.addEventListener('click', (ev) => {
    ev.preventDefault();
    if (ev.detail > 1) return; // the 2nd/3rd click of a double/triple click
    toggle();
  });
  window.addEventListener('keydown', (ev) => {
    if (ev.code === 'Space' || ev.code === 'Enter' || ev.code === 'KeyK') {
      ev.preventDefault();
      toggle();
    }
  });
  window.addEventListener('contextmenu', (ev) => ev.preventDefault());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state === 'playing') pause();
    else if (!document.hidden && state === 'loading') startFilm();
  });
  let cursorTimer = 0;
  window.addEventListener('pointermove', () => {
    document.body.classList.add('cursor');
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => document.body.classList.remove('cursor'), 1800);
  });
  let resizeQueued = false;
  function onResize() {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => {
      resizeQueued = false;
      rebuildTargets();
      for (const e of entries) if (e.ok && e.def.resize) try { e.def.resize(gl, sceneCtx); } catch (err) { reportError(e.id, 'resize', err); }
      kick();
    });
  }
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  document.addEventListener('fullscreenchange', onResize);
  document.addEventListener('webkitfullscreenchange', onResize);
  // GPU reset: pause and wait. Once the context comes back, every scene's GPU resources are
  // gone, so reload the page and land paused at the same moment of the film.
  const RESUME_KEY = 'so-it-begins:resume';
  canvas.addEventListener('webglcontextlost', (ev) => {
    ev.preventDefault();
    contextLost = true;
    if (state === 'playing') pause();
  });
  canvas.addEventListener('webglcontextrestored', () => {
    if (state === 'paused' && T > 0 && T < TL.duration) {
      try { sessionStorage.setItem(RESUME_KEY, String(T)); } catch (_) { /* storage blocked */ }
    }
    location.reload();
  });
  let resumeT = null;
  try {
    const v = sessionStorage.getItem(RESUME_KEY);
    sessionStorage.removeItem(RESUME_KEY);
    if (v !== null && isFinite(parseFloat(v))) resumeT = parseFloat(v);
  } catch (_) { /* storage blocked */ }

  // ------------------------------------------------------------------ debug / automation hooks
  U.engine = {
    gl, canvas, caps, tier, isMobile,
    get state() { return state; },
    get T() { return T; },
    get renderScale() { return renderScale; },
    get post() { return lastPost; },
    toggle, pause, resume,
  };
  U.debug = {
    get ready() { return ready; },
    whenReady,
    // Render the frame at film time t synchronously (does not change playback state).
    renderAt(t) {
      T = t;
      if (state === 'intro') { state = 'paused'; dim = dimTarget = 1; introEl.classList.add('gone'); counterEl.classList.add('on'); }
      renderFrame(t, 0, 1, 1 - M.smoothstep(TL.cues.outroStart, TL.duration, t));
      return true;
    },
    // Average wall time (ms) to render a frame at t, GPU-synchronised.
    perf(t, frames) {
      frames = frames || 20;
      const px = new Uint8Array(4);
      renderAt1(t);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) {
        renderFrame(t + i / 60, 1 / 60, 1, 1);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      }
      return (performance.now() - t0) / frames;
    },
    sceneSize: () => [sceneW, sceneH],
    play(t) { setPlaying(t || 0); },
  };
  function renderAt1(t) { renderFrame(t, 0, 1, 1); }

  // ------------------------------------------------------------------ boot
  rebuildTargets();
  initScenes().then(() => {
    const startT = DEBUG_T !== null ? DEBUG_T : resumeT;
    if (startT !== null && !STILL && state === 'intro') {
      introEl.classList.add('gone');
      counterEl.classList.add('on');
      if (DEBUG_PLAY) { setPlaying(startT); silentPlay = true; }
      else {
        // A debug seek shows the frame undimmed; after a GPU reset it looks like a normal pause.
        const restored = DEBUG_T === null;
        state = 'paused'; T = startT; dim = 1; dimTarget = restored ? 0.72 : 1; kick();
        document.body.classList.add('paused');
        refullscreen = restored;
      }
    }
  });
  if (STILL) {
    document.body.classList.add('still');
    introEl.classList.add('gone');
  }
  kick();
})();
