// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2024, Tiny Tapeout LTD
// Author: Renaldas Zioma, Uri Shaked

export class AudioPlayer {
  private audioCtx : AudioContext;
  private resamplerNode : AudioWorkletNode;

  constructor(private readonly sampleRate: number, private readonly fps: number, stateListener = null, private readonly bufferSize: number = 200) {
    this.audioCtx = new AudioContext({sampleRate:sampleRate, latencyHint:'interactive'});
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
    this.latencyInMilliseconds = event.data / this.sampleRate * 1000.0;
    this.latencyInMilliseconds += this.audioCtx.outputLatency * 1000.0;
  }

  private writeIndex = 0;
  readonly buffer = new Float32Array(this.bufferSize); // larger buffer reduces the communication overhead with the worker thread
                                                       // however, if buffer is too large it could lead to worker thread starving
  feed(value: number, current_fps: number) {
    if (this.writeIndex >= this.bufferSize) {
      if (this.resamplerNode != null)
      {
        this.resamplerNode.port.postMessage({
          type: 'samples',
          samples: this.buffer,
          fps: current_fps,
        });
        if (this.resumeScheduled == 1)
          this.audioCtx.resume();
        this.resumeScheduled--;
      }
      this.writeIndex = 0;
    }
    
    this.buffer[this.writeIndex] = value;
    this.writeIndex++;
  }

  private resumeScheduled = 0;
  resume() {
    this.resumeScheduled = 50;  // pre-feed buffers before resuming playback
                                // to avoid starving playback
    if (this.resamplerNode != null)
    {
      this.resamplerNode.port.postMessage({
        type: 'reset'
      });
    }
  }

  suspend() {
    this.resumeScheduled = 0;
    this.audioCtx.suspend();
    if (this.resamplerNode != null)
    {
      this.resamplerNode.port.postMessage({
        type: 'reset'
      });
    }
  }

  isRunning() {
    return (this.audioCtx.state === "running");
  }
  needsFeeding() {
    return this.isRunning() | this.resumeScheduled > 0;
  }

}

