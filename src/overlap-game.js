// 影の重なりコア: リアルタイム物理 (並行モード)
//   2人以上の影が重なった solid マスク(毎フレーム更新)を当たり判定にして、
//   丸を画面右上のゴールへ運ぶ。フェーズ無し・キャプチャ無し・地形無し。
//   物理は game.js の方式(マスク勾配→法線→押し出し+反射)を踏襲している。
//   ※ solid グリッドは overlap.js 側で mirror 反映済み(表示と同じ向き)なので、
//     ここでは左右反転をしない。

const WORLD_W = 1920, WORLD_H = 1080;

const BALL_R     = 60;
const AIR        = 0.999;
const MAX_SPEED  = 5200;
const MASK_THRESH = 0.5;
const GRAVITY    = 2100;
const SHADOW_REST = 0.10;
const FLOOR_FRIC = 0.94;

const BALL_COLOR  = '#ffd23f';
const SOLID_COLOR = 'rgba(120, 90, 240, 0.45)';

// 正規化座標 (0..1)。ゴール=右上、ボール=左下スタート → 2人で持ち上げて運ぶ。
const GOAL       = { x: 0.85, y: 0.05, w: 0.13, h: 0.16 };
const BALL_START = { x: 0.09, y: 0.86 };

export class OverlapGame {
  #ctx;
  #ball;
  #goal; #start;
  #mask = null; #mw = 0; #mh = 0;   // solid グリッド(参照)
  #won = false;
  #flash = 0;
  #banner = null;

  constructor(overlayCanvas) {
    this.#ctx = overlayCanvas.getContext('2d');
    this.#goal  = this.#toWorld(GOAL);
    this.#start = { x: BALL_START.x * WORLD_W, y: BALL_START.y * WORLD_H };
    this.reset();
  }

  get won() { return this.#won; }

  #toWorld(r) { return { x: r.x * WORLD_W, y: r.y * WORLD_H, w: r.w * WORLD_W, h: r.h * WORLD_H }; }

  reset() {
    this.#ball = { x: this.#start.x, y: this.#start.y, vx: 0, vy: 0 };
    this.#won = false; this.#flash = 0; this.#banner = null;
  }

  setMask(mask, w, h) { this.#mask = mask; this.#mw = w; this.#mh = h; }

  // solid グリッドのバイリニアサンプリング (0..1)
  #maskAt(nx, ny) {
    const mask = this.#mask;
    if (!mask) return 0;
    nx = nx < 0 ? 0 : nx > 1 ? 1 : nx;
    ny = ny < 0 ? 0 : ny > 1 ? 1 : ny;
    const fx = nx * (this.#mw - 1), fy = ny * (this.#mh - 1);
    const x0 = fx | 0, y0 = fy | 0;
    const x1 = x0 + 1 < this.#mw ? x0 + 1 : x0;
    const y1 = y0 + 1 < this.#mh ? y0 + 1 : y0;
    const tx = fx - x0, ty = fy - y0, w = this.#mw;
    const a = mask[y0 * w + x0], b = mask[y0 * w + x1];
    const c = mask[y1 * w + x0], d = mask[y1 * w + x1];
    const top = a + (b - a) * tx, bot = c + (d - c) * tx;
    return top + (bot - top) * ty;
  }

  update(dtMs) {
    if (this.#flash > 0) this.#flash = Math.max(0, this.#flash - dtMs);
    if (this.#banner)    { this.#banner.t -= dtMs; if (this.#banner.t <= 0) this.#banner = null; }
    if (this.#won) return;

    let dt = dtMs / 1000; if (dt > 0.05) dt = 0.05;
    const ball = this.#ball;

    const speed = Math.hypot(ball.vx, ball.vy);
    let steps = Math.ceil((speed * dt) / (BALL_R * 0.4)) || 1;
    if (steps > 12) steps = 12;
    const h = dt / steps;

    for (let s = 0; s < steps; s++) {
      ball.vy += GRAVITY * h;
      ball.vx *= AIR; ball.vy *= AIR;
      ball.x  += ball.vx * h;
      ball.y  += ball.vy * h;
      this.#collideShadow(ball);
    }

    const sp = Math.hypot(ball.vx, ball.vy);
    if (sp > MAX_SPEED) { ball.vx *= MAX_SPEED / sp; ball.vy *= MAX_SPEED / sp; }

    // 四方の壁 (落下し続けないよう下も床にする。地形ではなく場の境界)
    if (ball.x < BALL_R)            { ball.x = BALL_R;            ball.vx = -ball.vx * 0.6; }
    if (ball.x > WORLD_W - BALL_R)  { ball.x = WORLD_W - BALL_R;  ball.vx = -ball.vx * 0.6; }
    if (ball.y < BALL_R)            { ball.y = BALL_R;            ball.vy = -ball.vy * 0.6; }
    if (ball.y > WORLD_H - BALL_R)  { ball.y = WORLD_H - BALL_R;  ball.vy = -ball.vy * 0.4; ball.vx *= FLOOR_FRIC; }

    // ゴール (右上)
    const g = this.#goal;
    if (ball.x > g.x && ball.x < g.x + g.w && ball.y > g.y && ball.y < g.y + g.h) {
      this.#won = true; this.#flash = 350; this.#banner = { text: 'クリア！', t: 2500 };
    }
  }

  // ボールと solid の衝突: マスク勾配から法線→押し出し+反射 (game.js と同方式)
  #collideShadow(ball) {
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
    else            { onx = 0; ony = -1; }

    ball.x += onx * BALL_R * 0.45;
    ball.y += ony * BALL_R * 0.45;

    const vn = ball.vx * onx + ball.vy * ony;
    if (vn < 0) {
      ball.vx -= (1 + SHADOW_REST) * vn * onx;
      ball.vy -= (1 + SHADOW_REST) * vn * ony;
    }
    if (ony < -0.5) ball.vx *= 0.99;
  }

  // --- 描画 (背景シルエットは既存 renderer が下の canvas に描くので、ここでは描かない) ---
  draw() {
    const ctx = this.#ctx;
    const cw = ctx.canvas.width, ch = ctx.canvas.height;
    ctx.setTransform(cw / WORLD_W, 0, 0, ch / WORLD_H, 0, 0);
    ctx.clearRect(0, 0, WORLD_W, WORLD_H);
    this.#drawSolid(ctx);
    this.#drawGoal(ctx);
    this.#drawBall(ctx);
    this.#drawBanner(ctx);
  }

  #drawSolid(ctx) {
    const mask = this.#mask;
    if (!mask) return;
    const gw = this.#mw, gh = this.#mh;
    const cw = WORLD_W / gw, chh = WORLD_H / gh;
    ctx.fillStyle = SOLID_COLOR;
    for (let y = 0; y < gh; y++) {
      const row = y * gw;
      for (let x = 0; x < gw; x++) {
        if (mask[row + x] >= MASK_THRESH) ctx.fillRect(x * cw, y * chh, cw + 1, chh + 1);
      }
    }
  }

  #drawGoal(ctx) {
    const g = this.#goal;
    const glow = this.#flash > 0 ? this.#flash / 350 : 0;
    ctx.save();
    ctx.fillStyle = `rgba(90, 240, 138, ${0.18 + glow * 0.5})`;
    ctx.fillRect(g.x, g.y, g.w, g.h);
    ctx.lineWidth = 8;
    ctx.strokeStyle = `rgba(90, 240, 138, ${0.8 + glow * 0.2})`;
    ctx.strokeRect(g.x, g.y, g.w, g.h);
    ctx.fillStyle = 'rgba(90, 240, 138, 0.9)';
    ctx.font = 'bold 52px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('GOAL', g.x + g.w / 2, g.y + g.h / 2);
    ctx.restore();
  }

  #drawBall(ctx) {
    const { x, y } = this.#ball;
    ctx.save();
    const grad = ctx.createRadialGradient(x - BALL_R * 0.3, y - BALL_R * 0.3, BALL_R * 0.2, x, y, BALL_R);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.25, BALL_COLOR);
    grad.addColorStop(1, BALL_COLOR);
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(x, y, BALL_R, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.stroke();
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
