import { WORLD_W, WORLD_H, PHYSICS } from './settings.js';

// ?debug=1 で有効。占有率フィールドを可視化する。
//
// これが無いと「なぜボールがそこへ飛んだのか」が一切分からず、
// shadowThresh / posCorrect の調整ができない。実験前の必須ツール。
//
// 見るべきもの:
//   - 赤い等値線(O = shadowThresh)が影の輪郭をボール半径ぶん外側でなぞっているか
//   - 手を振ったとき等値線が「滑らかに」動くか(100ms 刻みでカクつくなら外挿が効いていない)
//   - ボールの法線(黄色い矢印)が体の面に対して正しく立っているか
export const DEBUG_ON = new URLSearchParams(location.search).get('debug') === '1';

export function drawDebug(ctx, field, ball, tNow) {
  if (!field.ready) return;

  const gw = field.gridW, gh = field.gridH;
  const cw = WORLD_W / gw, ch = WORLD_H / gh;
  const grid = field.grid;
  const th = PHYSICS.shadowThresh;

  ctx.save();

  // 占有率をセルの濃さで表示。等値面を超えたセルは赤枠で囲む。
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const o = grid[y * gw + x];
      if (o < 0.02) continue;
      ctx.fillStyle = `rgba(80, 160, 255, ${Math.min(0.5, o * 0.5)})`;
      ctx.fillRect(x * cw, y * ch, cw + 1, ch + 1);
      if (o >= th) {
        ctx.strokeStyle = 'rgba(255, 60, 60, 0.9)';
        ctx.lineWidth = 2;
        ctx.strokeRect(x * cw, y * ch, cw, ch);
      }
    }
  }

  // ボール位置での法線
  const e = PHYSICS.gradStep;
  const xl = field.sample(ball.x - e, ball.y, tNow), xr = field.sample(ball.x + e, ball.y, tNow);
  const yu = field.sample(ball.x, ball.y - e, tNow), yd = field.sample(ball.x, ball.y + e, tNow);
  const gx = (xr - xl) / (2 * e), gy = (yd - yu) / (2 * e);
  const gm = Math.hypot(gx, gy);
  if (gm > PHYSICS.gradMin) {
    const nx = -gx / gm, ny = -gy / gm;
    ctx.beginPath();
    ctx.moveTo(ball.x, ball.y);
    ctx.lineTo(ball.x + nx * 160, ball.y + ny * 160);
    ctx.strokeStyle = '#ffd23f';
    ctx.lineWidth = 8;
    ctx.stroke();
  }

  // マスクの齢と外挿量。ここが 100ms 前後なら遅延が効いている。
  ctx.font = 'bold 34px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = '#0f0';
  const lines = [
    `mask age : ${field.age(tNow).toFixed(0)} ms`,
    `extrap τ : ${(field.tau(tNow) * 1000).toFixed(0)} ms`,
    `coverage : ${(field.coverage * 100).toFixed(1)} %`,
    `O at ball: ${field.sample(ball.x, ball.y, tNow).toFixed(3)}  (θ=${th})`,
  ];
  lines.forEach((s, i) => ctx.fillText(s, 40, WORLD_H - 120 + i * 38 - lines.length * 38 + 152));

  ctx.restore();
}
