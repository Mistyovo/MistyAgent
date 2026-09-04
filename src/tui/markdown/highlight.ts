import type { Root, RootContent } from 'hast';
import { common, createLowlight } from 'lowlight';

import type { Theme } from '../theme';

import type { StyledSegment } from './styled';

/**
 * 代码块语法高亮：lowlight（highlight.js 的 hast 接口）把代码 token 化，
 * hljs 类别映射到既有主题 token（不新增色板字段）。识别不了的语言返回
 * null，调用方按 codeBlock 纯色降级。
 */

const lowlight = createLowlight(common);

function hljsClassColor(className: unknown, theme: Theme): string | undefined {
  if (!Array.isArray(className)) {
    return undefined;
  }
  for (const cls of className) {
    switch (cls) {
      case 'hljs-comment':
      case 'hljs-quote':
      case 'hljs-doctag':
        return theme.dim;
      case 'hljs-string':
      case 'hljs-regexp':
      case 'hljs-addition':
      case 'hljs-meta-string':
        return theme.success;
      case 'hljs-number':
      case 'hljs-literal':
      case 'hljs-symbol':
      case 'hljs-bullet':
      case 'hljs-link':
        return theme.markdown.codeInline;
      case 'hljs-keyword':
      case 'hljs-selector-tag':
      case 'hljs-built_in':
      case 'hljs-meta':
        return theme.markdown.heading;
      case 'hljs-title':
      case 'hljs-section':
      case 'hljs-name':
        return theme.accent;
      case 'hljs-type':
      case 'hljs-attr':
      case 'hljs-attribute':
      case 'hljs-variable':
      case 'hljs-template-variable':
      case 'hljs-selector-attr':
      case 'hljs-selector-class':
      case 'hljs-selector-id':
        return theme.warning;
      case 'hljs-deletion':
        return theme.markdown.diffRemove;
      default:
        break;
    }
  }
  return undefined;
}

function walk(node: Root | RootContent, color: string, theme: Theme, out: StyledSegment[]): void {
  if (node.type === 'text') {
    if (node.value !== '') {
      out.push({ text: node.value, color });
    }
    return;
  }
  const children = node.type === 'root' || node.type === 'element' ? node.children : [];
  const next = node.type === 'element' ? (hljsClassColor(node.properties?.className, theme) ?? color) : color;
  for (const child of children) {
    walk(child, next, theme, out);
  }
}

/** 高亮为逐行段序列（跨行 span 的样式随行延续）；语言未注册或解析失败返回 null */
export function highlightCodeLines(
  code: string,
  lang: string | undefined,
  theme: Theme,
): StyledSegment[][] | null {
  if (lang === undefined || lang === '' || !lowlight.registered(lang)) {
    return null;
  }
  let root: Root;
  try {
    root = lowlight.highlight(lang, code);
  } catch {
    return null;
  }
  const segments: StyledSegment[] = [];
  walk(root, theme.markdown.codeBlock, theme, segments);
  const lines: StyledSegment[][] = [[]];
  for (const segment of segments) {
    const parts = segment.text.split('\n');
    for (const [index, part] of parts.entries()) {
      if (index > 0) {
        lines.push([]);
      }
      if (part !== '') {
        lines.at(-1)!.push({ ...segment, text: part });
      }
    }
  }
  return lines;
}
