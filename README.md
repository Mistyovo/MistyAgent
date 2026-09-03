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

## 配置

分层加载，后者覆盖前者（深合并，数组拼接）：

1. 内置默认值
2. `~/.misty/settings.json`（用户级）
3. `<cwd>/.misty/settings.json`（项目级）
4. 环境变量：`MISTY_API_KEY` / `MISTY_BASE_URL` / `MISTY_MODEL` / `OPENAI_API_KEY`（优先级低于 `MISTY_API_KEY`）
5. CLI flags（内存层）

```jsonc
// .misty/settings.json
{
  "provider": { "type": "openai", "baseURL": "https://api.example.com/v1", "defaultModel": "kimi-k2" },
  "permissionMode": "default",           // default | acceptEdits | plan | bypassPermissions
  "permissionRules": [{ "action": "deny", "tool": "write_file", "pattern": "*.env" }],
  "maxTokens": 8192,
  "temperature": 0.6
}
```

**安全约束：API key 只允许来自环境变量**（`MISTY_API_KEY` 或 `OPENAI_API_KEY`）。
settings.json 中出现 `provider.apiKey` 会被警告并忽略，禁止把密钥写进任何落盘配置。
