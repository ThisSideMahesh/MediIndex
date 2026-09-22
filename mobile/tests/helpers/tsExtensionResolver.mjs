/**
 * Node ESM loader hook used ONLY by the real-SQLite integration test run.
 *
 * Purpose: mobile/src/**\/*.ts uses extensionless relative imports
 * (e.g. `from '../utils/idempotency'`), which is normal, valid TypeScript/bundler
 * style and matches every other file in this codebase. Node's native type-stripping
 * mode (--experimental-strip-types) only strips types; it does not add bundler-style
 * extension resolution. Rather than editing production import statements across the
 * mobile source tree just to satisfy a test runner, this loader teaches Node's ESM
 * resolver to also try a `.ts` suffix when a bare relative specifier doesn't resolve.
 *
 * This file is not imported by any production code and does not change what ships
 * in the app. It is only registered via `--import` for the real-SQLite test file.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) throw err;

    const parentPath = context.parentURL ? fileURLToPath(context.parentURL) : process.cwd();
    const basePath = path.resolve(path.dirname(parentPath), specifier);

    for (const ext of ['.ts', '.tsx', '/index.ts']) {
      const candidate = basePath + ext;
      if (existsSync(candidate)) {
        return nextResolve(pathToFileURL(candidate).href, context);
      }
    }
    throw err;
  }
}
