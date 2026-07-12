// 影の抽出・描画にかかわる調整値をここに集約する。
// 認識精度や見た目を詰めたいときは、まずこのファイルだけを見れば済む状態を保つ。

// --- 時間平滑化 (非対称 EMA) ---
// 各画素の「人である度合い」を 0..1 の連続値として平滑化し、二値化せずに描画へ渡す。
// こうすると動いていない画素は値がほぼ一定になってちらつかず、動いた画素だけが滑らかに追従する。
//   RISE … 0→1(出現)方向の追従速度。速いほど動かした手先がすぐ埋まり、操作感が良くなる。
//   FALL … 1→0(消失)方向の追従速度。速いほど残像が残らない。
//          「人がいなくなった画素」にしか効かないので、毎フレーム検出され続ける肩などは
//          速くしても消えない。肩や輪郭が欠けるのは平滑化ではなくセグメンテーション品質の
//          問題なので、INFERENCE_CONFIG.segmentationThreshold 側で対処する。
export const ALPHA_RISE = 0.75;
export const ALPHA_FALL = 0.85;

// 16:9 ワイド(仮想ワールド 1920×1080 と同じアスペクト)で取得する
export const CAMERA_SIZE = { width: 1280, height: 720 };

// BodyPix モデル本体の設定。ResNet50 は精度が高いが重い。
// 動作が重すぎるときは architecture:'MobileNetV1' + multiplier:0.75 まで落とせる。
export const MODEL_CONFIG = {
  architecture: 'ResNet50',
  outputStride: 16,
  multiplier:   1.0,
  quantBytes:   2,
};

// 通常モード(capture / realtime)の推論設定
export const INFERENCE_CONFIG = {
  flipHorizontal:        false,
  // 描画はモザイク(粗いセル)に量子化されるので、マスクが高解像度でも見た目はほぼ変わらない。
  // 'medium' に落として推論を軽くし、描画レート(=なめらかさ)を稼ぐ。
  internalResolution:    'medium',
  // 白い服など「背景との差が小さく確信度が下がる」画素も拾えるよう低めにする。
  // 下げるほど欠けにくくなるが、背景ノイズも混ざりやすい(0.2〜0.3 が目安)。
  segmentationThreshold: 0.2,
};

// 「手の重なり物理」モード用。手首キーポイントしか使わないので、
// セグメンテーション精度より「多人数の姿勢を確実に取ること」を優先する。
export const HANDS_CONFIG = {
  flipHorizontal:        false,
  internalResolution:    'medium',
  segmentationThreshold: 0.5,
  maxDetections:         4,     // 最大4人まで姿勢検出(上位2人を A/B に使う)
  // ソファ・クッション等を人と誤検出するのを抑える。本物の人まで落ちるなら 0.5 程度まで下げる。
  // 手首の個別スコアは hands-game.js 側でも同じ値で再フィルタしている(二段構え)。
  scoreThreshold:        0.70,
  nmsRadius:             20,
};
