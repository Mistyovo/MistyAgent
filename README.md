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

## 使用

```bash
export MISTY_API_KEY=sk-...        # cmd: set MISTY_API_KEY=sk-...
export MISTY_BASE_URL=https://...  # 可选；MISTY_MODEL 指定模型
npm run build && node dist/cli.js  # 或开发期 npm run dev
```

默认启动 TUI。CLI flags：`--model`、`--base-url`、`--mode <权限模式>`、`-p, --print <prompt>`。

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

### 斜杠命令

TUI 内输入 `/` 开头的命令：

| 命令 | 行为 |
| --- | --- |
| `/help` | 列出全部命令 |
| `/model <name>` | 切换模型（运行时状态，不回写配置） |
| `/mode [name]` | 切换权限模式；无参数显示当前模式 |
| `/compact` | 手动压缩上下文（超过阈值时也会自动触发） |
| `/clear` | 开始新会话（清屏 + 新 transcript） |
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

read / write / edit / bash / glob / grep / todo / agent。
`agent` 是子代理工具（`explore` 代码探索、`plan` 实现规划，只读、独立上下文、
结果回流主会话）；连续 3 次完全相同的工具调用会触发循环防护，强制询问确认。

上下文：启动时从 project root（含 `.git`）到 cwd 逐级收集 `AGENTS.md` 注入
system prompt（总量 32KB 截断）。
