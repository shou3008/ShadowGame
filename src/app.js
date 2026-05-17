import { Camera }   from './camera.js';
import { Renderer } from './renderer.js';
import { ImageSegmenter, FilesetResolver } from '../node_modules/@mediapipe/tasks-vision/vision_bundle.mjs';

const video    = document.getElementById('video');
const canvas   = document.getElementById('canvas');
const statusEl = document.getElementById('status');
const fpsEl    = document.getElementById('fps');

const ERODE_RADIUS  = 3;    // 収縮半径（小さくして指を削りすぎない）
const DILATE_RADIUS = 6;    // 膨張半径
const THRESHOLD     = 0.75;
const ALPHA_STILL   = 0.25; // 静止ピクセルのEMA重み（低いほど点滅が消える）
const ALPHA_MOVING  = 0.85; // 変化ピクセルのEMA重み（高いほど残像が消える）

// --- UI controls（色のみ）---
const ctrlFg = document.getElementById('ctrl-fg');
const ctrlBg = document.getElementById('ctrl-bg');

function hexToVec4(hex) {
  return new Float32Array([
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
    1.0,
  ]);
}

const config = {
  fgColor: hexToVec4('#000000'),
  bgColor: hexToVec4('#ffffff'),
};

ctrlFg.addEventListener('input', () => { config.fgColor = hexToVec4(ctrlFg.value); });
ctrlBg.addEventListener('input', () => { config.bgColor = hexToVec4(ctrlBg.value); });

// --- Main ---
async function main() {
  // 1. Camera
  statusEl.textContent = 'カメラを起動中...';
  const camera = new Camera(video);
  await camera.start({ width: 640, height: 480 });

  // 2. Renderer (WebGL2 dilation)
  const renderer = new Renderer(canvas);
  renderer.resize(camera.width, camera.height);

  // 3. MediaPipe Tasks Vision — ImageSegmenter
  statusEl.textContent = 'モデルを読み込み中...';
  const vision = await FilesetResolver.forVisionTasks(
    '../node_modules/@mediapipe/tasks-vision/wasm'
  );
  const segmenter = await ImageSegmenter.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: '../models/selfie_segmenter.tflite',
      delegate: 'GPU',
    },
    outputCategoryMask:    false,
    outputConfidenceMasks: true,
    runningMode: 'VIDEO',
  });

  statusEl.textContent = '実行中';

  // マスクを renderer に渡す中継キャンバス（毎フレーム使い回す）
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width  = camera.width;
  maskCanvas.height = camera.height;
  const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: false });

  let smoothedMask = null; // 時間方向 EMA 用バッファ
  let frameCount   = 0;
  let lastFpsTime  = performance.now();
  let lastTs       = -1;

  function loop(ts) {
    if (camera.ready && ts !== lastTs) {
      lastTs = ts;

      const result = segmenter.segmentForVideo(camera.element, ts);

      // confidenceMasks[1] = person confidence (0=bg, 1=person)
      const conf = result.confidenceMasks?.[1] ?? result.confidenceMasks?.[0];
      if (conf) {
        const w = conf.width, h = conf.height;
        const src = conf.getAsFloat32Array();

        // 適応的EMA: 変化量が大きいピクセルは高alpha（残像を防ぐ）
        //            変化量が小さいピクセルは低alpha（点滅を抑える）
        if (!smoothedMask || smoothedMask.length !== src.length) {
          smoothedMask = new Float32Array(src);
        } else {
          for (let i = 0; i < src.length; i++) {
            const diff  = Math.abs(src[i] - smoothedMask[i]);
            const alpha = ALPHA_STILL + (ALPHA_MOVING - ALPHA_STILL) * Math.min(diff / 0.3, 1.0);
            smoothedMask[i] = alpha * src[i] + (1 - alpha) * smoothedMask[i];
          }
        }

        // Float32 smoothed confidence → RGBA canvas（alpha = 平滑化済み信頼度）
        const buf = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < smoothedMask.length; i++) {
          buf[i * 4 + 3] = smoothedMask[i] * 255;
        }
        maskCtx.putImageData(new ImageData(buf, w, h), 0, 0);

        renderer.render(maskCanvas, {
          erodeRadius:  ERODE_RADIUS,
          dilateRadius: DILATE_RADIUS,
          threshold:    THRESHOLD,
          ...config,
        });
        result.close();
      }
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
