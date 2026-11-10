import { describe, expect, it } from 'vitest';
import { hasRawHtml } from './markdownRawHtml';

describe('hasRawHtml', () => {
  it('识别常见原始标签（决定是否需要 rehype-raw）', () => {
    expect(hasRawHtml('a<br>b')).toBe(true);
    expect(hasRawHtml('<u>下划线</u>')).toBe(true);
    expect(hasRawHtml('<details open><summary>x</summary></details>')).toBe(true);
    expect(hasRawHtml('<img src="a.png" />')).toBe(true);
  });

  it('注释、自动链接、小于号与普通文本不触发', () => {
    expect(hasRawHtml('前文 <!-- group: x --> 后文')).toBe(false);
    expect(hasRawHtml('见 <https://example.com/a>')).toBe(false);
    expect(hasRawHtml('a < b')).toBe(false);
    expect(hasRawHtml('3 < 5 与普通正文')).toBe(false);
  });
});
