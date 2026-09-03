/**
 * 进程退出辅助。Windows 上 process.exit 与 undici keep-alive socket 的回收
 * 存在竞态：同步 exit 会触发 libuv 断言（win/async.c UV_HANDLE_CLOSING）。
 * 先设 exitCode 让事件循环自然排空；100ms 后仍未退出（socket 驻留）再强制 exit。
 */
export function exitProcess(code: number): void {
  process.exitCode = code;
  const timer = setTimeout(() => {
    process.exit(code);
  }, 100);
  timer.unref();
}
