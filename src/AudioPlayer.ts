// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2024, Tiny Tapeout LTD
// Author: Renaldas Zioma, Uri Shaked

export class AudioPlayer {
  private audioCtx: AudioContext;
  private resamplerNode: AudioWorkletNode;

  private downsampleIntFactor = 1;
  private downsampleFracFactor = 1;

  constructor(
    private readonly sampleRate: number,
    stateListener: null | ((state: AudioContextState) => void) = null,
    private readonly bufferSize: number = 200,
  ) {
    this.audioCtx = new AudioContext({ sampleRate: sampleRate, latencyHint: 'interactive' });
    // Optional downsampling is used in case when audio context does not support 192 kHz
    //                for example when context playback rate is 44.1 kHz:
    this.downsampleFracFactor = sampleRate / this.audioCtx.sampleRate; // 4.35 = 192_000 / 44_100
    this.downsampleIntFactor = Math.floor(this.downsampleFracFactor); // 4
    this.downsampleFracFactor /= this.downsampleIntFactor; // 1.088 ~~ 48_000 / 44_100

    this.audioCtx.audioWorklet.addModule(new URL('/resampler.js', import.meta.url)).then(() => {
      this.resamplerNode = new AudioWorkletNode(this.audioCtx, 'resampler');
      this.resamplerNode.connect(this.audioCtx.destination);

      this.resamplerNode.port.onmessage = this.handleMessage.bind(this);

      this.audioCtx.resume().then(() => {
        console.log('Audio playback started');
      });
    });

    this.audioCtx.onstatechange = stateListener;
  }

  readonly latencyInMilliseconds = 0.0;
  handleMessage(event) {
    const getEffectiveLatency = (audioContext) => {
      return audioContext.outputLatency || audioContext.baseLatency || 0;
    };

    const samplesInBuffer = event.data[0];
    this.latencyInMilliseconds = (samplesInBuffer / this.sampleRate) * 1000.0;
    this.latencyInMilliseconds += getEffectiveLatency(this.audioCtx) * 1000.0;

    const bufferOccupancy = event.data[1];
    if (this.resumeScheduled && bufferOccupancy > 0.25) {
      // resume playback once resampler's
      // buffer is at least 25% full
      this.audioCtx.resume();
      this.resumeScheduled = false;
    }
  }

  private writeIndex = 0;
  readonly buffer = new Float32Array(this.bufferSize); // larger buffer reduces the communication overhead with the worker thread
  // however, if buffer is too large it could lead to worker thread starving
  feed(value: number, current_fps: number) {
    if (this.writeIndex >= this.bufferSize) {
      if (this.resamplerNode != null) {
        this.resamplerNode.port.postMessage({
          type: 'samples',
          samples: this.buffer,
          fps: current_fps * this.downsampleFracFactor,
          downsampleFactor: this.downsampleIntFactor,
        });
      }
      this.writeIndex = 0;
    }

    this.buffer[this.writeIndex] = value;
    this.writeIndex++;
  }

  private resumeScheduled = false;
  resume() {
    // Pre-feed buffers before resuming playback to avoid starving playback
    this.resumeScheduled = true;
    if (this.resamplerNode != null) {
      this.resamplerNode.port.postMessage({
        type: 'reset',
      });
    }
  }

  suspend() {
    this.resumeScheduled = false;
    this.audioCtx.suspend();
    if (this.resamplerNode != null) {
      this.resamplerNode.port.postMessage({
        type: 'reset',
      });
    }
  }

  isRunning() {
    return this.audioCtx.state === 'running';
  }
  needsFeeding() {
    return this.isRunning() || this.resumeScheduled;
  }
}
