// Soundtrack test harness (src/audio/score.js).
//
//   node tools/audio-render.mjs [--t0 0] [--t1 190] [--sr 44100] [--step 0.5] [--wav /tmp/bb-audio/score.wav]
//        [--full] [--no-live] [--no-offline] [--raw] [--lite] [--mobile] [--html prebuilt.html] [--out dir]
//   --raw: bypass the master dynamics (mix analysis), --lite: the reduced mobile voice set,
//   --mobile: what a phone plays (lite voice set + the small-speaker master EQ),
//   --stem hits|beds|pads|patterns|type:a,b: render one layer group only (analysis use)
//   --tap comp: record the bus compressor's input instead of the output (analysis use)
//   --out: directory for the built page and the default WAV (default /tmp/bb-audio)
//
// 1. Builds the page (core + audio only; --full = with all scenes), opens it in headless Chromium.
// 2. Offline: U.audio.renderOffline(t0, t1, sr) -> writes a 16-bit WAV, prints per-window
//    RMS / peak / true-peak estimate (dBFS), brightness proxy (Hz), sub-bass level, stereo width,
//    then checks: silence windows, transients at the timeline cues, NaN / clipping / DC, render speed.
// 3. Live smoke test with a fake clock: init/start/update/pause/resume/stop, mid-film starts,
//    rapid pause/resume, replay after stop. Reports the first tap's cost and when the (deferred)
//    graph is ready, voices, levels, update() cost, sync error.
// Exit code 1 on page errors or failed checks.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { build } = await import(path.join(ROOT, 'build.mjs'));

const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes(k);
const T0 = Number(get('--t0', 0));
const T1 = Number(get('--t1', 190));
const SR = Number(get('--sr', 44100));
const STEP = Number(get('--step', 0.5));
const OUTDIR = get('--out', '/tmp/bb-audio');
const WAV = get('--wav', path.join(OUTDIR, 'score.wav'));
fs.mkdirSync(OUTDIR, { recursive: true });

let html = get('--html');
if (!html) {
  html = path.join(OUTDIR, 'page.html');
  build({ out: html, scenes: has('--full') ? null : ['__none__'] });
}

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-gpu', '--autoplay-policy=no-user-gesture-required'],
});
let errors = 0;
let failed = 0;
const fail = (msg) => { failed++; console.log('  FAIL ' + msg); };
const ok = (msg) => console.log('  ok   ' + msg);

async function openPage() {
  const page = await browser.newPage();
  page.on('console', (m) => {
    const ty = m.type();
    if (ty === 'error' || ty === 'warn' || ty === 'warning') {
      if (ty === 'error') errors++;
      console.log(`[page ${ty}] ${m.text()}`);
    }
  });
  page.on('pageerror', (e) => { errors++; console.log(`[page exception] ${e.message}`); });
  await page.goto('file://' + html + '#still');
  await page.waitForFunction('window.U && U.audio && U.timeline', { timeout: 60000 });
  return page;
}

try {
  // ------------------------------------------------------------------ offline render + analysis
  if (!has('--no-offline')) {
    const page = await openPage();
    console.log(`offline render ${T0}..${T1} s @ ${SR} Hz`);
    const res = await page.evaluate(async (T0, T1, SR, STEP, ropts) => {
      const w0 = performance.now();
      const buf = await U.audio.renderOffline(T0, T1, SR, ropts);
      const wall = (performance.now() - w0) / 1000;
      const L = buf.getChannelData(0), R = buf.getChannelData(1), n = buf.length, sr = buf.sampleRate;
      window.__buf = buf;
      const db = (x) => (x > 1e-9 ? 20 * Math.log10(x) : -180);
      // true-peak estimate: 4x windowed-sinc interpolation where samples are already loud
      const TAPS = 8, sinc = [];
      for (let ph = 1; ph < 4; ph++) {
        const row = [];
        for (let k = -TAPS + 1; k <= TAPS; k++) {
          const x = k - ph / 4, w = 0.5 + 0.5 * Math.cos((Math.PI * x) / TAPS);
          row.push((Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * w);
        }
        sinc.push(row);
      }
      const tp = (d, i) => {
        let m = Math.abs(d[i]);
        if (m < 0.5 && Math.abs(d[i + 1] || 0) < 0.5) return m;
        for (const row of sinc) {
          let s = 0;
          for (let k = -TAPS + 1, j = 0; k <= TAPS; k++, j++) { const ii = i + k; if (ii >= 0 && ii < n) s += d[ii] * row[j]; }
          m = Math.max(m, Math.abs(s));
        }
        return m;
      };
      // biquads (RBJ) for K-weighting (high shelf +4 dB @1681 Hz, HP 38 Hz) and a 150 Hz HP
      const bq = (type, f, q, gainDb) => {
        const A = Math.pow(10, (gainDb || 0) / 40), w = 2 * Math.PI * f / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * q);
        let b0, b1, b2, a0, a1, a2;
        if (type === 'hp') { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; }
        else { const sq = 2 * Math.sqrt(A) * al; b0 = A * ((A + 1) + (A - 1) * cs + sq); b1 = -2 * A * ((A - 1) + (A + 1) * cs); b2 = A * ((A + 1) + (A - 1) * cs - sq); a0 = (A + 1) - (A - 1) * cs + sq; a1 = 2 * ((A - 1) - (A + 1) * cs); a2 = (A + 1) - (A - 1) * cs - sq; }
        const c = [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
        let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
        return (x) => { const y = c[0] * x + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; };
      };
      const kL = [bq('shelf', 1681, 0.707, 4), bq('hp', 38, 0.5)], kR = [bq('shelf', 1681, 0.707, 4), bq('hp', 38, 0.5)];
      const sL = [bq('hp', 150, 0.707), bq('hp', 150, 0.707)], sR = [bq('hp', 150, 0.707), bq('hp', 150, 0.707)];
      const win = Math.round(STEP * sr), rows = [];
      let nan = 0, clip = 0, dcSum = 0, tpMax = 0, tpAt = 0, lpL = 0, lpL2 = 0, prevL = 0, prevR = 0;
      const a = 1 - Math.exp((-2 * Math.PI * 120) / sr);
      for (let w = 0; w * win < n; w++) {
        let s2 = 0, pk = 0, d2 = 0, sub2 = 0, m2 = 0, side2 = 0, dc = 0, tpk = 0, k2 = 0, sp2 = 0;
        const i0 = w * win, i1 = Math.min(n, i0 + win);
        for (let i = i0; i < i1; i++) {
          const l = L[i], r = R[i];
          if (!Number.isFinite(l) || !Number.isFinite(r)) { nan++; continue; }
          const al = Math.abs(l), ar = Math.abs(r);
          if (al > 0.99 || ar > 0.99) clip++;
          if (al > pk) pk = al;
          if (ar > pk) pk = ar;
          if (al > 0.5 || ar > 0.5) { const t = Math.max(tp(L, i), tp(R, i)); if (t > tpk) tpk = t; }
          s2 += l * l + r * r;
          const dl = l - prevL, dr = r - prevR; d2 += dl * dl + dr * dr; prevL = l; prevR = r;
          const m = 0.5 * (l + r), sd = 0.5 * (l - r);
          m2 += m * m; side2 += sd * sd;
          lpL += a * (m - lpL); lpL2 += a * (lpL - lpL2); sub2 += lpL2 * lpL2;
          dc += m;
          const kl = kL[1](kL[0](l)), kr = kR[1](kR[0](r)); k2 += kl * kl + kr * kr;
          const ql = sL[1](sL[0](l)), qr = sR[1](sR[0](r)); sp2 += ql * ql + qr * qr;
        }
        const N = i1 - i0;
        tpk = Math.max(tpk, pk);
        if (tpk > tpMax) { tpMax = tpk; tpAt = T0 + i0 / sr; }
        dcSum += dc;
        const rms = Math.sqrt(s2 / (2 * N));
        rows.push({
          t: T0 + i0 / sr, rms: db(rms), peak: db(pk), tp: db(tpk),
          bright: rms > 1e-6 ? Math.sqrt(d2 / Math.max(1e-20, s2)) * sr / (2 * Math.PI) : 0,
          sub: db(Math.sqrt(sub2 / N)), lufs: k2 > 0 ? -0.691 + 10 * Math.log10(k2 / N) : -180, small: db(Math.sqrt(sp2 / (2 * N))), width: m2 > 1e-14 ? Math.sqrt(side2 / m2) : 0, dc: dc / N,
        });
      }
      // 10 ms frame energy for onset checks
      const fr = Math.round(0.01 * sr), frames = new Float32Array(Math.ceil(n / fr));
      for (let f = 0; f < frames.length; f++) {
        let s = 0; const i0 = f * fr, i1 = Math.min(n, i0 + fr);
        for (let i = i0; i < i1; i++) s += L[i] * L[i] + R[i] * R[i];
        frames[f] = db(Math.sqrt(s / (2 * Math.max(1, i1 - i0))));
      }
      const maxAbs = (ta, tb) => {
        let m = 0;
        for (let i = Math.max(0, Math.floor((ta - T0) * sr)); i < Math.min(n, Math.floor((tb - T0) * sr)); i++) m = Math.max(m, Math.abs(L[i]), Math.abs(R[i]));
        return db(m);
      };
      const cues = U.timeline.cues;
      const onsets = {};
      for (const [k, c] of Object.entries(cues)) {
        if (c < T0 + 0.5 || c > T1 - 0.5) continue;
        const fc = Math.round((c - T0) / 0.01);
        let best = -1e9, bestF = fc;
        for (let f = fc - 40; f <= fc + 40; f++) {
          if (f < 5 || f >= frames.length) continue;
          let pre = 0; for (let j = 1; j <= 5; j++) pre += Math.pow(10, frames[f - j] / 10);
          const jump = frames[f] - 10 * Math.log10(pre / 5 + 1e-18);
          if (jump > best) { best = jump; bestF = f; }
        }
        let pre = 0, post = 0;
        for (let j = 1; j <= 10; j++) { pre += Math.pow(10, frames[fc - j] / 10); post += Math.pow(10, (frames[fc + j] || -180) / 10); }
        onsets[k] = { cue: c, at: T0 + bestF * 0.01, dt: T0 + bestF * 0.01 - c, jump: best, pre: 10 * Math.log10(pre / 10 + 1e-18), post: 10 * Math.log10(post / 10 + 1e-18) };
      }
      let tot = 0;
      for (let i = 0; i < n; i++) tot += L[i] * L[i] + R[i] * R[i];
      return {
        wall, n, sr, rows, nan, clip, dc: dcSum / n, tpMax: db(tpMax), tpAt, onsets,
        integrated: db(Math.sqrt(tot / (2 * n))),
        silence: { pre: maxAbs(0, 1.6), breath: maxAbs(4.73, 4.97), end: maxAbs(189.5, 190), quiet: maxAbs(1.6, 4.72) },
        info: U.audio.lastOffline,
        tempo: U.audio.debug.tempo.A.map((a) => [a.t, a.bpm, a.B]),
      };
    }, T0, T1, SR, STEP, { raw: has('--raw'), lite: has('--lite') || has('--mobile'), mobile: has('--mobile'), stem: get('--stem'), tap: get('--tap') });

    const f1 = (x) => (x <= -179 ? '  -inf' : x.toFixed(1).padStart(6));
    console.log(`rendered ${(res.n / res.sr).toFixed(1)} s in ${res.wall.toFixed(2)} s wall (${((res.n / res.sr) / res.wall).toFixed(1)}x real time); voices built ${res.info && res.info.built}, dropped ${res.info && res.info.dropped}, voice errors ${res.info && res.info.errors}`);
    console.log('   t     rms   peak  tpeak  bright    sub   lufs  small  width   (dBFS; Hz; LUFS-like K-weighted; >150 Hz rms; S/M)');
    for (const r of res.rows) {
      const bar = '#'.repeat(Math.max(0, Math.round((r.lufs + 60) / 2)));
      console.log(`${r.t.toFixed(1).padStart(6)} ${f1(r.rms)} ${f1(r.peak)} ${f1(r.tp)} ${String(Math.round(r.bright)).padStart(6)} ${f1(r.sub)} ${f1(r.lufs)} ${f1(r.small)} ${r.width.toFixed(2).padStart(5)}  ${bar}`);
    }
    console.log('\ncue onsets (largest 10 ms energy jump within +-0.4 s):');
    for (const [k, o] of Object.entries(res.onsets)) {
      console.log(`  ${k.padEnd(15)} ${o.cue.toFixed(2).padStart(7)}  onset ${o.at.toFixed(2).padStart(7)} (dt ${(o.dt * 1000).toFixed(0).padStart(5)} ms)  jump ${o.jump.toFixed(1).padStart(5)} dB   pre ${f1(o.pre)}  post ${f1(o.post)}`);
    }
    console.log('\ntempo anchors [t, bpm, beat]: ' + JSON.stringify(res.tempo));
    console.log(`\nintegrated ${res.integrated.toFixed(1)} dBFS, true peak ${res.tpMax.toFixed(2)} dBFS at ${res.tpAt.toFixed(1)} s, DC ${res.dc.toExponential(2)}`);
    console.log('checks:');
    if (res.nan) fail(`${res.nan} NaN samples`); else ok('no NaN');
    if (res.clip) fail(`${res.clip} samples above 0.99`); else ok('no samples above 0.99');
    if (res.tpMax > -1.0) fail(`true peak ${res.tpMax.toFixed(2)} dBFS > -1`); else ok(`true peak ${res.tpMax.toFixed(2)} dBFS <= -1`);
    if (Math.abs(res.dc) > 1e-3) fail(`DC ${res.dc}`); else ok('no DC');
    if (T0 === 0) {
      if (res.silence.pre > -90) fail(`0-1.6 not silent (${res.silence.pre.toFixed(1)} dBFS)`); else ok(`0-1.6 silent (${f1(res.silence.pre)} dBFS peak)`);
      if (res.silence.quiet > -12) fail(`1.6-4.72 too loud (${res.silence.quiet.toFixed(1)})`); else ok(`1.6-4.72 quiet (peak ${res.silence.quiet.toFixed(1)} dBFS)`);
      if (res.silence.breath > -60) fail(`breath 4.73-4.97 not silent (${res.silence.breath.toFixed(1)})`); else ok(`breath before the bang silent (${f1(res.silence.breath)} dBFS peak)`);
    }
    if (T1 >= 190) { if (res.silence.end > -70) fail(`189.5-190 not silent (${res.silence.end.toFixed(1)})`); else ok(`189.5-190 silent (${f1(res.silence.end)} dBFS peak)`); }
    for (const [k, o] of Object.entries(res.onsets)) {
      const hit = ['bang', 'recombination', 'firstStar', 'firstSupernova', 'galaxyMerger', 'solarSupernova', 'sunIgnition', 'earthFormed', 'theiaImpact', 'thaw', 'pangaea', 'breakup', 'dinosaursEnd', 'today'];
      if (hit.includes(k)) {
        if (Math.abs(o.dt) > 0.025 || o.jump < 3) fail(`${k}: transient ${(o.dt * 1000).toFixed(0)} ms off / ${o.jump.toFixed(1)} dB`);
        else ok(`${k}: transient at cue (${(o.dt * 1000).toFixed(0)} ms, +${o.jump.toFixed(1)} dB)`);
      }
    }
    if (res.wall > (res.n / res.sr) / 3) fail('offline render slower than 3x real time'); else ok('render speed');

    // WAV
    const chunks = [];
    const total = res.n;
    const CH = 1 << 20;
    for (let i = 0; i < total; i += CH) {
      const b64 = await page.evaluate((i, CH) => {
        const buf = window.__buf, L = buf.getChannelData(0), R = buf.getChannelData(1);
        const m = Math.min(CH, buf.length - i), out = new Int16Array(m * 2);
        for (let k = 0; k < m; k++) {
          out[2 * k] = Math.max(-32768, Math.min(32767, Math.round(L[i + k] * 32767)));
          out[2 * k + 1] = Math.max(-32768, Math.min(32767, Math.round(R[i + k] * 32767)));
        }
        const u8 = new Uint8Array(out.buffer);
        let s = '';
        for (let k = 0; k < u8.length; k += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(k, k + 0x8000));
        return btoa(s);
      }, i, CH);
      chunks.push(Buffer.from(b64, 'base64'));
    }
    const data = Buffer.concat(chunks);
    const hdr = Buffer.alloc(44);
    hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write('WAVE', 8);
    hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(2, 22);
    hdr.writeUInt32LE(res.sr, 24); hdr.writeUInt32LE(res.sr * 4, 28); hdr.writeUInt16LE(4, 32); hdr.writeUInt16LE(16, 34);
    hdr.write('data', 36); hdr.writeUInt32LE(data.length, 40);
    fs.writeFileSync(WAV, Buffer.concat([hdr, data]));
    console.log(`wrote ${WAV} (${(data.length / 1048576).toFixed(1)} MB)`);
    await page.close();
  }

  // ------------------------------------------------------------------ live smoke test
  if (!has('--no-live')) {
    const page = await openPage();
    console.log('\nlive smoke test (fake clock):');
    const log = await page.evaluate(async () => {
      const A = U.audio, out = [];
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      let anchorT = 0, anchorW = 0, playing = false, timer = 0, maxV = 0, maxRms = 0, upd = [], syncErr = [];
      const T = () => (playing ? anchorT + (performance.now() - anchorW) / 1000 : anchorT);
      const tick = () => {
        if (!playing) return;
        const t = T(), w = performance.now();
        A.update(t);
        upd.push(performance.now() - w);
        const d = A.debug;
        maxV = Math.max(maxV, d.activeVoices());
        const m = d.meter(); if (m) maxRms = Math.max(maxRms, m.rms);
        if (d.score && d.ctx.state === 'running') syncErr.push(d.syncError(t));
      };
      const run = async (ms) => { const end = performance.now() + ms; while (performance.now() < end) { tick(); await sleep(16); } };
      const go = (t) => { anchorT = t; anchorW = performance.now(); playing = true; };
      const startCost = [];
      const _start = A.start.bind(A);
      A.start = (t) => { const w = performance.now(); _start(t); startCost.push(performance.now() - w); };
      const halt = () => { anchorT = T(); playing = false; };
      const st = () => A.debug.ctx && A.debug.ctx.state;
      const note = (label) => {
        const ms = upd.slice().sort((a, b) => a - b);
        const se = syncErr.slice(-30);
        out.push({ label, T: +T().toFixed(2), state: st(), voices: A.debug.activeVoices(), maxV, maxRmsDb: maxRms > 0 ? +(20 * Math.log10(maxRms)).toFixed(1) : -180,
          updAvg: ms.length ? +(ms.reduce((a, b) => a + b, 0) / ms.length).toFixed(2) : 0, updMax: ms.length ? +ms[ms.length - 1].toFixed(2) : 0,
          syncMs: se.length ? +((se.reduce((a, b) => a + b, 0) / se.length) * 1000).toFixed(1) : null });
        maxV = 0; maxRms = 0; upd = []; syncErr = [];
      };
      // the first tap: init + start must stay cheap (the graph is built in the following tasks)
      const longTasks = [];
      try { new PerformanceObserver((l) => { for (const e of l.getEntries()) longTasks.push(Math.round(e.duration)); }).observe({ type: 'longtask' }); } catch (_) { /* unsupported */ }
      const w0 = performance.now();
      A.init();
      const initMs = performance.now() - w0; // mostly the AudioContext's creation (device open)
      go(0); A.start(0);
      const tapMs = performance.now() - w0 - initMs;
      while (!A.debug.score && performance.now() - w0 < 3000) { tick(); await sleep(4); }
      const builtMs = performance.now() - w0;
      await run(2500 - builtMs); note('start(0) +2.5s');
      out.push({ label: 'first tap', initMs: +initMs.toFixed(1), tapMs: +tapMs.toFixed(1), scoreBuiltAfterMs: +builtMs.toFixed(0), longTasks: longTasks.slice() });
      halt(); A.pause(T()); await sleep(250); note('pause');
      go(anchorT); A.resume(T()); await run(1200); note('resume +1.2s');
      halt(); A.stop(); await sleep(700); note('stop');
      go(96.5); A.start(96.5); await run(3500); note('start(96.5) across Theia');
      halt(); A.pause(T()); await sleep(20); go(anchorT); A.resume(T()); await sleep(30);
      halt(); A.pause(T()); await sleep(120); go(anchorT); A.resume(T()); await run(1000); note('rapid pause/resume');
      go(172); A.start(172); await run(3000); note('start(172) across today');
      halt(); A.stop(); await sleep(600); go(0); A.init(); A.start(0); await run(800); note('replay start(0) after stop');
      const Ts = [3, 6, 20, 25.1, 36, 41, 50, 55, 62, 71, 81, 90, 98.9, 99.2, 104, 116, 123, 128, 132, 134, 136.9, 138, 151, 157, 166, 173.9, 175, 185, 189.8];
      for (const t of Ts) { go(t); A.start(t); await run(300); }
      note('29 mid-film starts');
      go(186); A.start(186); await run(4200); note('186 -> end (190.2)');
      halt(); A.stop(); await sleep(600); note('final stop');
      A.start = _start;
      out.push({ label: 'start() cost', avgMs: +(startCost.reduce((a, b) => a + b, 0) / startCost.length).toFixed(2), maxMs: +Math.max(...startCost).toFixed(2), n: startCost.length });
      return out;
    });
    for (const r of log) console.log('  ' + JSON.stringify(r));
    const by = (l) => log.find((r) => r.label.startsWith(l));
    if (by('start(0)').state !== 'running') fail('not running after start'); else ok('running after start');
    if (by('pause').state !== 'suspended') fail('not suspended after pause'); else ok('suspended after pause');
    if (by('resume').state !== 'running') fail('not running after resume'); else ok('running after resume');
    if (by('stop').state !== 'suspended') fail('not suspended after stop'); else ok('suspended after stop');
    if (by('start(96.5)').maxRmsDb < -30) fail('Theia too quiet live'); else ok(`Theia live level ${by('start(96.5)').maxRmsDb} dBFS rms`);
    if (by('replay').state !== 'running') fail('replay after stop failed'); else ok('replay after stop');
    if (by('replay').maxRmsDb > -60) fail(`replay 0-0.8 s not silent (${by('replay').maxRmsDb} dBFS rms: old tail leaking)`); else ok('replay opens in silence (no tail from the previous run)');
    const ft = by('first tap');
    if (ft.tapMs > 20) fail(`first start(0) took ${ft.tapMs} ms`); else ok(`first init() ${ft.initMs} ms (context creation), start(0) ${ft.tapMs} ms; score built ${ft.scoreBuiltAfterMs} ms later; long tasks ${JSON.stringify(ft.longTasks)}`);
    if (ft.scoreBuiltAfterMs > 1500) fail('score not built within 1.5 s of the first start (the first sound is at 1.6 s)');
    ok(`start() cost avg ${by('start() cost').avgMs} ms, max ${by('start() cost').maxMs} ms`);
    const upMax = Math.max(...log.filter((r) => r.updMax !== undefined).map((r) => r.updMax));
    ok(`update() cost max ${upMax} ms`);
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(`\n${errors} page errors, ${failed} failed checks`);
process.exit(errors || failed ? 1 : 0);
