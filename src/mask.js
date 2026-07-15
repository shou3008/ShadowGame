import { ALPHA_RISE, ALPHA_FALL, MASK_OPEN_RADIUS } from './settings.js';

// BodyPix が返す人物マスクを時間平滑化し、2つの形で持ち回るためのクラス。
//   smooth … 0..1 の連続値 (Float32Array)。ゲームの当たり判定に使う。
//   alpha  … 0..255 の単一チャンネル (Uint8Array)。Renderer が R8 テクスチャとして
//            そのままアップロードする(2D canvas 経由のコピーはしない)。
// 二値化せず連続値のまま扱うのが要点で、これによりシルエットの輪郭がちらつかない。
//
// version は update() のたびに進む。描画側はこれを見て「マスクが変わったときだけ」
// 再描画する(マスクは推論レートでしか変わらないのに 60fps で描き直すのは無駄)。
//
// EMA の前に二値マスクへモルフォロジー・オープニング(収縮→膨張)を掛ける。
// 近接したシルエット同士を繋ぐ細い「橋」(幅 2*MASK_OPEN_RADIUS px 以下)を切断するためで、
// 体本体は収縮後に膨張で復元されるため太さは変わらない。render と当たり判定の両方に効く。

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
  #tmp    = null;  // Uint8Array (分離フィルタの中間バッファ)
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
    const n = width * height;
    this.#smooth = new Float32Array(n);
    this.#alpha  = new Uint8Array(n);
    this.#bin    = new Uint8Array(n);
    this.#tmp    = new Uint8Array(n);
    this.#version++;
  }

  // seg: BodyPix の SemanticPersonSegmentation ({ data, width, height })
  //      data[i] は その画素が人なら 1、そうでなければ 0
  update(seg) {
    const { width: w, height: h, data } = seg;
    const n = w * h;

    if (!this.#smooth || this.#smooth.length !== n) {
      this.#smooth = new Float32Array(n);
      this.#alpha  = new Uint8Array(n);
      this.#bin    = new Uint8Array(n);
      this.#tmp    = new Uint8Array(n);
      this.#w = w;
      this.#h = h;
    }
    const smooth = this.#smooth;
    const alpha  = this.#alpha;
    const bin    = this.#bin;

    for (let i = 0; i < n; i++) bin[i] = data[i] ? 1 : 0;

    const r = MASK_OPEN_RADIUS;
    if (r > 0) {
      const tmp = this.#tmp;
      morphPassH(bin, tmp, w, h, r, true);   // 収縮
      morphPassV(tmp, bin, w, h, r, true);
      morphPassH(bin, tmp, w, h, r, false);  // 膨張
      morphPassV(tmp, bin, w, h, r, false);
    }

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
}
