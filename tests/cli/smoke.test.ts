import { describe, expect, it } from 'vitest';

import { formatSmokeReport, runSmokeChecks, type SmokeCheck } from '#/cli/smoke';

describe('runSmokeChecks', () => {
  it('全过 → passed；非关键失败 → 仍 passed；关键失败 → 不通过', async () => {
    const ok: SmokeCheck = { name: 'model', critical: true, run: async () => 'replied OK' };
    const warnFail: SmokeCheck = {
      name: 'objdump',
      critical: false,
      run: async () => {
        throw new Error('not found');
      },
    };
    const criticalFail: SmokeCheck = {
      name: 'platform',
      critical: true,
      run: async () => {
        throw new Error('token missing');
      },
    };
    expect((await runSmokeChecks([ok, warnFail])).passed).toBe(true);
    const failed = await runSmokeChecks([ok, criticalFail]);
    expect(failed.passed).toBe(false);
    expect(failed.lines[1]!.detail).toBe('token missing');
  });

  it('报告行 ✓/✗/⚠ 标记与详情', () => {
    const report = formatSmokeReport([
      { name: 'model', critical: true, ok: true, detail: 'replied OK' },
      { name: 'objdump (pwn)', critical: false, ok: false, detail: 'not found' },
    ]);
    expect(report).toContain('✓ model');
    expect(report).toContain('⚠ objdump (pwn)');
    expect(report).toContain('not found');
  });
});
