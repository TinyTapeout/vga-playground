import { describe, expect, test } from 'vitest';
import { ErrorParser } from './ErrorParser';

describe('ErrorParser', () => {
  test('Parse error message', () => {
    const parser = new ErrorParser();
    const errors = [
      `%Error: src/project.v:20:3: syntax error, unexpected wire, expecting IDENTIFIER or randomize`,
      `   20 |   wire [1:0] R;`,
      `      |   ^~~~`,
      `%Error: Exiting due to 1 error(s)`,
    ];

    for (const line of errors) {
      parser.feedLine(line);
    }

    expect(parser.errors).toEqual([
      {
        type: 'error',
        file: 'src/project.v',
        line: 20,
        column: 3,
        endColumn: 7,
        message: 'syntax error, unexpected wire, expecting IDENTIFIER or randomize',
      },
    ]);
  });

  test('Multi-line error message', () => {
    const parser = new ErrorParser();
    const errors = [
      "%Error: src/project.v:48:17: Signal definition not found, and implicit disabled with `default_nettype: 'activefideo'",
      "                           : ... Suggested alternative: 'activevideo'",
      '   48 |     .display_on(activefideo),',
      '      |                 ^~~~~~~~~~~',
    ];

    for (const line of errors) {
      parser.feedLine(line);
    }

    expect(parser.errors).toEqual([
      {
        type: 'error',
        file: 'src/project.v',
        line: 48,
        column: 17,
        endColumn: 28,
        message:
          "Signal definition not found, and implicit disabled with `default_nettype: 'activefideo'\n" +
          `Suggested alternative: 'activevideo'`,
      },
    ]);
  });

  test('Parsing warnings', () => {
    const parser = new ErrorParser();
    const errors = [
      `%Warning-WIDTH: src/project.v:91:22: Operator ASSIGNW expects 9 bits on the Assign RHS, but Assign RHS's ADD generates 32 or 20 bits.`,
      `                                   : ... In instance tt_um_vga_example.worley_inst`,
      `   91 |   assign points_x[0] = 100 + t;`,
      `      |                      ^`,
      `                ... For warning description see https://verilator.org/warn/WIDTH?v=4.205`,
      `                ... Use "/* verilator lint_off WIDTH */" and lint_on around source to disable this message.`,
    ];

    for (const line of errors) {
      parser.feedLine(line);
    }

    expect(parser.errors).toEqual([
      {
        type: 'warning',
        warningClass: 'WIDTH',
        file: 'src/project.v',
        line: 91,
        column: 22,
        endColumn: 23,
        message:
          `Operator ASSIGNW expects 9 bits on the Assign RHS, but Assign RHS's ADD generates 32 or 20 bits.\n` +
          `In instance tt_um_vga_example.worley_inst\n` +
          `For warning description see https://verilator.org/warn/WIDTH?v=4.205\n` +
          `Use "/* verilator lint_off WIDTH */" and lint_on around source to disable this message.`,
      },
    ]);
  });
});
