export class Camera {
  #video;
  #stream = null;

  constructor(videoEl) {
    this.#video = videoEl;
  }

  // deviceId 指定時はそのカメラを、未指定時はフロントカメラを使用
  async start({ width = 640, height = 480, deviceId = null } = {}) {
    this.stop();
    const video = deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: width }, height: { ideal: height } }
      : { facingMode: 'user',            width: { ideal: width }, height: { ideal: height } };
    const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    this.#stream = stream;
    this.#video.srcObject = stream;
    await new Promise(resolve => {
      this.#video.onloadedmetadata = resolve;
    });
    await this.#video.play();
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
