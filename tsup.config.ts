import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli/main.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
  // ink/react are bundled; native-ish deps stay external
  noExternal: [/.*/],
  external: ['node-pty', 'fsevents'],
});
