#!/usr/bin/env node
// Build-time pipeline for src/data/plates.js (continental drift data). Not part of the bundle: build.mjs only
// takes *.js files. Node >= 18, no dependencies.
//
//   node --max-old-space-size=8000 src/data/tools-plates.mjs [--work /tmp/plates-work] [--out src/data/plates.js]
//
// Sources (downloaded into the work dir on first run, then cached):
//   Merdith, A. S., Williams, S. E., Collins, A. S., Tetley, M. G., Mulder, J. A., Blades, M. L., Young, A.,
//     Armistead, S. E., Cannon, J., Zahirovic, S., Müller, R. D. (2021). Extending full-plate tectonic models into
//     deep time: Linking the Neoproterozoic and the Phanerozoic. Earth-Science Reviews 214, 103477.
//     Rotation file 1000_0_rotfile_Merdith_etal.rot + static polygons, via the GPlates plate-model-manager
//     repository (https://repo.gplates.org/webdav/pmm/merdith2021/). CC BY 4.0.
//   Natural Earth 1:10m land polygons (public domain), https://github.com/nvkelso/natural-earth-vector.
//
// Steps:
//   1. Parse static polygons (plate id + valid time) and rasterise them and the present-day land at 4096x2048
//      equirect; land pixels without a polygon take the nearest plate id.
//   2. Group the ~480 model plates into BLOCKS (below; chosen by a film-time-weighted clustering of the full
//      model's motions, then hand-tuned so cratons that travel separately before Pangaea stay separate).
//   3. Per block: soft land mask (0.5 at the coastline, ramp RAMP tile texels each side), restricted to the block's
//      region (ocean near land belongs to the nearest block), averaged to the 2048x1024 tile, cropped,
//      PNG-style row-filtered and deflated. Bounding cap = minimal enclosing cap of the non-zero texels.
//   4. Per block and per 5 Myr: robust (Cauchy IRLS) Wahba / Davenport q-method fit of one rigid rotation to the
//      full-model motion of all the block's land, plates fading in/out with their polygon ages; then Gaussian
//      smoothing in time with sigma proportional to the film's Myr-per-second (identity forced at 0 Ma), int16.
//   5. Write plates.js: its hand-written runtime code is kept, only the META / MASKS / ROTS constants change.
//
// Env knobs: RAMP (4), FADE (20 Myr), RC (0.15), SIGT (0.2 film s).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const WORK = path.resolve(opt('--work', '/tmp/plates-work'));
const OUT = path.resolve(opt('--out', path.join(HERE, 'plates.js')));
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1) + 's', ...a);

// ================================================================ blocks: [name, [model plate ids]]
const BLOCKS = [
  ["North America", [101,16107,16103,16113,16124,16106,16122,16123,16121,16112,18105,16140,16130,16141,18108,44101,43301,18106,16105,44102,154,1731,104,44103,42201,107,208,210,213,211,216,209,204,212,178,43202,43200,43207,43206,43201,231,176,275,274,185,42200,122,120,124,123,205,141,16101,18103,121,18102,16102,103,215,18104,16104,105,43300,42300,42101,184,108,16110,233,911,109,16111,901,42100,42102]],
  ["Greenland", [102,309,311,404,373]],
  ["South America", [201,229,230,22011,22032,22043,22034,22041,22602,225,226,228,227,22042,22601,235,234,237,255,254,253,224,222,202]],
  ["Sao Francisco", [22054,206,22055,22052,22053,290,2901,283,28011,28800,28900,8201]],
  ["West Africa", [714,77142,721,706,718,77149,77147,77146,329,720,70822,3202,3201,70844,707,3062,3063,708,306,3061,3203]],
  ["Central Africa", [701,712,77016,77013,77012,77011,77017,713,77521,7752,7750,709,77531,5901,5902,5903,5905,5904,715,323,3307,3323,307,3446,346,308,77141,347,59161,328,760,522,77145,5032,77144,525,5033,334,508,340,337,322,7701]],
  ["Southern Africa", [77030,77031,77032]],
  ["Madagascar", [702,77021,77022,77023,704]],
  ["Arabia", [503,50302,5911,5912,5909,5906,5908,5907,5913,59061,5031,5034]],
  ["India", [501,5011,5021,5014,502,517,518,554]],
  ["Europe", [302,301,390,551,330,319,349,338,44100,521,520,526,303]],
  ["Western Europe", [304,305,315,344,375,374]],
  ["Siberia", [401,372,43101,623,622,43102,42400,4012,4101,625,627,626,43400,43204,43205,43203,4100]],
  ["Kazakhstan", [468,458,450,4593,4602,464,459,467,466,463,465,461,460,462,4671,4672,4592,4591,4661,4601,4673,4662]],
  ["North China", [601,630,631,628,6013,649,648,629,430,455,453,454,621,619,624]],
  ["South China", [602,6025,604,6023,6024,60402,60201,60405,60404,60406,60403,60401,60301]],
  ["Tarim-Mongolia", [580,4561,456,457,451]],
  ["Cimmeria", [505,606,616,50602,506,591,590,50601,61601,61602,603,7250,607,687]],
  ["Sundaland", [614,647,61401,61403,61406,61413,67301,68601,67352,673,657,67350,61407,646,645,64701,738,564,60302,674,563,735,677,736,61405,668,737,678,669,65702,651]],
  ["Australia", [801,8011,676,664,652,615,684,675,61501,698,61502,681,878,8013,836,860,845,844,838,825,823,821,827,697,692,699,688,847,659,830,69701,69702,566,565,667,983,608,670,679,680,982,567]],
  ["East Antarctica", [802,8021,80121,8030,8026,8022,8024,8025,8023]],
  ["West Antarctica", [804,814,8181,815]],
  ["Zealandia", [806,813]],
  ["Indo-Antarctica", [803,8031]],
];

// ================================================================ sources
const PMM = 'https://repo.gplates.org/webdav/pmm/merdith2021';
const NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_land.geojson';
const ROT_FILE = path.join(WORK, 'merdith2021/Rotations/Rotations/1000_0_rotfile_Merdith_etal.rot');
const STATIC_FILE = path.join(WORK, 'merdith2021/StaticPolygons/StaticPolygons/shapes_static_polygons_Merdith_etal.gpml');
const LAND_FILE = path.join(WORK, 'ne_10m_land.geojson');

async function download(url, file) {
  if (fs.existsSync(file)) return;
  log('download', url);
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + ': HTTP ' + r.status);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}
// minimal zip extraction (stored / deflate entries), via the central directory
function unzip(file, dir) {
  const b = fs.readFileSync(file);
  let e = b.length - 22;
  while (e >= 0 && b.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('not a zip: ' + file);
  const n = b.readUInt16LE(e + 10);
  let p = b.readUInt32LE(e + 16);
  for (let k = 0; k < n; k++) {
    const method = b.readUInt16LE(p + 10), csize = b.readUInt32LE(p + 20), nl = b.readUInt16LE(p + 28), xl = b.readUInt16LE(p + 30), cl = b.readUInt16LE(p + 32);
    const lho = b.readUInt32LE(p + 42), name = b.toString('utf8', p + 46, p + 46 + nl);
    p += 46 + nl + xl + cl;
    if (name.endsWith('/')) continue;
    const ds = lho + 30 + b.readUInt16LE(lho + 26) + b.readUInt16LE(lho + 28);
    const raw = b.subarray(ds, ds + csize);
    const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (!data) throw new Error('zip method ' + method + ' in ' + name);
    const f = path.join(dir, name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, data);
  }
}
async function fetchSources() {
  for (const z of ['Rotations', 'StaticPolygons']) {
    const zf = path.join(WORK, 'merdith2021', z + '.zip');
    await download(`${PMM}/${z}.zip`, zf);
    if (!fs.existsSync(z === 'Rotations' ? ROT_FILE : STATIC_FILE)) unzip(zf, path.join(WORK, 'merdith2021', z));
  }
  await download(NE, LAND_FILE);
}

// ================================================================ quaternions + GPlates rotation model (ECEF frame)
const D2R = Math.PI / 180;
function qFromPole(lat, lon, angDeg) {
  const a = angDeg * D2R, la = lat * D2R, lo = lon * D2R;
  const s = Math.sin(a / 2);
  return [Math.cos(a / 2), s * Math.cos(la) * Math.cos(lo), s * Math.cos(la) * Math.sin(lo), s * Math.sin(la)];
}
function qMul(a, b) {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}
const qConj = (q) => [q[0], -q[1], -q[2], -q[3]];
const qDot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
function qNorm(q) {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
function qSlerp(a, b, t) {
  let d = qDot(a, b);
  if (d < 0) { b = [-b[0], -b[1], -b[2], -b[3]]; d = -d; }
  if (d > 0.9995) return qNorm([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t]);
  const th = Math.acos(d), s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb, a[3] * wa + b[3] * wb];
}
function qToMat(q) { // row-major 3x3
  const [w, x, y, z] = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}
// .rot lines: moving time lat lon angle fixed [comment]; sequences slerped; plate 999 / moving==fixed = comments
function parseRot(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const seqs = new Map();
  let cur = null;
  for (const ln of lines) {
    const m = ln.match(/^\s*(\d+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+(\d+)/);
    if (!m) continue;
    const mov = +m[1], t = +m[2], lat = +m[3], lon = +m[4], ang = +m[5], fix = +m[6];
    if (mov === 999 || mov === fix) continue; // comment lines: do not break the current sequence
    if (!seqs.has(mov)) seqs.set(mov, []);
    const arr = seqs.get(mov);
    if (!cur || cur.mov !== mov || cur.fixed !== fix || (cur.ts.length && t < cur.ts[cur.ts.length - 1])) {
      cur = { mov, fixed: fix, ts: [], qs: [] };
      arr.push(cur);
    }
    cur.ts.push(t);
    cur.qs.push(qFromPole(lat, lon, ang));
  }
  return seqs;
}
function makeModel(seqs) {
  const memo = new Map();
  function rel(mov, t) {
    const arr = seqs.get(mov);
    if (!arr) return null;
    let best = null;
    for (const s of arr) {
      const n = s.ts.length;
      if (t >= s.ts[0] - 1e-9 && t <= s.ts[n - 1] + 1e-9) { best = s; break; }
    }
    if (!best) { // outside the model's range: clamp to the nearest sequence end
      let bd = Infinity;
      for (const s of arr) {
        const n = s.ts.length;
        const d = t < s.ts[0] ? s.ts[0] - t : t - s.ts[n - 1];
        if (d < bd) { bd = d; best = s; }
      }
      const n = best.ts.length;
      return { fixed: best.fixed, q: t < best.ts[0] ? best.qs[0] : best.qs[n - 1], clamped: true };
    }
    const ts = best.ts;
    let i = 0;
    while (i < ts.length - 2 && t > ts[i + 1]) i++;
    if (ts.length === 1) return { fixed: best.fixed, q: best.qs[0] };
    const ta = ts[i], tb = ts[i + 1];
    const u = tb > ta ? (t - ta) / (tb - ta) : 0;
    return { fixed: best.fixed, q: qSlerp(best.qs[i], best.qs[i + 1], Math.max(0, Math.min(1, u))) };
  }
  function total(pid, t, depth = 0) {
    if (pid === 0) return [1, 0, 0, 0];
    const key = pid + '@' + t;
    if (memo.has(key)) return memo.get(key);
    if (depth > 60) throw new Error('rotation loop at ' + pid);
    const r = rel(pid, t);
    const q = r ? qNorm(qMul(total(r.fixed, t, depth + 1), r.q)) : [1, 0, 0, 0];
    memo.set(key, q);
    return q;
  }
  return { total };
}

// ================================================================ Davenport q-method (Wahba's problem)
function jacobiEig4(A) { // symmetric 4x4 -> {vals, vecs (columns)}
  const a = Float64Array.from(A), v = new Float64Array(16);
  for (let i = 0; i < 4; i++) v[i * 5] = 1;
  for (let sweep = 0; sweep < 30; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += a[p * 4 + q] ** 2;
    if (off < 1e-22) break;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) {
      const apq = a[p * 4 + q]; if (Math.abs(apq) < 1e-30) continue;
      const th = (a[q * 4 + q] - a[p * 4 + p]) / (2 * apq);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 4; k++) { const akp = a[k * 4 + p], akq = a[k * 4 + q]; a[k * 4 + p] = c * akp - s * akq; a[k * 4 + q] = s * akp + c * akq; }
      for (let k = 0; k < 4; k++) { const apk = a[p * 4 + k], aqk = a[q * 4 + k]; a[p * 4 + k] = c * apk - s * aqk; a[q * 4 + k] = s * apk + c * aqk; }
      for (let k = 0; k < 4; k++) { const vkp = v[k * 4 + p], vkq = v[k * 4 + q]; v[k * 4 + p] = c * vkp - s * vkq; v[k * 4 + q] = s * vkp + c * vkq; }
    }
  }
  return { vals: [a[0], a[5], a[10], a[15]], vecs: v };
}
// best rotation R maximising tr(R^T B), B = sum a y x^T (y = R x). Returns {q (w,x,y,z), val}
function wahbaFit(B) {
  const Sx = [B[0] * 2, B[1] + B[3], B[2] + B[6], B[3] + B[1], B[4] * 2, B[5] + B[7], B[6] + B[2], B[7] + B[5], B[8] * 2];
  const sig = B[0] + B[4] + B[8];
  const z = [B[5] - B[7], B[6] - B[2], B[1] - B[3]];
  const K = [
    Sx[0] - sig, Sx[1], Sx[2], z[0],
    Sx[3], Sx[4] - sig, Sx[5], z[1],
    Sx[6], Sx[7], Sx[8] - sig, z[2],
    z[0], z[1], z[2], sig,
  ];
  const { vals, vecs } = jacobiEig4(K);
  let bi = 0; for (let i = 1; i < 4; i++) if (vals[i] > vals[bi]) bi = i;
  const e = [vecs[0 * 4 + bi], vecs[1 * 4 + bi], vecs[2 * 4 + bi], vecs[3 * 4 + bi]];
  const qa = qNorm([e[3], e[0], e[1], e[2]]), qb = qConj(qa);
  const score = (q) => { const R = qToMat(q); let s = 0; for (let k = 0; k < 9; k++) s += R[k] * B[k]; return s; };
  const sa = score(qa), sb = score(qb);
  return sa >= sb ? { q: qa, val: sa } : { q: qb, val: sb };
}

// ================================================================ distance transforms (x periodic)
const INF = 1e20;
function dt1d(f, n, d, v, z) { // Felzenszwalb-Huttenlocher 1D squared distance
  let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let r = v[k];
    let s = ((f[q] + q * q) - (f[r] + r * r)) / (2 * q - 2 * r);
    while (s <= z[k]) { k--; r = v[k]; s = ((f[q] + q * q) - (f[r] + r * r)) / (2 * q - 2 * r); }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; const r = v[k]; d[q] = (q - r) * (q - r) + f[r]; }
}
function edt(src, W, H, pad = 64) { // distance (px) to the nearest src=1 pixel
  const g = new Float32Array(W * H);
  const n = Math.max(W + 2 * pad, H);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = src[y * W + x] ? 0 : INF;
    dt1d(f, H, d, v, z);
    for (let y = 0; y < H; y++) g[y * W + x] = d[y];
  }
  const out = new Float32Array(W * H);
  const L = W + 2 * pad;
  for (let y = 0; y < H; y++) {
    for (let i = 0; i < L; i++) f[i] = g[y * W + ((i - pad + W) % W)];
    dt1d(f, L, d, v, z);
    for (let x = 0; x < W; x++) out[y * W + x] = Math.sqrt(d[x + pad]);
  }
  return out;
}
function sdf(mask, W, H, pad = 64) { // + inside, - outside (pixel-centre corrected)
  const inv = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) inv[i] = mask[i] ? 0 : 1;
  const dOut = edt(mask, W, H, pad), dIn = edt(inv, W, H, pad);
  const s = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) s[i] = mask[i] ? dIn[i] - 0.5 : -(dOut[i] - 0.5);
  return s;
}

// ================================================================ GPML static polygons -> [{pid, name, from, to, rings}]
function parseGpml(file) {
  let txt = fs.readFileSync(file);
  if (file.endsWith('z')) txt = zlib.gunzipSync(txt);
  txt = txt.toString('utf8');
  const feats = [];
  const re = /<gml:featureMember>([\s\S]*?)<\/gml:featureMember>/g;
  let m;
  while ((m = re.exec(txt))) {
    const f = m[1];
    const pidM = f.match(/<gpml:reconstructionPlateId>\s*<gpml:ConstantValue>\s*<gpml:value>(\d+)<\/gpml:value>/);
    const name = (f.match(/<gml:name>([^<]*)<\/gml:name>/) || [])[1] || '';
    const vt = f.match(/<gml:validTime>[\s\S]*?<gml:begin>[\s\S]*?<gml:timePosition[^>]*>([^<]*)<[\s\S]*?<gml:end>[\s\S]*?<gml:timePosition[^>]*>([^<]*)</);
    // times in Ma; GPlates writes open ends as http://gplates.org/times/distantPast | distantFuture (or +-inf)
    const parseT = (s) => (/distantFuture|-inf/i.test(s) ? -1e9 : /distantPast|inf/i.test(s) ? 1e9 : +s);
    const rings = [];
    const rr = /<gml:(exterior|interior)>[\s\S]*?<gml:posList[^>]*>([^<]*)<\/gml:posList>/g;
    let r;
    while ((r = rr.exec(f))) rings.push({ ext: r[1] === 'exterior', pts: r[2].trim().split(/\s+/).map(Number) });
    feats.push({ pid: pidM ? +pidM[1] : -1, name, from: vt ? parseT(vt[1]) : 1e9, to: vt ? parseT(vt[2]) : -1e9, rings });
  }
  return feats;
}

// ================================================================ rasterisation (equirect, pixel centres, row 0 = north)
function fillRings(rings, W, H, cb) { // even-odd fill; rings: [lon,lat,...] (lon may run beyond +-180)
  let minLat = 90, maxLat = -90, minLon = 1e9, maxLon = -1e9;
  for (const r of rings) for (let i = 0; i < r.length; i += 2) {
    if (r[i + 1] < minLat) minLat = r[i + 1]; if (r[i + 1] > maxLat) maxLat = r[i + 1];
    if (r[i] < minLon) minLon = r[i]; if (r[i] > maxLon) maxLon = r[i];
  }
  const y0 = Math.max(0, Math.floor((90 - maxLat) / 180 * H - 0.5)), y1 = Math.min(H - 1, Math.ceil((90 - minLat) / 180 * H - 0.5));
  const offs = [0];
  if (minLon < -180) offs.push(360);
  if (maxLon > 180) offs.push(-360);
  const xs = [];
  for (let y = y0; y <= y1; y++) {
    const lat = 90 - (y + 0.5) * 180 / H;
    xs.length = 0;
    for (const r of rings) {
      const n = r.length / 2;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const ya = r[2 * j + 1], yb = r[2 * i + 1];
        if ((ya > lat) !== (yb > lat)) { const xa = r[2 * j], xb = r[2 * i]; xs.push(xa + (lat - ya) / (yb - ya) * (xb - xa)); }
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (const off of offs) {
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const la = xs[k] + off, lb = xs[k + 1] + off;
        let xa = Math.ceil((la + 180) / 360 * W - 0.5), xb = Math.ceil((lb + 180) / 360 * W - 0.5) - 1;
        if (xa < 0) xa = 0; if (xb > W - 1) xb = W - 1;
        for (let x = xa; x <= xb; x++) cb(y * W + x);
      }
    }
  }
}
function unwrapLatLon(pts) { // [lat,lon,...] -> continuous [lon,lat,...]; rings around a pole closed via the pole
  const n = pts.length / 2;
  const out = [];
  let prev = null, sumLat = 0;
  for (let i = 0; i < n; i++) {
    const lat = pts[2 * i], lon = pts[2 * i + 1];
    let L = lon;
    if (prev !== null) { let d = lon - prev; while (d > 180) d -= 360; while (d < -180) d += 360; L = out[out.length - 2] + d; }
    prev = lon;
    out.push(L, lat);
    sumLat += lat;
  }
  let d = pts[1] - pts[2 * (n - 1) + 1];
  while (d > 180) d -= 360; while (d < -180) d += 360;
  const endL = out[out.length - 2] + d;
  const k = Math.round((endL - out[0]) / 360);
  if (k !== 0) {
    const pole = sumLat >= 0 ? 90 : -90;
    out.push(endL, out[out.length - 1]);
    out.push(endL, pole, out[0], pole);
  }
  let mn = 1e9, mx = -1e9;
  for (let i = 0; i < out.length; i += 2) { mn = Math.min(mn, out[i]); mx = Math.max(mx, out[i]); }
  const sh = Math.round((mn + mx) / 2 / 360) * 360;
  if (sh) for (let i = 0; i < out.length; i += 2) out[i] -= sh;
  return Float64Array.from(out);
}
function rasterLand(W, H) {
  const land = new Uint8Array(W * H);
  const ne = JSON.parse(fs.readFileSync(LAND_FILE, 'utf8'));
  for (const f of ne.features) {
    const g = f.geometry;
    for (const poly of g.type === 'Polygon' ? [g.coordinates] : g.coordinates) {
      fillRings(poly.map((ring) => Float64Array.from(ring.flat())), W, H, (i) => { land[i] ^= 1; });
    }
  }
  return land;
}
function rasterPlates(feats, W, H) {
  const pid = new Int32Array(W * H).fill(-1);
  // bigger features first so small ones win on overlaps
  const valid = feats.filter((f) => f.to <= 0.001 && f.from >= 0 && f.rings.length && f.pid >= 0);
  const area = (f) => { const r = unwrapLatLon(f.rings[0].pts); let a = 1e9, b = -1e9, c = 1e9, d = -1e9; for (let i = 0; i < r.length; i += 2) { a = Math.min(a, r[i]); b = Math.max(b, r[i]); c = Math.min(c, r[i + 1]); d = Math.max(d, r[i + 1]); } return (b - a) * (d - c); };
  valid.sort((a, b) => area(b) - area(a));
  const tmp = new Uint8Array(W * H);
  for (const f of valid) {
    const touched = [];
    fillRings(f.rings.map((r) => unwrapLatLon(r.pts)), W, H, (i) => { if (!tmp[i]) touched.push(i); tmp[i] ^= 1; });
    for (const i of touched) { if (tmp[i]) pid[i] = f.pid; tmp[i] = 0; }
  }
  // pixels without a polygon: nearest labelled pixel (BFS)
  const q = new Int32Array(W * H); let qh = 0, qt = 0;
  for (let i = 0; i < W * H; i++) if (pid[i] >= 0) q[qt++] = i;
  while (qh < qt) {
    const i = q[qh++], x = i % W, y = (i / W) | 0;
    const nb = [y * W + ((x + 1) % W), y * W + ((x + W - 1) % W), y > 0 ? i - W : -1, y < H - 1 ? i + W : -1];
    for (const j of nb) if (j >= 0 && pid[j] < 0) { pid[j] = pid[i]; q[qt++] = j; }
  }
  return pid;
}

// ================================================================ film timeline (for time-weighted smoothing)
const TL = (() => {
  const window = { U: {} };
  new Function('window', fs.readFileSync(path.join(HERE, '../core/timeline.js'), 'utf8'))(window);
  return window.U.timeline;
})();

// ================================================================ main
await fetchSources();
const W = 4096, H = 2048, TW = 2048, TH = 1024;
const RAMP = +(process.env.RAMP || 4); // land ramp half-width in tile texels (m: 0 -> 1 over 2*RAMP texels)
const STEP = 5, MAXMA = 1000;
const feats = parseGpml(STATIC_FILE);
log('static polygons', feats.length);
const land = rasterLand(W, H);
const pid = rasterPlates(feats, W, H);
log('rasters');
if (argv.includes('--dump')) { fs.writeFileSync(path.join(WORK, 'tool_land.bin'), land); fs.writeFileSync(path.join(WORK, 'tool_pid.bin'), Buffer.from(pid.buffer)); }
const blocks = BLOCKS.map(([name, members]) => ({ name, members }));
const N = blocks.length;
const blockOf = new Map();
blocks.forEach((b, i) => b.members.forEach((p) => blockOf.set(p, i)));

// ---------------------------------------------------------------- owner map (land: block of plate; sea near land: nearest)
const owner = new Int8Array(W * H).fill(-1);
{
  const q = new Int32Array(W * H); let qh = 0, qt = 0;
  const dist = new Uint8Array(W * H).fill(255);
  for (let i = 0; i < W * H; i++) if (land[i]) { const b = blockOf.get(pid[i]); if (b === undefined) throw new Error('unassigned plate ' + pid[i]); owner[i] = b; dist[i] = 0; q[qt++] = i; }
  const LIM = 2 * RAMP * 2 + 8; // px at 4096
  while (qh < qt) {
    const i = q[qh++], x = i % W, y = (i / W) | 0, d = dist[i] + 1;
    if (d > LIM) continue;
    const nb = [y * W + ((x + 1) % W), y * W + ((x + W - 1) % W), y > 0 ? i - W : -1, y < H - 1 ? i + W : -1];
    for (const j of nb) if (j >= 0 && dist[j] === 255) { dist[j] = d; owner[j] = owner[i]; q[qt++] = j; }
  }
}
log('owner map');

// ---------------------------------------------------------------- land signed distance -> soft mask (4096)
const sdLand = sdf(land, W, H, 64); // px at 4096, + inside
const mLand = new Float32Array(W * H);
for (let i = 0; i < W * H; i++) mLand[i] = Math.min(1, Math.max(0, 0.5 + (sdLand[i] / 2) / (2 * RAMP)));
log('land sdf');

// ---------------------------------------------------------------- per-block masks, cropped
const DIL = 1.5; // block region dilation (tile texels): 1 inside and up to DIL-1 beyond, 0.5 at DIL, 0 at DIL+1
const crops = [];
for (let b = 0; b < N; b++) {
  // circular x-extent and y-extent of owner==b at 4096
  const colHas = new Uint8Array(W); let y0 = H, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (owner[y * W + x] === b) { colHas[x] = 1; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  // largest empty circular gap
  let bestGap = 0, gapEnd = 0, run = 0;
  for (let k = 0; k < 2 * W; k++) { if (colHas[k % W]) run = 0; else { run++; if (run > bestGap && run <= W) { bestGap = run; gapEnd = k; } } }
  const M = 8; // px margin at 4096
  let x0, w;
  if (bestGap > 2 * M + 16) { x0 = ((gapEnd + 1) % W) - M; w = W - bestGap + 2 * M; } else { x0 = 0; w = W; }
  x0 = ((x0 % W) + W) % W;
  // make crop even-aligned in 4096 so it maps to whole tile texels
  if (x0 & 1) { x0 -= 1; w += 1; }
  if (w & 1) w += 1;
  if (w > W) { x0 = 0; w = W; }
  let cy0 = Math.max(0, y0 - M) & ~1, cy1 = Math.min(H, y1 + 1 + M); if ((cy1 - cy0) & 1) cy1 = Math.min(H, cy1 + 1);
  const h = cy1 - cy0;
  const full = w === W;
  // region mask in crop
  const reg = new Uint8Array(w * h);
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) reg[yy * w + xx] = owner[(cy0 + yy) * W + ((x0 + xx) % W)] === b ? 1 : 0;
  const dOut = edt(reg, w, h, full ? 64 : 0);
  // tile-resolution crop
  const tw = w / 2, th = h / 2, tx0 = x0 / 2, ty0 = cy0 / 2;
  const out = new Uint8Array(tw * th);
  let sum = [0, 0, 0], any = 0;
  for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
    let acc = 0;
    for (let k = 0; k < 4; k++) {
      const xx = 2 * tx + (k & 1), yy = 2 * ty + (k >> 1);
      const gi = (cy0 + yy) * W + ((x0 + xx) % W);
      const d = reg[yy * w + xx] ? 0 : (dOut[yy * w + xx] - 0.5) / 2; // tile texels outside region
      const bm = Math.min(1, Math.max(0, 0.5 + (DIL - d) / 2 + 0.25)); // 1 up to ~DIL-0.5 then ramps out
      acc += Math.min(mLand[gi], bm);
    }
    const v = Math.round(acc / 4 * 255);
    out[ty * tw + tx] = v;
  }
  crops.push({ b, x0: tx0, y0: ty0, w: tw, h: th, data: out });
}
log('block masks');

// ---------------------------------------------------------------- caps (present-day, our frame), from tile crops
const ourV = (lat, lon) => [Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon)];
const caps = [], cents = [], capR = [];
for (const c of crops) {
  const s = [0, 0, 0]; let A = 0, sl = [0, 0, 0], AL = 0;
  const pts = [];
  for (let ty = 0; ty < c.h; ty++) {
    const lat = Math.PI / 2 - (c.y0 + ty + 0.5) / TH * Math.PI;
    for (let tx = 0; tx < c.w; tx++) {
      const v = c.data[ty * c.w + tx]; if (!v) continue;
      const lon = -Math.PI + (((c.x0 + tx) % TW) + 0.5) / TW * 2 * Math.PI;
      const p = ourV(lat, lon), a = Math.cos(lat);
      for (let k = 0; k < 3; k++) s[k] += a * p[k];
      A += a; pts.push(p);
      if (v >= 128) { for (let k = 0; k < 3; k++) sl[k] += a * p[k]; AL += a; }
    }
  }
  let l = Math.hypot(...s); let cc = s.map((x) => x / l);
  // minimal enclosing cap of the block's non-zero texels (Badoiu-Clarkson iterations on boundary texels), much
  // tighter than the centroid cap for blocks with far islands
  const bnd = [];
  { let k = 0;
    for (let ty = 0; ty < c.h; ty++) for (let tx = 0; tx < c.w; tx++) {
      if (!c.data[ty * c.w + tx]) continue;
      const p = pts[k++];
      const z = (xx, yy) => xx < 0 || yy < 0 || xx >= c.w || yy >= c.h || !c.data[yy * c.w + xx];
      if (z(tx - 1, ty) || z(tx + 1, ty) || z(tx, ty - 1) || z(tx, ty + 1)) bnd.push(p);
    } }
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const farthest = (cv, set) => { let bd = 2, bp = set[0]; for (const p of set) { const d = dot3(cv, p); if (d < bd) { bd = d; bp = p; } } return [bp, Math.acos(Math.max(-1, Math.min(1, bd)))]; };
  // For caps < 90 deg the optimal centre is the direction of the minimum-norm point of the convex hull of the
  // points (KKT: p.x >= |x|^2 for all p); found with Gilbert's algorithm.
  { let x = [0, 0, 0]; for (const p of bnd) { x[0] += p[0]; x[1] += p[1]; x[2] += p[2]; } x = x.map((v) => v / bnd.length);
    for (let it = 0; it < 20000; it++) {
      const [sp] = farthest(x, bnd);
      const xx = dot3(x, x), gap = xx - dot3(sp, x);
      if (gap < 1e-9) break;
      const d = [x[0] - sp[0], x[1] - sp[1], x[2] - sp[2]], dd = dot3(d, d);
      const g = Math.min(1, dot3(x, d) / dd);
      x = [x[0] - g * d[0], x[1] - g * d[1], x[2] - g * d[2]];
    }
    const xl = Math.hypot(...x);
    if (xl > 0.02) { const cv = x.map((v) => v / xl); if (farthest(cv, bnd)[1] < farthest(cc, bnd)[1]) cc = cv; } }
  // caps near/over 90 deg: Badoiu-Clarkson iterations (keep the best centre seen)
  { let cv = cc, [fp, r] = farthest(cv, bnd), best = cv, bestR = r;
    for (let it = 1; it <= 4000 && r < Math.PI * 0.95; it++) {
      const d = dot3(cv, fp), a = Math.acos(Math.max(-1, Math.min(1, d))) / (it + 1);
      let pr = [fp[0] - cv[0] * d, fp[1] - cv[1] * d, fp[2] - cv[2] * d]; const pl = Math.hypot(...pr); if (pl < 1e-12) break; pr = pr.map((x) => x / pl);
      cv = [0, 1, 2].map((j) => cv[j] * Math.cos(a) + pr[j] * Math.sin(a)); const cl = Math.hypot(...cv); cv = cv.map((x) => x / cl);
      [fp, r] = farthest(cv, bnd);
      if (r < bestR) { bestR = r; best = cv; }
    }
    cc = best; }
  let maxAng = 0; for (const p of pts) { const d = Math.acos(Math.min(1, p[0] * cc[0] + p[1] * cc[1] + p[2] * cc[2])); if (d > maxAng) maxAng = d; }
  maxAng += 5 * Math.PI / TH; // texel margin: bilinear + mip footprint (lod ~2)
  caps.push([cc[0], cc[1], cc[2], maxAng >= Math.PI ? -2 : Math.cos(maxAng)]);
  capR.push(maxAng);
  l = Math.hypot(...sl); cents.push(sl.map((x) => x / l));
}
log('caps', capR.map((r, i) => blocks[i].name.slice(0, 6) + ' ' + (r * 180 / Math.PI).toFixed(1)).join(', '), '| mean padded passes', capR.reduce((s, r) => s + (1 - Math.cos(Math.min(Math.PI, r + 0.12))) / 2, 0).toFixed(2));

// ---------------------------------------------------------------- rotations: per-plate moments, film-weighted fits
const fromAge = new Map();
for (const f of feats) if (f.to <= 0.001) fromAge.set(f.pid, Math.max(fromAge.get(f.pid) || 0, f.from));
const plates = new Map();
for (let y = 0; y < H; y++) {
  const lat = (90 - (y + 0.5) * 180 / H) * Math.PI / 180, a = Math.cos(lat);
  for (let x = 0; x < W; x++) {
    const i = y * W + x; if (!land[i]) continue;
    const p = pid[i];
    const lon = (-180 + (x + 0.5) * 360 / W) * Math.PI / 180;
    const v = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
    if (!plates.has(p)) plates.set(p, { pid: p, A: 0, S: new Float64Array(9), b: blockOf.get(p) });
    const P = plates.get(p); P.A += a;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) P.S[r * 3 + c] += a * v[r] * v[c];
  }
}
const model = makeModel(parseRot(ROT_FILE));
const NT = MAXMA / STEP + 1;
const qs = Array.from({ length: N }, () => []); // ECEF quats present->paleo
const FADE = +(process.env.FADE || 20);
const ROBUST_C = +(process.env.RC || 0.15); // chord distance scale for Cauchy IRLS (0 = plain least squares)
const plist = [...plates.values()];
const byBlock = Array.from({ length: N }, () => []);
for (const P of plist) byBlock[P.b].push(P);
const prevQ = Array.from({ length: N }, () => [1, 0, 0, 0]);
const fitStats = Array.from({ length: N }, () => ({ inlier: 0, n: 0 }));
for (let k = 0; k < NT; k++) {
  const t = k * STEP;
  for (let b = 0; b < N; b++) {
    const mem = byBlock[b].map((P) => {
      const from = fromAge.get(P.pid) ?? 4000;
      const u = Math.min(1, Math.max(0, (from + FADE - t) / (2 * FADE)));
      const e = Math.max(0.01, u * u * (3 - 2 * u));
      const R = qToMat(model.total(P.pid, t));
      const RS = new Float64Array(9);
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) { let s = 0; for (let j = 0; j < 3; j++) s += R[r * 3 + j] * P.S[j * 3 + c]; RS[r * 3 + c] = s; }
      return { P, e, RS };
    });
    let q = prevQ[b];
    const iters = ROBUST_C > 0 ? 12 : 1;
    let inl = 0;
    for (let it = 0; it < iters; it++) {
      const Rq = qToMat(q);
      const Bm = new Float64Array(9);
      inl = 0;
      for (const m of mem) {
        let w = m.e;
        if (ROBUST_C > 0) {
          let tr = 0; for (let j = 0; j < 9; j++) tr += Rq[j] * m.RS[j];
          const d2 = Math.max(0, 2 * (m.P.A - tr) / m.P.A); // mean squared chord distance of this plate's land
          const f = 1 / (1 + d2 / (ROBUST_C * ROBUST_C));
          w *= f; inl += f * m.e * m.P.A;
        }
        for (let j = 0; j < 9; j++) Bm[j] += w * m.RS[j];
      }
      const nq = wahbaFit(Bm).q;
      q = qDot(nq, q) < 0 ? nq.map((x) => -x) : nq;
    }
    prevQ[b] = q;
    qs[b].push(q);
    const tot = mem.reduce((s, m) => s + m.e * m.P.A, 0);
    fitStats[b].inlier += inl / tot; fitStats[b].n++;
  }
}
log('fits'); fitStats.forEach((f, b) => console.log('  ', blocks[b].name.padEnd(18), 'mean robust inlier frac', (f.inlier / f.n).toFixed(3)));
// sign-align, smooth (sigma in Myr from film speed), convert to our frame
const Tof = (ma) => TL.timeOfYears(ma * 1e6);
const rate = (t) => { const a = Math.max(0, t - 5), b = t + 5; const s = (Tof(a) - Tof(b)); return s > 1e-6 ? (b - a) / s : 1e4; }; // Myr per film second
const SIGT = +(process.env.SIGT || 0.2);
const sigmaOf = (t) => Math.min(16, Math.max(3, SIGT * rate(t)));
const qsS = [];
for (let b = 0; b < N; b++) {
  const Q = qs[b];
  for (let k = 1; k < NT; k++) if (qDot(Q[k], Q[k - 1]) < 0) Q[k] = Q[k].map((x) => -x);
  const get = (k) => { if (k < 0) { const q = Q[-k]; return [q[0], -q[1], -q[2], -q[3]]; } return Q[Math.min(NT - 1, k)]; };
  const S = [];
  for (let k = 0; k < NT; k++) {
    const t = k * STEP, sg = sigmaOf(t) / STEP, rr = Math.ceil(3 * sg);
    const acc = [0, 0, 0, 0]; let ws = 0;
    for (let j = -rr; j <= rr; j++) {
      const w = Math.exp(-0.5 * (j / sg) ** 2), q = get(k + j);
      const s = qDot(q, Q[k]) < 0 ? -1 : 1;
      for (let c = 0; c < 4; c++) acc[c] += w * s * q[c]; ws += w;
    }
    let q = qNorm(acc);
    if (k === 0) q = [1, 0, 0, 0];
    S.push(q);
  }
  qsS.push(S.map((q) => [q[0], q[1], q[3], -q[2]])); // ECEF (x,y,z) -> ours (x, z, -y)
}
// quantise int16: layout [t][block][w,x,y,z]
const rotI16 = new Int16Array(NT * N * 4);
for (let k = 0; k < NT; k++) for (let b = 0; b < N; b++) {
  let q = qsS[b][k]; if (k > 0) { const p = qsS[b][k - 1]; if (qDot(p, q) < 0) q = q.map((x) => -x), qsS[b][k] = q; }
  for (let c = 0; c < 4; c++) rotI16[(k * N + b) * 4 + c] = Math.round(q[c] * 32767);
}
log('rotations');

// ---------------------------------------------------------------- encode masks: PNG-style row filters + deflate
function filterRows(c) {
  const { w, h, data } = c;
  const out = new Uint8Array((w + 1) * h);
  const row = (y) => data.subarray(y * w, y * w + w);
  const cand = [new Uint8Array(w), new Uint8Array(w), new Uint8Array(w), new Uint8Array(w), new Uint8Array(w)];
  for (let y = 0; y < h; y++) {
    const r = row(y), up = y ? row(y - 1) : new Uint8Array(w);
    for (let x = 0; x < w; x++) {
      const a = x ? r[x - 1] : 0, bb = up[x], cc = x ? up[x - 1] : 0;
      const p = a + bb - cc, pa = Math.abs(p - a), pb = Math.abs(p - bb), pc = Math.abs(p - cc);
      const pr = pa <= pb && pa <= pc ? a : pb <= pc ? bb : cc;
      cand[0][x] = r[x]; cand[1][x] = r[x] - a; cand[2][x] = r[x] - bb; cand[3][x] = r[x] - ((a + bb) >> 1); cand[4][x] = r[x] - pr;
    }
    let best = 0, bs = Infinity;
    for (let f = 0; f < 5; f++) { let s = 0; for (let x = 0; x < w; x++) { const v = cand[f][x]; s += v < 128 ? v : 256 - v; } if (s < bs) { bs = s; best = f; } }
    out[y * (w + 1)] = best; out.set(cand[best], y * (w + 1) + 1);
  }
  return out;
}
const parts = crops.map(filterRows);
const rawAll = Buffer.concat(parts.map((p) => Buffer.from(p)));
const defl = zlib.deflateSync(rawAll, { level: 9, memLevel: 9 });
log('mask raw', rawAll.length, 'deflated', defl.length);


// ================================================================ emit: keep the runtime code of the existing plates.js
const meta = {
  count: N, maxMa: MAXMA, step: STEP, tile: [TW, TH], ramp: RAMP,
  names: blocks.map((b) => b.name),
  crops: crops.map((c) => [c.x0, c.y0, c.w, c.h]),
  caps: caps.map((c) => c.map((x) => +x.toFixed(5))),
  centroids: cents.map((c) => c.map((x) => +x.toFixed(5))),
};
const b64 = (buf) => Buffer.from(buf.buffer ? Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength) : buf).toString('base64');
const wrap = (s, n = 120) => { const out = []; for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n)); return out.join('\\\n'); };
const tplFile = opt('--template', OUT);
let js = fs.readFileSync(tplFile, 'utf8');
const put = (re, val) => { if (!re.test(js)) throw new Error('template slot not found: ' + re); js = js.replace(re, () => val); };
put(/const META = (?:\/\*@META@\*\/null|\{.*?\});\n/s, 'const META = ' + JSON.stringify(meta) + ';\n');
put(/const MASKS = (?:\/\*@MASKS@\*\/)?'[^']*';\n/s, "const MASKS = '" + wrap(b64(defl)) + "';\n");
put(/const ROTS = (?:\/\*@ROTS@\*\/)?'[^']*';\n/s, "const ROTS = '" + wrap(b64(rotI16)) + "';\n");
fs.writeFileSync(OUT, js);
log('wrote', OUT, (js.length / 1024).toFixed(1) + ' KB, masks b64', (b64(defl).length / 1024).toFixed(1), 'KB');
