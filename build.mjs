// Bundles src/ into one self-contained HTML file.
//   node build.mjs [--out index.html] [--scenes bigbang,plasma] [--no-audio]
// Each source file becomes its own <script> so an error in one file can't take down the others.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'src');
const listJs = (dir) => {
  const d = path.join(SRC, dir);
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.js')).sort().map((f) => `${dir}/${f}`) : [];
};

export function build({ out = path.join(ROOT, 'index.html'), scenes = null, audio = true } = {}) {
  const sceneFiles = listJs('scenes').filter((f) => !scenes || scenes.includes(path.basename(f, '.js')));
  const files = [
    'core/util.js', 'core/glsl.js', 'core/timeline.js',
    ...listJs('data'), ...listJs('earth'), ...sceneFiles,
    ...(audio ? listJs('audio') : []),
    'core/engine.js',
  ];
  const scripts = files.map((f) => {
    const code = fs.readFileSync(path.join(SRC, f), 'utf8').replace(/<\/script/gi, '<\\/script');
    return `<script>/* ${f} */\n${code}\n</script>`;
  }).join('\n');
  const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8').replace('<!-- SCRIPTS -->', () => scripts);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  return { out, files, bytes: Buffer.byteLength(html) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const r = build({
    out: get('--out') ? path.resolve(get('--out')) : undefined,
    scenes: get('--scenes') ? get('--scenes').split(',') : null,
    audio: !args.includes('--no-audio'),
  });
  console.log(`built ${path.relative(process.cwd(), r.out) || r.out} (${(r.bytes / 1024).toFixed(1)} KB, ${r.files.length} files)`);
}
