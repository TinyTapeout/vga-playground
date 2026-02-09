// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2024-2026, Tiny Tapeout LTD
// Author: Uri Shaked

import { HDLModuleWASM } from './hdlwasm';

export const VGA_WIDTH = 736;
export const VGA_HEIGHT = 520;

export interface VGASignals {
  hsync: boolean;
  vsync: boolean;
  r: number;
  g: number;
  b: number;
}

export interface SyncPolarity {
  hsyncActiveLow: boolean;
  vsyncActiveLow: boolean;
}

export function decodeVGAOutput(uo_out: number, polarity?: SyncPolarity): VGASignals {
  const hraw = !!(uo_out & 0b10000000);
  const vraw = !!(uo_out & 0b00001000);
  return {
    hsync: polarity?.hsyncActiveLow ? !hraw : hraw,
    vsync: polarity?.vsyncActiveLow ? !vraw : vraw,
    r: ((uo_out & 0b00000001) << 1) | ((uo_out & 0b00010000) >> 4),
    g: ((uo_out & 0b00000010) << 0) | ((uo_out & 0b00100000) >> 5),
    b: ((uo_out & 0b00000100) >> 1) | ((uo_out & 0b01000000) >> 6),
  };
}

export function detectSyncPolarity(mod: HDLModuleWASM): SyncPolarity {
  const uo_out_offset = mod.globals.lookup('uo_out').offset;
  const MAX_TICKS = 500_000;

  function detectBit(mask: number): boolean {
    const bit = () => !!(mod.data8[uo_out_offset] & mask);

    // Skip the initial (potentially partial) phase to reach a clean transition
    const initialState = bit();
    let skipTicks = 0;
    while (bit() === initialState && skipTicks < MAX_TICKS) {
      mod.tick2(1);
      skipTicks++;
    }
    if (skipTicks >= MAX_TICKS) {
      return true; // fallback: active-low (VGA standard)
    }

    // Measure two complete consecutive phases; the shorter one is the sync pulse
    const phase1State = bit();
    let phase1Ticks = 0;
    while (bit() === phase1State && phase1Ticks < MAX_TICKS) {
      mod.tick2(1);
      phase1Ticks++;
    }
    if (phase1Ticks >= MAX_TICKS) {
      return true;
    }
    let phase2Ticks = 0;
    while (bit() !== phase1State && phase2Ticks < MAX_TICKS) {
      mod.tick2(1);
      phase2Ticks++;
    }
    if (phase2Ticks >= MAX_TICKS) {
      return true;
    }
    const pulseIsHigh = phase1Ticks < phase2Ticks ? phase1State : !phase1State;
    return !pulseIsHigh;
  }

  const vsyncActiveLow = detectBit(0b00001000);
  const hsyncActiveLow = detectBit(0b10000000);
  return { hsyncActiveLow, vsyncActiveLow };
}

export interface RenderOptions {
  polarity?: SyncPolarity;
  onTick?: () => void;
  onLine?: () => void;
}

export function renderVGAFrame(mod: HDLModuleWASM, pixels: Uint8Array, options?: RenderOptions) {
  const uo_out_offset = mod.globals.lookup('uo_out').offset;
  const { onTick, onLine, polarity } = options ?? {};

  function readSignals() {
    return decodeVGAOutput(mod.data8[uo_out_offset], polarity);
  }

  function waitFor(condition: () => boolean, timeout = 10000) {
    let counter = 0;
    while (!condition() && counter < timeout) {
      mod.tick2(1);
      onTick?.();
      counter++;
    }
  }

  frameLoop: for (let y = 0; y < VGA_HEIGHT; y++) {
    waitFor(() => !readSignals().hsync);
    onLine?.();
    for (let x = 0; x < VGA_WIDTH; x++) {
      const offset = (y * VGA_WIDTH + x) * 4;
      mod.tick2(1);
      onTick?.();
      const { hsync, vsync, r, g, b } = readSignals();
      if (hsync) break;
      if (vsync) break frameLoop;
      pixels[offset] = r * 85;
      pixels[offset + 1] = g * 85;
      pixels[offset + 2] = b * 85;
      pixels[offset + 3] = 0xff;
    }
    waitFor(() => readSignals().hsync);
  }
}

export function resetModule(mod: HDLModuleWASM) {
  const ui_in = mod.state.ui_in;
  mod.powercycle();
  mod.state.ena = 1;
  mod.state.rst_n = 0;
  mod.state.ui_in = ui_in;
  mod.tick2(10);
  mod.state.rst_n = 1;
}

/** Advance the simulation to the next vsync frame boundary. */
export function skipToFrameBoundary(mod: HDLModuleWASM, polarity?: SyncPolarity) {
  const uo_out_offset = mod.globals.lookup('uo_out').offset;
  const vsync = () => {
    const raw = !!(mod.data8[uo_out_offset] & 0b00001000);
    return polarity?.vsyncActiveLow ? !raw : raw;
  };
  while (!vsync()) mod.tick2(1);
  while (vsync()) mod.tick2(1);
}
