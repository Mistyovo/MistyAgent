import { homedir } from 'node:os';
import path from 'node:path';

export interface SensitivePathResult {
  sensitive: boolean;
  /** 命中时说明命中的保护项 */
  reason?: string;
}

const SENSITIVE_DIR_REASONS: Record<string, string> = {
  '.git': 'Git 版本库目录 .git/',
  '.ssh': 'SSH 配置目录 .ssh/',
  '.gnupg': 'GnuPG 密钥目录 .gnupg/',
};

/** .env 与 .env.<suffix>；config.env / foo.env 不算 */
const ENV_BASENAME = /^\.env(\..+)?$/;

function isInside(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * 敏感路径安全护栏（对齐 Claude Code safetyCheck）：任何权限模式（含 bypassPermissions）
 * 都不可写入，settings 里的 allow 规则也不能覆盖；deny 规则仍可叠加更多保护。
 * 清单：.git/（含嵌套子目录与 .git 本身）、.ssh/、.gnupg/、.aws/credentials、
 * ~/.misty/projects/（会话 transcript 落盘处）、.env*、**\/*.pem、id_rsa* / id_ed25519*。
 * 项目 .misty/settings.json 是用户自己写的配置，不在保护之列。
 * 路径分隔符兼容 / 与 \；Windows 文件系统大小写不敏感，一律按小写比较。
 */
export function checkSensitivePath(absPath: string): SensitivePathResult {
  const normalized = path.normalize(absPath);
  const segments = normalized.split(/[\\/]+/).map((segment) => segment.toLowerCase());
  const basename = segments.at(-1) ?? '';

  for (const segment of segments) {
    const reason = SENSITIVE_DIR_REASONS[segment];
    if (reason !== undefined) {
      return { sensitive: true, reason };
    }
  }
  if (segments.includes('.aws') && basename === 'credentials') {
    return { sensitive: true, reason: 'AWS 凭证文件 .aws/credentials' };
  }
  if (isInside(path.join(homedir(), '.misty', 'projects'), normalized)) {
    return { sensitive: true, reason: 'Misty 会话数据目录 ~/.misty/projects/' };
  }
  if (ENV_BASENAME.test(basename)) {
    return { sensitive: true, reason: '密钥文件 .env*' };
  }
  if (basename.endsWith('.pem')) {
    return { sensitive: true, reason: '证书/私钥文件 *.pem' };
  }
  if (basename.startsWith('id_rsa') || basename.startsWith('id_ed25519')) {
    return { sensitive: true, reason: 'SSH 私钥文件 id_rsa*/id_ed25519*' };
  }
  return { sensitive: false };
}
