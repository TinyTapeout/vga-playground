// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2024, Tiny Tapeout LTD
// Author: Renaldas Zioma, Uri Shaked

export class AudioPlayer {
  private audioCtx : AudioContext;
  private resamplerNode : AudioWorkletNode;

  constructor(private readonly sampleRate: number, private readonly fps: number, private readonly bufferSize: number = 200) {
    this.audioCtx = new AudioContext({sampleRate:sampleRate, latencyHint:'interactive'});
    this.audioCtx.audioWorklet.addModule(new URL('/resampler.js', import.meta.url)).then(() => {

      this.resamplerNode = new AudioWorkletNode(this.audioCtx, 'resampler');
      this.resamplerNode.connect(this.audioCtx.destination);

      this.audioCtx.resume().then(() => {
        console.log('Audio playback started');
      });
    });
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
      }
      this.writeIndex = 0;
    }
    
    this.buffer[this.writeIndex] = value;
    this.writeIndex++;
  }

  resume() {
    this.audioCtx.resume();
    if (this.resamplerNode != null)
    {
      this.resamplerNode.port.postMessage({
        type: 'reset'
      });
    }
  }
}

