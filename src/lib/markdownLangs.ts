/**
 * markdown 多语言/页签切换：`<!-- lang:标签名 -->`（或 `<!-- tab:标签名 -->`）
 * 注释开启一个可切换区块，连续的标记构成一个页签组，`<!-- /tab -->` 结束当前组、
 * 其后回到普通内容。一篇文档允许任意多个页签组，每组在文档原位渲染切换标签、
 * 独立切换（抓取端把「标签组 + 等量内容面板」重写为标记组）。
 * GitHub 式的 HTML/CSS 切换在我们预览中不可用（原始 HTML 被安全剥离），
 * 因此采用标记约定 + 预览原生渲染。
 */

export interface LangSection {
  label: string;
  md: string;
  /** 区块 md 在原文中的起始偏移（预览右键把选区映射回源码用） */
  start: number;
  /** 开标记 <!-- tab:... --> 的源码区间（改名/删除用） */
  markerStart: number;
  markerEnd: number;
  /** 正文完整源码区间（不含标记，含首尾空白；改内容/删除用） */
  bodyStart: number;
  bodyEnd: number;
}

export type LangBlock =
  | { type: 'md'; md: string; start: number }
  | {
    type: 'tabs';
    sections: LangSection[];
    /** 组尾 <!-- /tab --> 的区间；未闭合组为 -1 */
    closeStart: number;
    closeEnd: number;
  };

const LANG_MARKER = /<!--\s*(?:lang|tab)\s*:\s*(.+?)\s*-->/gi;
const LANG_END_MARKER = /<!--\s*\/\s*(?:lang|tab)\s*-->/gi;

/**
 * 把文档解析为块序列：普通内容块与页签组块交替。组内每个标记开启一个区块，
 * 结束标记收组；结束标记之后的内容恢复普通块，后续标记开启新的组。
 * 无任何标记返回 null（普通文档）；只有单个空区块的组丢弃。
 */
export function parseLangBlocks(content: string): LangBlock[] | null {
  interface Ev {
    kind: 'open' | 'close';
    label: string;
    start: number;
    end: number;
  }
  const events: Ev[] = [];
  LANG_MARKER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LANG_MARKER.exec(content))) {
    events.push({ kind: 'open', label: m[1].trim(), start: m.index, end: m.index + m[0].length });
  }
  LANG_END_MARKER.lastIndex = 0;
  while ((m = LANG_END_MARKER.exec(content))) {
    events.push({ kind: 'close', label: '', start: m.index, end: m.index + m[0].length });
  }
  events.sort((a, b) => a.start - b.start);
  if (!events.some(e => e.kind === 'open')) return null;

  const blocks: LangBlock[] = [];
  /* 记录区块 md 的原文偏移（去掉前导空白后的起始位置） */
  const pushMd = (to: number) => {
    const raw = content.slice(cursor, to);
    const md = raw.trim();
    if (md) blocks.push({ type: 'md', md, start: cursor + (raw.length - raw.trimStart().length) });
  };
  let cursor = 0;
  let group: LangSection[] | null = null;
  let label = '';
  let segStart = 0;
  let markerStart = 0;
  let markerEnd = 0;
  const flushSection = (to: number) => {
    if (!group) return;
    const raw = content.slice(segStart, to);
    const md = raw.trim();
    group.push({
      label,
      md,
      start: segStart + (raw.length - raw.trimStart().length),
      markerStart,
      markerEnd,
      bodyStart: segStart,
      bodyEnd: to,
    });
  };
  const closeGroup = (bodyEnd: number, closeStart: number, closeEnd: number) => {
    flushSection(bodyEnd);
    /* 单区块组也按页签渲染（编辑器里新建的空页签要可见、可继续编辑） */
    if (group && group.length > 0) blocks.push({ type: 'tabs', sections: group, closeStart, closeEnd });
    group = null;
  };

  for (const ev of events) {
    if (ev.kind === 'open') {
      if (!group) {
        pushMd(ev.start);
        group = [];
      } else {
        flushSection(ev.start);
      }
      label = ev.label;
      segStart = ev.end;
      markerStart = ev.start;
      markerEnd = ev.end;
    } else if (group) {
      closeGroup(ev.start, ev.start, ev.end);
      cursor = segStart = ev.end;
    }
  }
  if (group) closeGroup(content.length, -1, -1);
  else pushMd(content.length);
  return blocks;
}
