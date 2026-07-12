import { ALPHA_RISE, ALPHA_FALL } from './settings.js';

// BodyPix が返す人物マスクを時間平滑化し、2つの形で持ち回るためのクラス。
//   smooth … 0..1 の連続値 (Float32Array)。ゲームの当たり判定に使う。
//   canvas … RGBA の A チャンネルに所属度を詰めたもの (R/G/B は未使用)。Renderer に渡す。
// 二値化せず連続値のまま扱うのが要点で、これによりシルエットの輪郭がちらつかない。
export class SilhouetteMask {
  #canvas = document.createElement('canvas');
  #ctx;
  #smooth = null; // Float32Array (0..1)
  #rgba   = null; // Uint8ClampedArray (書き出しバッファ)

  constructor() {
    this.#ctx = this.#canvas.getContext('2d', { willReadFrequently: false });
  }

  get canvas() { return this.#canvas; }
  get smooth() { return this.#smooth; }

  // カメラを切り替えると解像度が変わるので、平滑化の履歴ごと捨てる
  reset(width, height) {
    this.#canvas.width  = width;
    this.#canvas.height = height;
    this.#smooth = null;
    this.#rgba   = null;
  }

  // seg: BodyPix の SemanticPersonSegmentation ({ data, width, height })
  //      data[i] は その画素が人なら 1、そうでなければ 0
  update(seg) {
    const { width: w, height: h, data } = seg;
    const n = w * h;

    if (!this.#smooth || this.#smooth.length !== n) {
      this.#smooth = new Float32Array(n);
      this.#rgba   = new Uint8ClampedArray(n * 4);
    }
    const smooth = this.#smooth;
    const rgba   = this.#rgba;

    for (let i = 0; i < n; i++) {
      const curr  = data[i] ? 1 : 0;
      const alpha = curr > smooth[i] ? ALPHA_RISE : ALPHA_FALL; // 出現は速く、消失も速く
      smooth[i] += alpha * (curr - smooth[i]);
      rgba[i * 4 + 3] = smooth[i] * 255;
    }

    if (this.#canvas.width !== w || this.#canvas.height !== h) {
      this.#canvas.width  = w;
      this.#canvas.height = h;
    }
    this.#ctx.putImageData(new ImageData(rgba, w, h), 0, 0);
  }
}
