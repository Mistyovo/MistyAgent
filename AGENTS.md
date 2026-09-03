# AGENTS.md

## 项目约定

- TypeScript strict 模式，ESM，`#/` 路径别名指向 `src/`
- 分层依赖：cli → tui → core → provider，下层不得 import 上层
- 核心逻辑（core/provider/config）必须有 vitest 单测，测试放 `tests/`
- Commit 用 Conventional Commits（`feat(core): …`、`fix(permission): …`），每里程碑一个 commit
- 注释克制：不写解释"做了什么"的注释，代码自解释
- TUI 组件只渲染事件、提交 Op，禁止直接 import provider 或绕过 core 做事
- 工具失败不中断 agent loop：错误转成 tool result 回喂模型
- API key 只走环境变量（`MISTY_API_KEY` / `OPENAI_API_KEY`），禁止写进任何落盘配置

## 命令

```bash
npm run dev / test / lint / typecheck / build
```

提交前必须 `npm run typecheck && npm run lint && npm test` 全绿。
