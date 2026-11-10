// @vitest-environment jsdom
/**
 * 预览的原始 HTML 支持：导入网页常见的 <br>/<u>/<details> 等标签要渲染，
 * 脚本、事件属性、javascript: 链接与样式仍须被清洗。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/platform', () => ({
  IS_TOUCH_PRIMARY: false,
  IS_ANDROID_APP: false,
  NARROW_QUERY: '(max-width: 767.98px)',
}));
vi.mock('../lib/i18nContext', () => ({
  useT: () => (key: string) => key,
}));
/* 图片读取依赖 Tauri 文件系统：直接回显地址，验证协议白名单即可 */
vi.mock('../lib/imageSrc', () => ({
  resolveImageSrc: (src: string) => Promise.resolve(src),
  joinRelativeSrc: (src: string) => src,
  normalizeLocalSrc: (src: string) => src,
  ImageForbiddenError: class ImageForbiddenError extends Error {},
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { MarkdownPreview } from './MarkdownPreview';

let root: Root | null = null;
let container: HTMLElement | null = null;

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function mount(content: string) {
  act(() => { root?.unmount(); });
  container?.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<MarkdownPreview content={content} isDarkMode={false} />);
  });
  await flush();
}

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
});

describe('预览原始 HTML', () => {
  it('行内 <br> 渲染为换行，不再显示字面标签', async () => {
    await mount('第一行<br>第二行');
    const p = container!.querySelector('p')!;
    expect(p.querySelector('br')).not.toBeNull();
    expect(p.textContent).toBe('第一行第二行');
    expect(container!.textContent).not.toContain('<br>');
  });

  it('整行 <br> 与常见排版标签一起渲染', async () => {
    await mount([
      '前文',
      '<br>',
      '后文',
      '',
      '<u>下划线</u> <kbd>Ctrl</kbd> <small>小字</small>',
      '',
      '<details><summary>摘要</summary>展开内容</details>',
    ].join('\n'));
    expect(container!.querySelectorAll('br').length).toBeGreaterThan(0);
    expect(container!.querySelector('u')!.textContent).toBe('下划线');
    expect(container!.querySelector('kbd')!.textContent).toBe('Ctrl');
    expect(container!.querySelector('small')!.textContent).toBe('小字');
    expect(container!.querySelector('details summary')!.textContent).toBe('摘要');
    expect(container!.textContent).toContain('展开内容');
  });

  it('脚本、事件属性与 javascript: 链接被清洗', async () => {
    await mount([
      '<script>window.__mdPwned = 1</script>',
      '',
      '<div title="ok" onmouseover="alert(1)">可见文本</div>',
      '',
      '<style>.evil { color: red; }</style>',
      '',
      '<a href="javascript:alert(1)">点我</a>',
    ].join('\n'));
    expect((window as any).__mdPwned).toBeUndefined();
    expect(container!.querySelector('script')).toBeNull();
    const div = container!.querySelector('div[title="ok"]')!;
    expect(div.hasAttribute('onmouseover')).toBe(false);
    expect(div.textContent).toBe('可见文本');
    expect(container!.innerHTML).not.toContain('color: red');
    const link = container!.querySelector('a')!;
    expect(link.getAttribute('href')).toBeNull();
    expect(link.textContent).toBe('点我');
  });

  it('数学公式与 ==高亮==/下标扩展不被清洗误伤', async () => {
    await mount('行内 $x^2$ 与 ==red:重点==、H~2~O');
    expect(container!.querySelector('.katex')).not.toBeNull();
    expect(container!.querySelector('mark.md-mark-red')!.textContent).toBe('重点');
    expect(container!.querySelector('sub')!.textContent).toBe('2');
  });

  it('脚注锚点与正文跳转仍然对齐', async () => {
    await mount('脚注[^1]\n\n[^1]: 注释内容');
    const ref = container!.querySelector('a[data-footnote-ref]')!;
    const href = ref.getAttribute('href')!;
    expect(href.startsWith('#')).toBe(true);
    expect(container!.querySelector(`[id="${href.slice(1)}"]`)).not.toBeNull();
  });

  it('HTML 注释（如导入残留的 group 标记）不进入正文，代码块里保持字面量', async () => {
    await mount('前文 <!-- group: event_marian1_prologue --> 后文\n\n<!-- 独立一行 -->\n\n```\n<!-- code -->\n```');
    expect(container!.textContent).not.toContain('group:');
    expect(container!.textContent).not.toContain('独立一行');
    expect(container!.textContent).toContain('前文');
    expect(container!.textContent).toContain('后文');
    expect(container!.textContent).toContain('<!-- code -->');
  });

  it('没有原始标签时（走轻量管线）注释同样隐藏', async () => {
    await mount('前文 <!-- group: event_x --> 后文');
    expect(container!.textContent).not.toContain('group:');
    expect(container!.textContent).toContain('前文');
    expect(container!.textContent).toContain('后文');
  });

  it('代码块里的 <br> 保持字面量', async () => {
    await mount('```\na<br>b\n```');
    const code = container!.querySelector('code')!;
    expect(code.textContent).toContain('a<br>b');
    expect(code.querySelector('br')).toBeNull();
  });

  it('本地图片的 file:/// 地址不被地址清洗误删', async () => {
    await mount('![pic](file:///C:/pics/a.png)');
    const img = container!.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('file:///C:/pics/a.png');
    expect(img.getAttribute('alt')).toBe('pic');
  });
});
