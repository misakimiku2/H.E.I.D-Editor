/**
 * 围栏代码块的语言标题：常见 Prism/别名归一后取应用内显示名（与状态栏同一张表），
 * 纯文本返回空串（由调用方给本地化文案），未知语言原样显示标注。
 */
import { LANGUAGE_LABELS } from './codemirror';

const ALIASES: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  py: 'python', rb: 'ruby', rs: 'rust', kt: 'kotlin', kts: 'kotlin',
  cs: 'csharp', 'c#': 'csharp',
  'c++': 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hxx: 'cpp', h: 'c',
  sh: 'bash', shell: 'bash', zsh: 'bash',
  yml: 'yaml', md: 'markdown', htm: 'html',
  docker: 'dockerfile', make: 'makefile', mk: 'makefile',
  jsonc: 'json', json5: 'json',
  txt: 'plaintext', text: 'plaintext', plain: 'plaintext',
};

export function codeLangLabel(lang: string): string {
  const key = lang.trim().toLowerCase();
  if (!key) return '';
  const canonical = ALIASES[key] ?? key;
  if (canonical === 'plaintext') return '';
  return LANGUAGE_LABELS[canonical] ?? lang;
}
