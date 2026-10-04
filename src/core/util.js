// Core namespace, math helpers and WebGL2 helpers shared by every module.
(function () {
  'use strict';
  const U = (window.U = window.U || {});

  // ---------------------------------------------------------------- scenes
  U.scenesById = U.scenesById || {};
  U.defineScene = function (def) {
    if (!def || !def.id) throw new Error('defineScene: missing id');
    U.scenesById[def.id] = def;
  };

  // ---------------------------------------------------------------- math
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const M = (U.math = {
    clamp,
    saturate: (x) => (x < 0 ? 0 : x > 1 ? 1 : x),
    mix: (a, b, t) => a + (b - a) * t,
    linstep: (e0, e1, x) => clamp((x - e0) / (e1 - e0), 0, 1),
    smoothstep(e0, e1, x) {
      const t = clamp((x - e0) / (e1 - e0), 0, 1);
      return t * t * (3 - 2 * t);
    },
    smootherstep(e0, e1, x) {
      const t = clamp((x - e0) / (e1 - e0), 0, 1);
      return t * t * t * (t * (t * 6 - 15) + 10);
    },
    easeInCubic: (t) => t * t * t,
    easeOutCubic: (t) => 1 - Math.pow(1 - t, 3),
    easeInOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    easeInOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
    easeInExpo: (t) => (t <= 0 ? 0 : Math.pow(2, 10 * t - 10)),
    easeOutExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
    // Piecewise-linear lookup in [[x, y], ...] (x ascending).
    keyframes(keys, x) {
      if (x <= keys[0][0]) return keys[0][1];
      for (let i = 1; i < keys.length; i++) {
        if (x <= keys[i][0]) {
          const a = keys[i - 1], b = keys[i];
          return a[1] + (b[1] - a[1]) * ((x - a[0]) / (b[0] - a[0]));
        }
      }
      return keys[keys.length - 1][1];
    },
    // Deterministic PRNG (mulberry32). rng() -> [0,1)
    rng(seed) {
      let a = seed >>> 0;
      return function () {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    },
    // Column-major 4x4 matrices (Float32Array(16)), GL convention.
    perspective(out, fovyRad, aspect, near, far) {
      const f = 1 / Math.tan(fovyRad / 2), nf = 1 / (near - far);
      out.fill(0);
      out[0] = f / aspect; out[5] = f;
      out[10] = (far + near) * nf; out[11] = -1;
      out[14] = 2 * far * near * nf;
      return out;
    },
    lookAt(out, eye, target, up) {
      let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
      let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
      let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
      l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
      const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
      out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
      out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
      out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
      out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
      out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
      out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
      out[15] = 1;
      return out;
    },
    multiply(out, a, b) {
      const r = new Float32Array(16);
      for (let c = 0; c < 4; c++)
        for (let rr = 0; rr < 4; rr++)
          r[c * 4 + rr] = a[rr] * b[c * 4] + a[4 + rr] * b[c * 4 + 1] + a[8 + rr] * b[c * 4 + 2] + a[12 + rr] * b[c * 4 + 3];
      out.set(r);
      return out;
    },
  });

  // ---------------------------------------------------------------- WebGL2
  const SETTERS = {};
  function initSetters(gl) {
    if (SETTERS.ready) return;
    const f = (fn) => fn;
    SETTERS[gl.FLOAT] = f((g, l, v, n) => (n > 1 || typeof v !== 'number' ? g.uniform1fv(l, v) : g.uniform1f(l, v)));
    SETTERS[gl.FLOAT_VEC2] = f((g, l, v) => g.uniform2fv(l, v));
    SETTERS[gl.FLOAT_VEC3] = f((g, l, v) => g.uniform3fv(l, v));
    SETTERS[gl.FLOAT_VEC4] = f((g, l, v) => g.uniform4fv(l, v));
    SETTERS[gl.FLOAT_MAT2] = f((g, l, v) => g.uniformMatrix2fv(l, false, v));
    SETTERS[gl.FLOAT_MAT3] = f((g, l, v) => g.uniformMatrix3fv(l, false, v));
    SETTERS[gl.FLOAT_MAT4] = f((g, l, v) => g.uniformMatrix4fv(l, false, v));
    const int1 = (g, l, v, n) => (n > 1 || typeof v !== 'number' ? g.uniform1iv(l, v) : g.uniform1i(l, v));
    for (const t of [gl.INT, gl.BOOL, gl.SAMPLER_2D, gl.SAMPLER_CUBE, gl.SAMPLER_3D, gl.SAMPLER_2D_ARRAY,
      gl.INT_SAMPLER_2D, gl.UNSIGNED_INT_SAMPLER_2D, gl.UNSIGNED_INT])
      SETTERS[t] = t === gl.UNSIGNED_INT ? (g, l, v, n) => (n > 1 || typeof v !== 'number' ? g.uniform1uiv(l, v) : g.uniform1ui(l, v)) : int1;
    SETTERS[gl.INT_VEC2] = SETTERS[gl.BOOL_VEC2] = (g, l, v) => g.uniform2iv(l, v);
    SETTERS[gl.INT_VEC3] = SETTERS[gl.BOOL_VEC3] = (g, l, v) => g.uniform3iv(l, v);
    SETTERS[gl.INT_VEC4] = SETTERS[gl.BOOL_VEC4] = (g, l, v) => g.uniform4iv(l, v);
    SETTERS.ready = true;
  }

  function shader(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    return sh;
  }
  function compileError(gl, sh, src, type, label) {
    if (gl.getShaderParameter(sh, gl.COMPILE_STATUS)) return null;
    const log = gl.getShaderInfoLog(sh);
    const lines = src.split('\n').map((l, i) => String(i + 1).padStart(4) + ': ' + l).join('\n');
    return new Error(`[${label || 'shader'}] ${type === gl.VERTEX_SHADER ? 'VS' : 'FS'} compile error:\n${log}\n${lines}`);
  }

  // Programs whose compile/link status has not been queried yet. Querying blocks until the
  // driver is done, so U.gl.program() never does: the first use() / set() / uniforms / attribs
  // (or the engine, once KHR_parallel_shader_compile reports completion) finalizes it.
  const pending = new Set();
  const byProgram = new WeakMap();
  function hookDelete(gl) {
    if (gl.__uDeleteHooked) return;
    gl.__uDeleteHooked = true;
    const del = gl.deleteProgram;
    gl.deleteProgram = function (p) {
      const P = p && byProgram.get(p);
      if (P) P._dispose();
      return del.call(gl, p);
    };
  }

  // Compile pacing. Even with KHR_parallel_shader_compile, Chrome may compile on the GPU process's
  // main thread, and while it does no frame reaches the screen: a burst of programs would freeze
  // the page for the whole burst. So programs go to the driver one at a time (the next once the
  // last has linked), and a freeze lasts one program's compile at most. A program is finalized
  // as soon as it has linked, before the next one goes out: then nothing else is compiling, so
  // its status queries don't wait, and its first use() needs none. U.gl.compiled() moves the
  // programs it waits for ahead of the ones nobody waits for; finalize() submits at once.
  const queue = [], flying = [];
  let pumpTimer = 0;
  function parallelExt(gl) {
    if (G._pc === undefined) G._pc = gl.getExtension('KHR_parallel_shader_compile');
    return G._pc;
  }
  function pump(gl) {
    for (let i = flying.length - 1; i >= 0; i--) {
      if (!flying[i].done()) continue;
      flying[i]._settle();
      flying.splice(i, 1);
      G.progressAt = performance.now();
    }
    // (a hidden page has no frames to protect, and its timers are throttled: submit everything)
    const all = document.hidden;
    while (queue.length && (all || !flying.length)) {
      const P = queue.shift();
      if (P._submit()) flying.push(P);
    }
    if (flying.length) schedule(gl);
  }
  // (polled as often as timers allow, ~4 ms: the GPU idles from a link's end to the next submit)
  function schedule(gl) {
    if (!pumpTimer) pumpTimer = setTimeout(() => { pumpTimer = 0; pump(gl); }, 1);
  }

  const fbComplete = {};

  const G = (U.gl = {
    // Fullscreen-triangle vertex shader. Provides vUv in [0,1]^2.
    FULLSCREEN_VS: `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`,

    // Compile + link. Returns { program, uniforms: {name: {loc,type,size}}, attribs: {name: loc},
    // use(), set(name, value), setAll(obj), finalize() }. Unknown uniform names are ignored
    // silently (the GLSL compiler strips unused uniforms).
    // Compilation is asynchronous: errors are thrown by the first use()/set()/uniforms/attribs,
    // or by finalize() — call it inside a try if you want to catch a compile error yourself.
    // Create all of a scene's programs before using any of them so the driver can compile them
    // in parallel.
    program(gl, vsSrc, fsSrc, label) {
      initSetters(gl);
      hookDelete(gl);
      const ext = parallelExt(gl);
      const program = gl.createProgram();
      let vs = null, fs = null, submitted = false;
      // compile + link (asynchronous in the driver); false if already done or deleted
      function submit() {
        if (submitted || P.disposed) return false;
        submitted = true;
        vs = shader(gl, gl.VERTEX_SHADER, vsSrc);
        fs = shader(gl, gl.FRAGMENT_SHADER, fsSrc);
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        return true;
      }
      let uniforms = null, attribs = null, error = null;
      function dropShaders() {
        if (vs) { gl.deleteShader(vs); gl.deleteShader(fs); vs = fs = null; }
      }
      function finalize() {
        if (uniforms) return;
        if (error) throw error;
        submit();
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
          // (it stays pending: the engine reports the failure for the program's scene)
          error = compileError(gl, vs, vsSrc, gl.VERTEX_SHADER, label) || compileError(gl, fs, fsSrc, gl.FRAGMENT_SHADER, label) ||
            new Error(`[${label || 'program'}] link error: ${gl.getProgramInfoLog(program)}`);
          dropShaders();
          throw error;
        }
        pending.delete(P);
        dropShaders();
        const u = {};
        const nU = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < nU; i++) {
          const info = gl.getActiveUniform(program, i);
          const name = info.name.replace(/\[0\]$/, '');
          u[name] = { loc: gl.getUniformLocation(program, info.name), type: info.type, size: info.size };
        }
        const a = {};
        const nA = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES);
        for (let i = 0; i < nA; i++) {
          const info = gl.getActiveAttrib(program, i);
          a[info.name] = gl.getAttribLocation(program, info.name);
        }
        attribs = a;
        uniforms = u;
      }
      const P = {
        program, label,
        owner: G.owner,
        get uniforms() { if (!uniforms) finalize(); return uniforms; },
        get attribs() { if (!attribs) finalize(); return attribs; },
        finalize() { finalize(); return P; },
        use() { if (!uniforms) finalize(); gl.useProgram(program); return P; },
        set(name, value) {
          if (!uniforms) finalize();
          const u = uniforms[name];
          if (u && value !== undefined) SETTERS[u.type](gl, u.loc, value, u.size);
          return P;
        },
        setAll(obj) { for (const k in obj) P.set(k, obj[k]); return P; },
        // true once the driver has finished with it (or it was deleted); never blocks
        done() {
          if (P.disposed || uniforms || error) return true;
          return submitted && (!ext || gl.getProgramParameter(program, ext.COMPLETION_STATUS_KHR) !== false);
        },
        _submit: submit,
        _settle() { if (!P.disposed) try { finalize(); } catch (err) { /* thrown again by use() */ } },
        _dispose() { P.disposed = true; pending.delete(P); if (!uniforms && !error) dropShaders(); },
      };
      pending.add(P);
      byProgram.set(program, P);
      if (ext) { queue.push(P); pump(gl); } else submit();
      return P;
    },

    // EXT_texture_filter_anisotropic + its max level (capped at 8), queried once: like any
    // synchronous GL query, a first getExtension() waits for pending shader compiles.
    anisotropy(gl) {
      if (G._aniso === undefined) {
        const ext = gl.getExtension('EXT_texture_filter_anisotropic');
        G._aniso = ext ? { ext, max: Math.min(8, gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT)) } : null;
      }
      return G._aniso;
    },

    // Resolves once the driver has finished compiling `progs` (at once without
    // KHR_parallel_shader_compile), so a bake can use them without blocking the page. They go
    // ahead of the programs nobody waits for, behind those earlier callers wait for. (It gives
    // up when no program at all has linked for 20 s; the first use() then waits for the driver.)
    async compiled(gl, progs) {
      if (!parallelExt(gl)) return;
      progs = progs.filter((P) => P && !P.done());
      const mine = new Set(progs);
      const earlier = queue.filter((P) => P._wanted && !mine.has(P));
      const rest = queue.filter((P) => !P._wanted && !mine.has(P));
      for (const P of progs) P._wanted = true;
      queue.length = 0;
      queue.push(...earlier, ...progs, ...rest);
      pump(gl);
      const t0 = performance.now();
      while (!gl.isContextLost() && progs.some((P) => !P.done()) &&
        performance.now() - Math.max(t0, G.progressAt) < 20000) {
        await new Promise((r) => setTimeout(r, 8));
      }
    },

    // Engine hooks. `owner` tags programs created while a scene initializes;
    // pendingPrograms() lists programs that have not been finalized yet (or failed to);
    // progressAt is when the compile queue last saw a program link.
    owner: null,
    pendingPrograms: () => Array.from(pending),
    progressAt: 0,

    // Draw a fullscreen triangle with the currently bound program.
    drawFullscreen(gl) {
      if (!G._emptyVao) G._emptyVao = gl.createVertexArray();
      gl.bindVertexArray(G._emptyVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
    },

    // Static buffer helper. data: Float32Array etc.
    buffer(gl, data, target, usage) {
      const b = gl.createBuffer();
      target = target || gl.ARRAY_BUFFER;
      gl.bindBuffer(target, b);
      gl.bufferData(target, data, usage || gl.STATIC_DRAW);
      gl.bindBuffer(target, null);
      return b;
    },

    // Build a VAO. attrs: [{ loc, buffer, size, type?, stride?, offset?, divisor?, normalized?, integer? }]
    vao(gl, attrs, indexBuffer) {
      const v = gl.createVertexArray();
      gl.bindVertexArray(v);
      for (const a of attrs) {
        if (a.loc === undefined || a.loc < 0) continue;
        gl.bindBuffer(gl.ARRAY_BUFFER, a.buffer);
        gl.enableVertexAttribArray(a.loc);
        if (a.integer) gl.vertexAttribIPointer(a.loc, a.size, a.type || gl.INT, a.stride || 0, a.offset || 0);
        else gl.vertexAttribPointer(a.loc, a.size, a.type || gl.FLOAT, !!a.normalized, a.stride || 0, a.offset || 0);
        if (a.divisor) gl.vertexAttribDivisor(a.loc, a.divisor);
      }
      if (indexBuffer) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      return v;
    },

    // 2D texture from an image/canvas/ImageData or typed array.
    // opts: { width, height, data, internalFormat, format, type, filter: 'linear'|'nearest',
    //         wrap: 'clamp'|'repeat'|'mirror' or [wrapS, wrapT], mipmap: bool, flipY: bool }
    texture(gl, source, opts) {
      opts = opts || {};
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, !!opts.flipY);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      const ifmt = opts.internalFormat || gl.RGBA8, fmt = opts.format || gl.RGBA, type = opts.type || gl.UNSIGNED_BYTE;
      if (source && !ArrayBuffer.isView(source)) gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, fmt, type, source);
      else gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, opts.width, opts.height, 0, fmt, type, source || null);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      const wrapOf = (w) => (w === 'repeat' ? gl.REPEAT : w === 'mirror' ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE);
      const wraps = Array.isArray(opts.wrap) ? opts.wrap : [opts.wrap, opts.wrap];
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapOf(wraps[0]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapOf(wraps[1]));
      const lin = opts.filter !== 'nearest';
      if (opts.mipmap) {
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, lin ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_NEAREST);
        const aniso = G.anisotropy(gl);
        if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.ext.TEXTURE_MAX_ANISOTROPY_EXT, aniso.max);
      } else {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, lin ? gl.LINEAR : gl.NEAREST);
      }
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, lin ? gl.LINEAR : gl.NEAREST);
      gl.bindTexture(gl.TEXTURE_2D, null);
      return tex;
    },

    // Offscreen render target. opts: { hdr: bool (default true), depth: bool, filter }
    // Returns { fb, tex, depth, w, h, hdr }.
    target(gl, w, h, opts) {
      opts = opts || {};
      const caps = U.gl.caps || {};
      const wantHdr = opts.hdr !== false && caps.hdr;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      if (wantHdr) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const filt = opts.filter === 'nearest' ? gl.NEAREST : gl.LINEAR;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filt);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filt);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      let depth = null;
      if (opts.depth) {
        depth = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
        gl.bindRenderbuffer(gl.RENDERBUFFER, null);
      }
      // The status query is a GPU round trip (it waits behind pending shader links), so ask once
      // per kind of target, and only for HDR ones: WebGL2 requires RGBA8 (+ DEPTH_COMPONENT24)
      // to be renderable.
      const kind = (wantHdr ? 'hdr' : 'ldr') + (opts.depth ? '+depth' : '');
      if (!(kind in fbComplete)) fbComplete[kind] = !wantHdr || gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      const ok = fbComplete[kind];
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      if (!ok && wantHdr) {
        gl.deleteFramebuffer(fb); gl.deleteTexture(tex); if (depth) gl.deleteRenderbuffer(depth);
        caps.hdr = false;
        return G.target(gl, w, h, Object.assign({}, opts, { hdr: false }));
      }
      return { fb, tex, depth, w, h, hdr: wantHdr };
    },

    deleteTarget(gl, t) {
      if (!t) return;
      gl.deleteFramebuffer(t.fb);
      gl.deleteTexture(t.tex);
      if (t.depth) gl.deleteRenderbuffer(t.depth);
    },

    bindTexture(gl, unit, tex, target) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(target || gl.TEXTURE_2D, tex);
    },
  });
})();
