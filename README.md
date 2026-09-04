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
  "fallbackModels": ["kimi-k1.5", "gpt-5-mini"],  // 主模型失败时依次降级的备用模型
  "permissionMode": "default",           // default | acceptEdits | plan | bypassPermissions
  "permissionRules": [{ "action": "deny", "tool": "write_file", "pattern": "*.env" }],
  "maxTokens": 8192,
  "temperature": 0.6
}
```

**错误恢复**（对标 Claude Code）：

- **传输层重试**：429 / 408 / 5xx / 网络错误在流出任何内容前按指数退避重试（1s/2s/4s，3 次）
- **max_tokens 截断升级**：响应 finish_reason 为 `length` 且未流出可见内容时，maxTokens
  自动翻倍重发该步（默认 8192 → 16384 → 32768 → 65536 封顶，最多升级 3 次）；
  已流出部分内容则不重发（避免重复上屏），turn 照常推进；超过封顶以 error 收尾
- **模型 fallback 链**：不可重试错误（400/401/403/404 等）或单模型重试耗尽后，自动按
  `fallbackModels` 顺序切换备用模型重试该步，每个模型有独立的传输层重试预算。
  上下文溢出（context-overflow）优先走响应式压缩，不消耗 fallback 链。
  切换发出 `model-fallback` 事件（TUI 落暗色提示、状态栏模型名更新；print 模式写 stderr）。
  **fallback 仅当前 turn 生效**：后续 step 沿用切换后的模型，新 turn 从主模型重新开始

**安全约束：API key 只允许来自环境变量**（`MISTY_API_KEY` 或 `OPENAI_API_KEY`）。
settings.json 中出现 `provider.apiKey` 会被警告并忽略，禁止把密钥写进任何落盘配置。

### Hooks

settings.json 可配置 shell 命令钩子，在工具执行前后 / turn 结束时触发（对标
Claude Code 的 PreToolUse/PostToolUse/Stop hooks）：

```jsonc
{
  "hooks": {
    "preToolUse":  [{ "matcher": "write|edit", "command": "node scripts/check.js" }],
    "postToolUse": [{ "matcher": "bash", "command": "node scripts/log.js" }],
    "stop":        [{ "command": "node scripts/notify.js" }]
  }
}
```

- `matcher` 是对工具名匹配的正则字符串（仅 preToolUse/postToolUse 有效），省略 = 匹配全部
- 命令经系统 shell 执行（Windows 为 cmd.exe，与 bash 工具一致），工作目录为会话 cwd
- 钩子输入经 **stdin** 传 JSON：`{ event, toolName, input, output, isError, cwd }`
  （字段按事件裁剪，stop 只有 event/cwd）；环境变量附带 `MISTY_HOOK_EVENT` / `MISTY_HOOK_TOOL_NAME`
- **preToolUse 可阻断工具**：进程 exit code 非 0，或 stdout 输出
  `{"decision":"deny","reason":"..."}`，reason 会作为 isError 结果回喂模型
- postToolUse / stop 的 stdout 非空时作为提示上屏（不进消息历史）
- 单个钩子超时 30s 后终止；钩子崩溃 / 超时只记警告，不阻断主流程
- hooks 数组在分层合并时拼接累加（user 层与 project 层的钩子都会生效）
- 钩子命令不进权限审批（用户自己配置的信任代码），也不触发循环防护

### MCP（Model Context Protocol）

settings.json 可配置 MCP servers（对标 Claude Code 的 MCP 集成），其工具并入
Agent 工具池，名字加 `mcp__<server>__<tool>` 前缀避免与内置工具冲突：

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "env": { "FOO": "bar" }   // 可选：追加到子进程环境（默认继承 PATH 等安全变量）
    }
  }
}
```

- v1 仅支持 stdio transport（command + args + env）；SSE/HTTP transport 留扩展位
- 启动时并行连接所有 server（单个 10s 超时），连接失败的 server 降级为 warning
  不阻断启动；TUI 内 `/mcp` 查看各 server 连接状态与工具数
- MCP 工具按保守策略参与权限：`default` 模式弹审批；可用 permissionRules 放行，
  `tool` 字段支持精确工具名或 glob（如 `mcp__filesystem__*` 放行整组工具）
- MCP 工具的 inputSchema 是 JSON Schema，原样透传给模型；参数校验在 server 端完成
- 进程退出时自动断开全部连接并终止子进程

## 使用

```bash
export MISTY_API_KEY=sk-...        # cmd: set MISTY_API_KEY=sk-...
export MISTY_BASE_URL=https://...  # 可选；MISTY_MODEL 指定模型
npm run build && node dist/cli.js  # 或开发期 npm run dev
```

默认启动 TUI。CLI flags：`--model`、`--fallback <model>`（可多次使用，追加到 fallbackModels 链尾）、
`--base-url`、`--mode <权限模式>`、`-p, --print <prompt>`。

### TUI 键位

| 键位 | 行为 |
| --- | --- |
| Enter | 提交输入（turn 进行中则进入队列，输入框下方显示排队计数） |
| ↑ / ↓ | 翻会话内输入历史 |
| ← / → | 移动输入光标；审批弹窗中移动选项 |
| Shift+Tab | 循环切换权限模式（状态栏即时反映） |
| Esc | 中断进行中的 turn；审批弹窗打开时等同拒绝 |
| 1 / 2 / 3 | 审批弹窗：Yes / Yes 且本会话不再询问同类操作 / No |
| Ctrl+C | 第一次提示"再按一次退出"（turn 在飞则顺手中断），3 秒内第二次退出 |

输入框支持粘贴多行文本（Windows 终端粘贴的 \r\n 会归一化）。
Windows 终端差异：ConPTY 的 Backspace 到达为 `\x7f`，ink 解析为 delete，
因此 backspace/delete 统一按"删光标前一个字符"处理。

### 无头模式（print）

`misty -p "<prompt>"` 跑一个 turn 后退出：assistant 文本流式写 stdout，
工具调用摘要与错误写 stderr，互不污染。审批请求无法交互，自动拒绝并回喂模型说明。

退出码：`completed` → 0；`error` / `max-steps` → 1；`interrupted`（Ctrl+C/SIGINT）→ 130。

```bash
misty -p "把 README 里的错别字改了" --mode acceptEdits
echo $?
```

### 权限模式

| 模式 | 状态栏 | 语义 |
| --- | --- | --- |
| `default` | `? default` | 写操作与命令执行需要审批 |
| `acceptEdits` | `⏵ accept edits` | 文件写/编辑自动放行，bash 仍需审批 |
| `plan` | `⏸ plan mode` | 只读模式，写/执行直接拒绝（不弹审批） |
| `bypassPermissions` | `⚠ bypass permissions` | 全部放行，仅受 deny 规则约束 |

初始模式来自配置 `permissionMode` 或 `--mode`；TUI 内 Shift+Tab 运行时循环切换，
对后续判定立即生效。审批弹窗选 2（don't ask again）会把该次操作累积为会话级
allow 规则（bash 按命令首词、write/edit 按文件路径），重启后失效。

plan 是完整的计划模式闭环（对标 Claude Code）：模型判断任务复杂时可调用
`enter_plan_mode` 主动进入（Shift+Tab 切到 plan / `--mode plan` 等价进入），
此期间只读探索，system prompt 每步注入计划指引；调研完成后模型用
`exit_plan_mode` 提交计划全文，弹窗经用户批准后退出（切回进入前的模式）并开始执行，
被拒绝则带反馈修订后重新提交。Shift+Tab 从 plan 切走等价于退出计划模式。

### 斜杠命令

TUI 内输入 `/` 开头的命令：

| 命令 | 行为 |
| --- | --- |
| `/help` | 列出全部命令 |
| `/model <name>` | 切换模型（运行时状态，不回写配置） |
| `/mode [name]` | 切换权限模式；无参数显示当前模式 |
| `/compact` | 手动压缩上下文（超过阈值时也会自动触发） |
| `/clear` | 开始新会话（清屏 + 新 transcript） |
| `/mcp` | 列出 MCP server 连接状态与工具数 |
| `/exit` | 退出 |

### 会话恢复

每个会话实时落盘到 `~/.misty/projects/<sanitized-cwd>/<sessionId>.jsonl`
（用户消息先落盘再调 API，进程被杀也不丢）。恢复：

```bash
misty --continue          # 恢复最近会话
misty --resume            # 只有一个会话时直接恢复；多个时列出供选择
misty --resume <id前缀>   # 恢复指定会话
```

### 内置工具

read / write / edit / bash / glob / grep / todo / agent / web_fetch / web_search /
ask_user / enter_plan_mode / exit_plan_mode。
`agent` 是子代理工具（内置 `explore` 代码探索、`plan` 实现规划，只读、独立上下文、
结果回流主会话；`run_in_background=true` 时后台运行并立即返回 taskId，用
`task_output` 取结果、`task_stop` 中断，结束时经 task-finished 事件通知，与 bash
后台任务共用同一任务管理器）；`web_fetch` 抓取网页（HTML 转纯文本、30000 字符截断、
15s 超时），`web_search` 用 DuckDuckGo lite 免 key 搜索（可能受地区/频率限制），
两者均为只读；连续 3 次完全相同的工具调用会触发循环防护，强制询问确认。

上下文：启动时从 project root（含 `.git`）到 cwd 逐级收集 `AGENTS.md` 注入
system prompt（总量 32KB 截断）。

### 自定义子代理

对标 Claude Code 的 `.claude/agents/*.md`：在 `~/.misty/agents/`（用户级）或
`<cwd>/.misty/agents/`（项目级，同名覆盖用户级）放置 Markdown 文件即可注册新的
`subagent_type`，启动时加载，坏文件降级为警告不阻断启动。

```markdown
---
name: reviewer
description: 代码评审：审查改动并输出问题清单
tools: read, glob, grep     # 可选，逗号分隔或 dash 列表；缺省 read/glob/grep
model: kimi-k2              # 可选，覆盖默认模型
---

你是代码评审子代理。关注正确性、边界条件与安全问题，输出按严重度排序的问题清单（含文件与行号）。
```

- `name` / `description` 必填（`name` 只允许字母/数字/连字符/下划线），正文为子代理的
  system prompt（自动追加 cwd 与运行环境说明）；`description` 是主代理选择子代理的依据
- `tools` 白名单可选：`read / write / edit / glob / grep / bash / web_fetch / web_search`
- 与内置 `explore` / `plan` 同名的自定义定义被内置遮蔽
- 子代理沿用主会话的权限判定（模式/规则/会话级"不再询问"累积），但**没有交互审批能力**：
  判定为需要审批的操作会被自动拒绝并回喂模型（模型可改用只读方式或在结论里说明）。
  含写工具的自定义代理建议配合 `--mode acceptEdits` 或 `permissionRules` 使用
