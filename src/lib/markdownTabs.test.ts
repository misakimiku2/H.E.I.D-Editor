/**
 * 图片右键「设为页签」的内容变换：首图成组、后续相邻图并入同组
 * （回归用例对应真实事故：并组时旧结束标记只被削掉 `<!`，
 *   在预览里留下可见的 `-- /tab -->` 文本）。
 */
import { describe, expect, it } from 'vitest';
import { applyImageTab } from './markdownTabs';

const IMG1 = '![](https://x/1.png)';
const IMG2 = '![](https://x/2.png)';
const IMG3 = '![](https://x/3.png)';

describe('applyImageTab', () => {
  it('首图：包成独立页签组，前后紧贴上文时补空行', () => {
    const content = `基础资料\n\n${IMG1}\n\n${IMG2}`;
    const out = applyImageTab(content, content.indexOf(IMG1), content.indexOf(IMG1) + IMG1.length);
    expect(out).toBe(`基础资料\n\n<!-- tab:页签1 -->\n\n${IMG1}\n\n<!-- /tab -->\n\n${IMG2}`);
  });

  it('相邻图并入上一组：旧结束标记整体挪到本图之后，不残留碎片', () => {
    const content = `<!-- tab:页签1 -->\n\n${IMG1}\n\n<!-- /tab -->\n\n${IMG2}\n\n${IMG3}`;
    const out = applyImageTab(content, content.indexOf(IMG2), content.indexOf(IMG2) + IMG2.length);
    expect(out).toBe(`<!-- tab:页签1 -->\n\n${IMG1}\n\n${IMG2}\n\n<!-- /tab -->\n\n${IMG3}`);
    /* 不残留断裂的标记行（-- /tab --> 之类） */
    expect(out).not.toMatch(/^--\s*\/\s*tab/m);
    expect((out.match(/<!--\s*\/\s*tab\s*-->/g) || []).length).toBe(1);
  });

  it('隔正文的图另起新组（不并入前面的组）', () => {
    const content = `<!-- tab:页签1 -->\n\n${IMG1}\n\n<!-- /tab -->\n\n说明文字\n\n${IMG2}`;
    const out = applyImageTab(content, content.indexOf(IMG2), content.indexOf(IMG2) + IMG2.length);
    expect(out).toBe(
      `<!-- tab:页签1 -->\n\n${IMG1}\n\n<!-- /tab -->\n\n说明文字\n\n<!-- tab:页签2 -->\n\n${IMG2}\n\n<!-- /tab -->`,
    );
  });

  it('文档末尾的图（无尾随换行）也能成组', () => {
    const content = `前言\n\n${IMG1}`;
    const out = applyImageTab(content, content.indexOf(IMG1), content.indexOf(IMG1) + IMG1.length);
    expect(out).toBe(`前言\n\n<!-- tab:页签1 -->\n\n${IMG1}\n\n<!-- /tab -->`);
  });

  it('连续三张图逐张并入同一组', () => {
    let content = `${IMG1}\n\n${IMG2}\n\n${IMG3}`;
    const pos = (img: string) => ({ start: content.indexOf(img), end: content.indexOf(img) + img.length });
    const p1 = pos(IMG1);
    content = applyImageTab(content, p1.start, p1.end);
    const p2 = pos(IMG2);
    content = applyImageTab(content, p2.start, p2.end);
    const p3 = pos(IMG3);
    content = applyImageTab(content, p3.start, p3.end);
    expect(content).toBe(
      `<!-- tab:页签1 -->\n\n${IMG1}\n\n${IMG2}\n\n${IMG3}\n\n<!-- /tab -->`,
    );
    expect((content.match(/<!--\s*\/\s*tab\s*-->/g) || []).length).toBe(1);
  });
});
