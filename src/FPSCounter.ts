export class FPSCounter {
  private samples = new Array<number>(60).fill(0);
  private index = 0;
  private lastTime = -1;
  private pauseTime = -1;
  readonly fps = 0;

  constructor() {}

  reset() {
    this.samples.fill(0);
    this.index = 0;
    this.lastTime = -1;
    this.pauseTime = -1;
  }

  update(time: number) {
    if (this.lastTime >= 0) {
      this.samples[this.index++ % this.samples.length] = time - this.lastTime;
    }
    this.lastTime = time;

    if (this.index > 0) {
      const slice = this.samples.slice(0, this.index);
      const avgDelta = slice.reduce((a, b) => a + b, 0) / slice.length;
      this.fps = 1000 / avgDelta;
    }
  }

  pause(time: number) {
    if (this.pauseTime === -1) {
      this.pauseTime = time;
    }
  }

  resume(time: number) {
    if (this.pauseTime !== -1) {
      this.lastTime += time - this.pauseTime;
      this.pauseTime = -1;
    }
  }

  getFPS() {
    return this.fps;
  }
}
