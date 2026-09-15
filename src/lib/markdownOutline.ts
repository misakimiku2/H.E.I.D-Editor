/**
 * Markdown 大纲提取（纯函数）：ATX 标题（#{1,6}）扫描，跳过围栏代码块。
 * 与 react-markdown 的节点 position 对齐：offset 取行首 '#' 的全文偏移，
 * 供预览侧按 [data-md-start] 定位滚动、编辑器侧按 line 跳转。
 * Setext 标题（下划 ===/---）不支持——大数用户文档以 ATX 为主，YAGNI。
 */

export interface MdHeading {
  /** 1..6 */
  level: number;
  /** 去掉 # 与首尾空白后的标题文本 */
  text: string;
  /** 0 起行号 */
  line: number;
  /** 行首 '#' 的全文偏移 */
  offset: number;
}

export function extractHeadings(md: string): MdHeading[] {
  const out: MdHeading[] = [];
  const lines = md.split('\n');
  let offset = 0;
  let fence: string | null = null; // 当前围栏标记（``` 或 ~~~，含更长重复）
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = /^(\s{0,3})(`{3,}|~{3,})/.exec(line);
    if (fence) {
      /* 围栏内：匹配到等长及以上的同字符围栏即闭合 */
      if (fenceMatch && fenceMatch[2][0] === fence[0] && fenceMatch[2].length >= fence.length) fence = null;
    } else if (fenceMatch) {
      fence = fenceMatch[2];
    } else {
      const m = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/.exec(line);
      if (m) {
        out.push({
          level: m[1].length,
          text: (m[2] ?? '').trim(),
          line: i,
          offset: offset + line.indexOf('#'),
        });
      }
    }
    offset += line.length + 1; // +1 换行符
  }
  return out;
}
