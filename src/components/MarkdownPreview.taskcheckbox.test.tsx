// @vitest-environment jsdom
/**
 * 预览 task checkbox 点击回写（第一批第 3 项）。
 * 可编辑预览（onChange 存在）里 checkbox 可点、toggle 回写源码；纯预览保持禁用。
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

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { MarkdownPreview } from './MarkdownPreview';

let root: Root | null = null;
let container: HTMLElement | null = null;

function mount(content: string, withOnChange = true) {
  act(() => { root?.unmount(); });
  container?.remove();
  const onChange = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <MarkdownPreview content={content} isDarkMode={false}
        onChange={withOnChange ? onChange : undefined} />,
    );
  });
  return { onChange, latest: () => onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as string };
}

const checkboxes = () =>
  Array.from(container!.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];

const click = (el: HTMLInputElement) => {
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
};

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
});

describe('预览 checkbox 点击回写', () => {
  it('未勾点击变勾并回写', () => {
    const { onChange, latest } = mount('- [ ] a');
    click(checkboxes()[0]);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(latest()).toBe('- [x] a');
  });

  it('已勾点击变未勾', () => {
    const { latest } = mount('- [x] a');
    click(checkboxes()[0]);
    expect(latest()).toBe('- [ ] a');
  });

  it('嵌套列表只改被点的那一行', () => {
    const { latest } = mount('intro\n\n- [ ] a\n  - [ ] b');
    click(checkboxes()[1]);
    expect(latest()).toBe('intro\n\n- [ ] a\n  - [x] b');
  });

  it('无 onChange 保持禁用', () => {
    mount('- [ ] a', false);
    expect(checkboxes()[0].disabled).toBe(true);
  });
});