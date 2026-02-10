import { AudioPlayer } from './AudioPlayer';

export class AudioEngine {
  private readonly player: AudioPlayer;

  private readonly ticksPerSample: number;
  private readonly lowPassFilterSize: number;
  private readonly getAudioSignal: () => number;
  private readonly getFPS: () => number;

  private enableUpdate: boolean;
  private tickCounter = 0;
  private sample = 0;
  private sampleQueue: Float32Array;
  private sampleQueueIndex = 0;

  constructor(
    sampleRate: number,
    vgaClockRate: number,
    getAudioSignal: () => number,
    getFPS: () => number,
    onStateChange: () => void,
  ) {
    this.player = new AudioPlayer(sampleRate, onStateChange);
    this.getAudioSignal = getAudioSignal;
    this.getFPS = getFPS;
    this.enableUpdate = this.player.needsFeeding();

    this.ticksPerSample = vgaClockRate / sampleRate;

    const lowPassFrequency = 20_000; // 20 kHz -- Audio PMOD low pass filter
    this.lowPassFilterSize = Math.ceil(sampleRate / lowPassFrequency);
    this.sampleQueue = new Float32Array(this.lowPassFilterSize);
  }

  update() {
    if (!this.enableUpdate) return;

    this.sample += this.getAudioSignal();
    if (++this.tickCounter < this.ticksPerSample) return;

    const newSample = this.sample / this.ticksPerSample;

    this.sampleQueue[this.sampleQueueIndex++] = newSample;
    this.sampleQueueIndex %= this.lowPassFilterSize;
    let filteredSample = this.sampleQueue[0];
    for (let i = 1; i < this.lowPassFilterSize; i++) filteredSample += this.sampleQueue[i];

    this.player.feed(filteredSample / this.lowPassFilterSize, this.getFPS());
    this.tickCounter = 0;
    this.sample = 0;
  }

  get needsFeeding() {
    return this.player.needsFeeding();
  }

  set enablePerTickUpdate(v: boolean) {
    this.enableUpdate = v;
  }

  get latencyMs() {
    return this.player.latencyInMilliseconds;
  }

  isRunning() {
    return this.player.isRunning();
  }

  resume() {
    this.player.resume();
  }

  suspend() {
    this.player.suspend();
  }
}
