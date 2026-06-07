// BodyPix の segmentPerson を使うシンプルなシルエット方式
//   - 検出した人の画素を 1、それ以外を 0 とする二値マスクを取得し、
//     そのまま影(前景色)として描画するだけ。
//   - 頭/手などの部位判定は行わない（必要になったら別途追加する）。
const bodyPix = window['body-pix'];

import { Camera }   from './camera.js';
import { Renderer } from './renderer.js';

const video    = document.getElementById('video');
const canvas   = document.getElementById('canvas');
const statusEl = document.getElementById('status');
const fpsEl    = document.getElementById('fps');

// 時間平滑化 (非対称 EMA)
//   各画素のカテゴリ所属度を 0..1 の連続値として平滑化し、二値化せずにそのまま
//   描画側へ渡す。こうすると「動いていない画素」は値がほぼ一定 → ちらつかず、
//   「動いた画素」だけが滑らかに値を変えて追従する。
//   立ち上がり(出現)は速く、立ち下がり(消失)は遅くする「粘る」挙動にすることで、
//   セグメンテーションが時々しか拾わない弱い画素(肩や輪郭の端)が
//   しきい値割れで消えてしまうのを防ぐ。
//     ALPHA_RISE … 0→1 方向の追従速度（速め＝すぐ埋まる）
//     ALPHA_FALL … 1→0 方向の追従速度（速め＝動いた跡をすぐ消す＝残像を出さない）
//   FALL は curr=0(=その画素に人がいない)になった画素にしか効かない。
//   毎フレーム検出され続ける肩などは curr=1 のままなので FALL を速くしても消えない。
//   よって残像を消すには FALL を大きく。肩が欠けるのは別問題(セグメンテーション品質)
//   なので INFERENCE_CONFIG 側で対処する。
const ALPHA_RISE = 0.5;
const ALPHA_FALL = 0.6;

const INFERENCE_CONFIG = {
  flipHorizontal:        false,
  // 肩や輪郭の端まで拾うには 'low'+0.7 は痩せすぎ。'medium'+0.5 で
  //   シルエットを太らせ、肩が欠けないようにする（多少 FPS は下がる）。
  internalResolution:    'medium',
  segmentationThreshold: 0.5,
};

// --- UI controls ---
const ctrlFg     = document.getElementById('ctrl-fg');
const ctrlBg     = document.getElementById('ctrl-bg');
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
  pixelScale: 1.0,
  mirror:     ctrlFlip.checked,
  cellSize:   parseInt(ctrlCell.value),
};

ctrlFg.addEventListener('input',   () => { config.fgColor   = hexToVec4(ctrlFg.value); });
ctrlBg.addEventListener('input',   () => { config.bgColor   = hexToVec4(ctrlBg.value); });
ctrlFlip.addEventListener('change', () => { config.mirror = ctrlFlip.checked; });
ctrlScale.addEventListener('input', () => {
  config.pixelScale = parseInt(ctrlScale.value) / 100;
});
ctrlCell.addEventListener('input', () => {
  config.cellSize = parseInt(ctrlCell.value);
  ctrlCellVal.textContent = ctrlCell.value + 'px';
});

// 一画素分の非対称 EMA（出現は速く、消失は速く＝残像を残さない）
function ema(arr, i, curr) {
  const a = curr > arr[i] ? ALPHA_RISE : ALPHA_FALL;
  arr[i] += a * (curr - arr[i]);
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
  // RGBA の A チャンネルに 体の所属度(連続 0..255) を詰める (R/G/B は未使用)
  const maskCanvas = document.createElement('canvas');
  const maskCtx    = maskCanvas.getContext('2d', { willReadFrequently: false });
  let smBody = null; // Float32 EMA (0..1)
  let buf    = null; // RGBA 書き出しバッファ
  let paused = false;

  function syncMaskSize() {
    maskCanvas.width  = camera.width;
    maskCanvas.height = camera.height;
    smBody = null;
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

      // 人物セグメンテーション (全員分を 1 枚の二値マスクに統合)
      //   返り値: SemanticPersonSegmentation — { data: Uint8Array, width, height, allPoses }
      //   data[i] は その画素が人なら 1、そうでなければ 0
      net.segmentPerson(camera.element, INFERENCE_CONFIG).then(seg => {
        if (seg && seg.data) {
          const w = seg.width, h = seg.height;
          const N = w * h;
          const data = seg.data;

          if (!smBody || smBody.length !== N) {
            smBody = new Float32Array(N);
            buf    = new Uint8ClampedArray(N * 4);
          }

          // EMA(連続) → RGBA 書き出し。二値化せず連続値のまま渡すので、
          // 動かない画素は値が一定でちらつかず、動いた画素だけが滑らかに追従する。
          for (let i = 0; i < N; i++) {
            ema(smBody, i, data[i] ? 1 : 0);
            buf[i * 4 + 3] = smBody[i] * 255; // A = body 所属度 (R/G/B は 0)
          }
          if (maskCanvas.width !== w || maskCanvas.height !== h) {
            maskCanvas.width = w; maskCanvas.height = h;
          }
          maskCtx.putImageData(new ImageData(buf, w, h), 0, 0);
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
