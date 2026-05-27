// Vertex shader — u_flipX/u_flipY で水平・垂直反転を独立制御（最終出力パスのみに適用）
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

// 体マスクのクロージング: RGBA mask の alpha チャネルだけを処理して R8 FBO に出力
// Pass 1: 水平膨張
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

// Pass 2: 垂直膨張
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

// Pass 3: 水平収縮
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

// Pass 4: 垂直収縮（クロージング完成）
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

// Pass 5: グリッドモザイク + キーポイント領域別の色付け + 反転 — R8 FBO → screen
// 体のセル判定はカーソル中心 3x3 平均で行い、ヒステリシスなし＝遅延ゼロ
// 体内ならキーポイント位置から幾何学的に手/頭/足の領域を判定して色分け
// 座標系: キーポイントは「カメラ画素」座標で渡す。cell 中心を u_cam スケールに変換して比較
const MOSAIC_COLOR_FRAG = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform vec2  u_res;       // 出力解像度(px)
uniform vec2  u_cam;       // カメラ解像度(px) — キーポイント座標の基準
uniform float u_cell;
uniform vec4  u_fg;
uniform vec4  u_bg;
uniform vec4  u_hand;
uniform vec4  u_head;
uniform vec4  u_leg;

// === 複数人対応 ===
// 全 uniform を「ポーズインデックス順の flat 配列」に変更
//   - 体マスクは全員分を JS 側で max 合成して u_tex に渡す
//   - キーポイント系は per-pose に配列化して 1 シェーダで全員のチェックを行う
const int MAX_POSES      = 4;
const int MAX_HAND_BS    = 3;
const int MAX_LEG_SEGS   = 6;
const int MAX_NONLEG_PTS = 8;

uniform int u_poseCount; // 有効なポーズ数(0..MAX_POSES)

uniform vec2  u_headPos[MAX_POSES];
uniform float u_headR  [MAX_POSES];

uniform vec2  u_handLA      [MAX_POSES];
uniform vec2  u_handLBs     [MAX_POSES * MAX_HAND_BS]; // flat
uniform int   u_handLBCount [MAX_POSES];
uniform float u_handLR      [MAX_POSES];
uniform vec2  u_handRA      [MAX_POSES];
uniform vec2  u_handRBs     [MAX_POSES * MAX_HAND_BS];
uniform int   u_handRBCount [MAX_POSES];
uniform float u_handRR      [MAX_POSES];

uniform vec2  u_legSegA    [MAX_POSES * MAX_LEG_SEGS];
uniform vec2  u_legSegB    [MAX_POSES * MAX_LEG_SEGS];
uniform int   u_legSegCount[MAX_POSES];
uniform vec2  u_nonLegPts  [MAX_POSES * MAX_NONLEG_PTS];
uniform int   u_nonLegCount[MAX_POSES];
uniform int   u_legOn      [MAX_POSES];
// 脚 Voronoi の絶対距離ガード: 他の人の脚骨格が遠くからゆるく当たらないように
uniform float u_legRadius  [MAX_POSES];

in vec2 v_uv;
out vec4 fragColor;

// 半キャプセル距離: 線分 [a,b] の a より手前(elbow/hip 側)は除外
//   手の場合 a=手首、手首より前腕側は塗られない → 「手首から先のみ」を実現
//   足の場合 a=膝、 膝より大腿側は塗られない → 「膝から先のみ」を実現
float distSeg(vec2 p, vec2 a, vec2 b) {
  vec2 d = b - a;
  float L2 = dot(d, d);
  if (L2 < 0.0001) return distance(p, a);
  float tRaw = dot(p - a, d) / L2;
  if (tRaw < 0.0) return 1e6; // a より手前は無効
  float t = clamp(tRaw, 0.0, 1.25); // b より少し先(指先/つま先)まで延長
  return distance(p, a + d * t);
}

void main() {
  vec2  px     = v_uv * u_res;
  vec2  cell   = floor(px / u_cell);
  vec2  center = (cell + 0.5) * u_cell;

  // 体カバレッジ: セル内 3x3 サンプル平均（端セルの点滅対策、ヒステリシス不要）
  float cov = 0.0;
  for (int yy = -1; yy <= 1; yy++) {
    for (int xx = -1; xx <= 1; xx++) {
      vec2 off = vec2(float(xx), float(yy)) * (u_cell / 3.0);
      cov += texture(u_tex, (center + off) / u_res).r;
    }
  }
  if (cov / 9.0 <= 0.5) {
    fragColor = u_bg;
    return;
  }

  // セル中心をカメラ画素座標へ変換
  vec2 p = (center / u_res) * u_cam;

  // 複数人: 各領域チェックをポーズで OR
  //   一つでもいずれかのポーズで領域内なら該当色にする
  bool inHead = false;
  bool inHand = false;
  bool inLeg  = false;

  for (int pi = 0; pi < MAX_POSES; pi++) {
    if (pi >= u_poseCount) break;

    // 頭(円)
    if (!inHead && u_headR[pi] > 0.0 && distance(p, u_headPos[pi]) < u_headR[pi]) {
      inHead = true;
    }

    // 手 (左 + 右、各々最大 MAX_HAND_BS 本のキャプセル)
    if (!inHand && u_handLR[pi] > 0.0) {
      for (int i = 0; i < MAX_HAND_BS; i++) {
        if (i >= u_handLBCount[pi]) break;
        if (distSeg(p, u_handLA[pi], u_handLBs[pi * MAX_HAND_BS + i]) < u_handLR[pi]) {
          inHand = true; break;
        }
      }
    }
    if (!inHand && u_handRR[pi] > 0.0) {
      for (int i = 0; i < MAX_HAND_BS; i++) {
        if (i >= u_handRBCount[pi]) break;
        if (distSeg(p, u_handRA[pi], u_handRBs[pi * MAX_HAND_BS + i]) < u_handRR[pi]) {
          inHand = true; break;
        }
      }
    }

    // 脚: Voronoi + 絶対距離ガード
    if (!inLeg && u_legOn[pi] != 0 && u_legSegCount[pi] > 0) {
      float dLeg = 1e10;
      for (int i = 0; i < MAX_LEG_SEGS; i++) {
        if (i >= u_legSegCount[pi]) break;
        dLeg = min(dLeg, distSeg(p,
          u_legSegA[pi * MAX_LEG_SEGS + i],
          u_legSegB[pi * MAX_LEG_SEGS + i]));
      }
      // 絶対距離ガード: 他人の脚骨格が遠くから誤マッチしないように
      if (dLeg <= u_legRadius[pi]) {
        float dNonLeg = 1e10;
        for (int i = 0; i < MAX_NONLEG_PTS; i++) {
          if (i >= u_nonLegCount[pi]) break;
          dNonLeg = min(dNonLeg, distance(p, u_nonLegPts[pi * MAX_NONLEG_PTS + i]));
        }
        if (dLeg < dNonLeg) inLeg = true;
      }
    }

    if (inHead && inHand && inLeg) break; // 既に全て判定済みなら早期終了
  }

  vec4 col = u_fg;
  if (inLeg)  col = u_leg;
  if (inHead) col = u_head;
  if (inHand) col = u_hand;

  // 手と頭が重なるセルは赤と青をチェッカーボードで交互配置
  //   両方の形状が同時に視認でき、前後関係(手が前、頭は後ろ)を区別可能
  if (inHand && inHead) {
    float c = mod(cell.x + cell.y, 2.0);
    col = (c < 1.0) ? u_hand : u_head;
  }

  fragColor = col;
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

  // パイプライン: 膨張(H→V) → 収縮(H→V) = クロージング → モザイク+部位色
  render(maskImage, {
    closeRadius, threshold,
    fgColor, bgColor, handColor, headColor, legColor,
    mirror = true, cellSize = 18,
    camW, camH, pose,
  }) {
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

    // Pass 4: 垂直収縮 (fboA → fboB)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#fboB);
    gl.viewport(0, 0, W, H);
    gl.useProgram(this.#vErodeProg);
    gl.bindTexture(gl.TEXTURE_2D, this.#fbTexA);
    this.#setUniforms(this.#vErodeProg, { step: 1/H, r: closeRadius });
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Pass 5: モザイク化 + 部位色 (fboB → screen)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.useProgram(this.#mosaicProg);
    gl.bindTexture(gl.TEXTURE_2D, this.#fbTexB);
    this.#setUniforms(this.#mosaicProg, {
      flipX: mirror ? 1 : 0, flipY: 0,
      res: [W, H], cam: [camW, camH], cell: Math.max(2, cellSize),
      fg: fgColor, bg: bgColor, hand: handColor, head: headColor, leg: legColor,
      pose,
    });
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  #setUniforms(prog, {
    flipX = 0, flipY = 0, step, r, thresh,
    fg, bg, hand, head, leg,
    res, cam, cell, pose,
  } = {}) {
    const gl = this.#gl;
    const loc = name => gl.getUniformLocation(prog, name);
    gl.uniform1i(loc('u_flipX'), flipX);
    gl.uniform1i(loc('u_flipY'), flipY);
    if (step   !== undefined) gl.uniform1f(loc('u_step'),   step);
    if (r      !== undefined) gl.uniform1i(loc('u_r'),      r);
    if (thresh !== undefined) gl.uniform1f(loc('u_thresh'), thresh);
    if (fg)                   gl.uniform4fv(loc('u_fg'),    fg);
    if (bg)                   gl.uniform4fv(loc('u_bg'),    bg);
    if (hand)                 gl.uniform4fv(loc('u_hand'),  hand);
    if (head)                 gl.uniform4fv(loc('u_head'),  head);
    if (leg)                  gl.uniform4fv(loc('u_leg'),   leg);
    if (res)                  gl.uniform2f(loc('u_res'),    res[0], res[1]);
    if (cam)                  gl.uniform2f(loc('u_cam'),    cam[0], cam[1]);
    if (cell   !== undefined) gl.uniform1f(loc('u_cell'),   cell);
    if (pose) {
      // すべて per-pose flat 配列で渡す (要素 0..poseCount-1 のみ有効)
      gl.uniform1i (loc('u_poseCount'),    pose.poseCount);
      gl.uniform2fv(loc('u_headPos'),      pose.headPos);
      gl.uniform1fv(loc('u_headR'),        pose.headR);
      gl.uniform2fv(loc('u_handLA'),       pose.handLA);
      gl.uniform2fv(loc('u_handLBs'),      pose.handLBs);
      gl.uniform1iv(loc('u_handLBCount'),  pose.handLBCount);
      gl.uniform1fv(loc('u_handLR'),       pose.handLR);
      gl.uniform2fv(loc('u_handRA'),       pose.handRA);
      gl.uniform2fv(loc('u_handRBs'),      pose.handRBs);
      gl.uniform1iv(loc('u_handRBCount'),  pose.handRBCount);
      gl.uniform1fv(loc('u_handRR'),       pose.handRR);
      gl.uniform2fv(loc('u_legSegA'),      pose.legSegA);
      gl.uniform2fv(loc('u_legSegB'),      pose.legSegB);
      gl.uniform1iv(loc('u_legSegCount'),  pose.legSegCount);
      gl.uniform2fv(loc('u_nonLegPts'),    pose.nonLegPts);
      gl.uniform1iv(loc('u_nonLegCount'),  pose.nonLegCount);
      gl.uniform1iv(loc('u_legOn'),        pose.legOn);
      gl.uniform1fv(loc('u_legRadius'),    pose.legRadius);
    }
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
