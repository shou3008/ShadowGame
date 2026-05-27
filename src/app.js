// MediaPipe Pose Landmarker: ポーズ(33 ランドマーク)とセグメンテーションを 1 回の推論で取得
//   - VIDEO モードによりモデル内蔵の時間平滑化が効く（揺らぎが少ない）
//   - 指キーポイント(thumb/index/pinky)が取れるので手首の曲げに依存しない手先判定
//   - 左右の検出精度も BodyPix より安定
const MEDIAPIPE_BASE  = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21';
const POSE_MODEL_URL  = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task';

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
const KP_ENTRY_FINGER = 0.30, KP_EXIT_FINGER = 0.15; // 指は MediaPipe でも視認性が落ちやすい
const KP_ENTRY_LEG    = 0.30, KP_EXIT_LEG    = 0.15;

const poseState = { kp: {}, frame: 0 };
function resetPoseState() { poseState.kp = {}; }

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

function emptyPose() {
  return {
    headPos: [0, 0], headR: 0,
    handLA:  [0, 0], handLBs: new Float32Array(MAX_HAND_BS * 2), handLBCount: 0, handLR: 0,
    handRA:  [0, 0], handRBs: new Float32Array(MAX_HAND_BS * 2), handRBCount: 0, handRR: 0,
    legSegA: new Float32Array(MAX_LEG_SEGS   * 2),
    legSegB: new Float32Array(MAX_LEG_SEGS   * 2),
    nonLegPts: new Float32Array(MAX_NONLEG_PTS * 2),
    legSegCount: 0, nonLegCount: 0, legOn: 0,
  };
}

// MediaPipe Pose のランドマーク(normalized [0,1])から色領域用のキーポイントを構築
function buildPose(landmarks, camW, camH) {
  poseState.frame++;
  const out = emptyPose();
  const frame = poseState.frame;
  const arr = (landmarks && landmarks.length > 0) ? landmarks : [];

  // sm: 平滑化＋採否ヒステリシス＋TTL
  //   - 値は EMA(α=0.6)で平滑化
  //   - visibility が entry を超えたら有効化、exit を下回るまで継続
  //   - 短期 (TTL) の検出落ちは前回位置で持続 → 明滅を抑制
  const sm = (i, entry = KP_ENTRY, exit = KP_EXIT) => {
    const lm = arr[i];
    const vis = lm ? (lm.visibility ?? 1) : 0;
    const prev = poseState.kp[i];
    const wasValid = !!prev && (frame - prev.lastValid) <= POSE_TTL;
    const thresh = wasValid ? exit : entry;
    if (lm && vis >= thresh) {
      const raw = [lm.x * camW, lm.y * camH];
      const smoothed = (prev && (frame - prev.lastValid) <= 1)
        ? [POSE_ALPHA * raw[0] + (1 - POSE_ALPHA) * prev.pos[0],
           POSE_ALPHA * raw[1] + (1 - POSE_ALPHA) * prev.pos[1]]
        : raw;
      poseState.kp[i] = { pos: smoothed, lastValid: frame };
      return smoothed;
    } else if (wasValid) {
      return prev.pos;
    } else {
      delete poseState.kp[i];
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

  // 脚関連: Voronoi 判定用の骨格 polyline 点と、対立する非脚キーポイント
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

  // 頭: 耳中点 → 半径は耳間距離 × 1.05（頭頂〜あごをカバー）
  if (leftEar && rightEar) {
    out.headPos = [(leftEar[0] + rightEar[0]) / 2, (leftEar[1] + rightEar[1]) / 2];
    out.headR   = dist(leftEar, rightEar) * 1.05;
  } else if (nose) {
    out.headPos = nose;
    out.headR   = bodyScale * 0.55;
  }

  // 手首から先: 手首(A) から 親指/人差し指/小指 への複数キャプセルの和集合
  //   開いた手の横スプレッドを単一キャプセルでは radius が足りずカバー漏れする問題に対処
  //   検出された指だけキャプセルを伸ばす (見えてない指はスキップ)
  //   指が 1 本も検出されない場合は手首位置の縮退キャプセル(=円)にフォールバック
  const handRadius = Math.max(bodyScale * 0.25, 28);

  const fillHandBs = (Bs, target) => {
    const detected = Bs.filter(p => p !== null);
    return detected.length > 0 ? detected : [target]; // 縮退時は wrist 位置で円
  };

  if (leftWrist) {
    out.handLA = leftWrist;
    const Bs = fillHandBs([leftThumb, leftIndex, leftPinky], leftWrist);
    const count = Math.min(Bs.length, MAX_HAND_BS);
    for (let i = 0; i < count; i++) {
      out.handLBs[i * 2]     = Bs[i][0];
      out.handLBs[i * 2 + 1] = Bs[i][1];
    }
    out.handLBCount = count;
    out.handLR = handRadius;
  }
  if (rightWrist) {
    out.handRA = rightWrist;
    const Bs = fillHandBs([rightThumb, rightIndex, rightPinky], rightWrist);
    const count = Math.min(Bs.length, MAX_HAND_BS);
    for (let i = 0; i < count; i++) {
      out.handRBs[i * 2]     = Bs[i][0];
      out.handRBs[i * 2 + 1] = Bs[i][1];
    }
    out.handRBCount = count;
    out.handRR = handRadius;
  }

  // 脚骨格 polyline: hip→knee→ankle→foot を各脚で線分に分解
  // 端点のいずれかが欠けたセグメントはスキップ
  const segs = [];
  const addSeg = (a, b) => { if (a && b) segs.push([a, b]); };
  addSeg(leftHip,    leftKnee);
  addSeg(leftKnee,   leftAnkle);
  addSeg(leftAnkle,  leftFootIdx);
  addSeg(rightHip,   rightKnee);
  addSeg(rightKnee,  rightAnkle);
  addSeg(rightAnkle, rightFootIdx);
  const segCount = Math.min(segs.length, MAX_LEG_SEGS);
  for (let i = 0; i < segCount; i++) {
    out.legSegA[i*2]   = segs[i][0][0];
    out.legSegA[i*2+1] = segs[i][0][1];
    out.legSegB[i*2]   = segs[i][1][0];
    out.legSegB[i*2+1] = segs[i][1][1];
  }
  out.legSegCount = segCount;

  // 非脚キーポイント (Voronoi 対立点): 肩・肘・手首・股関節
  //   股関節を含めることで腰より上の領域 (胴体/腕) を「非脚側に近い」と判定させる
  const nonLeg = [];
  for (const k of [leftShoulder, rightShoulder, leftElbow, rightElbow,
                   leftWrist,    rightWrist,    leftHip,   rightHip]) {
    if (k) nonLeg.push(k);
  }
  const nonLegCount = Math.min(nonLeg.length, MAX_NONLEG_PTS);
  for (let i = 0; i < nonLegCount; i++) {
    out.nonLegPts[i*2]   = nonLeg[i][0];
    out.nonLegPts[i*2+1] = nonLeg[i][1];
  }
  out.nonLegCount = nonLegCount;
  out.legOn = segCount > 0 ? 1 : 0;

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

  // --- MediaPipe Pose Landmarker のロード ---
  statusEl.textContent = 'MediaPipe を読み込み中...';
  let PoseLandmarker, FilesetResolver;
  try {
    const m = await import(MEDIAPIPE_BASE + '/vision_bundle.mjs');
    PoseLandmarker = m.PoseLandmarker;
    FilesetResolver = m.FilesetResolver;
  } catch (e) {
    statusEl.textContent = 'MediaPipe 読み込み失敗: ' + e.message;
    throw e;
  }

  const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_BASE + '/wasm');
  let poseLandmarker;
  const baseConfig = {
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence:  0.5,
    minTrackingConfidence:      0.5,
    outputSegmentationMasks: true,
  };
  try {
    poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate: 'GPU' },
      ...baseConfig,
    });
  } catch (e) {
    console.warn('GPU 推論不可、CPU にフォールバック:', e);
    poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate: 'CPU' },
      ...baseConfig,
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

        const result = poseLandmarker.detectForVideo(camera.element, ts);

        // セグメンテーションマスク処理（体シルエット）
        const masks = result.segmentationMasks;
        if (masks && masks.length > 0) {
          const mask = masks[0];
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

        // ポーズランドマークから色領域を構築
        const lms = (result.landmarks && result.landmarks.length > 0)
          ? result.landmarks[0] : null;
        const pose = buildPose(lms, camera.width, camera.height);

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
