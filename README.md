# ShadowGame（シルエット影あそび）

Web カメラに映った人のシルエット（影）をリアルタイムに抽出し、その影を当たり判定に使って遊ぶブラウザゲームです。複数人が同時に映って一緒に遊べます。

- 人物抽出: [BodyPix](https://github.com/tensorflow/tfjs-models/tree/master/body-pix)（TensorFlow.js）
- 影の描画: WebGL2 によるグリッドモザイク
- ゲーム: 影をコリジョン（壁・坂）として、ボールをゴールへ運ぶ協力プレイ

---

## 必要環境

- WebGL2 と Web カメラに対応したモダンブラウザ（Chrome / Edge 推奨）
- カメラ利用のため **`https://` か `localhost`** で配信する必要があります（`file://` 直開きは不可）

依存ライブラリ（TensorFlow.js / BodyPix）は **CDN から読み込む**ため、`npm install` は不要です。

---

## 起動方法

任意の静的サーバで配信して `index.html` を開きます。

VS Code の **Live Server** 拡張を使う場合:

1. このフォルダを VS Code で開く
2. `index.html` を右クリック →「Open with Live Server」

コマンドラインで配信する場合の例:

```bash
# Python
python -m http.server 5500
# または Node
npx serve .
```

ブラウザで `http://localhost:5500/`（ポートは環境に合わせて）を開き、カメラ使用を許可してください。

---

## 遊び方

ツールバーの **スタート** で開始、**リセット** で STAGE 1 から再開します。
影（自分の体）でボールを動かし、緑の **GOAL** ゾーンへ運びます。全ステージクリアでタイム表示。

| ステージ | ルール |
| --- | --- |
| **STAGE 1** | 重力のみ。影を「坂」にしてボールを転がし運ぶ。画面下に落とすと **GAME OVER**。 |
| **STAGE 2** | 段差マップあり。影で下から突き上げて **ジャンプ**し、段を登って上のゴールへ。 |

GAME OVER 後に **スタート** を押すと、そのステージから再挑戦できます。

### ツールバーの設定

| 項目 | 説明 |
| --- | --- |
| カメラ | 使用するカメラを選択 |
| 左右反転 | 鏡のように左右反転（既定 ON） |
| 解像度 | 影マスクの描画解像度（下げると軽い／粗い） |
| 間隔 | モザイクのセルサイズ |
| 影 / 背景 | 前景（影）と背景の色 |

---

## ファイル構成

```
index.html      画面・ツールバー・CDN 読み込み
style.css       スタイル
src/
  camera.js     Web カメラの取得（getUserMedia ラッパ）
  app.js        メインループ（BodyPix 推論・マスク平滑化・全体の統括）
  renderer.js   WebGL2 でシルエットをモザイク描画
  game.js       ゲーム本体（ステージ・物理・当たり判定・描画）
```

### 処理の流れ

1. `app.js` が毎フレーム BodyPix で人物セグメンテーションを実行
2. 結果の人物マスクを EMA で時間平滑化（`smBody`）
3. `renderer.js` がマスクを WebGL でモザイク影として描画
4. `game.js` が同じマスクを当たり判定に使い、ボールの物理を更新してオーバーレイに描画

ゲームの物理は推論レートと切り離して 60fps で更新し、すり抜け防止のサブステップ積分を行っています。

---

## 調整ポイント

- **人物抽出の精度/速度**: `src/app.js` の `INFERENCE_CONFIG`
  （`internalResolution` を上げると細部に強いが重い／`segmentationThreshold` を下げると太る）
- **影の追従・残像**: `src/app.js` の `ALPHA_RISE` / `ALPHA_FALL`
- **ゲーム物理・ステージ**: `src/game.js` 冒頭の定数と `STAGES` 配列
  （重力 `gravity`、ジャンプ力 `shadowPush`、足場 `platforms`、ゴール `goal` など）

---

## コードスタイル

`.editorconfig` / `.gitattributes` で統一しています。

- 文字コード: UTF-8
- 改行: LF
- インデント: 半角スペース 2
- 末尾空白の除去・最終行の改行を有効化
