import { spawn } from 'node:child_process';

import { loadSettings, resolveProviderConfig } from '#/config/settings';
import { errorMessage } from '#/core/errors';
import { createProvider } from '#/provider/factory';
import type { StreamedMessagePart } from '#/provider/types';

import { resolveCompetitionClient } from './arena';

export interface SmokeCheck {
  name: string;
  /** 关键检查失败 → 退出码 1；非关键（如 pwn 工具链）只警告 */
  critical: boolean;
  run: () => Promise<string>;
}

export interface SmokeLine {
  name: string;
  critical: boolean;
  ok: boolean;
  detail: string;
}

export async function runSmokeChecks(checks: SmokeCheck[]): Promise<{
  lines: SmokeLine[];
  passed: boolean;
}> {
  const lines: SmokeLine[] = [];
  for (const check of checks) {
    try {
      lines.push({ name: check.name, critical: check.critical, ok: true, detail: await check.run() });
    } catch (error) {
      lines.push({
        name: check.name,
        critical: check.critical,
        ok: false,
        detail: errorMessage(error),
      });
    }
  }
  return { lines, passed: lines.every((line) => line.ok || !line.critical) };
}

export function formatSmokeReport(lines: SmokeLine[]): string {
  const width = Math.max(...lines.map((line) => line.name.length));
  return lines
    .map((line) => {
      const mark = line.ok ? '✓' : line.critical ? '✗' : '⚠';
      return `${mark} ${line.name.padEnd(width)}  ${line.detail}`;
    })
    .join('\n');
}

function runCommand(command: string, args: string[], timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(out.trim());
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}

async function checkModel(): Promise<string> {
  const { settings } = loadSettings(process.cwd());
  const provider = createProvider(resolveProviderConfig(settings));
  const model = settings.provider.defaultModel;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let reply = '';
  try {
    for await (const part of provider.generate({
      model,
      systemPrompt: 'You are a connectivity smoke test.',
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      tools: [],
      signal: controller.signal,
    }) as AsyncIterable<StreamedMessagePart>) {
      if (part.type === 'text-delta') {
        reply += part.text;
      } else if (part.type === 'error') {
        throw part.error;
      } else if (part.type === 'done') {
        break;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  if (reply.trim() === '') {
    throw new Error('model returned an empty response');
  }
  return `${model} replied: ${reply.trim().slice(0, 40)}`;
}

async function checkPlatform(): Promise<string> {
  const client = resolveCompetitionClient(process.env);
  if (client === undefined) {
    throw new Error('MISTY_CTF_TOKEN (or CTF_TOKEN) is not set');
  }
  const questions = await client.listQuestions();
  return `${questions.length} questions visible`;
}

function checkShell(): Promise<string> {
  return process.platform === 'win32'
    ? runCommand('cmd', ['/c', 'echo ok']).then(() => 'cmd.exe available')
    : runCommand('bash', ['-c', 'echo ok']).then(() => 'bash available');
}

function checkPython(): Promise<string> {
  return runCommand('python', ['-c', 'import sys; print(sys.version.split()[0])']).then(
    (version) => `python ${version}`,
  );
}

export function buildDefaultChecks(): SmokeCheck[] {
  return [
    { name: 'model', critical: true, run: checkModel },
    { name: 'platform', critical: true, run: checkPlatform },
    { name: 'shell', critical: true, run: checkShell },
    { name: 'python', critical: true, run: checkPython },
    { name: 'curl', critical: false, run: () => runCommand('curl', ['--version']).then((out) => out.split('\n')[0] ?? 'available') },
    {
      name: 'objdump (pwn)',
      critical: false,
      run: () => runCommand('objdump', ['--version']).then((out) => out.split('\n')[0] ?? 'available'),
    },
  ];
}

export async function runSmokeCommand(): Promise<number> {
  const { lines, passed } = await runSmokeChecks(buildDefaultChecks());
  console.log(formatSmokeReport(lines));
  console.log(passed ? 'smoke: all critical checks passed' : 'smoke: FAILED (critical checks above)');
  return passed ? 0 : 1;
}
