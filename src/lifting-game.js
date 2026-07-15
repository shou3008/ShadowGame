import { OccupancyField } from './field.js';
import {
  WORLD_W, WORLD_H, BALL_R, FLOOR_Y, SPAWN, PHYSICS, EXPERIMENT,
} from './settings.js';

const BALL_COLOR  = '#ffd23f';
const FLOOR_COLOR = '#e74c3c';

// リフティング。落ちてくるボールを影(体)で弾き続ける。
//
// プレイヤーが制御するのは「影の法線の向き」だけ。反発係数は全条件で固定(完全弾性)で、
// 影の速度による撃力は存在しない。つまり "速く振る" ことでは飛ばせず、
// "どこにどんな角度で体を差し出すか" だけがボールの行き先を決める。
//
// 重力は setGravity() でしか変わらない。これが唯一の独立変数。
export class LiftingGame {
  mirror  = true;    // app.js が毎フレーム config.mirror を入れる
  onEvent = null;    // (ev) => logger.push(ev)

  #ctx;
  #field = new OccupancyField();

  #gravity = 0;
  #playing = false;

  #ball = { x: SPAWN.x, y: SPAWN.y, vx: 0, vy: 0 };
  #acc  = 0;         // 固定ステップの端数
  #tNow = 0;         // 秒。1フレームに1回だけ取得する

  #inContact  = false;
  #contactMs  = 0;
  #freezeMs   = 0;   // 落下後の再投入待ち
  #frozen     = false;

  #hits = 0; #drops = 0; #floorDrops = 0; #carryDrops = 0;
  #rally = 0; #rallyMax = 0;
  #rallies = [];
  #clampHits = 0;
  #firstDropMs = -1;
  #activeMs = 0;     // 実プレイ時間(再投入待ちを除く)

  // 時間加重の統計(フレームレートが揺れても平均が偏らない)
  #sumDt = 0; #sumSpeedDt = 0; #sumEnergyDt = 0;
  #maxSpeed = 0; #maxEnergy = 0;
  #hitImpulseSum = 0; #hitAgeSum = 0; #hitAgeCount = 0;

  // 行動指標(主観評価との対応づけ用)。すべてストリーミング集計(配列を持たない)。
  #firstHitMs = -1;                       // 最初の打点までの時間(構え/様子見)
  #lastHitMs  = -1;                       // 打点間隔用。ドロップでリセット(ラリー内のみ)
  #ivSum = 0; #iv2Sum = 0; #ivCount = 0;  // 打点間隔 = 課題のテンポ
  #hitHSum = 0; #hitH2Sum = 0;            // 打点高さ(床基準) = どこで迎え撃つか
  #hitXSum = 0; #hitX2Sum = 0;            // 打点の横散らばり = 追い回され具合
  #apexSum = 0;                           // 打ち上げ頂点高さ = 強打/ちょん当ての別

  #flashMs = 0;      // 打撃時のエフェクト

  constructor(overlayCanvas) {
    this.#ctx = overlayCanvas.getContext('2d');
  }

  // ---- 制御 ----
  setGravity(g) { this.#gravity = g; }

  reset() {
    this.#field.reset();
    this.#playing = false;
    this.#acc = 0;
    this.#inContact = false;
    this.#contactMs = 0;
    this.#freezeMs = 0;
    this.#frozen = false;

    this.#hits = 0; this.#drops = 0; this.#floorDrops = 0; this.#carryDrops = 0;
    this.#rally = 0; this.#rallyMax = 0; this.#rallies = [];
    this.#clampHits = 0; this.#firstDropMs = -1; this.#activeMs = 0;
    this.#sumDt = 0; this.#sumSpeedDt = 0; this.#sumEnergyDt = 0;
    this.#maxSpeed = 0; this.#maxEnergy = 0;
    this.#hitImpulseSum = 0; this.#hitAgeSum = 0; this.#hitAgeCount = 0;
    this.#firstHitMs = -1; this.#lastHitMs = -1;
    this.#ivSum = 0; this.#iv2Sum = 0; this.#ivCount = 0;
    this.#hitHSum = 0; this.#hitH2Sum = 0;
    this.#hitXSum = 0; this.#hitX2Sum = 0;
    this.#apexSum = 0;
    this.#flashMs = 0;

    this.#spawn();
  }

  startPlay() { this.#playing = true; }
  stopPlay()  { this.#playing = false; }

  // 推論のたびに呼ばれる。マスクを占有率フィールドへ畳み込む。
  setMask(mask, w, h) {
    this.#field.build(mask, w, h, this.mirror, performance.now() / 1000);
  }

  #spawn() {
    // 初期条件は全条件・全試行で同一にする(中央・初速ゼロ)。
    // 乱数を入れると条件間の比較にノイズが乗るので入れない。
    this.#ball.x = SPAWN.x;
    this.#ball.y = SPAWN.y;
    this.#ball.vx = 0;
    this.#ball.vy = 0;
    this.#inContact = false;
    this.#contactMs = 0;
    this.#frozen = false;
    this.#emit('spawn', {});
  }

  // ---- 物理 ----
  update(dtMs) {
    this.#tNow = performance.now() / 1000;
    if (this.#flashMs > 0) this.#flashMs -= dtMs;
    if (!this.#playing) return;

    if (this.#frozen) {
      this.#freezeMs -= dtMs;
      if (this.#freezeMs <= 0) this.#spawn();
      return;                                   // 再投入待ちは実プレイ時間に数えない
    }

    const P = PHYSICS;
    const dt = Math.min(dtMs / 1000, P.maxFrameDt);
    this.#activeMs += dtMs;
    this.#acc += dt;

    let dropped = false;
    while (this.#acc >= P.fixedDt && !dropped) {
      dropped = this.#step(P.fixedDt);
      this.#acc -= P.fixedDt;
    }
    if (dropped) this.#acc = 0;

    // 統計(時間加重)
    const b = this.#ball;
    const sp = Math.hypot(b.vx, b.vy);
    // 力学的エネルギー(単位質量あたり)。完全弾性なので保存するはず。
    // 増え続けるなら位置補正がエネルギーを注入している = 暴走の兆候。
    const en = 0.5 * sp * sp + this.#gravity * (FLOOR_Y - b.y);
    const s  = dtMs / 1000;
    this.#sumDt += s;
    this.#sumSpeedDt  += sp * s;
    this.#sumEnergyDt += en * s;
    if (sp > this.#maxSpeed)  this.#maxSpeed = sp;
    if (en > this.#maxEnergy) this.#maxEnergy = en;
  }

  // 1 サブステップ。落下したら true。
  #step(h) {
    const b = this.#ball, P = PHYSICS;

    b.vy += this.#gravity * h;                    // ★唯一の独立変数

    if (P.airPerSec !== 1) {                      // ステップ数に依存しない不変形
      const d = Math.pow(P.airPerSec, h);
      b.vx *= d; b.vy *= d;
    }

    b.x += b.vx * h;
    b.y += b.vy * h;

    const contact = this.#collideShadow();
    this.#contactMs = contact ? this.#contactMs + h * 1000 : 0;
    this.#inContact = contact;

    // 体に乗せて静止させると無限ラリーになり従属変数が壊れる
    if (P.enforceCarry && this.#contactMs > P.maxCarryMs) {
      this.#drop('carry');
      return true;
    }

    // 壁(左右・上)。床だけが失敗条件なので床には壁を置かない。
    if (b.x < BALL_R)           { b.x = BALL_R;           b.vx =  Math.abs(b.vx); }
    if (b.x > WORLD_W - BALL_R) { b.x = WORLD_W - BALL_R; b.vx = -Math.abs(b.vx); }
    if (b.y < BALL_R)           { b.y = BALL_R;           b.vy =  Math.abs(b.vy); }

    const sp = Math.hypot(b.vx, b.vy);
    if (sp > P.maxSpeed) {                        // 安全網。発火したらその試行は疑う
      const k = P.maxSpeed / sp;
      b.vx *= k; b.vy *= k;
      this.#clampHits++;
    }

    if (b.y + BALL_R >= FLOOR_Y) { this.#drop('floor'); return true; }
    return false;
  }

  // 影との衝突。接触していたら true。
  #collideShadow() {
    const b = this.#ball, P = PHYSICS, f = this.#field, t = this.#tNow;

    const c = f.sample(b.x, b.y, t);
    if (c < P.shadowThresh) return false;

    // 法線 = -∇O/‖∇O‖ (影の外を向く)。これが「体の角度で跳ね返る向きが決まる」の実体。
    const e = P.gradStep;
    const xl = f.sample(b.x - e, b.y, t), xr = f.sample(b.x + e, b.y, t);
    const yu = f.sample(b.x, b.y - e, t), yd = f.sample(b.x, b.y + e, t);
    const gx = (xr - xl) / (2 * e);
    const gy = (yd - yu) / (2 * e);
    let gm = Math.hypot(gx, gy);
    let nx, ny;
    if (gm < P.gradMin) { nx = 0; ny = -1; gm = P.gradMin; }  // 体の内部深く → 真上へ逃がす
    else                { nx = -gx / gm; ny = -gy / gm; }

    const rising = !this.#inContact;           // 接触の立ち上がり = リフティング 1 回
    const vn = b.vx * nx + b.vy * ny;

    if (vn < 0) {
      // --- 接近中: 弾む ---
      //
      // ここで法線方向に押し出してはいけない。上向きに動かすと位置エネルギーが増え、
      // しかもその量は行き過ぎ量 ∝ v·h ∝ √g に比例するので「高重力ほど勝手にエネルギーを
      // 得る」という交絡になる(完全弾性なので減衰せず、跳ねるたびに複利で溜まる)。
      //
      // 正しくは「θ 面を行き過ぎた分を、ボール自身の進行方向に沿って巻き戻す」。
      // 行き過ぎた時間ぶんの重力加算も取り消せば、面上の状態が厳密に復元しエネルギーが保存する。
      const speed = Math.hypot(b.vx, b.vy);
      if (speed > 1e-6) {
        // ∇O·v̂ = gm·(-vn)/|v| なので、O を θ まで戻すのに必要な後退距離は:
        let s = (c - P.shadowThresh) * speed / (gm * -vn);
        if (s > P.maxPush) s = P.maxPush;     // 影が突然生えた等の異常時の保険
        if (s > 0) {
          const dtBack = s / speed;
          b.x -= (b.vx / speed) * s;
          b.y -= (b.vy / speed) * s;
          b.vy -= this.#gravity * dtBack;     // 行き過ぎ中に加算された重力を取り消す
        }
      }

      // 完全弾性反射(静止壁)。巻き戻しで vy が変わったので法線速度を取り直す。
      const vn2 = b.vx * nx + b.vy * ny;
      const vx0 = b.vx, vy0 = b.vy;
      const j = -(1 + P.restitution) * vn2;
      b.vx += j * nx;
      b.vy += j * ny;

      if (rising) this.#registerHit(vx0, vy0, nx, ny, c, j, f.age(t));
    } else {
      // --- 接近していないのに埋まっている: 影の方が動いてボールに入り込んだ ---
      // 深さに比例して押し出す。これが唯一のエネルギー注入経路(= 体でボールをすくい上げる)。
      // 幾何的な効果で重力には依存しないので、独立変数は汚さない。
      let phi = (c - P.shadowThresh) / gm;
      const cap = P.maxPush / P.posCorrect;
      if (phi > cap) phi = cap;
      b.x += nx * phi * P.posCorrect;
      b.y += ny * phi * P.posCorrect;
      if (rising) this.#emit('touch', { occupancy: c.toFixed(3) });
    }
    return true;
  }

  #registerHit(vx0, vy0, nx, ny, occupancy, impulse, ageMs) {
    this.#hits++;
    this.#rally++;
    if (this.#rally > this.#rallyMax) this.#rallyMax = this.#rally;
    this.#hitImpulseSum += impulse;
    if (Number.isFinite(ageMs)) { this.#hitAgeSum += ageMs; this.#hitAgeCount++; }
    this.#flashMs = 160;

    const b = this.#ball;

    // --- 行動指標 ---
    if (this.#firstHitMs < 0) this.#firstHitMs = this.#activeMs;
    // 打点間隔はラリー内(直前にドロップを挟まない連続打)のみ。再投入待ちを跨ぐと
    // テンポの指標として意味を持たない。
    if (this.#lastHitMs >= 0) {
      const iv = this.#activeMs - this.#lastHitMs;
      this.#ivSum += iv; this.#iv2Sum += iv * iv; this.#ivCount++;
    }
    this.#lastHitMs = this.#activeMs;

    const hh = FLOOR_Y - b.y;               // 打点高さ(床基準)
    this.#hitHSum += hh; this.#hitH2Sum += hh * hh;
    this.#hitXSum += b.x; this.#hitX2Sum += b.x * b.x;
    // 反射直後の vy から放物線の頂点高さを見積もる(上向きでなければ打点高さのまま)
    const apex = b.vy < 0 && this.#gravity > 0
      ? hh + (b.vy * b.vy) / (2 * this.#gravity)
      : hh;
    this.#apexSum += apex;

    this.#emit('hit', {
      ball_x: b.x.toFixed(1), ball_y: b.y.toFixed(1),
      vx_in: vx0.toFixed(1), vy_in: vy0.toFixed(1),
      vx_out: b.vx.toFixed(1), vy_out: b.vy.toFixed(1),
      normal_x: nx.toFixed(3), normal_y: ny.toFixed(3),
      occupancy: occupancy.toFixed(3),
      impulse: impulse.toFixed(1),
      rally_at_event: this.#rally,
      infer_age_ms: Number.isFinite(ageMs) ? ageMs.toFixed(1) : '',
    });
  }

  #drop(reason) {
    this.#drops++;
    if (reason === 'floor') this.#floorDrops++; else this.#carryDrops++;
    if (this.#firstDropMs < 0) this.#firstDropMs = this.#activeMs;

    this.#rallies.push(this.#rally);
    this.#emit('drop', { drop_reason: reason, rally_at_event: this.#rally });
    this.#rally = 0;
    this.#lastHitMs = -1;   // 打点間隔はラリー内のみで集計する

    this.#frozen  = true;
    this.#freezeMs = EXPERIMENT.respawnDelayMs;
    this.#ball.vx = 0;
    this.#ball.vy = 0;
  }

  #emit(type, data) {
    if (this.onEvent) this.onEvent(type, { t_ms: Math.round(this.#activeMs), ...data });
  }

  // ---- 読み取り ----
  get ball()     { return this.#ball; }
  get field()    { return this.#field; }
  get frozen()   { return this.#frozen; }
  get hits()     { return this.#hits; }
  get drops()    { return this.#drops; }
  get rally()    { return this.#rally; }
  get rallyMax() { return this.#rallyMax; }
  get activeMs() { return this.#activeMs; }

  get stats() {
    const n = this.#sumDt || 1;
    const r = this.#rallies;
    // ストリーミング分散: sd = sqrt(E[x²] − E[x]²)。丸め誤差で負に振れたら 0 に潰す
    const sd = (sum, sum2, cnt) => {
      if (cnt < 2) return NaN;
      const m = sum / cnt;
      return Math.sqrt(Math.max(0, sum2 / cnt - m * m));
    };
    const ivMean = this.#ivCount ? this.#ivSum / this.#ivCount : NaN;
    const ivSd   = sd(this.#ivSum, this.#iv2Sum, this.#ivCount);
    const fmt = (v, digits) => Number.isFinite(v) ? v.toFixed(digits) : '';
    return {
      hit_count:   this.#hits,
      drop_count:  this.#drops,
      floor_drops: this.#floorDrops,
      carry_drops: this.#carryDrops,
      rally_max:   this.#rallyMax,
      rally_mean:  r.length ? (r.reduce((a, b) => a + b, 0) / r.length).toFixed(2) : '',
      rallies:     r.join('|'),
      time_to_first_drop_ms: this.#firstDropMs < 0 ? '' : Math.round(this.#firstDropMs),
      mean_ball_speed_px_s:  (this.#sumSpeedDt / n).toFixed(1),
      max_ball_speed_px_s:   this.#maxSpeed.toFixed(1),
      mean_ball_energy:      (this.#sumEnergyDt / n).toFixed(0),
      max_ball_energy:       this.#maxEnergy.toFixed(0),
      mean_hit_impulse_px_s: this.#hitImpulseSum && this.#hits
        ? (this.#hitImpulseSum / this.#hits).toFixed(1) : '',
      mean_hit_infer_age_ms: this.#hitAgeCount
        ? (this.#hitAgeSum / this.#hitAgeCount).toFixed(1) : '',
      clamp_hits: this.#clampHits,

      // --- 行動指標(主観評価との対応づけ用) ---
      time_to_first_hit_ms: this.#firstHitMs < 0 ? '' : Math.round(this.#firstHitMs),
      hit_interval_mean_ms: fmt(ivMean, 0),                    // 課題のテンポ
      hit_interval_cv:      fmt(ivSd / ivMean, 3),             // テンポの乱れ(変動係数)
      hit_height_mean_px:   this.#hits
        ? (this.#hitHSum / this.#hits).toFixed(1) : '',        // 迎撃高さ(床基準)
      hit_height_sd_px:     fmt(sd(this.#hitHSum, this.#hitH2Sum, this.#hits), 1),
      hit_x_sd_px:          fmt(sd(this.#hitXSum, this.#hitX2Sum, this.#hits), 1),  // 横の追い回され
      hit_apex_mean_px:     this.#hits
        ? (this.#apexSum / this.#hits).toFixed(1) : '',        // 打ち上げの高さ(強打/ちょん当て)
    };
  }

  // ---- 描画 ----
  // 描画は world 座標で書く。setTransform で表示サイズへ写す。
  draw() {
    const ctx = this.#ctx;
    const cw = ctx.canvas.width, ch = ctx.canvas.height;
    ctx.setTransform(cw / WORLD_W, 0, 0, ch / WORLD_H, 0, 0);
    ctx.clearRect(0, 0, WORLD_W, WORLD_H);

    // 床(失敗ライン)
    ctx.fillStyle = FLOOR_COLOR;
    ctx.fillRect(0, FLOOR_Y, WORLD_W, WORLD_H - FLOOR_Y);

    if (this.#frozen) return;

    const b = this.#ball;
    if (this.#flashMs > 0) {                    // 打った瞬間のリング
      ctx.beginPath();
      ctx.arc(b.x, b.y, BALL_R + 24 * (this.#flashMs / 160), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255, 210, 63, ${this.#flashMs / 160})`;
      ctx.lineWidth = 8;
      ctx.stroke();
    }

    const g = ctx.createRadialGradient(
      b.x - BALL_R * 0.3, b.y - BALL_R * 0.3, BALL_R * 0.1,
      b.x, b.y, BALL_R,
    );
    g.addColorStop(0, '#fff3b0');
    g.addColorStop(1, BALL_COLOR);
    ctx.beginPath();
    ctx.arc(b.x, b.y, BALL_R, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#000';
    ctx.stroke();
  }
}
