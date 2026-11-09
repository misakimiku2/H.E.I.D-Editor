/**
 * 编辑器设置（纯函数 + localStorage 持久化）：
 * 收敛此前散落各处的用户偏好；所有字段经 clamp/枚举校验，
 * 损坏或缺失的字段逐项回退默认值，设置损坏不影响编辑功能。
 */
import { CODE_THEME_IDS } from './editorThemes';
import {
  NIKKE_SAMPLE, TEMPLATE_CONTENT_MAX, TEMPLATE_COUNT_MAX, TEMPLATE_NAME_MAX, type DocTemplate,
} from './docTemplates';

/** 可选等宽字体栈（value 即 CSS font-family，直接内联） */
export const FONT_OPTIONS: Array<{ id: string; label: string; stack: string }> = [
  { id: 'default', label: '默认（Cascadia / Fira / Consolas）', stack: '"Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, monospace' },
  { id: 'consolas', label: 'Consolas', stack: 'Consolas, "Courier New", monospace' },
  { id: 'jetbrains', label: 'JetBrains Mono', stack: '"JetBrains Mono", Consolas, monospace' },
  { id: 'fira', label: 'Fira Code', stack: '"Fira Code", Consolas, monospace' },
  { id: 'cascadia', label: 'Cascadia Code', stack: '"Cascadia Code", Consolas, monospace' },
  { id: 'system-mono', label: '系统等宽', stack: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
];

/** 自动换行模式：仅 Markdown（默认）/ 总是 / 从不 */
export type LineWrapMode = 'markdown' | 'always' | 'never';

/** 界面语言：跟随系统 / 简体中文 / 英文 */
export type LanguagePref = 'system' | 'zh' | 'en';

export interface EditorSettings {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  tabSize: number;
  /** Tab 键插入空格（false = 插入 \t） */
  insertSpaces: boolean;
  lineWrapMode: LineWrapMode;
  showWhitespace: boolean;
  minimap: boolean;
  stickyScroll: boolean;
  /** 代码内颜色字面量前显示色样圆点（点击可调色） */
  colorDecorations: boolean;
  /** 定时把脏文件落盘（无路径标签走草稿，不受此项控制） */
  autosaveEnabled: boolean;
  autosaveIntervalSec: number;
  /** 'system' 按 navigator.language 解析（zh* → 中文，其余英文） */
  language: LanguagePref;
  /** 代码高亮主题 id（深/浅界面各一份），注册表见 lib/editorThemes */
  codeThemeDark: string;
  codeThemeLight: string;
  /** 文档模板（从模板新建）；空数组 = 用户删光，不再注入内置示例 */
  templates: DocTemplate[];
}

export const DEFAULT_SETTINGS: EditorSettings = {
  fontFamily: FONT_OPTIONS[0].stack,
  fontSize: 14,
  lineHeight: 1.55,
  tabSize: 2,
  insertSpaces: true,
  lineWrapMode: 'markdown',
  showWhitespace: false,
  minimap: true,
  stickyScroll: true,
  colorDecorations: true,
  autosaveEnabled: false,
  autosaveIntervalSec: 30,
  language: 'system',
  codeThemeDark: 'vs-dark',
  codeThemeLight: 'vs-light',
  templates: [NIKKE_SAMPLE],
};

const STORAGE_KEY = 'heid-settings';

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function pickFont(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_SETTINGS.fontFamily;
  return FONT_OPTIONS.find(f => f.stack === value)?.stack ?? DEFAULT_SETTINGS.fontFamily;
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** 模板数组校验：非数组→注入内置示例（老版本升级）；空数组原样保留（删光不复活）；
    逐项校验（id/name/content 字符串、name trim 非空且 ≤60、content ≤20000），坏项丢弃，上限 50。 */
function normalizeTemplates(value: unknown): DocTemplate[] {
  if (!Array.isArray(value)) return [NIKKE_SAMPLE];
  const out: DocTemplate[] = [];
  for (const item of value) {
    if (out.length >= TEMPLATE_COUNT_MAX) break;
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.id !== 'string' || !rec.id) continue;
    if (typeof rec.name !== 'string' || typeof rec.content !== 'string') continue;
    const name = rec.name.trim();
    if (!name || name.length > TEMPLATE_NAME_MAX) continue;
    if (rec.content.length > TEMPLATE_CONTENT_MAX) continue;
    out.push({ id: rec.id, name, content: rec.content });
  }
  return out;
}

/** 任意输入 → 合法设置：逐字段校验回退（未知字段忽略） */
export function normalizeSettings(input: unknown): EditorSettings {
  const rec = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  return {
    fontFamily: pickFont(rec.fontFamily),
    fontSize: clampInt(rec.fontSize, 11, 28, DEFAULT_SETTINGS.fontSize),
    lineHeight: clampInt(Number(rec.lineHeight) * 100, 110, 240, DEFAULT_SETTINGS.lineHeight * 100) / 100,
    tabSize: clampInt(rec.tabSize, 1, 8, DEFAULT_SETTINGS.tabSize),
    insertSpaces: typeof rec.insertSpaces === 'boolean' ? rec.insertSpaces : DEFAULT_SETTINGS.insertSpaces,
    lineWrapMode: pickEnum(rec.lineWrapMode, ['markdown', 'always', 'never'] as const, DEFAULT_SETTINGS.lineWrapMode),
    showWhitespace: typeof rec.showWhitespace === 'boolean' ? rec.showWhitespace : DEFAULT_SETTINGS.showWhitespace,
    minimap: typeof rec.minimap === 'boolean' ? rec.minimap : DEFAULT_SETTINGS.minimap,
    stickyScroll: typeof rec.stickyScroll === 'boolean' ? rec.stickyScroll : DEFAULT_SETTINGS.stickyScroll,
    colorDecorations: typeof rec.colorDecorations === 'boolean' ? rec.colorDecorations : DEFAULT_SETTINGS.colorDecorations,
    autosaveEnabled: typeof rec.autosaveEnabled === 'boolean' ? rec.autosaveEnabled : DEFAULT_SETTINGS.autosaveEnabled,
    autosaveIntervalSec: clampInt(rec.autosaveIntervalSec, 5, 300, DEFAULT_SETTINGS.autosaveIntervalSec),
    language: pickEnum(rec.language, ['system', 'zh', 'en'] as const, DEFAULT_SETTINGS.language),
    codeThemeDark: pickEnum(rec.codeThemeDark, CODE_THEME_IDS, DEFAULT_SETTINGS.codeThemeDark),
    codeThemeLight: pickEnum(rec.codeThemeLight, CODE_THEME_IDS, DEFAULT_SETTINGS.codeThemeLight),
    templates: normalizeTemplates(rec.templates),
  };
}

/** 读取设置；存储不可用 / 数据损坏时返回默认值 */
export function loadSettings(storage: Storage | null = defaultStorage()): EditorSettings {
  if (!storage) return { ...DEFAULT_SETTINGS };
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** 保存设置；失败静默（不影响编辑） */
export function saveSettings(settings: EditorSettings, storage: Storage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* 忽略持久化失败 */
  }
}
