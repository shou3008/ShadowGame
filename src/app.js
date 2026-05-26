// BodyPix は index.html の <script> タグで UMD として読み込み済み
const bodyPix = window["body-pix"];

import { Camera }   from './camera.js';
import { Renderer } from './renderer.js';

const video    = document.getElementById('video');
const canvas   = document.getElementById('canvas');
const statusEl = document.getElementById('status');
const fpsEl    = document.getElementById('fps');

const CLOSE_RADIUS  = 15;   // クロージング半径（腕幅程度の隙間を埋める）
const THRESHOLD     = 0.5;  // BodyPix は二値マスクなので EMA 後 0.5 で十分
const ALPHA_STILL   = 0.3;  // 静止ピクセルの EMA 重み
const ALPHA_MOVING  = 0.97; // 変化ピクセルの EMA 重み

// BodyPix 推論設定
const INFERENCE_CONFIG = {
  flipHorizontal:       false,
  internalResolution:   'medium', // 内部解像度 0.5 (速度と精度のバランス)
  segmentationThreshold: 0.7,     // 人体以外をより厳しく除外
};

// --- UI controls ---
const ctrlFg     = document.getElementById('ctrl-fg');
const ctrlBg     = document.getElementById('ctrl-bg');
const ctrlScale  = document.getElementById('ctrl-scale');
const ctrlScaleVal = document.getElementById('ctrl-scale-val');
const ctrlFlip   = document.getElementById('ctrl-flip');
const ctrlCamera = document.getElementById('ctrl-camera');

function hexToVec4(hex) {
  return new Float32Array([
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
    1.0,
  ]);
}

const config = {
  fgColor:    hexToVec4('#000000'),
  bgColor:    hexToVec4('#ffffff'),
  pixelScale: 1.0,
  mirror:     ctrlFlip.checked, // 左右反転
};

ctrlFg.addEventListener('input', () => { config.fgColor = hexToVec4(ctrlFg.value); });
ctrlBg.addEventListener('input', () => { config.bgColor = hexToVec4(ctrlBg.value); });
ctrlFlip.addEventListener('change', () => { config.mirror = ctrlFlip.checked; });
ctrlScale.addEventListener('input', () => {
  config.pixelScale = parseInt(ctrlScale.value) / 100;
});

// --- Main ---
async function main() {
  // 1. Camera
  statusEl.textContent = 'カメラを起動中...';
  const camera = new Camera(video);
  await camera.start({ width: 640, height: 480 });

  // 2. Renderer (WebGL2 dilation)
  const renderer = new Renderer(canvas);

  function fitCanvas() {
    const aspect = camera.width / camera.height;
    const dispW  = Math.min(window.innerWidth, Math.round(window.innerHeight * aspect));
    const dispH  = Math.round(dispW / aspect);
    // CSS 表示サイズは常にフル解像度に固定し、実ピクセルだけ scale で縮小
    canvas.style.width  = dispW + 'px';
    canvas.style.height = dispH + 'px';
    const rw = Math.max(1, Math.round(dispW * config.pixelScale));
    const rh = Math.max(1, Math.round(dispH * config.pixelScale));
    renderer.resize(rw, rh);
    // 画面上に配置する実ピクセル数を表示
    ctrlScaleVal.textContent = `${rw}×${rh}px`;
  }
  fitCanvas();
  window.addEventListener('resize', fitCanvas);
  // スライダー変更時にもリサイズを反映
  ctrlScale.addEventListener('input', fitCanvas);

  // マスクを renderer に渡す中継キャンバス（毎フレーム使い回す）
  const maskCanvas = document.createElement('canvas');
  const maskCtx    = maskCanvas.getContext('2d', { willReadFrequently: false });
  let smoothedMask = null; // 時間方向 EMA 用バッファ
  let paused       = false; // カメラ切替中など、推論を一時停止するフラグ

  // カメラ解像度に合わせて中継キャンバスを同期し、EMA バッファを破棄
  function syncMaskSize() {
    maskCanvas.width  = camera.width;
    maskCanvas.height = camera.height;
    smoothedMask = null;
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
    paused = true; // 切替中はループの推論を止める
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

  // 3. BodyPix モデルのロード
  statusEl.textContent = 'モデルを読み込み中...';
  const net = await bodyPix.load({
    architecture: 'MobileNetV1',
    outputStride: 16,
    multiplier:   0.75,
    quantBytes:   2,
  });

  statusEl.textContent = '実行中';

  let frameCount   = 0;
  let lastFpsTime  = performance.now();
  let processing   = false; // 推論の多重起動を防ぐフラグ

  function loop() {
    if (camera.ready && !processing && !paused) {
      processing = true;

      // BodyPix は非同期: Promise を then で処理して描画
      net.segmentPerson(camera.element, INFERENCE_CONFIG).then(seg => {
        const w = seg.width, h = seg.height;
        const src = seg.data; // Uint8Array: 0=背景, 1=人体

        // Uint8Array (0/1) を Float32 に変換して適応的 EMA を適用
        if (!smoothedMask || smoothedMask.length !== src.length) {
          smoothedMask = new Float32Array(src.length);
          for (let i = 0; i < src.length; i++) smoothedMask[i] = src[i];
        } else {
          for (let i = 0; i < src.length; i++) {
            const val   = src[i]; // 0.0 または 1.0
            const diff  = Math.abs(val - smoothedMask[i]);
            const alpha = ALPHA_STILL + (ALPHA_MOVING - ALPHA_STILL) * Math.min(diff / 0.3, 1.0);
            smoothedMask[i] = alpha * val + (1 - alpha) * smoothedMask[i];
          }
        }

        // Float32 smoothed mask → RGBA canvas（alpha = 平滑化済み信頼度）
        const buf = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < smoothedMask.length; i++) {
          buf[i * 4 + 3] = smoothedMask[i] * 255;
        }
        maskCtx.putImageData(new ImageData(buf, w, h), 0, 0);

        renderer.render(maskCanvas, {
          closeRadius: CLOSE_RADIUS,
          threshold:   THRESHOLD,
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
