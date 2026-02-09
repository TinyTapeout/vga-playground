import { describe, expect, test } from 'vitest';
import { detectTopModule } from './verilog';

describe('detectTopModule', () => {
  test('returns tt_um_* module from sources', () => {
    expect(
      detectTopModule({
        'project.v': 'module tt_um_my_project(input clk);',
      }),
    ).toBe('tt_um_my_project');
  });

  test('returns tt_um_* module from non-project.v file', () => {
    expect(
      detectTopModule({
        'project.v': 'module helper(input clk);',
        'top.v': 'module tt_um_top(input clk);',
      }),
    ).toBe('tt_um_top');
  });

  test('returns non-tt_um module from project.v when no tt_um_* found', () => {
    expect(
      detectTopModule({
        'project.v': 'module my_design(input clk);',
        'other.v': 'module helper(input a);',
      }),
    ).toBe('my_design');
  });

  test('returns fallback when sources are empty', () => {
    expect(detectTopModule({})).toBe('tt_um_vga_example');
  });

  test('ignores commented-out module (single-line)', () => {
    expect(
      detectTopModule({
        'project.v': ['// module tt_um_fake(input clk);', 'module tt_um_real(input clk);'].join(
          '\n',
        ),
      }),
    ).toBe('tt_um_real');
  });

  test('ignores commented-out module (block comment)', () => {
    expect(
      detectTopModule({
        'project.v': ['/* module tt_um_fake(input clk); */', 'module tt_um_real(input clk);'].join(
          '\n',
        ),
      }),
    ).toBe('tt_um_real');
  });

  test('falls through to project.v non-tt_um when tt_um is commented out', () => {
    expect(
      detectTopModule({
        'project.v': ['// module tt_um_fake(input clk);', 'module my_design(input clk);'].join(
          '\n',
        ),
      }),
    ).toBe('my_design');
  });
});
