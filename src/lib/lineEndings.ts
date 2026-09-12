/**
 * 换行符检测与转换（纯函数）：
 * 文件读入后统一以 LF 存于编辑器（CodeMirror 本身也会把 \r\n 归一为 \n），
 * 原始换行符记在标签页上，保存时再还原，保证打开 → 保存字节级保留原换行风格。
 */

export type LineEnding = 'lf' | 'crlf' | 'cr';

export const EOL_LABELS: Record<LineEnding, string> = { lf: 'LF', crlf: 'CRLF', cr: 'CR' };

export const EOL_SEQUENCES: Record<LineEnding, string> = { lf: '\n', crlf: '\r\n', cr: '\r' };

export interface LineEndingDetection {
  /** 主导换行符（无换行符时默认 lf） */
  eol: LineEnding;
  /** 文件内混用多种换行符 */
  mixed: boolean;
  crlf: number;
  lf: number;
  cr: number;
}

/** 统计三类换行符出现次数，给出主导换行符与混用标记 */
export function detectLineEnding(text: string): LineEndingDetection {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\r') {
      if (text[i + 1] === '\n') {
        crlf++;
        i++;
      } else {
        cr++;
      }
    } else if (ch === '\n') {
      lf++;
    }
  }
  const max = Math.max(crlf, lf, cr);
  const eol: LineEnding = max === 0 ? 'lf' : max === crlf ? 'crlf' : max === lf ? 'lf' : 'cr';
  const kinds = [crlf, lf, cr].filter(n => n > 0).length;
  return { eol, mixed: kinds > 1, crlf, lf, cr };
}

/** 把任意 CRLF / CR 归一为 LF */
export function normalizeToLf(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** LF 文本按目标换行符输出（磁盘写入用） */
export function applyLineEnding(textLf: string, eol: LineEnding): string {
  if (eol === 'lf') return textLf;
  return textLf.replace(/\n/g, EOL_SEQUENCES[eol]);
}
