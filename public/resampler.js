// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2024, Tiny Tapeout LTD
// Author: Renaldas Zioma, Uri Shaked

class AudioResamplerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    
    // Define buffer properties
    this.ringBufferSize = 4096 * 4; // can store approximately 5 frames of audio data
    this.ringBuffer = new Float32Array(this.ringBufferSize); // ring-buffer helps to amortise uneven framerate and
                                                             // keeps re-sampler from starving or overflowing
    this.writeIndex = 0; // Index where new samples are written
    this.readIndex = 0;  // Index where samples are read
    this.previousSample = 0.0;
    this.ringBuffer.fill(this.previousSample);
    
    // Listen to messages from the main thread
    this.port.onmessage = this.handleMessage.bind(this);

    this.expectedFPS = 60.0;
    this.currentFPS = this.expectedFPS;
    console.log("Audio WebWorker started");
  }

  handleMessage(event) {
    const data = event.data;

    // Handle incoming audio samples and write to the ring buffer
    if (data.type === 'samples') {
      this.currentFPS = data.fps;
      const samples = data.samples;
      for (let i = 0; i < samples.length; i++) {
        if ((this.writeIndex + 1) % this.ringBufferSize == this.readIndex)
        {
          console.log("Buffer is full. Dropping", samples.length - i, "incomming samples!");
          break; // Skip incomming samples when ring-buffer is full
        }
        if (this.writeIndex == this.readIndex)
          this.ringBuffer[(this.writeIndex - 1) % this.ringBufferSize] = samples[i]; 
        this.ringBuffer[this.writeIndex] = samples[i];
        this.writeIndex = (this.writeIndex + 1) % this.ringBufferSize; // Wrap around
      }
    }
    else if (data.type === 'reset') {
      this.ringBuffer.fill(this.previousSample);
      this.readIndex = 0;
      this.writeIndex = 0;
    }
  }

  // Linear interpolation for resampling
  interpolate(buffer, index1, index2, frac) {
    return (1 - frac) * buffer[index1] + frac * buffer[index2];
  }

  // Process function that resamples the data from the ring buffer to match output size
  process(inputs, outputs) {
    const output = outputs[0]; // Mono output (1 channel)
    const outputData = output[0]; // Get the output data array

    const playbackRate = this.currentFPS / this.expectedFPS;
    const borderSamples = 2;
    const samplesRequired = Math.round(outputData.length * playbackRate) + borderSamples;

    // example when samplesRequired = 8 + 2 border samples
    // (border samples are marked as 'b' below)
    // 
    // 3 subsequent invocations of process():
    //                                     
    // ringBuffer:  b01234567b01234567b01234567b.
    // process#0    ^........^                  | <- sampling window
    // process#1             ^........^         | <- sampling window
    // process#2                      ^........^| <- sampling window 
    //                           WRITE pointer--`

    // process#0    ^--READ pointer
    // process#1             ^--READ pointer
    // process#2                      ^--READ pointer 
    // after process#2                         ^--READ pointer

    const samplesAvailable = (this.writeIndex - this.readIndex + this.ringBufferSize) % this.ringBufferSize;
    if (samplesAvailable < borderSamples)
    {
      for (let i = 0; i < outputData.length; i++)
        outputData[i] = this.previousSample;
      console.log("Buffer is empty. Using previous sample value " + this.previousSample.toFixed(3));
      return true;
    }

    const samplesConsumed = Math.min(samplesRequired, samplesAvailable) - borderSamples;

    // Calculate resampling ratio
    const ratio = samplesConsumed / outputData.length;

    // Fill the output buffer by resampling from the ring buffer
    for (let i = 0; i < outputData.length; i++) {
      const floatPos = 0.5 + ratio * (i + 0.5); // use sample centroids, thus +0.5
      const intPos = Math.floor(floatPos);
      const nextIntPos = intPos + 1;
      const frac = floatPos - intPos; // fractional part for interpolation

      if ((this.readIndex + nextIntPos) % this.ringBufferSize == this.writeIndex)
        console.log(i, frac, intPos, nextIntPos, playbackRate, 'req: ', samplesRequired, 'avail: ', samplesAvailable, ratio, samplesConsumed);

      // Resample with linear interpolation
      outputData[i] = this.interpolate(this.ringBuffer,
        (this.readIndex + intPos) % this.ringBufferSize,
        (this.readIndex + nextIntPos) % this.ringBufferSize, frac);
    }

    this.previousSample = outputData[outputData.length - 1];

    // Update readIndex to match how many samples were consumed
    this.readIndex = (this.readIndex + samplesConsumed) % this.ringBufferSize;

    // Return true to keep the processor alive
    return true;
  }
}

// Register the processor
registerProcessor('resampler', AudioResamplerProcessor);
