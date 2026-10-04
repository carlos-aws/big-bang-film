// End-to-end / real-time tests of the page as the viewer experiences it (file:// URL, no hash,
// real clicks/taps/keys, real-time playback). Complements shot.mjs (deterministic stills).
//
//   cd tools && node e2e.mjs [--html /path/page.html] [--out /tmp/bb-e2e] [--tests load,early,...]
//                            [--pacing-size 1280x720] [--headful]
//
// Tests (default: all, in this order):
//   load       black page + "So it begins.." fade-in (desktop + iPhone), counter hidden, console,
//              network requests, time to U.debug.ready, per-scene init cost, long tasks
//   early      click ~150 ms after DOMContentLoaded (before ready): what the viewer sees and for how long
//   start      click the text: fullscreen, AudioContext running (no autoplay flag), T~0, counter fade-in,
//              cursor auto-hide; then ~20 s real-time progression (T vs wall clock, counter == yearsAgo(T));
//              pause/resume by click (T/counter frozen, audio suspended, dim), rapid toggling, keys
//   touch      iPhone emulation (touch, DPR 3, mobile UA, no fullscreen API): one toggle per tap, tier,
//              silent fullscreen failure; Android emulation: fullscreen requested on tap
//   visibility hidden tab -> auto-pause; behaviour on return
//   ending     seek to 183 after a real start, run past 190: fade, 'ended', intro back, counter hidden,
//              audio stopped; replay by click (audio, fullscreen, counter)
//   resize     1280x720 -> 390x844 -> 1920x1080 -> 844x390 while playing, fullscreen enter/exit
//   ctxloss    WEBGL_lose_context loseContext/restoreContext while playing and during the intro
//   robust     selection/zoom/scrollbars/context menu/safe-area/phone intro typography
//   pacing     fresh load, click, play the whole film in real time: rAF deltas, long tasks, engine
//              tick CPU, per-scene render CPU, dynamic resolution scale, hitches > 50 ms
//
// Writes <out>/results.json, <out>/pacing.json and screenshots <out>/<test>_*.png. Exit code 1 if
// any check failed or the page logged an error/exception.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer, { KnownDevices } from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes(k);
const OUT = path.resolve(get('--out', '/tmp/bb-e2e'));
fs.mkdirSync(OUT, { recursive: true });
let HTML = get('--html');
if (!HTML) {
  const { build } = await import(path.join(ROOT, 'build.mjs'));
  HTML = path.join(OUT, 'page.html');
  build({ out: HTML });
}
HTML = path.resolve(HTML);
const URL0 = 'file://' + HTML;
const ALL = ['load', 'early', 'start', 'touch', 'visibility', 'ending', 'resize', 'ctxloss', 'robust', 'pacing'];
const TESTS = get('--tests') ? get('--tests').split(',') : ALL;
const [PW, PH] = get('--pacing-size', '1280x720').split('x').map(Number);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = { html: HTML, started: new Date().toISOString(), tests: {} };
let failures = 0;
let pageErrors = 0;

// ------------------------------------------------------------------ in-page instrumentation
// Installed before any page script. Times scene init/render (wrapping U.defineScene), each engine
// rAF tick, records long tasks, input events, state changes and (when E.rec) one entry per frame.
function INSTR() {
  const now = () => performance.now();
  const E = (window.__e2e = {
    longtasks: [], frames: [], events: [], states: [], clicks: 0, touchends: 0, pointerups: 0,
    initMs: {}, renderMs: {}, loopMs: 0, rec: false, keep: 0,
  });
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) E.longtasks.push([+e.startTime.toFixed(1), +e.duration.toFixed(1)]); })
      .observe({ type: 'longtask', buffered: true });
  } catch (_) { /* unsupported */ }
  addEventListener('click', (e) => { E.clicks++; E.events.push(['click', now(), e.isTrusted]); }, true);
  addEventListener('touchend', () => { E.touchends++; E.events.push(['touchend', now()]); }, true);
  addEventListener('pointerup', (e) => { E.pointerups++; E.events.push(['pointerup', now(), e.pointerType]); }, true);
  addEventListener('dblclick', () => E.events.push(['dblclick', now()]), true);
  // after the engine's own listener (registered later, bubble phase on window) we cannot run, so
  // check defaultPrevented on document-level bubble listeners added after load (see robust test).
  const raf = window.requestAnimationFrame.bind(window);
  E.raf = raf;
  window.requestAnimationFrame = (cb) => raf((ts) => {
    const t0 = now();
    try { cb(ts); } finally { E.loopMs += now() - t0; }
  });
  const pre = (window.U = window.U || {});
  let ds;
  Object.defineProperty(pre, 'defineScene', {
    configurable: true,
    get() { return ds; },
    set(fn) {
      ds = function (def) {
        const id = def.id;
        if (def.init) {
          const init = def.init;
          def.init = function (...a) {
            const t0 = now();
            const r = init.apply(this, a);
            const sync = now() - t0;
            E.initMs[id] = { sync: +sync.toFixed(1), at: +t0.toFixed(1) };
            if (r && r.then) return r.then((v) => { E.initMs[id].total = +(now() - t0).toFixed(1); return v; });
            E.initMs[id].total = +sync.toFixed(1);
            return r;
          };
        }
        const render = def.render;
        def.render = function (...a) {
          const t0 = now();
          try { return render.apply(this, a); } finally { E.renderMs[id] = (E.renderMs[id] || 0) + now() - t0; }
        };
        return fn(def);
      };
    },
  });
  document.addEventListener('DOMContentLoaded', () => {
    E.dcl = now();
    if (window.U && U.debug) U.debug.whenReady().then(() => { E.readyAt = now(); });
  });
  let lastState = null;
  setInterval(() => {
    const s = window.U && U.engine ? U.engine.state : 'none';
    if (s !== lastState) { E.states.push([+now().toFixed(1), s, window.U && U.engine ? +U.engine.T.toFixed(3) : 0]); lastState = s; }
  }, 10);
  E.fmt = (T) => Math.max(0, Math.round(U.timeline.yearsAgo(T))).toLocaleString('en-US');
  let n = 0;
  function rec(ts) {
    if (E.rec && window.U && U.engine) {
      const c = document.getElementById('counter');
      const T = U.engine.T;
      const txt = c.textContent;
      const want = E.fmt(T);
      const sz = U.debug.sceneSize();
      const r = {};
      for (const k in E.renderMs) r[k] = +E.renderMs[k].toFixed(2);
      const f = { ts: +ts.toFixed(2), T: +T.toFixed(4), st: U.engine.state, sc: +U.engine.renderScale.toFixed(3), w: sz[0], h: sz[1], loop: +E.loopMs.toFixed(2), r };
      if (txt !== want) f.bad = txt + ' != ' + want;
      if ((n++ % 60) === 0 && performance.memory) f.heap = performance.memory.usedJSHeapSize;
      E.frames.push(f);
    }
    E.loopMs = 0; E.renderMs = {};
    raf(rec);
  }
  raf(rec);
}

// iPhone Safari has no element fullscreen API.
function NO_FULLSCREEN() {
  for (const k of ['requestFullscreen', 'webkitRequestFullscreen', 'webkitRequestFullScreen']) {
    try { delete Element.prototype[k]; } catch (_) { /* ignore */ }
  }
}

// ------------------------------------------------------------------ harness
async function launch({ autoplay = false } = {}) {
  // window/screen = the main test viewport, so screencast frames cover the page (also in fullscreen)
  const a = ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-gpu', '--window-size=1280,720', '--screen-info={1280x720}'];
  if (autoplay) a.push('--autoplay-policy=no-user-gesture-required');
  return puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: has('--headful') ? false : true, args: a, protocolTimeout: 600000 });
}

async function openPage(browser, { viewport, device, noFullscreen = false, hash = '' } = {}, log) {
  const page = await browser.newPage();
  const con = [];
  const reqs = [];
  page.on('console', (m) => {
    const ty = m.type();
    const txt = m.text();
    con.push([ty, txt]);
    if (ty === 'error' || ty === 'warn' || ty === 'warning') {
      if (ty === 'error') pageErrors++;
      console.log(`   [page ${ty}] ${txt.slice(0, 300)}`);
    }
  });
  page.on('pageerror', (e) => { pageErrors++; con.push(['exception', e.message]); console.log(`   [page exception] ${e.message}`); });
  page.on('request', (r) => reqs.push(r.url().slice(0, 120)));
  if (device) await page.emulate(KnownDevices[device]);
  else await page.setViewport(viewport || { width: 1280, height: 720, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(INSTR);
  if (noFullscreen) await page.evaluateOnNewDocument(NO_FULLSCREEN);
  const t0 = Date.now();
  await page.goto(URL0 + hash, { waitUntil: 'domcontentloaded' });
  return { page, con, reqs, t0 };
}

function makeTest(name) {
  const T = { name, checks: [], data: {}, shots: [] };
  results.tests[name] = T;
  T.check = (ok, msg, val) => {
    T.checks.push({ ok: !!ok, msg, val });
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}${val !== undefined ? ' — ' + (typeof val === 'string' ? val : JSON.stringify(val)) : ''}`);
  };
  T.note = (k, v) => { T.data[k] = v; console.log(`  .... ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`); };
  T.shot = async (page, label) => {
    const f = path.join(OUT, `${name}_${label}.png`);
    await page.screenshot({ path: f });
    T.shots.push(f);
    return f;
  };
  return T;
}

const ev = (page, fn, ...a) => page.evaluate(fn, ...a);
const waitReady = (page, timeout = 300000) => page.waitForFunction('window.U && U.debug && U.debug.ready', { timeout, polling: 50 });
const engine = (page) => ev(page, () => ({
  state: U.engine.state, T: U.engine.T, scale: U.engine.renderScale,
  fs: !!(document.fullscreenElement || document.webkitFullscreenElement),
  audio: U.audio && U.audio.debug.ctx ? U.audio.debug.ctx.state : 'none',
  audioPlaying: U.audio ? U.audio.debug.playing : null,
  counter: document.getElementById('counter').textContent,
  counterOn: document.getElementById('counter').classList.contains('on'),
  counterOpacity: +getComputedStyle(document.getElementById('counter')).opacity,
  introOpacity: +getComputedStyle(document.getElementById('intro')).opacity,
  spanOpacity: +getComputedStyle(document.querySelector('#intro span')).opacity,
  body: document.body.className,
  dimText: null,
}));
const clickCenter = async (page) => {
  const vp = page.viewport();
  await page.mouse.click(Math.round(vp.width / 2), Math.round(vp.height / 2));
};
// mean luminance (0..1) of a PNG and of its central 50% box
function meanLum(file) {
  const all = +execFileSync('magick', [file, '-colorspace', 'Gray', '-format', '%[fx:mean]', 'info:']).toString();
  return +all.toFixed(4);
}
async function waitT(page, T, timeoutMs = 300000) {
  await page.waitForFunction((T) => U.engine.T >= T || U.engine.state === 'ended', { timeout: timeoutMs, polling: 20 }, T);
}

// ------------------------------------------------------------------ tests
async function testLoad() {
  const T = makeTest('load');
  for (const cfg of [{ tag: 'desktop', viewport: { width: 1280, height: 720, deviceScaleFactor: 1 } }, { tag: 'iphone', device: 'iPhone 15 Pro' }]) {
    const browser = await launch();
    try {
      const { page, con, reqs, t0 } = await openPage(browser, cfg);
      const samples = [];
      for (const at of [0.3, 0.9, 1.6, 2.4, 3.2, 4.2, 6.5]) {
        const wait = at * 1000 - (Date.now() - t0);
        if (wait > 0) await sleep(wait);
        const e = await engine(page);
        const ready = await ev(page, () => U.debug.ready);
        const f = await T.shot(page, `${cfg.tag}_${at.toFixed(1)}s`);
        samples.push({ at, ready, state: e.state, span: e.spanOpacity, counter: e.counterOpacity, lum: meanLum(f) });
      }
      T.note(`${cfg.tag} intro samples (s since goto)`, samples);
      await waitReady(page);
      const info = await ev(page, () => {
        const sp = document.querySelector('#intro span').getBoundingClientRect();
        const cs = getComputedStyle(document.querySelector('#intro span'));
        return {
          dcl: __e2e.dcl, readyAt: __e2e.readyAt, initMs: __e2e.initMs, longtasks: __e2e.longtasks,
          span: { x: sp.x, y: sp.y, w: sp.width, h: sp.height, cx: sp.x + sp.width / 2, cy: sp.y + sp.height / 2 },
          vw: innerWidth, vh: innerHeight, fontSize: cs.fontSize, fontFamily: cs.fontFamily,
          counterText: document.getElementById('counter').textContent,
          counterOpacity: getComputedStyle(document.getElementById('counter')).opacity,
          tier: U.engine.tier, isMobile: U.engine.isMobile, canvas: [U.engine.canvas.width, U.engine.canvas.height],
          scene: U.debug.sceneSize(), dpr: devicePixelRatio,
          renderer: (() => { const g = U.engine.gl; const x = g.getExtension('WEBGL_debug_renderer_info'); return x ? g.getParameter(x.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER); })(),
          caps: U.engine.caps,
        };
      });
      T.note(`${cfg.tag} renderer`, info.renderer);
      T.note(`${cfg.tag} ready after DOMContentLoaded (ms)`, Math.round(info.readyAt - info.dcl));
      T.note(`${cfg.tag} DOMContentLoaded at (ms since nav)`, Math.round(info.dcl));
      T.note(`${cfg.tag} scene init ms`, info.initMs);
      const lt = info.longtasks.filter((l) => l[0] < info.readyAt + 50);
      T.note(`${cfg.tag} long tasks before ready`, { count: lt.length, total: Math.round(lt.reduce((a, l) => a + l[1], 0)), max: Math.max(0, ...lt.map((l) => l[1])), list: lt });
      T.note(`${cfg.tag} layout`, { vw: info.vw, vh: info.vh, dpr: info.dpr, span: info.span, fontSize: info.fontSize, canvas: info.canvas, scene: info.scene, tier: info.tier, isMobile: info.isMobile });
      T.check(Math.abs(info.span.cx - info.vw / 2) < 2 && Math.abs(info.span.cy - info.vh / 2) < 2, `${cfg.tag}: intro text centred`, [info.span.cx, info.span.cy]);
      T.check(info.span.w <= info.vw, `${cfg.tag}: intro text box fits the viewport width`, [info.span.w, info.vw]);
      T.check(+info.counterOpacity === 0, `${cfg.tag}: counter hidden on the intro`, info.counterOpacity);
      const nonLocal = reqs.filter((u) => !/^(file|data|blob):/.test(u));
      T.check(nonLocal.length === 0, `${cfg.tag}: no network requests other than file:/data:/blob:`, nonLocal);
      T.note(`${cfg.tag} requests`, reqs);
      const bad = con.filter((c) => c[0] !== 'log' && c[0] !== 'info' && c[0] !== 'debug');
      T.check(bad.length === 0, `${cfg.tag}: no console errors/warnings during load`, bad);
      T.check(samples.every((s) => s.state === 'intro'), `${cfg.tag}: state stays 'intro' without input`);
      T.check(samples[0].span < 0.05, `${cfg.tag}: text starts invisible (fade-in)`, samples[0].span);
      T.check(samples[samples.length - 1].span > 0.6, `${cfg.tag}: text visible after the fade-in`, samples[samples.length - 1].span);
      await page.close();
    } finally { await browser.close(); }
  }
}

// Clicks at fixed wall times after navigation (fire-and-forget CDP input, so a blocked main thread
// cannot delay the dispatch itself) and measures when the page handles the click, when the film
// starts and what is on screen meanwhile (CDP screencast frames with wall timestamps).
async function testEarly() {
  const T = makeTest('early');
  for (const at of [1.0, 2.0, 3.5]) {
    const browser = await launch();
    try {
      const page = await browser.newPage();
      page.on('pageerror', (e) => { pageErrors++; console.log(`   [page exception] ${e.message}`); });
      await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
      await page.evaluateOnNewDocument(INSTR);
      const cdp = await page.createCDPSession();
      const cast = [];
      cdp.on('Page.screencastFrame', (f) => {
        cast.push({ wall: Date.now(), data: f.data });
        cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      });
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, everyNthFrame: 1, maxWidth: 1280, maxHeight: 720 });
      const nav0 = Date.now();
      const nav = page.goto(URL0, { waitUntil: 'load' });
      await sleep(at * 1000);
      const clickWall = Date.now();
      const base = { x: 640, y: 360, button: 'left', clickCount: 1 };
      cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 640, y: 360 }).catch(() => {});
      cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base }).catch(() => {});
      cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base }).catch(() => {});
      await nav;
      await page.waitForFunction("U.engine.state === 'playing'", { timeout: 300000, polling: 10 });
      await sleep(1500);
      await cdp.send('Page.stopScreencast');
      const d = await ev(page, () => {
        const click = __e2e.events.find((e) => e[0] === 'click');
        const playing = __e2e.states.find((s) => s[1] === 'playing');
        const loading = __e2e.states.find((s) => s[1] === 'loading');
        return { origin: performance.timeOrigin, dcl: __e2e.dcl, click: click && click[1], readyAt: __e2e.readyAt, loadingAt: loading && loading[0], playingAt: playing && playing[0], playingT: playing && playing[2], audio: U.audio.debug.ctx && U.audio.debug.ctx.state, fs: !!document.fullscreenElement, longtasks: __e2e.longtasks };
      });
      const toPage = (wall) => wall - d.origin;
      const clickPage = toPage(clickWall);
      // screencast frames after the click: wall time -> page time, mean luminance of the text box and the counter box
      const frames = [];
      for (const [i, f] of cast.entries()) {
        const pt = toPage(f.wall);
        if (pt < clickPage - 600 || pt > (d.playingAt || 0) + 400) continue;
        const file = path.join(OUT, `early_${at.toFixed(1)}_${String(i).padStart(3, '0')}.jpg`);
        fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
        const txt = +execFileSync('magick', [file, '-gravity', 'center', '-crop', '50%x16%+0+0', '-format', '%[fx:maxima*255]', 'info:']).toString();
        const cnt = +execFileSync('magick', [file, '-gravity', 'southeast', '-crop', '22%x7%+0+0', '-format', '%[fx:maxima*255]', 'info:']).toString();
        frames.push({ t: Math.round(pt - clickPage), text: txt, counter: cnt });
      }
      const r = {
        clickAtNav: Math.round(clickPage), handledAfter: Math.round(d.click - clickPage), readyAt: Math.round(d.readyAt),
        filmStartsAfterClick: Math.round(d.playingAt - clickPage), playingT: d.playingT, audio: d.audio, fs: d.fs,
      };
      T.note(`click at ${at}s after navigation`, r);
      T.note(`click at ${at}s: screencast frames after the click [ms, text max, counter max]`, frames.map((f) => [f.t, f.text, f.counter]));
      T.check(r.handledAfter < 200, `click at ${at}s handled promptly (< 200 ms)`, r.handledAfter);
      // An early click keeps the (dimmed) title up until the film can start: never a blank wait.
      // (frames once the title's own 0.5 + 3.2 s blur-in is over)
      const waiting = frames.filter((f) => f.t > 300 && r.clickAtNav + f.t > 4200 && f.t < r.filmStartsAfterClick - 100);
      T.check(waiting.every((f) => f.text > 40 && f.counter < 20), `click at ${at}s: title stays visible (counter hidden) until the film starts`,
        waiting.filter((f) => !(f.text > 40 && f.counter < 20)).slice(0, 5).map((f) => [f.t, f.text, f.counter]));
      T.check(d.playingAt - d.readyAt < 250, `click at ${at}s: film starts as soon as the scenes are ready`, Math.round(d.playingAt - d.readyAt));
      T.note(`click at ${at}s: wait after the click (ms)`, r.filmStartsAfterClick);
      T.check(d.playingT < 0.25, `click at ${at}s: film starts at T~0`, d.playingT);
      T.check(d.audio === 'running', `click at ${at}s: audio running`, d.audio);
      await page.close();
    } finally { await browser.close(); }
  }
}

async function testStart() {
  const T = makeTest('start');
  const browser = await launch({ autoplay: false });
  try {
    const { page } = await openPage(browser, { viewport: { width: 1280, height: 720, deviceScaleFactor: 1 } });
    await waitReady(page);
    await sleep(4200);
    await T.shot(page, 'intro');
    const box = await ev(page, () => { const r = document.querySelector('#intro span').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; });
    const pre = await engine(page);
    T.check(pre.audio === 'none', 'no AudioContext before the click', pre.audio);
    await page.mouse.move(box[0] - 40, box[1]);
    await page.mouse.click(box[0], box[1]);
    const a0 = await engine(page);
    T.note('immediately after click', a0);
    T.check(a0.fs, 'fullscreen requested and granted on the intro click', a0.fs);
    T.check(a0.state === 'playing', 'state playing right after the click', a0.state);
    T.check(a0.T < 0.2, 'film starts at T~0', a0.T);
    await sleep(400);
    const a1 = await engine(page);
    T.check(a1.audio === 'running', 'AudioContext running (gesture unlock, no autoplay flag)', a1.audio);
    T.check(a1.counterOn && a1.counter === '13,800,000,000', 'counter on and shows 13,800,000,000', a1.counter);
    T.note('counter opacity 0.4 s after click', a1.counterOpacity);
    T.note('cursor 0.4 s after click', await ev(page, () => [document.body.className, getComputedStyle(document.elementFromPoint(innerWidth / 2, innerHeight / 2)).cursor]));
    await sleep(2400);
    const a2 = await engine(page);
    T.check(a2.counterOpacity > 0.99, 'counter fully faded in by ~2.8 s', a2.counterOpacity);
    const cur = await ev(page, () => [document.body.className, getComputedStyle(document.elementFromPoint(innerWidth / 2, innerHeight / 2)).cursor]);
    T.check(cur[1] === 'none', 'cursor hidden after ~2.8 s idle', cur);
    await page.mouse.move(300, 300);
    await sleep(200);
    const cur2 = await ev(page, () => getComputedStyle(document.elementFromPoint(300, 300)).cursor);
    T.check(cur2 !== 'none', 'cursor reappears on mouse move', cur2);
    await sleep(2200);
    const cur3 = await ev(page, () => getComputedStyle(document.elementFromPoint(300, 300)).cursor);
    T.check(cur3 === 'none', 'cursor hides again 1.8 s after the move', cur3);

    // ---- real-time progression (~20 s)
    await ev(page, () => { __e2e.frames = []; __e2e.rec = true; });
    const w0 = Date.now();
    const e0 = await engine(page);
    const syncs = [];
    for (let i = 0; i < 10; i++) {
      await sleep(2000);
      syncs.push(await ev(page, () => +(U.audio.debug.syncError(U.engine.T) * 1000).toFixed(1)));
    }
    const e1 = await engine(page);
    const wallS = (Date.now() - w0) / 1000;
    const fr = await ev(page, () => { __e2e.rec = false; return __e2e.frames; });
    const dT = e1.T - e0.T;
    T.note('real-time: film dT vs wall dt (s)', { dT: +dT.toFixed(3), wall: +wallS.toFixed(3), frames: fr.length, fps: +(fr.length / wallS).toFixed(1) });
    T.check(Math.abs(dT - wallS) < 0.15, 'T advances at wall-clock speed', +(dT - wallS).toFixed(3));
    const sl = [];
    for (let i = 1; i < fr.length; i++) if (fr[i].st === 'playing' && fr[i - 1].st === 'playing') sl.push([fr[i].ts - fr[i - 1].ts, (fr[i].T - fr[i - 1].T) * 1000]);
    const drift = sl.map(([a, b]) => Math.abs(a - b));
    T.note('per-frame |dWall - dT| ms (median, max)', [median(drift), Math.max(...drift)].map((x) => +x.toFixed(2)));
    const bad = fr.filter((f) => f.st === 'playing' && f.bad);
    T.check(bad.length === 0, 'counter text == formatted yearsAgo(T) on every playing frame', bad.slice(0, 5).map((f) => f.bad));
    T.note('audio sync error samples (ms, + = audio late)', syncs);
    T.check(syncs.every((s) => Math.abs(s) < 40), 'audio stays in sync with T (|err| < 40 ms)', syncs);
    T.note('renderScale during the first 20 s', [...new Set(fr.map((f) => f.sc))]);
    await T.shot(page, 'playing_T' + e1.T.toFixed(1));

    // ---- pause / resume by click
    const fPlay = await T.shot(page, 'before_pause');
    await clickCenter(page);
    const p0 = await engine(page);
    T.check(p0.state === 'paused', 'click pauses', p0.state);
    await sleep(350);
    const p1 = await engine(page);
    const meterP = await ev(page, () => U.audio.debug.meter());
    T.check(p1.audio === 'suspended', 'AudioContext suspended while paused', p1.audio);
    T.note('meter while paused', meterP);
    await sleep(1200);
    const fPause = await T.shot(page, 'paused');
    const p2 = await engine(page);
    T.check(p2.T === p0.T && p2.counter === p1.counter, 'T and counter frozen while paused', [p0.T, p2.T, p1.counter, p2.counter]);
    T.check(p2.body.includes('paused'), 'body.paused set', p2.body);
    const lp = meanLum(fPlay), lq = meanLum(fPause);
    T.note('mean luminance playing vs paused (dim)', [lp, lq, +(lq / Math.max(lp, 1e-4)).toFixed(3)]);
    T.check(lq < lp * 0.85, 'pause dim visible', [lp, lq]);
    await clickCenter(page);
    const r0 = await engine(page);
    T.check(r0.state === 'playing' && Math.abs(r0.T - p0.T) < 0.05, 'click resumes from the same T', [p0.T, r0.T]);
    await sleep(1000);
    const r1 = await engine(page);
    T.check(r1.T - p0.T > 0.85 && r1.T - p0.T < 1.25, 'T continues after resume (~1 s later)', +(r1.T - p0.T).toFixed(3));
    T.check(r1.audio === 'running' && r1.audioPlaying, 'audio running again after resume', [r1.audio, r1.audioPlaying]);
    const sy = await ev(page, () => +(U.audio.debug.syncError(U.engine.T) * 1000).toFixed(1));
    T.check(Math.abs(sy) < 40, 'audio re-synced after resume', sy);

    // ---- rapid toggling: 10 clicks in 1 s, then 11
    for (const n of [10, 11]) {
      const before = await engine(page);
      const c0 = await ev(page, () => __e2e.clicks);
      for (let i = 0; i < n; i++) { await clickCenter(page); await sleep(100 - 0); }
      const c1 = await ev(page, () => __e2e.clicks);
      await sleep(600);
      const after = await engine(page);
      const want = n % 2 === 0 ? before.state : before.state === 'playing' ? 'paused' : 'playing';
      T.check(after.state === want && c1 - c0 === n, `${n} rapid clicks -> ${want}`, { state: after.state, clicks: c1 - c0 });
      T.check(want === 'playing' ? after.audio === 'running' && after.audioPlaying : after.audio === 'suspended' && !after.audioPlaying,
        `${n} rapid clicks: audio state consistent`, [after.audio, after.audioPlaying]);
      if (after.state === 'playing') {
        const sy2 = await ev(page, () => +(U.audio.debug.syncError(U.engine.T) * 1000).toFixed(1));
        T.check(Math.abs(sy2) < 40, 'audio in sync after rapid toggling', sy2);
      }
    }
    // now paused (after 11)
    for (const key of ['Space', 'Enter', 'KeyK', 'Space']) {
      const b = await engine(page);
      await page.keyboard.press(key);
      await sleep(250);
      const a = await engine(page);
      T.check(a.state !== b.state && ['playing', 'paused'].includes(a.state), `key ${key} toggles ${b.state} -> ${a.state}`);
    }
    const kOther = await engine(page);
    await page.keyboard.press('KeyX');
    await sleep(150);
    T.check((await engine(page)).state === kOther.state, 'other keys do not toggle');
    // Escape exits fullscreen in a real browser; check the film keeps playing
    await page.close();
  } finally { await browser.close(); }
}

async function testTouch() {
  const T = makeTest('touch');
  for (const cfg of [{ tag: 'iphone', device: 'iPhone 15 Pro', noFullscreen: true }, { tag: 'android', device: 'Pixel 5' }]) {
    if (!KnownDevices[cfg.device]) { T.note('missing device', cfg.device); continue; }
    const browser = await launch();
    try {
      const { page } = await openPage(browser, cfg);
      await waitReady(page);
      await sleep(4000);
      await T.shot(page, `${cfg.tag}_intro`);
      const info = await ev(page, () => ({ tier: U.engine.tier, isMobile: U.engine.isMobile, dpr: devicePixelRatio, vw: innerWidth, vh: innerHeight, canvas: [U.engine.canvas.width, U.engine.canvas.height], hasFS: !!Element.prototype.requestFullscreen, touch: navigator.maxTouchPoints }));
      T.note(`${cfg.tag} env`, info);
      T.check(info.tier === 'mid' && info.isMobile, `${cfg.tag}: tier mid / isMobile`, [info.tier, info.isMobile]);
      const vp = page.viewport();
      const seq = [];
      for (let i = 0; i < 5; i++) {
        const c0 = await ev(page, () => ({ c: __e2e.clicks, t: __e2e.touchends, s: U.engine.state }));
        await page.touchscreen.tap(vp.width / 2 + (i - 2) * 20, vp.height / 2);
        await sleep(i === 0 ? 900 : 700);
        const c1 = await ev(page, () => ({ c: __e2e.clicks, t: __e2e.touchends, s: U.engine.state, fs: !!(document.fullscreenElement || document.webkitFullscreenElement), audio: U.audio.debug.ctx && U.audio.debug.ctx.state }));
        seq.push({ before: c0.s, after: c1.s, clicks: c1.c - c0.c, touchends: c1.t - c0.t, fs: c1.fs, audio: c1.audio });
        if (i === 0) await T.shot(page, `${cfg.tag}_after_first_tap`);
      }
      T.note(`${cfg.tag} taps`, seq);
      T.check(seq[0].after === 'playing', `${cfg.tag}: intro tap starts the film`, seq[0].after);
      T.check(seq.every((s) => s.clicks === 1), `${cfg.tag}: exactly one click per tap`, seq.map((s) => s.clicks));
      const exp = ['playing', 'paused', 'playing', 'paused', 'playing'];
      T.check(seq.every((s, i) => s.after === exp[i]), `${cfg.tag}: exactly one toggle per tap`, seq.map((s) => s.after));
      T.check(seq[0].audio === 'running', `${cfg.tag}: audio running after tap`, seq[0].audio);
      if (cfg.noFullscreen) T.check(!seq[0].fs, `${cfg.tag}: no fullscreen API -> fails silently (see console check)`);
      else T.check(seq[0].fs, `${cfg.tag}: fullscreen granted on tap`, seq[0].fs);
      // double tap quickly: two toggles, no zoom
      const z0 = await ev(page, () => ({ s: visualViewport.scale, st: U.engine.state }));
      await page.touchscreen.tap(vp.width / 2, vp.height / 2);
      await sleep(120);
      await page.touchscreen.tap(vp.width / 2, vp.height / 2);
      await sleep(600);
      const z1 = await ev(page, () => ({ s: visualViewport.scale, st: U.engine.state, sel: String(getSelection()) }));
      T.check(z1.s === 1 && z1.sel === '', `${cfg.tag}: double-tap does not zoom or select`, z1);
      T.note(`${cfg.tag} double tap state ${z0.st} -> ${z1.st}`, '');
      await sleep(1500);
      await T.shot(page, `${cfg.tag}_playing`);
      await page.close();
    } finally { await browser.close(); }
  }
}

async function testVisibility() {
  const T = makeTest('visibility');
  const browser = await launch();
  try {
    const { page } = await openPage(browser, { viewport: { width: 1280, height: 720, deviceScaleFactor: 1 } });
    await waitReady(page);
    await sleep(1500);
    await clickCenter(page);
    await sleep(3000);
    const before = await engine(page);
    // 1) real: another tab in front
    const other = await browser.newPage();
    await other.goto('about:blank');
    await other.bringToFront();
    await sleep(800);
    const hid = await ev(page, () => ({ vis: document.visibilityState, state: U.engine.state, T: U.engine.T, audio: U.audio.debug.ctx.state }));
    T.note('after another tab came to front', hid);
    let viaOverride = false;
    if (hid.vis !== 'hidden') {
      viaOverride = true;
      await ev(page, () => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await sleep(400);
    }
    const h2 = await ev(page, () => ({ vis: document.visibilityState, state: U.engine.state, T: U.engine.T, audio: U.audio.debug.ctx.state }));
    T.note('hidden state' + (viaOverride ? ' (override)' : ''), h2);
    T.check(h2.state === 'paused', 'hidden tab auto-pauses', h2.state);
    T.check(Math.abs(h2.T - before.T) < 1.5, 'pause T taken at hide time', [before.T, h2.T]);
    await sleep(3000);
    if (viaOverride) {
      await ev(page, () => { delete document.hidden; delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange')); });
    }
    await page.bringToFront();
    await sleep(800);
    const back = await engine(page);
    T.note('after return', { state: back.state, T: back.T, audio: back.audio, vis: await ev(page, () => document.visibilityState) });
    T.check(back.state === 'paused' && Math.abs(back.T - h2.T) < 1e-6, 'stays paused at the same T on return (viewer clicks to continue)', [back.state, back.T]);
    await T.shot(page, 'after_return');
    await clickCenter(page);
    await sleep(800);
    const res = await engine(page);
    T.check(res.state === 'playing' && res.audio === 'running', 'click after return resumes with audio', [res.state, res.audio]);
    await other.close();
    await page.close();
  } finally { await browser.close(); }
}

async function testEnding() {
  const T = makeTest('ending');
  const browser = await launch();
  try {
    const { page } = await openPage(browser, { viewport: { width: 1280, height: 720, deviceScaleFactor: 1 } });
    await waitReady(page);
    await sleep(1500);
    await clickCenter(page);
    await sleep(1500);
    await ev(page, () => U.debug.play(183));
    await sleep(1000);
    const s0 = await engine(page);
    const sy = await ev(page, () => +(U.audio.debug.syncError(U.engine.T) * 1000).toFixed(1));
    T.note('after debug seek to 183', { T: s0.T, audio: s0.audio, sync: sy });
    const samp = [];
    for (const t of [184, 185.5, 186.5, 188, 189.5]) {
      await waitT(page, t);
      const e = await engine(page);
      const m = await ev(page, () => U.audio.debug.meter());
      const f = await T.shot(page, 'T' + t.toFixed(1));
      samp.push({ T: +e.T.toFixed(2), lum: meanLum(f), counterOn: e.counterOn, counterOpacity: e.counterOpacity, rms: m && +m.rms.toFixed(4) });
    }
    T.note('outro samples', samp);
    await page.waitForFunction("U.engine.state === 'ended'", { timeout: 30000, polling: 20 });
    const endAt = Date.now();
    const e0 = await engine(page);
    T.check(e0.state === 'ended' && Math.abs(e0.T - 190) < 1e-6, 'state ended at T=190', [e0.state, e0.T]);
    T.check(!e0.counterOn, 'counter hidden at the end', e0.counterOn);
    await sleep(700);
    const e1 = await engine(page);
    T.check(e1.audio === 'suspended' && !e1.audioPlaying, 'audio stopped/suspended after the end', [e1.audio, e1.audioPlaying]);
    const introSamples = [];
    for (const at of [0.3, 1.0, 2.0, 4.0]) {
      const w = at * 1000 - (Date.now() - endAt);
      if (w > 0) await sleep(w);
      const e = await engine(page);
      const f = await T.shot(page, `ended_${at.toFixed(1)}s`);
      introSamples.push({ at, intro: e.introOpacity, span: e.spanOpacity, counter: e.counterOpacity, lum: meanLum(f), cls: await ev(page, () => document.getElementById('intro').className) });
    }
    T.note('intro after the end', introSamples);
    T.check(introSamples[introSamples.length - 1].intro > 0.95 && introSamples[introSamples.length - 1].span > 0.6, 'intro text returns', introSamples[introSamples.length - 1]);
    T.note('fullscreen still active after the end', e1.fs);
    await ev(page, () => document.exitFullscreen && document.fullscreenElement ? document.exitFullscreen() : null);
    await sleep(400);
    await clickCenter(page);
    await sleep(500);
    const r = await engine(page);
    T.check(r.state === 'playing' && r.T < 1.0, 'click after the end replays from 0', [r.state, r.T]);
    T.check(r.fs, 'fullscreen requested again on replay', r.fs);
    T.check(r.audio === 'running' && r.audioPlaying, 'audio running on replay', [r.audio, r.audioPlaying]);
    T.check(r.counterOn && r.counter === '13,800,000,000', 'counter back on replay', [r.counterOn, r.counter]);
    await sleep(6500);
    const r2 = await engine(page);
    const m2 = await ev(page, () => U.audio.debug.meter());
    T.note('replay at T~7 (after the bang): audio meter', { T: r2.T, meter: m2 });
    T.check(m2 && m2.rms > 0.005, 'replay has audible score after the bang', m2);
    await T.shot(page, 'replay_T' + r2.T.toFixed(1));
    await page.close();
  } finally { await browser.close(); }
}

async function testResize() {
  const T = makeTest('resize');
  const browser = await launch();
  try {
    const { page } = await openPage(browser, { viewport: { width: 1280, height: 720, deviceScaleFactor: 1 } });
    await waitReady(page);
    await sleep(1000);
    await clickCenter(page);
    await sleep(500);
    await ev(page, () => U.debug.play(64));
    await sleep(1500);
    for (const [w, h, d] of [[1280, 720, 1], [390, 844, 3], [1920, 1080, 1], [844, 390, 3], [1280, 720, 1]]) {
      await page.setViewport({ width: w, height: h, deviceScaleFactor: d });
      await sleep(1300);
      const info = await ev(page, () => ({ vw: innerWidth, vh: innerHeight, cw: U.engine.canvas.width, ch: U.engine.canvas.height, css: [U.engine.canvas.clientWidth, U.engine.canvas.clientHeight], scene: U.debug.sceneSize(), scale: U.engine.renderScale, T: U.engine.T, state: U.engine.state, sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight }));
      await T.shot(page, `${w}x${h}`);
      const ar = info.cw / info.ch, var_ = info.vw / info.vh;
      T.check(Math.abs(ar - var_) < 0.01 && info.css[0] === info.vw && info.css[1] === info.vh, `${w}x${h}@${d}: canvas re-laid out (aspect ${ar.toFixed(3)} vs ${var_.toFixed(3)})`, info);
      T.check(info.sw <= info.vw && info.sh <= info.vh, `${w}x${h}: no scroll overflow`, [info.sw, info.sh]);
    }
    // fullscreen exit/enter via CDP user gesture
    const cdp = await page.createCDPSession();
    const fsState = async () => ev(page, () => ({ fs: !!document.fullscreenElement, vw: innerWidth, vh: innerHeight, cw: U.engine.canvas.width, ch: U.engine.canvas.height, state: U.engine.state }));
    T.note('fullscreen before', await fsState());
    await ev(page, () => document.fullscreenElement && document.exitFullscreen());
    await sleep(800);
    T.note('after exitFullscreen', await fsState());
    await T.shot(page, 'fs_exit');
    const r = await cdp.send('Runtime.evaluate', { expression: 'document.documentElement.requestFullscreen().then(()=>"ok",(e)=>String(e))', userGesture: true, awaitPromise: true });
    await sleep(800);
    T.note('after requestFullscreen (gesture)', { r: r.result.value, ...(await fsState()) });
    await T.shot(page, 'fs_enter');
    const st = await engine(page);
    T.check(st.state === 'playing', 'still playing after resizes and fullscreen changes', st.state);
    await page.close();
  } finally { await browser.close(); }
}

async function testCtxLoss() {
  const T = makeTest('ctxloss');
  const browser = await launch();
  try {
    const { page, con } = await openPage(browser, { viewport: { width: 1280, height: 720, deviceScaleFactor: 1 } });
    await waitReady(page);
    await sleep(1000);
    await clickCenter(page);
    await sleep(500);
    await ev(page, () => U.debug.play(150));
    await sleep(1500);
    const n0 = con.length;
    await ev(page, () => { window.__lc = U.engine.gl.getExtension('WEBGL_lose_context'); window.__lc.loseContext(); });
    await sleep(1000);
    const l = await engine(page);
    T.note('after loseContext', { state: l.state, T: l.T, audio: l.audio });
    T.check(l.state === 'paused', 'context loss pauses playback', l.state);
    await T.shot(page, 'lost');
    // clicking while lost: what happens?
    await clickCenter(page);
    await sleep(800);
    const l2 = await engine(page);
    T.note('click while context lost', { state: l2.state, T: l2.T });
    await clickCenter(page);
    await sleep(300);
    const nav = page.waitForNavigation({ timeout: 20000 }).then(() => 'reloaded', () => 'no navigation');
    await ev(page, () => window.__lc.restoreContext());
    const navr = await nav;
    T.note('after restoreContext', navr);
    T.note('console during loss', con.slice(n0));
    if (navr === 'reloaded') {
      await waitReady(page);
      await sleep(3500);
      const e = await engine(page);
      await T.shot(page, 'after_restore');
      T.note('after reload', { state: e.state, T: e.T, intro: e.introOpacity, fs: e.fs });
      T.check(e.state === 'paused' && Math.abs(e.T - l.T) < 1e-3 && e.introOpacity < 0.05, 'after restore the page reloads paused at the same T', [e.state, e.T, l.T, e.introOpacity]);
      await clickCenter(page);
      await sleep(1200);
      const e2 = await engine(page);
      T.check(e2.state === 'playing' && e2.T > l.T + 0.5 && e2.audio === 'running' && e2.audioPlaying, 'click after the restore resumes with audio', [e2.state, e2.T, e2.audio, e2.audioPlaying]);
      await clickCenter(page);
      await sleep(300);
      // back to the intro for the next part of the test
      await page.reload();
      await waitReady(page);
      await sleep(1000);
    }
    // loss during the intro
    await ev(page, () => { window.__lc = U.engine.gl.getExtension('WEBGL_lose_context'); window.__lc.loseContext(); });
    await sleep(500);
    await clickCenter(page);
    await sleep(1500);
    const i1 = await engine(page);
    T.note('click on intro while context lost', { state: i1.state, T: i1.T, audio: i1.audio });
    const nav2 = page.waitForNavigation({ timeout: 20000 }).then(() => 'reloaded', () => 'no navigation');
    await ev(page, () => window.__lc.restoreContext());
    T.note('restore during playback-after-lost-intro', await nav2);
    await page.close();
  } finally { await browser.close(); }
}

async function testRobust() {
  const T = makeTest('robust');
  const browser = await launch();
  try {
    // desktop: double click / right click / selection / scrollbars
    const { page } = await openPage(browser, { viewport: { width: 1280, height: 720, deviceScaleFactor: 1 } });
    await waitReady(page);
    await sleep(3800);
    await ev(page, () => { window.__cm = []; window.addEventListener('contextmenu', (e) => __cm.push(e.defaultPrevented)); });
    await page.mouse.click(640, 360, { button: 'right' });
    await sleep(200);
    const cm = await ev(page, () => ({ cm: __cm, state: U.engine.state }));
    T.check(cm.cm.length === 1 && cm.cm[0] === true && cm.state === 'intro', 'right click: context menu suppressed, no toggle', cm);
    await page.mouse.click(640, 360, { clickCount: 2 });
    await sleep(300);
    await page.mouse.click(640, 360, { clickCount: 1 });
    await sleep(300);
    const sel = await ev(page, () => ({ sel: String(getSelection()), state: U.engine.state, clicks: __e2e.clicks }));
    T.check(sel.sel === '', 'double/triple click does not select the intro text', sel);
    T.note('state after dbl-click on intro then click', sel);
    await page.close();
    // sizes: overflow and intro typography
    const sizes = [[1280, 720, 1], [1920, 1080, 1], [2560, 1080, 1], [320, 568, 2], [360, 740, 3], [390, 844, 3], [430, 932, 3], [844, 390, 3], [768, 1024, 2]];
    const typo = [];
    for (const [w, h, d] of sizes) {
      const p = await browser.newPage();
      await p.setViewport({ width: w, height: h, deviceScaleFactor: d, isMobile: d > 1, hasTouch: d > 1 });
      await p.evaluateOnNewDocument(INSTR);
      await p.goto(URL0, { waitUntil: 'domcontentloaded' });
      await sleep(3900);
      const m = await ev(p, () => {
        const r = document.querySelector('#intro span').getBoundingClientRect();
        const rng = document.createRange(); rng.selectNodeContents(document.querySelector('#intro span'));
        const tr = rng.getBoundingClientRect();
        const cs = getComputedStyle(document.querySelector('#intro span'));
        return { vw: innerWidth, vh: innerHeight, text: [Math.round(tr.x), Math.round(tr.width), Math.round(tr.height)], box: [Math.round(r.x), Math.round(r.width)], font: cs.fontSize, ls: cs.letterSpacing,
          sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, bw: document.body.scrollWidth, bh: document.body.scrollHeight };
      });
      const fonts = await (async () => {
        try {
          const c = await p.createCDPSession();
          await c.send('DOM.enable'); await c.send('CSS.enable');
          const doc = await c.send('DOM.getDocument');
          const n = await c.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#intro span' });
          const f = await c.send('CSS.getPlatformFontsForNode', { nodeId: n.nodeId });
          return f.fonts.map((x) => x.familyName).join(',');
        } catch (e) { return 'n/a ' + e.message; }
      })();
      const tag = `${w}x${h}`;
      await p.screenshot({ path: path.join(OUT, `robust_intro_${tag}.png`) });
      T.shots.push(path.join(OUT, `robust_intro_${tag}.png`));
      typo.push({ size: tag, dpr: d, ...m, platformFont: fonts });
      T.check(m.sw <= m.vw && m.sh <= m.vh && m.bw <= m.vw && m.bh <= m.vh, `${tag}: no scrollbars/overflow`, [m.sw, m.sh, m.bw, m.bh]);
      T.check(m.text[0] >= 8 && m.text[0] + m.text[1] <= m.vw - 8, `${tag}: intro text inside the viewport with margin`, m.text);
      await p.close();
    }
    T.note('intro typography per size', typo);
    // safe-area insets on a phone (if the CDP override is supported)
    for (const [dev, ins] of [['iPhone 15 Pro', { top: 59, bottom: 34, left: 0, right: 0 }], ['iPhone 15 Pro landscape', { top: 0, bottom: 21, left: 59, right: 59 }]]) {
      const p = await browser.newPage();
      await p.emulate(KnownDevices[dev]);
      const c = await p.createCDPSession();
      let supported = true;
      try { await c.send('Emulation.setSafeAreaInsetsOverride', { insets: ins }); } catch (e) { supported = false; T.note('safe-area override unsupported', e.message); }
      await p.evaluateOnNewDocument(INSTR);
      await p.goto(URL0, { waitUntil: 'domcontentloaded' });
      await waitReady(p);
      await sleep(1500);
      await p.touchscreen.tap(100, 100);
      await sleep(2800);
      const r = await ev(p, () => { const b = document.getElementById('counter').getBoundingClientRect(); return { right: innerWidth - b.right, bottom: innerHeight - b.bottom, w: b.width, h: b.height, font: getComputedStyle(document.getElementById('counter')).fontSize, envProbe: (() => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;padding-bottom:env(safe-area-inset-bottom);padding-right:env(safe-area-inset-right)'; document.body.appendChild(d); const cs = getComputedStyle(d); const v = [cs.paddingRight, cs.paddingBottom]; d.remove(); return v; })() }; });
      const f = path.join(OUT, `robust_safearea_${dev.replace(/ /g, '_')}.png`);
      await p.screenshot({ path: f });
      T.shots.push(f);
      T.note(`${dev} counter offset from the edges (css px) with insets ${JSON.stringify(ins)}`, r);
      if (supported) T.check(r.right >= ins.right + 13 && r.bottom >= ins.bottom + 11, `${dev}: counter respects safe-area insets`, r);
      await p.close();
    }
    // long-press on a phone during playback: no toggle, no selection/callout
    const { page: ph } = await openPage(browser, { device: 'iPhone 15 Pro' });
    await waitReady(ph);
    await sleep(1500);
    await ph.touchscreen.tap(195, 420);
    await sleep(1500);
    await ev(ph, () => { window.__cm = []; window.addEventListener('contextmenu', (e) => __cm.push(e.defaultPrevented)); });
    const s0 = await engine(ph);
    const c = await ph.createCDPSession();
    await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: 420 }] });
    await sleep(1200);
    await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(500);
    const s1 = await ev(ph, () => ({ state: U.engine.state, sel: String(getSelection()), cm: __cm, scale: visualViewport.scale }));
    T.note('long-press during playback', { before: s0.state, after: s1 });
    T.check(s1.sel === '' && s1.scale === 1, 'long-press: no selection, no zoom', s1);
    await ph.close();
  } finally { await browser.close(); }
}

function median(a) { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; }
function pct(a, p) { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; }

async function testPacing() {
  const T = makeTest('pacing');
  const browser = await launch();
  try {
    const { page } = await openPage(browser, { viewport: { width: PW, height: PH, deviceScaleFactor: 1 } });
    await waitReady(page);
    await sleep(2500);
    await ev(page, () => { __e2e.frames = []; __e2e.rec = true; });
    const wall0 = Date.now();
    await clickCenter(page);
    // progress log
    let last = -1;
    while (true) {
      await sleep(5000);
      const e = await engine(page);
      const sec = Math.floor(e.T / 20);
      if (sec !== last) { last = sec; console.log(`   .. T=${e.T.toFixed(1)} state=${e.state} scale=${e.scale}`); }
      if (e.state === 'ended' || Date.now() - wall0 > 260000) break;
    }
    await sleep(1500);
    const data = await ev(page, () => { __e2e.rec = false; return { frames: __e2e.frames, longtasks: __e2e.longtasks, states: __e2e.states }; });
    fs.writeFileSync(path.join(OUT, 'pacing.json'), JSON.stringify(data));
    const fr = data.frames;
    const TL = await ev(page, () => ({ scenes: U.timeline.scenes, cues: U.timeline.cues }));
    const primary = (Tt) => { let id = TL.scenes[0].id; for (const s of TL.scenes) if (Tt >= s.start && Tt < s.end) id = s.id; return id; };
    const deltas = [];
    for (let i = 1; i < fr.length; i++) {
      const a = fr[i - 1], b = fr[i];
      if (b.st !== 'playing' || a.st !== 'playing') continue;
      deltas.push({ T: b.T, dt: b.ts - a.ts, loop: b.loop, r: b.r, sc: b.sc, w: b.w, h: b.h, ts: b.ts });
    }
    const per = {};
    for (const s of TL.scenes) {
      const d = deltas.filter((x) => primary(x.T) === s.id);
      const solo = d.filter((x) => TL.scenes.filter((q) => x.T >= q.start && x.T < q.end).length === 1);
      const loops = d.map((x) => x.loop);
      const rs = d.map((x) => x.r[s.id] || 0);
      per[s.id] = {
        frames: d.length,
        medDt: +median(d.map((x) => x.dt)).toFixed(2), p95Dt: +pct(d.map((x) => x.dt), 0.95).toFixed(2), maxDt: +Math.max(...d.map((x) => x.dt)).toFixed(1),
        soloMed: +median(solo.map((x) => x.dt)).toFixed(2), soloP95: +pct(solo.map((x) => x.dt), 0.95).toFixed(2),
        loopMed: +median(loops).toFixed(2), loopP95: +pct(loops, 0.95).toFixed(2), renderCpuMed: +median(rs).toFixed(2), renderCpuMax: +Math.max(...rs).toFixed(1),
        scale: [Math.min(...d.map((x) => x.sc)), Math.max(...d.map((x) => x.sc))],
      };
    }
    T.note('per-scene frame times (ms)', per);
    const cueNear = (Tt) => Object.entries(TL.cues).filter(([, c]) => Math.abs(c - Tt) < 0.35).map(([k]) => k);
    const sceneStart = (Tt) => TL.scenes.filter((s) => Tt >= s.start && Tt < s.start + 0.6).map((s) => s.id + '-start');
    const hitches = deltas.filter((x) => x.dt > 50).map((x) => ({ T: +x.T.toFixed(2), dt: +x.dt.toFixed(1), loopCpu: x.loop, sceneCpu: x.r, scale: x.sc, size: x.w + 'x' + x.h, near: [...cueNear(x.T), ...sceneStart(x.T)] }));
    T.note('hitches > 50 ms', hitches);
    const h33 = deltas.filter((x) => x.dt > 34);
    T.note('frames > 34 ms (count by scene)', Object.fromEntries(TL.scenes.map((s) => [s.id, h33.filter((x) => primary(x.T) === s.id).length])));
    const scaleChanges = [];
    for (let i = 1; i < fr.length; i++) if (fr[i].sc !== fr[i - 1].sc || fr[i].w !== fr[i - 1].w) scaleChanges.push({ T: +fr[i].T.toFixed(2), scale: fr[i].sc, size: fr[i].w + 'x' + fr[i].h });
    T.note('dynamic resolution changes', scaleChanges);
    // around each scale change: frame time of the next 3 frames
    const lt = data.longtasks.filter((l) => l[0] >= fr[0].ts - 1);
    const tAt = (ts) => { let lo = 0, hi = fr.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (fr[m].ts < ts) lo = m + 1; else hi = m; } return fr[lo] ? fr[lo].T : -1; };
    T.note('long tasks during playback [T, ms]', lt.map((l) => [+tAt(l[0]).toFixed(2), l[1]]));
    const firsts = {};
    for (const s of TL.scenes) {
      const d = deltas.filter((x) => x.T >= s.start && x.T < s.start + 1.0);
      if (d.length) { const m = d.reduce((a, b) => (b.dt > a.dt ? b : a)); firsts[s.id] = { maxDt: +m.dt.toFixed(1), atT: +m.T.toFixed(2), sceneCpu: m.r[s.id], loop: m.loop }; }
    }
    T.note('worst frame in the first second of each scene', firsts);
    const bad = fr.filter((f) => f.st === 'playing' && f.bad);
    T.check(bad.length === 0, 'counter == yearsAgo(T) on every playing frame (full film)', bad.slice(0, 5).map((f) => [f.T, f.bad]));
    const heaps = fr.filter((f) => f.heap).map((f) => [+f.T.toFixed(0), +(f.heap / 1048576).toFixed(1)]);
    T.note('JS heap MB over T (every ~60 frames, subsampled)', heaps.filter((_, i) => i % 10 === 0));
    const allDt = deltas.map((x) => x.dt);
    T.note('overall', { frames: deltas.length, med: +median(allDt).toFixed(2), p95: +pct(allDt, 0.95).toFixed(2), p99: +pct(allDt, 0.99).toFixed(2), over50: hitches.length, over34: h33.length, wallS: (Date.now() - wall0) / 1000 });
    const end = await engine(page);
    T.check(end.state === 'ended', 'film reached the end in real time', end.state);
    await T.shot(page, 'after_end');
    await page.close();
  } finally { await browser.close(); }
}

const RUN = { load: testLoad, early: testEarly, start: testStart, touch: testTouch, visibility: testVisibility, ending: testEnding, resize: testResize, ctxloss: testCtxLoss, robust: testRobust, pacing: testPacing };
for (const name of TESTS) {
  if (!RUN[name]) { console.log(`unknown test ${name}`); continue; }
  console.log(`== ${name}`);
  const t0 = Date.now();
  try { await RUN[name](); } catch (e) { failures++; console.log(`  FAIL ${name} threw: ${e.stack || e}`); (results.tests[name] || makeTest(name)).error = String(e.stack || e); }
  console.log(`   (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
}
results.failures = failures;
results.pageErrors = pageErrors;
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
console.log(`e2e: ${failures} failed checks, ${pageErrors} page errors. Results: ${path.join(OUT, 'results.json')}`);
process.exit(failures || pageErrors ? 1 : 0);
