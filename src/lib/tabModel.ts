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

export interface FileTab {
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

/** Ctrl+N 新建：标题序号取自计数器当前值（与 nextTabId 共用计数） */
export function makeNewUntitled(): FileTab {
  return makeUntitledTab(`untitled-${tabCounter + 1}.txt`);
}
