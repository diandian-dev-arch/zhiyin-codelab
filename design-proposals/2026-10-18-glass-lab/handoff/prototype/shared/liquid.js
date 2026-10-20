/* ==========================================================
   Glass Lab · 液体背景（WebGL）
   两层：
   1) 水面：GPU 波动方程（高度 + 速度，乒乓帧缓冲），涟漪会扩散、反射、干涉、衰减
   2) 液层：缓慢流动的缎面色场，被水面法线折射，并统一受光
   交互克制：移动一段距离才落一滴、点击一圈大涟漪、空闲时偶尔自然落滴
   GL.createLiquid(canvas, { anchor })
   ========================================================== */
(function () {
  "use strict";

  const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

  // 波动方程一步：r = 高度，g = 速度
  const SIM = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uState;
uniform vec2 uTexel;
void main() {
  vec4 s = texture2D(uState, vUv);
  vec4 n = texture2D(uState, vUv + vec2(uTexel.x, 0.0)) + texture2D(uState, vUv - vec2(uTexel.x, 0.0)) +
           texture2D(uState, vUv + vec2(0.0, uTexel.y)) + texture2D(uState, vUv - vec2(0.0, uTexel.y));
  n *= 0.25;
  // 较小的回复系数 = 较慢的波速；少量粘滞抹平网格高频，波纹更圆润
  s.g += (n.r - s.r) * 1.15;
  s.g = mix(s.g, n.g, 0.14);
  s.g *= 0.996;
  s.r += s.g;
  s.r *= 0.999;
  gl_FragColor = s;
}`;

  // 落滴：余弦形凸起
  const DROP = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uState;
uniform vec2 uCenter;
uniform float uRadius;
uniform float uStrength;
uniform float uAspect;
void main() {
  vec4 s = texture2D(uState, vUv);
  vec2 d = (vUv - uCenter) * vec2(uAspect, 1.0);
  float k = max(0.0, 1.0 - length(d) / uRadius);
  k = 0.5 - cos(k * 3.14159265) * 0.5;
  s.r += k * uStrength;
  gl_FragColor = s;
}`;

  const RENDER = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uState;
uniform vec2 uSimTexel;
uniform float uWater;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uCore;
uniform float uAccent;
uniform vec3 uBg, uC1, uC2, uC3, uC4, uC5;

const float SCALE = 1.3;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
const mat2 M = mat2(0.8, 0.6, -0.6, 0.8);
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += a * noise(p);
    p = M * p * 2.03;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 frag = vUv * uRes;
  float unit = SCALE / uRes.y;

  // 水面斜率
  vec2 wn = vec2(0.0);
  float wh = 0.0;
  if (uWater > 0.5) {
    wh = texture2D(uState, vUv).r;
    vec2 o = uSimTexel * 1.5;
    float l = texture2D(uState, vUv - vec2(o.x, 0.0)).r;
    float r = texture2D(uState, vUv + vec2(o.x, 0.0)).r;
    float d = texture2D(uState, vUv - vec2(0.0, o.y)).r;
    float u = texture2D(uState, vUv + vec2(0.0, o.y)).r;
    wn = vec2(r - l, u - d) / 1.5;
  }

  // 液层：被水面折射后再取样
  vec2 p = frag * unit + wn * 11.0;
  float t = uTime * 0.028;
  vec2 q = vec2(fbm(p + vec2(0.0, t)), fbm(p + vec2(5.2, 1.3) - t * 0.8));
  vec2 rr = vec2(fbm(p + 1.5 * q + vec2(1.7, 9.2) + t * 1.2),
                 fbm(p + 1.5 * q + vec2(8.3, 2.8) - t * 0.9));
  vec2 w = p + 1.5 * rr;

  float e = 0.01;
  float k = 6.0;
  float ph = t * 1.6 + q.x * 2.0;
  float b0 = fbm(w);
  float f0 = sin(b0 * k + ph);
  float fx = sin(fbm(w + vec2(e, 0.0)) * k + ph);
  float fy = sin(fbm(w + vec2(0.0, e)) * k + ph);
  vec2 gF = vec2(fx - f0, fy - f0) / e;

  // 液层褶皱给柔和起伏，水面给清晰的涟漪
  vec3 N = normalize(vec3(-gF * 0.05, 1.0));
  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 L = normalize(vec3(-0.45, 0.6, 0.66));
  vec3 H = normalize(L + V);
  float diff = max(dot(N, L), 0.0);
  float ndh = max(dot(N, H), 0.0);
  float spec = pow(ndh, 90.0);
  float glint = pow(ndh, 320.0);
  float sheen = pow(ndh, 6.0);
  float fres = pow(1.0 - N.z, 2.0);

  vec3 c1 = mix(uC1, uC2, uAccent);
  vec3 pal = mix(c1, uC4, smoothstep(0.36, 0.6, q.x));
  pal = mix(pal, uC5, smoothstep(0.4, 0.62, rr.y));
  pal = mix(pal, uC2, smoothstep(0.5, 0.7, q.y) * 0.4);

  float h = 0.5 + 0.5 * f0;
  float depth = 0.35 + 0.65 * smoothstep(0.25, 0.75, b0);
  vec3 col = uBg * 0.9;
  col += pal * (0.06 + 0.36 * h * depth) * (0.3 + 0.7 * diff);
  col += pal * sheen * 0.2 * depth;
  col += mix(vec3(1.0), uC3, 0.5) * spec * 0.5;
  col += vec3(1.0) * glint * 0.55;
  // 掠射角反射环境冷光，涟漪边缘因此更清透
  col += mix(uC5, uC3, 0.4) * fres * 0.32;
  // 水面：独立法线受光。迎光坡面亮起细高光，背光坡面压暗，形成清晰的涟漪
  vec3 Nw = normalize(vec3(-wn * 230.0, 1.0));
  float slope = dot(Nw.xy, normalize(L.xy));
  col *= 1.0 + clamp(slope, -0.5, 0.5) * 0.45;
  float wsp = pow(max(dot(Nw, H), 0.0), 140.0);
  float wsoft = pow(max(dot(Nw, H), 0.0), 18.0) - pow(H.z, 18.0);
  col += mix(vec3(1.0), uC3, 0.35) * wsp * 0.6;
  col += mix(uC5, uC3, 0.5) * max(wsoft, 0.0) * 0.35;
  col += mix(uC5, uC3, 0.5) * pow(1.0 - Nw.z, 1.5) * 0.25;

  float cl = length(frag - uCore.xy) / max(uCore.z, 1.0);
  col += c1 * exp(-cl * 1.2) * 0.14;

  vec2 vv = vUv - 0.5;
  col = mix(uBg, col, smoothstep(1.25, 0.35, length(vv * vec2(1.0, 1.3))));
  col += (hash(frag + fract(uTime)) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}`;

  function program(gl, fsrc) {
    const mk = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.warn("[liquid]", gl.getShaderInfoLog(s));
        return null;
      }
      return s;
    };
    const vs = mk(gl.VERTEX_SHADER, VERT),
      fs = mk(gl.FRAGMENT_SHADER, fsrc);
    if (!vs || !fs) return null;
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.bindAttribLocation(p, 0, "aPos");
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return null;
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(p, i).name;
      u[name] = gl.getUniformLocation(p, name);
    }
    return { p, u };
  }

  // 可渲染的浮点纹理：优先 WebGL2 + 半精度，退回 WebGL1 扩展
  function floatTarget(gl, isGL2) {
    let internal, type, linear;
    if (isGL2) {
      if (!gl.getExtension("EXT_color_buffer_float") && !gl.getExtension("EXT_color_buffer_half_float")) return null;
      internal = gl.RGBA16F;
      type = gl.HALF_FLOAT;
      linear = true;
    } else {
      const hf = gl.getExtension("OES_texture_half_float");
      if (!hf) return null;
      internal = gl.RGBA;
      type = hf.HALF_FLOAT_OES;
      linear = !!gl.getExtension("OES_texture_half_float_linear");
    }
    return (w, h) => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, type, null);
      const f = linear ? gl.LINEAR : gl.NEAREST;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return ok ? { tex, fb } : null;
    };
  }

  GL.createLiquid = function (canvas, opts = {}) {
    const ctxOpts = { antialias: false, alpha: false, depth: false, stencil: false };
    let gl = canvas.getContext("webgl2", ctxOpts);
    const isGL2 = !!gl;
    if (!gl) gl = canvas.getContext("webgl", ctxOpts);
    const noop = { pulse() {}, setAccent() {}, drop() {} };
    const fallback = () => {
      canvas.style.background =
        "radial-gradient(60% 70% at 70% 45%, rgb(var(--c1-rgb) / .22), transparent 70%), radial-gradient(50% 60% at 30% 70%, rgb(var(--c5-rgb) / .14), transparent 70%)";
      return noop;
    };
    if (!gl) return fallback();

    const render = program(gl, RENDER);
    if (!render) return fallback();
    const sim = program(gl, SIM);
    const drop = program(gl, DROP);
    const makeTarget = sim && drop ? floatTarget(gl, isGL2) : null;

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const n3 = (c) => c.map((v) => v / 255);
    function setColors(p) {
      gl.useProgram(render.p);
      const u = render.u;
      gl.uniform3fv(u.uBg, n3(p.bg));
      gl.uniform3fv(u.uC1, n3(p.c1));
      gl.uniform3fv(u.uC2, n3(p.c2));
      gl.uniform3fv(u.uC3, n3(p.c3));
      gl.uniform3fv(u.uC4, n3(p.c4));
      gl.uniform3fv(u.uC5, n3(p.c5));
    }
    setColors(GL.palette);

    let scale = [0.36, 0.48, 0.6][GL.tier];
    let w = 2, h = 2, sw = 0, sh = 0, rect = canvas.getBoundingClientRect();
    let A = null, B = null, water = false;

    function resize() {
      rect = canvas.getBoundingClientRect();
      w = Math.max(2, Math.round(rect.width * scale));
      h = Math.max(2, Math.round(rect.height * scale));
      canvas.width = w;
      canvas.height = h;
      // 水面网格约为 CSS 的 1/3（宽度上限 560 格）；波速 1 格/步，节奏自然偏慢
      const ns = Math.min(0.34, 560 / Math.max(1, rect.width));
      const nw = Math.max(2, Math.round(rect.width * ns)),
        nh = Math.max(2, Math.round(rect.height * ns));
      if (makeTarget && (nw !== sw || nh !== sh)) {
        sw = nw;
        sh = nh;
        A = makeTarget(sw, sh);
        B = makeTarget(sw, sh);
        water = !!(A && B);
      }
    }
    new ResizeObserver(resize).observe(canvas);
    addEventListener("scroll", () => (rect = canvas.getBoundingClientRect()), { passive: true });
    resize();

    function pass(prog, setup) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, B.fb);
      gl.viewport(0, 0, sw, sh);
      gl.useProgram(prog.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, A.tex);
      gl.uniform1i(prog.u.uState, 0);
      setup(prog.u);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const t = A;
      A = B;
      B = t;
    }

    const queue = [];
    // x, y 为 CSS 像素；radius 为相对高度的比例
    function addDrop(x, y, radius, strength) {
      if (!water) return;
      queue.push([x / rect.width, 1 - y / rect.height, radius, strength]);
    }

    function coreRect() {
      if (!opts.anchor) return [rect.width / 2, rect.height / 2, 80];
      const a = opts.anchor.getBoundingClientRect();
      return [a.left - rect.left + a.width / 2, a.top - rect.top + a.height / 2, a.width / 2];
    }

    let accent = 0, accentT = 0, time = 0, last = 0, acc = 0;
    let running = false, visible = true, raf = 0, slow = 0, frames = 0;
    let lastDrop = { x: -999, y: -999, t: -10 };
    let nextAmbient = 1.2;
    const t0 = performance.now();

    canvas.parentElement.addEventListener("pointerdown", (e) => {
      addDrop(e.clientX - rect.left, e.clientY - rect.top, 0.045, 0.9);
    });

    function frame(now) {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - (last || now)) / 1000);
      last = now;
      time = (now - t0) / 1000;
      if (dt > 0.026) slow++;
      if (++frames % 120 === 0) {
        if (slow > 60 && scale > 0.28) {
          scale *= 0.82;
          resize();
        }
        slow = 0;
      }

      // 指针：移动足够远、间隔足够长才轻点一下水面
      const px = GL.pointer.x - rect.left, py = GL.pointer.y - rect.top;
      if (GL.pointer.active && px > 0 && py > 0 && px < rect.width && py < rect.height) {
        const dist = Math.hypot(px - lastDrop.x, py - lastDrop.y);
        if (dist > 110 && time - lastDrop.t > 0.32) {
          addDrop(px, py, 0.03, 0.4);
          lastDrop = { x: px, y: py, t: time };
        }
      }
      // 空闲时偶尔自然落滴，让水面始终有呼吸
      if (time > nextAmbient) {
        nextAmbient = time + 3.2 + Math.random() * 3.5;
        addDrop(rect.width * (0.45 + Math.random() * 0.5), rect.height * (0.15 + Math.random() * 0.7), 0.026, 0.5);
      }
      accent += (accentT - accent) * Math.min(1, dt * 2.5);

      if (water) {
        while (queue.length) {
          const [x, y, r, s] = queue.shift();
          pass(drop, (u) => {
            gl.uniform2f(u.uCenter, x, y);
            gl.uniform1f(u.uRadius, r);
            gl.uniform1f(u.uStrength, s * 0.22);
            gl.uniform1f(u.uAspect, rect.width / rect.height);
          });
        }
        // 固定 60Hz 步进，高刷屏下波速不变
        acc += dt;
        let n = 0;
        while (acc >= 1 / 60 && n < 3) {
          acc -= 1 / 60;
          n++;
          pass(sim, (u) => gl.uniform2f(u.uTexel, 1 / sw, 1 / sh));
        }
      }
      draw();
    }

    function draw() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.useProgram(render.p);
      const u = render.u;
      if (water) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, A.tex);
        gl.uniform1i(u.uState, 0);
        gl.uniform2f(u.uSimTexel, 1 / sw, 1 / sh);
      }
      const [cx, cy, cr] = coreRect();
      gl.uniform1f(u.uWater, water ? 1 : 0);
      gl.uniform2f(u.uRes, w, h);
      gl.uniform1f(u.uTime, time);
      gl.uniform3f(u.uCore, cx * scale, h - cy * scale, cr * scale);
      gl.uniform1f(u.uAccent, accent);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    addEventListener("gl:theme", (e) => {
      setColors(e.detail);
      if (!running) draw();
    });

    function sync() {
      const should = visible && !document.hidden && !GL.reduced;
      if (should && !running) {
        running = true;
        last = 0;
        raf = requestAnimationFrame(frame);
      } else if (!should && running) {
        running = false;
        cancelAnimationFrame(raf);
      }
    }
    new IntersectionObserver((es) => {
      visible = es[0].isIntersecting;
      sync();
    }).observe(canvas);
    document.addEventListener("visibilitychange", sync);
    if (GL.reduced) {
      time = 12;
      draw();
    } else sync();

    return {
      // 核心爆发：从核心处荡开一圈较宽的波
      pulse() {
        const [cx, cy, cr] = coreRect();
        addDrop(cx, cy, Math.min(0.07, (cr / rect.height) * 0.6), 0.7);
      },
      setAccent(v) {
        accentT = v;
      },
      drop: addDrop,
      get water() {
        return water;
      },
    };
  };
})();
