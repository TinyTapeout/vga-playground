// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2024, Tiny Tapeout LTD

export class LineBreakTransformer implements Transformer<string, string> {
  private chunks: string;

  constructor() {
    // A container for holding stream data until a new line.
    this.chunks = '';
  }

  transform(chunk: string, controller: TransformStreamDefaultController) {
    // Append new chunks to existing chunks.
    this.chunks += chunk;
    // For each line breaks in chunks, send the parsed lines out.
    const lines = this.chunks.split('\n');
    this.chunks = lines.pop() ?? '';
    lines.forEach((line) => controller.enqueue(line));
  }

  flush(controller: TransformStreamDefaultController) {
    // When the stream is closed, flush any remaining chunks out.
    controller.enqueue(this.chunks);
  }
}
