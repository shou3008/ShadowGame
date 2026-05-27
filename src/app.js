// MediaPipe Pose Landmarker: ポーズ(33 ランドマーク)とセグメンテーションを 1 回の推論で取得
//   - VIDEO モードによりモデル内蔵の時間平滑化が効く（揺らぎが少ない）
//   - 指キーポイント(thumb/index/pinky)が取れるので手首の曲げに依存しない手先判定
//   - 左右の検出精度も BodyPix より安定
const MEDIAPIPE_BASE  = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21';
// 多人数検出のため LITE → FULL モデルに変更
const POSE_MODEL_URL  = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task';
// 多人数シルエット用: BodyPix segmentPerson 相当の selfie segmenter
//   PoseLandmarker のセグメンテーションは「ポーズ毎」だが、こちらは画像全体を
//   1 つの mask で返すので、人数や検出失敗に依らず確実に全員のシルエットが出る
const SEG_MODEL_URL   = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';

import { Camera }   from './camera.js';
import { Renderer } from './renderer.js';

const video    = document.getElementById('video');
const canvas   = document.getElementById('canvas');
const statusEl = document.getElementById('status');
const fpsEl    = document.getElementById('fps');

const CLOSE_RADIUS = 5;
const THRESHOLD    = 0.5;

// 体マスクの時間平滑化 + ヒステリシス
const EMA_ALPHA = 0.5;
const HYST_HIGH = 0.7;
const HYST_LOW  = 0.3;

// MediaPipe Pose のランドマークインデックス(33 点)
const MP = {
  nose: 0,
  leftEar: 7,  rightEar: 8,
  leftShoulder: 11, rightShoulder: 12,
  leftElbow: 13, rightElbow: 14,
  leftWrist: 15, rightWrist: 16,
  leftPinky: 17, rightPinky: 18,
  leftIndex: 19, rightIndex: 20,
  leftThumb: 21, rightThumb: 22,
  leftHip: 23,  rightHip: 24,
  leftKnee: 25, rightKnee: 26,
  leftAnkle: 27, rightAnkle: 28,
  leftFootIndex: 31, rightFootIndex: 32,
};

// キーポイント時間平滑化 + 採否ヒステリシス（揺らぎ対策）
// MediaPipe 自体の平滑化に加えて二重の安定化
const POSE_ALPHA = 0.6;
const POSE_TTL   = 2;
const KP_ENTRY        = 0.40, KP_EXIT        = 0.20;
const KP_ENTRY_WRIST  = 0.50, KP_EXIT_WRIST  = 0.25;
const KP_ENTRY_FINGER = 0.30, KP_EXIT_FINGER = 0.15;
const KP_ENTRY_LEG    = 0.30, KP_EXIT_LEG    = 0.15;

// 複数人対応: 各ポーズインデックス毎に独立した平滑化状態を持つ
const MAX_POSES = 4;
const poseState = {
  kps: Array.from({ length: MAX_POSES }, () => ({})),
  frame: 0,
};
function resetPoseState() {
  for (let i = 0; i < MAX_POSES; i++) poseState.kps[i] = {};
}

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

// shader 側の配列サイズと一致
const MAX_LEG_SEGS   = 6;
const MAX_NONLEG_PTS = 8;
const MAX_HAND_BS    = 3;

// 複数人ポーズ用の flat 配列構造を作る
function emptyPoses() {
  return {
    poseCount: 0,
    headPos:    new Float32Array(MAX_POSES * 2),
    headR:      new Float32Array(MAX_POSES),
    handLA:     new Float32Array(MAX_POSES * 2),
    handLBs:    new Float32Array(MAX_POSES * MAX_HAND_BS * 2),
    handLBCount:new Int32Array  (MAX_POSES),
    handLR:     new Float32Array(MAX_POSES),
    handRA:     new Float32Array(MAX_POSES * 2),
    handRBs:    new Float32Array(MAX_POSES * MAX_HAND_BS * 2),
    handRBCount:new Int32Array  (MAX_POSES),
    handRR:     new Float32Array(MAX_POSES),
    legSegA:    new Float32Array(MAX_POSES * MAX_LEG_SEGS * 2),
    legSegB:    new Float32Array(MAX_POSES * MAX_LEG_SEGS * 2),
    legSegCount:new Int32Array  (MAX_POSES),
    nonLegPts:  new Float32Array(MAX_POSES * MAX_NONLEG_PTS * 2),
    nonLegCount:new Int32Array  (MAX_POSES),
    legOn:      new Int32Array  (MAX_POSES),
    legRadius:  new Float32Array(MAX_POSES),
  };
}

// 1 人分のランドマークを ポーズインデックス pi の位置に書き込む
function buildOnePose(out, pi, landmarks, camW, camH) {
  const kpState = poseState.kps[pi];
  const frame   = poseState.frame;
  const arr     = landmarks || [];

  // sm: ポーズごとに独立した平滑化＋採否ヒステリシス＋TTL
  const sm = (i, entry = KP_ENTRY, exit = KP_EXIT) => {
    const lm = arr[i];
    const vis = lm ? (lm.visibility ?? 1) : 0;
    const prev = kpState[i];
    const wasValid = !!prev && (frame - prev.lastValid) <= POSE_TTL;
    const thresh = wasValid ? exit : entry;
    if (lm && vis >= thresh) {
      const raw = [lm.x * camW, lm.y * camH];
      const smoothed = (prev && (frame - prev.lastValid) <= 1)
        ? [POSE_ALPHA * raw[0] + (1 - POSE_ALPHA) * prev.pos[0],
           POSE_ALPHA * raw[1] + (1 - POSE_ALPHA) * prev.pos[1]]
        : raw;
      kpState[i] = { pos: smoothed, lastValid: frame };
      return smoothed;
    } else if (wasValid) {
      return prev.pos;
    } else {
      delete kpState[i];
      return null;
    }
  };

  const nose          = sm(MP.nose);
  const leftEar       = sm(MP.leftEar,  0.20, 0.10);
  const rightEar      = sm(MP.rightEar, 0.20, 0.10);
  const leftShoulder  = sm(MP.leftShoulder);
  const rightShoulder = sm(MP.rightShoulder);

  const leftWrist  = sm(MP.leftWrist,  KP_ENTRY_WRIST, KP_EXIT_WRIST);
  const rightWrist = sm(MP.rightWrist, KP_ENTRY_WRIST, KP_EXIT_WRIST);
  const leftIndex  = sm(MP.leftIndex,  KP_ENTRY_FINGER, KP_EXIT_FINGER);
  const rightIndex = sm(MP.rightIndex, KP_ENTRY_FINGER, KP_EXIT_FINGER);
  const leftPinky  = sm(MP.leftPinky,  KP_ENTRY_FINGER, KP_EXIT_FINGER);
  const rightPinky = sm(MP.rightPinky, KP_ENTRY_FINGER, KP_EXIT_FINGER);
  const leftThumb  = sm(MP.leftThumb,  KP_ENTRY_FINGER, KP_EXIT_FINGER);
  const rightThumb = sm(MP.rightThumb, KP_ENTRY_FINGER, KP_EXIT_FINGER);

  const leftHip      = sm(MP.leftHip,      KP_ENTRY_LEG, KP_EXIT_LEG);
  const rightHip     = sm(MP.rightHip,     KP_ENTRY_LEG, KP_EXIT_LEG);
  const leftKnee     = sm(MP.leftKnee,     KP_ENTRY_LEG, KP_EXIT_LEG);
  const rightKnee    = sm(MP.rightKnee,    KP_ENTRY_LEG, KP_EXIT_LEG);
  const leftAnkle    = sm(MP.leftAnkle,    KP_ENTRY_LEG, KP_EXIT_LEG);
  const rightAnkle   = sm(MP.rightAnkle,   KP_ENTRY_LEG, KP_EXIT_LEG);
  const leftFootIdx  = sm(MP.leftFootIndex,  KP_ENTRY_LEG, KP_EXIT_LEG);
  const rightFootIdx = sm(MP.rightFootIndex, KP_ENTRY_LEG, KP_EXIT_LEG);
  const leftElbow    = sm(MP.leftElbow);
  const rightElbow   = sm(MP.rightElbow);

  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const bodyScale = (leftShoulder && rightShoulder)
    ? dist(leftShoulder, rightShoulder)
    : 150;

  // 頭
  if (leftEar && rightEar) {
    out.headPos[pi*2]   = (leftEar[0] + rightEar[0]) / 2;
    out.headPos[pi*2+1] = (leftEar[1] + rightEar[1]) / 2;
    out.headR[pi] = dist(leftEar, rightEar) * 1.05;
  } else if (nose) {
    out.headPos[pi*2]   = nose[0];
    out.headPos[pi*2+1] = nose[1];
    out.headR[pi] = bodyScale * 0.55;
  }

  // 手 (multi-capsule)
  const handRadius = Math.max(bodyScale * 0.25, 28);
  const writeHand = (A, Bs, baseA, baseBs, countArr, rArr) => {
    if (!A) return;
    out[baseA][pi*2]   = A[0];
    out[baseA][pi*2+1] = A[1];
    const detected = Bs.filter(p => p !== null);
    const real = detected.length > 0 ? detected : [A];
    const count = Math.min(real.length, MAX_HAND_BS);
    const base = pi * MAX_HAND_BS * 2;
    for (let i = 0; i < count; i++) {
      out[baseBs][base + i*2]   = real[i][0];
      out[baseBs][base + i*2+1] = real[i][1];
    }
    out[countArr][pi] = count;
    out[rArr][pi] = handRadius;
  };
  writeHand(leftWrist,  [leftThumb,  leftIndex,  leftPinky],
            'handLA', 'handLBs', 'handLBCount', 'handLR');
  writeHand(rightWrist, [rightThumb, rightIndex, rightPinky],
            'handRA', 'handRBs', 'handRBCount', 'handRR');

  // 脚 polyline
  const segs = [];
  const addSeg = (a, b) => { if (a && b) segs.push([a, b]); };
  addSeg(leftHip,    leftKnee);
  addSeg(leftKnee,   leftAnkle);
  addSeg(leftAnkle,  leftFootIdx);
  addSeg(rightHip,   rightKnee);
  addSeg(rightKnee,  rightAnkle);
  addSeg(rightAnkle, rightFootIdx);
  const segCount = Math.min(segs.length, MAX_LEG_SEGS);
  const legBase = pi * MAX_LEG_SEGS * 2;
  for (let i = 0; i < segCount; i++) {
    out.legSegA[legBase + i*2]   = segs[i][0][0];
    out.legSegA[legBase + i*2+1] = segs[i][0][1];
    out.legSegB[legBase + i*2]   = segs[i][1][0];
    out.legSegB[legBase + i*2+1] = segs[i][1][1];
  }
  out.legSegCount[pi] = segCount;

  // 非脚キーポイント (Voronoi 対立点)
  const nonLeg = [];
  for (const k of [leftShoulder, rightShoulder, leftElbow, rightElbow,
                   leftWrist,    rightWrist,    leftHip,   rightHip]) {
    if (k) nonLeg.push(k);
  }
  const nonLegCount = Math.min(nonLeg.length, MAX_NONLEG_PTS);
  const nonLegBase = pi * MAX_NONLEG_PTS * 2;
  for (let i = 0; i < nonLegCount; i++) {
    out.nonLegPts[nonLegBase + i*2]   = nonLeg[i][0];
    out.nonLegPts[nonLegBase + i*2+1] = nonLeg[i][1];
  }
  out.nonLegCount[pi] = nonLegCount;
  out.legOn[pi]       = segCount > 0 ? 1 : 0;
  // 絶対距離ガード: 他の人の脚骨格が遠くから誤マッチしないよう、
  // bodyScale * 0.5 ≒ 半身分の距離を上限にする
  out.legRadius[pi]   = Math.max(bodyScale * 0.5, 60);
}

// すべてのポーズを処理して flat 配列を返す
function buildPoses(allLandmarks, camW, camH) {
  poseState.frame++;
  const out = emptyPoses();
  const list = allLandmarks || [];
  const n = Math.min(list.length, MAX_POSES);
  for (let pi = 0; pi < n; pi++) {
    buildOnePose(out, pi, list[pi], camW, camH);
  }
  out.poseCount = n;
  return out;
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

  // マスクキャンバスと状態
  const maskCanvas = document.createElement('canvas');
  const maskCtx    = maskCanvas.getContext('2d', { willReadFrequently: false });
  let smoothedBody = null;
  let binaryBody   = null;
  let reuseBuf     = null;
  let reuseBufN    = 0;
  let paused       = false;

  function syncMaskSize() {
    maskCanvas.width  = camera.width;
    maskCanvas.height = camera.height;
    smoothedBody = null;
    binaryBody   = null;
    resetPoseState();
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

  // --- MediaPipe のロード ---
  statusEl.textContent = 'MediaPipe を読み込み中...';
  let PoseLandmarker, ImageSegmenter, FilesetResolver;
  try {
    const m = await import(MEDIAPIPE_BASE + '/vision_bundle.mjs');
    PoseLandmarker  = m.PoseLandmarker;
    ImageSegmenter  = m.ImageSegmenter;
    FilesetResolver = m.FilesetResolver;
  } catch (e) {
    statusEl.textContent = 'MediaPipe 読み込み失敗: ' + e.message;
    throw e;
  }

  const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_BASE + '/wasm');

  // PoseLandmarker: キーポイント検出専用 (segmentation は使わない)
  let poseLandmarker;
  const poseConfig = {
    runningMode: 'VIDEO',
    numPoses: MAX_POSES,
    // 多人数検出のため閾値を下げる
    minPoseDetectionConfidence: 0.3,
    minPosePresenceConfidence:  0.3,
    minTrackingConfidence:      0.3,
    outputSegmentationMasks: false, // ImageSegmenter に任せる
  };
  try {
    poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate: 'GPU' },
      ...poseConfig,
    });
  } catch (e) {
    console.warn('Pose: GPU 推論不可、CPU にフォールバック:', e);
    poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate: 'CPU' },
      ...poseConfig,
    });
  }

  // ImageSegmenter: シルエット専用 (画像全体で人 vs 背景の 1 マスク = 多人数 OK)
  let imageSegmenter;
  const segConfig = {
    runningMode: 'VIDEO',
    outputCategoryMask: false,
    outputConfidenceMasks: true,
  };
  try {
    imageSegmenter = await ImageSegmenter.createFromOptions(vision, {
      baseOptions: { modelAssetPath: SEG_MODEL_URL, delegate: 'GPU' },
      ...segConfig,
    });
  } catch (e) {
    console.warn('Segmenter: GPU 推論不可、CPU にフォールバック:', e);
    imageSegmenter = await ImageSegmenter.createFromOptions(vision, {
      baseOptions: { modelAssetPath: SEG_MODEL_URL, delegate: 'CPU' },
      ...segConfig,
    });
  }

  statusEl.textContent = '実行中';

  let frameCount  = 0;
  let lastFpsTime = performance.now();
  let lastTs      = 0;

  function loop() {
    if (camera.ready && !paused) {
      try {
        let ts = performance.now();
        if (ts <= lastTs) ts = lastTs + 1; // VIDEO モードは厳密に単調増加が必要
        lastTs = ts;

        // --- 2 系統の推論を並走 ---
        // 1) ImageSegmenter: 画像全体 → 単一の人マスク (多人数も 1 つにまとまる)
        // 2) PoseLandmarker: 最大 MAX_POSES 人分のキーポイント
        const segResult  = imageSegmenter.segmentForVideo(camera.element, ts);
        const poseResult = poseLandmarker.detectForVideo(camera.element, ts);

        // セグメンテーション処理: confidenceMasks[0] が「前景(人)」の信頼度マスク
        const segMasks = segResult.confidenceMasks;
        if (segMasks && segMasks.length > 0) {
          const mask = segMasks[0];
          const data = mask.getAsFloat32Array();
          const w = mask.width, h = mask.height;
          const N = data.length;

          if (!smoothedBody || smoothedBody.length !== N) {
            smoothedBody = new Float32Array(N);
            binaryBody   = new Uint8Array(N);
            for (let i = 0; i < N; i++) {
              smoothedBody[i] = data[i];
              binaryBody[i]   = data[i] > 0.5 ? 1 : 0;
            }
          } else {
            for (let i = 0; i < N; i++) {
              const v = data[i];
              const s = EMA_ALPHA * v + (1 - EMA_ALPHA) * smoothedBody[i];
              smoothedBody[i] = s;
              if (binaryBody[i]) { if (s < HYST_LOW)  binaryBody[i] = 0; }
              else               { if (s > HYST_HIGH) binaryBody[i] = 1; }
            }
          }

          if (maskCanvas.width !== w || maskCanvas.height !== h) {
            maskCanvas.width = w; maskCanvas.height = h;
          }
          if (!reuseBuf || reuseBufN !== N * 4) {
            reuseBuf = new Uint8ClampedArray(N * 4);
            reuseBufN = N * 4;
          }
          for (let i = 0; i < N; i++) {
            reuseBuf[i * 4 + 3] = binaryBody[i] ? 255 : 0;
          }
          maskCtx.putImageData(new ImageData(reuseBuf, w, h), 0, 0);
          mask.close();
        }

        // 全員分のポーズランドマークから色領域を構築
        const pose = buildPoses(poseResult.landmarks, camera.width, camera.height);

        renderer.render(maskCanvas, {
          closeRadius: CLOSE_RADIUS,
          threshold:   THRESHOLD,
          camW: camera.width, camH: camera.height,
          pose,
          ...config,
        });
      } catch (e) {
        console.error('MediaPipe inference error:', e);
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
