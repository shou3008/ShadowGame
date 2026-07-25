import { LiftingGame } from './lifting-game.js';
import { SilhouetteMask } from './mask.js';
import {
  WORLD_W, WORLD_H, BALL_R, FLOOR_Y, FIELD, PHYSICS, GRAVITY_LEVELS,
  SUBJECT_ONLY,
} from './settings.js';

// ?selftest=1 で実行。Node が無いので、これが唯一の自動検証。
//
// 各テストは「重力sweepを汚染する交絡が存在しないこと」を直接検査する。
// ここが赤いまま実験を回してはいけない。

export const SELFTEST_ON = new URLSearchParams(location.search).get('selftest') === '1';

const results = [];
const ok   = (name, detail) => results.push({ pass: true,  name, detail });
const fail = (name, detail) => results.push({ pass: false, name, detail });
const near = (a, b, tol) => Math.abs(a - b) <= tol;

function makeGame() {
  const c = document.createElement('canvas');
  c.width = 320; c.height = 180;
  const g = new LiftingGame(c);
  g.mirror = false;
  g.reset();
  g.startPlay();
  return g;
}

// world 座標の関数から占有率グリッドを作る
function gridFrom(fn) {
  const gw = FIELD.gridW, gh = FIELD.gridH;
  const cw = WORLD_W / gw, ch = WORLD_H / gh;
  const a = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      a[y * gw + x] = fn((x + 0.5) * cw, (y + 0.5) * ch);
    }
  }
  return a;
}

// 半平面の影。P を通り、内向き法線 m=(-sin,cos) の面より「下」が影。
// O はボール円板の埋まり率の一次近似 = 幅 2R で 0→1 に遷移する。
function halfPlane(px, py, tiltRad) {
  const mx = -Math.sin(tiltRad), my = Math.cos(tiltRad);
  return (x, y) => {
    const d = (x - px) * mx + (y - py) * my;
    const o = 0.5 + d / (2 * BALL_R);
    return o < 0 ? 0 : o > 1 ? 1 : o;
  };
}

const energy = (g, b) => 0.5 * (b.vx * b.vx + b.vy * b.vy) + g * (FLOOR_Y - b.y);
const FRAME = 1000 / 60;

// ---------------------------------------------------------------------------

// 1. 自由落下が ½gt² に一致する(積分器の健全性)
function testFreeFall() {
  const g = 2100, t = 0.4;
  const game = makeGame();
  game.setGravity(g);
  const b = game.ball;
  b.x = 960; b.y = 100; b.vx = 0; b.vy = 0;

  for (let i = 0; i < Math.round(t * 60); i++) game.update(FRAME);

  const expected = 100 + 0.5 * g * t * t;
  const drop = expected - 100;
  near(b.y, expected, drop * 0.02)
    ? ok('1. 自由落下 = ½gt²', `y=${b.y.toFixed(1)} (期待 ${expected.toFixed(1)})`)
    : fail('1. 自由落下 = ½gt²', `y=${b.y.toFixed(1)} 期待 ${expected.toFixed(1)}`);
}

// 2. 減衰がフレーム長に依存しない(交絡1: 空気抵抗の速度依存)
//    airPerSec=1.0 では自明に通るので、あえて減衰を入れて不変性を検査する。
function testDampingInvariance() {
  const saved = PHYSICS.airPerSec;
  PHYSICS.airPerSec = 0.94;

  const run = (frameMs) => {
    const game = makeGame();
    game.setGravity(0);
    const b = game.ball;
    b.x = 960; b.y = 500; b.vx = 3000; b.vy = 0;
    const frames = Math.round(1000 / frameMs);   // ちょうど 1 秒ぶん
    for (let i = 0; i < frames; i++) game.update(frameMs);
    // 壁で跳ね返ると符号が反転するが、完全弾性なので速さは保たれる。速さで比べる。
    return Math.abs(b.vx);
  };

  const a = run(1000 / 60), c = run(1000 / 30), d = run(50);
  PHYSICS.airPerSec = saved;

  const expected = 3000 * 0.94;
  const spread = Math.max(a, c, d) - Math.min(a, c, d);
  spread < expected * 0.01 && near(a, expected, expected * 0.02)
    ? ok('2. 減衰がフレーム長に不変', `60fps=${a.toFixed(0)} 30fps=${c.toFixed(0)} 20fps=${d.toFixed(0)} (期待 ${expected.toFixed(0)})`)
    : fail('2. 減衰がフレーム長に不変', `ばらつき ${spread.toFixed(1)} px/s — サブステップ数に依存している`);
}

// 3. 全5水準で速度クランプが発火しない(交絡2)
function testNoClamp() {
  const lines = [];
  let allOk = true;

  for (const lv of GRAVITY_LEVELS) {
    const game = makeGame();
    game.setGravity(lv.gravity);
    const b = game.ball;
    b.x = 960; b.y = BALL_R + 30; b.vx = 0; b.vy = 0;

    let peak = 0;
    for (let i = 0; i < 600 && game.drops === 0; i++) {
      game.update(FRAME);
      peak = Math.max(peak, Math.hypot(b.vx, b.vy));
    }

    const dropDist = (FLOOR_Y - BALL_R) - (BALL_R + 30);
    const expected = Math.sqrt(2 * lv.gravity * dropDist);
    const clamps = game.stats.clamp_hits;
    const good = clamps === 0 && near(peak, expected, expected * 0.03);
    if (!good) allOk = false;
    lines.push(`${lv.id}: 最高速 ${peak.toFixed(0)} (期待 ${expected.toFixed(0)}) clamp=${clamps}`);
  }

  allOk ? ok('3. 速度クランプ不発火', lines.join(' / '))
        : fail('3. 速度クランプ不発火', lines.join(' / '));
}

// 4+5. 完全弾性のエネルギー保存が、全5水準で成り立つ(e=1.0 の要請 + 独立変数の純度)
//      跳ね返り後の最高到達点が落下開始点に戻ることを見る。
function testElasticConservation() {
  const lines = [];
  let allOk = true;

  for (const lv of GRAVITY_LEVELS) {
    const game = makeGame();
    game.setGravity(lv.gravity);
    game.field.injectGrid(gridFrom(halfPlane(960, 800, 0)), 0);

    const b = game.ball;
    b.x = 960; b.y = 200; b.vx = 0; b.vy = 0;
    const e0 = energy(lv.gravity, b);

    let bounces = 0, wasDown = true, apex = b.y, eMax = e0;
    for (let i = 0; i < 4000 && bounces < 20 && game.drops === 0; i++) {
      game.update(FRAME);
      const down = b.vy > 0;
      if (wasDown && !down) bounces++;             // 下降 → 上昇 = 1 バウンド
      if (!down) apex = Math.min(apex, b.y);       // 上昇中の最高点
      wasDown = down;
      eMax = Math.max(eMax, energy(lv.gravity, b));
    }

    const e1 = energy(lv.gravity, b);
    const ratio = e1 / e0;
    // 静止影ならエネルギーは厳密に保存するはず。ずれるなら衝突解決が
    // エネルギーを注入/散逸している(= 高重力ほど強く効く交絡)。
    const good = bounces >= 20 && near(ratio, 1, 0.02);
    if (!good) allOk = false;
    lines.push(`${lv.id}: ${bounces}回 E比=${ratio.toFixed(3)} 最高点y=${apex.toFixed(0)}`);
  }

  allOk
    ? ok('4/5. 完全弾性の保存(全5水準)', lines.join(' / '))
    : fail('4/5. 完全弾性の保存(全5水準)', `${lines.join(' / ')} ← E比が 1 から外れる = 位置補正がエネルギーを注入/散逸`);
}

// 6. 落下開始点が同じなら、跳ね返り後の最高到達点は重力に依存しない
//    (e=1 なので apex = 落下開始高さ。ここが揃わないなら重力以外の何かが効いている)
function testApexGravityIndependent() {
  const apexes = [];
  for (const lv of GRAVITY_LEVELS) {
    const game = makeGame();
    game.setGravity(lv.gravity);
    game.field.injectGrid(gridFrom(halfPlane(960, 800, 0)), 0);

    const b = game.ball;
    b.x = 960; b.y = 200; b.vx = 0; b.vy = 0;

    let wasDown = true, apex = 1e9, bounced = false;
    for (let i = 0; i < 2000 && game.drops === 0; i++) {
      game.update(FRAME);
      const down = b.vy > 0;
      if (wasDown && !down) bounced = true;
      if (bounced && !down) apex = Math.min(apex, b.y);
      if (bounced && down && apex < 1e9) break;   // 1回目の頂点を過ぎた
      wasDown = down;
    }
    apexes.push(apex);
  }

  const spread = Math.max(...apexes) - Math.min(...apexes);
  const detail = GRAVITY_LEVELS.map((lv, i) => `${lv.id}:${apexes[i].toFixed(0)}`).join(' ');
  spread < 20
    ? ok('6. 跳ね返り高さが重力に不依存', `${detail} (ばらつき ${spread.toFixed(1)}px)`)
    : fail('6. 跳ね返り高さが重力に不依存', `${detail} — ばらつき ${spread.toFixed(1)}px が大きい`);
}

// 7. 傾いた面に垂直落下 → 反射角が 2θ になる(「体の角度で跳ね返る向きが決まる」)
function testReflectionAngle() {
  const lines = [];
  let allOk = true;

  for (const deg of [0, 15, 30, 45]) {
    const rad = deg * Math.PI / 180;
    const game = makeGame();
    game.setGravity(0);                              // 重力を切って反射だけを見る
    game.field.injectGrid(gridFrom(halfPlane(960, 700, rad)), 0);

    const b = game.ball;
    b.x = 960; b.y = 300; b.vx = 0; b.vy = 1500;

    for (let i = 0; i < 300 && b.vy > 0; i++) game.update(FRAME);

    // 期待: v_out = 1500 * (sin2θ, -cos2θ)
    const outDeg = Math.atan2(b.vx, -b.vy) * 180 / Math.PI;
    const speed  = Math.hypot(b.vx, b.vy);
    const good = near(outDeg, 2 * deg, 6) && near(speed, 1500, 1500 * 0.05);
    if (!good) allOk = false;
    lines.push(`${deg}°→${outDeg.toFixed(1)}° (期待 ${2 * deg}°) |v|=${speed.toFixed(0)}`);
  }

  allOk ? ok('7. 反射角 = 2θ', lines.join(' / '))
        : fail('7. 反射角 = 2θ', lines.join(' / '));
}

// 8. 影を上向きに掃引 → エネルギーが発散しない(e=1.0 の暴走検知)
//    位置補正が唯一のエネルギー注入経路なので、ここが暴れるなら posCorrect を下げる。
function testSweepDoesNotDiverge() {
  const g = 2100;
  const game = makeGame();
  game.setGravity(g);

  const b = game.ball;
  b.x = 960; b.y = 300; b.vx = 0; b.vy = 0;
  const e0 = energy(g, b) || 1;

  // 影の面を 800px から 600px まで上向きに掃引しながら 3 秒回す
  let eMax = e0;
  const frames = 180;
  for (let i = 0; i < frames && game.drops === 0; i++) {
    const t = i / 60;
    const edgeY = 800 - Math.min(200, 800 * t * 0.25);
    game.field.injectGrid(gridFrom(halfPlane(960, edgeY, 0)), t);
    game.update(FRAME);
    eMax = Math.max(eMax, energy(g, b));
  }

  const growth = eMax / e0;
  const clamps = game.stats.clamp_hits;
  const peak = Number(game.stats.max_ball_speed_px_s);

  clamps === 0 && peak < PHYSICS.maxSpeed
    ? ok('8. 影の掃引でエネルギーが発散しない', `E増加 ${growth.toFixed(2)}倍 / 最高速 ${peak.toFixed(0)} / clamp=0`)
    : fail('8. 影の掃引でエネルギーが発散しない', `E増加 ${growth.toFixed(2)}倍 / 最高速 ${peak.toFixed(0)} / clamp=${clamps} ← posCorrect を下げる`);
}

// 9. 被験者選択: オープニングで千切れた腕が復元され、映り込んだ別人は消える。
//    腕はこの装置の入力デバイスそのもの。腕が欠けると全条件の操作性が壊れ、
//    別人の影が残ると被験者以外がボールに触れる(どちらも従属変数を汚染する)。
function testSubjectMask() {
  if (!SUBJECT_ONLY) {
    fail('9. 被験者選択と腕の復元', 'SUBJECT_ONLY=false — 実験では有効にすること');
    return;
  }
  const W = 160, H = 90;
  const seg = (draw) => {
    const data = new Uint8Array(W * H);
    const rect = (x0, y0, x1, y1) => {
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) data[y * W + x] = 1;
    };
    draw(rect);
    return { width: W, height: H, data };
  };
  // 体 + 幅3px の腕 + 手。幅3px はオープニング(r=2 → 幅5px未満を削除)で必ず千切れる
  const subject = (rect) => {
    rect(30, 20, 55, 80);   // 体
    rect(56, 30, 80, 32);   // 腕
    rect(81, 26, 88, 36);   // 手
  };
  const at = (m, x, y) => m.smooth[y * W + x];

  const m = new SilhouetteMask();
  m.reset(W, H);
  m.update(seg(subject));                  // 1: 被験者のみ → 追跡確立
  const armAlone = at(m, 70, 31);

  m.update(seg((rect) => {                 // 2: 被験者より大きい別人がメタボール橋で繋がる
    subject(rect);
    rect(100, 10, 150, 85);                // 別人
    rect(89, 30, 99, 32);                  // 橋 (幅3px)
  }));
  const arm      = at(m, 70, 31);
  const hand     = at(m, 84, 31);
  const body     = at(m, 40, 50);
  const intruder = at(m, 125, 45);

  m.update(seg(subject));                  // 3: 別人が退出
  const after = at(m, 40, 50);

  const good = armAlone > 0.5 && arm > 0.5 && hand > 0.5 && body > 0.5 &&
               intruder < 0.1 && after > 0.9;
  const detail =
    `腕=${arm.toFixed(2)} 手=${hand.toFixed(2)} 体=${body.toFixed(2)} ` +
    `別人=${intruder.toFixed(2)} 退出後=${after.toFixed(2)}`;
  good ? ok('9. 被験者選択と腕の復元', detail)
       : fail('9. 被験者選択と腕の復元', detail + ' ← 腕>0.5 / 別人<0.1 が期待値');
}

// ---------------------------------------------------------------------------

export function runSelfTest() {
  results.length = 0;

  const savedExtrap = PHYSICS.extrapolate;
  PHYSICS.extrapolate = false;   // 時間外挿は物理と独立。ここでは切って物理だけを見る

  try {
    testFreeFall();
    testDampingInvariance();
    testNoClamp();
    testElasticConservation();
    testApexGravityIndependent();
    testReflectionAngle();
    testSweepDoesNotDiverge();
    testSubjectMask();
  } catch (err) {
    fail('例外', String(err && err.stack || err));
  } finally {
    PHYSICS.extrapolate = savedExtrap;
  }

  const passed = results.filter(r => r.pass).length;
  console.log(`%c=== SELFTEST ${passed}/${results.length} ===`,
    'font-weight:bold;font-size:14px');
  for (const r of results) {
    console.log(
      `%c${r.pass ? 'PASS' : 'FAIL'}%c ${r.name}\n      ${r.detail}`,
      `color:#fff;background:${r.pass ? '#2e7d32' : '#c0392b'};padding:1px 6px;border-radius:3px`,
      'color:inherit',
    );
  }
  return { passed, total: results.length, results };
}
