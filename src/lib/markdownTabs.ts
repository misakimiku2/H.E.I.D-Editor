/**
 * 图片右键「设为页签」的内容变换（纯函数，预览组件调用）：
 * 把图片所在行包成页签区块；若该行紧邻上一个已关闭的页签组
 * （组尾 <!-- /tab --> 后只有空白），则把结束标记挪到本图之后——
 * 连续对多张图执行即逐张并入同一组。
 */

export function applyImageTab(content: string, srcStart: number, srcEnd: number): string {
  const lineStart = content.lastIndexOf('\n', srcStart) + 1;
  let lineEnd = content.indexOf('\n', srcEnd);
  if (lineEnd < 0) lineEnd = content.length;
  const before = content.slice(0, lineStart);
  /* 紧邻的页签组：before 以 <!-- /tab --> 结尾（允许中间只有空白） */
  const endMatch = before.match(/<!--\s*\/\s*tab\s*-->(\s*)$/);
  const tabCount = (content.match(/<!--\s*tab:/g) || []).length;
  const label = `页签${tabCount + 1}`;
  let next: string;
  if (endMatch) {
    /* 并入上一组：整体移除组尾旧结束标记（含其前导位置到行首的区间），
       挪到本图之后。旧标记区间 = [lineStart - endMatch[0].length, lineStart) */
    const oldEndStart = lineStart - endMatch[0].length;
    next = content.slice(0, oldEndStart)
      + content.slice(lineStart, lineEnd)
      + '\n\n<!-- /tab -->'
      + content.slice(lineEnd);
  } else {
    next = content.slice(0, lineStart)
      + `<!-- tab:${label} -->\n\n`
      + content.slice(lineStart, lineEnd)
      + '\n\n<!-- /tab -->'
      + content.slice(lineEnd);
    /* 新独立组：行前若紧贴上文，补空行让标记独立成块 */
    const prevChar = next.slice(Math.max(0, lineStart - 1), lineStart);
    if (prevChar && prevChar !== '\n') {
      next = next.slice(0, lineStart) + '\n\n' + next.slice(lineStart);
    }
  }
  return next.replace(/\n{4,}/g, '\n\n\n');
}
