// オペレーション画面(operator.html)とのウィンドウ間通信(プレイ画面側)。
//
// 同一オリジンの BroadcastChannel を使う(このアプリは getUserMedia の制約上
// localhost 配信が前提なので、常に同一オリジン)。
//
// ★盲検の担保: このチャンネルに重力に関する値を載せてはいけない。
//   state に入れてよいのは Session が公開している文字列(progress 等)だけ。
//
// プロトコル:
//   オペ → プレイ: {type:'hello'} {type:'op-alive'} {type:'op-bye'}
//                  {type:'cmd', cmd:'next'|'abort'|'exportTrials'|'exportEvents'}
//                  {type:'set', key, value}
//   プレイ → オペ: {type:'state', state}            (受信応答 + 1秒毎ハートビート)
//                  {type:'csv', which, filename, text} (書き出し応答)
//                  {type:'csv-empty', which}

export const CHANNEL_NAME = 'shadowgame-ctrl';

// op-alive は 1 秒毎に来る。3 秒途絶えたら切断とみなす。
const ALIVE_TIMEOUT_MS = 3000;

export class RemoteBridge {
  #ch;
  #handlers;
  #lastAlive = 0;
  #connected = false;

  // handlers:
  //   onNext() / onAbort()          … セッション操作(ローカルのボタンと同じ関数)
  //   applySet(key, value)          … 設定変更(呼び出し側で試行中ガードをかける)
  //   getCsv(which)                 … 'trials'|'events' → {filename, text} | null
  //   getState()                    … オペ画面に表示する状態スナップショット
  //   onConnectChange(connected)    … 接続/切断時(ツールバーの完全非表示に使う)
  constructor(handlers) {
    this.#handlers = handlers;
    this.#ch = new BroadcastChannel(CHANNEL_NAME);
    this.#ch.onmessage = (e) => this.#handle(e.data);

    // ハートビート送信と切断検知。バックグラウンドタブでも 1Hz は動く。
    setInterval(() => {
      if (this.#connected && performance.now() - this.#lastAlive > ALIVE_TIMEOUT_MS) {
        this.#setConnected(false);
      }
      if (this.#connected) this.pushState();
    }, 1000);
  }

  get connected() { return this.#connected; }

  pushState() {
    this.#ch.postMessage({ type: 'state', state: this.#handlers.getState() });
  }

  #setConnected(on) {
    if (this.#connected === on) return;
    this.#connected = on;
    this.#handlers.onConnectChange(on);
  }

  #noteAlive() {
    this.#lastAlive = performance.now();
    this.#setConnected(true);
  }

  #handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'hello':
      case 'op-alive':
        this.#noteAlive();
        this.pushState();
        break;

      case 'op-bye':
        this.#setConnected(false);
        break;

      case 'cmd':
        this.#noteAlive();
        if (msg.cmd === 'next')  this.#handlers.onNext();
        if (msg.cmd === 'abort') this.#handlers.onAbort();
        if (msg.cmd === 'exportTrials')  this.#sendCsv('trials');
        if (msg.cmd === 'exportEvents')  this.#sendCsv('events');
        this.pushState();
        break;

      case 'set':
        this.#noteAlive();
        this.#handlers.applySet(msg.key, msg.value);
        this.pushState();
        break;
    }
  }

  #sendCsv(which) {
    const csv = this.#handlers.getCsv(which);
    if (!csv) { this.#ch.postMessage({ type: 'csv-empty', which }); return; }
    this.#ch.postMessage({ type: 'csv', which, filename: csv.filename, text: csv.text });
  }
}
