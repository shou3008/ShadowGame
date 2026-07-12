// DOM 参照・ツールバーの配線・HUD 表示をまとめる。
// ゲームロジックや推論はここに置かない(app.js が両者を繋ぐ)。

const $ = (id) => document.getElementById(id);

export const els = {
  video:      $('video'),
  canvas:     $('canvas'),      // シルエット(WebGL)
  gameCanvas: $('game'),        // ゲームのオーバーレイ(2D)
  status:     $('status'),
  fps:        $('fps'),

  gameStart:   $('game-start'),
  gameReset:   $('game-reset'),
  gameTimer:   $('game-timer'),
  gameRemain:  $('game-remain'),
  result:      $('game-result'),
  resultTitle: $('result-title'),
  resultTime:  $('result-time'),
  resultHint:  $('result-hint'),

  mode:     $('ctrl-mode'),
  camera:   $('ctrl-camera'),
  flip:     $('ctrl-flip'),
  scale:    $('ctrl-scale'),
  scaleVal: $('ctrl-scale-val'),
  cell:     $('ctrl-cell'),
  cellVal:  $('ctrl-cell-val'),
  fg:       $('ctrl-fg'),
  bg:       $('ctrl-bg'),
};

function hexToVec4(hex) {
  return new Float32Array([
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
    1.0,
  ]);
}

// Renderer にそのまま渡す描画設定。ツールバーを操作するとここが書き換わる。
export const config = {
  fgColor:    hexToVec4(els.fg.value),
  bgColor:    hexToVec4(els.bg.value),
  pixelScale: parseInt(els.scale.value) / 100,
  mirror:     els.flip.checked,
  cellSize:   parseInt(els.cell.value),
};

// 見た目のツールバーを config に繋ぐ。
// onScaleChange は解像度スライダー操作時に canvas を張り直すためのフック。
export function bindAppearanceControls(onScaleChange) {
  els.fg.addEventListener('input',    () => { config.fgColor = hexToVec4(els.fg.value); });
  els.bg.addEventListener('input',    () => { config.bgColor = hexToVec4(els.bg.value); });
  els.flip.addEventListener('change', () => { config.mirror  = els.flip.checked; });
  els.cell.addEventListener('input',  () => {
    config.cellSize = parseInt(els.cell.value);
    els.cellVal.textContent = els.cell.value + 'px';
  });
  els.scale.addEventListener('input', () => {
    config.pixelScale = parseInt(els.scale.value) / 100;
    onScaleChange();
  });
}

export const setStatus     = (text) => { els.status.textContent = text; };
export const setFps        = (fps)  => { els.fps.textContent = fps + ' fps'; };
export const setRenderSize = (w, h) => { els.scaleVal.textContent = `${w}×${h}px`; };

// カメラ選択プルダウンを作り直す
export function renderCameraOptions(cams, currentId) {
  els.camera.innerHTML = '';
  cams.forEach((cam, i) => {
    const opt = document.createElement('option');
    opt.value = cam.deviceId;
    opt.textContent = cam.label || `カメラ ${i + 1}`;
    if (cam.deviceId === currentId) opt.selected = true;
    els.camera.appendChild(opt);
  });
}

function showResult({ title, time, hint, gameOver = false }) {
  els.resultTitle.textContent = title;
  els.resultTime.textContent  = time;
  els.resultHint.textContent  = hint;
  els.result.classList.toggle('gameover', gameOver);
  els.result.hidden = false;
}

const hideResult = () => { els.result.hidden = true; };

// モードごとにタイマー・進捗・結果パネルを更新する
export function updateHud(mode, { game, overlapGame, handsGame }) {
  if (mode === 'hands') {
    // 詳しい HUD は HandsGame.draw が canvas に描くので、ここは結果パネルを隠すだけ
    els.gameTimer.textContent  = '--';
    els.gameRemain.textContent = `受け止めた: ${handsGame.caught}`;
    hideResult();
    return;
  }

  if (mode === 'realtime') {
    els.gameTimer.textContent  = '--';
    els.gameRemain.textContent = '2人で影を重ねてボールを運ぼう';
    if (overlapGame.won) {
      showResult({ title: 'CLEAR!', time: 'ゴール達成！', hint: '「スタート」でもう一度' });
    } else {
      hideResult();
    }
    return;
  }

  // capture モード
  const phaseLabel = game.phase === 'pose' ? '（構え中）'
                   : game.phase === 'run'  ? '（実行中）' : '';
  els.gameTimer.textContent  = (game.timeMs / 1000).toFixed(1) + 's';
  els.gameRemain.textContent = `STAGE ${game.stageIndex + 1}/${game.stageCount}${phaseLabel}`;

  if (game.won) {
    showResult({
      title: 'ALL CLEAR!',
      time:  (game.timeMs / 1000).toFixed(1) + ' 秒',
      hint:  '「スタート」でもう一度',
    });
  } else if (game.gameOver) {
    showResult({
      title:    'GAME OVER',
      time:     '落下！',
      hint:     '「スタート」で再挑戦（もう一度ポーズから）',
      gameOver: true,
    });
  } else {
    hideResult();
  }
}
