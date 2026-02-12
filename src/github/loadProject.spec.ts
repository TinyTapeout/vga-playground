import { describe, expect, it } from 'vitest';
import { extractProjectInfo, extractReadmemPaths, parseRepoUrl } from './loadProject';

describe('parseRepoUrl', () => {
  it('parses owner/repo short form', () => {
    expect(parseRepoUrl('urish/tt-rings')).toEqual({ owner: 'urish', repo: 'tt-rings' });
  });

  it('parses full GitHub URL', () => {
    expect(parseRepoUrl('https://github.com/urish/tt-rings')).toEqual({
      owner: 'urish',
      repo: 'tt-rings',
    });
  });

  it('handles trailing slash', () => {
    expect(parseRepoUrl('urish/tt-rings/')).toEqual({ owner: 'urish', repo: 'tt-rings' });
  });

  it('handles .git suffix', () => {
    expect(parseRepoUrl('https://github.com/urish/tt-rings.git')).toEqual({
      owner: 'urish',
      repo: 'tt-rings',
    });
  });

  it('handles .git suffix with trailing slash', () => {
    expect(parseRepoUrl('urish/tt-rings.git/')).toEqual({ owner: 'urish', repo: 'tt-rings' });
  });

  it('handles extra path segments', () => {
    expect(parseRepoUrl('https://github.com/urish/tt-rings/tree/main/src')).toEqual({
      owner: 'urish',
      repo: 'tt-rings',
    });
  });

  it('throws for invalid input', () => {
    expect(() => parseRepoUrl('invalid')).toThrow();
  });
});

describe('extractProjectInfo', () => {
  it('extracts title, author, and source_files', () => {
    const result = extractProjectInfo({
      project: {
        title: 'Rings',
        author: 'Uri Shaked',
        source_files: ['project.v', 'hvsync_generator.v'],
      },
    });
    expect(result.title).toBe('Rings');
    expect(result.author).toBe('Uri Shaked');
    expect(result.sourceFiles).toEqual(['project.v', 'hvsync_generator.v']);
  });

  it('handles missing fields gracefully', () => {
    const result = extractProjectInfo({ project: { description: 'some description' } });
    expect(result.title).toBe('');
    expect(result.author).toBe('');
    expect(result.sourceFiles).toEqual([]);
  });
});

describe('extractReadmemPaths', () => {
  it('extracts paths from $readmemh', () => {
    const sources = {
      'main.v': '$readmemh("../data/foo.hex", arr);',
    };
    expect(extractReadmemPaths(sources)).toEqual(['../data/foo.hex']);
  });

  it('extracts paths from $readmemb', () => {
    const sources = {
      'main.v': '$readmemb("data.bin", arr);',
    };
    expect(extractReadmemPaths(sources)).toEqual(['data.bin']);
  });

  it('deduplicates identical paths across multiple files', () => {
    const sources = {
      'a.v': '$readmemh("../data/palette.hex", r);',
      'b.v': '$readmemh("../data/palette.hex", g);',
    };
    expect(extractReadmemPaths(sources)).toEqual(['../data/palette.hex']);
  });

  it('returns empty array when no $readmem calls exist', () => {
    const sources = {
      'main.v': 'module top(); endmodule',
    };
    expect(extractReadmemPaths(sources)).toEqual([]);
  });
});
