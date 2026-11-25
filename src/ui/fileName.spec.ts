import { describe, expect, test } from 'vitest';
import { INVALID_NAME_MESSAGE, VALID_EXTENSIONS, isValidFileName } from './fileName';

describe('isValidFileName', () => {
  test.each(VALID_EXTENSIONS)('accepts a name ending with %s', (ext) => {
    expect(isValidFileName(`counter${ext}`)).toBe(true);
  });

  test('rejects other extensions', () => {
    expect(isValidFileName('notes.txt')).toBe(false);
    expect(isValidFileName('module.vhd')).toBe(false);
    expect(isValidFileName('project')).toBe(false);
  });

  test('rejects names containing a forward slash', () => {
    expect(isValidFileName('rom/a.v')).toBe(false);
    expect(isValidFileName('src/project.v')).toBe(false);
    expect(isValidFileName('/project.v')).toBe(false);
  });

  test('accepts names with underscores and dots', () => {
    expect(isValidFileName('new_module.v')).toBe(true);
    expect(isValidFileName('vga.timing.sv')).toBe(true);
  });
});

describe('INVALID_NAME_MESSAGE', () => {
  test('mentions every valid extension', () => {
    for (const ext of VALID_EXTENSIONS) {
      expect(INVALID_NAME_MESSAGE).toContain(ext);
    }
  });

  test('mentions that slashes are disallowed', () => {
    expect(INVALID_NAME_MESSAGE).toContain('"/"');
  });
});
