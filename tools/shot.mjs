// Screenshot / perf harness. Builds the page, opens it in headless Chromium (real GPU) and
// renders exact film times.
//
//   node tools/shot.mjs --times 1,4.5,6 [--range 0:17:0.5] [--size 1280x720,390x844]
//        [--scenes bigbang,plasma] [--out /tmp/shots/x] [--q high|mid|low] [--sheet] [--perf]
//        [--label] [--html path/to/prebuilt.html] [--no-counter] [--reps N]
//
// --no-counter hides the HTML years counter (for pixel-identity diffs); --reps N measures --perf
// N times per frame and prints the minimum and the median.
//
// Writes <out>/<WxH>_t<time>.png (+ <out>/sheet_<WxH>.png with --sheet). Prints page console
// errors/warnings and exits with code 1 if any error was logged.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { build } = await import(path.join(ROOT, 'build.mjs'));

const args = process.argv.slice(2);
const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes(k);

let times = [];
if (get('--times')) times.push(...get('--times').split(',').map(Number));
if (get('--range')) {
  const [a, b, s] = get('--range').split(':').map(Number);
  for (let t = a; t <= b + 1e-9; t += s) times.push(Math.round(t * 1000) / 1000);
}
if (!times.length) times = [1];
const sizes = get('--size', '1280x720').split(',').map((s) => s.split('x').map(Number));
const out = path.resolve(get('--out', `/tmp/bb-shots/${Date.now()}`));
const q = get('--q', 'high');
fs.mkdirSync(out, { recursive: true });

let html = get('--html') ? path.resolve(get('--html')) : null;
if (!html) {
  html = path.join(out, 'page.html');
  build({ out: html, scenes: get('--scenes') ? get('--scenes').split(',') : null });
}

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-gpu', '--autoplay-policy=no-user-gesture-required'],
});
let errors = 0;
try {
  for (const [w, h] of sizes) {
    const page = await browser.newPage();
    page.on('console', (m) => {
      const ty = m.type();
      if (ty === 'error' || ty === 'warn' || ty === 'warning') {
        if (ty === 'error') errors++;
        console.log(`[page ${ty}] ${m.text()}`);
      }
    });
    page.on('pageerror', (e) => { errors++; console.log(`[page exception] ${e.message}`); });
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    await page.goto('file://' + html + `#still&q=${q}`);
    await page.waitForFunction('window.U && U.debug && U.debug.ready', { timeout: 180000 });
    if (has('--no-counter')) await page.addStyleTag({ content: '#counter { opacity: 0 !important; }' });
    const tag = `${w}x${h}`;
    const files = [];
    for (const t of times) {
      await page.evaluate((t, label) => {
        U.debug.renderAt(t);
        if (label) {
          let el = document.getElementById('__label');
          if (!el) {
            el = document.createElement('div');
            el.id = '__label';
            el.style.cssText = 'position:fixed;left:8px;top:6px;z-index:9;font:600 13px monospace;color:#0f0;text-shadow:0 0 3px #000';
            document.body.appendChild(el);
          }
          el.textContent = 'T=' + t.toFixed(2);
        }
      }, t, has('--label') || has('--sheet'));
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const file = path.join(out, `${tag}_t${t.toFixed(2).padStart(6, '0')}.png`);
      await page.screenshot({ path: file });
      files.push(file);
      if (has('--perf')) {
        const reps = Math.max(1, parseInt(get('--reps', '1'), 10) || 1);
        const runs = [];
        for (let i = 0; i < reps; i++) runs.push(await page.evaluate((t) => U.debug.perf(t, 30), t));
        const [sw, sh] = await page.evaluate(() => U.debug.sceneSize());
        const sorted = runs.slice().sort((a, b) => a - b);
        const stats = reps > 1 ? ` (min of ${reps}; median ${sorted[(reps - 1) >> 1].toFixed(2)})` : '';
        console.log(`perf ${tag} T=${t.toFixed(2)}: ${sorted[0].toFixed(2)} ms/frame${stats} (scene ${sw}x${sh})`);
      }
    }
    if (has('--sheet') && files.length > 1) {
      const cols = w >= h ? 4 : 6;
      const rows = Math.ceil(files.length / cols);
      const listFile = path.join(out, `.list_${tag}.txt`);
      // ffmpeg concat of stills -> tile filter
      const tmpDir = path.join(out, `.seq_${tag}`);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.mkdirSync(tmpDir);
      files.forEach((f, i) => fs.copyFileSync(f, path.join(tmpDir, `${String(i).padStart(4, '0')}.png`)));
      const tw = w >= h ? 480 : 200;
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(tmpDir, '%04d.png'),
        '-vf', `scale=${tw}:-1,tile=${cols}x${rows}:padding=4:color=0x333333`, '-frames:v', '1',
        path.join(out, `sheet_${tag}.png`)]);
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(listFile, { force: true });
      console.log(`sheet: ${path.join(out, `sheet_${tag}.png`)}`);
    }
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(`shots in ${out} (${times.length} times x ${sizes.length} sizes), page errors: ${errors}`);
process.exit(errors ? 1 : 0);
