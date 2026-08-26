import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { compileVerilator } from '../verilator/compile';
import { HDLModuleJS } from './hdlruntime';

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

async function compileAndCreate(topModule: string, sources: Record<string, string>) {
  const res = await compileVerilator({
    topModule,
    sources,
    wasmBinary: verilatorWasmBinary,
  });
  if (!res.output) {
    throw new Error(`Compilation failed: ${res.errors.map((e) => e.message).join('\n')}`);
  }
  const constpool = res.output.modules['@CONST-POOL@'] || res.output.modules['__Vconst'];
  const mod = new HDLModuleJS(res.output.modules['TOP'], constpool);
  mod.init();
  return mod;
}

describe('HDLModuleJS $readmem', () => {
  test('should load a hex file', async () => {
    // Regression: Verilator passes no format argument, so the runtime treated
    // every file as binary; the format comes from the file extension instead.
    const verilog = `
      module readmem_js(
        input wire [1:0] idx,
        output wire [7:0] val
      );
        reg [7:0] mem[0:3];
        initial begin
          $readmemh("../data/mem.hex", mem);
        end
        assign val = mem[idx];
      endmodule
    `;
    const mod = await compileAndCreate('readmem_js', { 'readmem_js.v': verilog });
    mod.getFileData = () => 'aa bb\ncc dd\n';
    mod.powercycle();
    for (const [i, expected] of [0xaa, 0xbb, 0xcc, 0xdd].entries()) {
      mod.state.idx = i;
      mod.eval();
      expect(mod.state.val).toBe(expected);
    }
  });

  test('should truncate values wider than the memory element', async () => {
    // Regression: values above Number.MAX_SAFE_INTEGER were assigned to the
    // destination typed array as bigints, which throws a TypeError.
    const verilog = `
      module readmem_js_wide(
        input wire idx,
        output wire [31:0] val
      );
        reg [31:0] mem[0:1];
        initial begin
          $readmemh("../data/mem.hex", mem);
        end
        assign val = mem[idx];
      endmodule
    `;
    const mod = await compileAndCreate('readmem_js_wide', { 'readmem_js_wide.v': verilog });
    mod.getFileData = () => '1234567893abcdef0 5\n';
    mod.powercycle();
    mod.state.idx = 0;
    mod.eval();
    expect(mod.state.val).toBe(0x3abcdef0);
    mod.state.idx = 1;
    mod.eval();
    expect(mod.state.val).toBe(5);
  });
});
