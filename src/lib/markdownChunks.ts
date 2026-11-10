/**
 * 超大 Markdown 的预览分块：按标题切段（标题是顶层块，切开不会破坏嵌套结构），
 * 围栏代码与页签组内部不切；超长章节再按空行切到约 maxChunkChars。
 * 预览逐块挂载，打开大文件时不再一次性解析/渲染整篇。
 */
import { parseLangBlocks, type LangBlock } from './markdownLangs';

export interface MarkdownChunk {
  /** 片段在全文中的起始偏移（render 时作为 data-md 偏移基准） */
  start: number;
  md: string;
}

const HEADING_RE = /^#{1,6}\s/;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const TAB_OPEN_RE = /<!--\s*(?:lang|tab)\s*:/g;
const TAB_CLOSE_RE = /<!--\s*\/\s*(?:lang|tab)\s*-->/g;

export const DEFAULT_CHUNK_CHARS = 24_000;

export function splitMarkdownChunks(
  content: string,
  maxChunkChars: number = DEFAULT_CHUNK_CHARS,
): MarkdownChunk[] {
  if (!content.trim()) return [];
  const chunks: MarkdownChunk[] = [];
  let start = 0;
  let pendingSplit: number | null = null;
  let fence: string | null = null;
  let tabDepth = 0;
  let pos = 0;

  const pushAt = (end: number) => {
    const md = content.slice(start, end);
    if (md.trim()) chunks.push({ start, md });
    start = end;
    pendingSplit = null;
  };

  const lines = content.split('\n');
  for (const line of lines) {
    const lineStart = pos;
    pos += line.length + 1;
    const outsideProtected = !fence && tabDepth === 0;

    if (outsideProtected && lineStart > start) {
      if (HEADING_RE.test(line)) {
        pushAt(lineStart);
      } else if (pendingSplit !== null && line.trim() !== '') {
        pushAt(lineStart);
      }
    }

    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fence) fence = marker;
      else if (marker === fence) fence = null;
    } else if (!fence) {
      tabDepth += (line.match(TAB_OPEN_RE) || []).length;
      tabDepth -= (line.match(TAB_CLOSE_RE) || []).length;
      if (tabDepth < 0) tabDepth = 0;
    }

    if (!fence && tabDepth === 0 && line.trim() === '' && pos - start >= maxChunkChars) {
      pendingSplit = pos;
    }
  }
  pushAt(content.length);
  return chunks;
}

/** 大文档预览块：每块独立解析页签标记，并把块内偏移抬到全文坐标 */
export function buildLargePreviewBlocks(
  content: string,
  maxChunkChars: number = DEFAULT_CHUNK_CHARS,
): LangBlock[] {
  return splitMarkdownChunks(content, maxChunkChars).flatMap(chunk => {
    const parsed = parseLangBlocks(chunk.md);
    if (!parsed) return [{ type: 'md', md: chunk.md, start: chunk.start }];
    return parsed.map(b => shiftBlock(b, chunk.start));
  });
}

const shiftBlock = (b: LangBlock, base: number): LangBlock => {
  if (b.type === 'md') return { ...b, start: b.start + base };
  return {
    ...b,
    closeStart: b.closeStart >= 0 ? b.closeStart + base : -1,
    closeEnd: b.closeEnd >= 0 ? b.closeEnd + base : -1,
    sections: b.sections.map(s => ({
      ...s,
      start: s.start + base,
      markerStart: s.markerStart + base,
      markerEnd: s.markerEnd + base,
      bodyStart: s.bodyStart + base,
      bodyEnd: s.bodyEnd + base,
    })),
  };
};
