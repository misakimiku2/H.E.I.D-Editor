// @vitest-environment jsdom
/**
 * 桌面右键预览：弹的是应用自己的插入/格式菜单，浏览器的页面菜单一律不放行。
 * 只读预览（更新文档那种）本来就不弹任何菜单，右键应当完全不触发。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/i18nContext', () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) =>
    vars ? `${key}${Object.values(vars).join(',')}` : key,
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { MarkdownPreview } from './MarkdownPreview';

let root: Root | null = null;
let container: HTMLElement | null = null;

function mount(onChange?: (v: string) => void) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <MarkdownPreview content={'# 标题\n\n一段正文'} isDarkMode={false} onChange={onChange} />
    );
  });
}

/** 在正文空白处右键，返回该事件是否被压掉 */
function rightClickBlank(): boolean {
  const el = (container!.querySelector('h1') ?? container!.firstElementChild!.firstElementChild!) as HTMLElement;
  const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 40 });
  act(() => { el.dispatchEvent(e); });
  return e.defaultPrevented;
}

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
});

describe('预览区桌面右键', () => {
  it('可编辑：插入菜单弹出，同时压掉浏览器页面菜单', () => {
    mount(vi.fn());
    expect(rightClickBlank()).toBe(true);
    expect(container!.textContent).toContain('md.sectionInsert');
  });

  it('只读：右键什么都不弹，也不放行浏览器页面菜单', () => {
    mount();
    expect(rightClickBlank()).toBe(true);
    expect(container!.textContent).not.toContain('md.sectionInsert');
  });
});
