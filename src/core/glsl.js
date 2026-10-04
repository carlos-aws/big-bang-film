// Shared GLSL chunks. Build shaders as: U.glsl.header + U.glsl.common + yourSource
(function () {
  'use strict';
  const U = window.U;

  const header = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;
precision highp sampler3D;
`;

  const common = `
#ifndef U_COMMON
#define U_COMMON
const float PI = 3.14159265359;
const float TAU = 6.28318530718;

float saturate(float x) { return clamp(x, 0.0, 1.0); }
vec3 saturate(vec3 x) { return clamp(x, 0.0, 1.0); }
mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// ---- hashing (integer based, stable across GPUs) ----
uint uhash(uint x) {
  x ^= x >> 16; x *= 0x7feb352dU; x ^= x >> 15; x *= 0x846ca68bU; x ^= x >> 16;
  return x;
}
uint uhash(uvec2 v) { return uhash(v.x ^ uhash(v.y)); }
uint uhash(uvec3 v) { return uhash(v.x ^ uhash(v.y ^ uhash(v.z))); }
float hash11(float p) { return float(uhash(floatBitsToUint(p))) * (1.0 / 4294967296.0); }
float hash12(vec2 p) { return float(uhash(uvec2(ivec2(floor(p))))) * (1.0 / 4294967296.0); }
float hash13(vec3 p) { return float(uhash(uvec3(ivec3(floor(p))))) * (1.0 / 4294967296.0); }
vec2 hash22(vec2 p) { uint h = uhash(uvec2(ivec2(floor(p)))); return vec2(float(h), float(uhash(h))) * (1.0 / 4294967296.0); }
vec3 hash33(vec3 p) {
  uint h = uhash(uvec3(ivec3(floor(p))));
  uint h2 = uhash(h), h3 = uhash(h2);
  return vec3(float(h), float(h2), float(h3)) * (1.0 / 4294967296.0);
}
// Hash of an integer index (e.g. gl_VertexID / gl_InstanceID) -> [0,1)
float hashI(int i, int salt) { return float(uhash(uvec2(uint(i), uint(salt)))) * (1.0 / 4294967296.0); }

// ---- value noise ----
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i), n100 = hash13(i + vec3(1, 0, 0)), n010 = hash13(i + vec3(0, 1, 0)), n110 = hash13(i + vec3(1, 1, 0));
  float n001 = hash13(i + vec3(0, 0, 1)), n101 = hash13(i + vec3(1, 0, 1)), n011 = hash13(i + vec3(0, 1, 1)), n111 = hash13(i + vec3(1, 1, 1));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}

// ---- simplex noise 3D (Gustavson/Ashima), returns ~[-1,1] ----
vec4 _perm(vec4 x) { return mod(((x * 34.0) + 10.0) * x, 289.0); }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - 0.5;
  i = mod(i, 289.0);
  vec4 p = _perm(_perm(_perm(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  vec4 j = p - 49.0 * floor(p * (1.0 / 49.0));
  vec4 x_ = floor(j * (1.0 / 7.0));
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = (x_ * 2.0 + 0.5) / 7.0 - 1.0;
  vec4 y = (y_ * 2.0 + 0.5) / 7.0 - 1.0;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 g0 = vec3(a0.xy, h.x);
  vec3 g1 = vec3(a0.zw, h.y);
  vec3 g2 = vec3(a1.xy, h.z);
  vec3 g3 = vec3(a1.zw, h.w);
  vec4 norm = inversesqrt(vec4(dot(g0, g0), dot(g1, g1), dot(g2, g2), dot(g3, g3)));
  g0 *= norm.x; g1 *= norm.y; g2 *= norm.z; g3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m * m, vec4(dot(g0, x0), dot(g1, x1), dot(g2, x2), dot(g3, x3)));
}

// fBm of simplex noise. oct <= 8. Returns ~[-1,1].
float fbm(vec3 p, int oct) {
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    s += a * snoise(p);
    n += a;
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return s / n;
}
// Ridged fBm, returns [0,1].
float ridged(vec3 p, int oct) {
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    float r = 1.0 - abs(snoise(p));
    s += a * r * r;
    n += a;
    p = p * 2.07 + vec3(4.3, 1.1, 7.7);
    a *= 0.5;
  }
  return s / n;
}

// Blackbody color for temperature in Kelvin (1000..40000). Linear RGB, max component ~1.
vec3 blackbody(float k) {
  float t = clamp(k, 1000.0, 40000.0) / 100.0;
  float r = t <= 66.0 ? 1.0 : clamp(1.292936186 * pow(t - 60.0, -0.1332047592), 0.0, 1.0);
  float g = t <= 66.0 ? clamp(0.390081579 * log(t) - 0.631841444, 0.0, 1.0)
                      : clamp(1.129890861 * pow(t - 60.0, -0.0755148492), 0.0, 1.0);
  float b = t >= 66.0 ? 1.0 : (t <= 19.0 ? 0.0 : clamp(0.543206789 * log(t - 10.0) - 1.196254089, 0.0, 1.0));
  return pow(vec3(r, g, b), vec3(2.2));
}

vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

// Star field for a view direction. Stable under camera motion, anti-aliased.
//   dir: normalized view direction; scale: cells per radian (60..600, higher = more, smaller-spaced stars);
//   px: angular size of one pixel in radians (fovY / heightPx); density: 0..1 fraction of cells with a star;
//   seed: any float to decorrelate layers. Returns linear HDR radiance.
//   Typical: starLayer(d, 200., px, 0.02, 1.) + starLayer(d, 500., px, 0.008, 2.) -> ~3-4k stars on screen.
//   Visible star count ~ 2 * density * (scale * fov)^2, so keep density small at high scale.
vec3 starLayer(vec3 dir, float scale, float px, float density, float seed) {
  vec3 p = dir * scale + seed * 17.13;
  vec3 base = floor(p - 0.5);
  vec3 col = vec3(0.0);
  float sigma = max(px * scale * 0.85, 0.02); // star radius in cell units, >= ~0.85 px
  for (int k = 0; k < 8; k++) {
    vec3 cell = base + vec3(float(k & 1), float((k >> 1) & 1), float((k >> 2) & 1));
    vec3 h = hash33(cell + seed * 131.0);
    if (h.x > density) continue;
    vec3 sp = cell + 0.2 + 0.6 * hash33(cell * 1.7 + 11.0 + seed);
    vec3 sdir = normalize(sp - seed * 17.13);
    float d = length(dir - sdir) * scale;          // distance in cell units
    float mag = pow(h.y, 5.0);                      // few bright, many faint
    float bright = 0.02 + 0.12 * h.y * h.y + 12.0 * mag * mag;
    float w = exp(-0.5 * (d * d) / (sigma * sigma));
    vec3 tint = blackbody(mix(3200.0, 12000.0, h.z * h.z));
    col += tint * bright * w * (px * scale < 0.5 ? 1.0 : 0.5 / (px * scale));
  }
  return col;
}
#endif
`;

  U.glsl = {
    header,
    common,
    // Convenience: complete fragment shader source from a body (body declares its own in/out).
    frag: (body) => header + common + body,
    vert: (body) => header + common + body,
  };
})();
