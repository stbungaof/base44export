import { defineConfig } from 'tsup';

// Bundle the workspace packages (they ship as TS sources); real npm deps stay external.
export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  noExternal: [/^@b44\//],
});
