// Procedural film score: Web Audio API only (no samples, no network).
//
//   U.audio = { init(), start(T), update(T), pause(T), resume(T), stop(), renderOffline(T0, T1, sr) }
//
// How it works
//  * The whole score is a pure function of film time T. It consists of
//      - a static list of events (hits, swells, chord pads, drones, noise beds...). Every event has
//        a start time, a duration and its automation expressed as envelopes in local time or as
//        functions of film time;
//      - pattern layers (heartbeat, ostinato, bass, drums...) generated on demand for any time window
//        on a beat grid. The tempo map is anchored on the timeline cues: every cue falls exactly on a
//        beat and bars restart at each cue, so hits, chord changes and downbeats coincide.
//  * Any event can be started part-way through (offset), so start/resume at any T is exact.
//  * Live: film time maps to audio time as anchorCtx + (T - anchorT). Each frame schedules a
//    lookahead window and servoes the anchor to the audible output time (output latency + drift).
//    Pause = fast fade + suspend; resume = re-anchor and rebuild the voices in progress.
//    start(T) also swaps in a fresh reverb/delay chain (pre-built while paused/stopped) so no tail
//    from the previous position leaks in. Master: DC block -> film gain -> two-band compressor -> soft clipper.
//  * The tap only creates/resumes the AudioContext (iOS needs that inside the gesture). The noise
//    loops and reverb IR are generated in short slices during the title, the graph is built in the
//    tasks after the tap (the first 1.6 s of film are silent) and anchored by the next update(T).
//  * Offline (testing): the same scheduler on an OfflineAudioContext, advanced with suspend()/resume().
(function () {
  'use strict';
  const U = window.U;
  const TL = U.timeline;
  const C = TL.cues;
  const M = U.math;
  const kf = M.keyframes;
  const clamp = M.clamp;
  const sst = M.smoothstep;
  const DUR = TL.duration;

  const LOOKAHEAD = 0.28; // s of audio time scheduled ahead of the current render position (live)
  const MAX_VOICES = 72; // pattern (low-priority) events are dropped above this many active voices
  const OUT_GAIN = 1.0; // final output trim (calibrated with tools/audio-render.mjs)
  // Mix console: trim in dB per voice type (per-event extra trim: ev.trim).
  const TRIM = {
    boom: -6, blast: -6, crack: -4, crash: -3, knock: -4, brass: -5, ring: -4, taiko: -5, bell: -2, shimmer: -2, mallet: 0,
    pad: -5, drone: -4, noise: -4, swell: -4, tone: 0, shepard: -3,
    thump: -8, pluck: 6, bassnote: -2, kick: -5, tom: -5, tick: -3, hat: -3, snare: -4,
  };
  // the original single-band bus compressor: its static (makeup) gain is the level reference the mix
  // was balanced against; the two bands below are level-matched to it
  const COMP = { thr: -12, knee: 8, ratio: 6, att: 0.004, rel: 0.25 };
  // phone/tablet voicing (isMobile): HP, low shelf, presence lift, makeup (dB)
  // hiThr: the high band's compressor threshold moves up by as much as the lift + makeup push that band
  const MOBILE_EQ = { hp: 60, shelfF: 130, shelf: -6, presF: 2200, pres: 3, makeup: 3, hiThr: 4.5 };
  const PRE_GAIN = 0.75;
  const KNOCK_SAT = 1.6; // knock: drive of the spike-rounding saturator (see BUILD.knock)
  const COMP_LAT = 0.006; // DynamicsCompressorNode pre-delay (Chromium/WebKit/Gecko: 6 ms)
  // two-band bus compression (see buildGraph): body band < xover, presence band above
  const BANDS = {
    xover: 250,
    low: { thr: -15, knee: 8, ratio: 6, att: 0.004, rel: 0.25 },
    high: { thr: -14, knee: 8, ratio: 3, att: 0.003, rel: 0.2 },
  };
  // the compressor node's automatic makeup gain, (1 / curve(0 dBFS))^0.6 (DynamicsCompressorKernel,
  // shared by Blink, WebKit and Gecko), so a band compressor can be level-matched below threshold
  function compMakeup(c) {
    const d2l = (d) => Math.pow(10, d / 20), l2d = (x) => 20 * Math.log10(x), lt = d2l(c.thr);
    const knee = (x, k) => (x < lt ? x : lt + (1 - Math.exp(-k * (x - lt))) / k);
    const slopeAt = (x, k) => { const x2 = x * 1.001; return (l2d(knee(x2, k)) - l2d(knee(x, k))) / (l2d(x2) - l2d(x)); };
    const kx = d2l(c.thr + c.knee);
    let lo = 0.1, hi = 10000, k = 5;
    for (let i = 0; i < 15; i++) { if (slopeAt(kx, k) < 1 / c.ratio) hi = k; else lo = k; k = Math.sqrt(lo * hi); }
    return Math.pow(1 / d2l(l2d(knee(kx, k)) - (c.thr + c.knee) / c.ratio), 0.6); // curve(1): ratio slope above the knee
  }

  // ================================================================ helpers
  const PCS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  function midi(n) {
    if (typeof n === 'number') return n;
    const m = /^([A-G])([b#]?)(-?\d)$/.exec(n);
    if (!m) throw new Error('bad note ' + n);
    return PCS[m[1]] + (m[2] === 'b' ? -1 : m[2] === '#' ? 1 : 0) + (parseInt(m[3], 10) + 1) * 12;
  }
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const hz = (n) => mtof(midi(n));
  // Deterministic integer hash -> [0, 1)
  function hash(a, b) {
    let h = (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) ^ 0x165667b1, 0x9e3779b1)) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  // Smooth deterministic wander in about [-1, 1].
  const wander = (t, s) =>
    Math.sin(t * 0.731 + s * 1.7) * 0.5 + Math.sin(t * 1.377 + s * 4.1) * 0.3 + Math.sin(t * 2.913 + s * 2.3) * 0.2;
  // Keyframes interpolated in log space (frequencies).
  function expKeys(keys) {
    const lk = keys.map(([t, v]) => [t, Math.log(v)]);
    return (x) => Math.exp(kf(lk, x));
  }
  const linKeys = (keys) => (x) => kf(keys, x);

  // ================================================================ tempo map
  // Target tempo (bpm) at cue anchors. The cumulative beat count is rounded at every anchor so each
  // cue lands exactly on a beat; between anchors beat(T) is a monotone cubic Hermite (smooth tempo).
  const Tempo = (function () {
    const keys = [
      [C.recombination, 40], [C.webReveal, 56], [C.galaxyMerger, 60], [C.solarSupernova, 68],
      [C.sunIgnition, 76], [C.earthFormed, 84], [C.theiaImpact, 92], [C.moonFormed, 76],
      [C.oceans, 80], [C.life, 84], [C.oxygenation, 88], [C.rodinia, 90], [C.snowball, 92],
      [C.thaw, 96], [C.pangaea, 108], [C.breakup, 118], [C.dinosaursEnd, 126], [C.today, 134],
    ];
    const A = [];
    let cum = 0;
    for (let i = 0; i < keys.length; i++) {
      const [t, bpm] = keys[i];
      if (i) cum += ((t - keys[i - 1][0]) * (keys[i - 1][1] + bpm)) / 120;
      A.push({ t, bpm, B: Math.round(cum), m: bpm / 60 });
    }
    for (let i = 1; i < A.length; i++) if (A[i].B <= A[i - 1].B) A[i].B = A[i - 1].B + 1;
    for (let i = 0; i + 1 < A.length; i++) { // Fritsch-Carlson monotonicity
      const a = A[i], b = A[i + 1];
      const d = (b.B - a.B) / (b.t - a.t);
      const al = a.m / d, be = b.m / d, s = al * al + be * be;
      if (s > 9) { const tau = 3 / Math.sqrt(s); a.m = tau * al * d; b.m = tau * be * d; }
    }
    const N = A.length;
    function seg(T) { let k = 0; while (k + 2 < N && A[k + 1].t <= T) k++; return k; }
    function beat(T) {
      if (T <= A[0].t) return A[0].B + (T - A[0].t) * A[0].m;
      if (T >= A[N - 1].t) return A[N - 1].B + (T - A[N - 1].t) * A[N - 1].m;
      const k = seg(T), a = A[k], b = A[k + 1], h = b.t - a.t, s = (T - a.t) / h;
      const s2 = s * s, s3 = s2 * s;
      return (2 * s3 - 3 * s2 + 1) * a.B + (s3 - 2 * s2 + s) * h * a.m + (3 * s2 - 2 * s3) * b.B + (s3 - s2) * h * b.m;
    }
    function timeOf(bt) {
      if (bt <= A[0].B) return A[0].t + (bt - A[0].B) / A[0].m;
      if (bt >= A[N - 1].B) return A[N - 1].t + (bt - A[N - 1].B) / A[N - 1].m;
      let k = 0;
      while (k + 2 < N && A[k + 1].B <= bt) k++;
      let lo = A[k].t, hi = A[k + 1].t;
      for (let i = 0; i < 40; i++) {
        const mid = 0.5 * (lo + hi);
        if (beat(mid) < bt) lo = mid; else hi = mid;
      }
      return 0.5 * (lo + hi);
    }
    const bpm = (T) => ((beat(T + 1e-3) - beat(T - 1e-3)) / 2e-3) * 60;
    // Bars restart at every anchor; leftover beats make one irregular bar (e.g. 5/4, 3/4).
    const bars = [];
    for (let k = 0; k + 1 < N; k++) {
      let n = A[k + 1].B - A[k].B, b0 = A[k].B, idx = 0;
      const lens = [];
      while (n > 7) { lens.push(4); n -= 4; }
      if (n === 7) lens.push(4, 3); else if (n > 0) lens.push(n);
      for (const len of lens) { bars.push({ b0, len, k, idx: idx++, t0: timeOf(b0) }); b0 += len; }
    }
    for (let i = 0; i < 24; i++) {
      const b0 = A[N - 1].B + 4 * i;
      bars.push({ b0, len: 4, k: N - 1, idx: i, t0: timeOf(b0) });
    }
    function barAt(bt) {
      if (bt < bars[0].b0) {
        const b0 = bars[0].b0 + 4 * Math.floor((bt - bars[0].b0) / 4);
        return { b0, len: 4, k: -1, idx: -1, t0: timeOf(b0) };
      }
      let lo = 0, hi = bars.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (bars[mid].b0 <= bt) lo = mid; else hi = mid - 1; }
      return bars[lo];
    }
    const anchorIndex = (cue) => A.findIndex((a) => Math.abs(a.t - cue) < 1e-6);
    const barsFrom = (cue) => { const k = anchorIndex(cue); return bars.filter((b) => b.k === k); };
    const beatOfCue = (cue) => A[anchorIndex(cue)].B;
    return { A, bars, beat, timeOf, bpm, barAt, barsFrom, beatOfCue };
  })();

  // ================================================================ harmony (D minor -> D major)
  const CH = {};
  function defChord(name, bass, pad, arp) {
    CH[name] = { name, bass: midi(bass), pad: pad.map(midi), arp: arp.map(midi) };
  }
  defChord('Dm', 'D2', ['D3', 'A3', 'D4', 'F4'], ['D4', 'F4', 'A4', 'D5', 'E5', 'F5', 'A5']);
  defChord('Dm9', 'D2', ['D3', 'A3', 'E4', 'F4', 'A4'], ['D4', 'E4', 'A4', 'D5', 'E5', 'F5', 'A5']);
  defChord('Bb', 'Bb1', ['Bb2', 'F3', 'Bb3', 'D4'], ['D4', 'F4', 'Bb4', 'C5', 'D5', 'F5', 'Bb5']);
  defChord('Bb9', 'Bb1', ['Bb2', 'F3', 'C4', 'D4', 'F4'], ['D4', 'F4', 'Bb4', 'C5', 'D5', 'F5', 'A5']);
  defChord('F', 'F2', ['F3', 'C4', 'F4', 'A4'], ['C4', 'F4', 'A4', 'C5', 'F5', 'G5', 'A5']);
  defChord('F9', 'F2', ['F3', 'C4', 'G4', 'A4'], ['C4', 'F4', 'G4', 'A4', 'C5', 'F5', 'G5']);
  defChord('C', 'C2', ['C3', 'G3', 'C4', 'E4'], ['C4', 'E4', 'G4', 'C5', 'D5', 'E5', 'G5']);
  defChord('Gm', 'G1', ['G2', 'D3', 'G3', 'Bb3', 'D4'], ['D4', 'G4', 'A4', 'Bb4', 'D5', 'G5', 'Bb5']);
  defChord('Am', 'A1', ['A2', 'E3', 'A3', 'C4'], ['C4', 'E4', 'A4', 'B4', 'C5', 'E5', 'A5']);
  defChord('A', 'A1', ['A2', 'E3', 'A3', 'C#4', 'E4'], ['C#4', 'E4', 'A4', 'C#5', 'E5', 'A5', 'C#6']);
  defChord('G', 'G1', ['G2', 'D3', 'G3', 'B3', 'D4'], ['D4', 'G4', 'A4', 'B4', 'D5', 'G5', 'B5']);
  defChord('D', 'D2', ['D3', 'A3', 'D4', 'F#4', 'A4'], ['D4', 'F#4', 'A4', 'D5', 'E5', 'F#5', 'A5']);
  defChord('Dx', 'D2', ['D3', 'A3', 'Eb4'], ['D4', 'Eb4', 'A4', 'D5', 'Eb5', 'A5', 'D6']); // post-impact
  defChord('Ice', 'D3', ['D5', 'E5', 'A5', 'D6'], ['D5', 'E5', 'A5', 'D6', 'E6', 'A6', 'D7']); // snowball

  function voicing(layer, ch) {
    if (layer === 'str') return ch.pad;
    if (layer === 'org') return [ch.bass + 12].concat(ch.pad.filter((n) => n !== ch.bass + 12));
    if (layer === 'cho') return Array.from(new Set(ch.pad.map((n) => (n < 57 ? n + 12 : n)))).sort((a, b) => a - b);
    if (layer === 'sub') return [mtof(ch.bass - 12) >= 32 ? ch.bass - 12 : ch.bass];
    return ch.pad;
  }

  // Harmony timeline: chord changes on bar lines of the cue-anchored tempo map.
  const HARM = [];
  function at(t, name) { HARM.push({ t, name }); }
  function prog(cue, names) {
    const bars = Tempo.barsFrom(cue);
    names.forEach((n, i) => { if (bars[i]) HARM.push({ t: bars[i].t0, name: n }); });
  }
  at(C.firstStar, 'Dm9');
  at(C.firstSupernova, 'Bb9');
  at(45.0, 'Dm');
  prog(C.webReveal, ['Bb9']);
  prog(C.galaxyMerger, ['F', 'C', 'Dm', 'Bb']);
  prog(C.solarSupernova, ['Dm', 'Bb', 'C']);
  prog(C.sunIgnition, ['F9', 'C', 'Bb']);
  prog(C.earthFormed, ['Dm', 'Bb', 'C', 'A']);
  at(C.theiaImpact, 'Dx');
  prog(C.moonFormed, ['Bb9', 'F', 'Dm9']);
  prog(C.oceans, ['F9', 'C']);
  prog(C.life, ['Dm9', 'Bb9']);
  prog(C.oxygenation, ['F', 'C']);
  prog(C.rodinia, ['Gm']);
  at(C.snowball, 'Ice');
  prog(C.thaw, ['Bb', 'F', 'C', 'Dm', 'C']);
  prog(C.pangaea, ['Dm', 'Am', 'C']);
  prog(C.breakup, ['G', 'Dm', 'Am', 'C']);
  prog(C.dinosaursEnd, ['Dm', 'F', 'Gm', 'Bb', 'C']);
  at(C.today, 'D');
  HARM.sort((a, b) => a.t - b.t);
  function chordAt(T) {
    let lo = 0, hi = HARM.length - 1;
    if (T < HARM[0].t) return CH[HARM[0].name];
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (HARM[mid].t <= T + 1e-6) lo = mid; else hi = mid - 1; }
    return CH[HARM[lo].name];
  }

  // ================================================================ mix curves (film time -> level)
  const MIX = {
    str: linKeys([[34.9, 0], [35, 0.05], [40.5, 0.06], [45, 0.045], [49, 0.055], [54.5, 0.065], [60, 0.08],
      [70, 0.09], [80, 0.1], [93, 0.11], [98.8, 0.13], [99, 0.07], [105, 0.05], [115, 0.065], [127, 0.07],
      [133, 0.075], [133.3, 0.022], [137, 0.075], [150, 0.09], [165, 0.11], [173.5, 0.15], [174, 0.16], [178, 0.12], [188.6, 0]]),
    org: linKeys([[48.9, 0], [49, 0.03], [60, 0.05], [70, 0.06], [79.9, 0.045], [80, 0.07], [89, 0.05],
      [98.8, 0.05], [99, 0], [99.8, 0], [101.5, 0.045], [103.5, 0.06], [104.6, 0.04], [104.9, 0.032], [105, 0.035], [115, 0.025], [133, 0.02], [133.3, 0], [137, 0.025],
      [150, 0.045], [165, 0.055], [174, 0.11], [180, 0.08], [188.6, 0]]),
    cho: linKeys([[79.9, 0], [80, 0.05], [89, 0.025], [98.8, 0.03], [99, 0], [99.8, 0], [101.5, 0.045], [103.5, 0.06], [104.4, 0.04], [104.6, 0.032],
      [105.3, 0], [114.9, 0], [115, 0.035],
      [133, 0.03], [133.3, 0], [137, 0.015], [156, 0.03], [174, 0.075], [180, 0.05], [188.6, 0]]),
    sub: linKeys([[44.9, 0], [45, 0.068], [60, 0.09], [98.8, 0.112], [99, 0], [104.9, 0], [105, 0.056], [133, 0.068],
      [133.3, 0], [136.9, 0], [137, 0.1], [173.8, 0.12], [174, 0.11], [182, 0.08], [188.6, 0]]),
    ost: linKeys([[44.9, 0], [45, 0.035], [49, 0.05], [54.5, 0.06], [60, 0.075], [70, 0.085], [80, 0.095],
      [89, 0.1], [98.8, 0.12], [98.81, 0], [109, 0], [111, 0.03], [115, 0.045], [122, 0.05], [133, 0.055],
      [133.01, 0], [136.99, 0], [137, 0.06], [150, 0.075], [165, 0.095], [172, 0.12], [174, 0.13], [175, 0.07], [180, 0]]),
    ostCut: expKeys([[45, 600], [49, 1000], [60, 1600], [70, 1900], [80, 2500], [98.8, 3600], [109, 600],
      [122, 1300], [133, 1700], [137, 1400], [150, 2300], [165, 3100], [174, 4200], [180, 700]]),
    strCut: expKeys([[35, 900], [60, 1400], [80, 2200], [99, 2600], [105, 1000], [115, 1500], [133, 2000],
      [137, 1500], [165, 2600], [174, 3800], [185, 1100], [190, 800]]),
    bass: linKeys([[69.9, 0], [70, 0.07], [98.8, 0.09], [98.81, 0], [136.99, 0], [137, 0.08], [174, 0.1], [174.01, 0]]),
  };
  const ATT = linKeys([[30, 1.0], [60, 0.6], [99, 0.4], [137, 0.15], [174, 0.1]]);
  const REL = linKeys([[30, 2.0], [99, 1.0], [137, 0.35], [174, 0.3]]);

  // ================================================================ globals (bus-level automation)
  // master gain keys: breaths of silence right before the Big Bang and Theia, final fade
  const MASTER_KEYS = [[0, 1], [4.70, 1], [4.72, 0], [4.998, 0], [5.0, 1], [98.80, 1], [98.84, 0], [98.998, 0],
    [99.0, 1], [173.80, 1], [173.82, 0], [173.998, 0], [174.0, 1], [184, 1], [186, 0.8], [188, 0.35], [189.4, 0]];
  const G_MASTER = linKeys(MASTER_KEYS);
  const G_WIDTH = (T) => (T < C.bang ? 0 : T < 8.4 ? 0.88 * M.smootherstep(C.bang, 8.4, T) : 0.88 + 0.12 * sst(8.4, 25, T));
  const G_REV = linKeys([[0, 0.3], [4.99, 0.3], [5.0, 0.85], [25, 1.15], [99, 1.15], [110, 1.0], [190, 1.0]]);
  const G_LP = expKeys([[0, 20000], [99.3, 20000], [99.8, 2200], [103.5, 20000], [133, 20000], [133.6, 2600],
    [136.3, 2600], [137, 20000], [190, 20000]]);
  const G_DLY = (T) => clamp((0.75 * 60) / Tempo.bpm(clamp(T, 25, 190)), 0.22, 1.2);
  // "sidechain" duck of the beds (pads, drones, noise beds, ostinato) at the big hits: the beds dip
  // in 20 ms on the cue, hold 120 ms and recover over ~0.5 s, so the transient stands clear
  const DUCKS = [[C.galaxyMerger, 0.4], [C.solarSupernova, 0.5], [C.sunIgnition, 0.4], [C.earthFormed, 0.35],
    [C.theiaImpact, 0.5], [C.rodinia, 0.35], [C.thaw, 0.45], [C.pangaea, 0.4], [C.breakup, 0.4],
    [C.dinosaursEnd, 0.5], [C.today, 0.45]];
  function G_DUCK(T) {
    let g = 1;
    for (const [c, d] of DUCKS) {
      const x = T - c;
      if (x < -0.02 || x > 0.62) continue;
      g *= 1 - d * (x < 0 ? (x + 0.02) / 0.02 : x < 0.12 ? 1 : 1 - sst(0.12, 0.62, x));
    }
    return g;
  }
  // voice types that form the beds (ducked); hits and drums are not
  const BED = new Set(['pad', 'drone', 'noise', 'shepard', 'pluck', 'bassnote', 'tone']);

  // ================================================================ composition: static events
  const EVENTS = [];
  function add(o) { o.seed = o.seed !== undefined ? o.seed : EVENTS.length * 7 + 3; EVENTS.push(o); return o; }
  const bt = (cue, beats) => Tempo.timeOf(Tempo.beatOfCue(cue) + beats);

  // --- compound helpers
  function swell(tEnd, len, amp, o) { // reverse-cymbal swell ending exactly on a cue
    add(Object.assign({ type: 'swell', t: tEnd - len, dur: len, amp, f0: 900, f1: 8000, pw: 3 }, o || {}));
  }
  function crash(t, amp, dur, hold) { add({ type: 'crash', t, dur: dur || 4.5, amp, hold }); }
  function boom(t, amp, f0, f1, sweep, dur, drive) {
    add({ type: 'boom', t, dur: dur || 5, amp, f0, f1, sweep: sweep || 1.5, drive: drive || 2 });
  }
  function blast(t, amp, f0, f1, sweep, dur, buf) {
    add({ type: 'blast', t, dur: dur || 4, amp, f0, f1, sweep: sweep || 2.5, buf: buf || 'white' });
  }
  function taikoHit(t, amp) {
    add({ type: 'taiko', t, dur: 1.6, amp, f: 58, pan: -0.15, body: 0.35 });
    add({ type: 'taiko', t: t + 0.012, dur: 1.6, amp: amp * 0.8, f: 52, pan: 0.2, body: 0.35 });
  }
  // the mid/high layer of a boom-led hit, so it also lands on laptop and phone speakers: a saturated
  // pitch-dropping body (≈250 -> 95 Hz, harmonics up to ~2.5 kHz), a noise snap and a crack
  function impact(t, amp, o) {
    o = o || {};
    add({ type: 'knock', t, dur: o.dur || 1.4, amp, f0: o.f0 || 250, f1: o.f1 || 95, snapF: o.snapF || 1700, pan: o.pan || 0 });
    if (o.crack !== 0) add({ type: 'crack', t, dur: 0.22, amp: amp * (o.crack || 0.55) });
  }

  // ---------------------------------------------------- 0 – 5  the void, the spark, the inhale
  const CUT = 4.71; // breath of silence 4.71 – 5.0 (master gain dips to 0)
  add({ type: 'tone', t: C.spark, dur: CUT - C.spark + 0.05, f: hz('A6'), att: 0.035,
    lvl: (T) => 0.0075 * Math.pow(2, (T - C.spark) / 1.25), vib: (T) => 3 + 14 * sst(2.5, CUT, T) });
  add({ type: 'bell', t: C.spark, dur: 2.5, f: hz('A7'), ratio: 2, index: 1.5, amp: 0.006, pan: 0, rev: 0.5 });
  add({ type: 'drone', t: C.spark, dur: CUT - C.spark + 0.05, wave: 'sine', notes: [midi('D1')], det: 0,
    gain: (T) => 0.09 * Math.pow(sst(C.spark, CUT, T), 1.6), harm2: 0.25 });
  add({ type: 'swell', t: 2.3, dur: CUT - 2.3, amp: 0.04, f0: 220, f1: 5200, pw: 3.2, filt: 'bandpass', q: 1.6 });
  add({ type: 'drone', t: 2.7, dur: CUT - 2.7 + 0.02, wave: 'sawtooth', notes: ['D2', 'A2', 'D3', 'A3'].map(midi), det: 9,
    cents: (T) => 120 * sst(2.7, CUT, T), cut: expKeys([[2.7, 140], [CUT, 3200]]), q: 1.2,
    gain: (T) => 0.045 * Math.pow(sst(2.7, CUT, T), 2.4) });

  // ---------------------------------------------------- 5.0  the Big Bang
  add({ type: 'crack', t: C.bang, dur: 0.2, amp: 0.55 });
  boom(C.bang, 0.64, 130, 27, 3.2, 7.5, 3.0);
  blast(C.bang, 0.42, 16000, 170, 4.2, 6.5, 'white');
  add({ type: 'brass', t: C.bang, dur: 5.5, notes: ['D1', 'A1', 'D2', 'A2', 'D3'].map(midi), amp: 0.2, open: 2600, rev: 0.55 });
  crash(C.bang, 0.12, 6);
  // inflation 5 – 8: rushing rising-then-falling sweep + runaway Shepard rise; stereo field inflates
  add({ type: 'noise', t: C.bang, dur: 4.6, buf: 'pink', filt: 'bandpass', q: 1.1, rev: 0.4,
    freq: expKeys([[5.0, 400], [6.5, 7200], [8.0, 900], [9.6, 380]]),
    gain: linKeys([[5.0, 0], [5.4, 0.12], [6.4, 0.3], [8.0, 0.14], [9.6, 0]]) });
  add({ type: 'shepard', t: 5.15, dur: 3.4, f0: 45, n: 7, rate: 1.7, acc: -0.15, rev: 0.4,
    gain: linKeys([[5.15, 0], [5.6, 0.05], [7.6, 0.05], [8.55, 0]]) });

  // ---------------------------------------------------- 8 – 25  the fireball: roaring drone that cools
  // It breathes: three slow surges (louder, brighter; the middle one carries the 15-17 hand-off into
  // the plasma) and a pulse - the sound waves ringing in the primordial plasma - that slows down as
  // space stretches, until it locks onto the 40 bpm grid of the heartbeat that begins after
  // recombination (pulses at 22.0 and 23.5 lie on that grid, the 25.0 hit is the next one).
  const ROAR_CENTS = linKeys([[5.4, 700], [8.0, 0], [16, -140], [25, -300]]); // F cluster cools to D
  const bump = (T, a, m, b) => (T <= a || T >= b ? 0 : T < m ? sst(a, m, T) : 1 - sst(m, b, T));
  const SURGE = (T) => bump(T, 9.2, 11.8, 14.4) + bump(T, 14.6, 16.6, 18.8) + 0.9 * bump(T, 19.2, 21.4, 23.6);
  const PULSES = (() => {
    const p = [];
    for (let t = C.recombination - 1.5; t > 9.4;) { p.push(t); t -= 0.62 + 0.88 * sst(10, 21.5, t - 0.75); }
    return p.reverse();
  })();
  const PULSE = (T) => {
    let s = 0;
    for (const p of PULSES) {
      const x = T - p;
      if (x > -0.3 && x < 1.4) s += x < 0 ? Math.exp(-(x / 0.1) * (x / 0.1)) : Math.exp(-x / 0.34);
    }
    return Math.min(1.25, s) * sst(9.2, 12.5, T);
  };
  add({ type: 'drone', t: 5.4, dur: 20.0, wave: 'sawtooth', notes: ['F2', 'C3', 'F3', 'G3', 'C4', 'F4'].map(midi), det: 13,
    cents: ROAR_CENTS, q: 1.6, rev: 0.35, trim: 7,
    cut: (T) => 1.3 * kf([[5.4, 600], [6.6, 6000], [8, 4200], [12, 2700], [18, 1500], [22.5, 950], [24.9, 2800], [25.0, 2800], [25.05, 700]], T) *
      (1 + 0.28 * wander(T * 0.8, 1)) * (1 + 0.55 * SURGE(T) + 0.35 * PULSE(T)),
    gain: (T) => kf([[5.4, 0], [6.6, 0.05], [8, 0.11], [12, 0.1], [20, 0.085], [23, 0.07], [24.97, 0.11], [25.03, 0]], T) *
      (1 + 0.16 * wander(T * 2.3, 2)) * (1 + 0.5 * SURGE(T)) * (1 - 0.22 * sst(9.2, 12.5, T) + 0.42 * PULSE(T)) });
  add({ type: 'drone', t: 6.0, dur: 19.2, wave: 'sine', notes: [midi('F1')], det: 0, cents: ROAR_CENTS, harm2: 0.45,
    gain: (T) => kf([[6, 0], [8, 0.085], [18, 0.065], [24.9, 0.075], [25.05, 0]], T) * (1 - 0.12 * sst(9.2, 12.5, T) + 0.3 * PULSE(T)) });
  add({ type: 'noise', t: C.bang, dur: 20.3, buf: 'brown', filt: 'lowpass', q: 0.8, rev: 0.25, trim: -6,
    freq: (T) => 150 + 50 * wander(T * 0.9, 3) + 120 * SURGE(T),
    gain: (T) => kf([[5, 0], [5.05, 0.42], [8, 0.3], [20, 0.22], [24.8, 0.28], [25.25, 0]], T) * (1 + 0.3 * wander(T * 1.7, 4)) * (1 + 0.35 * SURGE(T)) });
  add({ type: 'noise', t: 8, dur: 17.2, buf: 'pink', filt: 'bandpass', q: 1.4, rev: 0.4,
    freq: (T) => 750 * Math.pow(2, 0.9 * wander(T * 0.55, 5) + 0.6 * SURGE(T)),
    gain: (T) => kf([[8, 0], [10, 0.05], [24.8, 0.04], [25.15, 0]], T) * (0.55 + 0.25 * Math.sin(T * 5.1 + 2 * wander(T, 6)) + 0.45 * PULSE(T)) * (1 + 0.4 * SURGE(T)) });
  swell(C.recombination, 1.9, 0.07);

  // ---------------------------------------------------- 25  recombination: first light, glassy open chord
  add({ type: 'bell', t: C.recombination, dur: 6, f: hz('D6'), ratio: 2, index: 2.0, amp: 0.12, pan: -0.2, rev: 0.7, dly: 0.2 });
  boom(C.recombination, 0.3, 60, 36.7, 1.0, 4, 1.4);
  add({ type: 'shimmer', t: C.recombination, dur: 4, notes: ['D6', 'A6', 'E7', 'A7'].map(midi), amp: 0.04, rev: 0.7 });
  add({ type: 'bell', t: C.recombination + 0.01, dur: 5, f: hz('A5'), ratio: 3, index: 1.0, amp: 0.07, pan: 0.25, rev: 0.7 });
  add({ type: 'pad', tim: 'glass', t: C.recombination - 0.05, dur: 14, notes: ['D4', 'A4', 'E5', 'A5', 'D6'].map(midi),
    att: 0.35, rel: 3, lvl: linKeys([[25, 0.075], [28, 0.055], [33, 0.035], [36, 0.02], [39, 0]]), rev: 0.6 });
  add({ type: 'tone', t: C.recombination, dur: 9, f: hz('A6'), att: 0.4, lvl: linKeys([[25, 0.004], [30, 0.002], [34, 0]]), vib: () => 4 });
  // 25 – 35 dark ages: cold, sparse, wide; a distant gravitational sub
  add({ type: 'drone', t: 25.3, dur: 21.2, wave: 'sine', notes: [midi('D1')], det: 0, harm2: 0.4,
    gain: linKeys([[25.3, 0], [28, 0.05], [35, 0.06], [44.5, 0.07], [46.5, 0]]) });
  add({ type: 'pad', tim: 'str', t: 26.5, dur: 10.5, notes: ['D2', 'A2', 'E3'].map(midi), att: 3, rel: 3, cut: 620,
    lvl: () => 0.045, rev: 0.5 });
  add({ type: 'noise', t: 25.4, dur: 22, buf: 'pink', filt: 'bandpass', q: 2.2, rev: 0.5,
    freq: (T) => 1500 * Math.pow(2, 0.6 * wander(T * 0.3, 7)),
    gain: (T) => kf([[25.4, 0], [28, 0.021], [44, 0.025], [47.4, 0]], T) * (1 + 0.5 * wander(T * 0.5, 8)),
    pan: (T) => 0.7 * Math.sin(T * 0.21) });
  add({ type: 'bell', t: 29.3, dur: 5, f: hz('E6'), ratio: 2, index: 0.8, amp: 0.012, pan: 0.6, rev: 0.85, dly: 0.3 });
  add({ type: 'bell', t: 32.2, dur: 5, f: hz('A5'), ratio: 2, index: 0.8, amp: 0.011, pan: -0.55, rev: 0.85, dly: 0.3 });

  // ---------------------------------------------------- 35  the first star
  swell(C.firstStar, 1.5, 0.045, { f0: 1500, f1: 9000 });
  add({ type: 'pad', tim: 'glass', t: 33.4, dur: C.firstStar - 33.4 + 0.04, notes: ['A5', 'D6', 'E6'].map(midi),
    env: [[0, 0], [1.4, 0.6, 'e'], [C.firstStar - 33.4, 1], [C.firstStar - 33.4 + 0.04, 0]], lvl: () => 0.04, rev: 0.6 });
  add({ type: 'bell', t: C.firstStar, dur: 7, f: hz('A5'), ratio: 1.4, index: 5, amp: 0.085, pan: -0.1, rev: 0.65, dly: 0.2 });
  add({ type: 'bell', t: C.firstStar, dur: 5.5, f: hz('D6'), ratio: 2, index: 2.5, amp: 0.065, pan: 0.2, rev: 0.6, dly: 0.2 });
  add({ type: 'bell', t: C.firstStar + 0.005, dur: 3.5, f: hz('A6'), ratio: 2, index: 1, amp: 0.035, pan: 0.45, rev: 0.6 });
  boom(C.firstStar, 0.22, 70, 36, 1.2, 3.5, 1.5);

  // ---------------------------------------------------- 40.5  the first supernova
  swell(C.firstSupernova, 1.25, 0.06);
  boom(C.firstSupernova, 0.7, 95, 30, 1.6, 5.5, 2.2);
  blast(C.firstSupernova, 0.2, 9000, 240, 2.6, 4.5, 'pink');
  add({ type: 'shimmer', t: C.firstSupernova, dur: 5.5, notes: ['D6', 'E6', 'A6', 'D7', 'E7', 'A7'].map(midi), amp: 0.05, rev: 0.7 });
  add({ type: 'bell', t: C.firstSupernova, dur: 6, f: hz('D5'), ratio: 1.4, index: 4, amp: 0.05, pan: 0, rev: 0.7 });

  // ---------------------------------------------------- 45 – 62  cosmic web
  swell(C.webReveal, 1.4, 0.04);
  boom(C.webReveal, 0.35, 70, 34, 1.2, 4, 1.6);
  crash(C.webReveal, 0.045, 5);
  swell(C.galaxyMerger, 1.3, 0.06);
  boom(C.galaxyMerger, 0.4, 90, 32, 1.4, 4.5, 2);
  impact(C.galaxyMerger, 0.384);
  taikoHit(C.galaxyMerger, 0.45);
  crash(C.galaxyMerger, 0.182, 5);
  add({ type: 'brass', t: C.galaxyMerger, dur: 3.5, notes: ['F1', 'C2', 'F2', 'A2', 'C3'].map(midi), amp: 0.144, open: 3000, rev: 0.5 });

  // ---------------------------------------------------- 60 – 77  the Milky Way; 70 the solar supernova
  add({ type: 'shepard', t: 66, dur: 4, f0: 50, n: 7, rate: 0.55, acc: 0.25, rev: 0.4,
    gain: linKeys([[66, 0], [68, 0.035], [69.9, 0.06], [70, 0]]) });
  swell(C.solarSupernova, 2.2, 0.075);
  add({ type: 'crack', t: C.solarSupernova, dur: 0.2, amp: 0.35 });
  boom(C.solarSupernova, 0.6, 120, 29, 2.2, 6.5, 2.6);
  impact(C.solarSupernova, 0.48, { crack: 0 });
  blast(C.solarSupernova, 0.3, 14000, 220, 3, 5, 'white');
  add({ type: 'brass', t: C.solarSupernova, dur: 4.5, notes: ['D1', 'A1', 'D2', 'F2', 'A2'].map(midi), amp: 0.204, open: 3400, rev: 0.5 });
  taikoHit(C.solarSupernova, 0.55);
  crash(C.solarSupernova, 0.238, 6);
  add({ type: 'noise', t: C.solarSupernova + 0.15, dur: 3.6, buf: 'pink', filt: 'bandpass', q: 1.3, rev: 0.4, // shock front
    freq: expKeys([[70.15, 5000], [73.75, 300]]), gain: linKeys([[70.15, 0], [70.5, 0.16], [73.75, 0]]),
    pan: linKeys([[70.15, -0.8], [73.75, 0.8]]) });

  // ---------------------------------------------------- 75 – 95  the solar system; 80 the Sun ignites
  swell(C.sunIgnition, 1.6, 0.06);
  boom(C.sunIgnition, 0.44, 100, 43.6, 1.4, 5, 2.2);
  impact(C.sunIgnition, 0.384, { f0: 280, f1: 110 });
  crash(C.sunIgnition, 0.21, 6);
  add({ type: 'shimmer', t: C.sunIgnition, dur: 5, notes: ['F6', 'A6', 'C7', 'F7', 'G7'].map(midi), amp: 0.045, rev: 0.6 });
  add({ type: 'bell', t: C.sunIgnition, dur: 5, f: hz('F5'), ratio: 2, index: 2, amp: 0.05, pan: -0.3, rev: 0.6, dly: 0.25 });
  add({ type: 'bell', t: C.sunIgnition + 0.01, dur: 5, f: hz('C6'), ratio: 2, index: 1.5, amp: 0.04, pan: 0.3, rev: 0.6, dly: 0.25 });
  add({ type: 'brass', t: C.sunIgnition, dur: 4, notes: ['F1', 'C2', 'F2', 'A2', 'C3'].map(midi), amp: 0.132, open: 3400, rev: 0.5 });
  // 89 the Earth has formed: a warm, heavy landing (not a catastrophe) with a low brass chord
  boom(C.earthFormed, 0.32, 80, 36.7, 1.2, 4, 2);
  impact(C.earthFormed, 0.312, { f0: 220, f1: 90, crack: 0.5 });
  taikoHit(C.earthFormed, 0.45);
  crash(C.earthFormed, 0.3, 4.5);
  add({ type: 'brass', t: C.earthFormed, dur: 3.5, notes: ['D1', 'A1', 'D2', 'F2', 'A2'].map(midi), amp: 0.13, open: 3400, rev: 0.5 });
  add({ type: 'bell', t: C.earthFormed, dur: 5, f: hz('D5'), ratio: 2, index: 1.6, amp: 0.04, pan: -0.25, rev: 0.6, dly: 0.25 });
  add({ type: 'bell', t: C.earthFormed + 0.012, dur: 5, f: hz('A5'), ratio: 2, index: 1.2, amp: 0.032, pan: 0.3, rev: 0.6, dly: 0.25 });

  // ---------------------------------------------------- 93 – 110  Theia
  add({ type: 'shepard', t: 93, dur: 98.8 - 93, f0: 40, n: 8, rate: 0.35, acc: 0.12, rev: 0.4,
    gain: linKeys([[93, 0], [95, 0.035], [98.7, 0.075], [98.8, 0]]) });
  add({ type: 'drone', t: 93, dur: 5.85, wave: 'sawtooth', notes: ['D3', 'Eb3', 'A3', 'D4', 'Eb4'].map(midi), det: 14, // tremolo cluster
    cents: linKeys([[93, 0], [98.8, 180]]), cut: expKeys([[93, 500], [98.8, 5000]]), q: 1.5, trem: 11, rev: 0.4,
    gain: linKeys([[93, 0], [95, 0.025], [98.75, 0.07], [98.84, 0]]) });
  swell(98.84, 1.6, 0.085);
  add({ type: 'crack', t: C.theiaImpact, dur: 0.25, amp: 0.42 });
  boom(C.theiaImpact, 0.52, 150, 25, 3.5, 9, 3.4);
  boom(C.theiaImpact + 0.03, 0.15, 70, 32, 2.5, 6, 2.0);
  impact(C.theiaImpact, 0.46, { f0: 230, f1: 80, dur: 1.8, crack: 0 });
  blast(C.theiaImpact, 0.46, 18000, 160, 5, 7.5, 'white');
  add({ type: 'ring', t: C.theiaImpact, dur: 9, f: 196, amp: 0.085, rev: 0.6 });
  add({ type: 'brass', t: C.theiaImpact, dur: 6, notes: ['D1', 'A1', 'D2', 'F2', 'A2', 'Eb3'].map(midi), amp: 0.288, open: 3400, rev: 0.55 });
  taikoHit(C.theiaImpact, 0.7);
  crash(C.theiaImpact, 0.28, 7);
  // aftermath: rumble, debris rain, distant thuds; dissonant low drone resolving into the Moon chord
  add({ type: 'noise', t: 99.2, dur: 10, buf: 'brown', filt: 'lowpass', q: 0.8, rev: 0.3,
    freq: (T) => 130 + 40 * wander(T, 9), gain: (T) => kf([[99.2, 0], [99.5, 0.4], [103, 0.24], [109.2, 0]], T) * (1 + 0.3 * wander(T * 1.9, 10)) });
  add({ type: 'noise', t: 99.6, dur: 7.5, buf: 'crackle', filt: 'bandpass', q: 0.9, rev: 0.6,
    freq: expKeys([[99.6, 2600], [107.1, 900]]), gain: linKeys([[99.6, 0], [100.2, 0.12], [104, 0.06], [107.1, 0]]) });
  [[100.6, 0.22], [101.7, 0.16], [103.2, 0.12], [104.4, 0.08]].forEach(([t, a]) => boom(t, a, 75, 38, 0.9, 3, 1.6));
  add({ type: 'drone', t: 99.4, dur: 7.0, wave: 'sine', notes: [midi('D1')], det: 0, harm2: 0.45,
    gain: linKeys([[99.4, 0], [100.5, 0.08], [104.5, 0.07], [106.4, 0]]) });
  // the ears ring after the impact: a high A7 (the spark's overtone) that is not muffled - it is
  // routed after the master lowpass - beating slowly, fading as hearing comes back with the Moon
  add({ type: 'tone', t: 99.2, dur: 6.6, f: hz('A7'), att: 0.5, post: true, beat: 1.00025,
    lvl: linKeys([[99.2, 0.013], [100.2, 0.016], [102.5, 0.015], [104.6, 0.01], [105.8, 0]]), vib: () => 1 });

  // ---------------------------------------------------- 105  the Moon (callback to the spark)
  add({ type: 'tone', t: C.moonFormed, dur: 7, f: hz('A6'), att: 0.6, lvl: linKeys([[105, 0.012], [108, 0.008], [112, 0]]), vib: () => 4 });
  add({ type: 'bell', t: C.moonFormed, dur: 6, f: hz('D6'), ratio: 2, index: 1.6, amp: 0.065, pan: 0.35, rev: 0.7, dly: 0.25 });
  add({ type: 'bell', t: C.moonFormed + 0.012, dur: 5, f: hz('A5'), ratio: 2, index: 1.2, amp: 0.045, pan: -0.2, rev: 0.7, dly: 0.25 });
  boom(C.moonFormed, 0.2, 60, 34, 1, 3, 1.4);

  // ---------------------------------------------------- 108 – 137  early Earth
  add({ type: 'noise', t: 106.5, dur: 10, buf: 'brown', filt: 'lowpass', q: 0.9, rev: 0.3, // Hadean rumble
    freq: (T) => 120 + 40 * wander(T * 0.7, 11), gain: (T) => kf([[106.5, 0], [109, 0.3], [114, 0.3], [116.5, 0]], T) * (1 + 0.4 * wander(T * 0.9, 12)) });
  add({ type: 'noise', t: 107, dur: 9, buf: 'crackle', filt: 'bandpass', q: 1.2, rev: 0.5, freq: () => 1300,
    gain: (T) => kf([[107, 0], [109, 0.05], [114, 0.04], [116, 0]], T) });
  [[109.4, 0.2], [111.2, 0.16], [112.7, 0.22], [114.0, 0.14]].forEach(([t, a]) => boom(t, a, 70, 36, 0.9, 3, 1.6));
  // 115 oceans: rain and sea wash
  swell(C.oceans, 1.4, 0.05, { buf: 'pink', f0: 500, f1: 5000 });
  boom(C.oceans, 0.24, 60, 43.6, 1, 3, 1.4);
  crash(C.oceans, 0.14, 4.5);
  // the first water: a rolled harp/mallet chord (F add9) and a short choir swell that peaks on the cue
  ['F4', 'A4', 'C5', 'G5', 'A5'].forEach((n, i) => add({ type: 'mallet', t: C.oceans + i * 0.035, dur: 3.2, f: hz(n), amp: 0.05 - i * 0.003,
    pan: (i / 4 - 0.5) * 0.9, rev: 0.6, dly: 0.2 }));
  add({ type: 'pad', tim: 'cho', t: C.oceans - 1.2, dur: 3.6, notes: ['F4', 'A4', 'C5', 'F5'].map(midi), noDuck: true,
    env: [[0, 0], [1.2, 1], [1.6, 0.65], [3.6, 0]], lvl: () => 0.05, rev: 0.55 });
  add({ type: 'noise', t: C.oceans - 0.4, dur: 20.6, buf: 'pink', filt: 'lowpass', q: 0.6, rev: 0.35, // sea
    freq: (T) => 700 * Math.pow(2, 1.0 * Math.sin((T - 115) * 0.85) + 0.3 * wander(T, 13)),
    gain: (T) => kf([[114.6, 0], [116, 0.06], [131, 0.055], [133.05, 0.035], [135, 0]], T) * (0.62 + 0.38 * Math.sin((T - 115) * 0.85 - 0.6)),
    pan: (T) => 0.55 * Math.sin((T - 115) * 0.42) });
  add({ type: 'noise', t: C.oceans - 0.2, dur: 11, buf: 'white', filt: 'highpass', q: 0.5, rev: 0.3, freq: () => 4200, // rain
    gain: linKeys([[114.8, 0], [115.8, 0.028], [121, 0.022], [125.8, 0]]) });
  // 122 life: a gentle new motif (soft mallet)
  const MOTIF = [
    [C.life, [[0, 'A4', 1], [1, 'D5', 0.5], [1.5, 'E5', 0.5], [2, 'F5', 2], [4, 'E5', 1], [5, 'D5', 1], [6, 'A4', 1]]],
    [C.oxygenation, [[0, 'C5', 1], [1, 'F5', 0.5], [1.5, 'G5', 0.5], [2, 'A5', 2], [4, 'G5', 1], [5, 'E5', 1]]],
    [C.rodinia, [[0, 'D5', 1], [1, 'Bb4', 1], [2, 'A4', 1]]],
  ];
  for (const [cue, notes] of MOTIF) {
    for (const [b, n, len] of notes) {
      const t = bt(cue, b), t2 = bt(cue, b + len);
      add({ type: 'mallet', t, dur: Math.max(1.6, (t2 - t) * 2.2), f: hz(n), amp: 0.055, pan: (hash(midi(n), 5) - 0.5) * 0.6, rev: 0.55, dly: 0.3 });
    }
  }
  add({ type: 'bell', t: C.life, dur: 5, f: hz('A5'), ratio: 2, index: 1.2, amp: 0.03, pan: -0.3, rev: 0.6 });
  // 127 oxygenation: the sky brightens
  swell(C.oxygenation, 1.5, 0.045, { f0: 2000, f1: 10000 });
  add({ type: 'shimmer', t: C.oxygenation, dur: 4.5, notes: ['C6', 'F6', 'A6', 'C7', 'G7'].map(midi), amp: 0.05, rev: 0.6 });
  crash(C.oxygenation, 0.168, 4.5);
  [['C6', 0.04, -0.3], ['F6', 0.035, 0.3], ['A6', 0.03, 0]].forEach(([n, a, pan], i) => add({ type: 'bell', t: C.oxygenation + i * 0.012, dur: 4.5,
    f: hz(n), ratio: 2, index: 1.3, amp: a, pan, rev: 0.6, dly: 0.2 }));
  add({ type: 'pad', tim: 'cho', t: C.oxygenation - 1.2, dur: 3.8, notes: ['C5', 'F5', 'A5'].map(midi), noDuck: true,
    env: [[0, 0], [1.2, 1], [1.6, 0.65], [3.8, 0]], lvl: () => 0.05, rev: 0.55 });
  // 131 Rodinia
  boom(C.rodinia, 0.32, 70, 49, 1, 3, 1.6);
  impact(C.rodinia, 0.336, { f0: 240, f1: 98, crack: 0.35 });
  taikoHit(C.rodinia, 0.35);
  crash(C.rodinia, 0.17, 2.8); // short: the Snowball hit follows 2 s later
  // 133 Snowball Earth: everything freezes; glassy, filtered, sparse
  add({ type: 'shimmer', t: C.snowball, dur: 3.5, notes: ['E6', 'A6', 'B6', 'E7', 'A7'].map(midi), amp: 0.045, rev: 0.7 });
  add({ type: 'crack', t: C.snowball, dur: 0.2, amp: 0.36 });
  boom(C.snowball, 0.24, 60, 36.7, 1, 3, 1.4);
  impact(C.snowball, 0.24, { f0: 330, f1: 150, dur: 0.9, snapF: 3200, crack: 0 });
  crash(C.snowball, 0.15, 2.6); // the ice shatters (the 133.6 freeze muffles its tail)
  add({ type: 'pad', tim: 'glass', t: C.snowball, dur: 4.6, notes: ['D5', 'E5', 'A5', 'D6', 'E6'].map(midi), att: 0.25, rel: 1.2,
    lvl: linKeys([[133, 0.05], [136, 0.035], [137.6, 0.02]]), trem: 5.5, rev: 0.75 });
  add({ type: 'noise', t: C.snowball, dur: 4.3, buf: 'white', filt: 'bandpass', q: 6, rev: 0.6, // cold wind
    freq: (T) => 2600 * Math.pow(2, 0.4 * wander(T * 0.9, 14)), gain: (T) => kf([[133, 0], [133.5, 0.03], [136.5, 0.03], [137.3, 0]], T) * (1 + 0.5 * wander(T * 1.3, 15)),
    pan: (T) => 0.6 * Math.sin(T * 0.7) });
  add({ type: 'noise', t: C.snowball, dur: 4.1, buf: 'crackle', filt: 'highpass', q: 0.7, rev: 0.6, freq: () => 3500, // ice
    gain: linKeys([[133, 0.08], [134, 0.03], [137.1, 0]]) });
  // 137 thaw: release, momentum returns
  swell(C.thaw, 1.6, 0.07);
  add({ type: 'pad', tim: 'str', t: 135.4, dur: C.thaw - 135.4 + 0.05, notes: CH.Bb.pad, cut: 2400,
    env: [[0, 0], [C.thaw - 135.4, 1, 'e'], [C.thaw - 135.4 + 0.05, 0]], lvl: () => 0.06, rev: 0.4 });
  boom(C.thaw, 0.48, 100, 29, 1.5, 5, 2.4);
  impact(C.thaw, 0.432, { f0: 260, f1: 98 });
  blast(C.thaw, 0.14, 8000, 300, 1.5, 3, 'pink');
  crash(C.thaw, 0.21, 5);
  taikoHit(C.thaw, 0.5);

  // ---------------------------------------------------- 137 – 174  the relentless drive
  [[C.pangaea, 0.48], [C.breakup, 0.48]].forEach(([t, a]) => {
    swell(t, 1.2, 0.055);
    boom(t, a, 100, 36.7, 1.4, 4.5, 2.2);
    impact(t, 0.408, { f0: 260, f1: 110 });
    crash(t, 0.21, 5);
    taikoHit(t, 0.55);
  });
  add({ type: 'brass', t: C.pangaea, dur: 2.6, notes: ['D1', 'A1', 'D2', 'F2', 'A2'].map(midi), amp: 0.096, open: 3000, rev: 0.45 });
  add({ type: 'brass', t: C.breakup, dur: 3, notes: ['G1', 'D2', 'G2', 'B2', 'D3'].map(midi), amp: 0.132, open: 3200, rev: 0.45 });
  // 165 the end of the dinosaurs: an asteroid
  add({ type: 'noise', t: 164.1, dur: 0.9, buf: 'white', filt: 'bandpass', q: 1.5, rev: 0.3,
    freq: expKeys([[164.1, 600], [165, 7000]]), gain: linKeys([[164.1, 0], [164.95, 0.12], [165, 0]]) });
  add({ type: 'crack', t: C.dinosaursEnd, dur: 0.2, amp: 0.45 });
  boom(C.dinosaursEnd, 0.6, 120, 29, 2.0, 6, 2.6);
  impact(C.dinosaursEnd, 0.504, { f0: 240, f1: 85, dur: 1.6, crack: 0 });
  blast(C.dinosaursEnd, 0.3, 14000, 220, 2.6, 4.5, 'white');
  crash(C.dinosaursEnd, 0.252, 6);
  taikoHit(C.dinosaursEnd, 0.6);
  add({ type: 'brass', t: C.dinosaursEnd, dur: 3.2, notes: ['D1', 'A1', 'D2', 'F2', 'A2'].map(midi), amp: 0.168, open: 3400, rev: 0.45 });
  // final ascent into the present
  add({ type: 'shepard', t: 165.6, dur: C.today - 165.6, f0: 45, n: 8, rate: 0.32, acc: 0.07, rev: 0.4,
    gain: linKeys([[165.6, 0], [168, 0.03], [173.8, 0.07], [174, 0]]) });
  // the riser stops dead at 173.82 (the master breath 173.82-174 is the inhale before the present)
  swell(173.82, 2.4, 0.12, { f0: 600, f1: 9000 });
  // saw riser: its top end is not cut at 174, it rings on into the D major chord (already a D
  // octave cluster) and settles over 3.5 s, so the arrival is the brightest moment of the film
  add({ type: 'drone', t: 170.5, dur: 179 - 170.5, wave: 'sawtooth', notes: ['D3', 'A3', 'D4', 'A4'].map(midi), det: 12, noDuck: true,
    cut: expKeys([[170.5, 400], [173.8, 6000], [174, 7000], [176.5, 5200], [179, 2200]]), q: 1.2, rev: 0.4, cents: linKeys([[170.5, -200], [174, 0]]),
    gain: (T) => (T < C.today ? 0.1 * Math.pow(sst(170.5, C.today, T), 2) : 0.1 * (1 - sst(176.2, 178.9, T))) });

  // ---------------------------------------------------- 174  today: the huge resolved D major
  add({ type: 'crack', t: C.today, dur: 0.2, amp: 0.3 });
  boom(C.today, 0.6, 110, 36.7, 2.6, 8, 2.4);
  impact(C.today, 0.54, { f0: 290, f1: 147, dur: 1.6, crack: 0 });
  blast(C.today, 0.26, 12000, 300, 3, 5, 'pink');
  crash(C.today, 0.34, 7.5, 3.2);
  crash(C.today + 0.006, 0.168, 5);
  // a held cymbal wash: the top end of the arrival stays up for ~3.5 s instead of decaying with the hit
  add({ type: 'noise', t: C.today, dur: 5, buf: 'white', filt: 'bandpass', q: 0.6, rev: 0.5, noDuck: true,
    freq: expKeys([[174, 9000], [177, 7000], [179, 5000]]), gain: linKeys([[174, 0], [174.08, 0.07], [176.8, 0.062], [179, 0]]) });
  taikoHit(C.today, 0.65);
  add({ type: 'brass', t: C.today, dur: 9.5, notes: ['D2', 'A2', 'D3', 'F#3', 'A3'].map(midi), amp: 0.48, open: 5500, rev: 0.6, sustain: true, hold: 3.4 });
  // the full orchestra on the arrival: low strings, upper strings and choir D4-A5, bright and held for ~4 s
  add({ type: 'pad', tim: 'str', t: C.today, dur: 12, notes: ['D2', 'A2', 'D3', 'F#3', 'A3'].map(midi), att: 0.05, rel: 4, noDuck: true,
    cut: 2600, cutFn: expKeys([[174, 2600], [178, 1800], [186, 900]]), lvl: linKeys([[174, 0.15], [177, 0.14], [180, 0.07], [184, 0.025], [186, 0]]), rev: 0.45 });
  add({ type: 'pad', tim: 'str', t: C.today, dur: 14.6, notes: ['D4', 'F#4', 'A4', 'D5', 'F#5', 'A5'].map(midi), att: 0.08, rel: 4, noDuck: true,
    cut: 5200, cutFn: expKeys([[174, 5200], [178, 4200], [184, 1800], [188.6, 1200]]), lvl: linKeys([[174, 0.18], [177.2, 0.165], [180, 0.085], [184, 0.035], [188.6, 0]]), rev: 0.5 });
  add({ type: 'pad', tim: 'cho', t: C.today, dur: 14.6, notes: ['A4', 'D5', 'F#5', 'A5'].map(midi), att: 0.12, rel: 4, noDuck: true,
    lvl: linKeys([[174, 0.12], [177.4, 0.11], [181, 0.06], [188.6, 0]]), rev: 0.55 });
  add({ type: 'bell', t: C.today, dur: 7, f: hz('D6'), ratio: 2, index: 2, amp: 0.05, pan: -0.35, rev: 0.6, dly: 0.25 });
  add({ type: 'bell', t: C.today + 0.01, dur: 7, f: hz('F#6'), ratio: 2, index: 1.5, amp: 0.04, pan: 0.35, rev: 0.6, dly: 0.25 });
  add({ type: 'bell', t: C.today + 0.02, dur: 6, f: hz('A6'), ratio: 2, index: 1, amp: 0.035, pan: 0, rev: 0.6, dly: 0.25 });
  add({ type: 'shimmer', t: C.today, dur: 7, notes: ['D6', 'F#6', 'A6', 'D7', 'E7'].map(midi), amp: 0.075, rev: 0.7 });
  add({ type: 'pad', tim: 'glass', t: 176, dur: 12.6, notes: ['A4', 'D5', 'F#5', 'A5', 'D6'].map(midi), att: 3, rel: 5,
    lvl: linKeys([[176, 0.03], [182, 0.03], [188.6, 0]]), rev: 0.7 });
  add({ type: 'tone', t: 179.5, dur: 9, f: hz('A6'), att: 1.5, lvl: linKeys([[179.5, 0.006], [184, 0.005], [188.5, 0]]), vib: () => 4 }); // the spark, one last time

  // ---------------------------------------------------- chord pads from the harmony timeline
  for (let i = 0; i < HARM.length; i++) {
    const h = HARM[i], ch = CH[h.name];
    const tEnd = i + 1 < HARM.length ? HARM[i + 1].t : 188.8;
    const att = ATT(h.t), rel = h.name === 'D' ? 0.5 : REL(h.t);
    for (const layer of ['str', 'org', 'cho', 'sub']) {
      const fn = MIX[layer];
      let mx = 0;
      for (let k = 0; k <= 8; k++) mx = Math.max(mx, fn(h.t + ((tEnd - h.t) * k) / 8));
      if (mx < 1e-3) continue;
      const dur = tEnd - h.t + rel;
      add({ type: 'pad', tim: layer, t: h.t, dur, notes: voicing(layer, ch), att: layer === 'sub' ? Math.min(att, 0.3) : att, rel,
        lvl: fn, cutFn: layer === 'str' ? MIX.strCut : null, rev: layer === 'sub' ? 0.08 : 0.4, prio: 0, trim: h.name === 'D' && layer !== 'sub' ? 3 : 0 });
    }
  }
  EVENTS.sort((a, b) => a.t - b.t);
  const MAX_EVENT_DUR = EVENTS.reduce((m, e) => Math.max(m, e.dur), 0);

  // ================================================================ pattern layers (beat grid)
  const P8 = [0, 4, 2, 4, 1, 4, 2, 5];
  const P16 = [0, 2, 4, 2, 5, 2, 4, 2, 0, 2, 4, 2, 6, 4, 5, 3];
  const ACC16 = [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0]; // 3-3-2 / 3-3-2
  const inR = (t, a, b) => t >= a && t < b;
  const HB = linKeys([[26.5, 0], [29, 0.13], [35, 0.2], [45, 0.26], [49, 0.15], [50, 0]]);
  const HB2 = linKeys([[101, 0], [104, 0.1], [109, 0.16], [113.5, 0]]);
  const anchorsSet = [C.solarSupernova, C.sunIgnition, C.earthFormed, C.pangaea, C.breakup, C.dinosaursEnd];
  const fillBeats = anchorsSet.map((c) => Tempo.beatOfCue(c) - 1);
  const STARS = ['D5', 'F5', 'G5', 'A5', 'C6', 'D6', 'F6', 'G6', 'A6'].map(hz);

  function stepEvents(s, t, out) {
    const beatF = s / 4;
    const bar = Tempo.barAt(beatF);
    const rel = Math.round(s - bar.b0 * 4); // 16th index within the bar
    const sub = ((s % 4) + 4) % 4;
    const beatInBar = Math.floor(rel / 4);
    const lastBeatOfBar = beatInBar === bar.len - 1;
    const spb = 60 / Tempo.bpm(t); // seconds per beat
    const t16 = (k) => Tempo.timeOf((s + k) / 4);

    // heartbeat of gravity ("lub-dub")
    if (sub === 0) {
      const a = inR(t, 26.5, 50) ? HB(t) : inR(t, 101, 113.5) ? HB2(t) : 0;
      if (a > 0.003) {
        out.push({ type: 'thump', t, dur: 0.8, amp: a, f0: 66, f1: 38, prio: 1 });
        out.push({ type: 'thump', t: t16(1), dur: 0.7, amp: a * 0.55, f0: 60, f1: 36, prio: 1 });
      }
    }
    // stars igniting (35 – 47): crystalline pentatonic notes, density rising
    if (inR(t, 35.6, 47)) {
      const p = 0.12 + 0.4 * sst(35.6, 46, t);
      if (hash(s, 11) < p) {
        const f = STARS[Math.floor(hash(s, 12) * STARS.length)];
        out.push({ type: 'bell', t, dur: 2.6, f, ratio: 2, index: 1.2 + hash(s, 13), amp: 0.014 + 0.02 * hash(s, 14),
          pan: (hash(s, 15) - 0.5) * 1.6, rev: 0.7, dly: 0.25, prio: 1 });
      }
    }
    // ostinato
    const oL = MIX.ost(t);
    if (oL > 0.002) {
      const eighths = t < C.webReveal || inR(t, C.moonFormed, C.life);
      if (!eighths || (sub & 1) === 0) {
        const ch = chordAt(t + 0.02);
        const idx = eighths ? P8[(rel >> 1) % 8] : P16[rel % 16];
        const acc = eighths ? ((rel >> 1) % 4 === 0 ? 1 : 0) : ACC16[rel % 16];
        const f = mtof(ch.arp[idx]);
        const cut = MIX.ostCut(t) * (acc ? 1.45 : 1);
        const dur = clamp(spb * (eighths ? 1.4 : 0.85), 0.16, 0.7);
        const amp = oL * (acc ? 1 : 0.62) * (0.92 + 0.16 * hash(s, 21));
        out.push({ type: 'pluck', t, dur, f, amp, cut, env: 2.6, q: 3.2, pan: (rel & 1 ? 0.32 : -0.32), rev: 0.22, dly: 0.16, prio: 1 });
        if (acc && (t >= C.pangaea && t < C.today + 1)) {
          out.push({ type: 'pluck', t, dur: dur * 0.8, f: f * 2, amp: amp * 0.38, cut: cut * 1.4, env: 2, q: 2, pan: -0.5 * (rel & 1 ? 1 : -1), rev: 0.25, dly: 0.2, prio: 1 });
        }
      }
    }
    // pulse bass (8ths)
    const bL = MIX.bass(t);
    if (bL > 0.002 && (sub & 1) === 0) {
      const ch = chordAt(t + 0.02);
      const accent = sub === 0;
      out.push({ type: 'bassnote', t, dur: clamp(spb * 0.45, 0.12, 0.3), f: mtof(ch.bass), amp: bL * (accent ? 1 : 0.7), prio: 1 });
    }
    // low drums (taiko) on downbeats
    // (the low drums give way on the hit cues: the hit's own boom + taiko carry the downbeat, a
    // second sub transient would only stack the peak and pump the bus compressor)
    const onHit = sub === 0 && DUCKS.some((d) => Math.abs(t - d[0]) < 0.005);
    const taikoOn = inR(t, 60, 98.8) || inR(t, 115, 133) || inR(t, 137, 173.5);
    if (taikoOn && sub === 0 && !onHit) {
      const lvl = inR(t, 115, 133) ? 0.22 : kf([[60, 0.25], [75, 0.32], [98.8, 0.42], [137, 0.35], [174, 0.5]], t);
      if (beatInBar === 0) out.push({ type: 'taiko', t, dur: 1.4, amp: lvl, f: 56, pan: -0.1, prio: 1 });
      else if (beatInBar === 2 && (t >= 75 && t < 98.8 || t >= 143)) out.push({ type: 'taiko', t, dur: 1.2, amp: lvl * 0.7, f: 62, pan: 0.15, prio: 1 });
    }
    if (taikoOn && lastBeatOfBar && sub === 2 && t > 80) {
      out.push({ type: 'taiko', t, dur: 1.0, amp: 0.18, f: 66, pan: 0.25, prio: 1 });
    }
    // kick on every beat
    if (sub === 0 && !onHit && (inR(t, 84, 98.8) || inR(t, 141, 173.5))) {
      out.push({ type: 'kick', t, dur: 0.6, amp: t < 99 ? 0.32 : kf([[141, 0.3], [174, 0.45]], t), prio: 1 });
    }
    // clock ticks (time begins to matter)
    if (inR(t, 75, 98.8) || inR(t, 141, 173.5)) {
      const every = t < 80 ? 4 : t < 89 ? 2 : t < 141 ? 1 : t < 156 ? 2 : 1;
      if (rel % every === 0) {
        const a = (sub === 0 ? 1 : 0.6) * (t < 99 ? kf([[75, 0.05], [98.8, 0.08]], t) : kf([[141, 0.05], [174, 0.075]], t));
        out.push({ type: 'tick', t, dur: 0.08, amp: a, pan: sub === 0 ? 0.25 : -0.25, prio: 1 });
      }
    }
    // shaker / hats (16ths) in the final drive
    if (inR(t, 150, 173.5) || inR(t, 89, 98.8)) {
      const a = (sub === 2 ? 1 : 0.45) * (t < 99 ? 0.03 : kf([[150, 0.035], [174, 0.06]], t));
      out.push({ type: 'hat', t, dur: sub === 2 ? 0.12 : 0.06, amp: a, pan: 0.35, prio: 1 });
    }
    // snare: tension roll before Theia; backbeat and final roll in the drive
    if (inR(t, 93, 98.8)) {
      const dens = t < 95.5 ? 2 : t < 97.5 ? 1 : 0.5; // in 16ths
      const a = 0.04 + 0.16 * sst(93, 98.8, t);
      if (dens >= 1 ? rel % dens === 0 : true) {
        out.push({ type: 'snare', t, dur: 0.2, amp: a, prio: 1 });
        if (dens < 1) { const t2 = Tempo.timeOf((s + 0.5) / 4); if (t2 < 98.8) out.push({ type: 'snare', t: t2, dur: 0.2, amp: a * 0.9, prio: 1 }); }
      }
    }
    if (inR(t, 156, 171.5) && sub === 0 && (beatInBar === 1 || beatInBar === 3)) {
      out.push({ type: 'snare', t, dur: 0.3, amp: kf([[156, 0.12], [171.5, 0.18]], t), prio: 1 });
    }
    if (inR(t, 171.5, 173.8)) { // the roll runs into the breath (173.82)
      const a = 0.05 + 0.17 * sst(171.5, 173.6, t);
      out.push({ type: 'snare', t, dur: 0.2, amp: a, prio: 1 });
      const t2 = Tempo.timeOf((s + 0.5) / 4);
      if (t2 < 173.8) out.push({ type: 'snare', t: t2, dur: 0.2, amp: a * 0.85, prio: 1 });
    }
    // tom fills on the last beat before big cues
    for (const fb of fillBeats) {
      if (s >= fb * 4 && s < fb * 4 + 4) {
        const k = s - fb * 4;
        out.push({ type: 'tom', t, dur: 0.5, amp: 0.2 + 0.05 * k, f: [180, 150, 125, 100][k], pan: [0.4, 0.15, -0.15, -0.4][k], prio: 1 });
      }
    }
  }

  // the pulse layers push harder through the two long builds (to Theia, and to the present)
  const DRIVE = linKeys([[60, 0.85], [80, 0.95], [98.8, 1.15], [99, 1], [137, 0.85], [150, 0.95], [160, 1.05], [170, 1.25], [174, 1.35], [175, 1]]);
  function patternEvents(a, b, out) {
    if (b <= 26 || a >= 181) return out;
    a = Math.max(a, 26); b = Math.min(b, 181);
    let s = Math.ceil(Tempo.beat(a) * 4 - 1e-7);
    for (let guard = 0; guard < 20000; guard++, s++) {
      const t = Tempo.timeOf(s / 4);
      if (t >= b) break;
      if (t < a) continue;
      const n0 = out.length;
      stepEvents(s, t, out);
      const d = DRIVE(t);
      for (let i = n0; i < out.length; i++) out[i].amp *= d;
    }
    return out;
  }

  // ================================================================ envelopes & automation
  function envVal(pts, t) {
    if (t <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      const b = pts[i];
      if (t < b[0]) {
        const a = pts[i - 1];
        const u = (t - a[0]) / (b[0] - a[0]);
        if (b[2] === 'e' && a[1] > 0 && b[1] > 0) return a[1] * Math.pow(b[1] / a[1], u);
        return a[1] + (b[1] - a[1]) * u;
      }
    }
    return pts[pts.length - 1][1];
  }
  // Envelope points [[t, v, 'e'?], ...] in local seconds; starts at local time `off`.
  function applyEnv(param, when, off, pts) {
    let prev = envVal(pts, off);
    param.setValueAtTime(prev, when);
    for (const p of pts) {
      if (p[0] <= off + 1e-6) continue;
      const tt = when + (p[0] - off);
      if (p[2] === 'e' && p[1] > 0 && prev > 0) param.exponentialRampToValueAtTime(p[1], tt);
      else param.linearRampToValueAtTime(p[1], tt);
      prev = p[1];
    }
  }
  // Sample fn(localTime) from `off` to `dur` as a value curve.
  function applyCurve(param, when, off, dur, fn, rate) {
    const len = dur - off;
    if (len < 0.03) { param.setValueAtTime(fn(off), when); return; }
    const n = Math.max(2, Math.ceil(len * (rate || 30)) + 1);
    const arr = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const v = fn(off + (len * i) / (n - 1));
      arr[i] = Number.isFinite(v) ? v : 0;
    }
    param.setValueCurveAtTime(arr, when, len);
  }

  // ================================================================ the score graph
  function makeRng(seed) { return M.rng(seed); }

  // ---------------------------------------------------------------- sample data
  // The noise loops and the reverb impulse response (~45 ms of CPU on a laptop, 4x that on a phone)
  // need no AudioContext: they are generated as plain sample arrays in short slices, during the idle
  // title before the first tap (for the most likely output rate) or right after it, so the tap only
  // creates the context. Generators yield every SLAB samples.
  const SLAB = 16384;
  const NOISE_SPEC = (lite) => [['white', lite ? 2.5 : 3.5, 11], ['pink', lite ? 4 : 6, 12], ['brown', lite ? 5 : 8, 13], ['crackle', lite ? 4 : 6, 14]];
  const IR_SPEC = (lite) => [lite ? 4.5 : 6.5, 5.2]; // seconds, RT60
  const HAS_AB = (() => { try { return new AudioBuffer({ length: 1, numberOfChannels: 1, sampleRate: 44100 }).length === 1; } catch (_) { return false; } })();

  // 2-channel sample storage: a context-free AudioBuffer where supported (no copy later), else arrays
  function newStore(n, sr) {
    if (HAS_AB) { const b = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: sr }); return { b, ch: [b.getChannelData(0), b.getChannelData(1)] }; }
    return { b: null, ch: [new Float32Array(n), new Float32Array(n)] };
  }
  function storeBuffer(ctx, st) {
    if (!st.b) { st.b = ctx.createBuffer(2, st.ch[0].length, ctx.sampleRate); st.ch.forEach((d, i) => st.b.getChannelData(i).set(d)); }
    st.ch = null;
    return st.b;
  }

  function* genNoise(n, kind, seed, st) {
    const W = Math.min(4096, n >> 2);
    for (let ch = 0; ch < 2; ch++) {
      const r = makeRng(seed * 977 + ch * 131);
      const raw = new Float32Array(n + W);
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, br = 0, cr = 0;
      for (let i = 0; i < n + W; i++) {
        if ((i & (SLAB - 1)) === SLAB - 1) yield;
        const w = r() * 2 - 1;
        let v;
        if (kind === 'white') v = w * 0.6;
        else if (kind === 'pink') {
          b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
          b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
          v = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
        } else if (kind === 'brown') {
          br = (br + w * 0.02) * 0.997; v = br * 3.2;
        } else { // crackle: sparse decaying clicks of random size
          if (r() < 0.0011) cr = (r() * 2 - 1) * (0.3 + 0.7 * Math.pow(r(), 2));
          cr *= 0.93; v = cr + w * 0.004;
        }
        raw[i] = v;
      }
      yield;
      const d = st.ch[ch];
      let mean = 0;
      for (let i = 0; i < n; i++) mean += raw[i];
      mean /= n;
      for (let i = 0; i < n; i++) d[i] = raw[i] - mean;
      for (let i = 0; i < W; i++) { const u = i / W; d[i] = (raw[i] - mean) * u + (raw[n + i] - mean) * (1 - u); } // seamless loop
      yield;
    }
  }

  function* genIR(sr, secs, rt60, st) {
    const n = st.ch[0].length, pre = 0.022;
    for (let ch = 0; ch < 2; ch++) {
      const r = makeRng(4242 + ch * 77);
      const d = st.ch[ch];
      let lp = 0;
      for (let i = 0; i < n; i++) {
        if ((i & (SLAB - 1)) === SLAB - 1) yield;
        const t = i / sr;
        if (t < pre) { d[i] = 0; continue; }
        const tt = t - pre;
        const env = Math.exp((-6.9 * tt) / rt60) * Math.min(1, tt / 0.06) * (1 - sst(secs - 0.6, secs, t));
        const a = 0.18 + 0.72 * Math.min(1, tt / (rt60 * 0.8)); // darker as it decays
        lp += (1 - a) * ((r() * 2 - 1) - lp);
        d[i] = lp * env * (1 + a);
      }
    }
  }

  // -> { key, noise: { white, pink, brown, crackle }, ir } (stores; see storeBuffer)
  function* genData(sr, lite) {
    const data = { key: dataKey(sr, lite), noise: {}, ir: null };
    for (const [kind, secs, seed] of NOISE_SPEC(lite)) {
      const n = Math.floor(sr * secs), st = newStore(n, sr);
      yield* genNoise(n, kind, seed, st);
      data.noise[kind] = st;
    }
    const [secs, rt60] = IR_SPEC(lite);
    data.ir = newStore(Math.floor(sr * secs), sr);
    yield* genIR(sr, secs, rt60, data.ir);
    return data;
  }
  function dataKey(sr, lite) { return sr + (lite ? ':lite' : ':full'); }
  function drain(gen) { for (;;) { const r = gen.next(); if (r.done) return r.value; } }

  // One cached data set (the live context's) and at most one job building in slices of ~6 ms.
  let dataSet = null, dataJob = null;
  function withData(sr, lite, cb) {
    const key = dataKey(sr, lite);
    if (dataSet && dataSet.key === key) { if (cb) cb(dataSet); return; }
    if (!dataJob || dataJob.key !== key) {
      const job = dataJob = { key, gen: genData(sr, lite), cbs: [] };
      const tick = () => {
        if (dataJob !== job) return; // superseded (other output rate)
        const t0 = performance.now();
        let r;
        try {
          do r = job.gen.next(); while (!r.done && performance.now() - t0 < 6);
        } catch (err) { dataJob = null; console.error('[audio] sample data failed', err); return; }
        if (!r.done) { setTimeout(tick, 0); return; }
        dataJob = null; dataSet = r.value;
        for (const f of job.cbs.splice(0)) f(dataSet);
      };
      setTimeout(tick, 0);
    }
    if (cb) dataJob.cbs.push(cb);
  }

  class Score {
    constructor(ctx, opts) {
      this.ctx = ctx;
      this.offline = !!opts.offline;
      this.lite = !!opts.lite;
      this.raw = !!opts.raw;
      this.mobile = !!opts.mobile; // phone/tablet speaker voicing (see buildGraph)
      this.only = opts.only || null; // analysis: event filter (stem renders)
      this.tap = opts.tap || null; // analysis: 'comp' = output the bands' sum ahead of the soft clipper
      this.pre = opts.raw ? 0 : COMP_LAT; // compressor look-ahead delay, compensated in at()
      this.data = opts.data; // noise loops + reverb IR (genData)
      this.deferReverb = !!opts.deferReverb; // live first build: the convolver gets its IR in a later task (armReverb)
      this.voices = [];
      this.anchorCtx = 0;
      this.anchorT = 0;
      this.schedT = 0;
      this.gT = 0;
      this.dropped = 0;
      this.built = 0;
      this.errors = 0;
      this.buildGraph();
    }

    buildGraph() {
      const ctx = this.ctx;
      const g = (v) => { const n = ctx.createGain(); n.gain.value = v === undefined ? 1 : v; return n; };
      this.dry = g(1);
      this.revIn = g(1);
      this.dlyIn = g(1);
      // bed bus: sustained layers pass through gains that duck ~0.3 s under the big hits (G_DUCK)
      this.bedDry = g(1); this.bedRev = g(1); this.bedDly = g(1);
      this.bedDry.connect(this.dry); this.bedRev.connect(this.revIn); this.bedDly.connect(this.dlyIn);
      const sum = g(1);
      this.dry.connect(sum);

      // reverb + ping-pong delay live in a replaceable "fx" chain: start(T) swaps in a fresh one so a
      // tail held in the old one (e.g. the climax, frozen by suspend() after stop) never leaks into
      // the new position
      this.irBuf = storeBuffer(ctx, this.data.ir);
      this.sum = sum;
      this.fx = this.attachFx(this.makeFx(this.deferReverb));
      // stereo width (M/S): the singularity is a point (mono); space inflates the field
      const sp = ctx.createChannelSplitter(2), mg = ctx.createChannelMerger(2);
      this.wLL = g(1); this.wRR = g(1); this.wLR = g(0); this.wRL = g(0);
      sum.connect(sp);
      sp.connect(this.wLL, 0); sp.connect(this.wLR, 0);
      sp.connect(this.wRL, 1); sp.connect(this.wRR, 1);
      this.wLL.connect(mg, 0, 0); this.wRL.connect(mg, 0, 0);
      this.wLR.connect(mg, 0, 1); this.wRR.connect(mg, 0, 1);

      // master: lowpass (freeze/aftermath), DC block, film-level automation, pause fade, dynamics
      this.mlp = ctx.createBiquadFilter();
      this.mlp.type = 'lowpass'; this.mlp.Q.value = 0.5; this.mlp.frequency.value = 20000;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 18; hp.Q.value = 0.6;
      this.mgain = g(1);
      this.pgain = g(0);
      const clip = ctx.createWaveShaper();
      clip.curve = this.softClipCurve(0.85);
      clip.oversample = '4x';
      const dc = ctx.createBiquadFilter();
      dc.type = 'highpass'; dc.frequency.value = 7; dc.Q.value = 0.5;
      this.outGain = g(OUT_GAIN);
      // DC/infrasound block sits before the film-level gain so its tail is muted with everything else
      mg.connect(this.mlp); this.mlp.connect(hp); hp.connect(dc);
      // post-lowpass bus: voices that must not be muffled by mlp (the ringing ears after Theia)
      this.post = g(1); this.post.connect(hp);
      let head = dc;
      if (this.mobile) {
        // small speakers cannot move air below ~150 Hz: energy there only pumps the compressor and
        // the speaker. Thin the sub, lift the presence band, and make up the level. (Ahead of the
        // film-level gain, so the filters' ringing is gated by the breaths of silence too.)
        const bq = (type, f, q, gain) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; n.gain.value = gain || 0; return n; };
        const chain = [bq('highpass', MOBILE_EQ.hp, 0.7), bq('lowshelf', MOBILE_EQ.shelfF, 0.7, MOBILE_EQ.shelf),
          bq('peaking', MOBILE_EQ.presF, 0.8, MOBILE_EQ.pres), g(Math.pow(10, MOBILE_EQ.makeup / 20))];
        for (const n of chain) { head.connect(n); head = n; }
      }
      head.connect(this.mgain); this.mgain.connect(this.pgain);
      if (this.raw) this.pgain.connect(this.outGain); // analysis only: no dynamics
      else {
        // two-band bus compression -> soft clipper (true-peak safety). The body band (booms, sub,
        // drums, brass) carries almost all the peak energy of the big hits; compressed on its own it
        // no longer ducks the mid/high band - the transients, crashes and choirs, which is all a laptop
        // or phone plays. Linkwitz-Riley crossover (two Butterworth stages per side: the bands sum
        // flat; lowpass/highpass Q is in dB in Web Audio, -3.01 dB = 1/sqrt(2)). Both compressors have
        // the same look-ahead, and each band is level-matched to the single-band reference (COMP),
        // so below threshold the chain is a plain gain.
        const pre = g(PRE_GAIN); // cancels most of the compressors' automatic makeup gain below threshold
        const bq = (type) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = BANDS.xover; n.Q.value = 20 * Math.log10(Math.SQRT1_2); return n; };
        const cmp = (c) => {
          const n = ctx.createDynamicsCompressor();
          n.threshold.value = c.thr; n.knee.value = c.knee; n.ratio.value = c.ratio; n.attack.value = c.att; n.release.value = c.rel;
          return n;
        };
        const ref = compMakeup(COMP), bands = g(1);
        this.pgain.connect(pre);
        const high = this.mobile ? Object.assign({}, BANDS.high, { thr: BANDS.high.thr + MOBILE_EQ.hiThr }) : BANDS.high;
        [['lowpass', BANDS.low], ['highpass', high]].forEach(([type, c]) => {
          const f1 = bq(type), f2 = bq(type), k = cmp(c), m = g(ref / compMakeup(c));
          pre.connect(f1); f1.connect(f2); f2.connect(k); k.connect(m); m.connect(bands);
        });
        bands.connect(this.tap === 'comp' ? this.outGain : clip);
        if (this.tap !== 'comp') clip.connect(this.outGain);
      }
      this.outGain.connect(ctx.destination);

      this.globals = [
        { p: this.mlp.frequency, fn: G_LP },
        { p: this.wLL.gain, fn: (T) => 0.5 * (1 + G_WIDTH(T)) },
        { p: this.wRR.gain, fn: (T) => 0.5 * (1 + G_WIDTH(T)) },
        { p: this.wLR.gain, fn: (T) => 0.5 * (1 - G_WIDTH(T)) },
        { p: this.wRL.gain, fn: (T) => 0.5 * (1 - G_WIDTH(T)) },
        { p: this.bedDry.gain, fn: G_DUCK }, { p: this.bedRev.gain, fn: G_DUCK }, { p: this.bedDly.gain, fn: G_DUCK },
      ];
      this.baseGlobals = this.globals;
      this.globals = this.baseGlobals.concat(this.fx.globals);

      // shared resources
      this.buf = {};
      for (const k of Object.keys(this.data.noise)) this.buf[k] = storeBuffer(ctx, this.data.noise[k]);
      this.waves = {
        organ: this.periodic([0, 1, 0.75, 0.22, 0.5, 0.06, 0.16, 0, 0.22, 0, 0.05, 0, 0.07, 0, 0, 0, 0.05]),
        glass: this.periodic([0, 1, 0.04, 0.12, 0.0, 0.035]),
        mallet: this.periodic([0, 1, 0, 0.18, 0, 0.05]),
      };
      this.curves = {};
    }

    periodic(h) {
      const real = new Float32Array(h.length), imag = new Float32Array(h);
      return this.ctx.createPeriodicWave(real, imag);
    }

    // Unity below the knee, smooth saturation towards `ceil` (true-peak safety, -1 dBFS).
    softClipCurve(ceil) {
      const n = 8192, c = new Float32Array(n), knee = 0.7 * ceil, span = ceil - knee;
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1, a = Math.abs(x);
        c[i] = Math.sign(x) * (a <= knee ? a : knee + span * Math.tanh((a - knee) / span));
      }
      return c;
    }

    tanhCurve(drive) {
      const key = drive.toFixed(2);
      if (this.curves[key]) return this.curves[key];
      const n = 2048, c = new Float32Array(n), norm = 1 / Math.tanh(drive);
      for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(x * drive) * norm; }
      this.curves[key] = c;
      return c;
    }

    // defer: leave the convolver empty for now; armReverb() gives it the IR (setting a convolver's
    // buffer costs ~30 ms of main thread, so it gets a task of its own)
    makeFx(defer) {
      const ctx = this.ctx;
      const g = (v) => { const n = ctx.createGain(); n.gain.value = v === undefined ? 1 : v; return n; };
      const rin = g(1), din = g(1), outG = g(1);
      const conv = ctx.createConvolver();
      conv.normalize = true;
      const arm = () => { conv.buffer = this.irBuf; };
      if (!defer) arm();
      const revRet = g(1);
      rin.connect(conv); conv.connect(revRet); revRet.connect(outG);
      // ping-pong delay (dotted eighth, follows the tempo map), feeding the same reverb
      const dl = ctx.createDelay(2), dr = ctx.createDelay(2);
      const fb = g(0.36), lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 2800;
      const dm = ctx.createChannelMerger(2), dret = g(0.55), dsend = g(0.25);
      din.connect(dl);
      dl.connect(dm, 0, 0); dl.connect(dr); dr.connect(dm, 0, 1);
      dr.connect(lp); lp.connect(fb); fb.connect(dl);
      dm.connect(dret); dret.connect(outG);
      dret.connect(dsend); dsend.connect(rin);
      return {
        rin, din, outG, arm: defer ? arm : null, nodes: [rin, din, outG, conv, revRet, dl, dr, fb, lp, dm, dret, dsend],
        globals: [{ p: revRet.gain, fn: G_REV }, { p: dl.delayTime, fn: G_DLY }, { p: dr.delayTime, fn: G_DLY }],
      };
    }

    attachFx(fx) {
      this.revIn.connect(fx.rin); this.dlyIn.connect(fx.din); fx.outG.connect(this.sum);
      return fx;
    }

    // Build the next fx chain ahead of time (a convolver costs ~30 ms of main thread): called while
    // paused/stopped so the next start(T) only has to swap it in.
    prepareFx() {
      if (!this.spareFx) this.spareFx = this.makeFx();
    }

    armReverb() {
      const fx = this.fx;
      if (fx.arm) { const f = fx.arm; fx.arm = null; f(); }
    }

    // Replace the reverb/delay chain (old tails fade out within ~30 ms instead of ringing on).
    // defer: without a spare chain, arm the new reverb in a later task (see makeFx).
    flushFx(defer) {
      const old = this.fx, now = this.ctx.currentTime;
      try { this.revIn.disconnect(old.rin); } catch (_) { /* ignore */ }
      try { this.dlyIn.disconnect(old.din); } catch (_) { /* ignore */ }
      const kill = () => { for (const n of old.nodes) { try { n.disconnect(); } catch (_) { /* ignore */ } } };
      if (this.offline || this.ctx.state !== 'running') kill();
      else {
        old.outG.gain.cancelScheduledValues(0);
        old.outG.gain.setValueAtTime(old.outG.gain.value, now);
        old.outG.gain.setTargetAtTime(0, now, 0.008);
        setTimeout(kill, 250);
      }
      this.fx = this.attachFx(this.spareFx || this.makeFx(defer));
      this.spareFx = null;
      this.globals = this.baseGlobals.concat(this.fx.globals);
    }

    // ------------------------------------------------------------ scheduling
    // audio time at which film time T must be scheduled to be heard at the anchor's pace
    at(T) { return this.anchorCtx + (T - this.anchorT) - this.pre; }

    play(ev) {
      const ctx = this.ctx;
      let when = this.at(ev.t), off = 0;
      // never schedule at/before currentTime: a value set at currentTime would collide with curves
      const minWhen = ctx.currentTime + (this.offline ? 0.003 : 0.012);
      if (when < minWhen) { off = minWhen - when; when = minWhen; }
      if (off >= ev.dur - 0.02) return;
      if (this.only && !this.only(ev)) return;
      if (ev.prio && this.activeAt(when) >= MAX_VOICES) { this.dropped++; return; }
      const fn = BUILD[ev.type];
      if (!fn) return;
      const v = { srcs: [], nodes: [], start: when, end: when + (ev.dur - off) + 0.05,
        trim: Math.pow(10, ((TRIM[ev.type] || 0) + (ev.trim || 0)) / 20), bed: BED.has(ev.type) && !ev.noDuck, post: !!ev.post };
      try {
        fn(this, ev, when, off, v);
      } catch (err) {
        this.errors++;
        if (this.errors < 5) console.error('[audio] voice ' + ev.type + ' failed:', err && err.message ? err.message : err);
        for (const nd of v.nodes) try { nd.disconnect(); } catch (_) { /* ignore */ }
        return;
      }
      this.built++;
      let left = v.srcs.length;
      const nodes = v.nodes;
      const done = () => { if (--left <= 0) for (const nd of nodes) try { nd.disconnect(); } catch (_) { /* ignore */ } };
      for (const s of v.srcs) {
        s.onended = done;
        try {
          if (s._offset !== undefined) s.start(when, s._offset); else s.start(when);
          s.stop(v.end);
        } catch (_) { this.errors++; }
      }
      this.voices.push(v);
      if (this.voices.length > 160) this.prune();
    }

    prune() {
      const now = this.ctx.currentTime;
      this.voices = this.voices.filter((v) => v.end > now);
    }

    // number of voices sounding at audio time t
    activeAt(t) {
      let n = 0;
      for (const v of this.voices) if (v.start <= t + 0.005 && v.end > t) n++;
      return n;
    }

    activeCount() {
      this.prune();
      return this.activeAt(this.ctx.currentTime);
    }

    killAll(t) {
      for (const v of this.voices) for (const s of v.srcs) try { s.stop(t); } catch (_) { /* ignore */ }
      this.voices = [];
    }

    // Schedule everything with start time in [schedT, horizonT).
    scheduleTo(horizonT) {
      const a = this.schedT, b = horizonT;
      if (b <= a) return;
      // static events: binary search the first with t >= a
      let lo = 0, hi = EVENTS.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (EVENTS[mid].t < a) lo = mid + 1; else hi = mid; }
      for (let i = lo; i < EVENTS.length && EVENTS[i].t < b; i++) this.play(EVENTS[i]);
      const pe = patternEvents(a, b, []);
      for (const ev of pe) this.play(ev);
      this.schedT = b;
      this.scheduleGlobals(b + 0.1);
    }

    scheduleGlobals(h) {
      const step = 0.02, now = this.ctx.currentTime;
      let last = this.gLastAt || 0;
      while (this.gT < h) {
        const nt = (Math.floor(this.gT / step + 1e-6) + 1) * step;
        const tt = this.at(nt);
        if (tt > last + 1e-4 && tt > now) {
          for (const gl of this.globals) gl.p.linearRampToValueAtTime(gl.fn(nt), tt);
          last = tt;
        }
        this.gT = nt;
      }
      this.gLastAt = last;
      // master gain: exact keyframe times (sample-accurate breaths before the big hits). A ramp runs
      // from the previous key to this one, so it is queued as soon as the previous key (the ramp's
      // start) enters the horizon: one key ahead. Queued only when its own time arrived, a long ramp
      // (the 184-189.4 outro fade) would start in the past and Web Audio would jump to the
      // interpolated value (an audible step + click).
      while (this.mkI < MASTER_KEYS.length && (this.mkI === 0 || MASTER_KEYS[this.mkI - 1][0] <= h)) {
        const kp = this.mkI > 0 ? MASTER_KEYS[this.mkI - 1][0] : 0;
        const [kt, kv] = MASTER_KEYS[this.mkI++];
        // keep the key order even if the sync servo nudged the anchor between two queued keys, and
        // never drop a key (a dropped "back to 1" key would leave the film muted)
        let tt = this.at(kt);
        if (tt < this.mkLast + 1e-5) tt = this.mkLast + 1e-5 + Math.min(0.5 * (kt - kp), 0.002);
        if (tt < now + 0.002) tt = now + 0.002;
        this.mgain.gain.linearRampToValueAtTime(kv, tt);
        this.mkLast = tt;
      }
    }

    // Re-anchor at film time T (audio time `when` = audible position of T) and rebuild the voices
    // that are in progress at T.
    seek(T, anchorCtx, startCtx) {
      this.anchorT = T;
      this.anchorCtx = anchorCtx;
      const t0 = startCtx;
      for (const gl of this.globals) {
        gl.p.cancelScheduledValues(0);
        gl.p.setValueAtTime(gl.fn(Math.max(0, T)), t0);
      }
      this.gT = T;
      this.gLastAt = t0;
      const mg = this.mgain.gain;
      mg.cancelScheduledValues(0);
      mg.setValueAtTime(G_MASTER(Math.max(0, T)), t0);
      this.mkI = MASTER_KEYS.findIndex((k) => this.at(k[0]) > t0 + 1e-5);
      if (this.mkI < 0) this.mkI = MASTER_KEYS.length;
      this.mkLast = t0;
      // in-progress static events
      for (const ev of EVENTS) {
        if (ev.t >= T) break;
        if (ev.t + ev.dur > T + 0.05) this.play(ev);
      }
      // in-progress pattern events
      for (const ev of patternEvents(T - 3, T, [])) if (ev.t + ev.dur > T + 0.02) this.play(ev);
      this.schedT = T;
    }

    // ------------------------------------------------------------ voice output helper
    out(v, node, o) {
      const ctx = this.ctx;
      let tail = node;
      if (v.trim !== 1) { const t = ctx.createGain(); t.gain.value = v.trim; tail.connect(t); tail = t; v.nodes.push(t); }
      if (o.pan && ctx.createStereoPanner) {
        const p = ctx.createStereoPanner();
        if (typeof o.pan === 'function') applyCurve(p.pan, o.when, o.off, o.dur, o.pan, 20);
        else p.pan.value = clamp(o.pan, -1, 1);
        tail.connect(p); tail = p; v.nodes.push(p);
      }
      if (v.post) { tail.connect(this.post); return; } // dry only, after the master lowpass
      const dry = v.bed ? this.bedDry : this.dry, rin = v.bed ? this.bedRev : this.revIn, din = v.bed ? this.bedDly : this.dlyIn;
      if (!o.noDry) tail.connect(dry);
      if (o.rev > 0) { const s = ctx.createGain(); s.gain.value = o.rev; tail.connect(s); s.connect(rin); v.nodes.push(s); }
      if (o.dly > 0) { const s = ctx.createGain(); s.gain.value = o.dly; tail.connect(s); s.connect(din); v.nodes.push(s); }
    }
    osc(v, type, f) {
      const o = this.ctx.createOscillator();
      if (type === 'organ' || type === 'glass' || type === 'mallet') o.setPeriodicWave(this.waves[type]);
      else o.type = type;
      if (f !== undefined) o.frequency.value = f;
      v.srcs.push(o); v.nodes.push(o);
      return o;
    }
    gain(v, val) { const n = this.ctx.createGain(); n.gain.value = val === undefined ? 1 : val; v.nodes.push(n); return n; }
    filter(v, type, f, q) {
      const n = this.ctx.createBiquadFilter();
      n.type = type; n.frequency.value = f; if (q !== undefined) n.Q.value = q;
      v.nodes.push(n); return n;
    }
    noiseSrc(v, kind, seed, off) {
      const s = this.ctx.createBufferSource();
      s.buffer = this.buf[kind]; s.loop = true;
      const d = s.buffer.duration;
      s._offset = (hash(seed | 0, 77) * d + (off || 0)) % d;
      v.srcs.push(s); v.nodes.push(s);
      return s;
    }
    // A shared modulation source (ConstantSource) whose offset follows fn(localTime).
    modSource(v, when, off, dur, fn, rate) {
      const ctx = this.ctx;
      if (!ctx.createConstantSource) return null;
      const cs = ctx.createConstantSource();
      cs.offset.value = 0;
      applyCurve(cs.offset, when, off, dur, fn, rate);
      v.srcs.push(cs); v.nodes.push(cs);
      return cs;
    }
  }

  // ================================================================ voice builders
  // Each builder: (sc, ev, when, off, v). Envelopes are in local time (0..ev.dur); film-time functions
  // receive ev.t + local. Builders must push every source to v.srcs (started/stopped by play()).
  const BUILD = {};
  const lt2T = (ev, fn) => (lt) => fn(ev.t + lt);

  BUILD.tone = (sc, ev, when, off, v) => {
    const o1 = sc.osc(v, 'sine', ev.f), o2 = sc.osc(v, 'sine', ev.f * (ev.beat || 1.0034)), o3 = sc.osc(v, 'sine', ev.f * 2.0);
    const g2 = sc.gain(v, 0.35), g3 = sc.gain(v, 0.035);
    const env = sc.gain(v, 0), lvl = sc.gain(v, 0);
    o1.connect(env); o2.connect(g2); g2.connect(env); o3.connect(g3); g3.connect(env);
    env.connect(lvl);
    applyEnv(env.gain, when, off, [[0, 0], [ev.att || 0.03, 1], [ev.dur - 0.05, 1], [ev.dur, 0]]);
    applyCurve(lvl.gain, when, off, ev.dur, lt2T(ev, ev.lvl), 30);
    // vibrato (cents)
    const lfo = sc.osc(v, 'sine', 5.1), lg = sc.gain(v, 0);
    lfo.connect(lg); lg.connect(o1.detune); lg.connect(o2.detune);
    applyCurve(lg.gain, when, off, ev.dur, lt2T(ev, ev.vib || (() => 3)), 20);
    sc.out(v, lvl, { rev: ev.rev !== undefined ? ev.rev : 0.45, dly: 0.12 });
  };

  BUILD.bell = (sc, ev, when, off, v) => {
    const car = sc.osc(v, 'sine', ev.f), mod = sc.osc(v, 'sine', ev.f * ev.ratio);
    const mg = sc.gain(v, 0), g = sc.gain(v, 0);
    const dev = ev.index * ev.f * ev.ratio;
    mod.connect(mg); mg.connect(car.frequency);
    applyEnv(mg.gain, when, off, [[0, dev], [ev.dur * 0.35, dev * 0.08, 'e'], [ev.dur, dev * 0.01, 'e']]);
    car.connect(g);
    applyEnv(g.gain, when, off, [[0, 0], [ev.att || 0.002, ev.amp], [ev.dur * 0.98, ev.amp * 0.0008, 'e'], [ev.dur, 0]]);
    sc.out(v, g, { pan: ev.pan || 0, rev: ev.rev !== undefined ? ev.rev : 0.5, dly: ev.dly || 0 });
  };

  BUILD.mallet = (sc, ev, when, off, v) => { // soft celesta-like mallet with a pure sine body
    const car = sc.osc(v, 'mallet', ev.f), mod = sc.osc(v, 'sine', ev.f * 4);
    const mg = sc.gain(v, 0), g = sc.gain(v, 0);
    mod.connect(mg); mg.connect(car.frequency);
    applyEnv(mg.gain, when, off, [[0, ev.f * 1.4], [0.25, ev.f * 0.05, 'e'], [ev.dur, ev.f * 0.01, 'e']]);
    car.connect(g);
    applyEnv(g.gain, when, off, [[0, 0], [0.006, ev.amp], [0.4, ev.amp * 0.45, 'e'], [ev.dur * 0.98, ev.amp * 0.001, 'e'], [ev.dur, 0]]);
    sc.out(v, g, { pan: ev.pan || 0, rev: ev.rev || 0.5, dly: ev.dly || 0 });
  };

  BUILD.pluck = (sc, ev, when, off, v) => {
    const o = sc.osc(v, 'sawtooth', ev.f);
    const f = sc.filter(v, 'lowpass', ev.cut, ev.q || 2);
    const g = sc.gain(v, 0);
    o.connect(f); f.connect(g);
    const c = ev.cut, top = Math.min(16000, c * (1 + ev.env));
    applyEnv(f.frequency, when, off, [[0, top], [Math.min(0.12, ev.dur * 0.5), c, 'e'], [ev.dur, c * 0.6, 'e']]);
    applyEnv(g.gain, when, off, [[0, 0], [0.003, ev.amp], [ev.dur * 0.97, ev.amp * 0.002, 'e'], [ev.dur, 0]]);
    sc.out(v, g, { pan: ev.pan || 0, rev: ev.rev || 0, dly: ev.dly || 0 });
  };

  BUILD.bassnote = (sc, ev, when, off, v) => {
    const o = sc.osc(v, 'sawtooth', ev.f), o2 = sc.osc(v, 'sine', ev.f * 0.5);
    const f = sc.filter(v, 'lowpass', 300, 2.5);
    const g = sc.gain(v, 0), g2 = sc.gain(v, 0.6);
    o.connect(f); f.connect(g); o2.connect(g2); g2.connect(g);
    applyEnv(f.frequency, when, off, [[0, 900], [ev.dur * 0.6, 220, 'e'], [ev.dur, 160, 'e']]);
    applyEnv(g.gain, when, off, [[0, 0], [0.004, ev.amp], [ev.dur * 0.95, ev.amp * 0.05, 'e'], [ev.dur, 0]]);
    sc.out(v, g, { rev: 0.05 });
  };

  BUILD.pad = (sc, ev, when, off, v) => {
    const ctx = sc.ctx, tim = ev.tim, lite = sc.lite;
    const notes = ev.notes;
    const env = sc.gain(v, 0), lvl = sc.gain(v, 0);
    let head;
    if (tim === 'sub') {
      for (const n of notes) {
        const f = mtof(n);
        // fundamental + 2nd and 3rd harmonics: the low end is still heard (pitch) on small speakers
        const o = sc.osc(v, 'sine', f), o2 = sc.osc(v, 'sine', f * 2), g2 = sc.gain(v, 0.4);
        o.connect(env); o2.connect(g2); g2.connect(env);
        const o3 = sc.osc(v, 'sine', f * 3), g3 = sc.gain(v, 0.2); o3.connect(g3); g3.connect(env);
      }
      head = null;
    } else {
      const pair = !lite || tim === 'glass';
      const wave = tim === 'org' ? 'organ' : tim === 'glass' ? 'glass' : 'sawtooth';
      const merger = ctx.createChannelMerger(2);
      v.nodes.push(merger);
      const det = tim === 'org' ? 3.5 : tim === 'glass' ? 4 : 9;
      let lfoG = null;
      if (tim === 'str' || tim === 'cho') {
        const lfo = sc.osc(v, 'sine', 4.8 + hash(ev.seed, 3)), lg = sc.gain(v, tim === 'cho' ? 9 : 7);
        lfo.connect(lg); lfoG = lg;
      }
      for (let i = 0; i < notes.length; i++) {
        const f = mtof(notes[i]);
        for (let k = 0; k < (pair ? 2 : 1); k++) {
          const o = sc.osc(v, wave, f);
          o.detune.value = (pair ? (k ? 1 : -1) * det : 0) + (hash(i * 7 + k, ev.seed) - 0.5) * 5;
          if (lfoG) lfoG.connect(o.detune);
          o.connect(merger, 0, pair ? k : i & 1);
        }
      }
      const per = 1 / Math.sqrt(notes.length * (pair ? 2 : 1));
      const norm = sc.gain(v, per * (tim === 'str' ? 0.9 : tim === 'cho' ? 2.2 : tim === 'glass' ? 0.9 : 1));
      merger.connect(norm);
      head = norm;
      if (tim === 'str') {
        const f = sc.filter(v, 'lowpass', ev.cut || 1500, 0.8);
        if (ev.cutFn) applyCurve(f.frequency, when, off, ev.dur, lt2T(ev, ev.cutFn), 10);
        head.connect(f); head = f;
      } else if (tim === 'cho') {
        const f1 = sc.filter(v, 'bandpass', 700, 5), f2 = sc.filter(v, 'bandpass', 1150, 6), f3 = sc.filter(v, 'bandpass', 2600, 7);
        const s = sc.gain(v, 1), g3 = sc.gain(v, 0.4);
        head.connect(f1); head.connect(f2); head.connect(f3); f1.connect(s); f2.connect(s); f3.connect(g3); g3.connect(s);
        head = s;
      } else if (tim === 'org') {
        const f = sc.filter(v, 'lowpass', 4200, 0.6);
        head.connect(f); head = f;
      }
      if (ev.trem) {
        const tg = sc.gain(v, 1), lfo = sc.osc(v, 'sine', ev.trem), d = sc.gain(v, 0.35);
        lfo.connect(d); d.connect(tg.gain);
        head.connect(tg); head = tg;
      }
      head.connect(env);
    }
    const D = ev.dur, att = Math.min(ev.att || 0.5, D * 0.4), rel = Math.min(ev.rel || 1, D * 0.5);
    applyEnv(env.gain, when, off, ev.env || [[0, 0], [att, 1], [D - rel, 1], [D, 0]]);
    applyCurve(lvl.gain, when, off, D, lt2T(ev, ev.lvl), 20);
    env.connect(lvl);
    sc.out(v, lvl, { rev: ev.rev !== undefined ? ev.rev : 0.4 });
  };

  BUILD.drone = (sc, ev, when, off, v) => {
    const ctx = sc.ctx;
    const merger = ctx.createChannelMerger(2);
    v.nodes.push(merger);
    const pair = ev.wave !== 'sine' && !sc.lite;
    const mod = ev.cents ? sc.modSource(v, when, off, ev.dur, lt2T(ev, ev.cents), 20) : null;
    let n = 0;
    for (let i = 0; i < ev.notes.length; i++) {
      const f = mtof(ev.notes[i]);
      for (let k = 0; k < (pair ? 2 : 1); k++) {
        const o = sc.osc(v, ev.wave, f);
        o.detune.value = pair ? (k ? 1 : -1) * ev.det + (hash(i * 3 + k, ev.seed) - 0.5) * 6 : 0;
        if (mod) mod.connect(o.detune);
        else if (ev.cents) applyCurve(o.detune, when, off, ev.dur, lt2T(ev, ev.cents), 20);
        o.connect(merger, 0, pair ? k : ev.wave === 'sine' ? 0 : i & 1);
        if (ev.wave === 'sine') o.connect(merger, 0, 1);
        n++;
        if (ev.harm2) {
          const o2 = sc.osc(v, 'sine', f * 2), g2 = sc.gain(v, ev.harm2);
          if (mod) mod.connect(o2.detune);
          o2.connect(g2); g2.connect(merger, 0, 0); g2.connect(merger, 0, 1);
        }
      }
    }
    let head = sc.gain(v, 1 / Math.sqrt(Math.max(1, n)) * (ev.wave === 'sine' ? 1 : 1));
    merger.connect(head);
    if (ev.cut) {
      const f = sc.filter(v, 'lowpass', 1000, ev.q || 0.8);
      if (typeof ev.cut === 'function') applyCurve(f.frequency, when, off, ev.dur, lt2T(ev, ev.cut), 30);
      else f.frequency.value = ev.cut;
      head.connect(f); head = f;
    }
    if (ev.trem) {
      const tg = sc.gain(v, 0.6), lfo = sc.osc(v, 'sine', ev.trem), d = sc.gain(v, 0.4);
      lfo.connect(d); d.connect(tg.gain);
      head.connect(tg); head = tg;
    }
    const g = sc.gain(v, 0);
    applyCurve(g.gain, when, off, ev.dur, lt2T(ev, ev.gain), 30);
    head.connect(g);
    sc.out(v, g, { rev: ev.rev !== undefined ? ev.rev : 0.25 });
  };

  BUILD.noise = (sc, ev, when, off, v) => {
    const s = sc.noiseSrc(v, ev.buf || 'pink', ev.seed, off);
    let head = s;
    if (ev.filt) {
      const f = sc.filter(v, ev.filt, 1000, ev.q !== undefined ? ev.q : 0.7);
      applyCurve(f.frequency, when, off, ev.dur, lt2T(ev, ev.freq), 30);
      head.connect(f); head = f;
    }
    const g = sc.gain(v, 0);
    applyCurve(g.gain, when, off, ev.dur, lt2T(ev, ev.gain), 30);
    head.connect(g);
    sc.out(v, g, { rev: ev.rev || 0, pan: ev.pan ? lt2T(ev, ev.pan) : 0, when, off, dur: ev.dur });
  };

  BUILD.swell = (sc, ev, when, off, v) => { // reverse cymbal: rises and stops dead on the cue
    const s = sc.noiseSrc(v, ev.buf || 'white', ev.seed, off);
    const f = sc.filter(v, ev.filt || 'highpass', ev.f0, ev.q || 0.7);
    const g = sc.gain(v, 0);
    const D = ev.dur;
    applyCurve(f.frequency, when, off, D, (lt) => ev.f0 * Math.pow(ev.f1 / ev.f0, Math.pow(lt / D, 1.6)), 40);
    applyCurve(g.gain, when, off, D, (lt) => ev.amp * Math.pow(clamp(lt / D, 0, 1), ev.pw || 3) * (lt > D - 0.012 ? Math.max(0, (D - lt) / 0.012) : 1), 80);
    s.connect(f); f.connect(g);
    sc.out(v, g, { rev: 0.3 });
  };

  BUILD.crash = (sc, ev, when, off, v) => {
    const s = sc.noiseSrc(v, 'white', ev.seed, off);
    const hp = sc.filter(v, 'highpass', 3800, 0.6), pk = sc.filter(v, 'peaking', 7000, 1.2);
    pk.gain.value = 5;
    const g = sc.gain(v, 0);
    s.connect(hp); hp.connect(pk); pk.connect(g);
    applyEnv(g.gain, when, off, ev.hold // optional held wash (s) before the decay
      ? [[0, 0], [0.004, ev.amp], [0.35, ev.amp * 0.45, 'e'], [ev.hold, ev.amp * 0.3, 'e'], [ev.dur * 0.98, ev.amp * 0.001, 'e'], [ev.dur, 0]]
      : [[0, 0], [0.004, ev.amp], [0.35, ev.amp * 0.45, 'e'], [ev.dur * 0.98, ev.amp * 0.001, 'e'], [ev.dur, 0]]);
    sc.out(v, g, { rev: 0.45 });
  };

  BUILD.crack = (sc, ev, when, off, v) => {
    const s = sc.noiseSrc(v, 'white', ev.seed, off);
    const f = sc.filter(v, 'highpass', 900, 0.7);
    const g = sc.gain(v, 0);
    s.connect(f); f.connect(g);
    applyEnv(g.gain, when, off, [[0, 0], [0.0012, ev.amp], [0.09, ev.amp * 0.02, 'e'], [ev.dur, 0]]);
    sc.out(v, g, { rev: 0.5 });
  };

  BUILD.boom = (sc, ev, when, off, v) => { // saturated sub drop
    const o = sc.osc(v, 'sine', ev.f0);
    applyEnv(o.frequency, when, off, [[0, ev.f0], [ev.sweep, ev.f1, 'e'], [ev.dur, ev.f1 * 0.92, 'e']]);
    const pre = sc.gain(v, 0);
    applyEnv(pre.gain, when, off, [[0, 0], [0.004, 1], [0.35, 0.75, 'e'], [ev.dur * 0.97, 0.0005, 'e'], [ev.dur, 0]]);
    const sh = sc.ctx.createWaveShaper();
    sh.curve = sc.tanhCurve(ev.drive || 2); sh.oversample = '2x';
    v.nodes.push(sh);
    const lp = sc.filter(v, 'lowpass', 900, 0.7);
    const g = sc.gain(v, ev.amp);
    o.connect(pre); pre.connect(sh); sh.connect(lp); lp.connect(g);
    sc.out(v, g, { rev: 0.35 });
  };

  BUILD.knock = (sc, ev, when, off, v) => { // mid-range body + snap of a hit (reads on small speakers)
    const o = sc.osc(v, 'sawtooth', ev.f0);
    applyEnv(o.frequency, when, off, [[0, ev.f0 * 1.25], [0.08, ev.f1, 'e'], [ev.dur, ev.f1 * 0.85, 'e']]);
    const pre = sc.gain(v, 0);
    applyEnv(pre.gain, when, off, [[0, 0], [0.002, 1], [0.1, 0.4, 'e'], [ev.dur * 0.97, 0.0008, 'e'], [ev.dur, 0]]);
    const sh = sc.ctx.createWaveShaper();
    sh.curve = sc.tanhCurve(3); sh.oversample = '2x';
    v.nodes.push(sh);
    // the high-passed square-ish wave has needle spikes at every edge (crest ~20 dB): a second, gentle
    // saturator rounds them off, so the knock is as loud but no longer slams the bus compressor
    // (whose gain reduction would duck the whole hit), then the lowpass smooths the edges
    const sh2 = sc.ctx.createWaveShaper();
    sh2.curve = sc.tanhCurve(KNOCK_SAT); sh2.oversample = '2x';
    v.nodes.push(sh2);
    const lp = sc.filter(v, 'lowpass', 3200, 0.7), hp = sc.filter(v, 'highpass', 150, 0.7), hp2 = sc.filter(v, 'highpass', 150, 0.7);
    const g = sc.gain(v, ev.amp);
    o.connect(pre); pre.connect(sh); sh.connect(hp); hp.connect(hp2); hp2.connect(sh2); sh2.connect(lp); lp.connect(g);
    const s = sc.noiseSrc(v, 'white', ev.seed, off), bp = sc.filter(v, 'bandpass', ev.snapF || 1700, 0.8), gn = sc.gain(v, 0);
    applyEnv(gn.gain, when, off, [[0, 0], [0.001, 1], [0.05, 0.02, 'e'], [Math.min(ev.dur, 0.4), 0]]);
    s.connect(bp); bp.connect(gn); gn.connect(g);
    sc.out(v, g, { pan: ev.pan || 0, rev: 0.4 });
  };

  BUILD.blast = (sc, ev, when, off, v) => {
    const s = sc.noiseSrc(v, ev.buf || 'white', ev.seed, off);
    const f = sc.filter(v, 'lowpass', ev.f0, 0.9);
    const hp = sc.filter(v, 'highpass', 40, 0.7);
    const g = sc.gain(v, 0);
    applyEnv(f.frequency, when, off, [[0, ev.f0], [ev.sweep, ev.f1, 'e'], [ev.dur, ev.f1 * 0.7, 'e']]);
    applyEnv(g.gain, when, off, [[0, 0], [0.003, ev.amp], [0.5, ev.amp * 0.5, 'e'], [ev.dur * 0.97, ev.amp * 0.001, 'e'], [ev.dur, 0]]);
    s.connect(f); f.connect(hp); hp.connect(g);
    sc.out(v, g, { rev: 0.6 });
  };

  BUILD.brass = (sc, ev, when, off, v) => { // the BRAAAM: low saw cluster, filter blooms then closes
    const ctx = sc.ctx;
    const merger = ctx.createChannelMerger(2);
    v.nodes.push(merger);
    const scoop = sc.modSource(v, when, off, ev.dur, (lt) => -45 * Math.exp(-lt / 0.05), 120);
    const pair = !sc.lite;
    for (let i = 0; i < ev.notes.length; i++) {
      for (let k = 0; k < (pair ? 2 : 1); k++) {
        const o = sc.osc(v, 'sawtooth', mtof(ev.notes[i]));
        o.detune.value = pair ? (k ? 1 : -1) * 10 : 0;
        if (scoop) scoop.connect(o.detune);
        o.connect(merger, 0, pair ? k : i & 1);
      }
    }
    const norm = sc.gain(v, 1 / Math.sqrt(ev.notes.length * (pair ? 2 : 1)));
    const sh = ctx.createWaveShaper();
    sh.curve = sc.tanhCurve(1.8); v.nodes.push(sh);
    const f = sc.filter(v, 'lowpass', 200, 1.3);
    const g = sc.gain(v, 0);
    const D = ev.dur;
    const H = ev.hold || 0; // optional hold (s): stays open and loud before the slow close
    applyEnv(f.frequency, when, off, H
      ? [[0, 140], [0.14, ev.open || 2400, 'e'], [H, (ev.open || 2400) * 0.75, 'e'], [D * 0.55, 1400, 'e'], [D, 700, 'e']]
      : [[0, 140], [0.14, ev.open || 2400, 'e'], [D * 0.55, ev.sustain ? 1400 : 520, 'e'], [D, ev.sustain ? 700 : 220, 'e']]);
    applyEnv(g.gain, when, off, H
      ? [[0, 0], [0.05, ev.amp], [0.6, ev.amp * 0.85], [H, ev.amp * 0.75], [D * 0.7, ev.amp * 0.4, 'e'], [D * 0.98, ev.amp * 0.002, 'e'], [D, 0]]
      : ev.sustain
      ? [[0, 0], [0.05, ev.amp], [0.6, ev.amp * 0.7], [D * 0.7, ev.amp * 0.4, 'e'], [D * 0.98, ev.amp * 0.002, 'e'], [D, 0]]
      : [[0, 0], [0.05, ev.amp], [0.6, ev.amp * 0.7], [D * 0.97, ev.amp * 0.001, 'e'], [D, 0]]);
    merger.connect(norm); norm.connect(sh); sh.connect(f); f.connect(g);
    sc.out(v, g, { rev: ev.rev || 0.5 });
  };

  BUILD.ring = (sc, ev, when, off, v) => { // metallic ring: free-bar modal partials
    const parts = [[1, 1, 1], [2.756, 0.7, 0.8], [5.404, 0.45, 0.55], [8.933, 0.3, 0.4], [13.34, 0.18, 0.28]];
    const sum = sc.gain(v, 1);
    for (const [r, a, d] of parts) {
      for (let k = 0; k < 2; k++) {
        const o = sc.osc(v, 'sine', ev.f * r * (k ? 1.0025 : 0.9975));
        const g = sc.gain(v, 0);
        o.connect(g); g.connect(sum);
        const D = ev.dur * d;
        applyEnv(g.gain, when, off, [[0, 0], [0.002, a * ev.amp * 0.5], [Math.max(0.01, D * 0.97), a * ev.amp * 0.0005, 'e'], [Math.max(0.02, D), 0], [ev.dur, 0]]);
      }
    }
    sc.out(v, sum, { rev: ev.rev || 0.6 });
  };

  BUILD.shimmer = (sc, ev, when, off, v) => {
    const sum = sc.gain(v, 0);
    ev.notes.forEach((n, i) => {
      const o = sc.osc(v, 'sine', mtof(n));
      const g = sc.gain(v, 0);
      const rate = 3 + 9 * hash(i, ev.seed), ph = hash(i, ev.seed + 1) * 6.28;
      applyCurve(g.gain, when, off, ev.dur, (lt) => Math.pow(0.5 + 0.5 * Math.sin(lt * rate * 6.283 + ph), 2) / Math.sqrt(ev.notes.length), 60);
      o.connect(g); g.connect(sum);
    });
    applyEnv(sum.gain, when, off, [[0, 0], [0.01, ev.amp], [ev.dur * 0.97, ev.amp * 0.002, 'e'], [ev.dur, 0]]);
    sc.out(v, sum, { rev: ev.rev || 0.6, dly: 0.2 });
  };

  BUILD.shepard = (sc, ev, when, off, v) => { // Shepard-Risset glissando: an endless rise
    const n = ev.n || 7, sum = sc.gain(v, 1 / Math.sqrt(n / 2));
    for (let i = 0; i < n; i++) {
      const o = sc.osc(v, 'sine', ev.f0);
      const g = sc.gain(v, 0);
      const pos = (lt) => { const x = (i + ev.rate * lt + 0.5 * (ev.acc || 0) * lt * lt) / n; return ((x % 1) + 1) % 1; };
      applyCurve(o.frequency, when, off, ev.dur, (lt) => ev.f0 * Math.pow(2, pos(lt) * n), 60);
      applyCurve(g.gain, when, off, ev.dur, (lt) => Math.pow(Math.sin(Math.PI * pos(lt)), 2), 60);
      o.connect(g); g.connect(sum);
    }
    const lvl = sc.gain(v, 0);
    applyCurve(lvl.gain, when, off, ev.dur, lt2T(ev, ev.gain), 30);
    sum.connect(lvl);
    sc.out(v, lvl, { rev: ev.rev || 0.4 });
  };

  // ---- drums
  BUILD.thump = (sc, ev, when, off, v) => { // heartbeat: soft distant sub thump
    const o = sc.osc(v, 'sine', ev.f0);
    applyEnv(o.frequency, when, off, [[0, ev.f0], [0.2, ev.f1, 'e'], [ev.dur, ev.f1 * 0.9, 'e']]);
    const g = sc.gain(v, 0);
    applyEnv(g.gain, when, off, [[0, 0], [0.014, ev.amp], [ev.dur * 0.96, ev.amp * 0.001, 'e'], [ev.dur, 0]]);
    const o2 = sc.osc(v, 'sine', ev.f0 * 2), g2 = sc.gain(v, 0);
    applyEnv(o2.frequency, when, off, [[0, ev.f0 * 2], [0.2, ev.f1 * 2, 'e'], [ev.dur, ev.f1 * 1.8, 'e']]);
    applyEnv(g2.gain, when, off, [[0, 0], [0.01, ev.amp * 0.2], [0.25, ev.amp * 0.002, 'e'], [ev.dur, 0]]);
    o.connect(g); o2.connect(g2); g2.connect(g);
    sc.out(v, g, { rev: 0.3 });
  };

  BUILD.kick = (sc, ev, when, off, v) => {
    const o = sc.osc(v, 'sine', 120);
    applyEnv(o.frequency, when, off, [[0, 130], [0.05, 58, 'e'], [ev.dur, 40, 'e']]);
    const g = sc.gain(v, 0);
    applyEnv(g.gain, when, off, [[0, 0], [0.002, ev.amp], [0.08, ev.amp * 0.7, 'e'], [ev.dur * 0.96, ev.amp * 0.001, 'e'], [ev.dur, 0]]);
    o.connect(g);
    const s = sc.noiseSrc(v, 'white', ev.seed, off), hp = sc.filter(v, 'bandpass', 3000, 0.8), gn = sc.gain(v, 0);
    applyEnv(gn.gain, when, off, [[0, 0], [0.001, ev.amp * 0.25], [0.012, ev.amp * 0.002, 'e'], [0.02, 0]]);
    s.connect(hp); hp.connect(gn); gn.connect(g);
    sc.out(v, g, { rev: 0.08 });
  };

  BUILD.taiko = (sc, ev, when, off, v) => {
    const f = ev.f || 58;
    const o = sc.osc(v, 'sine', f * 1.6);
    applyEnv(o.frequency, when, off, [[0, f * 1.7], [0.1, f, 'e'], [ev.dur, f * 0.85, 'e']]);
    const g = sc.gain(v, 0);
    applyEnv(g.gain, when, off, [[0, 0], [0.003, ev.amp], [0.16, ev.amp * 0.55, 'e'], [ev.dur * 0.96, ev.amp * 0.001, 'e'], [ev.dur, 0]]);
    const o2 = sc.osc(v, 'triangle', f * 2.4), g2 = sc.gain(v, 0);
    applyEnv(g2.gain, when, off, [[0, 0], [0.002, ev.amp * 0.25], [0.18, ev.amp * 0.003, 'e'], [ev.dur, 0]]);
    // ev.body scales the sub body only (the cue hits leave the sub to the boom: it would only pump the bus)
    const bg = sc.gain(v, ev.body !== undefined ? ev.body : 1);
    o.connect(bg); bg.connect(g); o2.connect(g2); g2.connect(g);
    const s = sc.noiseSrc(v, 'pink', ev.seed, off), bp = sc.filter(v, 'bandpass', 220, 1.2), gn = sc.gain(v, 0);
    applyEnv(gn.gain, when, off, [[0, 0], [0.002, ev.amp * 0.9], [0.2, ev.amp * 0.005, 'e'], [ev.dur, 0]]);
    s.connect(bp); bp.connect(gn); gn.connect(g);
    const bp2 = sc.filter(v, 'bandpass', 1400, 1.5), gs = sc.gain(v, 0);
    applyEnv(gs.gain, when, off, [[0, 0], [0.001, ev.amp * 0.35], [0.05, ev.amp * 0.003, 'e'], [ev.dur, 0]]);
    s.connect(bp2); bp2.connect(gs); gs.connect(g);
    sc.out(v, g, { pan: ev.pan || 0, rev: 0.45 });
  };

  BUILD.tom = (sc, ev, when, off, v) => {
    const o = sc.osc(v, 'sine', ev.f);
    applyEnv(o.frequency, when, off, [[0, ev.f * 1.5], [0.06, ev.f, 'e'], [ev.dur, ev.f * 0.85, 'e']]);
    const g = sc.gain(v, 0);
    applyEnv(g.gain, when, off, [[0, 0], [0.002, ev.amp], [ev.dur * 0.96, ev.amp * 0.001, 'e'], [ev.dur, 0]]);
    o.connect(g);
    const s = sc.noiseSrc(v, 'pink', ev.seed, off), bp = sc.filter(v, 'bandpass', ev.f * 4, 1.5), gn = sc.gain(v, 0);
    applyEnv(gn.gain, when, off, [[0, 0], [0.001, ev.amp * 0.5], [0.08, ev.amp * 0.003, 'e'], [ev.dur, 0]]);
    s.connect(bp); bp.connect(gn); gn.connect(g);
    sc.out(v, g, { pan: ev.pan || 0, rev: 0.35 });
  };

  BUILD.tick = (sc, ev, when, off, v) => { // woody clock tick
    const s = sc.noiseSrc(v, 'white', ev.seed, off);
    const bp = sc.filter(v, 'bandpass', 2600, 9), bp2 = sc.filter(v, 'bandpass', 5200, 6);
    const g = sc.gain(v, 0);
    s.connect(bp); s.connect(bp2); bp.connect(g); bp2.connect(g);
    applyEnv(g.gain, when, off, [[0, 0], [0.0008, ev.amp * 3], [0.03, ev.amp * 0.01, 'e'], [ev.dur, 0]]);
    sc.out(v, g, { pan: ev.pan || 0, rev: 0.25, dly: 0.12 });
  };

  BUILD.hat = (sc, ev, when, off, v) => {
    const s = sc.noiseSrc(v, 'white', ev.seed, off);
    const hp = sc.filter(v, 'highpass', 7000, 0.8);
    const g = sc.gain(v, 0);
    s.connect(hp); hp.connect(g);
    applyEnv(g.gain, when, off, [[0, 0], [0.001, ev.amp], [ev.dur * 0.9, ev.amp * 0.005, 'e'], [ev.dur, 0]]);
    sc.out(v, g, { pan: ev.pan || 0, rev: 0.15 });
  };

  BUILD.snare = (sc, ev, when, off, v) => {
    const s = sc.noiseSrc(v, 'white', ev.seed, off);
    const bp = sc.filter(v, 'bandpass', 2200, 0.7), g = sc.gain(v, 0);
    s.connect(bp); bp.connect(g);
    applyEnv(g.gain, when, off, [[0, 0], [0.001, ev.amp], [ev.dur * 0.9, ev.amp * 0.003, 'e'], [ev.dur, 0]]);
    const o = sc.osc(v, 'triangle', 190), go = sc.gain(v, 0);
    applyEnv(o.frequency, when, off, [[0, 240], [0.04, 180, 'e'], [ev.dur, 170, 'e']]);
    applyEnv(go.gain, when, off, [[0, 0], [0.001, ev.amp * 0.6], [0.07, ev.amp * 0.005, 'e'], [ev.dur, 0]]);
    o.connect(go); go.connect(g);
    sc.out(v, g, { pan: -0.1, rev: 0.3 });
  };

  // ================================================================ public API
  const AC = window.AudioContext || window.webkitAudioContext;
  let ctx = null, score = null, playing = false, pauseTimer = 0, latS = 0.03;
  const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));

  // Output latency estimate (seconds between ctx.currentTime and what is audible right now).
  function measureLatency() {
    let lat = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
    if (ctx.getOutputTimestamp) {
      try {
        const ts = ctx.getOutputTimestamp();
        if (ts && ts.contextTime > 0 && ts.performanceTime > 0) {
          const est = ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
          const l = ctx.currentTime - est;
          if (l > -0.02 && l < 0.6) lat = Math.max(0, l);
        }
      } catch (_) { /* ignore */ }
    }
    latS += (clamp(lat, 0, 0.5) - latS) * 0.05;
    return latS;
  }

  // Build the live score off the tap: after the next frame is painted, the sample data (normally
  // pre-built during the title, else generated now in slices), then the graph in a task of its own and
  // the reverb IR in another (see armSoon). The film's first 1.6 s are silent; once built, the next
  // update(T) anchors the score at T (liveSeek), wherever the film is by then.
  let building = false, tapAt = -1e9, lastT = 0;
  // Give a deferred reverb its IR (the one long task left: ~30 ms on a laptop, ~120 ms on a phone).
  // Near the start of the film it waits until ~0.8 s after the tap: past the fullscreen switch and
  // the first frames, while the screen is still black and silent (the first sound is at 1.6 s).
  function armSoon() {
    const wait = lastT < 0.6 ? Math.max(0, 800 - (performance.now() - tapAt)) : 0;
    setTimeout(() => { if (score) score.armReverb(); }, wait);
  }
  function afterFrame(fn) {
    let done = false;
    const go = () => { if (!done) { done = true; setTimeout(fn, 0); } };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(go);
    setTimeout(go, 120); // no frames (hidden tab)
  }
  function kickBuild() {
    if (score || building || !ctx) return;
    building = true;
    const c = ctx;
    afterFrame(() => withData(c.sampleRate, isMobile, (data) => setTimeout(() => {
      building = false;
      if (score || ctx !== c) return;
      try {
        score = new Score(c, { offline: false, lite: isMobile, mobile: isMobile, data, deferReverb: true });
      } catch (err) { console.error('[audio] build failed', err); return; }
      armSoon();
      needSeek = true;
    }, 0)));
  }
  // Pre-build the sample data while the title is up (idle, sliced), for the most common output rate.
  // Not in automation mode (#still), where the page is driven by tools.
  const PREBUILD_SR = 48000;
  if (AC && !new URLSearchParams(location.hash.replace(/^#/, '')).has('still')) {
    const pre = () => { if (!ctx) withData(PREBUILD_SR, isMobile); };
    const arm = () => setTimeout(() => {
      const D = U.debug;
      if (D && typeof D.whenReady === 'function') D.whenReady().then(() => setTimeout(pre, 400));
      else setTimeout(pre, 1500);
    }, 0);
    if (document.readyState === 'complete') arm(); else window.addEventListener('load', arm, { once: true });
  }

  // Re-anchor so that film time T is audible now, fade out what is sounding and rebuild the
  // voices in progress at T.
  function liveSeek(T, w0) {
    const sc = score;
    if (!sc) { needSeek = true; kickBuild(); return; } // anchored by the first update() after the build
    // the caller's T was taken at w0; film time has moved on while we built/flushed nodes
    if (w0 !== undefined) T += clamp((performance.now() - w0) / 1000, 0, 0.5);
    sc.used = true;
    const now = ctx.currentTime;
    const pg = sc.pgain.gain;
    pg.cancelScheduledValues(0);
    pg.setValueAtTime(pg.value, now);
    pg.setTargetAtTime(0, now, 0.008);
    sc.killAll(now + 0.05);
    const start = now + 0.06;
    for (let i = 0; i < 3; i++) measureLatency();
    sc.seek(T, now - latS, start);
    pg.setTargetAtTime(1, start, 0.03);
    sc.scheduleTo(T + LOOKAHEAD + latS);
    errS = 0;
    needSeek = ctx.state !== 'running';
  }
  let errS = 0, needSeek = false;

  const API = {
    init() {
      if (!AC) return;
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (_) { /* ignore */ }
      if (!ctx) {
        try {
          ctx = new AC(isMobile ? { latencyHint: 'playback' } : undefined);
        } catch (_) {
          ctx = new AC();
        }
      }
      if (ctx.state !== 'running') { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); }
      // iOS unlock: play one silent sample inside the gesture
      try {
        const b = ctx.createBuffer(1, 1, ctx.sampleRate), s = ctx.createBufferSource();
        s.buffer = b; s.connect(ctx.destination); s.start(0);
      } catch (_) { /* ignore */ }
      // build the graph right after the gesture (see kickBuild), while the film loads or starts
      tapAt = performance.now();
      kickBuild();
    },
    start(T) {
      if (!ctx) API.init();
      if (!ctx) return;
      clearTimeout(pauseTimer);
      if (ctx.state !== 'running') { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); }
      playing = true;
      const w0 = performance.now();
      lastT = Math.max(0, T || 0);
      if (score && score.used) { score.flushFx(true); armSoon(); } // a fresh start: no reverb/delay tail from the previous position
      liveSeek(lastT, w0);
    },
    update(T) {
      if (!playing || !score) return;
      if (ctx.state !== 'running') {
        // suspended by the system (or still resuming): try again, and re-anchor once it runs
        if (ctx.state !== 'closed') { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); }
        needSeek = true;
        return;
      }
      if (needSeek) { liveSeek(T); return; }
      const sc = score;
      // servo: keep at(T) on the audible output time (latency changes, clock drift)
      const heard = ctx.currentTime - measureLatency();
      const err = heard - (sc.at(T) + sc.pre);
      if (Math.abs(err) > 0.35) { liveSeek(T); return; }
      errS += (err - errS) * 0.08;
      if (Math.abs(errS) > 0.006) {
        const d = clamp(errS * 0.08, -0.0015, 0.0015);
        sc.anchorCtx += d; errS -= d;
      }
      const horizonT = sc.anchorT + (ctx.currentTime + LOOKAHEAD - sc.anchorCtx);
      sc.scheduleTo(Math.max(horizonT, T));
    },
    pause() {
      if (!ctx) return;
      playing = false;
      if (!score) return;
      const now = ctx.currentTime, pg = score.pgain.gain;
      pg.cancelScheduledValues(0);
      pg.setValueAtTime(pg.value, now);
      pg.setTargetAtTime(0, now, 0.012);
      clearTimeout(pauseTimer);
      pauseTimer = setTimeout(() => {
        if (playing) return;
        score.killAll(ctx.currentTime);
        const p = ctx.suspend(); if (p && p.catch) p.catch(() => {});
        setTimeout(() => { if (!playing && score) score.prepareFx(); }, 700); // after the pause dim settles
      }, 75);
    },
    resume(T) {
      if (!ctx) { API.start(T); return; }
      clearTimeout(pauseTimer);
      if (ctx.state !== 'running') { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); }
      playing = true;
      lastT = Math.max(0, T || 0);
      liveSeek(T);
    },
    stop() {
      if (!ctx || !score) { playing = false; return; }
      playing = false;
      const now = ctx.currentTime, pg = score.pgain.gain;
      pg.cancelScheduledValues(0);
      pg.setValueAtTime(pg.value, now);
      pg.setTargetAtTime(0, now, 0.08);
      clearTimeout(pauseTimer);
      pauseTimer = setTimeout(() => {
        if (playing) return;
        score.killAll(ctx.currentTime);
        const p = ctx.suspend(); if (p && p.catch) p.catch(() => {});
        setTimeout(() => { if (!playing && score) score.prepareFx(); }, 700); // after the pause dim settles
      }, 500);
    },
    // Render [T0, T1) of the score offline (same scheduler, OfflineAudioContext). -> Promise<AudioBuffer>
    renderOffline(T0, T1, sampleRate, opts) {
      T0 = T0 || 0; T1 = T1 === undefined ? DUR : T1;
      const sr = sampleRate || 44100;
      const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const len = Math.max(1, Math.ceil((T1 - T0) * sr));
      const octx = new OAC(2, len, sr);
      const o = opts || {};
      let only = null;
      if (o.stem) { // 'hits' | 'beds' | 'pads' | 'patterns' | 'type:a,b' (analysis renders)
        const HITS = ['boom', 'knock', 'blast', 'crack', 'crash', 'brass', 'ring', 'taiko', 'bell', 'shimmer', 'mallet'];
        const types = /^type:/.test(o.stem) ? o.stem.slice(5).split(',') : null; // e.g. 'type:knock,crash'
        only = types ? (e) => types.includes(e.type)
          : o.stem === 'patterns' ? (e) => !!e.prio
          : o.stem === 'hits' ? (e) => !e.prio && HITS.includes(e.type)
            : o.stem === 'pads' ? (e) => !e.prio && e.type === 'pad'
              : (e) => !e.prio && !HITS.includes(e.type) && e.type !== 'pad';
      }
      const key = dataKey(sr, !!o.lite), data = dataSet && dataSet.key === key ? dataSet : drain(genData(sr, !!o.lite));
      const sc = new Score(octx, { offline: true, lite: !!o.lite, raw: !!o.raw, mobile: !!o.mobile, only, tap: o.tap, data });
      sc.pgain.gain.value = 1;
      sc.seek(T0, 0, 0);
      const STEP = 0.5, AHEAD = 1.0;
      sc.scheduleTo(T0 + AHEAD);
      const total = T1 - T0;
      if (typeof octx.suspend === 'function') {
        for (let t = STEP; t < total - 1e-6; t += STEP) {
          const tt = t;
          octx.suspend(tt).then(() => { sc.scheduleTo(T0 + tt + AHEAD); octx.resume(); });
        }
      } else {
        sc.scheduleTo(T1);
      }
      const p = octx.startRendering();
      return (p && p.then ? p : new Promise((res) => { octx.oncomplete = (e) => res(e.renderedBuffer); })).then((buf) => {
        API.lastOffline = { built: sc.built, dropped: sc.dropped, errors: sc.errors };
        return buf;
      });
    },
    // introspection for tools/audio-render.mjs
    debug: {
      get ctx() { return ctx; },
      get score() { return score; },
      get playing() { return playing; },
      get latency() { return latS; },
      tempo: Tempo,
      harmony: HARM,
      events: EVENTS,
      patternEvents,
      chordAt,
      maxEventDur: () => MAX_EVENT_DUR,
      activeVoices: () => (score ? score.activeCount() : 0),
      // audible time minus the audio time film time T is scheduled at (s); ~0 when in sync
      syncError: (T) => (score && ctx ? ctx.currentTime - latS - (score.at(T) + score.pre) : 0),
      meter() {
        if (!score) return null;
        if (!score._an) { score._an = ctx.createAnalyser(); score._an.fftSize = 2048; score.outGain.connect(score._an); }
        const a = new Float32Array(2048);
        score._an.getFloatTimeDomainData(a);
        let s = 0, pk = 0;
        for (const x of a) { s += x * x; pk = Math.max(pk, Math.abs(x)); }
        return { rms: Math.sqrt(s / a.length), peak: pk };
      },
    },
  };
  U.audio = API;
})();
