// @vitest-environment jsdom
/**
 * renderFetch：静态抓取结果过薄时的隐藏 WebView 渲染兜底。
 * looksThin 为纯启发式；fetchVia 为平台分流入口的依赖注入点（测试不碰真实 IPC）。
 */
import { describe, expect, it } from 'vitest';
import { looksThin, renderFetch, type RenderedPage } from './renderFetch';

describe('looksThin：静态 HTML 薄度启发式', () => {
  it('剥除 script/style 后正文过短判定为薄（SPA 空壳）', () => {
    const shell = `<html><head><script>var a=1;</script><style>.x{}</style></head><body><div id="root"></div><script src="app.js"></script></body></html>`;
    expect(looksThin(shell)).toBe(true);
  });

  it('正文充足的页面不判定为薄', () => {
    const body = '这是一段足够长的正文内容。'.repeat(200);
    const page = `<html><body><main>${body}</main></body></html>`;
    expect(looksThin(page)).toBe(false);
  });

  it('wiki 摘要页（约 2.6K 正文）不触发渲染兜底', () => {
    const body = '艾尔黛拉是一名挥舞施术单元、造成自然伤害的辅助干员。'.repeat(100);
    const page = `<html><body><main>${body}</main></body></html>`;
    expect(looksThin(page)).toBe(false);
  });
});

describe('renderFetch：平台分流（注入 fetchVia）', () => {
  it('平台无渲染能力（fetchVia 返回 null）时静默回退 null', async () => {
    const fetchVia = async (): Promise<RenderedPage | null> => null;
    await expect(renderFetch('https://example.com', { fetchVia })).resolves.toBeNull();
  });

  it('平台渲染成功时透传结果', async () => {
    const fetchVia = async (): Promise<RenderedPage | null> =>
      ({ html: '<html><body>渲染完成</body></html>', finalUrl: 'https://example.com/final' });
    await expect(renderFetch('https://example.com', { fetchVia })).resolves.toEqual({
      html: '<html><body>渲染完成</body></html>',
      finalUrl: 'https://example.com/final',
    });
  });

  it('渲染抛错时静默回退 null（由调用方走静态结果）', async () => {
    const fetchVia = async (): Promise<RenderedPage | null> => {
      throw new Error('渲染窗口创建失败');
    };
    await expect(renderFetch('https://example.com', { fetchVia })).resolves.toBeNull();
  });
});
