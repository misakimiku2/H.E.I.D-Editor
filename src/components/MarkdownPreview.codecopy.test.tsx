// @vitest-environment jsdom
/**
 * 预览代码块：头部栏左侧显示语言名、右侧复制按钮；点击复制把代码原文写进
 * 剪贴板并短暂切换「已复制」；行内代码不出现头部栏/复制按钮。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
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
const { writeClipboardText } = vi.hoisted(() => ({
  writeClipboardText: vi.fn(() => Promise.resolve()),
}));
vi.mock('../lib/fileOps', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/fileOps')>();
  return { ...actual, writeClipboardText };
});

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { MarkdownPreview } from './MarkdownPreview';

let root: Root | null = null;
let container: HTMLElement | null = null;

async function mount(content: string) {
  act(() => { root?.unmount(); });
  container?.remove();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<MarkdownPreview content={content} isDarkMode={false} />);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const copyButton = () =>
  container!.querySelector('button[aria-label="md.copyCode"]') as HTMLButtonElement | null;

const codeBar = () =>
  container!.querySelector('[data-md-code-bar]') as HTMLElement | null;

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
});

beforeEach(() => {
  writeClipboardText.mockClear();
});

describe('预览代码块复制', () => {
  it('点击按钮复制去掉末尾换行的代码原文', async () => {
    await mount('```js\nconst x = 1;\nconsole.log(x);\n```');
    const btn = copyButton();
    expect(btn).not.toBeNull();
    await act(async () => {
      btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(writeClipboardText).toHaveBeenCalledWith('const x = 1;\nconsole.log(x);');
  });

  it('复制成功后按钮切换为已复制', async () => {
    await mount('```\nline 1\nline 2\n```');
    const btn = copyButton()!;
    expect(btn.getAttribute('title')).toBe('md.copyCode');
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(container!.querySelector('button[aria-label="md.codeCopied"]')).not.toBeNull();
  });

  it('行内代码不出现头部栏与复制按钮', async () => {
    await mount('文字 `inline()` 结尾');
    expect(copyButton()).toBeNull();
    expect(codeBar()).toBeNull();
  });
});

describe('代码块头部栏', () => {
  it('左侧显示归一后的语言名，右侧是复制按钮', async () => {
    await mount('```py\nprint(1)\n```');
    expect(codeBar()!.textContent).toContain('Python');
    expect(codeBar()!.querySelector('button[aria-label="md.copyCode"]')).not.toBeNull();
  });

  it('无语言标注显示纯文本，单行围栏块也按块渲染', async () => {
    await mount('```\nline only\n```');
    expect(codeBar()).not.toBeNull();
    expect(codeBar()!.textContent).toContain('md.codePlain');
    expect(copyButton()).not.toBeNull();
  });

  it('单行带语言围栏块也显示头部栏', async () => {
    await mount('```ts\nconst x = 1;\n```');
    expect(codeBar()!.textContent).toContain('TypeScript');
  });
});
