import { Project } from '../examples/Project';

export interface RepoRef {
  owner: string;
  repo: string;
}

export function parseRepoUrl(input: string): RepoRef {
  let path = input.trim();

  // Strip protocol and host
  path = path.replace(/^https?:\/\/github\.com\//, '');

  path = path.replace(/\/+$/, '');
  path = path.replace(/\.git$/, '');

  const parts = path.split('/');
  const owner = parts[0];
  const repo = parts[1];

  if (!owner || !repo) {
    throw new Error(`Invalid repo URL: ${input}`);
  }

  return { owner, repo };
}

export interface ProjectInfo {
  title: string;
  author: string;
  sourceFiles: string[];
}

export function extractProjectInfo(doc: Record<string, unknown>): ProjectInfo {
  const project = (doc?.project ?? {}) as Record<string, unknown>;
  return {
    title: (project.title as string) ?? '',
    author: (project.author as string) ?? '',
    sourceFiles: Array.isArray(project.source_files) ? project.source_files : [],
  };
}

export function extractReadmemPaths(sources: Record<string, string>): string[] {
  const paths = new Set<string>();
  const re = /\$readmem[hb]\s*\(\s*"([^"]+)"/g;
  for (const code of Object.values(sources)) {
    for (const match of code.matchAll(re)) {
      paths.add(match[1]);
    }
  }
  return [...paths];
}

function resolveRelativeToSrc(path: string): string {
  const parts = ('src/' + path).split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      resolved.pop();
    } else if (part !== '.') {
      resolved.push(part);
    }
  }
  return resolved.join('/');
}

function githubRawUrl(owner: string, repo: string, branch: string, path: string): string {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
}

export async function loadProjectFromRepo(repoUrl: string): Promise<Project> {
  const { owner, repo } = parseRepoUrl(repoUrl);

  // Start loading YAML parser in parallel with the fetch
  const yamlModulePromise = import('yaml');

  // Try main branch first, fall back to master
  let infoYaml: string | null = null;
  let branch = 'main';
  for (const b of ['main', 'master']) {
    const url = githubRawUrl(owner, repo, b, 'info.yaml');
    const res = await fetch(url);
    if (res.ok) {
      infoYaml = await res.text();
      branch = b;
      break;
    }
  }

  if (infoYaml == null) {
    throw new Error(`Could not fetch info.yaml from ${owner}/${repo}`);
  }

  const { parse } = await yamlModulePromise;
  const { title, author, sourceFiles } = extractProjectInfo(parse(infoYaml));

  if (sourceFiles.length === 0) {
    throw new Error(`No source files found in info.yaml for ${owner}/${repo}`);
  }

  const entries = await Promise.all(
    sourceFiles.map(async (filename) => {
      const url = githubRawUrl(owner, repo, branch, `src/${filename}`);
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Failed to fetch ${filename}: ${res.status}`);
      }
      return [filename, await res.text()] as const;
    }),
  );

  const sources = Object.fromEntries(entries);

  // Scan sources for $readmemh/$readmemb paths and fetch data files
  const readmemPaths = extractReadmemPaths(sources);
  let dataFiles: Record<string, string> | undefined;
  if (readmemPaths.length > 0) {
    const dataEntries = await Promise.all(
      readmemPaths.map(async (literalPath) => {
        const resolvedPath = resolveRelativeToSrc(literalPath);
        const url = githubRawUrl(owner, repo, branch, resolvedPath);
        try {
          const res = await fetch(url);
          if (!res.ok) return null;
          return [literalPath, await res.text()] as const;
        } catch {
          return null;
        }
      }),
    );
    const validEntries = dataEntries.filter((e): e is [string, string] => e != null);
    if (validEntries.length > 0) {
      dataFiles = Object.fromEntries(validEntries);
    }
  }

  return {
    id: `${owner}/${repo}`,
    name: title || repo,
    author: author || owner,
    sources,
    dataFiles,
  };
}
