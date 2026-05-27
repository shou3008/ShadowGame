// BodyPix の segmentMultiPersonParts を使う直接セグメンテーション方式
//   - 複数人検出をモデルがネイティブに行うので、シルエットも人数を問わず正しく出る
//   - 各画素に部位 ID が割り当てられるため、キーポイント→幾何学計算の中間処理が不要
//   - 結果(セグメント)をそのまま色に変換するだけ
const bodyPix = window['body-pix'];

import { Camera }   from './camera.js';
import { Renderer } from './renderer.js';

const video    = document.getElementById('video');
const canvas   = document.getElementById('canvas');
const statusEl = document.getElementById('status');
const fpsEl    = document.getElementById('fps');

// BodyPix の部位 ID 区分（COCO 24 部位）
//   HEAD: face 左右 (= 0,1) — BodyPix に「頭部」カテゴリは無く face で代替
//   HAND: hand 左右 (= 10,11)
//   LEG : upper_leg + lower_leg + feet (= 14..21) すべて
const HEAD_PARTS = new Set([0, 1]);
const HAND_PARTS = new Set([10, 11]);
const LEG_PARTS  = new Set([14, 15, 16, 17, 18, 19, 20, 21]);

// 部位 → カテゴリ ID (大きい数値が「優先」)
//   0=背景, 4=他の体, 3=脚, 2=手, 1=頭
// 複数人で同一画素を別カテゴリで claim した場合は max を取る (= 高優先が勝つ)
// ただし shader 側の塗り優先は別途 (hand > head > leg > body) なので、ここでは
// シンプルに「どのカテゴリに該当するか」を 1 段で記録する
const CAT_BG=0, CAT_HEAD=1, CAT_HAND=2, CAT_LEG=3, CAT_BODY=4;

// 時間平滑化 + ヒステリシス（端の点滅対策）
const EMA_ALPHA = 0.5;
const HYST_HIGH = 0.7;
const HYST_LOW  = 0.3;

const INFERENCE_CONFIG = {
  flipHorizontal:        false,
  internalResolution:    'medium',
  segmentationThreshold: 0.7,
  // 多人数検出のためのポーズ検出パラメタ
  maxDetections:    5,
  scoreThreshold:   0.3,
  nmsRadius:        20,
};

// --- UI controls ---
const ctrlFg     = document.getElementById('ctrl-fg');
const ctrlBg     = document.getElementById('ctrl-bg');
const ctrlHand   = document.getElementById('ctrl-hand');
const ctrlHead   = document.getElementById('ctrl-head');
const ctrlLeg    = document.getElementById('ctrl-leg');
const ctrlScale  = document.getElementById('ctrl-scale');
const ctrlScaleVal = document.getElementById('ctrl-scale-val');
const ctrlFlip   = document.getElementById('ctrl-flip');
const ctrlCamera = document.getElementById('ctrl-camera');
const ctrlCell   = document.getElementById('ctrl-cell');
const ctrlCellVal = document.getElementById('ctrl-cell-val');

function hexToVec4(hex) {
  return new Float32Array([
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
    1.0,
  ]);
}

const config = {
  fgColor:    hexToVec4(ctrlFg.value),
  bgColor:    hexToVec4(ctrlBg.value),
  handColor:  hexToVec4(ctrlHand.value),
  headColor:  hexToVec4(ctrlHead.value),
  legColor:   hexToVec4(ctrlLeg.value),
  pixelScale: 1.0,
  mirror:     ctrlFlip.checked,
  cellSize:   parseInt(ctrlCell.value),
};

ctrlFg.addEventListener('input',   () => { config.fgColor   = hexToVec4(ctrlFg.value); });
ctrlBg.addEventListener('input',   () => { config.bgColor   = hexToVec4(ctrlBg.value); });
ctrlHand.addEventListener('input', () => { config.handColor = hexToVec4(ctrlHand.value); });
ctrlHead.addEventListener('input', () => { config.headColor = hexToVec4(ctrlHead.value); });
ctrlLeg.addEventListener('input',  () => { config.legColor  = hexToVec4(ctrlLeg.value); });
ctrlFlip.addEventListener('change', () => { config.mirror = ctrlFlip.checked; });
ctrlScale.addEventListener('input', () => {
  config.pixelScale = parseInt(ctrlScale.value) / 100;
});
ctrlCell.addEventListener('input', () => {
  config.cellSize = parseInt(ctrlCell.value);
  ctrlCellVal.textContent = ctrlCell.value + 'px';
});

// 部位 ID → カテゴリ
function partToCat(part) {
  if (part < 0)              return CAT_BG;
  if (HEAD_PARTS.has(part))  return CAT_HEAD;
  if (HAND_PARTS.has(part))  return CAT_HAND;
  if (LEG_PARTS .has(part))  return CAT_LEG;
  return CAT_BODY;
}

// 一画素分の EMA + ヒステリシス を smoothedArr/binaryArr に反映
function emaHyst(smoothedArr, binaryArr, i, currVal) {
  const s = EMA_ALPHA * currVal + (1 - EMA_ALPHA) * smoothedArr[i];
  smoothedArr[i] = s;
  if (binaryArr[i]) { if (s < HYST_LOW)  binaryArr[i] = 0; }
  else              { if (s > HYST_HIGH) binaryArr[i] = 1; }
}

// --- Main ---
async function main() {
  statusEl.textContent = 'カメラを起動中...';
  const camera = new Camera(video);
  await camera.start({ width: 640, height: 480 });

  const renderer = new Renderer(canvas);

  function fitCanvas() {
    const aspect = camera.width / camera.height;
    const dispW  = Math.min(window.innerWidth, Math.round(window.innerHeight * aspect));
    const dispH  = Math.round(dispW / aspect);
    canvas.style.width  = dispW + 'px';
    canvas.style.height = dispH + 'px';
    const rw = Math.max(1, Math.round(dispW * config.pixelScale));
    const rh = Math.max(1, Math.round(dispH * config.pixelScale));
    renderer.resize(rw, rh);
    ctrlScaleVal.textContent = `${rw}×${rh}px`;
  }
  fitCanvas();
  window.addEventListener('resize', fitCanvas);
  ctrlScale.addEventListener('input', fitCanvas);

  // --- マスク状態 ---
  // RGBA に 4 カテゴリ × 二値を詰める: R=head, G=hand, B=leg, A=body
  const maskCanvas = document.createElement('canvas');
  const maskCtx    = maskCanvas.getContext('2d', { willReadFrequently: false });
  let smHead = null, smHand = null, smLeg = null, smBody = null; // Float32 EMA
  let bnHead = null, bnHand = null, bnLeg = null, bnBody = null; // Uint8 binary
  let buf    = null;                                              // RGBA 書き出しバッファ
  let paused = false;

  function syncMaskSize() {
    maskCanvas.width  = camera.width;
    maskCanvas.height = camera.height;
    smHead = smHand = smLeg = smBody = null;
    bnHead = bnHand = bnLeg = bnBody = null;
    buf    = null;
  }
  syncMaskSize();

  // --- カメラ列挙・切替 ---
  async function populateCameras() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter(d => d.kind === 'videoinput');
    const current = camera.deviceId;
    ctrlCamera.innerHTML = '';
    cams.forEach((cam, i) => {
      const opt = document.createElement('option');
      opt.value = cam.deviceId;
      opt.textContent = cam.label || `カメラ ${i + 1}`;
      if (cam.deviceId === current) opt.selected = true;
      ctrlCamera.appendChild(opt);
    });
  }

  ctrlCamera.addEventListener('change', async () => {
    const id = ctrlCamera.value;
    paused = true;
    statusEl.textContent = 'カメラ切り替え中...';
    try {
      await camera.start({ width: 640, height: 480, deviceId: id });
      syncMaskSize();
      fitCanvas();
      statusEl.textContent = '実行中';
    } catch (err) {
      statusEl.textContent = 'カメラ切替エラー: ' + err.message;
      console.error(err);
    } finally {
      paused = false;
    }
    populateCameras();
  });

  await populateCameras();
  navigator.mediaDevices.addEventListener('devicechange', populateCameras);

  // --- BodyPix モデル ---
  statusEl.textContent = 'BodyPix を読み込み中...';
  const net = await bodyPix.load({
    architecture: 'MobileNetV1',
    outputStride: 16,
    multiplier:   0.75,
    quantBytes:   2,
  });

  statusEl.textContent = '実行中';

  let frameCount  = 0;
  let lastFpsTime = performance.now();
  let processing  = false;

  function loop() {
    if (camera.ready && !processing && !paused) {
      processing = true;

      // 多人数の部位セグメンテーション
      //   返り値: PersonSegmentation[] — 各人 1 つの { data: Int32Array, width, height, pose }
      //   data[i] は その人 が claim する画素の部位 ID。claim していない画素は -1
      net.segmentMultiPersonParts(camera.element, INFERENCE_CONFIG).then(segs => {
        if (segs && segs.length > 0) {
          const w = segs[0].width, h = segs[0].height;
          const N = w * h;

          if (!smHead || smHead.length !== N) {
            smHead = new Float32Array(N); smHand = new Float32Array(N);
            smLeg  = new Float32Array(N); smBody = new Float32Array(N);
            bnHead = new Uint8Array  (N); bnHand = new Uint8Array  (N);
            bnLeg  = new Uint8Array  (N); bnBody = new Uint8Array  (N);
            buf    = new Uint8ClampedArray(N * 4);
          }

          // 各画素ごとに全員分の部位 ID を走査して カテゴリ を決定
          // 同画素を複数人が claim することは原則無いが、念のため最大優先カテゴリを採用
          for (let i = 0; i < N; i++) {
            let cat = CAT_BG;
            for (let pi = 0; pi < segs.length; pi++) {
              const c = partToCat(segs[pi].data[i]);
              if (c !== CAT_BG && (cat === CAT_BG || c < cat)) cat = c;
              // 上の条件: BG 以外で、より高優先 (HEAD=1 / HAND=2 / LEG=3 / BODY=4 の中で
              //           小さい番号 = 体表面側に近い識別、HEAD > HAND > LEG > BODY と扱う)
              // ※ shader 側の塗り優先 (hand > head > leg > body) とは別。
              //    ここでは「何のセグメントだったか」だけ確定させる
            }
            // 各カテゴリ二値の今フレーム値
            const cHead = cat === CAT_HEAD ? 1 : 0;
            const cHand = cat === CAT_HAND ? 1 : 0;
            const cLeg  = cat === CAT_LEG  ? 1 : 0;
            const cBody = cat !== CAT_BG   ? 1 : 0;

            emaHyst(smHead, bnHead, i, cHead);
            emaHyst(smHand, bnHand, i, cHand);
            emaHyst(smLeg,  bnLeg,  i, cLeg );
            emaHyst(smBody, bnBody, i, cBody);
          }

          // RGBA バッファに 4 カテゴリ二値を詰める
          for (let i = 0; i < N; i++) {
            buf[i * 4 + 0] = bnHead[i] ? 255 : 0; // R = head
            buf[i * 4 + 1] = bnHand[i] ? 255 : 0; // G = hand
            buf[i * 4 + 2] = bnLeg [i] ? 255 : 0; // B = leg
            buf[i * 4 + 3] = bnBody[i] ? 255 : 0; // A = body
          }
          if (maskCanvas.width !== w || maskCanvas.height !== h) {
            maskCanvas.width = w; maskCanvas.height = h;
          }
          maskCtx.putImageData(new ImageData(buf, w, h), 0, 0);
        } else {
          // 検出 0 人: マスクをクリア
          if (buf) buf.fill(0);
          if (smBody) { smBody.fill(0); bnBody.fill(0); }
          if (smHead) { smHead.fill(0); bnHead.fill(0); }
          if (smHand) { smHand.fill(0); bnHand.fill(0); }
          if (smLeg ) { smLeg .fill(0); bnLeg .fill(0); }
          if (buf) {
            maskCtx.putImageData(new ImageData(buf, maskCanvas.width, maskCanvas.height), 0, 0);
          }
        }

        renderer.render(maskCanvas, {
          camW: camera.width, camH: camera.height,
          ...config,
        });

        processing = false;
      }).catch(err => {
        console.error('BodyPix error:', err);
        processing = false;
      });
    }

    frameCount++;
    const now = performance.now();
    if (now - lastFpsTime >= 1000) {
      fpsEl.textContent = frameCount + ' fps';
      frameCount  = 0;
      lastFpsTime = now;
    }
    requestAnimationFrame(loop);
  }

  requestAnimationFrame(loop);
}

main().catch(err => {
  statusEl.textContent = 'エラー: ' + err.message;
  console.error(err);
});
