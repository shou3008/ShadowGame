// DOM 参照・ツールバーの配線・ステータス表示。
// ★重力値をここへ持ち込んではいけない(盲検)。Session が公開していないので、そもそも取れない。

const $ = (id) => document.getElementById(id);

export const els = {
  video:      $('video'),
  canvas:     $('canvas'),      // シルエット(WebGL)
  gameCanvas: $('game'),        // ゲームとHUDのオーバーレイ(2D)
  status:     $('status'),
  fps:        $('fps'),
  toolbar:    $('toolbar'),
  uiShow:     $('ui-show'),

  pid:          $('ctrl-pid'),
  next:         $('btn-next'),
  abort:        $('btn-abort'),
  progress:     $('hud-progress'),
  exportTrials: $('btn-export-trials'),
  exportEvents: $('btn-export-events'),

  operator: $('btn-operator'),

  camera:   $('ctrl-camera'),
  quality:  $('ctrl-quality'),
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

// Renderer にそのまま渡す描画設定。
// version は外観が変わるたびに進む。描画側はこれを見て「変わったときだけ」再描画する。
export const config = {
  fgColor:    hexToVec4(els.fg.value),
  bgColor:    hexToVec4(els.bg.value),
  pixelScale: parseInt(els.scale.value) / 100,
  mirror:     els.flip.checked,
  cellSize:   parseInt(els.cell.value),
  version:    0,
};

export function bindAppearanceControls(onScaleChange) {
  els.fg.addEventListener('input',    () => { config.fgColor = hexToVec4(els.fg.value); config.version++; });
  els.bg.addEventListener('input',    () => { config.bgColor = hexToVec4(els.bg.value); config.version++; });
  els.flip.addEventListener('change', () => { config.mirror  = els.flip.checked;        config.version++; });
  els.cell.addEventListener('input',  () => {
    config.cellSize = parseInt(els.cell.value);
    els.cellVal.textContent = els.cell.value + 'px';
    config.version++;
  });
  els.scale.addEventListener('input', () => {
    config.pixelScale = parseInt(els.scale.value) / 100;
    config.version++;
    onScaleChange();
  });
}

// オペレーション画面からの設定変更。既存の DOM コントロールに値を入れて
// 合成イベントを発火することで、ローカル操作とまったく同じコード経路を通す。
export function applyRemoteSet(key, value) {
  const fire = (el, type) => el.dispatchEvent(new Event(type));
  switch (key) {
    case 'pid':     els.pid.value = String(value); break;
    case 'camera':  els.camera.value  = String(value); fire(els.camera,  'change'); break;
    case 'quality': els.quality.value = String(value); fire(els.quality, 'change'); break;
    case 'mirror':  els.flip.checked  = !!value;        fire(els.flip,   'change'); break;
    case 'scale':   els.scale.value   = String(value);  fire(els.scale,  'input');  break;
    case 'cell':    els.cell.value    = String(value);  fire(els.cell,   'input');  break;
    case 'fg':      els.fg.value      = String(value);  fire(els.fg,     'input');  break;
    case 'bg':      els.bg.value      = String(value);  fire(els.bg,     'input');  break;
  }
}

export function bindSession({ onNext, onAbort, onExportTrials, onExportEvents }) {
  els.next.addEventListener('click', onNext);
  els.abort.addEventListener('click', onAbort);
  els.exportTrials.addEventListener('click', onExportTrials);
  els.exportEvents.addEventListener('click', onExportEvents);
}

// 試行中に見え方や操作の対応づけが変わると剰余変数になる。
// cellSize/pixelScale は被験者の見え方を、mirror は操作の左右対応を変えてしまう。
const LOCKED = ['pid', 'camera', 'quality', 'flip', 'scale', 'cell', 'fg', 'bg'];

export function lockControls(locked) {
  for (const k of LOCKED) els[k].disabled = locked;
  els.abort.disabled = !locked;
  els.next.disabled  = locked;
}

// 試行中はツールバーを隠す(被験者の視界から実験者用UIを外す)。
// オペレーション画面接続中は ⚙ も含めて完全に非表示にする(被験者用モニターを
// 影とゲームだけにする)。切断されたら ⚙ が復帰し、ローカル操作に戻れる。
let toolbarVisible = true;
let operatorMode   = false;

function applyUiVisibility() {
  els.toolbar.hidden = operatorMode || !toolbarVisible;
  els.uiShow.hidden  = operatorMode || toolbarVisible;
  // ?display=1 のとき index.html の冒頭スクリプトが同じクラスを先に付けている
  // (CDN 読み込み中のチラ見え防止)。ここで状態と同期させ、切断時に外す。
  document.documentElement.classList.toggle('display-mode', operatorMode);
}

export function setToolbarVisible(visible) {
  toolbarVisible = visible;
  applyUiVisibility();
}

export function setOperatorMode(on) {
  operatorMode = on;
  applyUiVisibility();
}

export function updateSessionUi(session) {
  els.next.textContent     = session.nextLabel;
  els.progress.textContent = session.progress;
}

export const setStatus     = (text) => { els.status.textContent = text; };
export const setRenderSize = (w, h) => { els.scaleVal.textContent = `${w}×${h}px`; };

// 影が体に追いつくかは推論fps で決まる(描画fps ではない)。
//   renderFps … 描画回数。マスクが古くても同じ影を描き直すので常に 60 出る。追従性の指標ではない。
//   inferFps  … 影が実際に更新された回数。こちらが追従性を決める。
export const setFps = (renderFps, inferFps, inferMs, maskMs) => {
  els.fps.textContent =
    `${renderFps} fps / 推論 ${inferFps} (推論 ${inferMs.toFixed(0)}ms・マスク ${maskMs.toFixed(1)}ms)`;
};

// backend が cpu だと推論が桁違いに遅くなる。実験前に必ず気づけるよう目立たせる。
export function setBackendBanner(backend) {
  const ok = backend === 'webgl';
  if (ok) {
    els.status.textContent = '準備完了';
    els.status.className = '';
  } else {
    els.status.textContent = `⚠ TF backend が "${backend}" — 推論が遅すぎて実験に使えません`;
    els.status.className = 'banner-error';
  }
}
