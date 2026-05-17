export class Camera {
  #video;

  constructor(videoEl) {
    this.#video = videoEl;
  }

  async start({ width = 640, height = 480 } = {}) {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: width }, height: { ideal: height }, facingMode: 'user' },
      audio: false,
    });
    this.#video.srcObject = stream;
    await new Promise(resolve => {
      this.#video.onloadedmetadata = resolve;
    });
    await this.#video.play();
  }

  get element() { return this.#video; }
  get width()   { return this.#video.videoWidth; }
  get height()  { return this.#video.videoHeight; }
  get ready()   { return this.#video.readyState >= 2; }
}
