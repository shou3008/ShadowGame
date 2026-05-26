// Vertex shader — u_flipX/u_flipY で水平・垂直反転を独立制御（最終出力パスのみに適用）
// 垂直反転は FBO 多段描画による上下反転を補正するため最終パスで常に有効。
// 水平反転は UI の「左右反転」トグルから切り替える。
const VERT = `#version 300 es
layout(location=0) in vec2 a_pos;
layout(location=1) in vec2 a_uv;
uniform int u_flipX;
uniform int u_flipY;
out vec2 v_uv;
void main() {
  gl_Position = vec4(a_pos, 0.0, 1.0);
  float u = u_flipX != 0 ? 1.0 - a_uv.x : a_uv.x;
  float v = u_flipY != 0 ? 1.0 - a_uv.y : a_uv.y;
  v_uv = vec2(u, v);
}`;

// Pass 1: 水平膨張 — RGBA alpha → R8 FBO（閾値処理 + 膨張）
const H_DILATE_RGBA_FRAG = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform float u_step;
uniform int   u_r;
uniform float u_thresh;
in vec2 v_uv;
out vec4 fragColor;
void main() {
  float m = 0.0;
  for (int i = -30; i <= 30; i++) {
    if (abs(i) > u_r) continue;
    float a = texture(u_tex, v_uv + vec2(float(i) * u_step, 0.0)).a;
    m = max(m, step(u_thresh, a));
    if (m > 0.99) break;
  }
  fragColor = vec4(m, 0.0, 0.0, 1.0);
}`;

// Pass 2: 垂直膨張 — R8 FBO → R8 FBO
const V_DILATE_FRAG = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform float u_step;
uniform int   u_r;
in vec2 v_uv;
out vec4 fragColor;
void main() {
  float m = 0.0;
  for (int i = -30; i <= 30; i++) {
    if (abs(i) > u_r) continue;
    m = max(m, texture(u_tex, v_uv + vec2(0.0, float(i) * u_step)).r);
    if (m > 0.99) break;
  }
  fragColor = vec4(m, 0.0, 0.0, 1.0);
}`;

// Pass 3: 水平収縮 — R8 FBO → R8 FBO
const H_ERODE_FRAG = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform float u_step;
uniform int   u_r;
in vec2 v_uv;
out vec4 fragColor;
void main() {
  float m = 1.0;
  for (int i = -30; i <= 30; i++) {
    if (abs(i) > u_r) continue;
    m = min(m, texture(u_tex, v_uv + vec2(float(i) * u_step, 0.0)).r);
    if (m < 0.01) break;
  }
  fragColor = vec4(m, 0.0, 0.0, 1.0);
}`;

// Pass 4: 垂直収縮 — R8 FBO → R8 FBO（クロージング完成）
const V_ERODE_FRAG = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform float u_step;
uniform int   u_r;
in vec2 v_uv;
out vec4 fragColor;
void main() {
  float m = 1.0;
  for (int i = -30; i <= 30; i++) {
    if (abs(i) > u_r) continue;
    m = min(m, texture(u_tex, v_uv + vec2(0.0, float(i) * u_step)).r);
    if (m < 0.01) break;
  }
  fragColor = vec4(m, 0.0, 0.0, 1.0);
}`;

// Pass 5: グリッドモザイク化 + 色付け + 反転 — R8 FBO → screen
// 出力をセル(u_cell px = 間隔)のグリッドに分割し、各セルに影があるか(二値)で
// セル全体を塗りつぶす。四角(=セル)のサイズは間隔に連動して変わる。
const MOSAIC_COLOR_FRAG = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform vec2  u_res;   // 出力解像度(px)
uniform float u_cell;  // グリッドセル一辺(px) = 間隔 = 四角サイズ
uniform vec4  u_fg;
uniform vec4  u_bg;
in vec2 v_uv;
out vec4 fragColor;
void main() {
  vec2  px     = v_uv * u_res;
  vec2  cell   = floor(px / u_cell);
  vec2  center = (cell + 0.5) * u_cell;

  // セル範囲に影があるかを 3x3 平均の被覆で二値判定
  float cov = 0.0;
  for (int yy = -1; yy <= 1; yy++) {
    for (int xx = -1; xx <= 1; xx++) {
      vec2 off = vec2(float(xx), float(yy)) * (u_cell / 3.0);
      cov += texture(u_tex, (center + off) / u_res).r;
    }
  }
  float on = step(0.5, cov / 9.0);
  fragColor = mix(u_bg, u_fg, on);
}`;

export class Renderer {
  #gl;
  #hDilateRgbaProg;
  #vDilateProg;
  #hErodeR8Prog;
  #vErodeProg;
  #mosaicProg;
  #vao;
  #maskTex;
  #fboA; #fbTexA;
  #fboB; #fbTexB;
  #w = 0; #h = 0;

  constructor(canvas) {
    const gl = canvas.getContext('webgl2');
    if (!gl) throw new Error('WebGL2 がサポートされていません');
    this.#gl = gl;

    this.#hDilateRgbaProg = this.#buildProgram(VERT, H_DILATE_RGBA_FRAG);
    this.#vDilateProg     = this.#buildProgram(VERT, V_DILATE_FRAG);
    this.#hErodeR8Prog    = this.#buildProgram(VERT, H_ERODE_FRAG);
    this.#vErodeProg      = this.#buildProgram(VERT, V_ERODE_FRAG);
    this.#mosaicProg      = this.#buildProgram(VERT, MOSAIC_COLOR_FRAG);

    this.#vao     = this.#buildQuad();
    this.#maskTex = this.#makeTex(gl.NEAREST);
    this.#fbTexA  = this.#makeTex(gl.LINEAR);
    this.#fbTexB  = this.#makeTex(gl.LINEAR);
    this.#fboA    = gl.createFramebuffer();
    this.#fboB    = gl.createFramebuffer();
  }

  resize(w, h) {
    const gl = this.#gl;
    this.#w = w;
    this.#h = h;
    gl.canvas.width  = w;
    gl.canvas.height = h;

    for (const tex of [this.#fbTexA, this.#fbTexB]) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, null);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);

    this.#attachFbo(this.#fboA, this.#fbTexA);
    this.#attachFbo(this.#fboB, this.#fbTexB);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  #attachFbo(fbo, tex) {
    const gl = this.#gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  }

  // パイプライン: 膨張(H→V) → 収縮(H→V) = クロージング
  // 同じ半径で膨張→収縮することで、人物間の隙間（腕幅程度）を埋めつつ輪郭を保つ
  render(maskImage, { closeRadius, threshold, fgColor, bgColor, mirror = true, cellSize = 18 }) {
    const gl = this.#gl;
    const W = this.#w, H = this.#h;

    gl.bindTexture(gl.TEXTURE_2D, this.#maskTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, maskImage);
    gl.bindVertexArray(this.#vao);

    // Pass 1: 水平膨張 (RGBA mask → fboA)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#fboA);
    gl.viewport(0, 0, W, H);
    gl.useProgram(this.#hDilateRgbaProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.#maskTex);
    this.#setUniforms(this.#hDilateRgbaProg, { step: 1/W, r: closeRadius, thresh: threshold });
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Pass 2: 垂直膨張 (fboA → fboB)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#fboB);
    gl.viewport(0, 0, W, H);
    gl.useProgram(this.#vDilateProg);
    gl.bindTexture(gl.TEXTURE_2D, this.#fbTexA);
    this.#setUniforms(this.#vDilateProg, { step: 1/H, r: closeRadius });
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Pass 3: 水平収縮 (fboB → fboA)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#fboA);
    gl.viewport(0, 0, W, H);
    gl.useProgram(this.#hErodeR8Prog);
    gl.bindTexture(gl.TEXTURE_2D, this.#fbTexB);
    this.#setUniforms(this.#hErodeR8Prog, { step: 1/W, r: closeRadius });
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Pass 4: 垂直収縮 (fboA → fboB) でクロージング完成（二値マスク）
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#fboB);
    gl.viewport(0, 0, W, H);
    gl.useProgram(this.#vErodeProg);
    gl.bindTexture(gl.TEXTURE_2D, this.#fbTexA);
    this.#setUniforms(this.#vErodeProg, { step: 1/H, r: closeRadius });
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Pass 5: グリッドモザイク化 + 色付け + 反転 (fboB → screen)
    // flipY=0 で上下反転表示、flipX が UI の左右反転
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.useProgram(this.#mosaicProg);
    gl.bindTexture(gl.TEXTURE_2D, this.#fbTexB);
    this.#setUniforms(this.#mosaicProg, {
      flipX: mirror ? 1 : 0, flipY: 0,
      res: [W, H], cell: Math.max(2, cellSize),
      fg: fgColor, bg: bgColor,
    });
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  #setUniforms(prog, { flipX = 0, flipY = 0, step, r, thresh, fg, bg, res, cell } = {}) {
    const gl = this.#gl;
    const loc = name => gl.getUniformLocation(prog, name);
    gl.uniform1i(loc('u_flipX'), flipX);
    gl.uniform1i(loc('u_flipY'), flipY);
    if (step   !== undefined) gl.uniform1f(loc('u_step'),   step);
    if (r      !== undefined) gl.uniform1i(loc('u_r'),      r);
    if (thresh !== undefined) gl.uniform1f(loc('u_thresh'), thresh);
    if (fg)                   gl.uniform4fv(loc('u_fg'),    fg);
    if (bg)                   gl.uniform4fv(loc('u_bg'),    bg);
    if (res)                  gl.uniform2f(loc('u_res'),    res[0], res[1]);
    if (cell   !== undefined) gl.uniform1f(loc('u_cell'),   cell);
  }

  #buildQuad() {
    const gl = this.#gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,  0, 1,
       1, -1,  1, 1,
      -1,  1,  0, 0,
       1,  1,  1, 0,
    ]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    gl.bindVertexArray(null);
    return vao;
  }

  #makeTex(filter) {
    const gl = this.#gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    return tex;
  }

  #buildProgram(vertSrc, fragSrc) {
    const gl = this.#gl;
    const v = this.#compile(gl.VERTEX_SHADER, vertSrc);
    const f = this.#compile(gl.FRAGMENT_SHADER, fragSrc);
    const p = gl.createProgram();
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    gl.deleteShader(v);
    gl.deleteShader(f);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error('Shader link error: ' + gl.getProgramInfoLog(p));
    return p;
  }

  #compile(type, src) {
    const gl = this.#gl;
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error('Shader compile error: ' + gl.getShaderInfoLog(s));
    return s;
  }
}
