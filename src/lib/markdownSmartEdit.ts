export function linkPasteInsert(pasted: string, selected: string): string | null {
  const url = pasted.trim();
  if (!/^(https?:\/\/|mailto:|xmpp:|www\.)\S+$/i.test(url)) return null;
  if (!selected || /[\n[\]]/.test(selected)) return null;
  const target = /^www\./i.test(url) ? `https://${url}` : url;
  return `[${selected}](${target})`;
}

const TASK_RE = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+)\[([ xX])\]/;

export function toggleTaskAtOffset(content: string, offset: number): string | null {
  const lineStart = content.lastIndexOf('\n', offset - 1) + 1;
  const lineEnd = content.indexOf('\n', offset);
  const line = content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd);
  const m = TASK_RE.exec(line);
  if (!m) return null;
  const at = lineStart + m[1].length + 1;
  const next = m[2] === ' ' ? 'x' : ' ';
  return content.slice(0, at) + next + content.slice(at + 1);
}