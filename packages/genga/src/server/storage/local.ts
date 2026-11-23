import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { StorageAdapter } from './adapter';

const SAFE_KEY = /^[a-z0-9][a-z0-9.-]*$/;

export function localStorageAdapter(directory: string): StorageAdapter {
  const root = path.resolve(directory);
  const resolve = (key: string) => {
    if (!SAFE_KEY.test(key) || key.includes('..')) throw new Error(`Unsafe media key: ${key}`);
    return path.join(root, key.slice(0, 2), key);
  };

  return {
    async put(key, body) {
      const target = resolve(key);
      await mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, body);
      await rename(temporary, target);
    },
    async get(key) {
      const target = resolve(key);
      try {
        const info = await stat(target);
        const stream = Readable.toWeb(createReadStream(target)) as ReadableStream<Uint8Array>;
        return { body: stream, size: info.size };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async delete(key) {
      await rm(resolve(key), { force: true });
    },
  };
}
