import { describe, expect, test, beforeEach } from 'vitest';
import { HDLModuleWASM } from './hdlwasm';
import {
  HDLModuleDef,
  HDLVariableDef,
  HDLLogicType,
  HDLBlock,
  HDLBinop,
  HDLVarRef,
  HDLConstant,
  HDLUnop,
} from './hdltypes';

/**
 * Helper to create an HDLLogicType for a given bit width
 */
function makeLogicType(bits: number, signed = false): HDLLogicType {
  return {
    left: bits - 1,
    right: 0,
    signed,
  };
}

/**
 * Helper to create an HDLVariableDef
 */
function makeVarDef(
  name: string,
  bits: number,
  options: { isInput?: boolean; isOutput?: boolean; signed?: boolean } = {},
): HDLVariableDef {
  return {
    name,
    origName: name,
    dtype: makeLogicType(bits, options.signed),
    isInput: options.isInput ?? false,
    isOutput: options.isOutput ?? false,
    isParam: false,
  };
}

/**
 * Helper to create a variable reference expression
 */
function makeVarRef(name: string, bits: number, signed = false): HDLVarRef {
  return {
    refname: name,
    dtype: makeLogicType(bits, signed),
  };
}

/**
 * Helper to create a constant expression
 */
function makeConst(value: number | bigint, bits: number): HDLConstant {
  if (typeof value === 'bigint') {
    return {
      cvalue: Number(value & BigInt(0xffffffff)),
      bigvalue: value,
      dtype: makeLogicType(bits),
    };
  }
  return {
    cvalue: value,
    bigvalue: BigInt(value),
    dtype: makeLogicType(bits),
  };
}

/**
 * Helper to create a binary operation expression
 */
function makeBinop(
  op: string,
  left: HDLVarRef | HDLConstant,
  right: HDLVarRef | HDLConstant,
  resultBits: number,
): HDLBinop {
  return {
    op,
    left,
    right,
    dtype: makeLogicType(resultBits),
  };
}

/**
 * Helper to create an assignment expression
 */
function makeAssign(destName: string, destBits: number, src: HDLBinop | HDLVarRef | HDLConstant): HDLBinop {
  return {
    op: 'assign',
    left: src,
    right: makeVarRef(destName, destBits),
    dtype: makeLogicType(destBits),
  };
}

/**
 * Helper to create a minimal HDLModuleDef for testing
 */
function makeModule(
  vardefs: HDLVariableDef[],
  evalExprs: (HDLBinop | HDLUnop)[] = [],
): HDLModuleDef {
  const vardefsMap: { [id: string]: HDLVariableDef } = {};
  for (const vd of vardefs) {
    vardefsMap[vd.name] = vd;
  }

  // Create minimal required blocks
  const blocks: HDLBlock[] = [
    { blocktype: 'initial', name: '_ctor_var_reset', exprs: [] },
    { blocktype: 'initial', name: '_eval_initial', exprs: [] },
    { blocktype: 'initial', name: '_eval_settle', exprs: [] },
    { blocktype: 'comb', name: '_eval', exprs: evalExprs },
    { blocktype: 'comb', name: '_change_request', exprs: [] },
  ];

  return {
    name: 'test_module',
    origName: 'test_module',
    blocks,
    instances: [],
    vardefs: vardefsMap,
  };
}

describe('HDLModuleWASM', () => {
  describe('Standard operations (<=64 bits)', () => {
    test('should compile module with 32-bit signals', async () => {
      const mod = new HDLModuleWASM(
        makeModule([
          makeVarDef('clk', 1, { isInput: true }),
          makeVarDef('counter', 32),
        ]),
        null,
      );
      await mod.init();

      mod.powercycle();
      expect(mod.state.counter).toBe(0);

      mod.dispose();
    });

    test('should compile module with 64-bit signals', async () => {
      const mod = new HDLModuleWASM(
        makeModule([
          makeVarDef('clk', 1, { isInput: true }),
          makeVarDef('counter', 64),
        ]),
        null,
      );
      await mod.init();

      mod.powercycle();
      // 64-bit values return as Uint32Array
      const val = mod.state.counter;
      expect(val).toBeInstanceOf(Uint32Array);
      expect(val.length).toBe(2);

      mod.dispose();
    });
  });

  describe('Wide signals (>64 bits)', () => {
    test('should compile module with 65-bit signal', async () => {
      const mod = new HDLModuleWASM(
        makeModule([
          makeVarDef('clk', 1, { isInput: true }),
          makeVarDef('wide', 65),
        ]),
        null,
      );
      await mod.init();

      mod.powercycle();
      // Wide values should return as BigInt
      const val = mod.state.wide;
      expect(typeof val).toBe('bigint');
      expect(val).toBe(0n);

      mod.dispose();
    });

    test('should compile module with 96-bit signal', async () => {
      const mod = new HDLModuleWASM(
        makeModule([
          makeVarDef('clk', 1, { isInput: true }),
          makeVarDef('wide', 96),
        ]),
        null,
      );
      await mod.init();

      mod.powercycle();
      const val = mod.state.wide;
      expect(typeof val).toBe('bigint');
      expect(val).toBe(0n);

      mod.dispose();
    });

    test('should compile module with 128-bit signal', async () => {
      const mod = new HDLModuleWASM(
        makeModule([
          makeVarDef('clk', 1, { isInput: true }),
          makeVarDef('wide', 128),
        ]),
        null,
      );
      await mod.init();

      mod.powercycle();
      const val = mod.state.wide;
      expect(typeof val).toBe('bigint');
      expect(val).toBe(0n);

      mod.dispose();
    });

    test('should set and get 65-bit value via BigInt', async () => {
      const mod = new HDLModuleWASM(
        makeModule([
          makeVarDef('clk', 1, { isInput: true }),
          makeVarDef('wide', 65),
        ]),
        null,
      );
      await mod.init();

      mod.powercycle();

      // Set a value that uses the 65th bit
      const testValue = (1n << 64n) | 0x123456789abcdef0n;
      mod.state.wide = testValue;

      const readBack = mod.state.wide;
      expect(readBack).toBe(testValue);

      mod.dispose();
    });

    test('should set and get 128-bit value via BigInt', async () => {
      const mod = new HDLModuleWASM(
        makeModule([
          makeVarDef('clk', 1, { isInput: true }),
          makeVarDef('wide', 128),
        ]),
        null,
      );
      await mod.init();

      mod.powercycle();

      // Set a large 128-bit value
      const testValue = (1n << 127n) | (1n << 64n) | 0xfedcba9876543210n;
      mod.state.wide = testValue;

      const readBack = mod.state.wide;
      expect(readBack).toBe(testValue);

      mod.dispose();
    });
  });

  describe('Wide operations', () => {
    test('should perform wide addition', async () => {
      // Create a module that adds two 96-bit values
      const mod = new HDLModuleWASM(
        makeModule(
          [
            makeVarDef('clk', 1, { isInput: true }),
            makeVarDef('a', 96),
            makeVarDef('b', 96),
            makeVarDef('result', 96, { isOutput: true }),
          ],
          [
            makeAssign(
              'result',
              96,
              makeBinop('add', makeVarRef('a', 96), makeVarRef('b', 96), 96),
            ),
          ],
        ),
        null,
      );
      await mod.init();

      mod.powercycle();

      // Test simple addition
      mod.state.a = 100n;
      mod.state.b = 200n;
      mod.eval();
      expect(mod.state.result).toBe(300n);

      // Test addition with carry
      mod.state.a = 0xffffffff_ffffffffn; // 64 bits of 1s
      mod.state.b = 1n;
      mod.eval();
      expect(mod.state.result).toBe(0x1_00000000_00000000n);

      mod.dispose();
    });

    test('should perform wide subtraction', async () => {
      const mod = new HDLModuleWASM(
        makeModule(
          [
            makeVarDef('clk', 1, { isInput: true }),
            makeVarDef('a', 96),
            makeVarDef('b', 96),
            makeVarDef('result', 96, { isOutput: true }),
          ],
          [
            makeAssign(
              'result',
              96,
              makeBinop('sub', makeVarRef('a', 96), makeVarRef('b', 96), 96),
            ),
          ],
        ),
        null,
      );
      await mod.init();

      mod.powercycle();

      // Test simple subtraction
      mod.state.a = 300n;
      mod.state.b = 100n;
      mod.eval();
      expect(mod.state.result).toBe(200n);

      // Test subtraction with borrow
      mod.state.a = 0x1_00000000_00000000n;
      mod.state.b = 1n;
      mod.eval();
      expect(mod.state.result).toBe(0xffffffff_ffffffffn);

      mod.dispose();
    });

    test('should perform wide bitwise OR', async () => {
      const mod = new HDLModuleWASM(
        makeModule(
          [
            makeVarDef('clk', 1, { isInput: true }),
            makeVarDef('a', 96),
            makeVarDef('b', 96),
            makeVarDef('result', 96, { isOutput: true }),
          ],
          [
            makeAssign(
              'result',
              96,
              makeBinop('or', makeVarRef('a', 96), makeVarRef('b', 96), 96),
            ),
          ],
        ),
        null,
      );
      await mod.init();

      mod.powercycle();

      mod.state.a = 0xf0f0f0f0_f0f0f0f0_f0f0f0f0n;
      mod.state.b = 0x0f0f0f0f_0f0f0f0f_0f0f0f0fn;
      mod.eval();
      expect(mod.state.result).toBe(0xffffffff_ffffffff_ffffffffn);

      mod.dispose();
    });

    test('should perform wide bitwise AND', async () => {
      const mod = new HDLModuleWASM(
        makeModule(
          [
            makeVarDef('clk', 1, { isInput: true }),
            makeVarDef('a', 96),
            makeVarDef('b', 96),
            makeVarDef('result', 96, { isOutput: true }),
          ],
          [
            makeAssign(
              'result',
              96,
              makeBinop('and', makeVarRef('a', 96), makeVarRef('b', 96), 96),
            ),
          ],
        ),
        null,
      );
      await mod.init();

      mod.powercycle();

      mod.state.a = 0xffffffff_00000000_ffffffffn;
      mod.state.b = 0x12345678_12345678_12345678n;
      mod.eval();
      expect(mod.state.result).toBe(0x12345678_00000000_12345678n);

      mod.dispose();
    });

    test('should perform wide bitwise XOR', async () => {
      const mod = new HDLModuleWASM(
        makeModule(
          [
            makeVarDef('clk', 1, { isInput: true }),
            makeVarDef('a', 96),
            makeVarDef('b', 96),
            makeVarDef('result', 96, { isOutput: true }),
          ],
          [
            makeAssign(
              'result',
              96,
              makeBinop('xor', makeVarRef('a', 96), makeVarRef('b', 96), 96),
            ),
          ],
        ),
        null,
      );
      await mod.init();

      mod.powercycle();

      mod.state.a = 0xffffffff_ffffffff_ffffffffn;
      mod.state.b = 0x12345678_12345678_12345678n;
      mod.eval();
      expect(mod.state.result).toBe(0xedcba987_edcba987_edcba987n);

      mod.dispose();
    });

    test('should perform wide left shift by constant', async () => {
      // Test shift by 4 bits
      const mod1 = new HDLModuleWASM(
        makeModule(
          [
            makeVarDef('clk', 1, { isInput: true }),
            makeVarDef('a', 96),
            makeVarDef('result', 96, { isOutput: true }),
          ],
          [
            makeAssign(
              'result',
              96,
              makeBinop('shiftl', makeVarRef('a', 96), makeConst(4, 8), 96),
            ),
          ],
        ),
        null,
      );
      await mod1.init();
      mod1.powercycle();

      mod1.state.a = 0x123456789abcdef0n;
      mod1.eval();
      expect(mod1.state.result).toBe(0x123456789abcdef0n << 4n);
      mod1.dispose();

      // Test shift across word boundary (32 bits)
      const mod2 = new HDLModuleWASM(
        makeModule(
          [
            makeVarDef('clk', 1, { isInput: true }),
            makeVarDef('a', 96),
            makeVarDef('result', 96, { isOutput: true }),
          ],
          [
            makeAssign(
              'result',
              96,
              makeBinop('shiftl', makeVarRef('a', 96), makeConst(32, 8), 96),
            ),
          ],
        ),
        null,
      );
      await mod2.init();
      mod2.powercycle();

      mod2.state.a = 0xffffffffn;
      mod2.eval();
      expect(mod2.state.result).toBe(0xffffffff_00000000n);
      mod2.dispose();
    });

    test('should perform wide right shift by constant', async () => {
      // Test shift by 4 bits
      const mod1 = new HDLModuleWASM(
        makeModule(
          [
            makeVarDef('clk', 1, { isInput: true }),
            makeVarDef('a', 96),
            makeVarDef('result', 96, { isOutput: true }),
          ],
          [
            makeAssign(
              'result',
              96,
              makeBinop('shiftr', makeVarRef('a', 96), makeConst(4, 8), 96),
            ),
          ],
        ),
        null,
      );
      await mod1.init();
      mod1.powercycle();

      mod1.state.a = 0x123456789abcdef0n;
      mod1.eval();
      expect(mod1.state.result).toBe(0x123456789abcdef0n >> 4n);
      mod1.dispose();

      // Test shift across word boundary (32 bits)
      const mod2 = new HDLModuleWASM(
        makeModule(
          [
            makeVarDef('clk', 1, { isInput: true }),
            makeVarDef('a', 96),
            makeVarDef('result', 96, { isOutput: true }),
          ],
          [
            makeAssign(
              'result',
              96,
              makeBinop('shiftr', makeVarRef('a', 96), makeConst(32, 8), 96),
            ),
          ],
        ),
        null,
      );
      await mod2.init();
      mod2.powercycle();

      mod2.state.a = 0xffffffff_00000000n;
      mod2.eval();
      expect(mod2.state.result).toBe(0xffffffffn);
      mod2.dispose();
    });

    test('should perform wide equality comparison', async () => {
      const mod = new HDLModuleWASM(
        makeModule(
          [
            makeVarDef('clk', 1, { isInput: true }),
            makeVarDef('a', 96),
            makeVarDef('b', 96),
            makeVarDef('result', 1, { isOutput: true }),
          ],
          [
            makeAssign(
              'result',
              1,
              makeBinop('eq', makeVarRef('a', 96), makeVarRef('b', 96), 1),
            ),
          ],
        ),
        null,
      );
      await mod.init();

      mod.powercycle();

      // Equal values
      mod.state.a = 0x123456789abcdef0_12345678n;
      mod.state.b = 0x123456789abcdef0_12345678n;
      mod.eval();
      expect(mod.state.result).toBe(1);

      // Different values
      mod.state.b = 0x123456789abcdef0_12345679n;
      mod.eval();
      expect(mod.state.result).toBe(0);

      mod.dispose();
    });

    test('should perform wide less-than comparison', async () => {
      const mod = new HDLModuleWASM(
        makeModule(
          [
            makeVarDef('clk', 1, { isInput: true }),
            makeVarDef('a', 96),
            makeVarDef('b', 96),
            makeVarDef('result', 1, { isOutput: true }),
          ],
          [
            makeAssign(
              'result',
              1,
              makeBinop('lt', makeVarRef('a', 96), makeVarRef('b', 96), 1),
            ),
          ],
        ),
        null,
      );
      await mod.init();

      mod.powercycle();

      // a < b
      mod.state.a = 0x100n;
      mod.state.b = 0x200n;
      mod.eval();
      expect(mod.state.result).toBe(1);

      // a >= b
      mod.state.a = 0x200n;
      mod.state.b = 0x100n;
      mod.eval();
      expect(mod.state.result).toBe(0);

      // Equal values
      mod.state.a = 0x100n;
      mod.state.b = 0x100n;
      mod.eval();
      expect(mod.state.result).toBe(0);

      mod.dispose();
    });

    test('should load wide constant', async () => {
      const wideConst = 0x123456789abcdef0_fedcba98n;
      const mod = new HDLModuleWASM(
        makeModule(
          [
            makeVarDef('clk', 1, { isInput: true }),
            makeVarDef('result', 96, { isOutput: true }),
          ],
          [
            makeAssign('result', 96, makeConst(wideConst, 96)),
          ],
        ),
        null,
      );
      await mod.init();

      mod.powercycle();
      mod.eval();

      expect(mod.state.result).toBe(wideConst);

      mod.dispose();
    });
  });
});
