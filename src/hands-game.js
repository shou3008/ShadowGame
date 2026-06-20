// 重なりポリゴン物理モード (Matter.js / ブーリアン交差)
//
//   方針:
//     1. BodyPix のキーポイントから、各人物の「全身形状」を凸ポリゴンの集合で作る
//        (四肢=矩形, 胴体=四角形, 頭=多角形)。
//     2. Person A の各凸ポリゴン と Person B の各凸ポリゴンの交差(Intersection)を
//        全ペアで取り、「重なり合っている部分の正確な形状」の頂点群を得る。
//        ∪Aᵢ と ∪Bⱼ の交差は ∪(Aᵢ∩Bⱼ) に等しく、凸×凸の交差は必ず凸なので
//        poly-decomp 不要で安定して扱える(要件1)。
//     3. 得た頂点群を Matter.Bodies.fromVertices で静的ボディとして毎フレーム再生成し、
//        上から降る物理オブジェクトと衝突させる(要件2-1)。
//     4. 形がスライム状にうねるのを防ぐため、ポリゴン化の「前」に、各キーポイント座標へ
//        指数移動平均(EMA)ローパスフィルタを掛けて微振動を吸収する(要件2-2)。
//     5. DEBUG_SINGLE_PLAYER=true のとき、Person B を画面右半分の固定ダミー人型にして
//        1人でも「実際の重なり形状」の描画と物理を検証できる(要件3)。
//
//   座標系: 仮想ワールド 1920×1080。キーポイントは推論入力(w,h)→世界座標へ写像。

const WORLD_W = 1920, WORLD_H = 1080;

// ★要件3: 1人デバッグ。true で Person B = 右半分の固定ダミー人型。
export const DEBUG_SINGLE_PLAYER = true;

// --- チューニング定数 ---
const KP_SCORE_MIN = 0.50;   // このスコア未満のキーポイントは未検出扱い
const POSE_SCORE_MIN = 0.40; // 人物として採用する pose 全体の最低スコア
const EMA_ALPHA = 0.30;      // ★要件2-2: 小さいほど強い平滑化(うねり防止)。0.2〜0.4 が目安
const CONF_DECAY = 0.85;     // 一時的に見失ったキーポイントの保持(減衰)
const CONF_DROP  = 0.20;     // これ未満になったら破棄

// 四肢の「太さ」(世界座標 px, 半径)。体格・画角に合わせて調整。
const ARM_R = 55, LEG_R = 70, HEAD_R = 95;

const MIN_OVERLAP_AREA = 350;  // これ未満の交差ポリゴンは無視(スライバー除去)
const SPAWN_EVERY_MS = 850;
const DROP_R_MIN = 34, DROP_R_MAX = 54;
const OFFSCREEN_MARGIN = 240;

const OVERLAP_FILL = 'rgba(255, 60, 60, 0.78)';
const BODY_A_FILL  = 'rgba(79, 209, 255, 0.18)';
const BODY_B_FILL  = 'rgba(255, 143, 171, 0.18)';
const DROP_COLORS  = ['#ffd23f', '#4fd1ff', '#9d7bff', '#7CFFB2', '#ff8fab'];

// 平滑化・形状生成に使うキーポイント
const BODY_PARTS = [
  'nose', 'leftEar', 'rightEar',
  'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftWrist', 'rightWrist',
  'leftHip', 'rightHip', 'leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle',
];

// 四肢の線分(端点ペアと半径)
const LIMB_SEGMENTS = [
  ['leftShoulder', 'leftElbow',  ARM_R], ['leftElbow',  'leftWrist',  ARM_R],
  ['rightShoulder', 'rightElbow', ARM_R], ['rightElbow', 'rightWrist', ARM_R],
  ['leftHip',  'leftKnee',  LEG_R], ['leftKnee',  'leftAnkle',  LEG_R],
  ['rightHip', 'rightKnee', LEG_R], ['rightKnee', 'rightAnkle', LEG_R],
];

export class HandsGame {
  #canvas; #ctx;
  #Matter; #engine; #world;
  #colliderParts = [];      // 重なり形状から作った静的ボディ群(毎フレーム作り直す)
  #drops = [];
  #spawnAcc = 0;
  #caught = 0;
  #smA = new PersonSmoother(EMA_ALPHA);  // Person A の平滑化済みキーポイント
  #smB = new PersonSmoother(EMA_ALPHA);  // Person B (非デバッグ時のみ使用)
  #dummyPolys = buildDummyPolys();       // ★要件3: 固定ダミー人型(右半分)
  #polysA = [];             // 描画用: A の全身ポリゴン
  #polysB = [];             // 描画用: B(またはダミー)の全身ポリゴン
  #overlapPolys = [];       // 描画用: 重なり交差ポリゴン

  constructor(overlayCanvas) {
    this.#canvas = overlayCanvas;
    this.#ctx    = overlayCanvas.getContext('2d');
    this.#Matter = window.Matter;
    if (!this.#Matter) {
      console.error('Matter.js が読み込まれていません。index.html の CDN <script> を確認してください。');
      return;
    }
    const { Engine } = this.#Matter;
    this.#engine = Engine.create();
    this.#world  = this.#engine.world;
    this.#engine.gravity.y = 1.0;
    this.reset();
  }

  get caught() { return this.#caught; }
  get won()    { return false; }

  reset() {
    if (!this.#Matter) return;
    this.#Matter.Composite.clear(this.#world, false);
    this.#colliderParts = [];
    this.#drops = [];
    this.#spawnAcc = 0;
    this.#caught = 0;
    this.#smA.clear(); this.#smB.clear();
    this.#polysA = []; this.#polysB = []; this.#overlapPolys = [];
  }

  // --- 推論ごとに: allPoses を平滑化 → 全身ポリゴン → 交差 → コライダー再生成 ---
  //   形状計算はデータが来るこのタイミングでだけ行う(EMAも測定ごと=正しい更新頻度)。
  setPoses(poses, w, h, mirror) {
    if (!this.#Matter) return;
    const toWorld = pt => ({
      x: (mirror ? (w - 1 - pt.x) : pt.x) * WORLD_W / w,
      y: pt.y * WORLD_H / h,
    });

    // 採用する pose を抽出し、各々を {part: {x,y}} (世界座標, スコア閾値済み) に変換
    const people = (poses || [])
      .filter(p => p && (p.score == null || p.score >= POSE_SCORE_MIN))
      .map(p => ({ kp: rawKeypoints(p, toWorld), c: null }))
      .filter(p => Object.keys(p.kp).length > 0)
      .sort((a, b) => kpCount(b.kp) - kpCount(a.kp));

    if (DEBUG_SINGLE_PLAYER) {
      // ★要件3: A=実在の最有力人物(平滑化), B=固定ダミー
      if (people[0]) this.#smA.update(people[0].kp); else this.#smA.decay();
      this.#polysA = buildPersonPolys(this.#smA.kp);
      this.#polysB = this.#dummyPolys;
    } else {
      // 2人を前フレームの重心で近い方へ割り当て(A/Bの入れ替わりを抑制)
      assignTwo(people, this.#smA, this.#smB);
      this.#polysA = buildPersonPolys(this.#smA.kp);
      this.#polysB = buildPersonPolys(this.#smB.kp);
    }

    // ★要件1-2: A の各凸ポリゴン × B の各凸ポリゴン の交差を全ペアで取る
    this.#overlapPolys = [];
    for (const pa of this.#polysA) {
      for (const pb of this.#polysB) {
        const inter = clipConvex(pa, pb);
        if (inter.length >= 3 && Math.abs(polygonArea(inter)) >= MIN_OVERLAP_AREA) {
          this.#overlapPolys.push(inter);
        }
      }
    }

    this.#rebuildCollider(this.#overlapPolys);
  }

  // --- 毎フレーム(60fps): 落下物の生成・物理ステップ・除去 ---
  update(dtMs) {
    if (!this.#Matter) return;
    const { Engine, Composite } = this.#Matter;

    this.#spawnAcc += dtMs;
    while (this.#spawnAcc >= SPAWN_EVERY_MS) {
      this.#spawnAcc -= SPAWN_EVERY_MS;
      this.#spawnDrop();
    }

    Engine.update(this.#engine, Math.min(dtMs, 33));

    const hasCollider = this.#colliderParts.length > 0;
    for (let i = this.#drops.length - 1; i >= 0; i--) {
      const b = this.#drops[i];
      const p = b.position;
      if (p.y > WORLD_H + OFFSCREEN_MARGIN ||
          p.x < -OFFSCREEN_MARGIN || p.x > WORLD_W + OFFSCREEN_MARGIN) {
        if (hasCollider && p.y < WORLD_H) this.#caught++;
        Composite.remove(this.#world, b);
        this.#drops.splice(i, 1);
      }
    }
  }

  draw() {
    if (!this.#Matter) return;
    const ctx = this.#ctx;
    const cw = ctx.canvas.width, ch = ctx.canvas.height;
    ctx.setTransform(cw / WORLD_W, 0, 0, ch / WORLD_H, 0, 0);
    ctx.clearRect(0, 0, WORLD_W, WORLD_H);

    // 各人物の全身ポリゴン(薄く)。デバッグのダミーが見えるようにする。
    fillPolys(ctx, this.#polysB, BODY_B_FILL);
    fillPolys(ctx, this.#polysA, BODY_A_FILL);

    // 落下オブジェクト
    for (const b of this.#drops) {
      ctx.beginPath();
      ctx.arc(b.position.x, b.position.y, b.circleRadius, 0, Math.PI * 2);
      ctx.fillStyle = b.__color || '#ffd23f';
      ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.stroke();
    }

    // ★要件1: 重なりの正確な形状を赤で塗る
    ctx.fillStyle = OVERLAP_FILL;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 4;
    for (const poly of this.#overlapPolys) {
      ctx.beginPath();
      ctx.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }

    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = 'bold 40px sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    const hint = DEBUG_SINGLE_PLAYER
      ? 'DEBUG: 右のダミーに自分の影を重ねてみよう'
      : '2人で身体を重ねて落下物を受け止めよう';
    ctx.fillText(`${hint}    受け止めた: ${this.#caught}`, 40, 40);
  }

  // --- 重なりポリゴン群から静的ボディを作り直す(要件2-1) ---
  #rebuildCollider(polys) {
    const { Bodies, Composite } = this.#Matter;
    for (const b of this.#colliderParts) Composite.remove(this.#world, b);
    this.#colliderParts = [];

    for (const poly of polys) {
      const c = centroid(poly);
      let body;
      try {
        // 凸ポリゴンなので poly-decomp 不要。centroid を渡して元の世界位置に留める。
        body = Bodies.fromVertices(c.x, c.y, poly, {
          isStatic: true, restitution: 0.4, friction: 0.4, label: 'overlap',
        }, true, true, 0.01);
      } catch (e) { continue; }
      if (!body) continue;
      Composite.add(this.#world, body);
      this.#colliderParts.push(body);
    }
  }

  #spawnDrop() {
    const { Bodies, Composite } = this.#Matter;
    const r = DROP_R_MIN + Math.random() * (DROP_R_MAX - DROP_R_MIN);
    const x = r + Math.random() * (WORLD_W - 2 * r);
    const b = Bodies.circle(x, -r, r, {
      restitution: 0.5, friction: 0.05, frictionAir: 0.004, label: 'drop',
    });
    b.__color = DROP_COLORS[(Math.random() * DROP_COLORS.length) | 0];
    Composite.add(this.#world, b);
    this.#drops.push(b);
  }
}

// ====================== 人物トラッキング + EMA 平滑化 ======================

// 1人分の平滑化済みキーポイントを保持する。測定が来るたびに EMA で更新し、
//   一時的に見失った部位は信頼度を減衰させながら値を保持する(=ちらつき防止)。
class PersonSmoother {
  constructor(alpha) { this.alpha = alpha; this.kp = {}; this.conf = {}; }

  clear() { this.kp = {}; this.conf = {}; }

  get centroid() {
    let sx = 0, sy = 0, n = 0;
    for (const part in this.kp) { sx += this.kp[part].x; sy += this.kp[part].y; n++; }
    return n ? { x: sx / n, y: sy / n } : null;
  }

  // raw: { part: {x,y} } (世界座標, スコア閾値済み)
  update(raw) {
    const a = this.alpha;
    for (const part of BODY_PARTS) {
      const r = raw[part];
      if (r) {
        if (this.kp[part]) {
          this.kp[part].x += a * (r.x - this.kp[part].x);   // ★要件2-2: EMA ローパス
          this.kp[part].y += a * (r.y - this.kp[part].y);
        } else {
          this.kp[part] = { x: r.x, y: r.y };
        }
        this.conf[part] = 1;
      } else if (this.kp[part]) {
        this.conf[part] *= CONF_DECAY;
        if (this.conf[part] < CONF_DROP) { delete this.kp[part]; delete this.conf[part]; }
      }
    }
  }

  // この測定で見つからなかった(=人物が消えた)とき、全体を減衰させる
  decay() {
    for (const part in this.conf) {
      this.conf[part] *= CONF_DECAY;
      if (this.conf[part] < CONF_DROP) { delete this.kp[part]; delete this.conf[part]; }
    }
  }
}

// 2人を前フレームの重心に近い方へ割り当てる(A/B 入れ替わり抑制)
function assignTwo(people, smA, smB) {
  const ca = smA.centroid, cb = smB.centroid;
  const used = new Array(people.length).fill(false);

  const nearest = ref => {
    if (!ref) return -1;
    let best = -1, bestD = Infinity;
    people.forEach((p, i) => {
      if (used[i]) return;
      const c = centroidOf(p.kp);
      const d = (c.x - ref.x) ** 2 + (c.y - ref.y) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  };

  let ia = nearest(ca);
  if (ia < 0) ia = people.findIndex((_, i) => !used[i]);
  if (ia >= 0) { used[ia] = true; smA.update(people[ia].kp); } else smA.decay();

  let ib = nearest(cb);
  if (ib < 0) ib = people.findIndex((_, i) => !used[i]);
  if (ib >= 0) { used[ib] = true; smB.update(people[ib].kp); } else smB.decay();
}

// ====================== ポリゴン生成 ======================

// pose の keypoints を {part:{x,y}}(世界座標, スコア閾値済み)に変換
function rawKeypoints(pose, toWorld) {
  const out = {};
  for (const k of (pose.keypoints || [])) {
    const part = k.part || k.name;
    if (!BODY_PARTS.includes(part)) continue;
    if ((k.score ?? 0) < KP_SCORE_MIN) continue;
    out[part] = toWorld(k.position || k);
  }
  return out;
}

function kpCount(kp) { return Object.keys(kp).length; }
function centroidOf(kp) {
  let sx = 0, sy = 0, n = 0;
  for (const part in kp) { sx += kp[part].x; sy += kp[part].y; n++; }
  return n ? { x: sx / n, y: sy / n } : { x: 0, y: 0 };
}

// 平滑化済みキーポイントから「全身形状」= 凸ポリゴンの配列を作る
function buildPersonPolys(kp) {
  const polys = [];
  // 四肢(端を半径ぶん延ばしたカプセル近似の矩形)
  for (const [a, b, r] of LIMB_SEGMENTS) {
    if (kp[a] && kp[b]) polys.push(segmentQuad(kp[a], kp[b], r));
  }
  // 胴体(肩2点 + 腰2点の四角形)
  if (kp.leftShoulder && kp.rightShoulder && kp.leftHip && kp.rightHip) {
    polys.push(ensureCCW([
      kp.leftShoulder, kp.rightShoulder, kp.rightHip, kp.leftHip,
    ].map(p => ({ x: p.x, y: p.y }))));
  }
  // 頭(鼻 or 耳中点を中心にした多角形)
  const head = kp.nose
    ? kp.nose
    : (kp.leftEar && kp.rightEar
        ? { x: (kp.leftEar.x + kp.rightEar.x) / 2, y: (kp.leftEar.y + kp.rightEar.y) / 2 }
        : null);
  if (head) polys.push(regularPolygon(head, HEAD_R, 8));
  return polys;
}

// 線分 p0-p1 を半径 r のカプセル近似(両端を r 延ばした矩形)にする
function segmentQuad(p0, p1, r) {
  let dx = p1.x - p0.x, dy = p1.y - p0.y;
  const len = Math.hypot(dx, dy) || 1e-6;
  dx /= len; dy /= len;
  const ex = dx * r, ey = dy * r;      // 端の延長
  const px = -dy * r, py = dx * r;     // 法線方向の太さ
  const a = { x: p0.x - ex, y: p0.y - ey };
  const b = { x: p1.x + ex, y: p1.y + ey };
  return ensureCCW([
    { x: a.x + px, y: a.y + py },
    { x: b.x + px, y: b.y + py },
    { x: b.x - px, y: b.y - py },
    { x: a.x - px, y: a.y - py },
  ]);
}

function regularPolygon(c, r, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    out.push({ x: c.x + Math.cos(t) * r, y: c.y + Math.sin(t) * r });
  }
  return ensureCCW(out);
}

// ★要件3: 右半分に固定ダミー人型を作る。腕は下げ気味でAが重ねやすい配置。
function buildDummyPolys() {
  const cx = WORLD_W * 0.74;
  const kp = {
    nose:          { x: cx,        y: 190 },
    leftShoulder:  { x: cx - 120,  y: 340 },
    rightShoulder: { x: cx + 120,  y: 340 },
    leftElbow:     { x: cx - 200,  y: 490 },
    rightElbow:    { x: cx + 200,  y: 490 },
    leftWrist:     { x: cx - 240,  y: 650 },
    rightWrist:    { x: cx + 240,  y: 650 },
    leftHip:       { x: cx - 85,   y: 640 },
    rightHip:      { x: cx + 85,   y: 640 },
    leftKnee:      { x: cx - 95,   y: 850 },
    rightKnee:     { x: cx + 95,   y: 850 },
    leftAnkle:     { x: cx - 100,  y: 1040 },
    rightAnkle:    { x: cx + 100,  y: 1040 },
  };
  return buildPersonPolys(kp);
}

// ====================== 幾何ユーティリティ ======================

function polygonArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

function centroid(poly) {
  let sx = 0, sy = 0;
  for (const p of poly) { sx += p.x; sy += p.y; }
  return { x: sx / poly.length, y: sy / poly.length };
}

// 符号付き面積が正(=この座標系での CCW)になるよう向きを揃える
function ensureCCW(poly) {
  return polygonArea(poly) < 0 ? poly.slice().reverse() : poly;
}

// 凸ポリゴン clip で凸ポリゴン subject を切り取る(Sutherland–Hodgman)。
//   両方 ensureCCW 済みであること。戻り値も凸ポリゴン(空の可能性あり)。
function clipConvex(subject, clipPoly) {
  let output = subject;
  const n = clipPoly.length;
  for (let i = 0; i < n; i++) {
    if (output.length === 0) break;
    const A = clipPoly[i], B = clipPoly[(i + 1) % n];
    const ex = B.x - A.x, ey = B.y - A.y;
    const inside = p => ex * (p.y - A.y) - ey * (p.x - A.x) >= 0;  // CCW: 内側=左
    const input = output;
    output = [];
    const m = input.length;
    for (let j = 0; j < m; j++) {
      const cur = input[j];
      const prev = input[(j + m - 1) % m];
      const curIn = inside(cur), prevIn = inside(prev);
      if (curIn) {
        if (!prevIn) output.push(lineIntersect(prev, cur, A, B));
        output.push(cur);
      } else if (prevIn) {
        output.push(lineIntersect(prev, cur, A, B));
      }
    }
  }
  return output;
}

// 線分 p1-p2 と 直線 A-B の交点
function lineIntersect(p1, p2, A, B) {
  const r = { x: p2.x - p1.x, y: p2.y - p1.y };
  const s = { x: B.x - A.x, y: B.y - A.y };
  const denom = r.x * s.y - r.y * s.x || 1e-9;
  const t = ((A.x - p1.x) * s.y - (A.y - p1.y) * s.x) / denom;
  return { x: p1.x + t * r.x, y: p1.y + t * r.y };
}

function fillPolys(ctx, polys, color) {
  ctx.fillStyle = color;
  for (const poly of polys) {
    if (poly.length < 3) continue;
    ctx.beginPath();
    ctx.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
    ctx.closePath();
    ctx.fill();
  }
}
