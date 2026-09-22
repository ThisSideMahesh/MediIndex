/**
 * Bootstrap file: registers `tsExtensionResolver.mjs` as an ESM resolve hook using
 * `node:module`'s `register()` API. Meant to be passed via `node --import` so the
 * hook is active before the test file's own imports are resolved.
 *
 * Only used by the real-SQLite integration test run (see package.json script
 * `test:sqlite-integration`). Does not affect production code or the default
 * `npm test` mock/unit test run.
 */
import { register } from 'node:module';

register('./tsExtensionResolver.mjs', import.meta.url);
