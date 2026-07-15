// オペレーション画面(実験者用モニター)。DOM だけの軽量ページで、
// プレイ画面(index.html)へ BroadcastChannel 経由でコマンドを送り、
// 状態スナップショットを受けて表示する。カメラ・推論・物理はすべてプレイ側にある。
//
// ★盲検: プレイ側は重力に関する値をチャンネルに載せない。この画面にも表示しない。

import { CHANNEL_NAME } from './remote.js';
import { download }     from './logger.js';

const $ = (id) => document.getElementById(id);

const els = {
  conn:     $('op-conn'),
  openPlay: $('op-open-play'),
  pid:      $('op-pid'),
  gmode:    $('op-gmode'),
  next:     $('op-next'),
  abort:    $('op-abort'),
  progress: $('op-progress'),
  status:   $('op-status'),
  fps:      $('op-fps'),
  trials:   $('op-trials'),
  camera:   $('op-camera'),
  quality:  $('op-quality'),
  flip:     $('op-flip'),
  scale:    $('op-scale'),
  scaleVal: $('op-scale-val'),
  cell:     $('op-cell'),
  cellVal:  $('op-cell-val'),
  fg:       $('op-fg'),
  bg:       $('op-bg'),
  exportTrials: $('op-export-trials'),
  exportEvents: $('op-export-events'),
  unexported:   $('op-unexported'),
};

const ch = new BroadcastChannel(CHANNEL_NAME);
const send = (msg) => ch.postMessage(msg);
const cmd  = (c) => send({ type: 'cmd', cmd: c });
const set  = (key, value) => send({ type: 'set', key, value });

// ---- 送信側の配線 ----
// プレイ画面を表示専用モード(?display=1 = 操作UIを最初から出さない)で開く。
// 既に開いていれば同じ名前のウィンドウが前面に来るだけで、二重には開かない。
els.openPlay.addEventListener('click', () => {
  window.open('index.html?display=1', 'shadowgame-play');
});

els.next.addEventListener('click',  () => cmd('next'));
els.abort.addEventListener('click', () => cmd('abort'));
els.exportTrials.addEventListener('click', () => cmd('exportTrials'));
els.exportEvents.addEventListener('click', () => cmd('exportEvents'));

els.pid.addEventListener('input',      () => set('pid', els.pid.value));
els.gmode.addEventListener('change',   () => set('gmode', els.gmode.value));
els.camera.addEventListener('change',  () => set('camera', els.camera.value));
els.quality.addEventListener('change', () => set('quality', els.quality.value));
els.flip.addEventListener('change',    () => set('mirror', els.flip.checked));
els.scale.addEventListener('input',    () => set('scale', els.scale.value));
els.cell.addEventListener('input',     () => set('cell', els.cell.value));
els.fg.addEventListener('input',       () => set('fg', els.fg.value));
els.bg.addEventListener('input',       () => set('bg', els.bg.value));

// ---- 受信側 ----
let lastStateAt = 0;

ch.onmessage = (e) => {
  const msg = e.data;
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'state') {
    lastStateAt = performance.now();
    render(msg.state);
  } else if (msg.type === 'csv') {
    download(msg.filename, msg.text);
  } else if (msg.type === 'csv-empty') {
    alert('まだ記録がありません');
  }
};

// プログラムから value を代入してもイベントは発火しないので、echo ループは起きない。
// ユーザーが触っている最中のコントロールだけは上書きしない。
const busy = (el) => document.activeElement === el;

function render(s) {
  els.conn.textContent = 'プレイ画面: 接続中';
  els.conn.className   = 'op-conn op-conn-up';

  if (!busy(els.pid)) els.pid.value = s.pid ?? '';

  // 重力モード(自動 + 水準の倍率一覧)。選択肢はプレイ側の設定から届く
  const opts = s.gmodeOptions || [];
  if (els.gmode.options.length !== opts.length + 1) {
    els.gmode.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = 'auto';
    auto.textContent = '自動(ランダム順・盲検)';
    els.gmode.appendChild(auto);
    for (const o of opts) {
      const opt = document.createElement('option');
      opt.value = o.id;
      opt.textContent = `手動: ${o.label}`;
      els.gmode.appendChild(opt);
    }
  }
  if (!busy(els.gmode)) els.gmode.value = s.gmode ?? 'auto';

  const manualSelected = (s.gmode ?? 'auto') !== 'auto';
  els.next.textContent = manualSelected
    ? (s.state === 'idle' ? '手動試行を開始(セッション開始)' : '手動試行を開始')
    : (s.nextLabel ?? '開始');
  els.progress.textContent = s.progress ?? '— / —';
  els.status.textContent   = s.status ?? '—';
  els.status.className     = s.statusError ? 'banner-error' : '';
  els.fps.textContent      = s.fps ?? '—';
  els.trials.textContent   = String(s.trialCount ?? 0);
  els.unexported.hidden    = !s.hasUnexported;

  // カメラ一覧(数か選択が変わったときだけ組み直す)
  const cams = s.cameras || [];
  const needRebuild =
    els.camera.options.length !== cams.length ||
    cams.some((c, i) => els.camera.options[i].value !== c.id);
  if (needRebuild) {
    els.camera.innerHTML = '';
    for (const c of cams) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.label;
      els.camera.appendChild(opt);
    }
  }
  if (!busy(els.camera) && s.cameraId) els.camera.value = s.cameraId;

  if (!busy(els.quality) && s.quality) els.quality.value = s.quality;
  els.flip.checked = !!s.mirror;
  if (!busy(els.scale)) els.scale.value = s.scale ?? 100;
  els.scaleVal.textContent = s.scaleVal ?? '--';
  if (!busy(els.cell)) els.cell.value = s.cell ?? 18;
  els.cellVal.textContent = (s.cell ?? 18) + 'px';
  if (!busy(els.fg)) els.fg.value = s.fg ?? '#000000';
  if (!busy(els.bg)) els.bg.value = s.bg ?? '#ffffff';

  // 試行中ロック(プレイ側の lockControls と同じ方針)
  const locked = !!s.running;
  for (const el of [els.pid, els.gmode, els.camera, els.quality, els.flip, els.scale, els.cell, els.fg, els.bg]) {
    el.disabled = locked;
  }
  els.next.disabled  = locked;
  els.abort.disabled = !locked;
}

function showDisconnected() {
  els.conn.textContent = 'プレイ画面: 未接続(プレイ画面のタブが開いているか確認してください)';
  els.conn.className   = 'op-conn op-conn-down';
}

// ---- 接続維持 ----
send({ type: 'hello' });
setInterval(() => {
  send({ type: 'op-alive' });
  if (performance.now() - lastStateAt > 3000) showDisconnected();
}, 1000);

window.addEventListener('pagehide', () => send({ type: 'op-bye' }));
