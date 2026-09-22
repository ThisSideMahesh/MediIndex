'use strict';
/**
 * Minimal TypeScript module loader for `node:test`.
 *
 * Phase 7C needs to test real behaviour (what actually gets written to secure
 * storage, what the request body looks like, whether a token is ever logged),
 * not just source text. React Native components still cannot be rendered without
 * a native test renderer, but the pairing logic, credential store, API client and
 * startup routing are plain TypeScript and can be executed directly.
 *
 * How it works: `typescript` (already a devDependency) transpiles each module to
 * CommonJS in memory, and a small `require` shim resolves relative imports to
 * `.ts` / `.tsx` files and swaps native modules for stubs.
 *
 * Nothing here ships in the app bundle.
 */

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const MOBILE_ROOT = path.join(__dirname, '..', '..');

function resolveRelative(specifier, fromDir) {
  const base = path.resolve(fromDir, specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`tsLoader: cannot resolve "${specifier}" from ${fromDir}`);
}

/**
 * Creates an isolated module registry.
 *
 * @param {object}  [opts]
 * @param {object}  [opts.stubs] Map of import specifier -> module object.
 *                               Give stubs `__esModule: true` so TypeScript's
 *                               interop helper hands back the object unchanged
 *                               and later mutations stay visible.
 */
function createTsLoader({ stubs = {} } = {}) {
  const cache = new Map();

  function loadFile(absPath) {
    const cached = cache.get(absPath);
    if (cached) return cached.exports;

    const source = fs.readFileSync(absPath, 'utf8');
    const { outputText } = ts.transpileModule(source, {
      fileName: absPath,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
        jsx: ts.JsxEmit.React,
        isolatedModules: true,
      },
    });

    const moduleObj = { exports: {} };
    // Registered before evaluation so a cycle resolves to the partial exports
    // instead of recursing forever.
    cache.set(absPath, moduleObj);

    const dir = path.dirname(absPath);
    const localRequire = (specifier) => {
      if (Object.prototype.hasOwnProperty.call(stubs, specifier)) return stubs[specifier];
      if (specifier.startsWith('.')) return loadFile(resolveRelative(specifier, dir));
      return require(specifier);
    };

    const factory = new Function(
      'exports', 'require', 'module', '__filename', '__dirname',
      outputText,
    );
    factory(moduleObj.exports, localRequire, moduleObj, absPath, dir);
    return moduleObj.exports;
  }

  return {
    /** Loads a module by its path relative to `mobile/`, e.g. 'src/api/client.ts'. */
    load(relPath) {
      return loadFile(path.join(MOBILE_ROOT, relPath));
    },
  };
}

module.exports = { createTsLoader, MOBILE_ROOT };
