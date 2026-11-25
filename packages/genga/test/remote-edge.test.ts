import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const STATEMENT = /(?:^|\n)\s*(import|export)\s+(type\s+)?(?:([\s\S]*?)\s+from\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
const NODE_ONLY = [/\bBuffer\b/, /\bprocess\./, /\brequire\(/, /\b__dirname\b/];

function isTypeOnly(kind: string, typeKeyword: string | undefined, clause: string | undefined) {
  if (typeKeyword) return true;
  if (kind === 'export' && clause === undefined) return false;
  const names = /^\{([\s\S]*)\}$/.exec(clause?.trim() ?? '')?.[1];
  if (names === undefined) return false;
  const items = names
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 && items.every((item) => item.startsWith('type '));
}

function resolve(from: string, specifier: string): string {
  const base = path.resolve(path.dirname(from), specifier);
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Cannot resolve ${specifier} from ${path.relative(src, from)}`);
}

function stripComments(code: string) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The runtime import graph of a source file, without type-only imports. */
function graph(entry: string) {
  const files = new Set<string>();
  const problems: string[] = [];
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    const code = stripComments(readFileSync(file, 'utf8'));
    const specifiers: string[] = [];
    for (const [, kind, typeKeyword, clause, specifier] of code.matchAll(STATEMENT)) {
      if (!isTypeOnly(kind, typeKeyword, clause)) specifiers.push(specifier);
    }
    for (const [, specifier] of code.matchAll(DYNAMIC)) specifiers.push(specifier);
    for (const specifier of specifiers) {
      if (specifier.startsWith('.')) visit(resolve(file, specifier));
      else problems.push(`${path.relative(src, file)} imports ${specifier}`);
    }
    for (const pattern of NODE_ONLY) {
      if (pattern.test(code)) problems.push(`${path.relative(src, file)} uses ${pattern.source}`);
    }
  };
  visit(entry);
  return { files: [...files].map((file) => path.relative(src, file)), problems };
}

describe('genga/remote', () => {
  it('imports no package and no Node built-in, at any depth', () => {
    const { files, problems } = graph(path.join(src, 'remote/index.ts'));
    expect(problems).toEqual([]);
    expect(files).toContain('remote/remote-source.ts');
    expect(files).not.toContain('server/index.ts');
    expect(files).not.toContain('config.ts');
  });

  it('finds a Node import when one is there', () => {
    const { problems } = graph(path.join(src, 'server/source.ts'));
    expect(problems.some((problem) => /imports (postgres|node:crypto|sharp)/.test(problem))).toBe(true);
  });
});
