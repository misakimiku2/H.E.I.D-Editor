/**
 * 语言扩展懒加载注册表：按需 import()，语言包拆分为独立 chunk，不进主 bundle。
 * 编辑器外观/高亮主题在 src/lib/editorThemes.ts（含设置持久化的主题注册表）。
 */
import type { Extension } from '@codemirror/state';
import { StreamLanguage } from '@codemirror/language';

type LanguageLoader = () => Promise<Extension>;

const jsLoader = () => import('@codemirror/lang-javascript');

/**
 * legacy-modes / 自维护语法的共用入口：取模块上的某个 `StreamParser` 包成 LanguageSupport。
 * 传入完整 import() Promise 而不是模块名字符串，是为了让打包器看得见静态路径——
 * 每种 mode 仍是独立 chunk（clike 由 C#/Kotlin/Scala 共用一个）。
 */
async function streamMode(mod: Promise<{ [name: string]: unknown }>, name: string): Promise<Extension> {
  const m = await mod;
  const parser = m[name] as Parameters<typeof StreamLanguage.define>[0];
  return StreamLanguage.define(parser);
}

const LANGUAGE_LOADERS: Record<string, LanguageLoader> = {
  javascript: async () => (await jsLoader()).javascript(),
  typescript: async () => (await jsLoader()).javascript({ jsx: true, typescript: true }),
  tsx: async () => (await jsLoader()).javascript({ jsx: true, typescript: true }),
  jsx: async () => (await jsLoader()).javascript({ jsx: true }),
  python: async () => (await import('@codemirror/lang-python')).python(),
  css: async () => (await import('@codemirror/lang-css')).css(),
  html: async () => (await import('@codemirror/lang-html')).html(),
  json: async () => (await import('@codemirror/lang-json')).json(),
  rust: async () => (await import('@codemirror/lang-rust')).rust(),
  java: async () => (await import('@codemirror/lang-java')).java(),
  c: async () => (await import('@codemirror/lang-cpp')).cpp(),
  cpp: async () => (await import('@codemirror/lang-cpp')).cpp(),
  sql: async () => (await import('@codemirror/lang-sql')).sql(),
  yaml: async () => (await import('@codemirror/lang-yaml')).yaml(),
  xml: async () => (await import('@codemirror/lang-xml')).xml(),
  svg: async () => (await import('@codemirror/lang-xml')).xml(),
  php: async () => (await import('@codemirror/lang-php')).php(),
  markdown: async () => {
    const m = await import('@codemirror/lang-markdown');
    return m.markdown({ base: m.markdownLanguage });
  },
  /* ---- 以下为 v1.5（ROADMAP 51）补齐的第三档：官方 lang-go + legacy-modes 的 stream 着色器
     + 两个仓库内自维护语法。stream 的 token 名直接映射到 @lezer/highlight 的 tag，
     所以现有「代码配色主题」逐字生效，不需要另注册样式 ---- */
  go: async () => (await import('@codemirror/lang-go')).go(),
  bash: () => streamMode(import('@codemirror/legacy-modes/mode/shell'), 'shell'),
  dockerfile: () => streamMode(import('@codemirror/legacy-modes/mode/dockerfile'), 'dockerFile'),
  toml: () => streamMode(import('@codemirror/legacy-modes/mode/toml'), 'toml'),
  ruby: () => streamMode(import('@codemirror/legacy-modes/mode/ruby'), 'ruby'),
  swift: () => streamMode(import('@codemirror/legacy-modes/mode/swift'), 'swift'),
  csharp: () => streamMode(import('@codemirror/legacy-modes/mode/clike'), 'csharp'),
  kotlin: () => streamMode(import('@codemirror/legacy-modes/mode/clike'), 'kotlin'),
  scala: () => streamMode(import('@codemirror/legacy-modes/mode/clike'), 'scala'),
  scss: () => streamMode(import('@codemirror/legacy-modes/mode/css'), 'sCSS'),
  less: () => streamMode(import('@codemirror/legacy-modes/mode/css'), 'less'),
  ini: () => streamMode(import('./streamLangs'), 'ini'),
  makefile: () => streamMode(import('./streamLangs'), 'makefile'),
};

/** 已接着色器的语言键。README 里的语言数以此为准（实测键数，不写估计数） */
export const SUPPORTED_LANGUAGES = Object.keys(LANGUAGE_LOADERS);

const languageExtCache = new Map<string, Extension>();

/** 按语言名加载扩展（实例模块级缓存）；未知语言或加载失败返回 null（编辑功能不受影响） */
export async function loadLanguageExtension(lang: string): Promise<Extension | null> {
  const key = lang.toLowerCase();
  const cached = languageExtCache.get(key);
  if (cached) return cached;
  const loader = LANGUAGE_LOADERS[key];
  if (!loader) return null;
  try {
    const ext = await loader();
    languageExtCache.set(key, ext);
    return ext;
  } catch (e) {
    console.warn(`[codemirror] 语言扩展加载失败: ${lang}`, e);
    return null;
  }
}

export const LANGUAGE_LABELS: Record<string, string> = {
  typescript: 'TypeScript', javascript: 'JavaScript', python: 'Python',
  rust: 'Rust', go: 'Go', java: 'Java', c: 'C', cpp: 'C++',
  csharp: 'C#', ruby: 'Ruby', html: 'HTML', css: 'CSS',
  json: 'JSON', yaml: 'YAML', xml: 'XML', svg: 'SVG', markdown: 'Markdown', csv: 'CSV',
  bash: 'Shell', sql: 'SQL', plaintext: 'Text', toml: 'TOML',
  ini: 'INI', dockerfile: 'Dockerfile', makefile: 'Makefile',
  php: 'PHP', swift: 'Swift', kotlin: 'Kotlin', scala: 'Scala',
  scss: 'SCSS', less: 'Less', text: 'Text',
  jsx: 'React JSX', tsx: 'React TSX',
};

export function detectLanguageFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const extMap: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
    py: 'python', rs: 'rust', go: 'go', java: 'java',
    c: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', h: 'c', hpp: 'cpp',
    cs: 'csharp', rb: 'ruby', html: 'html', htm: 'html',
    css: 'css', scss: 'scss', less: 'less', json: 'json',
    yaml: 'yaml', yml: 'yaml', xml: 'xml', svg: 'svg', md: 'markdown',
    csv: 'csv', tsv: 'csv',
    sh: 'bash', bash: 'bash', sql: 'sql', toml: 'toml',
    ini: 'ini', dockerfile: 'dockerfile', makefile: 'makefile',
    php: 'php', swift: 'swift', kt: 'kotlin', kts: 'kotlin',
    scala: 'scala', txt: 'plaintext',
  };
  return extMap[ext] || 'plaintext';
}
