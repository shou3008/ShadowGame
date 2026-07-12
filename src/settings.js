// 実験装置の調整値をここに集約する。
// このアプリは「重力加速度を独立変数とする官能評価実験」の測定器であり、遊びのデモではない。
// したがって、ここに置いてよいのは
//   (a) 独立変数そのもの (GRAVITY_LEVELS)
//   (b) 全条件で固定される定数 (PHYSICS / FIELD)
//   (c) 実験の進行に関わる値 (EXPERIMENT)
// だけ。「手触りを良くするために重力ごとに変える値」を足してはいけない。独立変数が汚れる。

export const APP_VERSION = 'lifting-1.0';

// ===== 独立変数: ボールの重力加速度 (world px/s^2) =====
// 対数ほぼ等間隔 (比 1.71 / 1.75 / 1.71 / 1.67)。心理物理のべき関数フィットに向く。
export const BASELINE_GRAVITY = 2100;
export const GRAVITY_LEVELS = [
  { id: 'g1', gravity:  700 },   // 0.33x
  { id: 'g2', gravity: 1200 },   // 0.57x
  { id: 'g3', gravity: 2100 },   // 1.00x  基準
  { id: 'g4', gravity: 3600 },   // 1.71x
  { id: 'g5', gravity: 6000 },   // 2.86x
];

// ===== 実験の進行 =====
export const EXPERIMENT = {
  trialMs:    60000,   // 1試行の固定時間。条件間で曝露時間を等しくするため固定
  practiceMs: 45000,
  blocks:     1,       // 各水準の提示回数。2 にすると全10試行
  countdownMs:     3000,
  respawnDelayMs:  800,
  // 復活待ちの間も時計が進むと、ミスの多い高重力条件だけ実プレイ時間が短くなり、
  // 独立変数と結合した交絡になる。止めれば全条件で実プレイ 60 秒が揃う。
  pauseClockOnRespawn: true,
  pxPerMetre: 470,     // CSV の m/s^2 換算にのみ使う参考値。実測しないと意味を持たない
};

// ===== 仮想ワールド (物理はすべてこの座標系。カメラと同じ 16:9) =====
export const WORLD_W = 1920;
export const WORLD_H = 1080;
export const BALL_R  = 60;
export const FLOOR_Y = WORLD_H - 40;                  // ここに触れたらミス
export const SPAWN   = { x: WORLD_W / 2, y: BALL_R + 30 };

// ===== 物理 =====
export const PHYSICS = {
  // 可変サブステップ(速度依存)を廃し、固定タイムステップにする。
  // 旧実装はステップ数が速度に依存し、高重力ほど空気抵抗が強くかかる交絡があった。
  fixedDt:    1 / 300,
  maxFrameDt: 0.05,        // 1フレームで進める上限 → 最大 15 step

  // ★完全弾性。全条件で固定であり、下げてはいけない。
  //   影を静止壁として扱う以上ボールにエネルギーを与える経路が無く、e<1 だと
  //   h_{n+1} = e^2*h_n + y_w*(1-e^2) → h → y_w に収束し、ボールは体の上で死ぬ。
  //   これは技量では止められないため、従属変数が物理定数で決まってしまう。
  restitution: 1.0,

  // ★空気抵抗オフ。完全弾性と両立しない(抵抗があればエネルギーが減り結局ボールが死ぬ)。
  //   また線形抵抗は終端速度 g/λ を生み、構造的に重力と相互作用する。
  //   1 以外にする場合も pow(airPerSec, h) の不変形で掛けること(ステップ数に依存させない)。
  airPerSec: 1.0,

  // 安全網。通常は発火しない。発火したらその試行は疑う(clamp_hits を CSV に出す)。
  //   固定ステップ h=1/300 と合わせて 1 ステップ最大 20px < 24px(すり抜け境界)を保証する。
  //   全5水準の自由落下最高速は 1159/1518/2008/2629/3394 px/s でここには届かない。
  maxSpeed: 6000,

  // 占有率 O の等値面。ボールはこの面で跳ね返る。
  //   O は「ボールの円板が影に埋まっている割合」なので、θ を上げるほど
  //   ボールは深くめり込んでから跳ねる:  沈み込み = 2*BALL_R*θ  [px]
  //   一方、下げるほど細い部位まで当たるようになる: 最小反応幅 = 2R(1 - sqrt(1-θ))
  //     θ=0.40 → 沈み込み 48px / 最小幅 27px   (めり込みが目立つ)
  //     θ=0.25 → 沈み込み 30px / 最小幅 16px   ← 採用(≒3.4cm。指は拾わない)
  //     θ=0.10 → 沈み込み 12px / 最小幅  6px   (指まで拾いノイズになる)
  shadowThresh: 0.25,

  // ∇O の中心差分の刻み(world px)。1セル分。
  gradStep: 30,
  // ‖∇O‖ の下限。影の内部深くでは勾配が消えるので、その場合は真上へ逃がす。
  // O は幅 2*BALL_R=120px で 0→1 に遷移するので、典型値は 1/120 ≒ 0.0083。
  gradMin: 1 / 480,

  // 侵入深さに比例した位置補正。旧実装の「固定 27px 押し出し」は制御されていない
  // エネルギー源で、影の反発の見かけが重力の関数になっていた(交絡)。
  posCorrect: 0.60,
  maxPush:    BALL_R,     // 1ステップの補正量の上限(px)

  // 推論が 10fps 程度しか出ないため、衝突体を dO/dt で外挿して 60fps 相当に滑らかにする。
  extrapolate:    true,
  extrapMaxSec:   0.12,   // 推論が止まったときに外挿が暴走しないための上限
  latencyCompMs:  60,     // 推論そのものの所要時間を見越した先読み量

  // 体にボールを乗せて静止させると無限ラリーになり従属変数が壊れる。
  // ただし誤発火の恐れがあるので、パイロット中は記録のみ(下の enforceCarry で切り替え)。
  maxCarryMs:   800,
  enforceCarry: false,
};

// ===== 占有率フィールド =====
// ボールの円板が影にどれだけ埋まっているかを表す連続場 O(x,y,t)。
// これに対して当てることで「なめらかな法線」「本物の侵入深さ」「時間外挿」が同時に手に入る。
export const FIELD = {
  gridW: 64, gridH: 36,   // 16:9。640x360 なら 1セル=10x10 マスク画素(整数分割)
  // 3-tap ボックスぼかし x2 = テント核。支持は ±2セル = ±60 world px = ちょうどボール半径。
  // これにより O は「影をボール半径ぶん膨張させた場」に近くなり、
  // ボールの見えている縁が影の縁に触れる。
  blurPasses: 2,
};

// ===== マスクの時間平滑化 (対称 EMA) =====
// 非対称にすると「進む影」と「退く影」で dO/dt に方向バイアスが乗り、
// 跳ね返りが左右非対称になる。実験装置なので対称にする。
// 空間側(FIELD のぼかし: 1セル=100マスク画素)がノイズを吸収するので、時間平滑は弱くてよい。
export const ALPHA_RISE = 0.9;
export const ALPHA_FALL = 0.9;

// ===== カメラ =====
// BodyPix は「カメラ解像度 × internalResolution」を推論の入力サイズにするため、
// ここを下げると推論が面積比で軽くなる。当たり判定は 64x36 の粗いグリッドに落とすので
// 640x360 でも十分。
export const CAMERA_SIZE = { width: 640, height: 360 };

// ===== BodyPix =====
// 影が体に追いつくかは、ほぼこのプリセット(モデルの重さ)だけで決まる。
// マスクは推論が終わったときにしか更新されない。ステータス欄の「推論 N」がその回数。
export const QUALITY_PRESETS = {
  ultrafast: {
    label: '最速',
    model: { architecture: 'MobileNetV1', outputStride: 16, multiplier: 0.50, quantBytes: 2 },
    internalResolution: 0.35,
  },
  fast: {
    label: '速度優先',
    model: { architecture: 'MobileNetV1', outputStride: 16, multiplier: 0.75, quantBytes: 2 },
    internalResolution: 'low',
  },
  balanced: {
    label: 'バランス',
    model: { architecture: 'MobileNetV1', outputStride: 16, multiplier: 1.0, quantBytes: 2 },
    internalResolution: 'medium',
  },
  accurate: {
    label: '精度優先',
    model: { architecture: 'ResNet50', outputStride: 16, multiplier: 1.0, quantBytes: 2 },
    internalResolution: 'medium',
  },
};

export const DEFAULT_QUALITY = 'fast';

// internalResolution は品質プリセット側から与えるので、ここには持たせない。
export const INFERENCE_CONFIG = {
  flipHorizontal:        false,
  // 下げるほど影が太り、白い服なども欠けにくくなる。背景ノイズは FIELD のぼかしと
  // shadowThresh がある程度吸収する。
  segmentationThreshold: 0.3,
};
