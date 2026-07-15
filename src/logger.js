// 客観ログの収集と CSV 出力。
// 主観評価(官能評価)は紙 / Google Form で別途取るので、ここでは扱わない。
//
// 設計方針:
//   - 試行が終わるたびに localStorage へ退避する。ブラウザを閉じてもデータを失わない。
//   - 物理定数を全行に重複させる。パイロット中に定数を調整するので、CSV が自己記述的でないと
//     「どの設定で取ったデータか」を後から復元できなくなる。

const STORAGE_KEY = 'shadowgame.log';

const esc = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

function toCsv(rows) {
  if (rows.length === 0) return '';
  // 全行のキーの和集合を列にする(行ごとに欠けた列があっても崩れない)
  const cols = [];
  const seen = new Set();
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) { seen.add(k); cols.push(k); }
    }
  }
  const head = cols.join(',');
  const body = rows.map(r => cols.map(c => esc(r[c])).join(','));
  return [head, ...body].join('\r\n');
}

export function download(filename, text) {
  // BOM を付けないと Excel が UTF-8 と認識せず日本語ヘッダが化ける
  const blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

export class Logger {
  #trials = [];
  #events = [];
  #session = {};     // 全行に付ける共通列
  #trial   = null;   // 現在の試行の共通列
  #exported = true;

  beginSession(meta) {
    this.#session = meta;
    this.#trials = [];
    this.#events = [];
    this.#exported = true;
    this.#restore();
  }

  // 試行開始。meta には trial_index / level_id / gravity_px_s2 などが入る。
  beginTrial(meta) {
    this.#trial = meta;
  }

  // LiftingGame からのイベント。試行中でなければ捨てる。
  event(type, data) {
    if (!this.#trial) return;
    this.#events.push({
      participant_id: this.#session.participant_id,
      trial_index:    this.#trial.trial_index,
      is_practice:    this.#trial.is_practice,
      level_id:       this.#trial.level_id,
      gravity_px_s2:  this.#trial.gravity_px_s2,
      event_type:     type,
      ...data,
    });
  }

  // 試行終了。stats(LiftingGame) と env(推論fps 等) をまとめて 1 行にする。
  endTrial(stats, env) {
    if (!this.#trial) return;
    const row = { ...this.#session, ...this.#trial, ...stats, ...env };
    this.#trials.push(row);
    this.#trial = null;
    this.#exported = false;
    this.#persist();
    return row;
  }

  abortTrial() { this.#trial = null; }

  get trialCount()      { return this.#trials.length; }
  get hasUnexported()   { return !this.#exported && this.#trials.length > 0; }

  // CSV の生成とダウンロードを分離してある。オペレーション画面(別ウィンドウ)から
  // 書き出すときは csv* でテキストだけ作って送り、向こう側でダウンロードする
  // (被験者用モニターにダウンロード UI を出さないため)。
  csvTrials() {
    if (this.#trials.length === 0) return null;
    this.#exported = true;
    return {
      filename: `trials_${this.#session.participant_id || 'NA'}_${stamp()}.csv`,
      text: toCsv(this.#trials),
    };
  }

  csvEvents() {
    if (this.#events.length === 0) return null;
    return {
      filename: `events_${this.#session.participant_id || 'NA'}_${stamp()}.csv`,
      text: toCsv(this.#events),
    };
  }

  exportTrials() {
    const csv = this.csvTrials();
    if (!csv) return false;
    download(csv.filename, csv.text);
    return true;
  }

  exportEvents() {
    const csv = this.csvEvents();
    if (!csv) return false;
    download(csv.filename, csv.text);
    return true;
  }

  // --- localStorage への退避 ---
  #key() { return `${STORAGE_KEY}.${this.#session.participant_id || 'NA'}`; }

  #persist() {
    try {
      localStorage.setItem(this.#key(), JSON.stringify({
        trials: this.#trials,
        events: this.#events,
      }));
    } catch (err) {
      console.warn('ログの退避に失敗(容量超過の可能性):', err);
    }
  }

  // 同じ参加者IDで再開したら、前回までの試行を拾い直す
  #restore() {
    try {
      const raw = localStorage.getItem(this.#key());
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved.trials?.length) {
        this.#trials = saved.trials;
        this.#events = saved.events || [];
        this.#exported = false;
        console.warn(`前回の記録を復元しました: ${this.#trials.length} 試行`);
      }
    } catch (err) {
      console.warn('ログの復元に失敗:', err);
    }
  }
}
