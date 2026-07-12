// アプリの起点。カメラ → 人物抽出 → 描画 → ゲームを繋ぐだけの層。
//   人物抽出: BodyPix の segmentPerson (人=1 / それ以外=0 の二値マスク。部位判定はしない)
//   平滑化  : mask.js       (二値マスクを 0..1 の連続値にならす)
//   描画    : renderer.js   (WebGL2 でモザイク状のシルエットを描く)
//   ゲーム  : モードごとに game.js / overlap-game.js / hands-game.js へ委譲
// 調整値は settings.js、DOM まわりは ui.js に置き、ここにはロジックを増やさない。
const bodyPix = window['body-pix'];

import { Camera }         from './camera.js';
import { Renderer }       from './renderer.js';
import { SilhouetteMask } from './mask.js';
import { Game }           from './game.js';
import { OverlapGame }    from './overlap-game.js';
import { OverlapField }   from './overlap.js';
import { HandsGame }      from './hands-game.js';
import * as ui            from './ui.js';
import { CAMERA_SIZE, MODEL_CONFIG, INFERENCE_CONFIG, HANDS_CONFIG } from './settings.js';

// 選んだカメラを次回も使う。仮想カメラ(OBS 等)がブラウザの既定になっている環境で、
// 毎回選び直さずに済むようにするため。
const CAMERA_PREF_KEY = 'shadowgame.cameraId';
const loadCameraPref = () => {
  try { return localStorage.getItem(CAMERA_PREF_KEY); } catch { return null; }
};
const saveCameraPref = (id) => {
  try { if (id) localStorage.setItem(CAMERA_PREF_KEY, id); } catch { /* 保存できなくても続行 */ }
};

async function main() {
  const { els, config } = ui;

  // --- カメラ ---
  ui.setStatus('カメラを起動中...');
  const camera = new Camera(els.video);
  await camera.startAuto({ ...CAMERA_SIZE, preferredId: loadCameraPref() });
  saveCameraPref(camera.deviceId);

  // --- 描画とゲーム ---
  const renderer     = new Renderer(els.canvas);
  const mask         = new SilhouetteMask();
  const overlapField = new OverlapField();

  // 'capture'  = ポーズ→キャプチャ→実行（固定シルエットを坂や壁にしてボールを運ぶ）
  // 'realtime' = 複数人がリアルタイムに動き、影の重なりを当たり判定にして遊ぶ
  // 'hands'    = 2人の手首が重なった位置にコライダーを作り、落下物を受け止める
  const games = {
    game:        new Game(els.gameCanvas),
    overlapGame: new OverlapGame(els.gameCanvas),
    handsGame:   new HandsGame(els.gameCanvas),
  };
  const { game, overlapGame, handsGame } = games;

  let mode = els.mode.value;
  const activeGame = () =>
    mode === 'realtime' ? overlapGame :
    mode === 'hands'    ? handsGame   : game;

  // --- レイアウト ---
  function fitCanvas() {
    const aspect = camera.width / camera.height;
    const dispW  = Math.min(window.innerWidth, Math.round(window.innerHeight * aspect));
    const dispH  = Math.round(dispW / aspect);
    els.canvas.style.width  = dispW + 'px';
    els.canvas.style.height = dispH + 'px';

    const rw = Math.max(1, Math.round(dispW * config.pixelScale));
    const rh = Math.max(1, Math.round(dispH * config.pixelScale));
    renderer.resize(rw, rh);
    ui.setRenderSize(rw, rh);

    // ゲームのオーバーレイをシルエット canvas にぴったり重ねる
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

  const refreshCameraList = async () => {
    ui.renderCameraOptions(await camera.listCameras(), camera.deviceId);
  };

  els.camera.addEventListener('change', async () => {
    paused = true;
    ui.setStatus('カメラ切り替え中...');
    try {
      await camera.start({ ...CAMERA_SIZE, deviceId: els.camera.value });
      saveCameraPref(camera.deviceId);
      mask.reset(camera.width, camera.height);
      fitCanvas();
      ui.setStatus('実行中');
    } catch (err) {
      ui.setStatus('カメラ切替エラー: ' + err.message);
      console.error(err);
    } finally {
      paused = false;
    }
    refreshCameraList();
  });

  await refreshCameraList();
  navigator.mediaDevices.addEventListener('devicechange', refreshCameraList);

  // --- ゲーム操作 ---
  els.gameStart.addEventListener('click', () => {
    // capture 以外(realtime/hands)はフェーズが無いので、スタートは仕切り直しと同義
    if (mode === 'capture') game.start();
    else                    activeGame().reset();
  });
  els.gameReset.addEventListener('click', () => { activeGame().reset(); });

  els.mode.addEventListener('change', () => {
    mode = els.mode.value;
    Object.values(games).forEach(g => g.reset());
    // 旧モードの描画を消す(次フレームで現モードが描き直す)
    els.gameCanvas.getContext('2d').clearRect(0, 0, els.gameCanvas.width, els.gameCanvas.height);
  });

  // --- BodyPix モデル ---
  ui.setStatus('BodyPix を読み込み中...');
  await tf.ready(); // backend(WebGL/CPU 等)の初期化を待つ
  console.log('TF backend:', tf.getBackend());
  const net = await bodyPix.load(MODEL_CONFIG);
  ui.setStatus('実行中');

  // --- 推論結果の振り分け ---
  function applySegmentation(seg) {
    mask.update(seg);
    const { width: w, height: h } = seg;

    if (mode === 'realtime') {
      // 複数人の骨格から「影が重なったセル」を求めて当たり判定に渡す
      const field = overlapField.process(mask.smooth, seg.allPoses, w, h, config.mirror);
      overlapGame.setMask(field.solid, field.gw, field.gh);
    } else if (mode === 'hands') {
      // 手首キーポイントだけ渡す。重なり判定と Matter 物理は hands-game.js 側で行う
      handsGame.setPoses(seg.allPoses, w, h, config.mirror);
    } else {
      game.setMask(mask.smooth, w, h);
    }
  }

  // --- メインループ ---
  // ゲームは推論レートに依存せず毎フレーム(60fps)更新・描画し、
  // 推論は前回の結果が返ってきているときだけ走らせる(processing で多重実行を防ぐ)。
  let processing  = false;
  let lastFrame   = performance.now();
  let lastFpsTime = performance.now();
  let frameCount  = 0;

  function loop() {
    const now  = performance.now();
    const dtMs = now - lastFrame;
    lastFrame  = now;

    const active = activeGame();
    game.mirror = config.mirror;
    active.update(dtMs);

    // シルエットは毎フレーム描く。マスクは推論時にしか更新されないので、
    // capture の実行(RUN)中は固定シルエットがそのまま描き直され、消えずに残る。
    renderer.render(mask.canvas, { camW: camera.width, camH: camera.height, ...config });
    active.draw();
    ui.updateHud(mode, games);

    // capture       : ライブ表示が要るフェーズ(idle/構え)だけ推論する
    // realtime/hands: 全員が動き続けるので常に推論する
    const needInfer = mode === 'capture' ? game.live : true;
    if (needInfer && camera.ready && !processing && !paused) {
      processing = true;
      // hands は背景ノイズ(ソファ等の誤検出)を弾くため厳しめの設定を使う
      const inferConfig = mode === 'hands' ? HANDS_CONFIG : INFERENCE_CONFIG;
      net.segmentPerson(camera.element, inferConfig)
        .then(seg => { if (seg && seg.data) applySegmentation(seg); })
        .catch(err => { console.error('BodyPix error:', err); })
        .finally(() => { processing = false; });
    }

    frameCount++;
    if (now - lastFpsTime >= 1000) {
      ui.setFps(frameCount);
      frameCount  = 0;
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
