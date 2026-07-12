// 仮想カメラ(OBS / Iriun 等)は本体アプリが起動していないと開けず NotReadableError になる。
// ブラウザの既定デバイスに選ばれると起動そのものが失敗するため、実カメラより後に回す。
const VIRTUAL_CAMERA_RE = /obs|iriun|virtual|droidcam|epoccam|manycam|xsplit|nvidia|snap camera/i;

export class Camera {
  #video;
  #stream = null;

  constructor(videoEl) {
    this.#video = videoEl;
  }

  // 開けるカメラが見つかるまで順に試す。
  //   preferredId(前回使ったカメラ) → 実カメラ → 仮想カメラ の順。
  // 既定カメラ任せ(facingMode のみ)だと仮想カメラを掴んで失敗しうるので、常に deviceId で指定する。
  async startAuto({ width = 640, height = 480, preferredId = null } = {}) {
    const failures = [];
    const attempt = async (deviceId, name) => {
      try {
        await this.start({ width, height, deviceId });
        return true;
      } catch (err) {
        failures.push(`${name}(${err.name})`);
        return false;
      }
    };

    if (preferredId && await attempt(preferredId, '前回のカメラ')) return;

    let cams = await this.listCameras();
    // 権限未取得だと deviceId が空文字になり指定できない。一度取得して権限を得てから列挙し直す。
    if (cams.length > 0 && !cams[0].deviceId) {
      if (await attempt(null, '既定のカメラ')) return;
      cams = await this.listCameras();
    }

    const ordered = [
      ...cams.filter(c => !VIRTUAL_CAMERA_RE.test(c.label)),
      ...cams.filter(c =>  VIRTUAL_CAMERA_RE.test(c.label)),
    ];
    for (const cam of ordered) {
      if (await attempt(cam.deviceId, cam.label || 'カメラ')) return;
    }

    throw new Error(
      cams.length === 0
        ? 'カメラが見つかりませんでした'
        : `どのカメラも起動できませんでした: ${failures.join(' / ')}`
    );
  }

  async listCameras() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === 'videoinput');
  }

  // deviceId 指定時はそのカメラを、未指定時はフロントカメラを使用
  async start({ width = 640, height = 480, deviceId = null, timeoutMs = 5000 } = {}) {
    this.stop();
    const video = deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: width }, height: { ideal: height } }
      : { facingMode: 'user',            width: { ideal: width }, height: { ideal: height } };
    const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    this.#stream = stream;
    this.#video.srcObject = stream;
    try {
      await this.#waitMetadata(timeoutMs);
      await this.#video.play();
    } catch (err) {
      this.stop(); // 掴んだまま放置すると他のカメラも開けなくなるので解放する
      throw err;
    }
  }

  // getUserMedia が成功しても映像が一生来ないカメラがある(仮想カメラ等)。
  // 上限を設けて、永久待ちせず次の候補へ進めるようにする。
  #waitMetadata(timeoutMs) {
    if (this.#video.readyState >= 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#video.onloadedmetadata = null;
        const err = new Error('映像が届きませんでした');
        err.name = 'TimeoutError';
        reject(err);
      }, timeoutMs);
      this.#video.onloadedmetadata = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  stop() {
    if (this.#stream) {
      this.#stream.getTracks().forEach(t => t.stop());
      this.#stream = null;
    }
  }

  get element()  { return this.#video; }
  get width()    { return this.#video.videoWidth; }
  get height()   { return this.#video.videoHeight; }
  get ready()    { return this.#video.readyState >= 2; }
  get deviceId() {
    const track = this.#stream && this.#stream.getVideoTracks()[0];
    return track ? track.getSettings().deviceId : null;
  }
}
