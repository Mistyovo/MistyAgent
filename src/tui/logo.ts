/**
 * Misty 吉祥物「雾灵」：一块实心的小雾魂——▓ 眯眼 + ▀ 张嘴，底部融进
 * ░▒▓ 雾浪里（阴影字符本身就是"雾"的渐变语义）。
 * - narrow 终端：色块像素版（█▓░ 均为歧义宽字符，legacy-cjk 会按 2 格
 *   渲染撑歪比例，故回退纯 ASCII 色块版，等宽 1 格安全）
 * - dim 标记的行（雾浪）由调用方用暗色渲染，制造身体→雾气的消散层次
 * - 只作欢迎横幅用；打印/无头模式不渲染 banner
 */

export interface LogoLine {
  text: string;
  /** 雾浪/氛围行：用主题暗色渲染 */
  dim?: boolean;
}

/** narrow 终端的色块雾灵（6 行，宽 ≤ 13 列） */
export const LOGO_NARROW: readonly LogoLine[] = [
  { text: '  ▄███████▄' },
  { text: ' ███████████' },
  { text: ' ███▓███▓███' },
  { text: ' █████▀█████' },
  { text: ' ███████████' },
  { text: ' ░▒▓▒░▒▓▒░▒▓', dim: true },
];

/** legacy-cjk 终端的纯 ASCII 色块回退 */
export const LOGO_ASCII: readonly LogoLine[] = [
  { text: '  .#######.' },
  { text: '  #########' },
  { text: '  ##o###o##' },
  { text: '  ####-####' },
  { text: '  ##.#.#.##' },
  { text: '  ~.~.~.~.~', dim: true },
];

/** 欢迎横幅的标语行 */
export const MISTY_TAGLINE = 'coding agent in the mist';
