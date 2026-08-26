import { describe, expect, it } from 'vitest';
import { parseMemFile } from './readmem';

describe('parseMemFile', () => {
  it('parses one value per line', () => {
    expect(parseMemFile('0\n1\nff\n', true)).toEqual([
      { addr: 0, value: 0n },
      { addr: 1, value: 1n },
      { addr: 2, value: 0xffn },
    ]);
  });

  it('parses several whitespace-separated values per line', () => {
    expect(parseMemFile('0 1 2\n3   4\n', true).map((e) => Number(e.value))).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(parseMemFile('0 1 2\n3   4\n', true).map((e) => e.addr)).toEqual([0, 1, 2, 3, 4]);
  });

  it('handles CRLF line endings', () => {
    expect(parseMemFile('a\r\nb\r\n', true).map((e) => Number(e.value))).toEqual([10, 11]);
  });

  it('parses binary values', () => {
    expect(parseMemFile('1010 0101', false).map((e) => Number(e.value))).toEqual([0b1010, 0b0101]);
  });

  it('parses values wider than 32 bits', () => {
    expect(parseMemFile('0123456789abcdef', true)).toEqual([
      { addr: 0, value: 0x0123456789abcdefn },
    ]);
  });

  it('ignores underscores inside values', () => {
    expect(parseMemFile('de_ad be_ef', true).map((e) => Number(e.value))).toEqual([0xdead, 0xbeef]);
  });

  it('reads x and z bits as zero', () => {
    expect(parseMemFile('1x 2z 3?', true).map((e) => Number(e.value))).toEqual([0x10, 0x20, 0x30]);
  });

  it('strips line and block comments', () => {
    expect(parseMemFile('1 // two\n2 /* three\n   four */ 5\n', true).map((e) => e.value)).toEqual([
      1n,
      2n,
      5n,
    ]);
  });

  it('honors @address directives', () => {
    expect(parseMemFile('@10 aa bb @2 cc', true)).toEqual([
      { addr: 16, value: 0xaan },
      { addr: 17, value: 0xbbn },
      { addr: 2, value: 0xccn },
    ]);
  });

  it('returns nothing for an empty file', () => {
    expect(parseMemFile('\n  \n', true)).toEqual([]);
  });

  it('throws on values that are not valid for the radix', () => {
    expect(() => parseMemFile('12 gg', true)).toThrow('invalid hex value "gg"');
    expect(() => parseMemFile('10 2', false)).toThrow('invalid binary value "2"');
  });

  it('throws on malformed addresses', () => {
    expect(() => parseMemFile('@1g 0', true)).toThrow('invalid address "@1g"');
    expect(() => parseMemFile('@-2 0', true)).toThrow('invalid address "@-2"');
  });
});
