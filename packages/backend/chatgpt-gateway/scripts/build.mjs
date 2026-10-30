import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
await mkdir(root + 'dist', { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ['src/server.ts', 'src/control.ts', 'src/extension.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outExtension: { '.js': '.mjs' },
  alias: { jose: require.resolve('jose') },
});
await copyFile(root + 'compose.yml', root + 'dist/compose.yml');
