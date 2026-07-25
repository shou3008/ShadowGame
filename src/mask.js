import {
  ALPHA_RISE, ALPHA_FALL, MASK_OPEN_RADIUS,
  SUBJECT_ONLY, INTRUDER_MIN_AREA,
} from './settings.js';

// BodyPix が返す人物マスクを時間平滑化し、2つの形で持ち回るためのクラス。
//   smooth … 0..1 の連続値 (Float32Array)。ゲームの当たり判定に使う。
//   alpha  … 0..255 の単一チャンネル (Uint8Array)。Renderer が R8 テクスチャとして
//            そのままアップロードする(2D canvas 経由のコピーはしない)。
// 二値化せず連続値のまま扱うのが要点で、これによりシルエットの輪郭がちらつかない。
//
// version は update() のたびに進む。描画側はこれを見て「マスクが変わったときだけ」
// 再描画する(マスクは推論レートでしか変わらないのに 60fps で描き直すのは無駄)。
//
// EMA の前の空間処理は次の 3 段(いずれも render と当たり判定の両方に効く):
//   1. オープニング(収縮→膨張): 近接したシルエット同士を繋ぐ細い「橋」
//      (幅 2*MASK_OPEN_RADIUS px 以下)を切断し、孤立ノイズを消す。
//   2. 被験者選択: 前フレームの被験者マスクと最も重なる連結成分を被験者として追跡し、
//      それ以外の大きな成分(映り込んだ別人)を除去する。
//   3. 測地的再構成: オープニングで千切れた手首・前腕(元マスクでは体と繋がっている細部)を
//      元マスク側の連結を辿って復元する。別人の本体は通過禁止なので戻らない。

// 1軸方向の min(収縮) / max(膨張) フィルタ。構造要素が正方形なので縦横に分離できる。
// 窓は画像内にクランプする = 画面端に接した体が端で削られることはない。
function morphPassH(src, dst, w, h, r, keepMin) {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const x0 = x - r > 0 ? x - r : 0;
      const x1 = x + r < w - 1 ? x + r : w - 1;
      let v = src[row + x0];
      for (let xx = x0 + 1; xx <= x1; xx++) {
        const s = src[row + xx];
        if (keepMin ? s < v : s > v) v = s;
      }
      dst[row + x] = v;
    }
  }
}

function morphPassV(src, dst, w, h, r, keepMin) {
  for (let y = 0; y < h; y++) {
    const y0 = y - r > 0 ? y - r : 0;
    const y1 = y + r < h - 1 ? y + r : h - 1;
    for (let x = 0; x < w; x++) {
      let v = src[y0 * w + x];
      for (let yy = y0 + 1; yy <= y1; yy++) {
        const s = src[yy * w + x];
        if (keepMin ? s < v : s > v) v = s;
      }
      dst[y * w + x] = v;
    }
  }
}

export class SilhouetteMask {
  #smooth = null;  // Float32Array (0..1)
  #alpha  = null;  // Uint8Array (0..255)。Renderer へ渡す
  #bin    = null;  // Uint8Array (オープニング後の二値マスク)
  #tmp    = null;  // Uint8Array (分離フィルタの中間バッファ / 再構成の出力)
  #raw    = null;  // Uint8Array (オープニング前の二値マスク。腕の復元に使う)
  #label  = null;  // Int32Array (連結成分ラベル。0 = 背景)
  #queue  = null;  // Int32Array (BFS 用。各画素は高々1回しか積まれないので長さ n で足りる)
  #prevSel = null; // Uint8Array (前フレームで被験者として採用したマスク。成分の追跡に使う)
  #w = 0;
  #h = 0;
  #version = 0;

  get smooth()  { return this.#smooth; }
  get alpha()   { return this.#alpha; }
  get width()   { return this.#w; }
  get height()  { return this.#h; }
  get version() { return this.#version; }

  // カメラを切り替えると解像度が変わるので、平滑化の履歴ごと捨てる。
  // ゼロ埋めで確保し直す = 最初の推論が来る前でも「全面背景」を描画できる。
  reset(width, height) {
    this.#w = width;
    this.#h = height;
    this.#alloc(width * height);
    this.#version++;
  }

  #alloc(n) {
    this.#smooth  = new Float32Array(n);
    this.#alpha   = new Uint8Array(n);
    this.#bin     = new Uint8Array(n);
    this.#tmp     = new Uint8Array(n);
    this.#raw     = new Uint8Array(n);
    this.#label   = new Int32Array(n);
    this.#queue   = new Int32Array(n);
    this.#prevSel = new Uint8Array(n);
  }

  // seg: BodyPix の SemanticPersonSegmentation ({ data, width, height })
  //      data[i] は その画素が人なら 1、そうでなければ 0
  update(seg) {
    const { width: w, height: h, data } = seg;
    const n = w * h;

    if (!this.#smooth || this.#smooth.length !== n) {
      this.#alloc(n);
      this.#w = w;
      this.#h = h;
    }
    const smooth = this.#smooth;
    const alpha  = this.#alpha;
    const bin    = this.#bin;

    for (let i = 0; i < n; i++) bin[i] = data[i] ? 1 : 0;
    this.#raw.set(bin);

    const r = MASK_OPEN_RADIUS;
    if (r > 0) {
      const tmp = this.#tmp;
      morphPassH(bin, tmp, w, h, r, true);   // 収縮
      morphPassV(tmp, bin, w, h, r, true);
      morphPassH(bin, tmp, w, h, r, false);  // 膨張
      morphPassV(tmp, bin, w, h, r, false);
    }

    if (SUBJECT_ONLY) this.#selectSubject();

    for (let i = 0; i < n; i++) {
      const curr  = bin[i];
      // 対称 EMA。非対称にすると「進む影」と「退く影」で dO/dt に方向バイアスが乗り、
      // 跳ね返りが左右非対称になる(実験装置としては許容できない)。
      const alphaK = curr > smooth[i] ? ALPHA_RISE : ALPHA_FALL;
      smooth[i] += alphaK * (curr - smooth[i]);
      alpha[i] = smooth[i] * 255;
    }

    this.#version++;
  }

  // 被験者の連結成分だけを残し、オープニングで千切れた腕を復元する。
  // 入力: #bin(オープニング後) と #raw(オープニング前)。出力は #bin を書き換える。
  //
  //   1. #bin を連結成分ラベリング(4近傍 BFS)。
  //   2. 前フレームの被験者マスク(#prevSel)との重なりが最大の成分を被験者とする。
  //      面積最大でなく重なり最大にするのは、別人がカメラに近づいて被験者より
  //      大きく映っても選択が乗り移らないようにするため。重なりが全成分で 0 のとき
  //      (初回・全員退出後)だけ面積最大に落とす。
  //   3. 被験者以外で面積 ≥ INTRUDER_MIN_AREA の成分を「別人」として除去。
  //      小さな成分はノイズか被験者の千切れた部位の可能性があるので残す。
  //   4. 測地的再構成: 残した成分を種として #raw の連結を辿り、オープニングが
  //      削った画素(手首・前腕など体と繋がっている細部)を復元する。別人の本体は
  //      通過禁止なので、raw 上でメタボール橋が繋がっていても別人側は戻らない。
  #selectSubject() {
    const w = this.#w, h = this.#h, n = w * h;
    const bin   = this.#bin;
    const raw   = this.#raw;
    const label = this.#label;
    const queue = this.#queue;
    const prev  = this.#prevSel;
    const out   = this.#tmp;   // モルフォロジーが終わった後なので流用してよい

    // --- 1. 連結成分ラベリング ---
    label.fill(0);
    const areas    = [0];   // 添字 = ラベル(1..)
    const overlaps = [0];
    let comps = 0;
    for (let i = 0; i < n; i++) {
      if (!bin[i] || label[i] !== 0) continue;
      const c = ++comps;
      let area = 0, overlap = 0;
      let qh = 0, qt = 0;
      label[i] = c;
      queue[qt++] = i;
      while (qh < qt) {
        const p = queue[qh++];
        area++;
        if (prev[p]) overlap++;
        const x = p % w;
        if (x > 0     && bin[p - 1] && !label[p - 1]) { label[p - 1] = c; queue[qt++] = p - 1; }
        if (x < w - 1 && bin[p + 1] && !label[p + 1]) { label[p + 1] = c; queue[qt++] = p + 1; }
        if (p >= w    && bin[p - w] && !label[p - w]) { label[p - w] = c; queue[qt++] = p - w; }
        if (p < n - w && bin[p + w] && !label[p + w]) { label[p + w] = c; queue[qt++] = p + w; }
      }
      areas.push(area);
      overlaps.push(overlap);
    }
    if (comps === 0) { prev.fill(0); return; }

    // --- 2. 被験者成分の選択 (重なり最大。同点なら面積最大 = 初回のフォールバック) ---
    let subj = 1;
    for (let c = 2; c <= comps; c++) {
      if (overlaps[c] > overlaps[subj] ||
          (overlaps[c] === overlaps[subj] && areas[c] > areas[subj])) subj = c;
    }

    // --- 3. 別人の判定 ---
    const minArea = n * INTRUDER_MIN_AREA;
    const blocked = new Uint8Array(comps + 1);
    for (let c = 1; c <= comps; c++) {
      if (c !== subj && areas[c] >= minArea) blocked[c] = 1;
    }

    // --- 4. 測地的再構成 (残す成分を種に、raw の中を別人を避けて塗り広げる) ---
    out.fill(0);
    let qh = 0, qt = 0;
    for (let i = 0; i < n; i++) {
      const c = label[i];
      if (c !== 0 && !blocked[c]) { out[i] = 1; queue[qt++] = i; }
    }
    while (qh < qt) {
      const p = queue[qh++];
      const x = p % w;
      let q;
      // raw にあり・まだ拾っておらず・別人の本体でない画素へ広がる
      // (raw のみの画素は label が 0 なので blocked[0]=0 で常に通過できる)
      q = p - 1; if (x > 0     && raw[q] && !out[q] && !blocked[label[q]]) { out[q] = 1; queue[qt++] = q; }
      q = p + 1; if (x < w - 1 && raw[q] && !out[q] && !blocked[label[q]]) { out[q] = 1; queue[qt++] = q; }
      q = p - w; if (p >= w    && raw[q] && !out[q] && !blocked[label[q]]) { out[q] = 1; queue[qt++] = q; }
      q = p + w; if (p < n - w && raw[q] && !out[q] && !blocked[label[q]]) { out[q] = 1; queue[qt++] = q; }
    }

    bin.set(out);
    prev.set(out);
  }
}
