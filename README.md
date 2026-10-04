# Big Bang to Earth

A cinematic animation of about three minutes that runs from the Big Bang to the Earth of today. It covers the first plasma, cosmic dawn, the cosmic web, the Milky Way, the birth of the Solar System, the Theia impact, and continental drift up to the present-day map. A small counter in the bottom-right corner shows roughly how many years ago each moment happened. The film has a generative soundtrack.

**▶ Watch it: https://carlos-aws.github.io/big-bang-film/**

Click or tap "So it begins.." to start. The page goes fullscreen where the browser allows it. Click or tap again at any time to pause or resume.

## How it's made

`index.html` is the whole film in one self-contained file. It is rendered in real time with WebGL2, the sound is synthesized with Web Audio, and it needs no network requests or assets.

- `src/` holds the source: an engine and helpers (`core/`), one file per scene (`scenes/`), the Earth renderer (`earth/`), continental-drift data (`data/`) and the score (`audio/`).
- `node build.mjs` bundles `src/` into `index.html`.
- `CONTRACT.md` describes the scene API and the engine conventions.
- `tools/` holds the test and render tooling (puppeteer-core). Run `npm install` in `tools/` first.
  - `shot.mjs` renders deterministic stills.
  - `e2e.mjs` runs real-time end-to-end checks.

## Data credits

- Plate motions and the plate partition are derived from Merdith, A. S. et al. (2021), *Extending full-plate tectonic models into deep time: Linking the Neoproterozoic and the Phanerozoic*, Earth-Science Reviews 214, 103477, via EarthByte / GPlates. Licensed under CC BY 4.0. `src/data/tools-plates.mjs` documents how it was processed.
- Present-day coastlines come from Natural Earth 1:10m land (public domain).
