/**
 * 标签页数据模型（纯定义 + 工厂）：
 * FileTab 是单个标签页的完整状态；工厂函数集中在此，
 * 保证「新建 / 会话恢复 / 网址导入」等各入口产出的标签字段一致。
 */
import type { SessionMdView } from './session';
import type { LineEnding } from './lineEndings';
import { SAMPLE_CODE } from './welcomeContent';

/* markdown 标签页的视图模式：编辑 / 分屏（左预览右源码）/ 预览（持久化词汇表定义于 lib/session） */
export type MdViewMode = SessionMdView;

/** csv 标签页的视图模式：网格（缺省，`csvView` 未设即 grid）/ 原文本 */
export type CsvViewMode = 'grid' | 'text';

/** json / yaml 标签页的视图模式：结构树 / 分屏（左树右源码）/ 原文本（可解析且未超限时默认 tree） */
export type JsonViewMode = 'tree' | 'split' | 'text';

/** csv 页签的会话内 UI 状态（可选字段：缺省时按各自默认值生效） */
export interface CsvTabState {
  /** 网格 / 原文本视图；缺省 grid */
  csvView?: CsvViewMode;
  /** 首行作表头；缺省 true */
  csvHeaderOn?: boolean;
  /** 手动列宽（按列下标；双击列边界恢复自适应后删除该项） */
  csvColWidths?: number[];
}

export interface FileTab extends CsvTabState {
  id: string;
  title: string;
  path: string | null;
  handle: FileSystemFileHandle | null;
  content: string;
  originalContent: string;
  language: string;
  isDirty: boolean;
  readOnly: boolean;
  mdView: MdViewMode;
  /** 文件编码（WHATWG label；浏览器保存始终 UTF-8） */
  encoding: string;
  /** 文件是否带 BOM（UTF-8 / UTF-16 写回时保持） */
  bom: boolean;
  /** 当前目标换行符（编辑器内统一 LF，保存时转换） */
  eol: LineEnding;
  /** 磁盘上的原换行符（eol 与其不同即视为有未保存修改） */
  originalEol: LineEnding;
  /** 疑似二进制文件（检测含 NUL），只读预览 */
  binary?: boolean;
  /** 大文件（超降级阈值）：关闭语法高亮/小地图等保证流畅 */
  large?: boolean;
  /** 大文件只读分块预览（32~512MB 第二层）：content 恒为空，正文由 LargeFileViewer 分窗读取 */
  largePreview?: boolean;
  /** json / yaml 结构树视图状态（未设时按可解析性与性能闸门取默认） */
  jsonView?: JsonViewMode;
  /** 待跳转位置（跨文件搜索结果点击打开）：编辑器挂载后执行一次并清除。
      seq 区分同一标签的连续请求，避免相同位置的二连跳被 React 视为无变化 */
  jumpRequest?: { line: number; col: number; seq: number };
}

/** 大文件降级阈值（字符数）：超过即关闭语法高亮、小地图、补全等重计算特性 */
export const LARGE_FILE_CHARS = 2_000_000;

let tabCounter = 0;
export function nextTabId(): string {
  tabCounter += 1;
  return `tab-${Date.now()}-${tabCounter}`;
}

/* 初始 welcome 标签使用固定 id：会话恢复时需要精确识别并让位给快照内容 */
export const INITIAL_WELCOME_ID = 'tab-welcome-initial';

export function makeWelcomeTab(id: string = nextTabId()): FileTab {
  return {
    id,
    title: 'welcome.ts',
    path: null,
    handle: null,
    content: SAMPLE_CODE,
    originalContent: SAMPLE_CODE,
    language: 'typescript',
    isDirty: false,
    readOnly: false,
    mdView: 'edit',
    encoding: 'utf-8',
    bom: false,
    eol: 'lf',
    originalEol: 'lf',
  };
}

export function makeUntitledTab(title: string): FileTab {
  return {
    id: nextTabId(),
    title,
    path: null,
    handle: null,
    content: '',
    originalContent: '',
    language: 'plaintext',
    isDirty: false,
    readOnly: false,
    mdView: 'edit',
    encoding: 'utf-8',
    bom: false,
    eol: 'lf',
    originalEol: 'lf',
  };
}

/** 大文件只读分块预览标签（第二层）：readOnly 恒真，无保存/撤销概念 */
export function makeLargePreviewTab(path: string, title: string, language: string): FileTab {
  return {
    ...makeUntitledTab(title),
    path,
    language,
    readOnly: true,
    largePreview: true,
  };
}

/** Ctrl+N 新建：标题序号取自计数器当前值（与 nextTabId 共用计数） */
export function makeNewUntitled(): FileTab {
  return makeUntitledTab(`untitled-${tabCounter + 1}.txt`);
}
