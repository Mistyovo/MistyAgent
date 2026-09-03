# MistyAgent

私人定制 CLI Agent，设计理念对齐 Claude Code，模型层走 OpenAI 兼容 API。

## 开发

```bash
npm install
npm run dev          # tsx 直跑
npm test             # vitest
npm run lint         # oxlint
npm run typecheck
npm run build        # tsup 打包出 dist/cli.js
```

## 架构

```
CLI 入口 (commander)
  └─ TUI 层 (Ink/React)           只渲染事件、提交指令
  └─ Core 层 (loop/工具/权限)      无状态 loop + 事件总线，UI 无关
  └─ Provider 层 (LLM 抽象)        OpenAI 兼容适配器
```

核心机制：指令进（Op）/ 事件出（Event）双通道。依赖方向自上而下，禁止反向。

详见各目录代码与 `docs/`（随里程碑补充）。
