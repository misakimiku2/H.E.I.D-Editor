import { describe, expect, it } from 'vitest';
import { countWords } from './wordCount';

describe('countWords（CJK 感知）', () => {
  it('空文本为 0/0', () => {
    expect(countWords('', true)).toEqual({ chars: 0, words: 0 });
  });

  it('纯中文：每字计 1 词', () => {
    expect(countWords('你好世界', true)).toEqual({ chars: 4, words: 4 });
  });

  it('中英混排：中文逐字 + 拉丁连续串计 1', () => {
    const r = countWords('你好 world！123', true);
    expect(r.chars).toBe(12);
    expect(r.words).toBe(4); // 你 好 world 123
  });

  it('假名与谚文逐字计数', () => {
    expect(countWords('カタカナ', true).words).toBe(4);
    expect(countWords('한국어', true).words).toBe(3);
  });

  it('连字符/撇号连接的拉丁串算 1 词', () => {
    expect(countWords("state-of-the-art don't", true).words).toBe(2);
  });

  it('emoji 按码点计 1 字符', () => {
    expect(countWords('👍', true)).toEqual({ chars: 1, words: 0 });
  });

  it('标点不计词、空白不计字符', () => {
    const r = countWords('你好，世界。 end', true);
    expect(r.chars).toBe(10);
    expect(r.words).toBe(5); // 你 好 世 界 end（CJK 标点不计词）
  });
});

describe('countWords（空白分词）', () => {
  it('按空白切分，连续空白合并', () => {
    expect(countWords('hello world  foo\nbar', false)).toEqual({ chars: 20, words: 4 });
  });

  it('CJK 文本在简单模式下整段算 1 词', () => {
    expect(countWords('你好世界', false).words).toBe(1);
  });

  it('空串与纯空白为 0 词', () => {
    expect(countWords('   \n\t ', false).words).toBe(0);
    expect(countWords('', false)).toEqual({ chars: 0, words: 0 });
  });
});
