import {
  WORLD_W, GRAVITY_LEVELS, BASELINE_GRAVITY, EXPERIMENT, PHYSICS,
} from './settings.js';

// 試行の進行と盲検を受け持つ。
//
// ★盲検の担保: 重力値は #queue と game.setGravity() と logger の中だけに存在し、
//   このクラスは画面に出す値を一切公開しない。gravity の getter を作ってはいけない。
//
//   idle ─begin(pid)→ ready ─next()→ countdown → running → ended ─next()→ … → done

// 参加者IDから再現可能な乱数列を作る(同じIDなら同じ提示順になる)
function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class Session {
  #game; #logger;
  #state = 'idle';         // idle | ready | countdown | running | ended | done
  #queue = [];
  #pos   = -1;
  #seed  = 0;

  #countdownMs = 0;
  #elapsedMs   = 0;        // 実プレイ時間(再投入待ちを除く)
  #wallMs      = 0;        // 実時間
  #durationMs  = 0;
  #startedAt   = '';

  // 推論レートの試行内統計(遅延が独立変数と交絡していないかの事後検証用)
  #inferSamples = [];
  #coverageSum = 0; #coverageCount = 0; #framesNoPerson = 0;

  constructor(game, logger) {
    this.#game   = game;
    this.#logger = logger;
    this.#game.onEvent = (type, data) => this.#logger.event(type, data);
  }

  get state()      { return this.#state; }
  get isPractice() { return this.#current?.is_practice === 1; }
  get progress()   {
    if (this.#state === 'idle') return '— / —';
    const real = this.#queue.filter(q => !q.is_practice).length;
    if (this.isPractice) return `練習 / 全 ${real}`;
    const n = this.#queue.slice(0, this.#pos + 1).filter(q => !q.is_practice).length;
    return `${n} / ${real}`;
  }
  get nextLabel() {
    if (this.#state === 'idle')  return '開始';
    if (this.#state === 'done')  return '完了';
    if (this.#pos + 1 >= this.#queue.length) return '完了';
    return this.#queue[this.#pos + 1].is_practice ? '練習を開始' : '次の試行';
  }
  get canStart() { return this.#state === 'ready' || this.#state === 'ended'; }
  get running()  { return this.#state === 'countdown' || this.#state === 'running'; }

  get #current() { return this.#pos >= 0 ? this.#queue[this.#pos] : null; }

  // ---- セッション開始 ----
  begin(participantId, meta) {
    this.#seed = hash32(participantId);
    const rnd  = mulberry32(this.#seed);

    const trials = [];
    for (let b = 0; b < EXPERIMENT.blocks; b++) {
      const order = shuffle(GRAVITY_LEVELS.map((_, i) => i), rnd);
      for (const i of order) trials.push({ level: GRAVITY_LEVELS[i], block: b + 1 });
    }

    this.#queue = [
      { is_practice: 1, block: 0, level: { id: 'practice', gravity: BASELINE_GRAVITY } },
      ...trials.map(t => ({ ...t, is_practice: 0 })),
    ].map((t, k) => ({ ...t, trial_index: k, presentation_order: k }));

    this.#logger.beginSession({
      participant_id: participantId,
      seed: this.#seed,
      session_started_at: new Date().toISOString(),
      ...meta,
    });

    this.#pos = -1;
    this.#state = 'ready';
  }

  // ---- 次の試行へ ----
  next() {
    if (!this.canStart) return;
    if (this.#pos + 1 >= this.#queue.length) { this.#state = 'done'; return; }

    this.#pos++;
    const t = this.#current;

    this.#game.reset();
    this.#game.setGravity(t.level.gravity);      // ★重力が外へ出る唯一の経路(その1)

    this.#durationMs  = t.is_practice ? EXPERIMENT.practiceMs : EXPERIMENT.trialMs;
    this.#countdownMs = EXPERIMENT.countdownMs;
    this.#elapsedMs   = 0;
    this.#wallMs      = 0;
    this.#startedAt   = new Date().toISOString();

    this.#inferSamples = [];
    this.#coverageSum = 0; this.#coverageCount = 0; this.#framesNoPerson = 0;

    const ratio = t.level.gravity / BASELINE_GRAVITY;
    this.#logger.beginTrial({           // ★重力が外へ出る唯一の経路(その2)
      trial_index:        t.trial_index,
      is_practice:        t.is_practice,
      block:              t.block,
      presentation_order: t.presentation_order,
      level_id:           t.level.id,
      gravity_px_s2:      t.level.gravity,
      gravity_ratio_baseline: ratio.toFixed(4),
      gravity_log2_ratio:     Math.log2(ratio).toFixed(4),
      gravity_equiv_m_s2:     (t.level.gravity / EXPERIMENT.pxPerMetre).toFixed(2),
      trial_planned_ms:   this.#durationMs,
      started_at:         this.#startedAt,
    });

    this.#state = 'countdown';
  }

  abort() {
    if (!this.running) return;
    this.#game.stopPlay();
    this.#logger.abortTrial();
    // 中止した水準は最後にもう一度出す(黙って消さない)
    const t = this.#current;
    this.#queue.push({ ...t, trial_index: this.#queue.length, presentation_order: this.#queue.length });
    this.#state = 'ended';
  }

  // 推論のたびに app.js から呼ばれる。試行内の推論レートと在席を記録する。
  noteInference(inferMs, coverage) {
    if (this.#state !== 'running') return;
    this.#inferSamples.push(inferMs);
    this.#coverageSum += coverage;
    this.#coverageCount++;
    if (coverage < 0.01) this.#framesNoPerson++;
  }

  // ---- 毎フレーム。game.update より先に呼ぶこと ----
  update(dtMs) {
    if (this.#state === 'countdown') {
      this.#countdownMs -= dtMs;
      if (this.#countdownMs <= 0) {
        this.#state = 'running';
        this.#game.startPlay();
        this.#logger.event('trial_start', {});
      }
      return;
    }

    if (this.#state === 'running') {
      this.#wallMs += dtMs;
      // 再投入待ちの間に時計を止める。止めないとミスの多い高重力条件だけ
      // 実プレイ時間が短くなり、独立変数と結合した交絡になる。
      const counting = !(EXPERIMENT.pauseClockOnRespawn && this.#game.frozen);
      if (counting) this.#elapsedMs += dtMs;
      if (this.#elapsedMs >= this.#durationMs) this.#endTrial();
    }
  }

  #endTrial() {
    this.#game.stopPlay();
    this.#logger.event('trial_end', {});

    const fps = this.#inferSamples.length;
    const meanMs = fps ? this.#inferSamples.reduce((a, b) => a + b, 0) / fps : 0;
    const maxMs  = fps ? Math.max(...this.#inferSamples) : 0;
    const secs   = this.#elapsedMs / 1000 || 1;

    this.#logger.endTrial(this.#game.stats, {
      trial_active_ms: Math.round(this.#elapsedMs),
      trial_wall_ms:   Math.round(this.#wallMs),
      drops_per_min:   (this.#game.drops / secs * 60).toFixed(2),
      hits_per_min:    (this.#game.hits  / secs * 60).toFixed(2),
      infer_fps_mean:  (fps / secs).toFixed(2),
      infer_ms_mean:   meanMs.toFixed(1),
      infer_ms_max:    maxMs.toFixed(1),
      mean_body_coverage: this.#coverageCount
        ? (this.#coverageSum / this.#coverageCount).toFixed(4) : '',
      frames_no_person: this.#framesNoPerson,
      ended_at: new Date().toISOString(),
    });

    this.#state = this.#pos + 1 >= this.#queue.length ? 'done' : 'ended';
  }

  // ---- HUD (world 座標。重力値は決して描かない) ----
  drawHud(ctx) {
    ctx.save();
    ctx.textBaseline = 'top';
    ctx.font = 'bold 44px sans-serif';
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.lineWidth = 6;

    const text = (s, x, y, align = 'left') => {
      ctx.textAlign = align;
      ctx.strokeText(s, x, y);
      ctx.fillText(s, x, y);
    };

    if (this.#state === 'ready' || this.#state === 'idle') {
      ctx.font = 'bold 56px sans-serif';
      text('準備ができたら「開始」を押してください', WORLD_W / 2, 480, 'center');
      ctx.restore();
      return;
    }

    if (this.#state === 'done') {
      ctx.font = 'bold 72px sans-serif';
      text('すべて終了しました', WORLD_W / 2, 460, 'center');
      ctx.font = 'bold 44px sans-serif';
      text('CSV を書き出してください', WORLD_W / 2, 560, 'center');
      ctx.restore();
      return;
    }

    if (this.#state === 'ended') {
      ctx.font = 'bold 72px sans-serif';
      text('試行 終了', WORLD_W / 2, 440, 'center');
      ctx.font = 'bold 44px sans-serif';
      text('評価用紙に記入してください', WORLD_W / 2, 540, 'center');
      ctx.restore();
      return;
    }

    // countdown / running 共通の上段
    text(`連続 ${this.#game.rally}`, 40, 30);
    text(`最高 ${this.#game.rallyMax}`, 40, 84);
    text(`ミス ${this.#game.drops}`, 40, 138);
    text(this.isPractice ? '練習' : `試行 ${this.progress}`, WORLD_W / 2, 30, 'center');

    const left = Math.max(0, this.#durationMs - this.#elapsedMs) / 1000;
    ctx.font = 'bold 56px sans-serif';
    text(`残り ${left.toFixed(1)}`, WORLD_W - 40, 30, 'right');

    if (this.#state === 'countdown') {
      const n = Math.ceil(this.#countdownMs / 1000);
      ctx.font = 'bold 220px sans-serif';
      text(n > 0 ? String(n) : 'スタート！', WORLD_W / 2, 380, 'center');
    }
    ctx.restore();
  }
}

// CSV の全行に付ける物理定数。パイロットで値を変えるので、データに焼き込んでおく。
export function physicsSnapshot() {
  return {
    fixed_dt:        PHYSICS.fixedDt,
    restitution:     PHYSICS.restitution,
    air_per_sec:     PHYSICS.airPerSec,
    max_speed:       PHYSICS.maxSpeed,
    shadow_thresh:   PHYSICS.shadowThresh,
    pos_correct:     PHYSICS.posCorrect,
    max_push:        PHYSICS.maxPush,
    grad_step:       PHYSICS.gradStep,
    extrapolate:     PHYSICS.extrapolate ? 1 : 0,
    latency_comp_ms: PHYSICS.latencyCompMs,
    max_carry_ms:    PHYSICS.maxCarryMs,
    enforce_carry:   PHYSICS.enforceCarry ? 1 : 0,
  };
}
