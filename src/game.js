// 協力プレイのシャドウゲーム (ステージ制)
//   - 人物シルエット(smBody マスク)を当たり判定の「壁/坂」として使う
//   - ステージごとに扱える動作(ルール)が変わる:
//       STAGE 1: 重力のみ。影を坂にしてボールを転がし運ぶ。落下で GAME OVER。
//       STAGE 2: 段差マップあり。影で下から突き上げてジャンプし、段を登る。
//
// 座標系: 仮想ワールド 1920×1080 (16:9)。描画時にオーバーレイ canvas へスケール。
//   当たり判定はワールド座標→正規化→マスク座標へ変換してサンプリングする。

const WORLD_W = 1920;
const WORLD_H = 1080;

// ステージ非依存の物理定数
const BALL_R      = 60;
const AIR         = 0.999; // 空気抵抗(わずか)
const MAX_SPEED   = 5200;
const MASK_THRESH = 0.5;   // この値以上を「影あり」とみなす
const FLOOR_FRIC  = 0.94;  // 平面の上を転がるときの横方向減衰
const PLAT_REST   = 0.18;  // プラットフォームの反発(低め=跳ねずに乗る)

const BALL_COLORS = ['#ff5a5a', '#ffd23f', '#46d3ff', '#9b6bff'];

// --- ステージ定義 (矩形・座標はすべて 0..1 の正規化値) ---
//   gravity     : 重力加速度
//   shadowPush  : 影に触れている間の外向き押し出し(0=能動的な弾き無し=坂のみ)
//   shadowRest  : 影の反発(低い=坂に乗って滑る / 高い=弾む)
//   fallGameOver: 画面下に落ちたら GAME OVER か
//   platforms   : 静的な足場(矩形)
const STAGES = [
  {
    name: 'STAGE 1 — 影の坂で運ぶ',
    gravity: 2200, shadowPush: 0, shadowRest: 0.12, fallGameOver: true,
    platforms: [],
    ballStart: { x: 0.12, y: 0.10 },
    goal:      { x: 0.85, y: 0.34, w: 0.12, h: 0.28 },
  },
  {
    name: 'STAGE 2 — 影でジャンプして登る',
    gravity: 2800, shadowPush: 480, shadowRest: 0.25, fallGameOver: false,
    platforms: [
      { x: 0.00, y: 0.945, w: 1.00, h: 0.055 }, // 地面
      { x: 0.16, y: 0.80,  w: 0.17, h: 0.028 },
      { x: 0.40, y: 0.66,  w: 0.17, h: 0.028 },
      { x: 0.63, y: 0.52,  w: 0.17, h: 0.028 },
      { x: 0.83, y: 0.38,  w: 0.17, h: 0.028 }, // 最上段
    ],
    ballStart: { x: 0.05, y: 0.90 },
    goal:      { x: 0.85, y: 0.27, w: 0.13, h: 0.10 }, // 最上段の上
  },
];

export class Game {
  #ctx;
  #stageIdx = 0;
  #stage = null;     // ワールド座標に解決したステージ
  #ball = null;
  #running = false;
  #won = false;
  #gameOver = false;
  #timeMs = 0;
  #flash = 0;        // ゴール時のフラッシュ
  #banner = null;    // { text, t } 画面中央の一時表示
  mirror = true;     // 表示の左右反転に合わせてマスクをサンプリング

  #mask = null; #mw = 0; #mh = 0;

  constructor(overlayCanvas) {
    this.#ctx = overlayCanvas.getContext('2d');
    this.reset();
  }

  // --- 状態取得 (HUD 用) ---
  get running()   { return this.#running; }
  get won()       { return this.#won; }
  get gameOver()  { return this.#gameOver; }
  get timeMs()    { return this.#timeMs; }
  get stageName() { return this.#stage ? this.#stage.name : ''; }
  get stageIndex(){ return this.#stageIdx; }
  get stageCount(){ return STAGES.length; }

  setMask(mask, w, h) { this.#mask = mask; this.#mw = w; this.#mh = h; }

  // 正規化矩形 → ワールド矩形
  #toWorld(r) {
    return { x: r.x * WORLD_W, y: r.y * WORLD_H, w: r.w * WORLD_W, h: r.h * WORLD_H };
  }

  #loadStage(i) {
    this.#stageIdx = i;
    const s = STAGES[i];
    this.#stage = {
      name: s.name, gravity: s.gravity, shadowPush: s.shadowPush,
      shadowRest: s.shadowRest, fallGameOver: s.fallGameOver,
      platforms: s.platforms.map(p => this.#toWorld(p)),
      goal: this.#toWorld(s.goal),
    };
    this.#ball = {
      x: s.ballStart.x * WORLD_W, y: s.ballStart.y * WORLD_H,
      vx: 0, vy: 0, color: BALL_COLORS[i % BALL_COLORS.length],
    };
    this.#flash = 0;
  }

  // 最初(STAGE 1)からやり直し
  reset() {
    this.#loadStage(0);
    this.#running = false; this.#won = false; this.#gameOver = false;
    this.#timeMs = 0; this.#banner = null;
  }

  // 現在ステージをやり直し(GAME OVER 後)。タイムは継続。
  #retryStage() {
    this.#loadStage(this.#stageIdx);
    this.#gameOver = false;
  }

  start() {
    if (this.#won)            this.reset();        // クリア後は最初から
    else if (this.#gameOver)  this.#retryStage();  // GAME OVER はこのステージから
    this.#running = true;
  }

  // --- マスクサンプリング (バイリニア, 0..1) ---
  #maskAt(nx, ny) {
    const mask = this.#mask;
    if (!mask) return 0;
    nx = nx < 0 ? 0 : nx > 1 ? 1 : nx;
    ny = ny < 0 ? 0 : ny > 1 ? 1 : ny;
    if (this.mirror) nx = 1 - nx;
    const fx = nx * (this.#mw - 1);
    const fy = ny * (this.#mh - 1);
    const x0 = fx | 0, y0 = fy | 0;
    const x1 = x0 + 1 < this.#mw ? x0 + 1 : x0;
    const y1 = y0 + 1 < this.#mh ? y0 + 1 : y0;
    const tx = fx - x0, ty = fy - y0;
    const w = this.#mw;
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
    if (!this.#running || this.#won || this.#gameOver) return;

    this.#timeMs += dtMs;
    let dt = dtMs / 1000;
    if (dt > 0.05) dt = 0.05; // フレーム飛び抑制

    const ball = this.#ball;
    const st = this.#stage;

    // すり抜け防止のサブステップ
    const speed = Math.hypot(ball.vx, ball.vy);
    let steps = Math.ceil((speed * dt) / (BALL_R * 0.4)) || 1;
    if (steps > 12) steps = 12;
    const h = dt / steps;

    for (let s = 0; s < steps; s++) {
      ball.vy += st.gravity * h;
      ball.vx *= AIR; ball.vy *= AIR;
      ball.x  += ball.vx * h;
      ball.y  += ball.vy * h;
      this.#collideShadow(ball, st);
      for (const p of st.platforms) this.#collidePlatform(ball, p);
    }

    // 速度上限
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
        this.#banner = { text: this.#stage.name, t: 1800 };
      } else {
        this.#won = true; this.#running = false;
      }
      return;
    }

    // 落下判定
    if (st.fallGameOver && ball.y - BALL_R > WORLD_H) {
      this.#gameOver = true; this.#running = false;
    }
  }

  // ボールと影の衝突: マスク勾配から法線を求めて 押し出し+反射(+押し力)
  #collideShadow(ball, st) {
    const nx = ball.x / WORLD_W, ny = ball.y / WORLD_H;
    const eX = BALL_R / WORLD_W, eY = BALL_R / WORLD_H;

    const c = this.#maskAt(nx, ny);
    const l = this.#maskAt(nx - eX, ny), r = this.#maskAt(nx + eX, ny);
    const u = this.#maskAt(nx, ny - eY), d = this.#maskAt(nx, ny + eY);

    if (c < MASK_THRESH && l < MASK_THRESH && r < MASK_THRESH &&
        u < MASK_THRESH && d < MASK_THRESH) return;

    let gx = r - l, gy = d - u;
    const mag = Math.hypot(gx, gy);
    let onx, ony;
    if (mag > 1e-3) { onx = -gx / mag; ony = -gy / mag; }
    else            { onx = 0; ony = -1; } // 深く埋もれたら上へ逃がす

    ball.x += onx * BALL_R * 0.45;
    ball.y += ony * BALL_R * 0.45;

    const vn = ball.vx * onx + ball.vy * ony;
    if (vn < 0) {
      ball.vx -= (1 + st.shadowRest) * vn * onx;
      ball.vy -= (1 + st.shadowRest) * vn * ony;
    }
    // 影で押す(STAGE 2 のジャンプ等)。STAGE 1 は shadowPush=0 で坂のみ。
    ball.vx += onx * st.shadowPush;
    ball.vy += ony * st.shadowPush;
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
      // 中心が矩形内: 最も近い辺へ押し出す
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
    // 上面に乗っているときは横を減衰(転がりすぎ防止)
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
    this.#drawGoal(ctx);
    if (this.#ball) this.#drawBall(ctx, this.#ball.x, this.#ball.y, this.#ball.color);

    this.#drawStageLabel(ctx);
    this.#drawBanner(ctx);
  }

  #drawPlatform(ctx, p) {
    ctx.fillStyle = 'rgba(40, 48, 66, 0.92)';
    ctx.fillRect(p.x, p.y, p.w, p.h);
    ctx.fillStyle = 'rgba(120, 150, 200, 0.9)'; // 上面ハイライト
    ctx.fillRect(p.x, p.y, p.w, Math.max(4, p.h * 0.18));
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

  #drawBanner(ctx) {
    if (!this.#banner) return;
    const a = Math.min(1, this.#banner.t / 400);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = '#ffd23f';
    ctx.font = 'bold 88px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(this.#banner.text, WORLD_W / 2, WORLD_H * 0.4);
    ctx.restore();
  }
}
