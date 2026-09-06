import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { STACKED_LAYOUT_QUERY } from './SplitPane';

const cssFiles = ['../index.css', './split-pane.css', './file-explorer.css'];

describe('STACKED_LAYOUT_QUERY', () => {
  test.each(cssFiles)('matches the media query in %s', (file) => {
    const css = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
    expect(css).toContain(`@media ${STACKED_LAYOUT_QUERY} {`);
  });
});
