// @vitest-environment jsdom
/**
 * 预览页签条的可视化编辑：＋新增、铅笔编辑、删除确认；
 * 空白右键「页签组」也能从零新建，不再要求手写 <!-- tab:... --> 标记。
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
  useT: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { MarkdownPreview } from './MarkdownPreview';

const DOC = '<!-- tab:甲 -->\n\n甲内容\n\n<!-- tab:乙 -->\n\n乙内容\n\n<!-- /tab -->';

let root: Root | null = null;
let container: HTMLElement | null = null;

async function mount(content: string, withOnChange = true) {
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
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return { onChange, latest: () => onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as string };
}

const byLabel = (label: string) =>
  container!.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;

const clickEl = (el: Element) => {
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
};

const setNativeValue = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

const submitModal = () => {
  const form = document.querySelector('form')!;
  act(() => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
};

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
  document.body.innerHTML = '';
});

describe('预览页签条编辑', () => {
  it('＋新增页签：默认标签顺延，内容插在组尾之前', async () => {
    const { latest } = await mount(DOC);
    clickEl(byLabel('md.tabAdd')!);
    expect(document.body.textContent).toContain('md.tabAddTitle');
    const label = document.querySelector('input[placeholder="md.tabLabelPlaceholder"]') as HTMLInputElement;
    const body = document.querySelector('textarea[placeholder="md.tabContentHint"]') as HTMLTextAreaElement;
    act(() => { setNativeValue(label, '丙'); setNativeValue(body, '丙内容'); });
    submitModal();
    const out = latest();
    expect(out).toContain('<!-- tab:丙 -->');
    expect(out).toContain('丙内容');
    expect(out.indexOf('<!-- tab:丙 -->')).toBeLessThan(out.indexOf('<!-- /tab -->'));
    expect((out.match(/<!--\s*\/\s*tab\s*-->/g) || []).length).toBe(1);
  });

  it('编辑当前页签：改标签与正文，不影响其它页签', async () => {
    const { latest } = await mount(DOC);
    clickEl(byLabel('md.tabEdit')!);
    expect(document.body.textContent).toContain('md.tabEditTitle');
    const label = document.querySelector('input[placeholder="md.tabLabelPlaceholder"]') as HTMLInputElement;
    const body = document.querySelector('textarea[placeholder="md.tabContentHint"]') as HTMLTextAreaElement;
    expect(label.value).toBe('甲');
    expect(body.value).toBe('甲内容');
    act(() => { setNativeValue(label, '新甲'); setNativeValue(body, '新的正文'); });
    submitModal();
    const out = latest();
    expect(out).toContain('<!-- tab:新甲 -->');
    expect(out).toContain('新的正文');
    expect(out).not.toContain('甲内容');
    expect(out).toContain('乙内容');
  });

  it('删除页签需二次确认，确认后连同内容移除', async () => {
    const { latest } = await mount(DOC);
    clickEl(byLabel('md.tabDelete')!);
    expect(document.body.textContent).toContain('md.tabDeleteTitle');
    const confirm = Array.from(document.querySelectorAll('button'))
      .find(b => b.textContent === 'md.tabDelete')!;
    clickEl(confirm);
    const out = latest();
    expect(out).not.toContain('甲内容');
    expect(out).toContain('乙内容');
    expect((out.match(/<!--\s*\/\s*tab\s*-->/g) || []).length).toBe(1);
  });

  it('删除最后一个页签：解散组并保留正文', async () => {
    const { latest } = await mount('前言\n\n<!-- tab:甲 -->\n\n甲内容\n\n<!-- /tab -->\n\n结尾');
    clickEl(byLabel('md.tabDelete')!);
    expect(document.body.textContent).toContain('md.tabDeleteLastMsg');
    const confirm = Array.from(document.querySelectorAll('button'))
      .find(b => b.textContent === 'md.tabDelete')!;
    clickEl(confirm);
    expect(latest()).toBe('前言\n\n甲内容\n\n结尾');
  });

  it('空白右键「页签组」可从零新建', async () => {
    const { latest } = await mount('随便一段正文');
    const rootEl = container!.firstElementChild as HTMLElement;
    act(() => {
      rootEl.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 120, clientY: 120,
      }));
    });
    const entry = Array.from(document.querySelectorAll('button'))
      .find(b => b.textContent === 'md.tabNewGroup')!;
    clickEl(entry);
    expect(document.body.textContent).toContain('md.tabNewGroupTitle');
    const label = document.querySelector('input[placeholder="md.tabLabelPlaceholder"]') as HTMLInputElement;
    const body = document.querySelector('textarea[placeholder="md.tabContentHint"]') as HTMLTextAreaElement;
    act(() => { setNativeValue(label, '介绍'); setNativeValue(body, '介绍内容'); });
    submitModal();
    const out = latest();
    expect(out).toContain('<!-- tab:介绍 -->');
    expect(out).toContain('介绍内容');
    expect(out).toContain('<!-- /tab -->');
  });

  it('空页签显示占位提示，点击直接打开编辑弹窗', async () => {
    await mount('<!-- tab:空 -->\n\n<!-- /tab -->');
    const hint = Array.from(document.querySelectorAll('button'))
      .find(b => b.textContent === 'md.tabEmptyHint');
    expect(hint).toBeTruthy();
    clickEl(hint!);
    expect(document.body.textContent).toContain('md.tabEditTitle');
    expect((document.querySelector('input[placeholder="md.tabLabelPlaceholder"]') as HTMLInputElement).value).toBe('空');
  });

  it('只读预览不出现增删改按钮', async () => {
    await mount(DOC, false);
    expect(byLabel('md.tabAdd')).toBeNull();
    expect(byLabel('md.tabEdit')).toBeNull();
    expect(byLabel('md.tabDelete')).toBeNull();
  });
});
