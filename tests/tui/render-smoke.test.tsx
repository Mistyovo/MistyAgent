import path from 'node:path';

import { renderToString } from 'ink';
import { describe, expect, it } from 'vitest';

import { Session } from '#/core/session/session';
import { createBuiltinRegistry } from '#/core/tools/builtin';
import { App } from '#/tui/App';
import {
  ApprovalDialog,
  approvalDetailLines,
} from '#/tui/components/ApprovalDialog';
import { StatusBar } from '#/tui/components/StatusBar';
import { TodoList } from '#/tui/components/TodoList';

import { FakeProvider } from '../core/fake-provider';

describe('StatusBar 冒烟渲染', () => {
  it('显示目录 basename、模型、权限模式符号与 token 用量', () => {
    const output = renderToString(
      <StatusBar
        cwd={path.join('some', 'where', 'mistyapp')}
        model="gpt-5-mini"
        mode="default"
        usage={{ inputTokens: 1200, outputTokens: 300 }}
        busy={false}
        runningTasks={0}
        exitArmed={false}
      />,
    );
    expect(output).toContain('mistyapp');
    expect(output).toContain('gpt-5-mini');
    expect(output).toContain('? default');
    expect(output).toContain('↑1.2k');
    expect(output).toContain('↓300');
    expect(output).not.toContain('⚙');
  });

  it('按模式元数据切换显示（plan 模式）', () => {
    const output = renderToString(
      <StatusBar
        cwd={path.join('mistyapp')}
        model="m"
        mode="plan"
        usage={null}
        busy={true}
        runningTasks={0}
        exitArmed={false}
      />,
    );
    expect(output).toContain('⏸ plan mode');
    expect(output).not.toContain('↑');
  });

  it('有运行中后台任务时显示计数', () => {
    const output = renderToString(
      <StatusBar
        cwd={path.join('mistyapp')}
        model="m"
        mode="default"
        usage={null}
        busy={false}
        runningTasks={2}
        exitArmed={false}
      />,
    );
    expect(output).toContain('⚙ 2');
  });
});

describe('approvalDetailLines', () => {
  it('bash：显示完整命令', () => {
    const lines = approvalDetailLines({
      id: 'c1',
      toolName: 'bash',
      describeCall: 'Bash git status',
      input: { command: 'git status' },
      reason: 'r',
    });
    expect(lines).toEqual(['git status']);
  });

  it('write：路径 + 内容预览，超过 20 行截断', () => {
    const content = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n');
    const lines = approvalDetailLines({
      id: 'c2',
      toolName: 'write',
      describeCall: 'Write a.ts',
      input: { path: 'a.ts', content },
      reason: 'r',
    });
    expect(lines[0]).toBe('路径：a.ts');
    expect(lines).toHaveLength(1 + 20 + 1);
    expect(lines.at(-1)).toContain('截断');
  });

  it('edit：old/new 以 - / + 前缀展示', () => {
    const lines = approvalDetailLines({
      id: 'c3',
      toolName: 'edit',
      describeCall: 'Edit a.ts',
      input: { path: 'a.ts', old_string: 'foo', new_string: 'bar\nbaz' },
      reason: 'r',
    });
    expect(lines).toEqual(['路径：a.ts', '- foo', '+ bar', '+ baz']);
  });

  it('其他工具：回退为 JSON 预览', () => {
    const lines = approvalDetailLines({
      id: 'c4',
      toolName: 'read',
      describeCall: 'Read a.ts',
      input: { path: 'a.ts' },
      reason: 'r',
    });
    expect(lines.join('\n')).toContain('"path": "a.ts"');
  });
});

describe('ApprovalDialog 冒烟渲染', () => {
  it('显示工具摘要、原因、详情与三个选项', () => {
    const output = renderToString(
      <ApprovalDialog
        request={{
          id: 'c1',
          toolName: 'bash',
          describeCall: 'Bash git status',
          input: { command: 'git status' },
          reason: 'bash 需要用户确认后才能执行',
        }}
        cwd={process.cwd()}
        onReply={() => {}}
      />,
    );
    expect(output).toContain('需要审批：Bash git status');
    expect(output).toContain('git status');
    expect(output).toContain('1. Yes');
    expect(output).toContain("don't ask again for Bash(git *)");
    expect(output).toContain('3. No');
  });
});

describe('TodoList 冒烟渲染', () => {
  it('按状态渲染符号，in_progress 用 activeForm 文案', () => {
    const output = renderToString(
      <TodoList
        todos={[
          { content: '实现功能', status: 'in_progress', activeForm: '正在实现功能' },
          { content: '写测试', status: 'pending' },
          { content: '读代码', status: 'done' },
        ]}
      />,
    );
    expect(output).toContain('▶ 正在实现功能');
    expect(output).toContain('☐ 写测试');
    expect(output).toContain('☑ 读代码');
  });

  it('空列表不渲染任何内容', () => {
    expect(renderToString(<TodoList todos={[]} />)).toBe('');
  });
});

describe('App 冒烟渲染', () => {
  it('整树渲染出输入框提示与状态栏（idle 状态）', () => {
    const registry = createBuiltinRegistry();
    const session = new Session({
      provider: new FakeProvider([]),
      model: 'fake-model',
      systemPrompt: 'system',
      tools: registry.list(),
      cwd: process.cwd(),
    });
    const output = renderToString(
      <App session={session} registry={registry} model="fake-model" cwd={process.cwd()} />,
    );
    expect(output).toContain('输入消息，Enter 发送');
    expect(output).toContain('? default');
    expect(output).toContain('fake-model');
  });
});
