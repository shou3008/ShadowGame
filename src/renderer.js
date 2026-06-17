// シンプル化したレンダラ:
//   - BodyPix の人物マスクを JS 側で 体の所属度の連続値 (A チャンネル, 0..255)
//     に圧縮してから渡す
//   - シェーダは 1 パスのみ。クロージング系の前処理は無し
//     (時間平滑化は JS 側 EMA で、空間平滑化はセル内 3x3 平均で吸収)

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

// グリッドモザイク (シルエットのみ)
//   u_tex: RGBA 入力。A=body 所属度 (連続 0..1)
//   - セル内 3x3 を平均してカバレッジを取得し閾値判定する。
//     連続値を空間平均することで、セル単位のチカチカ(きもさ)を抑える。
const MOSAIC_FRAG = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform vec2  u_res;     // 出力解像度
uniform float u_cell;    // セル一辺(px)
uniform vec4  u_fg;
uniform vec4  u_bg;
in vec2 v_uv;
out vec4 fragColor;
void main() {
  vec2  px     = v_uv * u_res;
  vec2  cell   = floor(px / u_cell);
  vec2  center = (cell + 0.5) * u_cell;

  // セル内 3x3 平均で 体のカバレッジを取得
  float bodyCov = 0.0;
  for (int yy = -1; yy <= 1; yy++) {
    for (int xx = -1; xx <= 1; xx++) {
      vec2 off = vec2(float(xx), float(yy)) * (u_cell / 3.0);
      bodyCov += texture(u_tex, (center + off) / u_res).a;
    }
  }
  bodyCov /= 9.0;

  // 低めのしきい値で拾う（セル幅より細い腕や肘の端セルを消さないため）
  fragColor = bodyCov < 0.28 ? u_bg : u_fg;
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
    fgColor, bgColor,
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
