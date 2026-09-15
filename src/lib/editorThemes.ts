/**
 * 代码高亮主题注册表：每套主题由一份调色板（chrome + token 颜色）生成，
 * 编辑器外观（EditorView.theme）与高亮规则（HighlightStyle）同源不同视图，
 * 小地图 / 粘性滚动 / 设置预览卡片也取同一份调色板，改一处全局一致。
 * 设置持久化的是主题 id（settings.codeThemeDark / codeThemeLight，按界面深浅各存一份）。
 */
import { EditorView } from '@codemirror/view';
import { HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import type { Extension } from '@codemirror/state';

const CODE_FONT = '"Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, monospace';

/** 语法 token 颜色（高亮规则与小地图着色共用） */
export interface ThemeTokens {
  /** 无语法结构的纯文本/未命中行条 */
  default: string;
  comment: string;
  variable: string;
  type: string;
  func: string;
  string: string;
  number: string;
  keyword: string;
  regexp: string;
  escape: string;
  operator: string;
  punctuation: string;
  tag: string;
  attr: string;
  attrValue: string;
  meta: string;
  invalid: string;
  deleted: string;
  inserted: string;
}

/** 一套主题的完整取色：编辑器 chrome、小地图、粘性滚动头 */
export interface ThemePalette {
  dark: boolean;
  background: string;
  foreground: string;
  caret: string;
  selection: string;
  activeLine: string;
  gutterFg: string;
  gutterHoverBg: string;
  gutterHoverFg: string;
  /** null = 行号栏不画右边框（深色主题惯例） */
  gutterBorder: string | null;
  /** tooltip / 面板 / 粘性滚动 / 小地图边线 */
  chromeBorder: string;
  tooltipBg: string;
  autocompleteSelected: string;
  panelBg: string;
  foldPlaceholderBg: string;
  foldPlaceholderFg: string;
  foldPlaceholderBorder: string | null;
  foldMarker: string;
  searchMatchBg: string;
  searchMatchSelectedBg: string;
  searchMatchOutline: string;
  minimapViewport: string;
  minimapViewportBorder: string;
  minimapSelection: string;
  stickyHoverBg: string;
  tokens: ThemeTokens;
}

/** 由调色板生成 CodeMirror 编辑器外观（结构与历史 VS Code 主题一致） */
function buildEditorTheme(p: ThemePalette): Extension {
  return EditorView.theme({
    '&': {
      backgroundColor: p.background,
      color: p.foreground,
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
      caretColor: p.caret,
      contain: 'layout style',
    },
    '.cm-line': {
      contain: 'style paint',
    },
    '.cm-cursor': {
      borderLeftColor: p.caret,
      borderLeftWidth: '2px',
    },
    '.cm-selectionBackground': {
      background: `${p.selection} !important`,
    },
    '.cm-focused .cm-selectionBackground': {
      background: `${p.selection} !important`,
    },
    '.cm-gutters': {
      backgroundColor: p.background,
      color: p.gutterFg,
      borderRight: p.gutterBorder ? `1px solid ${p.gutterBorder}` : 'none',
      fontFamily: CODE_FONT,
      fontSize: '13px',
      userSelect: 'none',
    },
    '.cm-gutterElement': {
      fontFamily: CODE_FONT,
      cursor: 'pointer',
      /* 这里刻意不加 transition：折叠栏的高亮格子是按需创建/销毁的（悬停时才临时生成一格），
         新建/移除没有动画而行号栏那一格有动画 —— 两半会先后来回，看起来是「撕裂」；
         悬停高亮统一做成瞬间生效（和 VS Code 的 gutter hover 一致）。 */
    },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 10px',
      display: 'flex',
      justifyContent: 'flex-end',
    },
    /* 行号悬停反馈：与「当前行」同宽 —— 类名由 CodeEditor 的悬停行状态经 gutterLineClass
       打到该行在所有 gutter（行号栏 + 折叠栏）里的格子上（当前行用 !important 底色，悬停不盖它） */
    '.cm-gutterHoverLine': {
      backgroundColor: p.gutterHoverBg,
      color: p.gutterHoverFg,
    },
    '.cm-activeLine': {
      backgroundColor: `${p.activeLine} !important`,
    },
    '.cm-activeLineGutter': {
      backgroundColor: `${p.activeLine} !important`,
    },
    '.cm-foldPlaceholder': {
      backgroundColor: p.foldPlaceholderBg,
      border: p.foldPlaceholderBorder ? `1px solid ${p.foldPlaceholderBorder}` : 'none',
      color: p.foldPlaceholderFg,
      padding: '0 4px',
    },
    '.cm-tooltip': {
      border: `1px solid ${p.chromeBorder}`,
      backgroundColor: p.tooltipBg,
      color: p.foreground,
      boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
    },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: p.autocompleteSelected,
      color: p.foreground,
    },
    '.cm-panels': {
      backgroundColor: p.panelBg,
      color: p.foreground,
    },
    '.cm-panels.cm-panels-top': {
      borderBottom: `1px solid ${p.chromeBorder}`,
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
      backgroundColor: `${p.searchMatchBg} !important`,
      outline: `1px solid ${p.searchMatchOutline}`,
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: `${p.searchMatchSelectedBg} !important`,
      outline: `1px solid ${p.searchMatchOutline}`,
    },
  }, { dark: p.dark });
}

/** 由同一份 token 颜色生成高亮规则（各主题结构一致，仅颜色不同） */
function buildHighlightStyle(k: ThemeTokens): HighlightStyle {
  return HighlightStyle.define([
    { tag: t.comment, color: k.comment, fontStyle: 'italic' },
    { tag: [t.variableName], color: k.variable },
    { tag: [t.typeName, t.className, t.namespace], color: k.type },
    { tag: t.function(t.variableName), color: k.func } as any,
    { tag: t.propertyName, color: k.variable },
    { tag: t.string, color: k.string },
    { tag: t.number, color: k.number },
    { tag: t.bool, color: k.keyword },
    { tag: t.null, color: k.keyword },
    { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword], color: k.keyword },
    { tag: t.operator, color: k.operator },
    { tag: t.punctuation, color: k.punctuation },
    { tag: t.tagName, color: k.tag },
    { tag: t.attributeName, color: k.attr },
    { tag: t.attributeValue, color: k.attrValue },
    { tag: t.regexp, color: k.regexp },
    { tag: t.escape, color: k.escape },
    { tag: t.definition(t.variableName), color: k.variable },
    { tag: t.local, color: k.variable },
    { tag: t.meta, color: k.meta },
    { tag: t.processingInstruction, color: k.keyword },
    { tag: t.monospace, color: k.string },
    { tag: t.link, color: k.keyword, textDecoration: 'underline' },
    { tag: t.heading, color: k.keyword, fontWeight: 'bold' },
    { tag: t.emphasis, fontStyle: 'italic' },
    { tag: t.strong, fontWeight: 'bold' },
    { tag: t.strikethrough, textDecoration: 'line-through' },
    { tag: t.deleted, color: k.deleted },
    { tag: t.inserted, color: k.inserted },
    { tag: t.invalid, color: k.invalid },
    { tag: t.list, color: k.meta },
  ]);
}

export interface CodeTheme {
  id: string;
  /** 展示名（专有名词，不做翻译） */
  label: string;
  theme: Extension;
  highlight: HighlightStyle;
  palette: ThemePalette;
}

function defineTheme(id: string, label: string, palette: ThemePalette): CodeTheme {
  return { id, label, theme: buildEditorTheme(palette), highlight: buildHighlightStyle(palette.tokens), palette };
}

/* ---- 深色主题 ---- */

const vsDark = defineTheme('vs-dark', 'VS Code Dark+', {
  dark: true,
  background: '#1e1e1e',
  foreground: '#d4d4d4',
  caret: '#aeafad',
  selection: 'rgba(38, 79, 120, 0.45)',
  activeLine: '#2a2d2e',
  gutterFg: '#858585',
  gutterHoverBg: '#2d2d2d',
  gutterHoverFg: '#cccccc',
  gutterBorder: null,
  chromeBorder: '#3f3f46',
  tooltipBg: '#2d2d2d',
  autocompleteSelected: '#062f4a',
  panelBg: '#252526',
  foldPlaceholderBg: '#2d2d2d',
  foldPlaceholderFg: '#858585',
  foldPlaceholderBorder: null,
  foldMarker: '#858585',
  searchMatchBg: '#613214',
  searchMatchSelectedBg: '#494a36',
  searchMatchOutline: '#b7792c',
  minimapViewport: 'rgba(255, 255, 255, 0.12)',
  minimapViewportBorder: 'rgba(255, 255, 255, 0.25)',
  minimapSelection: 'rgba(100, 150, 255, 0.3)',
  stickyHoverBg: '#2d2d2d',
  tokens: {
    default: '#3d3d42',
    comment: '#6a9955',
    variable: '#9cdcfe',
    type: '#4ec9b0',
    func: '#dcdcaa',
    string: '#ce9178',
    number: '#b5cea8',
    keyword: '#569cd6',
    regexp: '#d16969',
    escape: '#d7ba7d',
    operator: '#d4d4d4',
    punctuation: '#d4d4d4',
    tag: '#569cd6',
    attr: '#9cdcfe',
    attrValue: '#ce9178',
    meta: '#d4d4d4',
    invalid: '#f44747',
    deleted: '#ce9178',
    inserted: '#b5cea8',
  },
});

const oneDark = defineTheme('one-dark', 'One Dark Pro', {
  dark: true,
  background: '#282c34',
  foreground: '#abb2bf',
  caret: '#528bff',
  selection: 'rgba(59, 134, 247, 0.25)',
  activeLine: '#2c313c',
  gutterFg: '#7d828f',
  gutterHoverBg: '#333846',
  gutterHoverFg: '#cccccc',
  gutterBorder: null,
  chromeBorder: '#3e4451',
  tooltipBg: '#21252b',
  autocompleteSelected: '#3e4451',
  panelBg: '#21252b',
  foldPlaceholderBg: '#3a3f4b',
  foldPlaceholderFg: '#7d828f',
  foldPlaceholderBorder: null,
  foldMarker: '#7d828f',
  searchMatchBg: '#47432a',
  searchMatchSelectedBg: '#3d3d29',
  searchMatchOutline: '#b7792c',
  minimapViewport: 'rgba(255, 255, 255, 0.10)',
  minimapViewportBorder: 'rgba(255, 255, 255, 0.22)',
  minimapSelection: 'rgba(100, 150, 255, 0.28)',
  stickyHoverBg: '#333846',
  tokens: {
    default: '#828997',
    comment: '#5c6370',
    variable: '#e06c75',
    type: '#e5c07b',
    func: '#61afef',
    string: '#98c379',
    number: '#d19a66',
    keyword: '#c678dd',
    regexp: '#56b6c2',
    escape: '#56b6c2',
    operator: '#56b6c2',
    punctuation: '#abb2bf',
    tag: '#e06c75',
    attr: '#d19a66',
    attrValue: '#98c379',
    meta: '#61afef',
    invalid: '#f44747',
    deleted: '#e06c75',
    inserted: '#98c379',
  },
});

const dracula = defineTheme('dracula', 'Dracula', {
  dark: true,
  background: '#282a36',
  foreground: '#f8f8f2',
  caret: '#f8f8f0',
  selection: '#44475a',
  activeLine: 'rgba(68, 71, 90, 0.5)',
  gutterFg: '#6272a4',
  gutterHoverBg: '#343746',
  gutterHoverFg: '#f8f8f2',
  gutterBorder: null,
  chromeBorder: '#3d4053',
  tooltipBg: '#21222c',
  autocompleteSelected: '#44475a',
  panelBg: '#21222c',
  foldPlaceholderBg: '#44475a',
  foldPlaceholderFg: '#6272a4',
  foldPlaceholderBorder: null,
  foldMarker: '#6272a4',
  searchMatchBg: 'rgba(255, 184, 108, 0.25)',
  searchMatchSelectedBg: 'rgba(255, 184, 108, 0.4)',
  searchMatchOutline: '#ffb86c',
  minimapViewport: 'rgba(255, 255, 255, 0.10)',
  minimapViewportBorder: 'rgba(255, 255, 255, 0.22)',
  minimapSelection: 'rgba(139, 233, 253, 0.25)',
  stickyHoverBg: '#343746',
  tokens: {
    default: '#a9adbe',
    comment: '#6272a4',
    variable: '#f8f8f2',
    type: '#8be9fd',
    func: '#50fa7b',
    string: '#f1fa8c',
    number: '#bd93f9',
    keyword: '#ff79c6',
    regexp: '#f1fa8c',
    escape: '#bd93f9',
    operator: '#ff79c6',
    punctuation: '#f8f8f2',
    tag: '#ff79c6',
    attr: '#50fa7b',
    attrValue: '#f1fa8c',
    meta: '#ffb86c',
    invalid: '#ff5555',
    deleted: '#ff5555',
    inserted: '#50fa7b',
  },
});

const monokai = defineTheme('monokai', 'Monokai', {
  dark: true,
  background: '#272822',
  foreground: '#f8f8f2',
  caret: '#f8f8f0',
  selection: '#49483e',
  activeLine: '#3e3d32',
  gutterFg: '#90908a',
  gutterHoverBg: '#35362f',
  gutterHoverFg: '#f8f8f2',
  gutterBorder: null,
  chromeBorder: '#49483e',
  tooltipBg: '#34352f',
  autocompleteSelected: '#49483e',
  panelBg: '#34352f',
  foldPlaceholderBg: '#49483e',
  foldPlaceholderFg: '#90908a',
  foldPlaceholderBorder: null,
  foldMarker: '#90908a',
  searchMatchBg: 'rgba(253, 151, 31, 0.22)',
  searchMatchSelectedBg: 'rgba(253, 151, 31, 0.35)',
  searchMatchOutline: '#fd971f',
  minimapViewport: 'rgba(255, 255, 255, 0.10)',
  minimapViewportBorder: 'rgba(255, 255, 255, 0.22)',
  minimapSelection: 'rgba(166, 226, 46, 0.22)',
  stickyHoverBg: '#35362f',
  tokens: {
    default: '#cfcfc6',
    comment: '#75715e',
    variable: '#f8f8f2',
    type: '#66d9ef',
    func: '#a6e22e',
    string: '#e6db74',
    number: '#ae81ff',
    keyword: '#f92672',
    regexp: '#fd971f',
    escape: '#ae81ff',
    operator: '#f92672',
    punctuation: '#f8f8f2',
    tag: '#f92672',
    attr: '#a6e22e',
    attrValue: '#e6db74',
    meta: '#fd971f',
    invalid: '#f92672',
    deleted: '#f92672',
    inserted: '#a6e22e',
  },
});

const nord = defineTheme('nord', 'Nord', {
  dark: true,
  background: '#2e3440',
  foreground: '#d8dee9',
  caret: '#d8dee9',
  selection: '#434c5e',
  activeLine: '#3b4252',
  gutterFg: '#616e88',
  gutterHoverBg: '#3b4252',
  gutterHoverFg: '#eceff4',
  gutterBorder: null,
  chromeBorder: '#434c5e',
  tooltipBg: '#3b4252',
  autocompleteSelected: '#434c5e',
  panelBg: '#3b4252',
  foldPlaceholderBg: '#434c5e',
  foldPlaceholderFg: '#616e88',
  foldPlaceholderBorder: null,
  foldMarker: '#7b88a1',
  searchMatchBg: 'rgba(235, 203, 139, 0.18)',
  searchMatchSelectedBg: 'rgba(235, 203, 139, 0.3)',
  searchMatchOutline: '#ebcb8b',
  minimapViewport: 'rgba(255, 255, 255, 0.10)',
  minimapViewportBorder: 'rgba(255, 255, 255, 0.22)',
  minimapSelection: 'rgba(136, 192, 208, 0.25)',
  stickyHoverBg: '#3b4252',
  tokens: {
    default: '#aeb8cc',
    comment: '#616e88',
    variable: '#d8dee9',
    type: '#8fbcbb',
    func: '#88c0d0',
    string: '#a3be8c',
    number: '#b48ead',
    keyword: '#81a1c1',
    regexp: '#ebcb8b',
    escape: '#ebcb8b',
    operator: '#81a1c1',
    punctuation: '#eceff4',
    tag: '#81a1c1',
    attr: '#8fbcbb',
    attrValue: '#a3be8c',
    meta: '#81a1c1',
    invalid: '#bf616a',
    deleted: '#bf616a',
    inserted: '#a3be8c',
  },
});

/* ---- 浅色主题 ---- */

const vsLight = defineTheme('vs-light', 'VS Code Light+', {
  dark: false,
  background: '#ffffff',
  foreground: '#1e1e1e',
  caret: '#1e1e1e',
  selection: 'rgba(38, 79, 120, 0.35)',
  activeLine: '#f0f0f0',
  gutterFg: '#858585',
  gutterHoverBg: '#e8e8e8',
  gutterHoverFg: '#3b3b3b',
  gutterBorder: '#e1e4e8',
  chromeBorder: '#d4d4d8',
  tooltipBg: '#ffffff',
  autocompleteSelected: '#dbeafe',
  panelBg: '#f4f4f4',
  foldPlaceholderBg: '#f4f4f4',
  foldPlaceholderFg: '#858585',
  foldPlaceholderBorder: '#d4d4d4',
  foldMarker: '#6e6e6e',
  searchMatchBg: '#fef08a',
  searchMatchSelectedBg: '#fde68a',
  searchMatchOutline: '#ca8a04',
  minimapViewport: 'rgba(0, 0, 0, 0.08)',
  minimapViewportBorder: 'rgba(0, 0, 0, 0.18)',
  minimapSelection: 'rgba(50, 100, 255, 0.25)',
  stickyHoverBg: '#f0f0f0',
  tokens: {
    default: '#d8d8db',
    comment: '#6a9955',
    variable: '#001080',
    type: '#267f99',
    func: '#795e26',
    string: '#a31515',
    number: '#098658',
    keyword: '#0000ff',
    regexp: '#800000',
    escape: '#098658',
    operator: '#000000',
    punctuation: '#000000',
    tag: '#800000',
    attr: '#0000ff',
    attrValue: '#a31515',
    meta: '#000000',
    invalid: '#ff0000',
    deleted: '#a31515',
    inserted: '#098658',
  },
});

const solarizedLight = defineTheme('solarized-light', 'Solarized Light', {
  dark: false,
  background: '#fdf6e3',
  foreground: '#657b83',
  caret: '#586e75',
  selection: '#eee8d5',
  activeLine: '#f5eedd',
  gutterFg: '#93a1a1',
  gutterHoverBg: '#eee8d5',
  gutterHoverFg: '#586e75',
  gutterBorder: '#eee8d5',
  chromeBorder: '#e3dbc3',
  tooltipBg: '#fdf6e3',
  autocompleteSelected: '#eee8d5',
  panelBg: '#eee8d5',
  foldPlaceholderBg: '#eee8d5',
  foldPlaceholderFg: '#93a1a1',
  foldPlaceholderBorder: '#e3dbc3',
  foldMarker: '#93a1a1',
  searchMatchBg: 'rgba(203, 75, 22, 0.14)',
  searchMatchSelectedBg: 'rgba(203, 75, 22, 0.25)',
  searchMatchOutline: '#cb4b16',
  minimapViewport: 'rgba(0, 0, 0, 0.08)',
  minimapViewportBorder: 'rgba(0, 0, 0, 0.15)',
  minimapSelection: 'rgba(42, 161, 152, 0.25)',
  stickyHoverBg: '#eee8d5',
  tokens: {
    default: '#8a989b',
    comment: '#93a1a1',
    variable: '#586e75',
    type: '#b58900',
    func: '#268bd2',
    string: '#2aa198',
    number: '#d33682',
    keyword: '#859900',
    regexp: '#cb4b16',
    escape: '#cb4b16',
    operator: '#586e75',
    punctuation: '#586e75',
    tag: '#268bd2',
    attr: '#b58900',
    attrValue: '#2aa198',
    meta: '#cb4b16',
    invalid: '#dc322f',
    deleted: '#dc322f',
    inserted: '#859900',
  },
});

const githubLight = defineTheme('github-light', 'GitHub Light', {
  dark: false,
  background: '#ffffff',
  foreground: '#24292e',
  caret: '#24292e',
  selection: 'rgba(84, 159, 255, 0.28)',
  activeLine: '#f6f8fa',
  gutterFg: '#8b949e',
  gutterHoverBg: '#eaeef2',
  gutterHoverFg: '#24292e',
  gutterBorder: '#e1e4e8',
  chromeBorder: '#d0d7de',
  tooltipBg: '#ffffff',
  autocompleteSelected: '#dbeafe',
  panelBg: '#f6f8fa',
  foldPlaceholderBg: '#f6f8fa',
  foldPlaceholderFg: '#6e7781',
  foldPlaceholderBorder: '#d0d7de',
  foldMarker: '#6e7781',
  searchMatchBg: '#fff8c5',
  searchMatchSelectedBg: '#ffdf5d',
  searchMatchOutline: '#d4a72c',
  minimapViewport: 'rgba(0, 0, 0, 0.08)',
  minimapViewportBorder: 'rgba(0, 0, 0, 0.15)',
  minimapSelection: 'rgba(9, 105, 218, 0.25)',
  stickyHoverBg: '#f6f8fa',
  tokens: {
    default: '#6e7781',
    comment: '#6a737d',
    variable: '#24292e',
    type: '#6f42c1',
    func: '#6f42c1',
    string: '#032f62',
    number: '#005cc5',
    keyword: '#d73a49',
    regexp: '#032f62',
    escape: '#005cc5',
    operator: '#24292e',
    punctuation: '#24292e',
    tag: '#22863a',
    attr: '#6f42c1',
    attrValue: '#032f62',
    meta: '#6a737d',
    invalid: '#cb2431',
    deleted: '#b31d28',
    inserted: '#22863a',
  },
});

/** 全部主题（深色在前）；设置弹窗的预览卡片按 dark 字段分组渲染 */
export const CODE_THEMES: CodeTheme[] = [
  vsDark, oneDark, dracula, monokai, nord,
  vsLight, solarizedLight, githubLight,
];

/** 供 settings.ts 做枚举校验的 id 列表 */
export const CODE_THEME_IDS: readonly string[] = CODE_THEMES.map(x => x.id);

const DEFAULT_DARK = vsDark;
const DEFAULT_LIGHT = vsLight;

/** 按 id 取主题；id 未知（损坏/被移除）时按界面深浅回退默认主题 */
export function resolveCodeTheme(id: string | null | undefined, isDarkMode: boolean): CodeTheme {
  const found = CODE_THEMES.find(x => x.id === id);
  if (found) return found;
  return isDarkMode ? DEFAULT_DARK : DEFAULT_LIGHT;
}
