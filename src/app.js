// 重力の官能評価実験装置。カメラ → 人物抽出 → 占有率フィールド → 物理 → ログ を繋ぐ層。
//
//   人物抽出 : BodyPix segmentPerson (人=1 / それ以外=0)
//   平滑化   : mask.js    (0..1 の連続値にならす)
//   当たり判定: field.js   (ボールの埋まり率 O。法線・侵入深さ・時間外挿を供給)
//   物理     : lifting-game.js (固定ステップ・完全弾性)
//   進行     : session.js  (盲検ランダム順・固定時間試行)
//   記録     : logger.js   (CSV)
//
// ★重力値はこのファイルにも出てこない。Session の中だけに存在する(盲検)。
const bodyPix = window['body-pix'];

import { Camera }         from './camera.js';
import { Renderer }       from './renderer.js';
import { SilhouetteMask } from './mask.js';
import { LiftingGame }    from './lifting-game.js';
import { Session, physicsSnapshot } from './session.js';
import { Logger }         from './logger.js';
import { DEBUG_ON, drawDebug }      from './debug.js';
import { SELFTEST_ON, runSelfTest } from './selftest.js';
import * as ui            from './ui.js';
import {
  APP_VERSION, CAMERA_SIZE, QUALITY_PRESETS, DEFAULT_QUALITY, INFERENCE_CONFIG,
  WORLD_W, WORLD_H,
} from './settings.js';

const CAMERA_PREF_KEY = 'shadowgame.cameraId';
const loadCameraPref = () => {
  try { return localStorage.getItem(CAMERA_PREF_KEY); } catch { return null; }
};
const saveCameraPref = (id) => {
  try { if (id) localStorage.setItem(CAMERA_PREF_KEY, id); } catch { /* 続行 */ }
};

async function main() {
  const { els, config } = ui;

  // --- カメラ ---
  ui.setStatus('カメラを起動中...');
  const camera = new Camera(els.video);
  await camera.startAuto({ ...CAMERA_SIZE, preferredId: loadCameraPref() });
  saveCameraPref(camera.deviceId);

  // --- 構成要素 ---
  const renderer = new Renderer(els.canvas);
  const mask     = new SilhouetteMask();
  const game     = new LiftingGame(els.gameCanvas);
  const logger   = new Logger();
  const session  = new Session(game, logger);

  // --- レイアウト ---
  function fitCanvas() {
    const aspect = WORLD_W / WORLD_H;
    const dispW  = Math.min(window.innerWidth, Math.round(window.innerHeight * aspect));
    const dispH  = Math.round(dispW / aspect);
    els.canvas.style.width  = dispW + 'px';
    els.canvas.style.height = dispH + 'px';

    const rw = Math.max(1, Math.round(dispW * config.pixelScale));
    const rh = Math.max(1, Math.round(dispH * config.pixelScale));
    renderer.resize(rw, rh);
    ui.setRenderSize(rw, rh);

    els.gameCanvas.width  = dispW;
    els.gameCanvas.height = dispH;
    els.gameCanvas.style.width  = dispW + 'px';
    els.gameCanvas.style.height = dispH + 'px';
    els.gameCanvas.style.left   = els.canvas.offsetLeft + 'px';
    els.gameCanvas.style.top    = els.canvas.offsetTop  + 'px';
  }
  ui.bindAppearanceControls(fitCanvas);
  window.addEventListener('resize', fitCanvas);
  fitCanvas();
  mask.reset(camera.width, camera.height);

  // --- カメラ切替 ---
  let paused = false;
  let processing = false;

  async function fillCameraSelect() {
    const cams = await camera.listCameras();
    const current = camera.deviceId;
    els.camera.innerHTML = '';
    cams.forEach((cam, i) => {
      const opt = document.createElement('option');
      opt.value = cam.deviceId;
      opt.textContent = cam.label || `カメラ ${i + 1}`;
      if (cam.deviceId === current) opt.selected = true;
      els.camera.appendChild(opt);
    });
  }

  els.camera.addEventListener('change', async () => {
    paused = true;
    ui.setStatus('カメラ切り替え中...');
    try {
      await camera.start({ ...CAMERA_SIZE, deviceId: els.camera.value });
      saveCameraPref(camera.deviceId);
      mask.reset(camera.width, camera.height);
      game.field.reset();
      fitCanvas();
      ui.setStatus('準備完了');
    } catch (err) {
      ui.setStatus('カメラ切替エラー: ' + err.message);
      console.error(err);
    } finally {
      paused = false;
    }
    fillCameraSelect();
  });

  await fillCameraSelect();
  navigator.mediaDevices.addEventListener('devicechange', fillCameraSelect);

  // --- BodyPix ---
  let quality = els.quality.value || DEFAULT_QUALITY;
  ui.setStatus(`BodyPix を読み込み中(${QUALITY_PRESETS[quality].label})...`);

  // backend が cpu に落ちると推論が桁違いに遅くなる。既定任せにせず webgl を明示的に要求する。
  try {
    await tf.setBackend('webgl');
  } catch (err) {
    console.error('WebGL backend の設定に失敗:', err);
  }
  await tf.ready();

  const backend = tf.getBackend();
  console.log('TF backend:', backend, backend === 'webgl' ? '(OK)' : '(!!! 実験に使えない)');
  console.log('カメラ解像度:', camera.width, '×', camera.height);

  let net = await bodyPix.load(QUALITY_PRESETS[quality].model);
  ui.setBackendBanner(backend);

  els.quality.addEventListener('change', async () => {
    const next = els.quality.value;
    if (next === quality) return;
    paused = true;
    ui.setStatus(`モデルを切り替え中(${QUALITY_PRESETS[next].label})...`);
    try {
      const loaded = await bodyPix.load(QUALITY_PRESETS[next].model);
      // paused は「新しい推論を始めない」だけ。実行中の推論はまだ旧モデルを掴んでいる。
      while (processing) await new Promise(requestAnimationFrame);
      const old = net;
      net = loaded;
      quality = next;
      old.dispose();
      ui.setBackendBanner(tf.getBackend());
    } catch (err) {
      els.quality.value = quality;
      ui.setStatus('モデル切替エラー: ' + err.message);
      console.error(err);
    } finally {
      paused = false;
    }
  });

  if (SELFTEST_ON) runSelfTest();

  // --- セッション操作 ---
  ui.bindSession({
    onNext: () => {
      if (session.state === 'idle') {
        const pid = (els.pid.value || '').trim();
        if (!pid) { alert('参加者IDを入力してください'); return; }
        session.begin(pid, {
          app_version: APP_VERSION,
          tf_backend:  backend,
          quality_preset: quality,
          camera_w: camera.width,
          camera_h: camera.height,
          cell_size:   config.cellSize,
          pixel_scale: config.pixelScale,
          mirror: config.mirror ? 1 : 0,
          ...physicsSnapshot(),
        });
      }
      session.next();
      ui.updateSessionUi(session);
    },
    onAbort: () => { session.abort(); ui.updateSessionUi(session); },
    onExportTrials: () => {
      if (!logger.exportTrials()) alert('まだ記録がありません');
    },
    onExportEvents: () => {
      if (!logger.exportEvents()) alert('まだ記録がありません');
    },
  });
  ui.updateSessionUi(session);

  window.addEventListener('beforeunload', (e) => {
    if (logger.hasUnexported) { e.preventDefault(); e.returnValue = ''; }
  });

  // --- 推論結果 ---
  let lastCoverage = 0;
  function applySegmentation(seg) {
    mask.update(seg);
    game.mirror = config.mirror;
    game.setMask(mask.smooth, seg.width, seg.height);
    lastCoverage = game.field.coverage;
  }

  // --- メインループ ---
  let lastFrame   = performance.now();
  let lastFpsTime = performance.now();
  let frameCount  = 0;
  let inferCount  = 0;
  let inferMsSum  = 0;
  let maskMsSum   = 0;
  let wasRunning  = false;

  function loop() {
    const now  = performance.now();
    const dtMs = now - lastFrame;
    lastFrame  = now;

    session.update(dtMs);      // game.update より先。カウントダウン終了で startPlay する
    game.update(dtMs);

    renderer.render(mask.canvas, { camW: camera.width, camH: camera.height, ...config });

    game.draw();
    const ctx = els.gameCanvas.getContext('2d');
    if (DEBUG_ON) drawDebug(ctx, game.field, game.ball, performance.now() / 1000);
    session.drawHud(ctx);

    // 試行中はツールバーを隠し、剰余変数になるコントロールをロックする
    const running = session.running;
    if (running !== wasRunning) {
      ui.lockControls(running);
      ui.setToolbarVisible(!running);
      ui.updateSessionUi(session);
      wasRunning = running;
    }
    if (!running && session.state !== 'idle') ui.updateSessionUi(session);

    if (camera.ready && !processing && !paused) {
      processing = true;
      const inferConfig = {
        ...INFERENCE_CONFIG,
        internalResolution: QUALITY_PRESETS[quality].internalResolution,
      };
      const tCall = performance.now();
      net.segmentPerson(camera.element, inferConfig)
        .then(seg => {
          const tInferred = performance.now();
          if (seg && seg.data) applySegmentation(seg);
          const tApplied = performance.now();

          const inferMs = tInferred - tCall;
          inferMsSum += inferMs;
          maskMsSum  += tApplied - tInferred;
          inferCount++;
          session.noteInference(inferMs, lastCoverage);
        })
        .catch(err => { console.error('BodyPix error:', err); })
        .finally(() => { processing = false; });
    }

    frameCount++;
    if (now - lastFpsTime >= 1000) {
      const n = inferCount || 1;
      ui.setFps(frameCount, inferCount, inferMsSum / n, maskMsSum / n);
      frameCount = 0; inferCount = 0; inferMsSum = 0; maskMsSum = 0;
      lastFpsTime = now;
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

main().catch(err => {
  ui.setStatus('エラー: ' + err.message);
  console.error(err);
});
