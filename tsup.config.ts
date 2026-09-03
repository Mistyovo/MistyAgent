import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli/main.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // banner 会加到每个输出 chunk 顶部：shebang + createRequire 垫片，
  // 让分包后的 CJS 依赖（commander/react-reconciler 等）里的 require 调用可用
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __mistyCreateRequire } from 'node:module';",
      'const require = __mistyCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  // ink/react are bundled; native-ish deps stay external
  // react-devtools-core 只在 DEV=true 时被 ink 动态加载（有兜底提示），
  // 从 noExternal 排除（负向前瞻）并标为 external，避免打包期解析失败
  noExternal: [/^(?!react-devtools-core$).*$/],
  external: ['node-pty', 'fsevents', 'react-devtools-core'],
});
