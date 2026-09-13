/**
 * markdown 多语言切换：`<!-- lang:标签名 -->` 注释把文档切分为多个语言版本，
 * 预览顶部出现切换标签。GitHub 式的 HTML/CSS 切换在我们预览中不可用
 * （原始 HTML 被安全剥离），因此采用标记约定 + 预览原生渲染。
 */

export interface LangSection {
  label: string;
  md: string;
}

const LANG_MARKER = /<!--\s*(?:lang|tab)\s*:\s*(.+?)\s*-->/gi;

/** 按 lang 标记切分文档；标记少于两个（含无标记）返回 null 表示普通文档 */
export function splitLangSections(content: string): LangSection[] | null {
  const markers: { label: string; start: number; end: number }[] = [];
  LANG_MARKER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LANG_MARKER.exec(content))) {
    markers.push({ label: m[1].trim(), start: m.index, end: m.index + m[0].length });
  }
  if (markers.length < 2) return null;

  const sections: LangSection[] = [];
  for (let i = 0; i < markers.length; i++) {
    const from = markers[i].end;
    const to = i + 1 < markers.length ? markers[i + 1].start : content.length;
    const body = content.slice(from, to).replace(/^\n+/, '').replace(/\s+$/, '');
    sections.push({ label: markers[i].label, md: body });
  }
  /* 首个标记前的引导内容并入第一区块（如共享的标题/元信息） */
  const pre = content.slice(0, markers[0].start).trim();
  if (pre) sections[0].md = `${pre}\n\n${sections[0].md}`;
  return sections;
}
