#!/usr/bin/env node
// Copies the compiled admin stylesheet next to the admin app with a content hash, and writes the
// manifest that `genga.handle` reads to render the HTML shell.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist/admin-app');
const css = readFileSync(path.join(root, 'dist/admin.css'));
const style = `admin-${createHash('sha256').update(css).digest('hex').slice(0, 10)}.css`;
writeFileSync(path.join(out, style), css);
const scripts = readdirSync(out).filter((name) => /^main-[\w-]+\.js$/.test(name));
if (scripts.length !== 1) throw new Error(`The admin app build must write one main-<hash>.js, not ${scripts.length}.`);
const [script] = scripts;
writeFileSync(path.join(out, 'genga-admin.json'), `${JSON.stringify({ script, style }, null, 2)}\n`);
console.log(`admin app: ${script}, ${style}`);
