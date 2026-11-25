// Bundles the server code for Lambda. Run after `vite build`, which writes the
// SPA to dist/server/public.
//
//   dist/server/   -> the Web Function zip: index.js (+ package.json, public/)
//   dist/migrate/  -> the migration Lambda: index.mjs + migrations/*.sql
import { build } from 'esbuild';
import { cpSync, rmSync, writeFileSync } from 'node:fs';

const common = {
  bundle: true,
  platform: 'node',
  target: 'node26',
  format: 'esm',
  // `pg` only loads pg-native when asked to; it is not installed.
  external: ['pg-native'],
  // Some bundled CommonJS dependencies call require() for Node.js built-ins.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'warning',
};

rmSync('dist/server/index.js', { force: true });
await build({ ...common, entryPoints: ['server/src/index.ts'], outfile: 'dist/server/index.js' });
// The Web Functions runtime loads index.js; this makes Node.js treat it as ESM.
writeFileSync('dist/server/package.json', `${JSON.stringify({ type: 'module' }, null, 2)}\n`);

rmSync('dist/migrate', { recursive: true, force: true });
await build({ ...common, entryPoints: ['server/src/migrate.ts'], outfile: 'dist/migrate/index.mjs' });
cpSync('migrations', 'dist/migrate/migrations', { recursive: true });
