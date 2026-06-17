// 協力プレイのシャドウゲーム (ポーズ・キャプチャ方式)
//   流れ: 構え(POSE) → キャプチャ(CAPTURE) → 実行(RUN)
//     1. POSE : ライブのシルエットを見ながら、複数人で協力して「坂/橋」の形を作る
//     2. CAPTURE: 一定タイミング(カウントダウン0)でその瞬間のシルエットを固定
//     3. RUN  : ボールを落とし、"固定したシルエット" を当たり判定にしてゴールを目指す
//   → 実行中は形を変えられないので、一人では届かない配置にすることで協力が必須になる。
//
// 座標系: 仮想ワールド 1920×1080 (16:9)。描画時にオーバーレイ canvas へスケール。

const WORLD_W = 1920;
const WORLD_H = 1080;

// ステージ非依存の物理定数
const BALL_R      = 60;
const AIR         = 0.999;
const MAX_SPEED   = 5200;
const MASK_THRESH = 0.5;
const FLOOR_FRIC  = 0.94;
const PLAT_REST   = 0.18;

// 影との衝突(安定接地)用
//   SHADOW_RING   : ボール円周をいくつの点でサンプリングして接触を見るか
//   SHADOW_CORRECT: めり込みを1フレームでどれだけ戻すか(0..1)。低いほど柔らかく安定
const SHADOW_RING    = 8;
const SHADOW_CORRECT = 0.6;

const BALL_COLOR = '#ffd23f';

// --- ステージ定義 (矩形・座標はすべて 0..1 の正規化値) ---
//   poseMs    : 構え(キャプチャまで)の時間
//   gravity   : 重力加速度
//   shadowRest: 影(固定シルエット)の反発(低い=坂に乗って転がる)
//   platforms : 固定の足場(スタート台/ゴール台など)
//   スタート台(左上)とゴール台(右下)を大きく離し、間を人の橋で繋がせる。
const STAGES = [
  {
    name: 'ステージ1 — 影で橋を作って渡せ',
    poseMs: 6000, gravity: 2100, shadowRest: 0.10, fallGameOver: true,
    platforms: [
      { x: 0.00, y: 0.26, w: 0.13, h: 0.022 }, // スタート台(左上)
      { x: 0.87, y: 0.78, w: 0.13, h: 0.022 }, // ゴール台(右下)
    ],
    ballStart: { x: 0.06, y: 0.21 },
    goal:      { x: 0.87, y: 0.63, w: 0.13, h: 0.15 }, // ゴール台の上
  },
  {
    name: 'ステージ2 — 谷をまたいで運べ',
    poseMs: 7000, gravity: 2300, shadowRest: 0.10, fallGameOver: true,
    platforms: [
      { x: 0.00, y: 0.20, w: 0.11, h: 0.022 }, // スタート台(左上・高い)
      { x: 0.44, y: 0.52, w: 0.12, h: 0.022 }, // 中継台(中央)
      { x: 0.89, y: 0.72, w: 0.11, h: 0.022 }, // ゴール台(右)
    ],
    ballStart: { x: 0.05, y: 0.15 },
    goal:      { x: 0.89, y: 0.57, w: 0.11, h: 0.15 },
  },
];

export class Game {
  #ctx;
  #stageIdx = 0;
  #stage = null;        // ワールド座標に解決したステージ
  #ball = null;

  #phase = 'idle';      // 'idle' | 'pose' | 'run' | 'won' | 'gameover'
  #poseTimer = 0;       // 構えの残り(ms)
  #timeMs = 0;          // RUN の経過時間
  #flash = 0;
  #banner = null;       // { text, t }

  mirror = true;        // 表示の左右反転に合わせてマスクをサンプリング

  // 物理チューニング(DevTools から実機調整可能。null はステージ値を使う)
  //   correct: 押し出しの戻し率 / fric: 接線摩擦 / rest: 反発 / gravity: 重力
  tune = { correct: SHADOW_CORRECT, fric: null, rest: null, gravity: null };

  #mask = null; #mw = 0; #mh = 0;             // ライブのマスク(参照)
  #cap = null; #cw = 0; #ch = 0; #cmir = true; // キャプチャした固定マスク(コピー)

  constructor(overlayCanvas) {
    this.#ctx = overlayCanvas.getContext('2d');
    this.reset();
  }

  // --- 状態取得 (HUD / ループ制御 用) ---
  get phase()      { return this.#phase; }
  get timeMs()     { return this.#timeMs; }
  get won()        { return this.#phase === 'won'; }
  get gameOver()   { return this.#phase === 'gameover'; }
  get stageName()  { return this.#stage ? this.#stage.name : ''; }
  get stageIndex() { return this.#stageIdx; }
  get stageCount() { return STAGES.length; }
  // 推論(ライブ描画)が必要なフェーズか。RUN/結果中は固定表示にして軽く・スムーズにする。
  get live()       { return this.#phase === 'idle' || this.#phase === 'pose'; }

  setMask(mask, w, h) { this.#mask = mask; this.#mw = w; this.#mh = h; }

  #toWorld(r) {
    return { x: r.x * WORLD_W, y: r.y * WORLD_H, w: r.w * WORLD_W, h: r.h * WORLD_H };
  }

  #loadStage(i) {
    this.#stageIdx = i;
    const s = STAGES[i];
    this.#stage = {
      name: s.name, poseMs: s.poseMs, gravity: s.gravity,
      shadowRest: s.shadowRest, shadowFric: s.shadowFric ?? 0.06,
      fallGameOver: s.fallGameOver,
      platforms: s.platforms.map(p => this.#toWorld(p)),
      goal: this.#toWorld(s.goal),
      ballStart: { x: s.ballStart.x * WORLD_W, y: s.ballStart.y * WORLD_H },
    };
    this.#resetBall();
    this.#cap = null;
    this.#flash = 0;
  }

  #resetBall() {
    const st = this.#stage;
    this.#ball = { x: st.ballStart.x, y: st.ballStart.y, vx: 0, vy: 0 };
  }

  // 最初(ステージ1)から
  reset() {
    this.#loadStage(0);
    this.#phase = 'idle';
    this.#timeMs = 0; this.#banner = null;
  }

  // スタート: 現在ステージの「構え」を開始。
  //   クリア後は最初から。GAME OVER 後は同じステージをもう一度。
  start() {
    if (this.#phase === 'won') this.#loadStage(0);
    else                       this.#loadStage(this.#stageIdx);
    this.#phase = 'pose';
    this.#poseTimer = this.#stage.poseMs;
    this.#banner = null;
  }

  // 構え終了 → その瞬間のシルエットを固定して RUN へ
  #capture() {
    if (this.#mask) {
      this.#cap = Float32Array.from(this.#mask);
      this.#cw = this.#mw; this.#ch = this.#mh; this.#cmir = this.mirror;
    } else {
      this.#cap = null;
    }
    this.#resetBall();
    this.#timeMs = 0;
    this.#flash = 350;
    this.#banner = { text: 'キャプチャ！', t: 1100 };
    this.#phase = 'run';
  }

  // --- 固定マスクのサンプリング (バイリニア, 0..1) ---
  #maskAt(nx, ny) {
    const mask = this.#cap;
    if (!mask) return 0;
    nx = nx < 0 ? 0 : nx > 1 ? 1 : nx;
    ny = ny < 0 ? 0 : ny > 1 ? 1 : ny;
    if (this.#cmir) nx = 1 - nx;
    const fx = nx * (this.#cw - 1);
    const fy = ny * (this.#ch - 1);
    const x0 = fx | 0, y0 = fy | 0;
    const x1 = x0 + 1 < this.#cw ? x0 + 1 : x0;
    const y1 = y0 + 1 < this.#ch ? y0 + 1 : y0;
    const tx = fx - x0, ty = fy - y0;
    const w = this.#cw;
    const a = mask[y0 * w + x0], b = mask[y0 * w + x1];
    const c = mask[y1 * w + x0], d = mask[y1 * w + x1];
    const top = a + (b - a) * tx;
    const bot = c + (d - c) * tx;
    return top + (bot - top) * ty;
  }

  // --- 更新 ---
  update(dtMs) {
    if (this.#flash > 0)  this.#flash  = Math.max(0, this.#flash - dtMs);
    if (this.#banner)     { this.#banner.t -= dtMs; if (this.#banner.t <= 0) this.#banner = null; }

    if (this.#phase === 'pose') {
      this.#poseTimer -= dtMs;
      if (this.#poseTimer <= 0) this.#capture();
      return;
    }
    if (this.#phase !== 'run') return;

    this.#timeMs += dtMs;
    let dt = dtMs / 1000;
    if (dt > 0.05) dt = 0.05;

    const ball = this.#ball;
    const st = this.#stage;

    const speed = Math.hypot(ball.vx, ball.vy);
    let steps = Math.ceil((speed * dt) / (BALL_R * 0.4)) || 1;
    if (steps > 12) steps = 12;
    const h = dt / steps;

    const gravity = this.tune.gravity ?? st.gravity;
    for (let s = 0; s < steps; s++) {
      ball.vy += gravity * h;
      ball.vx *= AIR; ball.vy *= AIR;
      ball.x  += ball.vx * h;
      ball.y  += ball.vy * h;
      this.#collideShadow(ball, st);
      for (const p of st.platforms) this.#collidePlatform(ball, p);
    }

    const sp = Math.hypot(ball.vx, ball.vy);
    if (sp > MAX_SPEED) { ball.vx *= MAX_SPEED / sp; ball.vy *= MAX_SPEED / sp; }

    // 左右・上の壁(下は無し=落下しうる)
    if (ball.x < BALL_R)           { ball.x = BALL_R;           ball.vx = -ball.vx * 0.6; }
    if (ball.x > WORLD_W - BALL_R) { ball.x = WORLD_W - BALL_R; ball.vx = -ball.vx * 0.6; }
    if (ball.y < BALL_R)           { ball.y = BALL_R;           ball.vy = -ball.vy * 0.6; }

    // ゴール
    const g = st.goal;
    if (ball.x > g.x && ball.x < g.x + g.w && ball.y > g.y && ball.y < g.y + g.h) {
      this.#flash = 350;
      if (this.#stageIdx + 1 < STAGES.length) {
        this.#loadStage(this.#stageIdx + 1);
        this.#phase = 'pose';
        this.#poseTimer = this.#stage.poseMs;
        this.#banner = { text: this.#stage.name, t: 2000 };
      } else {
        this.#phase = 'won';
      }
      return;
    }

    // 落下 → GAME OVER
    if (st.fallGameOver && ball.y - BALL_R > WORLD_H) this.#phase = 'gameover';
  }

  // ボールと固定シルエットの衝突 (安定接地):
  //   ボール円周(リング)上で影のカバレッジをサンプリングし、影が食い込んでいる向きと
  //   "めり込み量" を連続値で求める。押し出しは固定量ではなく深さに比例させる(+slop)ので、
  //   平らな影には震えずに乗り、坂では接触を保ったまま重力で転がる。
  #collideShadow(ball, st) {
    const R = BALL_R;
    let sx = 0, sy = 0, wsum = 0, n = 0;
    for (let i = 0; i < SHADOW_RING; i++) {
      const a  = (i / SHADOW_RING) * Math.PI * 2;
      const ox = Math.cos(a), oy = Math.sin(a);
      const cov = this.#maskAt((ball.x + ox * R) / WORLD_W, (ball.y + oy * R) / WORLD_H);
      if (cov > MASK_THRESH) {
        const w = cov - MASK_THRESH;   // 連続: 深いほど大
        sx -= ox * w; sy -= oy * w;     // 影のある向きと逆へ押す
        wsum += w; n++;
      }
    }
    if (n === 0) return;

    let nlen = Math.hypot(sx, sy);
    let onx, ony;
    if (nlen > 1e-4) { onx = sx / nlen; ony = sy / nlen; }
    else             { onx = 0; ony = -1; }

    // めり込み深さ(0..R) ∝ 平均の超過カバレッジ。固定量ではないので震えない。
    const correct = this.tune.correct ?? SHADOW_CORRECT;
    const depth = R * Math.min(1, (wsum / n) / (1 - MASK_THRESH));
    ball.x += onx * depth * correct;
    ball.y += ony * depth * correct;

    // 法線方向: めり込む速度だけ取り除く(+わずかな反発)
    const rest = this.tune.rest ?? st.shadowRest;
    const vn = ball.vx * onx + ball.vy * ony;
    if (vn < 0) {
      ball.vx -= (1 + rest) * vn * onx;
      ball.vy -= (1 + rest) * vn * ony;
    }
    // 接線方向: 摩擦で転がりを制御 (小さいほどよく転がる)
    const fric = this.tune.fric ?? st.shadowFric;
    const tx = -ony, ty = onx;
    const vt = ball.vx * tx + ball.vy * ty;
    ball.vx -= vt * fric * tx;
    ball.vy -= vt * fric * ty;
  }

  // ボールと矩形足場の衝突 (円 vs AABB)
  #collidePlatform(ball, p) {
    const cx = Math.max(p.x, Math.min(ball.x, p.x + p.w));
    const cy = Math.max(p.y, Math.min(ball.y, p.y + p.h));
    let dx = ball.x - cx, dy = ball.y - cy;
    let d2 = dx * dx + dy * dy;
    if (d2 >= BALL_R * BALL_R) return;

    let nx, ny, overlap;
    if (d2 > 1e-6) {
      const d = Math.sqrt(d2);
      nx = dx / d; ny = dy / d; overlap = BALL_R - d;
    } else {
      const left = ball.x - p.x, right = p.x + p.w - ball.x;
      const top = ball.y - p.y, bot = p.y + p.h - ball.y;
      const m = Math.min(left, right, top, bot);
      if (m === top)       { nx = 0; ny = -1; }
      else if (m === bot)  { nx = 0; ny = 1; }
      else if (m === left) { nx = -1; ny = 0; }
      else                 { nx = 1; ny = 0; }
      overlap = BALL_R;
    }

    ball.x += nx * overlap;
    ball.y += ny * overlap;

    const vn = ball.vx * nx + ball.vy * ny;
    if (vn < 0) {
      ball.vx -= (1 + PLAT_REST) * vn * nx;
      ball.vy -= (1 + PLAT_REST) * vn * ny;
    }
    if (ny < -0.7) ball.vx *= FLOOR_FRIC;
  }

  // --- 描画 ---
  draw() {
    const ctx = this.#ctx;
    const cw = ctx.canvas.width, ch = ctx.canvas.height;
    ctx.setTransform(cw / WORLD_W, 0, 0, ch / WORLD_H, 0, 0);
    ctx.clearRect(0, 0, WORLD_W, WORLD_H);
    if (!this.#stage) return;

    for (const p of this.#stage.platforms) this.#drawPlatform(ctx, p);
    this.#drawStartMarker(ctx);
    this.#drawGoal(ctx);

    // ボールは RUN/結果中のみ表示
    if (this.#phase === 'run' || this.#phase === 'won' || this.#phase === 'gameover') {
      this.#drawBall(ctx, this.#ball.x, this.#ball.y, BALL_COLOR);
    }

    this.#drawStageLabel(ctx);
    if (this.#phase === 'pose')  this.#drawCountdown(ctx);
    this.#drawBanner(ctx);
  }

  #drawPlatform(ctx, p) {
    ctx.fillStyle = 'rgba(40, 48, 66, 0.92)';
    ctx.fillRect(p.x, p.y, p.w, p.h);
    ctx.fillStyle = 'rgba(120, 150, 200, 0.9)';
    ctx.fillRect(p.x, p.y, p.w, Math.max(4, p.h * 0.4));
  }

  #drawStartMarker(ctx) {
    const b = this.#stage.ballStart;
    ctx.save();
    ctx.setLineDash([10, 10]);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255, 210, 63, 0.7)';
    ctx.beginPath(); ctx.arc(b.x, b.y, BALL_R, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  #drawGoal(ctx) {
    const g = this.#stage.goal;
    const glow = this.#flash > 0 ? this.#flash / 350 : 0;
    ctx.save();
    ctx.fillStyle = `rgba(90, 240, 138, ${0.18 + glow * 0.5})`;
    ctx.fillRect(g.x, g.y, g.w, g.h);
    ctx.lineWidth = 8;
    ctx.strokeStyle = `rgba(90, 240, 138, ${0.8 + glow * 0.2})`;
    ctx.strokeRect(g.x, g.y, g.w, g.h);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(90, 240, 138, 0.35)';
    for (let x = g.x + 26; x < g.x + g.w; x += 30) {
      ctx.beginPath(); ctx.moveTo(x, g.y); ctx.lineTo(x, g.y + g.h); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(90, 240, 138, 0.9)';
    ctx.font = 'bold 52px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.translate(g.x + g.w / 2, g.y + g.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('GOAL', 0, 0);
    ctx.restore();
  }

  #drawBall(ctx, x, y, color) {
    ctx.save();
    const grad = ctx.createRadialGradient(x - BALL_R * 0.3, y - BALL_R * 0.3, BALL_R * 0.2, x, y, BALL_R);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.25, color);
    grad.addColorStop(1, color);
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(x, y, BALL_R, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.stroke();
    ctx.restore();
  }

  #drawStageLabel(ctx) {
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = 'bold 30px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(this.#stage.name, WORLD_W / 2, 18);
    ctx.restore();
  }

  #drawCountdown(ctx) {
    const sec = Math.ceil(this.#poseTimer / 1000);
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = 'bold 44px sans-serif';
    ctx.fillText('みんなで橋を作って！', WORLD_W / 2, WORLD_H * 0.16);
    ctx.fillStyle = '#ffd23f';
    ctx.font = 'bold 200px sans-serif';
    ctx.fillText(String(sec), WORLD_W / 2, WORLD_H * 0.5);
    ctx.restore();
  }

  #drawBanner(ctx) {
    if (!this.#banner) return;
    const a = Math.min(1, this.#banner.t / 400);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = '#ffd23f';
    ctx.font = 'bold 96px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(this.#banner.text, WORLD_W / 2, WORLD_H * 0.4);
    ctx.restore();
  }
}
