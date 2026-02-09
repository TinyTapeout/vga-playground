// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026, Tiny Tapeout LTD
// Author: Uri Shaked

/**
 * VGA integration test: compiles a preset, renders the first frame,
 * and compares against a reference PNG image.
 */

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { PNG } from 'pngjs';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { compileVerilator } from '../verilator/compile';
import { HDLModuleWASM } from './hdlwasm';
import { renderVGAFrame, resetModule, skipToFrameBoundary, VGA_HEIGHT, VGA_WIDTH } from './vga';

const __dirname = dirname(fileURLToPath(import.meta.url));
const verilatorWasmBinary = readFileSync(resolve(__dirname, '../verilator/verilator_bin.wasm'));

// Mock process.exit to prevent Verilator from killing the test process
const originalExit = process.exit;
beforeAll(() => {
  process.setMaxListeners(20);
  process.exit = vi.fn((code?: number) => {
    throw new Error(`process.exit called with code ${code}`);
  }) as any;
});

afterAll(() => {
  process.exit = originalExit;
});

function decodePNG(buf: Buffer): { width: number; height: number; data: Uint8Array } {
  const png = PNG.sync.read(buf);
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
}

describe('VGA Integration', () => {
  test('renders first frame of stripes preset matching reference', async () => {
    const projectV = readFileSync(resolve(__dirname, '../examples/stripes/project.v'), 'utf8');
    const hvsyncV = readFileSync(
      resolve(__dirname, '../examples/common/hvsync_generator.v'),
      'utf8',
    );

    const res = await compileVerilator({
      topModule: 'tt_um_vga_example',
      sources: {
        'project.v': projectV,
        'hvsync_generator.v': hvsyncV,
      },
      wasmBinary: verilatorWasmBinary,
    });
    if (!res.output) {
      throw new Error(`Compilation failed: ${res.errors.map((e) => e.message).join('\n')}`);
    }

    const constpool = res.output.modules['@CONST-POOL@'] || res.output.modules['__Vconst'];
    const mod = new HDLModuleWASM(res.output.modules['TOP'], constpool);
    await mod.init();

    resetModule(mod);

    // Skip the partial first frame after reset to reach a proper frame boundary.
    // (In the browser, this shifted first frame is invisible since it's immediately
    // overwritten by the next properly-synced frame at 60fps.)
    skipToFrameBoundary(mod);

    const pixels = new Uint8Array(VGA_WIDTH * VGA_HEIGHT * 4);
    renderVGAFrame(mod, pixels);

    // Compare against reference PNG
    const refPath = resolve(__dirname, '../examples/stripes/reference/frame0.png');
    const ref = decodePNG(readFileSync(refPath));
    expect(Buffer.from(pixels).equals(Buffer.from(ref.data))).toBe(true);

    mod.dispose();
  });
});
