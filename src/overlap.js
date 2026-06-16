// 影の重なりコア用フィールド計算 (並行モード・骨格カプセル / 真の交差版)
//
//   なぜカプセルか:
//     「2人の影が重なった部分だけ solid」を出したいが、ピクセルのセグメンテーションは
//     各画素を1人にしか割り当てない(disjoint)ため、2人が"同じ画素に重なる"状態は
//     原理的に作れない。そこで allPoses(骨格) から各人の体を太い線分(カプセル)の形で
//     合成する。形どうしは 2D で本当に重ねられるので、「重なった(交差した)セル」を
//     そのまま solid にできる。膨張で隙間を埋めるのではなく、真の交差を取る。
//
//   軽さ:
//     セグメンテーションのピクセル走査は使わず、粗グリッド(80×45)上でカプセルを
//     ラスタライズするだけ。実体数ぶんの小さなループで済むので 60fps を保ちやすい。
//
//   通常: 各 pose を1人=1実体として全身カプセルを描き、2人分が重なるセルを solid。
//   soloArms(デバッグ): 一人の左腕・右腕を2実体として、腕を重ねるとそこが solid。
//   `overlapField.soloArms = true/false` で即切替。

const DEFAULTS = {
  gw: 80, gh: 45,        // 粗グリッド (16:9, 軽量)
  countThresh: 2,        // solid に必要な重なり実体数 (本番=2 / 単独全身デバッグ時=1)
  pad: 0,                // 交差の許容(セル)。0=真の交差のみ。増やすと当たりが甘くなる
  riseAlpha: 0.6,        // solid 0→1 (出現)
  fallAlpha: 0.5,        // solid 1→0 (消失)
  poseScore: 0.2,        // 採用する pose の最低スコア
  kpScore: 0.3,          // 使うキーポイントの最低スコア
  maxPersons: 6,
  // カプセルの太さ(セル)。体格・画角に合わせて調整。
  armR:   1.8,
  legR:   1.8,
  torsoR: 3.4,
  soloArms: false,       // ★ デバッグ: 一人の腕2本で solid を作る
};

export class OverlapField {
  #o;
  #cbin = null;   // Uint8Array(G) 実体ごとの形
  #dil = null;    // Uint8Array(G) pad 適用後
  #tmp = null;    // Uint8Array(G) 分離型 max の中間
  #count = null;  // Uint8Array(G) 重なり実体数
  #solid = null;  // Float32Array(G) EMA後 solid (0..1)

  constructor(opts = {}) { this.#o = { ...DEFAULTS, ...opts }; }

  set countThresh(v) { this.#o.countThresh = v; }
  get countThresh()  { return this.#o.countThresh; }
  set pad(v)         { this.#o.pad = v; }
  get pad()          { return this.#o.pad; }
  set soloArms(v)    { this.#o.soloArms = !!v; }   // ★ 即オン/オフできるトグル
  get soloArms()     { return this.#o.soloArms; }
  // DevTools からまとめて調整用: configure({ armR:2.5, torsoR:4, pad:1, ... })
  configure(opts = {}) { Object.assign(this.#o, opts); }

  #ensure() {
    if (this.#solid) return;
    const G = this.#o.gw * this.#o.gh;
    this.#cbin  = new Uint8Array(G);
    this.#dil   = new Uint8Array(G);
    this.#tmp   = new Uint8Array(G);
    this.#count = new Uint8Array(G);
    this.#solid = new Float32Array(G);
  }

  // mask  : (未使用) シルエット表示は app 側で行う。物理はポーズのみで計算する。
  // poses : segmentPerson の allPoses (Pose[]: { score, keypoints:[{score, part, position:{x,y}}] })
  // mirror: 表示・当たり判定に合わせて solid グリッドを左右反転して作る
  // 戻り値: { solid:Float32Array(G), gw, gh }
  process(mask, poses, w, h, mirror) {
    this.#ensure();
    const { gw, gh, countThresh, riseAlpha, fallAlpha } = this.#o;
    const G = gw * gh;
    this.#count.fill(0);

    const toG = pt => ({ x: (mirror ? (w - 1 - pt.x) : pt.x) * gw / w, y: pt.y * gh / h });

    if (this.#o.soloArms) this.#fillSoloArms(poses, toG);
    else                  this.#fillPeople(poses, toG);

    // count>=threshold を raw solid とし、非対称EMAで平滑化
    const solid = this.#solid, count = this.#count;
    for (let g = 0; g < G; g++) {
      const raw = count[g] >= countThresh ? 1 : 0;
      const a = raw > solid[g] ? riseAlpha : fallAlpha;
      solid[g] += a * (raw - solid[g]);
    }
    return { solid, gw, gh };
  }

  // --- 通常: 各 pose を1人=1実体として全身カプセルを描き、重なりを count に積む ---
  #fillPeople(poses, toG) {
    const { poseScore, kpScore, maxPersons } = this.#o;
    let used = 0;
    for (const p of poses || []) {
      if (used >= maxPersons) break;
      if (!p) continue;
      if (p.score != null && p.score < poseScore) continue;
      const kp = {};
      for (const k of (p.keypoints || [])) if (k.score >= kpScore) kp[k.part] = k.position;
      const cbin = this.#cbin; cbin.fill(0);
      if (this.#rasterBody(cbin, kp, toG)) { this.#accumulate(cbin); used++; }
    }
  }

  // --- デバッグ: 一人の左腕・右腕を 2実体として、腕の重なりを count に積む ---
  #fillSoloArms(poses, toG) {
    const { poseScore, kpScore, armR } = this.#o;
    let pose = null;
    for (const p of poses || []) {
      if (!p) continue;
      if (p.score != null && p.score < poseScore) continue;
      pose = p; break;
    }
    if (!pose) return;
    const kp = {};
    for (const k of (pose.keypoints || [])) if (k.score >= kpScore) kp[k.part] = k.position;

    const drawArm = (sh, el, wr) => {
      const cbin = this.#cbin; cbin.fill(0);
      let any = false;
      if (kp[sh] && kp[el]) { this.#rasterCapsule(cbin, toG(kp[sh]), toG(kp[el]), armR); any = true; }
      if (kp[el] && kp[wr]) { this.#rasterCapsule(cbin, toG(kp[el]), toG(kp[wr]), armR); any = true; }
      if (any) this.#accumulate(cbin);
    };
    drawArm('leftShoulder',  'leftElbow',  'leftWrist');
    drawArm('rightShoulder', 'rightElbow', 'rightWrist');
  }

  // 全身(腕・脚・胴体)をカプセルで cbin に描く。何か描けたら true。
  #rasterBody(cbin, kp, toG) {
    const { armR, legR, torsoR } = this.#o;
    let any = false;
    const seg = (a, b, r) => {
      if (kp[a] && kp[b]) { this.#rasterCapsule(cbin, toG(kp[a]), toG(kp[b]), r); any = true; }
    };
    // 腕
    seg('leftShoulder',  'leftElbow',  armR); seg('leftElbow',  'leftWrist',  armR);
    seg('rightShoulder', 'rightElbow', armR); seg('rightElbow', 'rightWrist', armR);
    // 脚
    seg('leftHip',  'leftKnee',  legR); seg('leftKnee',  'leftAnkle',  legR);
    seg('rightHip', 'rightKnee', legR); seg('rightKnee', 'rightAnkle', legR);
    // 胴体 (肩中心→腰中心 と 肩幅・腰幅)
    const mid = (a, b) => (kp[a] && kp[b])
      ? { x: (kp[a].x + kp[b].x) / 2, y: (kp[a].y + kp[b].y) / 2 } : null;
    const ms = mid('leftShoulder', 'rightShoulder');
    const mh = mid('leftHip', 'rightHip');
    if (ms && mh) { this.#rasterCapsule(cbin, toG(ms), toG(mh), torsoR); any = true; }
    seg('leftShoulder', 'rightShoulder', torsoR);
    seg('leftHip', 'rightHip', torsoR);
    return any;
  }

  // cbin(0/1) を pad だけ膨らませて count に 1 加算する (実体1つぶん)
  #accumulate(cbin) {
    const { gw, gh, pad } = this.#o;
    const G = gw * gh;
    let src = cbin;
    if (pad > 0) { this.#dilate(cbin, this.#dil, gw, gh, pad); src = this.#dil; }
    const count = this.#count;
    for (let g = 0; g < G; g++) if (src[g]) count[g]++;
  }

  // グリッド上の線分 p0-p1 を半径r のカプセルとして cbin に塗る (バウンディングボックス内のみ走査)
  #rasterCapsule(cbin, p0, p1, r) {
    const { gw, gh } = this.#o;
    const minx = Math.max(0,      Math.floor(Math.min(p0.x, p1.x) - r));
    const maxx = Math.min(gw - 1, Math.ceil (Math.max(p0.x, p1.x) + r));
    const miny = Math.max(0,      Math.floor(Math.min(p0.y, p1.y) - r));
    const maxy = Math.min(gh - 1, Math.ceil (Math.max(p0.y, p1.y) + r));
    const vx = p1.x - p0.x, vy = p1.y - p0.y;
    const len2 = vx * vx + vy * vy || 1e-6;
    const r2 = r * r;
    for (let y = miny; y <= maxy; y++) {
      for (let x = minx; x <= maxx; x++) {
        const px = x + 0.5 - p0.x, py = y + 0.5 - p0.y;
        let t = (px * vx + py * vy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = px - vx * t, dy = py - vy * t;
        if (dx * dx + dy * dy <= r2) cbin[y * gw + x] = 1;
      }
    }
  }

  // 分離型 max フィルタ (半径r): src(0/1) → dst(0/1)。pad>0 のときだけ使う。
  #dilate(src, dst, gw, gh, r) {
    const tmp = this.#tmp;
    for (let y = 0; y < gh; y++) {
      const row = y * gw;
      for (let x = 0; x < gw; x++) {
        const x0 = x - r < 0 ? 0 : x - r;
        const x1 = x + r >= gw ? gw - 1 : x + r;
        let v = 0;
        for (let xx = x0; xx <= x1; xx++) { if (src[row + xx]) { v = 1; break; } }
        tmp[row + x] = v;
      }
    }
    for (let x = 0; x < gw; x++) {
      for (let y = 0; y < gh; y++) {
        const y0 = y - r < 0 ? 0 : y - r;
        const y1 = y + r >= gh ? gh - 1 : y + r;
        let v = 0;
        for (let yy = y0; yy <= y1; yy++) { if (tmp[yy * gw + x]) { v = 1; break; } }
        dst[y * gw + x] = v;
      }
    }
  }
}
