import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';

const UI_FONT = '"Inter", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const CODE_FONT = '"Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, monospace';

export const vsCodeDarkTheme = EditorView.theme({
  '&': {
    backgroundColor: '#1e1e1e',
    color: '#d4d4d4',
    fontSize: '14px',
    fontFamily: CODE_FONT,
    height: '100%',
  },
  '.cm-scroller': {
    fontFamily: CODE_FONT,
    overflow: 'auto',
    willChange: 'scroll-position',
  },
  '.cm-content': {
    fontFamily: CODE_FONT,
    padding: '12px 16px',
    caretColor: '#aeafad',
    contain: 'layout style',
  },
  '.cm-line': {
    contain: 'style paint',
  },
  '.cm-cursor': {
    borderLeftColor: '#aeafad',
    borderLeftWidth: '2px',
  },
  '.cm-selectionBackground': {
    background: 'rgba(38, 79, 120, 0.45) !important',
  },
  '.cm-focused .cm-selectionBackground': {
    background: 'rgba(38, 79, 120, 0.45) !important',
  },
  '.cm-gutters': {
    backgroundColor: '#1e1e1e',
    color: '#858585',
    borderRight: 'none',
    fontFamily: CODE_FONT,
    fontSize: '13px',
    userSelect: 'none',
  },
  '.cm-gutterElement': {
    fontFamily: CODE_FONT,
    cursor: 'pointer',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 10px',
    display: 'flex',
    justifyContent: 'flex-end',
  },
  '.cm-activeLine': {
    backgroundColor: '#2a2d2e !important',
  },
  '.cm-activeLineGutter': {
    backgroundColor: '#2a2d2e !important',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: '#2d2d2d',
    border: 'none',
    color: '#858585',
    padding: '0 4px',
  },
  '.cm-tooltip': {
    border: '1px solid #3f3f46',
    backgroundColor: '#2d2d2d',
    color: '#d4d4d4',
    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: '#062f4a',
    color: '#ffffff',
  },
  '.cm-panels': {
    backgroundColor: '#252526',
    color: '#d4d4d4',
  },
  '.cm-panels.cm-panels-top': {
    borderBottom: '1px solid #3f3f46',
  },
  '.cm-panel.cm-search label': {
    fontSize: '80%',
  },
  '.cm-foldGutter': {
    width: '12px',
  },
  '.cm-foldGutter .cm-gutterElement': {
    padding: '0 2px',
    cursor: 'pointer',
    fontSize: '13px',
    minWidth: '12px',
  },
  '.cm-foldGutter .cm-gutterElement span': {
    display: 'block',
    textAlign: 'center',
  },
  '.cm-searchMatch': {
    backgroundColor: '#613214 !important',
    outline: '1px solid #b7792c',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: '#494a36 !important',
    outline: '1px solid #b7792c',
  },
}, { dark: true });

export const vsCodeLightTheme = EditorView.theme({
  '&': {
    backgroundColor: '#ffffff',
    color: '#1e1e1e',
    fontSize: '14px',
    fontFamily: CODE_FONT,
    height: '100%',
  },
  '.cm-scroller': {
    fontFamily: CODE_FONT,
    overflow: 'auto',
    willChange: 'scroll-position',
  },
  '.cm-content': {
    fontFamily: CODE_FONT,
    padding: '12px 16px',
    caretColor: '#1e1e1e',
    contain: 'layout style',
  },
  '.cm-line': {
    contain: 'style paint',
  },
  '.cm-cursor': {
    borderLeftColor: '#1e1e1e',
    borderLeftWidth: '2px',
  },
  '.cm-selectionBackground': {
    background: 'rgba(38, 79, 120, 0.35) !important',
  },
  '.cm-focused .cm-selectionBackground': {
    background: 'rgba(38, 79, 120, 0.35) !important',
  },
  '.cm-gutters': {
    backgroundColor: '#ffffff',
    color: '#858585',
    borderRight: '1px solid #e1e4e8',
    fontFamily: CODE_FONT,
    fontSize: '13px',
    userSelect: 'none',
  },
  '.cm-gutterElement': {
    fontFamily: CODE_FONT,
    cursor: 'pointer',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 10px',
    display: 'flex',
    justifyContent: 'flex-end',
  },
  '.cm-activeLine': {
    backgroundColor: '#f0f0f0 !important',
  },
  '.cm-activeLineGutter': {
    backgroundColor: '#f0f0f0 !important',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: '#f4f4f4',
    border: '1px solid #d4d4d4',
    color: '#858585',
    padding: '0 4px',
  },
  '.cm-tooltip': {
    border: '1px solid #d4d4d8',
    backgroundColor: '#ffffff',
    color: '#1e1e1e',
    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: '#dbeafe',
    color: '#1e1e1e',
  },
  '.cm-panels': {
    backgroundColor: '#f4f4f4',
    color: '#1e1e1e',
  },
  '.cm-panels.cm-panels-top': {
    borderBottom: '1px solid #d4d4d4',
  },
  '.cm-panel.cm-search label': {
    fontSize: '80%',
  },
  '.cm-foldGutter': {
    width: '12px',
  },
  '.cm-foldGutter .cm-gutterElement': {
    padding: '0 2px',
    cursor: 'pointer',
    fontSize: '13px',
    minWidth: '12px',
  },
  '.cm-foldGutter .cm-gutterElement span': {
    display: 'block',
    textAlign: 'center',
  },
  '.cm-searchMatch': {
    backgroundColor: '#fef08a !important',
    outline: '1px solid #ca8a04',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: '#fde68a !important',
    outline: '1px solid #ca8a04',
  },
}, { dark: false });

export const vsCodeDarkHighlightStyle = HighlightStyle.define([
  { tag: t.comment, color: '#6a9955', fontStyle: 'italic' },
  { tag: [t.variableName], color: '#9cdcfe' },
  { tag: [t.typeName, t.className, t.namespace], color: '#4ec9b0' },
  { tag: t.function(t.variableName), color: '#dcdcaa' } as any,
  { tag: t.propertyName, color: '#9cdcfe' },
  { tag: t.string, color: '#ce9178' },
  { tag: t.number, color: '#b5cea8' },
  { tag: t.bool, color: '#569cd6' },
  { tag: t.null, color: '#569cd6' },
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], color: '#569cd6' },
  { tag: t.operator, color: '#d4d4d4' },
  { tag: t.punctuation, color: '#d4d4d4' },
  { tag: t.tagName, color: '#569cd6' },
  { tag: t.attributeName, color: '#9cdcfe' },
  { tag: t.attributeValue, color: '#ce9178' },
  { tag: t.regexp, color: '#d16969' },
  { tag: t.escape, color: '#d7ba7d' },
  { tag: t.definition(t.variableName), color: '#9cdcfe' },
  { tag: t.local, color: '#9cdcfe' },
  { tag: t.meta, color: '#d4d4d4' },
  { tag: t.processingInstruction, color: '#569cd6' },
  { tag: t.monospace, color: '#ce9178' },
  { tag: t.link, color: '#569cd6', textDecoration: 'underline' },
  { tag: t.heading, color: '#569cd6', fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.deleted, color: '#ce9178' },
  { tag: t.inserted, color: '#b5cea8' },
  { tag: t.invalid, color: '#f44747' },
  { tag: t.list, color: '#d4d4d4' },
]);

export const vsCodeLightHighlightStyle = HighlightStyle.define([
  { tag: t.comment, color: '#6a9955', fontStyle: 'italic' },
  { tag: [t.variableName], color: '#001080' },
  { tag: [t.typeName, t.className, t.namespace], color: '#267f99' },
  { tag: t.function(t.variableName), color: '#795e26' } as any,
  { tag: t.propertyName, color: '#001080' },
  { tag: t.string, color: '#a31515' },
  { tag: t.number, color: '#098658' },
  { tag: t.bool, color: '#0000ff' },
  { tag: t.null, color: '#0000ff' },
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], color: '#0000ff' },
  { tag: t.operator, color: '#000000' },
  { tag: t.punctuation, color: '#000000' },
  { tag: t.tagName, color: '#800000' },
  { tag: t.attributeName, color: '#0000ff' },
  { tag: t.attributeValue, color: '#a31515' },
  { tag: t.regexp, color: '#800000' },
  { tag: t.escape, color: '#098658' },
  { tag: t.definition(t.variableName), color: '#001080' },
  { tag: t.local, color: '#001080' },
  { tag: t.meta, color: '#000000' },
  { tag: t.processingInstruction, color: '#800000' },
  { tag: t.monospace, color: '#a31515' },
  { tag: t.link, color: '#0000ff', textDecoration: 'underline' },
  { tag: t.heading, color: '#000080', fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.deleted, color: '#a31515' },
  { tag: t.inserted, color: '#098658' },
  { tag: t.invalid, color: '#ff0000' },
  { tag: t.list, color: '#000000' },
]);

/** 语言扩展懒加载注册表：按需 import()，语言包拆分为独立 chunk，不进主 bundle */
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
  json: 'JSON', yaml: 'YAML', xml: 'XML', markdown: 'Markdown',
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
    yaml: 'yaml', yml: 'yaml', xml: 'xml', md: 'markdown',
    sh: 'bash', bash: 'bash', sql: 'sql', toml: 'toml',
    ini: 'ini', dockerfile: 'dockerfile', makefile: 'makefile',
    php: 'php', swift: 'swift', kt: 'kotlin', kts: 'kotlin',
    scala: 'scala', txt: 'plaintext',
  };
  return extMap[ext] || 'plaintext';
}