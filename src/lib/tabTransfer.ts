/**
 * 跨窗口标签传输载荷(纯类型 + 序列化 + 事件名):
 * FileTab 剔除运行时瞬态字段(handle 为浏览器文件句柄、jumpRequest 为窗口内瞬态指令)
 * 后即为可跨窗口 JSON 传输的投影;id 由接收窗口重新分配,保证各窗口标签 id 自持。
 * 事件统一经 Rust emit_to 转发,名称集中在此避免两端拼错。
 */
import type { FileTab, MdViewMode } from './tabModel';
import { nextTabId } from './tabModel';
import type { LineEnding } from './lineEndings';

/** FileTab 的可序列化投影 */
export type TransferableTab = Omit<FileTab, 'handle' | 'jumpRequest'>;

/** 脱离成窗:新窗口装载单个标签 */
export interface TabTransferPayload {
  kind: 'tab';
  /** 源窗口 label(ack 回执的目标) */
  from: string;
  /** 传输唯一 id:源窗口等此 id 的回执决定是否移除源标签 */
  transferId: string;
  /** 本次拖拽会话 id(忽略过期悬停/回执) */
  dragId: string;
  /** 被拖标签是否为源窗口唯一标签:Rust 据此决定 detached 后是否隐藏源窗口 */
  wasOnlyTab: boolean;
  tab: TransferableTab;
}

/** 多窗口会话恢复:新窗口按整份快照重建标签 */
export interface SessionPayload {
  kind: 'session';
  state: import('./session').SessionState;
}

export type WindowBootstrapPayload = TabTransferPayload | SessionPayload;

/* ---- 跨窗口事件名(Rust emit_to → 前端 listen) ---- */

/** 目标窗口收下标签后回执给源窗口:{ transferId, dragId, ok } */
export const EV_TAB_ADOPTED = 'heid-tab-adopted';

const MD_VIEWS: MdViewMode[] = ['edit', 'split', 'preview'];
const EOLS: LineEnding[] = ['lf', 'crlf', 'cr'];

let transferCounter = 0;
export function makeTransferId(): string {
  transferCounter += 1;
  return `xf-${Date.now()}-${transferCounter}`;
}

/** 一次拖拽会话的唯一 id:源窗口用它让目标窗口丢弃过期悬停/离开事件 */
export function makeDragId(): string {
  transferCounter += 1;
  return `drag-${Date.now()}-${transferCounter}`;
}

/** 剔除运行时瞬态字段;其余字段(含 csv/json 视图状态、脏缓冲)原样随行 */
export function serializeTab(tab: FileTab): TransferableTab {
  const { handle: _handle, jumpRequest: _jump, ...rest } = tab;
  return rest;
}

/**
 * 载荷重建为 FileTab。关键字段类型校验(自进程事件也做防御,坏载荷返回 null);
 * forceNewId 供接收侧重新分配标签 id;mdView/eol 非法值收敛为缺省(向前兼容)。
 */
export function deserializeTab(raw: TransferableTab, forceNewId = false): FileTab | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.title !== 'string' || r.title.length === 0) return null;
  if (r.path !== null && typeof r.path !== 'string') return null;
  if (typeof r.content !== 'string' || typeof r.originalContent !== 'string') return null;
  if (typeof r.language !== 'string' || typeof r.encoding !== 'string') return null;
  if (typeof r.isDirty !== 'boolean' || typeof r.readOnly !== 'boolean') return null;
  if (typeof r.bom !== 'boolean') return null;
  const eol = EOLS.includes(r.eol as LineEnding) ? (r.eol as LineEnding) : 'lf';
  const originalEol = EOLS.includes(r.originalEol as LineEnding) ? (r.originalEol as LineEnding) : eol;
  return {
    id: forceNewId ? nextTabId() : typeof r.id === 'string' ? r.id : nextTabId(),
    title: r.title,
    path: r.path,
    handle: null,
    content: r.content,
    originalContent: r.originalContent,
    language: r.language,
    isDirty: r.isDirty,
    readOnly: r.readOnly,
    mdView: MD_VIEWS.includes(r.mdView as MdViewMode) ? (r.mdView as MdViewMode) : 'edit',
    encoding: r.encoding,
    bom: r.bom,
    eol,
    originalEol,
    binary: r.binary === true ? true : undefined,
    large: r.large === true ? true : undefined,
    largePreview: r.largePreview === true ? true : undefined,
    csvView: (r.csvView === 'grid' || r.csvView === 'text') ? r.csvView : undefined,
    csvHeaderOn: typeof r.csvHeaderOn === 'boolean' ? r.csvHeaderOn : undefined,
    csvColWidths: Array.isArray(r.csvColWidths) ? r.csvColWidths.filter((n): n is number => typeof n === 'number') : undefined,
    jsonView: (r.jsonView === 'tree' || r.jsonView === 'split' || r.jsonView === 'text') ? r.jsonView : undefined,
    svgEdit: r.svgEdit === true ? true : undefined,
  };
}

/** 事件载荷守卫:跨窗口事件 payload 反序列化前的统一入口 */
export function isTabTransferPayload(v: unknown): v is TabTransferPayload {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return r.kind === 'tab'
    && typeof r.from === 'string'
    && typeof r.transferId === 'string'
    && !!r.tab && typeof r.tab === 'object';
}

export function isSessionPayload(v: unknown): v is SessionPayload {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return r.kind === 'session'
    && !!r.state && typeof r.state === 'object'
    && Array.isArray((r.state as Record<string, unknown>).tabs);
}
