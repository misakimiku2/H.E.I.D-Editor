/**
 * 标签页内容历史（撤销/重做）纯逻辑核心：
 * stack 存内容快照，index 指向当前态；连续输入（间隔小于合并窗口）合并为同一条历史。
 * React 侧（hooks/useEditorState.ts）只负责把它接到标签页状态上。
 */

export interface TabHistory {
  stack: string[];
  index: number;
  lastAt: number;
}

export const MAX_HISTORY = 200;
/** 间隔小于该值的连续修改（连续输入）合并为同一条历史 */
export const HISTORY_COALESCE_MS = 800;

/** 内容超过该字符数时撤销历史自动降档（快照模型的内存防护） */
export const LARGE_HISTORY_CHARS = 4_000_000;
/** 超大内容的历史条数上限（保住「误删整段可撤回」的底线即可） */
export const LARGE_HISTORY_LIMIT = 5;

/** 按内容长度取历史条数上限（UI 状态栏提示复用同一判定） */
export function historyLimitFor(contentLength: number): number {
  return contentLength > LARGE_HISTORY_CHARS ? LARGE_HISTORY_LIMIT : MAX_HISTORY;
}

/** 把栈压到上限内（保留以 index 结尾的窗口，重做分支一并丢弃） */
function enforceLimit(h: TabHistory, limit: number): void {
  if (h.stack.length <= limit) return;
  const start = Math.max(0, h.index - (limit - 1));
  h.stack = h.stack.slice(start, h.index + 1);
  h.index = h.stack.length - 1;
}

/** 懒初始化历史（stack[0] 为初始内容）；已存在则原样返回 */
export function ensureHistory(map: Map<string, TabHistory>, tabId: string, initialContent: string): TabHistory {
  let h = map.get(tabId);
  if (!h) {
    h = { stack: [initialContent], index: 0, lastAt: 0 };
    map.set(tabId, h);
  }
  return h;
}

/**
 * 向历史推进一次内容变化，返回是否实际记录。
 * major（如右键格式化）强制独立成条；返回值 newStep 供内部 diff 时间线复用同一合并判定。
 */
export function recordStep(
  h: TabHistory,
  prevContent: string,
  nextContent: string,
  major: boolean | undefined,
  now: number,
): { recorded: boolean; newStep: boolean } {
  if (prevContent === nextContent) return { recorded: false, newStep: false };
  if (nextContent === h.stack[h.index]) return { recorded: false, newStep: false };
  const newStep = !!major || now - h.lastAt > HISTORY_COALESCE_MS;
  const limit = historyLimitFor(nextContent.length);
  if (newStep) {
    h.stack = h.stack.slice(0, h.index + 1);
    h.stack.push(nextContent);
    h.index = h.stack.length - 1;
    enforceLimit(h, limit);
  } else {
    h.stack[h.index] = nextContent;
    enforceLimit(h, limit);
  }
  h.lastAt = now;
  return { recorded: true, newStep };
}

/** 回退一步，返回该步内容；无历史可退返回 null（调用方负责更新标签与时间戳） */
export function undoStep(h: TabHistory | undefined, now: number): string | null {
  if (!h || h.index <= 0) return null;
  h.index -= 1;
  h.lastAt = now;
  return h.stack[h.index];
}

/** 前进一步，返回该步内容；无历史可进返回 null */
export function redoStep(h: TabHistory | undefined, now: number): string | null {
  if (!h || h.index >= h.stack.length - 1) return null;
  h.index += 1;
  h.lastAt = now;
  return h.stack[h.index];
}

export function canUndoHistory(h: TabHistory | undefined): boolean {
  return !!h && h.index > 0;
}

export function canRedoHistory(h: TabHistory | undefined): boolean {
  return !!h && h.index < h.stack.length - 1;
}
