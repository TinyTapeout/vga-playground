// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2024, Tiny Tapeout LTD
// Author: Uri Shaked

const CHUNKS_PER_SECOND = 10;

export class AudioPlayer {
  private counter = 0;
  readonly audioCtx = new AudioContext();

  private readonly gainNode = this.audioCtx.createGain();
  private chunkBuffer = new AudioBuffer({
    length: this.audioCtx.sampleRate / CHUNKS_PER_SECOND,
    numberOfChannels: 1,
    sampleRate: this.audioCtx.sampleRate,
  });

  private chunk = this.chunkBuffer.getChannelData(0);
  private node: AudioBufferSourceNode | null = null;
  private prevValue = 0;
  private playedSamples = 0;
  private lastSample = 0;

  constructor(private readonly clockFrequency: number) {
    this.gainNode.connect(this.audioCtx.destination);
  }

  feed(value: number) {
    this.counter++;
    if (this.prevValue === value) {
      return;
    }

    const currentTime = this.counter / this.clockFrequency;
    const { sampleRate } = this.audioCtx;
    let currentSample = Math.floor(currentTime * sampleRate) - this.playedSamples;
    if (currentSample - this.lastSample > sampleRate / 20) {
      this.lastSample = currentSample;
      currentSample = 0;
    } else {
      this.lastSample = currentSample;
    }
    if (currentSample > this.chunk.length) {
      this.playedSamples += this.chunk.length;
      this.node = new AudioBufferSourceNode(this.audioCtx, { buffer: this.chunkBuffer });
      this.node.connect(this.gainNode);
      this.node.start();
      currentSample %= this.chunk.length;
      this.chunkBuffer = new AudioBuffer({
        length: sampleRate / CHUNKS_PER_SECOND,
        numberOfChannels: 1,
        sampleRate,
      });
      this.chunk = this.chunkBuffer.getChannelData(0);
      this.chunk.fill(this.prevValue, 0, currentSample);
    }
    this.chunk.fill(value, currentSample);
    this.prevValue = value;
  }

  resume() {
    this.audioCtx.resume();
  }
}
