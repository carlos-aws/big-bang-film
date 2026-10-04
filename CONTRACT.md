# "So it begins.." — build contract

A purely cinematic, single-file HTML film: from the Big Bang to the Earth of today, including
continental drift up to today's map. **No UI, menus or text** on screen during the film except a
small years-ago number at the bottom right (the engine owns it). Click/tap anywhere toggles
pause/resume. The page opens black with "So it begins.." in the centre; clicking it goes
fullscreen and starts the film + a procedural Web Audio score. The film is ~190 s.

Everything is rendered with raw **WebGL2** (no libraries, no network, no external assets — the
final `index.html` must work offline when opened from disk).

## Files and ownership

```
build.mjs              bundles src/ -> index.html (each file becomes its own <script>)
src/index.html         page template (intro text, counter, CSS)            [core — do not edit]
src/core/util.js       U namespace, U.math, U.gl helpers                    [core — do not edit]
src/core/glsl.js       U.glsl.header / U.glsl.common (noise, hash, blackbody, starLayer)  [core]
src/core/timeline.js   scene schedule, cues, years-ago mapping              [core — do not edit]
src/core/engine.js     clock, cross-fades, HDR post, input, counter          [core — do not edit]
src/data/*.js          data modules (plates)                                 [plates agent]
src/earth/*.js         shared Earth globe renderer U.earth                   [earth agent]
src/scenes/<id>.js     one file per scene id                                 [scene agents]
src/audio/score.js     U.audio procedural score                              [audio agent]
tools/shot.mjs         screenshot/perf harness
```

**Only create/edit the files you own.** Other agents are working in the same directory at the
same time. If you believe a core file needs a change, do not edit it — put the request in your
final report. You may create private helper files under `/tmp/` freely, and you may add more files
in your own directory (e.g. `src/scenes/<id>-extra.js` — any file in `src/scenes/` is bundled in
alphabetical order, so prefix it with your scene id).

Every source file is a classic script wrapped in an IIFE: `(function () { 'use strict'; const U = window.U; ... })();`
Load order: core/util, core/glsl, core/timeline, data/*, earth/*, scenes/*, audio/*, core/engine.

## Scene API

```js
U.defineScene({
  id: 'bigbang',                    // must match src/core/timeline.js
  init(gl, ctx) { ... },            // once at page load (during the intro). Compile programs, build
                                    // buffers/textures. May return a Promise (awaited before the
                                    // film can start). ctx: { gl, caps, tier, isMobile, particleScale, width, height }
  resize(gl, ctx) { ... },          // optional, after the canvas size changes
  render(gl, s) { ... },            // every frame while the scene is on screen
});
```

`s` (fresh object each frame):

| field | meaning |
|---|---|
| `t`, `dur`, `p` | local seconds since scene start, scene duration, `t/dur` (0..1) |
| `T` | global film time (s). Compare with `s.cues.*` |
| `years` | years ago shown by the counter at `T` (`U.timeline.yearsAgo(T)`) |
| `width`, `height`, `aspect` | size of the render target in px |
| `weight` | this scene's cross-fade weight (1 = alone on screen) |
| `tier` | `'low' \| 'mid' \| 'high'`; `particleScale` (0.3 / 0.6 / 1.0) multiply particle counts by it |
| `target`, `bindOutput()` | the scene's HDR framebuffer; call `s.bindOutput()` to re-bind it (+viewport) after using your own FBOs |
| `post` | writable post-processing parameters for this frame (see below) |
| `dt` | frame delta; **do not** use it to integrate state |

Before `render` the engine binds the scene's target (RGBA16F, with a depth buffer), sets the
viewport, clears to black and disables blend/depth/cull. Afterwards it resets that state, so you
may leave GL state dirty. Output **linear HDR radiance** (values > 1 are fine and drive bloom).

**Determinism:** `render` must be a pure function of time (`s.T`/`s.t`). No simulation state that
accumulates across frames — the film can be paused, seeked (`#t=42`), rendered at any frame rate
and screenshotted at arbitrary times. Particle motion must be computed analytically from
per-particle seeds + time (in the vertex shader ideally). Use `U.math.rng(seed)` for
deterministic CPU-side randomness at init.

**Cross-fades:** consecutive scenes overlap by 2 s (see the table). During the overlap the engine
renders both and blends `mix(a, b, smoothstep)`. Your `p` runs 0..1 over your whole range
*including* the overlaps, so at `p≈0` and `p≈1` you are partially visible. Match the hand-off
picture described below so the blend is seamless (similar framing, colour and brightness).

### Post-processing (`s.post`)

Defaults: `{ exposure: 1, bloom: 0.8, bloomThreshold: 0.9, bloomKnee: 0.6, bloomRadius: 1,
vignette: 0.55, grain: 0.035, aberration: 0.12, flash: 0, shake: 0, saturation: 1, contrast: 0.12,
zoom: 1, tint: [1,1,1], lift: [0,0,0] }`. Set any of them per frame (they are cross-faded between
scenes). Pipeline: scene → bloom (13-tap down / tent up, soft threshold) → `(scene + bloom)*exposure*tint/0.6 + lift + flash`
→ ACES fitted tonemap → saturation → vignette → gamma 2.2 → contrast → grain + dither.
`flash` adds white before tonemapping (1–20 for blinding flashes). `shake` 0..1 = camera shake.

## Helpers

* `U.gl.program(gl, vsSrc, fsSrc, label)` → `{ use(), set(name, v), setAll({...}), uniforms, attribs, finalize() }`
  (setters dispatch on the uniform's GLSL type; numbers, arrays and typed arrays are fine).
  Compilation is **asynchronous** (KHR_parallel_shader_compile): the call returns at once and the
  first `use()`/`set()`/`uniforms`/`attribs` waits for the driver and throws on a compile error
  (`finalize()` does the same explicitly). So in `init`, **create all your programs first, then do
  CPU work, then bakes** — the driver compiles while your JS runs. The engine waits for the rest
  without blocking the page; a program that fails to compile marks its scene as failed (black).
  Programs go to the driver **one at a time** (a paced queue: some GPUs freeze the page while they
  compile, so a freeze lasts one program at most); `P.done()` tells, without blocking, whether the
  driver has finished with one.
* Keep `init` free of long blocking stretches (the intro title is animating): split big CPU loops
  and bake passes with `await new Promise((r) => setTimeout(r, 0))`. Before the first
  `use()`/`set()`/`uniforms`/`attribs` of a program in `init` (a VAO built from `attribs` counts),
  `await U.gl.compiled(gl, [prog, ...])`: it moves those programs ahead of the ones nobody waits
  for yet and resolves once they are linked (and finalized), without blocking. Only wait for what
  the next step needs: a big shader you wait for early holds up the other scenes' bakes. Don't
  poll `COMPLETION_STATUS_KHR` yourself.
  Scene inits run **concurrently** (each one interleaves with the others at every `await`), so
  re-bind all GL state you rely on (framebuffer, viewport, program, VAO, textures and active unit,
  pixelStorei, blend) after each `await`, and leave defaults behind you before each one.
* `U.gl.anisotropy(gl)` → `{ ext, max }` or null (already enabled by the engine; `U.gl.texture` with
  `mipmap` uses it). Avoid other first-time `getExtension`/`getParameter` calls in `init`: like any
  synchronous GL query they wait for the shaders still compiling.
* `U.gl.FULLSCREEN_VS` (provides `vUv` 0..1) + `U.gl.drawFullscreen(gl)`.
* `U.gl.buffer`, `U.gl.vao(gl, [{loc, buffer, size, divisor, ...}], indexBuffer)`, `U.gl.texture`, `U.gl.target(gl, w, h, {hdr, depth})`, `U.gl.deleteTarget`, `U.gl.bindTexture(gl, unit, tex)`.
* `U.glsl.frag(body)` / `U.glsl.vert(body)` = `#version 300 es` + precision + common library:
  `PI, TAU, saturate, rot2, luma, uhash, hash11/12/13, hash22, hash33, hashI(int,int), vnoise, snoise (simplex 3D),
  fbm(p, oct), ridged(p, oct), blackbody(kelvin), hsv2rgb, starLayer(dir, scale, px, density, seed)`.
* `U.math`: `clamp, saturate, mix, linstep, smoothstep, smootherstep, ease*, keyframes, rng, perspective, lookAt, multiply`.
* Screen-space convention for fullscreen shaders:
  `vec2 q = (vUv - 0.5) * uRes / min(uRes.x, uRes.y);` → the shorter screen side spans [-0.5, 0.5].
  **Design for every aspect ratio from 9:19.5 portrait phones to 21:9**: keep the subject inside the
  central circle of radius ~0.45 in these units, let backgrounds fill whatever is outside.
* For particles bigger than a few px use instanced quads (WebGL2 `drawArraysInstanced`); `gl.POINTS`
  max size is only guaranteed to be small (`caps.maxPointSize`, 255 on the test GPU, can be 64 on phones).
  Clamp point sprites to >= ~1.5 px and fade intensity instead of shrinking below that (no shimmering).
* Additive blending into the HDR target: `gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE)`.

## Global conventions

* **Lighting for planets** (solar system → Earth scenes): the Sun is to the left, slightly in front:
  view-space light direction `normalize(vec3(-1.0, 0.25, 0.6))` (x right, y up, z toward the viewer).
* **Planet framing for hand-offs**: planet centred, radius `0.30` in the screen-space units above
  (i.e. diameter = 60 % of the shorter screen side).
* **Earth-fixed frame** (used by `U.plates` and `U.earth`): unit sphere, y = north pole,
  `p = vec3(cos(lat)*cos(lon), sin(lat), -cos(lat)*sin(lon))`, inverse `lat = asin(p.y)`,
  `lon = atan(-p.z, p.x)`. Equirectangular textures: `u = (lon + PI) / TAU`, `v = (PI/2 - lat) / PI`
  (v = 0 at the north pole = first row of the uploaded image, uploaded without FLIP_Y).

## Timeline (src/core/timeline.js is authoritative)

| scene | T range | content |
|---|---|---|
| `bigbang` | 0 – 17 | void, a spark, the Big Bang, inflation, the fireball |
| `plasma` | 15 – 32 | primordial plasma cooling; recombination → CMB; fade to dark |
| `cosmicdawn` | 30 – 47 | dark ages; first stars ignite; first supernovae; first proto-galaxies |
| `cosmicweb` | 45 – 62 | pull back to the cosmic web; galaxies form & merge; approach one spiral |
| `milkyway` | 60 – 77 | the Milky Way; dive into a spiral arm; supernova shock hits a molecular cloud |
| `solarsystem` | 75 – 95 | cloud collapse; protoplanetary disk; the Sun ignites; planets accrete; proto-Earth |
| `theia` | 93 – 110 | molten proto-Earth; Theia impact; debris ring; the Moon forms |
| `earth` | 108 – 190 | Hadean → oceans → life → Rodinia → Snowball Earth → Pangaea → drift to today; final hold, fade |

Cues (global T): spark 1.6 · bang 5.0 · inflationEnd 8.0 · recombination 25.0 · firstStar 35.0 ·
firstSupernova 40.5 · webReveal 49.0 · galaxyMerger 54.5 · solarSupernova 70.0 · sunIgnition 80.0 ·
earthFormed 89.0 · theiaImpact 99.0 · moonFormed 105.0 · oceans 115.0 · life 122.0 ·
oxygenation 127.0 · rodinia 131.0 · snowball 133.0 · thaw 137.0 · pangaea 150.0 · breakup 156.0 ·
dinosaursEnd 165.0 · today 174.0 · outroStart 184.0 · duration 190.0 (engine fades to black
184–190, then the intro text returns). The score hits on these cues, so **visual events must land
exactly on their cue** (read them from `s.cues`, never hard-code).

Years-ago keyframes (counter) — see `yearsKeys` in timeline.js: 13.8 Gyr until the bang,
13,799,620,000 at recombination, 13.6 Gyr first stars, 13.2 Gyr at 47 s, 9 Gyr at 62 s, 4.6 Gyr at
the solar supernova, 4.567 Gyr Sun, 4.54 Gyr Earth (95 s), 4.51 Gyr Theia, 4.45 Gyr (110 s),
4.3 Gyr oceans, 3.5 Gyr life, 2.4 Gyr oxygenation, 1.0 Gyr Rodinia, 720 Myr snowball, 635 Myr thaw,
320 Myr Pangaea, 200 Myr breakup, then decelerating to 0 at 174 s.

### Hand-off pictures (what is on screen during each 2 s overlap)

1. **bigbang → plasma (15–17)**: the screen is filled edge to edge with roiling incandescent plasma,
   white-gold (≈ 8000 K blackbody look), turbulent, slowly expanding past the camera. Bright (mean
   radiance ≈ 2–4 before exposure).
2. **plasma → cosmicdawn (30–32)**: the CMB has faded: nearly black, with only a faint dark
   reddish-brown mottled haze. cosmicdawn starts as near-black with the faintest dark haze.
3. **cosmicdawn → cosmicweb (45–47)**: a field of many small young blue-white proto-galaxies/star
   clumps scattered on black, camera slowly pulling back.
4. **cosmicweb → milkyway (60–62)**: one spiral galaxy, centred, disk inclined ~60° (tilted, long
   axis horizontal), radius ≈ 0.40 screen units, golden core, blue spiral arms with dark dust
   lanes, rotating slowly, camera slowly approaching.
5. **milkyway → solarsystem (75–77)**: inside a spiral arm: a dark, dense, reddish-brown molecular
   cloud core in the centre glowing faintly from within, freshly compressed by the supernova shock,
   starting to collapse; star field + nebular glow behind.
6. **solarsystem → theia (93–95)**: the molten proto-Earth, centred, radius 0.30, lit from the left
   (light convention above), glowing orange-red magma with dark cooling crust plates; faint dusty
   disk band and stars behind; the young Sun out of frame to the left.
7. **theia → earth (108–110)**: post-impact Earth: molten magma-ocean globe, centred, radius 0.30,
   lit from the left; a thin fading debris ring; the newly formed Moon small and to the upper right.

## Art direction

Think high-end science documentary (Cosmos, Voyage of Time, Hubble/JWST imagery): photographic,
volumetric, majestic, physically motivated colour (blackbody temperatures, emission-line nebulae:
H-alpha red/magenta, OIII teal), deep blacks, real sense of scale. Always some slow camera motion
(dolly/orbit/zoom) — never a static frame. Big moments get `post.flash`, `post.shake`, bloom.
Avoid: cartoon looks, flat gradients, visible banding, hard polygon edges, aliasing/shimmer,
uniform noise speckle, everything-is-bright frames, and any text.

## Performance

Target 60 fps. Budget per scene: **≤ 6 ms/frame at 1280x720** measured with
`node tools/shot.mjs ... --perf` on this machine's GPU (Intel Arc iGPU), and it must scale down with
`s.tier` / `s.particleScale` (phones run 'mid'). Bound all loops; raymarch ≤ ~48 steps on high,
fewer on low/mid. The engine also lowers resolution dynamically.

## Testing (do this repeatedly while you work)

```
node tools/shot.mjs --scenes <yourIds> --range <a>:<b>:<step> --size 1280x720,390x844 --sheet --out /tmp/bb-shots/<you>
node tools/shot.mjs --scenes <yourIds> --times <t1,t2> --perf --reps 4 --out /tmp/bb-shots/<you>-perf
```

`--no-counter` hides the years counter (use it for `magick compare -metric AE` identity checks).

Then **look at the PNGs with the Read tool** (sheet_*.png for overview, individual frames for
detail; filenames are `<WxH>_t<time>.png`). The tool prints page console errors and exits 1 on
errors — there must be none from your files. Shots render with `#still`; you can also open
`file://.../page.html#t=40&play` in a real browser if one is available (not required). Check both
landscape and portrait, the hand-off frames, and the exact cue times. Iterate until it looks
genuinely beautiful — judge it like a film critic, not like a unit test.
