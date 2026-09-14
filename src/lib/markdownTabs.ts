/**
 * 页签内容变换（纯函数，预览/编辑器调用）：
 * 把一段内容包成一个页签区块；若该段紧邻上一个已关闭的页签组
 * （组尾 <!-- /tab --> 后只有空白），则在该组末尾追加一个新区块——
 * 连续对相邻选区执行即逐个并排进同一组，成为可切换的页签。
 */

/** 片段首行是短纯文本时作页签标签（从内容中移除）；否则整段保留，用 fallback 兜底 */
function splitTabLabel(slice: string, fallback: string): { label: string; body: string } {
  const trimmed = slice.replace(/^\n+|\n+$/g, '');
  if (!trimmed) return { label: '', body: slice };
  const lines = trimmed.split('\n');
  const first = (lines[0] || '').trim();
  const plain = first.length >= 1 && first.length <= 16
    && !/^(!\[|\||<!--)/.test(first) && !/^[\s#*_-]+$/.test(first);
  if (!plain) return { label: fallback, body: trimmed };
  const label = first.replace(/^#+\s*/, '').replace(/[*_`]/g, '').trim() || fallback;
  return { label, body: lines.slice(1).join('\n').replace(/^\n+/, '') || trimmed };
}

export interface TabSplice {
  head: string;
  slice: string;
  tail: string;
}

/**
 * 把 [head|slice|tail] 三段中的 slice 包成一个页签区块，返回替换后的三段：
 * - head 以已关闭页签组的组尾（<!-- /tab --> 后只有空白）结束时：新区块插到组尾
 *   标记之前（旧结束标记保留作组尾），即并排追加进该组；
 * - 否则原位包成新的单区块组，前后自动补空行让标记独立成块。
 * slice 为空白时原样返回。
 */
export function spliceSelectionTab(head: string, slice: string, tail: string): TabSplice {
  if (!slice.trim()) return { head, slice, tail };
  /* 兜底标签全局编号：组内已有几个页签，新页签就顺延 */
  const opened = ((head + slice + tail).match(/<!--\s*tab:/g) || []).length;
  const { label, body } = splitTabLabel(slice, `页签${opened + 1}`);
  const closeMatch = head.match(/<!--\s*\/\s*tab\s*-->(\s*)$/);
  if (closeMatch) {
    /* 并排追加：新区块插在旧组尾标记之前（旧标记保留作组尾），选区本身清空；
       旧标记原有的尾随空行随之丢弃，接缝空行按 tail 重新归一 */
    const markerStart = head.length - closeMatch[0].length;
    const tailGap = tail.length === 0 ? ''
      : tail.startsWith('\n\n') ? '' : tail.startsWith('\n') ? '\n' : '\n\n';
    return {
      head: head.slice(0, markerStart) + `<!-- tab:${label} -->\n\n${body}\n\n<!-- /tab -->`,
      slice: '',
      tail: tailGap + tail,
    };
  }
  const headTrim = head.replace(/\n+$/, '');
  const tailGap = tail.length === 0 ? ''
    : tail.startsWith('\n\n') ? '' : tail.startsWith('\n') ? '\n' : '\n\n';
  return {
    head: headTrim.length === 0 ? '' : headTrim + '\n\n',
    slice: `<!-- tab:${label} -->\n\n${body}\n\n<!-- /tab -->`,
    tail: tailGap + tail,
  };
}

/** 把全文中 [start, end) 的选区包成一个页签区块（见 spliceSelectionTab） */
export function applySelectionTab(content: string, start: number, end: number): string {
  const p = spliceSelectionTab(content.slice(0, start), content.slice(start, end), content.slice(end));
  return p.head + p.slice + p.tail;
}

/**
 * 图片右键「设为页签」：把图片所在行包成页签区块，相邻图片逐张并排进同一组
 * （见 spliceSelectionTab）。
 */
export function applyImageTab(content: string, srcStart: number, srcEnd: number): string {
  const lineStart = content.lastIndexOf('\n', srcStart) + 1;
  let lineEnd = content.indexOf('\n', srcEnd);
  if (lineEnd < 0) lineEnd = content.length;
  return applySelectionTab(content, lineStart, lineEnd);
}
