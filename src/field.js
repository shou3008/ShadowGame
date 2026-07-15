import { WORLD_W, WORLD_H, FIELD, PHYSICS } from './settings.js';

// 占有率フィールド O(x, y, t)
//
// 「ボールの円板が影にどれだけ埋まっているか」を表す粗い連続場(64x36)。
// 生マスクに直接当てるのではなく、この場に対して当てることで 3 つが同時に手に入る:
//
//   1. なめらかな法線     n = -∇O/‖∇O‖
//      → 「体をどの角度で差し出すかで跳ね返る向きが決まる」の実体。
//        生マスクの勾配は画素ノイズで暴れるが、こちらは安定する。
//
//   2. 本物の侵入深さ     φ = (O - θ)/‖∇O‖   [px]
//      → 深さ比例の位置補正が書ける。旧実装の「固定 27px 押し出し」は制御されていない
//        エネルギー源で、影の反発の見かけが重力の関数になっていた(交絡)。
//
//   3. 時間外挿           O_pred = O + (∂O/∂t)·τ
//      → 推論が 10fps しか出なくても、衝突体を 60fps 相当で滑らかに動かせる。
//        これが無いと影は 100ms ごとにカクッと飛び、高重力条件だけが
//        「重力のせい」でなく「遅延のせい」で難しくなる。
//
// ぼかし核の支持を ±2セル = ±60 world px = ちょうどボール半径にしてあるので、
// O は「影をボール半径ぶん膨張させた場」に近くなる。結果としてボールの
// 見えている縁が影の縁に触れ、見た目と当たり判定が一致する。
export class OccupancyField {
  #gw = FIELD.gridW;
  #gh = FIELD.gridH;
  #cellW = WORLD_W / FIELD.gridW;   // 30 world px
  #cellH = WORLD_H / FIELD.gridH;   // 30 world px

  #curr; #prev; #rate; #acc; #tmp; #cnt;
  #lutX = null; #lutY = null;

  #tCurr = -1;      // curr を作った時刻 [s]
  #tPrev = -1;
  #mw = 0; #mh = 0; #mirror = null;
  #coverage = 0;
  #centroidX = NaN; // 占有率の重心 (world px)。体の位置の指標
  #centroidY = NaN;
  #motion = 0;      // 平均 |∂O/∂t| [1/s]。体の動きの激しさの指標

  constructor() {
    const n = this.#gw * this.#gh;
    this.#curr = new Float32Array(n);
    this.#prev = new Float32Array(n);
    this.#rate = new Float32Array(n);
    this.#acc  = new Float32Array(n);
    this.#tmp  = new Float32Array(n);
    this.#cnt  = new Float32Array(n);
  }

  get gridW()    { return this.#gw; }
  get gridH()    { return this.#gh; }
  get grid()     { return this.#curr; }   // debug.js 用
  get rateGrid() { return this.#rate; }
  get coverage() { return this.#coverage; }  // O>0.5 のセル比。フレーミングのサニティチェック
  get ready()    { return this.#tCurr >= 0; }

  // ログ用の行動指標。重心の移動距離は「移動量」、motion は手足を含む「動きの激しさ」。
  // (重心は腕を左右対称に振っても動かないので、両方を取る)
  get centroidX() { return this.#centroidX; }   // world px。人がいなければ NaN
  get centroidY() { return this.#centroidY; }
  get motion()    { return this.#motion; }      // グリッド平均 |∂O/∂t| [1/s]

  reset() {
    this.#curr.fill(0); this.#prev.fill(0); this.#rate.fill(0);
    this.#tCurr = -1; this.#tPrev = -1;
    this.#coverage = 0;
    this.#centroidX = NaN; this.#centroidY = NaN;
    this.#motion = 0;
  }

  // マスク座標 → グリッド座標の対応表。mirror はここで焼き込むので、
  // 以降のサンプラは mirror を一切知らなくてよい(座標系はつねに world 向き)。
  #buildLuts(mw, mh, mirror) {
    this.#lutX = new Int32Array(mw);
    this.#lutY = new Int32Array(mh);
    for (let x = 0; x < mw; x++) {
      let gx = Math.min(this.#gw - 1, (x * this.#gw / mw) | 0);
      if (mirror) gx = this.#gw - 1 - gx;
      this.#lutX[x] = gx;
    }
    for (let y = 0; y < mh; y++) {
      this.#lutY[y] = Math.min(this.#gh - 1, (y * this.#gh / mh) | 0);
    }
    // セルごとのマスク画素数(整数分割でないときも正しく平均するため)
    this.#cnt.fill(0);
    for (let y = 0; y < mh; y++) {
      const row = this.#lutY[y] * this.#gw;
      for (let x = 0; x < mw; x++) this.#cnt[row + this.#lutX[x]]++;
    }
    this.#mw = mw; this.#mh = mh; this.#mirror = mirror;
  }

  // smooth: SilhouetteMask.smooth (Float32Array 0..1, mw*mh, 行優先)
  // tSec  : この推論結果の時刻 [s]
  build(smooth, mw, mh, mirror, tSec) {
    if (mw !== this.#mw || mh !== this.#mh || mirror !== this.#mirror) {
      this.#buildLuts(mw, mh, mirror);
      // 座標系が変わったので前フレームとの差分(= dO/dt)は意味を持たない
      this.#tPrev = -1;
      this.#tCurr = -1;
      this.#rate.fill(0);
    }

    // prev <- curr (バッファを入れ替えるだけ。コピーしない)
    const old = this.#prev;
    this.#prev  = this.#curr;
    this.#curr  = old;
    this.#tPrev = this.#tCurr;
    this.#tCurr = tSec;

    // セル平均に集約
    const acc = this.#acc, cnt = this.#cnt, lx = this.#lutX, ly = this.#lutY;
    acc.fill(0);
    for (let y = 0; y < mh; y++) {
      const grow = ly[y] * this.#gw;
      const mrow = y * mw;
      for (let x = 0; x < mw; x++) acc[grow + lx[x]] += smooth[mrow + x];
    }
    const n = this.#gw * this.#gh;
    const curr = this.#curr;
    for (let i = 0; i < n; i++) curr[i] = cnt[i] > 0 ? acc[i] / cnt[i] : 0;

    this.#blur(curr);
    this.#finish(n);
  }

  // 合成グリッドを直接流し込む(selftest 用)。ぼかしは掛けない。
  injectGrid(values, tSec) {
    const old = this.#prev;
    this.#prev  = this.#curr;
    this.#curr  = old;
    this.#tPrev = this.#tCurr;
    this.#tCurr = tSec;
    this.#curr.set(values);
    this.#finish(this.#gw * this.#gh);
  }

  // dO/dt・coverage・重心・motion を確定させる
  #finish(n) {
    const curr = this.#curr, prev = this.#prev, rate = this.#rate;
    const dt = this.#tCurr - this.#tPrev;
    // dt が異常(初回・長すぎる中断)なら外挿を止める。暴走防止。
    if (this.#tPrev >= 0 && dt > 1e-4 && dt < 0.5) {
      for (let i = 0; i < n; i++) rate[i] = (curr[i] - prev[i]) / dt;
    } else {
      rate.fill(0);
    }

    const gw = this.#gw, gh = this.#gh;
    let solid = 0, wsum = 0, sx = 0, sy = 0, mabs = 0;
    for (let y = 0; y < gh; y++) {
      const row = y * gw;
      const cy = (y + 0.5) * this.#cellH;
      for (let x = 0; x < gw; x++) {
        const o = curr[row + x];
        if (o > 0.5) solid++;
        wsum += o;
        sx += o * (x + 0.5) * this.#cellW;
        sy += o * cy;
        mabs += Math.abs(rate[row + x]);
      }
    }
    this.#coverage = solid / n;
    this.#motion   = mabs / n;
    if (wsum > 1e-6) {
      this.#centroidX = sx / wsum;
      this.#centroidY = sy / wsum;
    } else {
      this.#centroidX = NaN;
      this.#centroidY = NaN;
    }
  }

  // 3-tap ボックスの分離ぼかしを blurPasses 回。支持 ±2セル = ±60px = ボール半径。
  #blur(a) {
    const gw = this.#gw, gh = this.#gh, t = this.#tmp;
    for (let p = 0; p < FIELD.blurPasses; p++) {
      for (let y = 0; y < gh; y++) {           // 横
        const r = y * gw;
        for (let x = 0; x < gw; x++) {
          const l = a[r + (x > 0 ? x - 1 : 0)];
          const c = a[r + x];
          const g = a[r + (x < gw - 1 ? x + 1 : gw - 1)];
          t[r + x] = (l + c + g) / 3;
        }
      }
      for (let y = 0; y < gh; y++) {           // 縦
        const yu = (y > 0 ? y - 1 : 0) * gw;
        const yc = y * gw;
        const yd = (y < gh - 1 ? y + 1 : gh - 1) * gw;
        for (let x = 0; x < gw; x++) a[yc + x] = (t[yu + x] + t[yc + x] + t[yd + x]) / 3;
      }
    }
  }

  #bilerp(arr, wx, wy) {
    const gw = this.#gw, gh = this.#gh;
    let fx = wx / this.#cellW - 0.5;
    let fy = wy / this.#cellH - 0.5;
    if (fx < 0) fx = 0; else if (fx > gw - 1) fx = gw - 1;
    if (fy < 0) fy = 0; else if (fy > gh - 1) fy = gh - 1;
    const x0 = fx | 0, y0 = fy | 0;
    const x1 = x0 + 1 < gw ? x0 + 1 : x0;
    const y1 = y0 + 1 < gh ? y0 + 1 : y0;
    const tx = fx - x0, ty = fy - y0;
    const a = arr[y0 * gw + x0], b = arr[y0 * gw + x1];
    const c = arr[y1 * gw + x0], d = arr[y1 * gw + x1];
    const top = a + (b - a) * tx;
    const bot = c + (d - c) * tx;
    return top + (bot - top) * ty;
  }

  // 外挿量 τ [s]。マスクが古くなるほど先読みし、上限で頭打ちにする。
  tau(tNow) {
    if (!PHYSICS.extrapolate || this.#tCurr < 0) return 0;
    let t = (tNow - this.#tCurr) + PHYSICS.latencyCompMs / 1000;
    if (t < 0) t = 0;
    if (t > PHYSICS.extrapMaxSec) t = PHYSICS.extrapMaxSec;
    return t;
  }

  // 時刻 tNow における占有率(外挿込み)。物理のサブステップごとに呼ばれる。
  sample(wx, wy, tNow) {
    let o = this.#bilerp(this.#curr, wx, wy);
    if (PHYSICS.extrapolate) o += this.#bilerp(this.#rate, wx, wy) * this.tau(tNow);
    return o < 0 ? 0 : o > 1 ? 1 : o;
  }

  rateAt(wx, wy) { return this.#bilerp(this.#rate, wx, wy); }

  // マスクの齢 [ms]。打撃ごとに記録し、遅延が独立変数と交絡していないか事後検証する。
  age(tNow) { return this.#tCurr < 0 ? Infinity : (tNow - this.#tCurr) * 1000; }
}
