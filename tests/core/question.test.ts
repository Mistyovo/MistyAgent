import { describe, expect, it, vi } from 'vitest';

import { QuestionManager, type QuestionRequest } from '#/core/question';

const request: QuestionRequest = {
  id: 'q1',
  question: '选哪个？',
  options: [{ label: '甲' }, { label: '乙' }],
};

describe('QuestionManager', () => {
  it('ask 挂起，reply 兑现 answers', async () => {
    const manager = new QuestionManager();
    const promise = manager.ask(request);
    expect(manager.pendingCount).toBe(1);
    expect(manager.reply('q1', { answers: ['乙'] })).toBe(true);
    await expect(promise).resolves.toEqual({ answers: ['乙'] });
    expect(manager.pendingCount).toBe(0);
  });

  it('reply 未知 id 返回 false', () => {
    const manager = new QuestionManager();
    expect(manager.reply('nope', { answers: ['甲'] })).toBe(false);
  });

  it('重复 id 的 ask 立即落定 cancelled，不影响在途挂起', async () => {
    const manager = new QuestionManager();
    const first = manager.ask(request);
    await expect(manager.ask(request)).resolves.toEqual({ cancelled: true });
    expect(manager.reply('q1', { answers: ['甲'] })).toBe(true);
    await expect(first).resolves.toEqual({ answers: ['甲'] });
  });

  it('cancelAll 落定所有挂起为 cancelled', async () => {
    const manager = new QuestionManager();
    const a = manager.ask(request);
    const b = manager.ask({ ...request, id: 'q2' });
    expect(manager.pendingCount).toBe(2);
    manager.cancelAll();
    await expect(a).resolves.toEqual({ cancelled: true });
    await expect(b).resolves.toEqual({ cancelled: true });
    expect(manager.pendingCount).toBe(0);
  });

  it('signal 已 abort：ask 立即 cancelled，不发 onAsked 通知', async () => {
    const manager = new QuestionManager();
    const onAsked = vi.fn();
    manager.onAsked(onAsked);
    const controller = new AbortController();
    controller.abort();
    await expect(manager.ask(request, controller.signal)).resolves.toEqual({ cancelled: true });
    expect(onAsked).not.toHaveBeenCalled();
    expect(manager.pendingCount).toBe(0);
  });

  it('ask 后 signal abort：落定 cancelled，迟到的 reply 返回 false', async () => {
    const manager = new QuestionManager();
    const controller = new AbortController();
    const promise = manager.ask(request, controller.signal);
    controller.abort();
    await expect(promise).resolves.toEqual({ cancelled: true });
    expect(manager.pendingCount).toBe(0);
    expect(manager.reply('q1', { answers: ['甲'] })).toBe(false);
  });

  it('先挂起再通知：监听器在 onAsked 回调里同步回复也能兑现', async () => {
    const manager = new QuestionManager();
    const seen: QuestionRequest[] = [];
    manager.onAsked((req) => {
      seen.push(req);
      manager.reply(req.id, { answers: ['甲'] });
    });
    await expect(manager.ask(request)).resolves.toEqual({ answers: ['甲'] });
    expect(seen).toEqual([request]);
    expect(manager.pendingCount).toBe(0);
  });
});
