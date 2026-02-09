import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { compileVerilator } from '../verilator/compile';
import { HDLModuleWASM } from './hdlwasm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const verilatorWasmBinary = readFileSync(resolve(__dirname, '../verilator/verilator_bin.wasm'));

// Mock process.exit to prevent Verilator from killing the test process
const originalExit = process.exit;
beforeAll(() => {
  // Increase max listeners to avoid warning when creating multiple Verilator instances
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
  const mod = new HDLModuleWASM(res.output.modules['TOP'], constpool);
  await mod.init();
  return mod;
}

describe('Full Verilog -> WASM Pipeline', () => {
  describe('Wide counter (65 bits)', () => {
    test('should compile and simulate a 65-bit counter', async () => {
      const verilog = `
        module wide_counter(
          input wire clk,
          input wire rst_n,
          output reg [64:0] counter
        );
          always @(posedge clk or negedge rst_n) begin
            if (!rst_n)
              counter <= 0;
            else
              counter <= counter + 1;
          end
        endmodule
      `;

      const mod = await compileAndCreate('wide_counter', { 'wide_counter.v': verilog });
      mod.powercycle();

      // Release reset (rst_n is active-low)
      mod.state.rst_n = 1;
      mod.eval();

      // Check initial value
      expect(mod.state.counter).toBe(0n);

      // Tick a few times
      for (let i = 0; i < 10; i++) {
        mod.state.clk = 0;
        mod.eval();
        mod.state.clk = 1;
        mod.eval();
      }

      expect(mod.state.counter).toBe(10n);

      mod.dispose();
    });

    test('should handle 65-bit counter overflow correctly', async () => {
      const verilog = `
        module wide_counter_overflow(
          input wire clk,
          input wire rst_n,
          input wire [64:0] init_val,
          input wire load,
          output reg [64:0] counter
        );
          always @(posedge clk or negedge rst_n) begin
            if (!rst_n)
              counter <= 0;
            else if (load)
              counter <= init_val;
            else
              counter <= counter + 1;
          end
        endmodule
      `;

      const mod = await compileAndCreate('wide_counter_overflow', {
        'wide_counter_overflow.v': verilog,
      });
      mod.powercycle();

      // Release reset (rst_n is active-low)
      mod.state.rst_n = 1;
      mod.eval();

      // Set counter to near max value (65-bit max is 2^65 - 1)
      const nearMax = (1n << 64n) - 1n; // 0x_FFFFFFFF_FFFFFFFF
      mod.state.init_val = nearMax;
      mod.state.load = 1;

      // Load the value
      mod.state.clk = 0;
      mod.eval();
      mod.state.clk = 1;
      mod.eval();

      expect(mod.state.counter).toBe(nearMax);

      // Stop loading
      mod.state.load = 0;

      // Increment past 64-bit boundary
      mod.state.clk = 0;
      mod.eval();
      mod.state.clk = 1;
      mod.eval();

      expect(mod.state.counter).toBe(1n << 64n);

      // One more increment
      mod.state.clk = 0;
      mod.eval();
      mod.state.clk = 1;
      mod.eval();

      expect(mod.state.counter).toBe((1n << 64n) + 1n);

      mod.dispose();
    });
  });

  describe('Wide arithmetic (96 bits)', () => {
    test('should perform 96-bit addition', async () => {
      const verilog = `
        module wide_adder(
          input wire [95:0] a,
          input wire [95:0] b,
          output wire [95:0] sum
        );
          assign sum = a + b;
        endmodule
      `;

      const mod = await compileAndCreate('wide_adder', { 'wide_adder.v': verilog });
      mod.powercycle();

      // Test simple addition
      mod.state.a = 0x123456789abcdef0_12345678n;
      mod.state.b = 0x111111111111111_11111111n;
      mod.eval();

      expect(mod.state.sum).toBe(0x123456789abcdef0_12345678n + 0x111111111111111_11111111n);

      // Test addition with carry across 64-bit boundary
      mod.state.a = 0xffffffff_ffffffffn; // 64 bits of 1s
      mod.state.b = 1n;
      mod.eval();

      expect(mod.state.sum).toBe(1n << 64n);

      mod.dispose();
    });

    test('should perform 96-bit subtraction', async () => {
      const verilog = `
        module wide_subtractor(
          input wire [95:0] a,
          input wire [95:0] b,
          output wire [95:0] diff
        );
          assign diff = a - b;
        endmodule
      `;

      const mod = await compileAndCreate('wide_subtractor', { 'wide_subtractor.v': verilog });
      mod.powercycle();

      // Test subtraction with borrow across 64-bit boundary
      mod.state.a = 1n << 64n;
      mod.state.b = 1n;
      mod.eval();

      expect(mod.state.diff).toBe((1n << 64n) - 1n);

      mod.dispose();
    });
  });

  describe('Wide bitwise operations (128 bits)', () => {
    test('should perform 128-bit bitwise operations', async () => {
      const verilog = `
        module wide_bitwise(
          input wire [127:0] a,
          input wire [127:0] b,
          output wire [127:0] and_out,
          output wire [127:0] or_out,
          output wire [127:0] xor_out,
          output wire [127:0] not_out
        );
          assign and_out = a & b;
          assign or_out = a | b;
          assign xor_out = a ^ b;
          assign not_out = ~a;
        endmodule
      `;

      const mod = await compileAndCreate('wide_bitwise', { 'wide_bitwise.v': verilog });
      mod.powercycle();

      const a = 0xf0f0f0f0_f0f0f0f0_f0f0f0f0_f0f0f0f0n;
      const b = 0x0f0f0f0f_0f0f0f0f_0f0f0f0f_0f0f0f0fn;

      mod.state.a = a;
      mod.state.b = b;
      mod.eval();

      expect(mod.state.and_out).toBe(a & b);
      expect(mod.state.or_out).toBe(a | b);
      expect(mod.state.xor_out).toBe(a ^ b);

      // NOT result should have all bits inverted within 128 bits
      const notExpected = a ^ ((1n << 128n) - 1n);
      expect(mod.state.not_out).toBe(notExpected);

      mod.dispose();
    });
  });

  describe('Wide shifts (96 bits)', () => {
    test('should perform 96-bit left shift', async () => {
      const verilog = `
        module wide_shift_left(
          input wire [95:0] a,
          output wire [95:0] shifted_4,
          output wire [95:0] shifted_32,
          output wire [95:0] shifted_64
        );
          assign shifted_4 = a << 4;
          assign shifted_32 = a << 32;
          assign shifted_64 = a << 64;
        endmodule
      `;

      const mod = await compileAndCreate('wide_shift_left', { 'wide_shift_left.v': verilog });
      mod.powercycle();

      const a = 0x123456789abcdef0n;
      mod.state.a = a;
      mod.eval();

      // Mask to 96 bits
      const mask96 = (1n << 96n) - 1n;

      expect(mod.state.shifted_4).toBe((a << 4n) & mask96);
      expect(mod.state.shifted_32).toBe((a << 32n) & mask96);
      expect(mod.state.shifted_64).toBe((a << 64n) & mask96);

      mod.dispose();
    });

    test('should perform 96-bit right shift', async () => {
      const verilog = `
        module wide_shift_right(
          input wire [95:0] a,
          output wire [95:0] shifted_4,
          output wire [95:0] shifted_32,
          output wire [95:0] shifted_64
        );
          assign shifted_4 = a >> 4;
          assign shifted_32 = a >> 32;
          assign shifted_64 = a >> 64;
        endmodule
      `;

      const mod = await compileAndCreate('wide_shift_right', { 'wide_shift_right.v': verilog });
      mod.powercycle();

      const a = 0x123456789abcdef0_12345678n;
      mod.state.a = a;
      mod.eval();

      expect(mod.state.shifted_4).toBe(a >> 4n);
      expect(mod.state.shifted_32).toBe(a >> 32n);
      expect(mod.state.shifted_64).toBe(a >> 64n);

      mod.dispose();
    });
  });

  describe('Wide comparisons (96 bits)', () => {
    test('should perform 96-bit comparisons', async () => {
      const verilog = `
        module wide_compare(
          input wire [95:0] a,
          input wire [95:0] b,
          output wire eq,
          output wire neq,
          output wire lt,
          output wire gt,
          output wire lte,
          output wire gte
        );
          assign eq = a == b;
          assign neq = a != b;
          assign lt = a < b;
          assign gt = a > b;
          assign lte = a <= b;
          assign gte = a >= b;
        endmodule
      `;

      const mod = await compileAndCreate('wide_compare', { 'wide_compare.v': verilog });
      mod.powercycle();

      // Test equal values
      const val = 0x123456789abcdef0_12345678n;
      mod.state.a = val;
      mod.state.b = val;
      mod.eval();

      expect(mod.state.eq).toBe(1);
      expect(mod.state.neq).toBe(0);
      expect(mod.state.lt).toBe(0);
      expect(mod.state.gt).toBe(0);
      expect(mod.state.lte).toBe(1);
      expect(mod.state.gte).toBe(1);

      // Test a < b
      mod.state.a = 100n;
      mod.state.b = 200n;
      mod.eval();

      expect(mod.state.eq).toBe(0);
      expect(mod.state.neq).toBe(1);
      expect(mod.state.lt).toBe(1);
      expect(mod.state.gt).toBe(0);
      expect(mod.state.lte).toBe(1);
      expect(mod.state.gte).toBe(0);

      // Test comparison across 64-bit boundary
      mod.state.a = (1n << 64n) - 1n;
      mod.state.b = 1n << 64n;
      mod.eval();

      expect(mod.state.lt).toBe(1);
      expect(mod.state.gt).toBe(0);

      mod.dispose();
    });
  });

  describe('Modified Stripes demo with 65-bit counter', () => {
    test('should run Stripes-like demo with 65-bit counter', async () => {
      // Simplified version of the Stripes demo with a 65-bit counter
      const verilog = `
        module stripes_wide(
          input wire clk,
          input wire rst_n,
          input wire [9:0] pix_x,
          output reg [64:0] counter,
          output wire [9:0] moving_x,
          output wire [1:0] r_out
        );
          assign moving_x = pix_x + counter[9:0];
          assign r_out = {moving_x[5], moving_x[2]};

          always @(posedge clk or negedge rst_n) begin
            if (!rst_n)
              counter <= 0;
            else
              counter <= counter + 1;
          end
        endmodule
      `;

      const mod = await compileAndCreate('stripes_wide', { 'stripes_wide.v': verilog });
      mod.powercycle();

      // Release reset (rst_n is active-low)
      mod.state.rst_n = 1;
      mod.eval();

      // Set pixel position
      mod.state.pix_x = 100;

      // Run a few cycles
      for (let i = 0; i < 100; i++) {
        mod.state.clk = 0;
        mod.eval();
        mod.state.clk = 1;
        mod.eval();
      }

      expect(mod.state.counter).toBe(100n);

      // The moving_x should be pix_x + counter[9:0]
      const expectedMovingX = (100 + 100) & 0x3ff; // 10-bit mask
      expect(mod.state.moving_x).toBe(expectedMovingX);

      mod.dispose();
    });
  });

  describe('Very wide vectors (224+ bits)', () => {
    test('should handle 224-bit counter', async () => {
      const verilog = `
        module wide_counter_224(
          input wire clk,
          input wire rst_n,
          output reg [223:0] counter
        );
          always @(posedge clk or negedge rst_n) begin
            if (!rst_n)
              counter <= 0;
            else
              counter <= counter + 1;
          end
        endmodule
      `;

      const mod = await compileAndCreate('wide_counter_224', { 'wide_counter_224.v': verilog });
      mod.powercycle();

      // Release reset
      mod.state.rst_n = 1;
      mod.eval();

      expect(mod.state.counter).toBe(0n);

      // Tick a few times
      for (let i = 0; i < 10; i++) {
        mod.state.clk = 0;
        mod.eval();
        mod.state.clk = 1;
        mod.eval();
      }

      expect(mod.state.counter).toBe(10n);

      mod.dispose();
    });

    test('should handle 3000-bit counter (extremely large)', async () => {
      const verilog = `
        module wide_counter_3000(
          input wire clk,
          input wire rst_n,
          output reg [2999:0] counter
        );
          always @(posedge clk or negedge rst_n) begin
            if (!rst_n)
              counter <= 0;
            else
              counter <= counter + 1;
          end
        endmodule
      `;

      const mod = await compileAndCreate('wide_counter_3000', {
        'wide_counter_3000.v': verilog,
      });
      mod.powercycle();

      // Release reset
      mod.state.rst_n = 1;
      mod.eval();

      expect(mod.state.counter).toBe(0n);

      // Tick a few times
      for (let i = 0; i < 10; i++) {
        mod.state.clk = 0;
        mod.eval();
        mod.state.clk = 1;
        mod.eval();
      }

      expect(mod.state.counter).toBe(10n);

      mod.dispose();
    });

    test('should handle 1024-bit arithmetic', async () => {
      const verilog = `
        module wide_arithmetic_1024(
          input wire [1023:0] a,
          input wire [1023:0] b,
          output wire [1023:0] sum,
          output wire [1023:0] diff
        );
          assign sum = a + b;
          assign diff = a - b;
        endmodule
      `;

      const mod = await compileAndCreate('wide_arithmetic_1024', {
        'wide_arithmetic_1024.v': verilog,
      });
      mod.powercycle();

      // Test with large values
      const largeA = (1n << 512n) + 123n;
      const largeB = 456n;
      mod.state.a = largeA;
      mod.state.b = largeB;
      mod.eval();

      expect(mod.state.sum).toBe(largeA + largeB);
      expect(mod.state.diff).toBe(largeA - largeB);

      mod.dispose();
    });
  });

  describe('Signed comparisons', () => {
    test('should sign-extend narrower-than-container signed values before comparing', async () => {
      // Reproduces issue #15: $signed(28-bit value) > 28'sh4000
      // Verilator stores the 28-bit signed value in a 32-bit container but only
      // sign-extends to bit 27. Without the fix, i32.lt_s uses bit 31 as the sign
      // bit, so negative 28-bit values (bit 27=1, bit 31=0) are treated as positive.
      const verilog = `
        module signed_compare(
          input wire [15:0] val,
          output wire result
        );
          assign result = $signed({{12{val[15]}}, val}) > 28'sh4000;
        endmodule
      `;

      const mod = await compileAndCreate('signed_compare', { 'signed_compare.v': verilog });
      mod.powercycle();

      // 0x5000 = 20480 > 16384 → true
      mod.state.val = 0x5000;
      mod.eval();
      expect(mod.state.result).toBe(1);

      // 0x3000 = 12288 < 16384 → false
      mod.state.val = 0x3000;
      mod.eval();
      expect(mod.state.result).toBe(0);

      // 0xF000: sign-extended to 28 bits → 0xFFFF000 = -4096, which is < 16384 → false
      // This was the bug: without the fix, 0x0FFFF000 is positive in 32-bit signed
      mod.state.val = 0xf000;
      mod.eval();
      expect(mod.state.result).toBe(0);

      mod.dispose();
    });
  });
});
