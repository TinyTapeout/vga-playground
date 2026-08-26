/**
 * Parser for the data files loaded by Verilog's $readmemh / $readmemb.
 *
 * The format allows any amount of whitespace between values (so a whole memory
 * may live on a single line, or be laid out as a grid), Verilog comments, and
 * `@<hex address>` directives that move the load pointer.
 */

export interface MemFileEntry {
  addr: number;
  value: bigint;
}

const HEX_DIGITS = /^[0-9a-fA-F]+$/;
const BIN_DIGITS = /^[01]+$/;

/** Strip line comments and block comments. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * Parse the contents of a $readmem data file.
 *
 * @param text file contents
 * @param ishex true for $readmemh, false for $readmemb
 * @returns the values in the file, each with the memory index it belongs at
 */
export function parseMemFile(text: string, ishex: boolean): MemFileEntry[] {
  const entries: MemFileEntry[] = [];
  let addr = 0;
  for (const rawToken of stripComments(text).split(/\s+/)) {
    if (rawToken === '') continue;
    if (rawToken[0] === '@') {
      const digits = rawToken.slice(1); // addresses are always hex
      if (!HEX_DIGITS.test(digits)) {
        throw new Error(`invalid address "${rawToken}"`);
      }
      addr = parseInt(digits, 16);
      continue;
    }
    // unknown/high-impedance bits read as zero, underscores are separators
    const token = rawToken.replace(/_/g, '').replace(/[xXzZ?]/g, '0');
    if (!(ishex ? HEX_DIGITS : BIN_DIGITS).test(token)) {
      throw new Error(`invalid ${ishex ? 'hex' : 'binary'} value "${rawToken}"`);
    }
    entries.push({ addr, value: BigInt((ishex ? '0x' : '0b') + token) });
    addr++;
  }
  return entries;
}
