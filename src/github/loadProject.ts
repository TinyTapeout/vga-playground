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

export function extractIncludePaths(sources: Record<string, string>): string[] {
  const paths = new Set<string>();
  const re = /`include\s+"([^"]+)"/g;
  for (const code of Object.values(sources)) {
    for (const match of code.matchAll(re)) {
      paths.add(match[1]);
    }
  }
  // Exclude files already present in sources
  for (const name of Object.keys(sources)) {
    paths.delete(name);
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

async function tryFetchFiles(
  paths: string[],
  toUrl: (path: string) => string,
): Promise<[string, string][]> {
  const entries = await Promise.all(
    paths.map(async (path) => {
      try {
        const res = await fetch(toUrl(path));
        if (!res.ok) return null;
        return [path, await res.text()] as const;
      } catch {
        return null;
      }
    }),
  );
  return entries.filter((e): e is [string, string] => e != null);
}

export async function loadProjectFromRepo(
  repoUrl: string,
  branchName: string | null,
): Promise<Project> {
  const { owner, repo } = parseRepoUrl(repoUrl);

  // Start loading YAML parser in parallel with the fetch
  const yamlModulePromise = import('yaml');

  // Try given branch first, then fall back to main branch then master
  const branchOptions = [...(branchName !== null ? [branchName] : []), 'main', 'master'];
  let infoYaml: string | null = null;
  let branch = 'main';
  for (const b of branchOptions) {
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

  // Fetch header files referenced via `include
  const includeFiles = await tryFetchFiles(extractIncludePaths(sources), (f) =>
    githubRawUrl(owner, repo, branch, `src/${f}`),
  );
  for (const [name, content] of includeFiles) {
    sources[name] = content;
  }

  // Fetch data files referenced via $readmemh/$readmemb
  const dataEntries = await tryFetchFiles(extractReadmemPaths(sources), (p) =>
    githubRawUrl(owner, repo, branch, resolveRelativeToSrc(p)),
  );
  const dataFiles = dataEntries.length > 0 ? Object.fromEntries(dataEntries) : undefined;

  return {
    id: `${owner}/${repo}`,
    name: title || repo,
    author: author || owner,
    sources,
    dataFiles,
  };
}
