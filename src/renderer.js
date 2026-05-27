// シンプル化したレンダラ:
//   - BodyPix の segmentMultiPersonParts を JS 側で 4 カテゴリ二値 (R=head, G=hand,
//     B=leg, A=body) に圧縮してから渡す
//   - シェーダは 1 パスのみ。クロージング系の前処理は無し
//     (時間平滑化・ヒステリシスは JS 側で、空間平滑化はセル内 3x3 平均で吸収)

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

// グリッドモザイク + カテゴリ別塗色
//   u_tex: RGBA 入力。R=head 二値, G=hand 二値, B=leg 二値, A=body 二値
//   - 体カバレッジは alpha を 3x3 平均で取って閾値判定 (端セルの揺らぎを抑制)
//   - 各カテゴリは cell 中心の 1 サンプルで判定
//   - 塗色優先: hand > head > leg > body
const MOSAIC_FRAG = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform vec2  u_res;     // 出力解像度
uniform float u_cell;    // セル一辺(px)
uniform vec4  u_fg;
uniform vec4  u_bg;
uniform vec4  u_hand;
uniform vec4  u_head;
uniform vec4  u_leg;
in vec2 v_uv;
out vec4 fragColor;
void main() {
  vec2  px     = v_uv * u_res;
  vec2  cell   = floor(px / u_cell);
  vec2  center = (cell + 0.5) * u_cell;

  // 体カバレッジ判定: alpha 3x3 平均
  float bodyCov = 0.0;
  for (int yy = -1; yy <= 1; yy++) {
    for (int xx = -1; xx <= 1; xx++) {
      vec2 off = vec2(float(xx), float(yy)) * (u_cell / 3.0);
      bodyCov += texture(u_tex, (center + off) / u_res).a;
    }
  }
  if (bodyCov / 9.0 < 0.5) {
    fragColor = u_bg;
    return;
  }

  // カテゴリ: cell 中心の 1 サンプル
  vec4 cat = texture(u_tex, center / u_res);
  vec4 col = u_fg;
  if (cat.b > 0.5) col = u_leg;
  if (cat.r > 0.5) col = u_head;
  if (cat.g > 0.5) col = u_hand;
  fragColor = col;
}`;

export class Renderer {
  #gl;
  #mosaicProg;
  #vao;
  #maskTex;
  #w = 0; #h = 0;

  constructor(canvas) {
    const gl = canvas.getContext('webgl2');
    if (!gl) throw new Error('WebGL2 がサポートされていません');
    this.#gl = gl;

    this.#mosaicProg = this.#buildProgram(VERT, MOSAIC_FRAG);
    this.#vao        = this.#buildQuad();
    this.#maskTex    = this.#makeTex(gl.NEAREST);
  }

  resize(w, h) {
    const gl = this.#gl;
    this.#w = w;
    this.#h = h;
    gl.canvas.width  = w;
    gl.canvas.height = h;
  }

  render(maskImage, {
    fgColor, bgColor, handColor, headColor, legColor,
    mirror = true, cellSize = 18,
  }) {
    const gl = this.#gl;
    const W = this.#w, H = this.#h;

    // マスクをアップロード
    gl.bindTexture(gl.TEXTURE_2D, this.#maskTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, maskImage);

    // 描画
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.bindVertexArray(this.#vao);
    gl.useProgram(this.#mosaicProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.#maskTex);

    const prog = this.#mosaicProg;
    const loc = name => gl.getUniformLocation(prog, name);
    gl.uniform1i(loc('u_flipX'), mirror ? 1 : 0);
    gl.uniform1i(loc('u_flipY'), 0);
    gl.uniform2f(loc('u_res'),   W, H);
    gl.uniform1f(loc('u_cell'),  Math.max(2, cellSize));
    gl.uniform4fv(loc('u_fg'),   fgColor);
    gl.uniform4fv(loc('u_bg'),   bgColor);
    gl.uniform4fv(loc('u_hand'), handColor);
    gl.uniform4fv(loc('u_head'), headColor);
    gl.uniform4fv(loc('u_leg'),  legColor);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
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
