/**
 * 页签组的源码编辑（预览页签条的 新增 / 编辑 / 删除）：
 * 依据 parseLangBlocks 给出的精确区间操作，只替换目标页签的片段，
 * 不改动组外内容，也不重排其它页签的标记。
 */
import type { LangSection } from './markdownLangs';

export interface TabGroupRef {
  sections: LangSection[];
  /** 组尾 <!-- /tab --> 区间；未闭合组为 -1 */
  closeStart: number;
  closeEnd: number;
}

/** 标签会写进 <!-- tab:... -->：换行和结束符会破坏标记结构，先清掉 */
export function sanitizeTabLabel(label: string, fallback: string): string {
  const clean = label.replace(/[\r\n]+/g, ' ').replace(/--+>/g, '').trim();
  return clean || fallback;
}

/** 统一换行；只去掉首尾整行空行，保留正文自身的缩进与行尾空格 */
const normalizeBody = (body: string): string =>
  body.replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\n+$/, '');

const sectionText = (label: string, body: string): string =>
  `<!-- tab:${label} -->\n\n${normalizeBody(body)}\n\n`;

/** 新建页签组（两段之间由调用方保证空行分隔） */
export function makeTabGroup(label: string, body: string): string {
  return sectionText(label, body) + '<!-- /tab -->';
}

/**
 * 在组内插入一个页签，index 缺省为末尾：
 * 插在目标页签标记之前；追加时插在组尾标记之前；未闭合组补上组尾标记。
 */
export function insertTabSection(
  content: string,
  group: TabGroupRef,
  label: string,
  body: string,
  index: number = group.sections.length,
): string {
  const beforeEnd = Math.max(0, Math.min(index, group.sections.length - 1));
  const target = index < group.sections.length ? group.sections[beforeEnd] : null;
  const at = target ? target.markerStart : group.closeStart >= 0 ? group.closeStart : content.length;
  const prefix = content.slice(0, at);
  const suffix = content.slice(at);
  const lead = prefix.length === 0 || prefix.endsWith('\n\n')
    ? ''
    : prefix.endsWith('\n') ? '\n' : '\n\n';
  const block = lead + sectionText(label, body);
  /* 组已有尾标记（或插在组中间）：后面的标记天然收尾；未闭合的末尾追加补一个 */
  return prefix + block + (group.closeStart >= 0 || target ? suffix : '<!-- /tab -->');
}

/** 改写一个页签的标签与内容 */
export function updateTabSection(
  content: string,
  section: LangSection,
  label: string,
  body: string,
): string {
  return content.slice(0, section.markerStart) + sectionText(label, body) + content.slice(section.bodyEnd);
}

/**
 * 删除一个页签：
 * - 组内还有别的页签：连同该页签内容一起删掉；
 * - 这是最后一个页签：解散页签组，正文保留为普通内容（不误删正文）。
 */
export function deleteTabSection(content: string, group: TabGroupRef, index: number): string {
  const section = group.sections[index];
  if (!section) return content;
  if (group.sections.length > 1) {
    return content.slice(0, section.markerStart) + content.slice(section.bodyEnd);
  }
  const body = normalizeBody(content.slice(section.bodyStart, section.bodyEnd));
  const end = group.closeEnd >= 0 ? group.closeEnd : section.bodyEnd;
  const prefix = content.slice(0, section.markerStart).replace(/\n+$/, '');
  const suffix = content.slice(end).replace(/^\n+/, '');
  if (!body) return prefix + (prefix && suffix ? '\n\n' : '') + suffix;
  return prefix + (prefix ? '\n\n' : '') + body + (suffix ? '\n\n' : '') + suffix;
}
