/**
 * 语言扩展懒加载注册表：按需 import()，语言包拆分为独立 chunk，不进主 bundle。
 * 编辑器外观/高亮主题在 src/lib/editorThemes.ts（含设置持久化的主题注册表）。
 */
import type { Extension } from '@codemirror/state';

type LanguageLoader = () => Promise<Extension>;

const jsLoader = () => import('@codemirror/lang-javascript');

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
};

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
