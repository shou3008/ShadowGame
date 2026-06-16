// BodyPix の segmentPerson を使うシンプルなシルエット方式
//   - 検出した人の画素を 1、それ以外を 0 とする二値マスクを取得し、
//     そのまま影(前景色)として描画するだけ。
//   - 頭/手などの部位判定は行わない（必要になったら別途追加する）。
const bodyPix = window['body-pix'];

import { Camera }       from './camera.js';
import { Renderer }     from './renderer.js';
import { Game }         from './game.js';
import { OverlapGame }  from './overlap-game.js';
import { OverlapField } from './overlap.js';

const video    = document.getElementById('video');
const canvas   = document.getElementById('canvas');
const gameCanvas = document.getElementById('game');
const statusEl = document.getElementById('status');
const fpsEl    = document.getElementById('fps');

// --- ゲーム UI ---
const gameStartBtn  = document.getElementById('game-start');
const gameResetBtn  = document.getElementById('game-reset');
const gameTimerEl   = document.getElementById('game-timer');
const gameRemainEl  = document.getElementById('game-remain');
const gameResultEl  = document.getElementById('game-result');
const resultTitleEl = document.getElementById('result-title');
const resultTimeEl  = document.getElementById('result-time');
const resultHintEl  = document.getElementById('result-hint');

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
// RISE を速くすると、動いた手先などの「新しく現れた画素」がすぐ埋まり、
//   高速移動でも手の先が途切れにくくなる（操作性向上）。
const ALPHA_RISE = 0.75;
const ALPHA_FALL = 0.85;

const INFERENCE_CONFIG = {
  flipHorizontal:        false,
  // 描画はモザイク(粗いセル)に量子化されるため、マスクは過剰に高解像度でも
  //   見た目はほぼ変わらない。そこで internalResolution は 'medium' に下げて
  //   推論を軽くし、描画レート(=スムーズさ)を稼ぐ。見た目の精度は維持される。
  //   手先・輪郭の途切れは segmentationThreshold を低く保つことで補う。
  internalResolution:    'medium',
  // 白い服など「背景との差が小さく確信度が下がる」画素を拾えるよう低めに設定。
  //   下げるほど欠けにくくなるが、背景ノイズも混ざりやすくなる(0.2〜0.3 が目安)。
  segmentationThreshold: 0.2,
};

// 「重なりコア」モード用: 軽い segmentPerson(統合マスク + allPoses) を使う。
//   重い segmentMultiPerson(instance マスク) は使わない。allPoses を出すため
//   多人数ポーズ検出パラメタ(maxDetections 等)を渡す。
const OVERLAP_CONFIG = {
  flipHorizontal:        false,
  internalResolution:    'medium',
  segmentationThreshold: 0.3,
  maxDetections:         6,
  scoreThreshold:        0.3,
  nmsRadius:             20,
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
const ctrlMode   = document.getElementById('ctrl-mode');

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
  // 16:9 ワイド(仮想ワールド 1920×1080 と同じアスペクト)で取得
  await camera.start({ width: 1280, height: 720 });

  const renderer = new Renderer(canvas);
  const game     = new Game(gameCanvas);

  // --- 並行モード「影の重なりコア」 ---
  //   既存のキャプチャ方式(game)はそのまま残し、UI で切り替える。
  let mode = ctrlMode.value === 'overlap' ? 'overlap' : 'capture';
  const overlapGame  = new OverlapGame(gameCanvas);
  const overlapField = new OverlapField();
  // デバッグ補助: 一人で動作確認したいとき。
  //   - A キー or __shadow.overlapField.soloArms = true で「腕2本の重なりで solid」モード(即オフも可)。
  //   - __shadow.overlapField.pad で交差の当たりの甘さ(0=真の交差)、countThresh=1 で全身単独も可。
  window.__shadow = { overlapField, overlapGame, game };
  window.addEventListener('keydown', e => {
    if (e.key === 'a' || e.key === 'A') {
      overlapField.soloArms = !overlapField.soloArms;
      statusEl.textContent = `腕2本デバッグ: ${overlapField.soloArms ? 'ON' : 'OFF'}`;
    }
  });
  ctrlMode.addEventListener('change', () => {
    mode = ctrlMode.value === 'overlap' ? 'overlap' : 'capture';
    smBody = null; buf = null;     // モード切替時はマスクEMAを作り直す
    if (mode === 'overlap') overlapGame.reset();
  });

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

    // ゲームオーバーレイをシルエット canvas にぴったり重ねる
    gameCanvas.width  = dispW;
    gameCanvas.height = dispH;
    gameCanvas.style.width  = dispW + 'px';
    gameCanvas.style.height = dispH + 'px';
    gameCanvas.style.left = canvas.offsetLeft + 'px';
    gameCanvas.style.top  = canvas.offsetTop  + 'px';
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
      await camera.start({ width: 1280, height: 720, deviceId: id });
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
  // multiplier を上げるとモデル容量が増え、斜め/非正面の姿勢や手先の認識が安定する。
  //   さらに堅くしたい場合は architecture:'ResNet50'(高精度・重い) も選択肢。
  const net = await bodyPix.load({
    architecture: 'MobileNetV1',
    outputStride: 16,
    // 白い服・斜めの姿勢などで認識が甘いときは容量を上げると安定する(0.75→1.0)。
    //   さらに堅くしたいなら architecture:'ResNet50'(高精度・重い)。
    multiplier:   1.0,
    quantBytes:   2,
  });

  statusEl.textContent = '実行中';

  let frameCount  = 0;
  let lastFpsTime = performance.now();
  let lastFrame   = performance.now();
  let processing  = false;

  // --- ゲーム操作 (モードで対象を切り替え) ---
  gameStartBtn.addEventListener('click', () => {
    if (mode === 'overlap') overlapGame.reset(); else game.start();
  });
  gameResetBtn.addEventListener('click', () => {
    if (mode === 'overlap') overlapGame.reset(); else game.reset();
  });

  function updateGameHud() {
    if (mode === 'overlap') {
      gameTimerEl.textContent  = '';
      gameRemainEl.textContent = '重なりコア（2人で影を接触→足場）';
      if (overlapGame.won) {
        resultTitleEl.textContent = 'CLEAR!';
        resultTimeEl.textContent  = '';
        resultHintEl.textContent  = '「リセット」でもう一度';
        gameResultEl.classList.remove('gameover');
        gameResultEl.hidden = false;
      } else {
        gameResultEl.hidden = true;
      }
      return;
    }

    gameTimerEl.textContent  = (game.timeMs / 1000).toFixed(1) + 's';
    const phaseLabel = game.phase === 'pose' ? '（構え中）'
                     : game.phase === 'run'  ? '（実行中）' : '';
    gameRemainEl.textContent = `STAGE ${game.stageIndex + 1}/${game.stageCount}${phaseLabel}`;

    if (game.won) {
      resultTitleEl.textContent = 'ALL CLEAR!';
      resultTimeEl.textContent  = (game.timeMs / 1000).toFixed(1) + ' 秒';
      resultHintEl.textContent  = '「スタート」でもう一度';
      gameResultEl.classList.remove('gameover');
      gameResultEl.hidden = false;
    } else if (game.gameOver) {
      resultTitleEl.textContent = 'GAME OVER';
      resultTimeEl.textContent  = '落下！';
      resultHintEl.textContent  = '「スタート」で再挑戦（もう一度ポーズから）';
      gameResultEl.classList.add('gameover');
      gameResultEl.hidden = false;
    } else {
      gameResultEl.hidden = true;
    }
  }

  // union(Uint8) を 既存EMA→buf→maskCanvas に流して シルエット表示する共通処理
  function writeSilhouette(src, w, h) {
    const N = w * h;
    if (!smBody || smBody.length !== N) {
      smBody = new Float32Array(N);
      buf    = new Uint8ClampedArray(N * 4);
    }
    for (let i = 0; i < N; i++) {
      ema(smBody, i, src[i] ? 1 : 0);
      buf[i * 4 + 3] = smBody[i] * 255; // A = body 所属度 (R/G/B は 0)
    }
    if (maskCanvas.width !== w || maskCanvas.height !== h) {
      maskCanvas.width = w; maskCanvas.height = h;
    }
    maskCtx.putImageData(new ImageData(buf, w, h), 0, 0);
  }

  // --- 既存: キャプチャ方式 ---
  function stepCapture(dtMs) {
    game.mirror = config.mirror;
    game.update(dtMs);

    // シルエットは毎フレーム描画する。maskCanvas は推論時のみ更新されるため、
    //   実行(RUN)中は固定シルエットがそのまま再描画され、消えずに残る。
    renderer.render(maskCanvas, { camW: camera.width, camH: camera.height, ...config });
    game.draw();
    updateGameHud();

    // 推論はライブ表示が要るフェーズ(idle/構え)のみ実行。
    //   実行(RUN)/結果中は固定したシルエットのまま＝推論を止めて軽く・スムーズにする。
    if (game.live && camera.ready && !processing && !paused) {
      processing = true;
      net.segmentPerson(camera.element, INFERENCE_CONFIG).then(seg => {
        if (seg && seg.data) {
          writeSilhouette(seg.data, seg.width, seg.height);
          game.setMask(smBody, seg.width, seg.height); // 当たり判定用に最新マスク
        }
        processing = false;
      }).catch(err => {
        console.error('BodyPix error:', err);
        processing = false;
      });
    }
  }

  // --- 並行: 影の重なりコア (軽い segmentPerson + allPoses → 膨張接触 solid) ---
  function stepOverlap(dtMs) {
    overlapGame.update(dtMs);
    // 背景シルエット(全員の統合マスク)は既存 renderer で表示。solid と丸は overlapGame が上に描く。
    renderer.render(maskCanvas, { camW: camera.width, camH: camera.height, ...config });
    overlapGame.draw();
    updateGameHud();

    // 重なりはリアルタイムに変わるので、フェーズに関係なく常に推論する。
    if (camera.ready && !processing && !paused) {
      processing = true;
      net.segmentPerson(camera.element, OVERLAP_CONFIG).then(seg => {
        if (seg && seg.data) {
          const w = seg.width, h = seg.height;
          writeSilhouette(seg.data, w, h); // 統合マスクをそのままシルエット表示
          // allPoses で2人に分割し、接触領域 solid を求める
          const { solid, gw, gh } = overlapField.process(seg.data, seg.allPoses, w, h, config.mirror);
          overlapGame.setMask(solid, gw, gh);
        }
        processing = false;
      }).catch(err => {
        console.error('BodyPix(overlap) error:', err);
        processing = false;
      });
    }
  }

  function loop() {
    // --- ゲームは推論レートに依存せず毎フレーム(60fps)更新・描画 ---
    const tNow = performance.now();
    const dtMs = tNow - lastFrame;
    lastFrame = tNow;

    if (mode === 'overlap') stepOverlap(dtMs);
    else                    stepCapture(dtMs);

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
