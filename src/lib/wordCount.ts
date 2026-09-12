/**
 * 字数统计：字符按码点计（emoji 等代理对算 1）。
 * cjkAware（Markdown 等文档）：CJK 字符（汉字/假名/谚文）每字计 1 词，
 * 连续拉丁字母/数字串（含 ' ’ - 连接）计 1 词，标点空白不计——Word/WPS 口径。
 * 非 cjkAware（代码等）：按空白分词。
 */

export interface WordCount {
  chars: number;
  words: number;
}

const isCjk = (cp: number): boolean =>
  (cp >= 0x4e00 && cp <= 0x9fff) // CJK 统一表意
  || (cp >= 0x3400 && cp <= 0x4dbf) // 扩展 A
  || (cp >= 0x3040 && cp <= 0x30ff) // 平假名 + 片假名
  || (cp >= 0xac00 && cp <= 0xd7af) // 谚文音节
  || (cp >= 0xf900 && cp <= 0xfaff); // CJK 兼容表意

const isLatinWordChar = (cp: number): boolean =>
  (cp >= 0x41 && cp <= 0x5a) // A-Z
  || (cp >= 0x61 && cp <= 0x7a) // a-z
  || (cp >= 0x30 && cp <= 0x39) // 0-9
  || cp === 0x27 || cp === 0x2019 || cp === 0x2d; // ' ’ -

export function countWords(text: string, cjkAware: boolean): WordCount {
  let chars = 0;
  for (const _ of text) chars++;
  if (!cjkAware) {
    const words = text.split(/\s+/).filter(Boolean).length;
    return { chars, words };
  }
  let words = 0;
  let inLatin = false;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (isCjk(cp)) {
      words++;
      inLatin = false;
    } else if (isLatinWordChar(cp)) {
      if (!inLatin) {
        words++;
        inLatin = true;
      }
    } else {
      inLatin = false;
    }
  }
  return { chars, words };
}
