function stripComments(src: string): string {
  return src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

export function detectTopModule(sources: Record<string, string>): string {
  const ordered = Object.entries(sources).sort(([a], [b]) =>
    a === 'project.v' ? -1 : b === 'project.v' ? 1 : a.localeCompare(b),
  );
  for (const [, src] of ordered) {
    const match = stripComments(src).match(/^\s*module\s+(tt_um_\w+)/m);
    if (match) return match[1];
  }
  const projectV = sources['project.v'];
  if (projectV) {
    const match = stripComments(projectV).match(/^\s*module\s+(\w+)/m);
    if (match) return match[1];
  }
  return 'tt_um_vga_example';
}
