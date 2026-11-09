// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/platform', () => ({ IS_ANDROID_APP: false, IS_TOUCH_PRIMARY: false, NARROW_QUERY: '(max-width: 767.98px)' }));
vi.mock('../lib/i18nContext', () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) =>
    vars ? `${key}${Object.values(vars).join(',')}` : key,
}));

/* CodeEditor 重（CodeMirror），单测里以受控 textarea 替身渲染，只验管理弹窗的接线；
   右键菜单/高亮等行为由 CodeEditor 自己的测试覆盖。captured 记录最近一次收到的 props。 */
const { captured } = vi.hoisted(() => ({ captured: { props: null as any } }));
vi.mock('./CodeEditor', async () => {
  const R = await import('react');
  return {
    CodeEditor: (props: any) => {
      captured.props = props;
      return R.createElement('textarea', {
        'data-testid': 'template-content-input',
        value: props.value,
        onChange: (e: any) => props.onChange?.(e.target.value),
      });
    },
  };
});
vi.mock('./MarkdownPreview', async () => {
  const R = await import('react');
  return {
    MarkdownPreview: (props: any) => R.createElement('div', { 'data-testid': 'template-preview' }, props.content),
  };
});

import { TemplateManagerDialog } from './TemplateManagerDialog';
import type { DocTemplate } from '../lib/docTemplates';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setInputValue = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = el instanceof window.HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

const sample: DocTemplate[] = [
  { id: 'a', name: '角色', content: '# {{title}}' },
  { id: 'b', name: '攻略', content: '## 简介' },
];

let host: HTMLElement;
let root: Root;
let onChange: Mock<(next: DocTemplate[]) => void>;
let onClose: Mock<() => void>;
let onBack: Mock<() => void>;

const render = (templates: DocTemplate[] = sample) => {
  onChange = vi.fn<(next: DocTemplate[]) => void>();
  onClose = vi.fn<() => void>();
  onBack = vi.fn<() => void>();
  act(() => {
    root.render(
      <TemplateManagerDialog isDarkMode={false} templates={templates} onChange={onChange} onClose={onClose} onBack={onBack} />,
    );
  });
};

const btnByText = (text: string) =>
  [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === text) as HTMLButtonElement;

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  captured.props = null;
});
afterEach(() => { act(() => { root.unmount(); }); });

describe('TemplateManagerDialog 列表', () => {
  it('展示模板名', () => {
    render();
    expect(host.textContent).toContain('角色');
    expect(host.textContent).toContain('攻略');
  });
  it('空列表显示空态', () => {
    render([]);
    expect(host.querySelector('[data-testid="template-manager-empty"]')).not.toBeNull();
  });
});

describe('TemplateManagerDialog 内容编辑器接线', () => {
  it('内容用 markdown 的 CodeEditor，并接上 markdown 菜单与撤销历史', () => {
    render();
    act(() => { (host.querySelector('[data-testid="template-edit-a"]') as HTMLButtonElement).click(); });
    expect(captured.props).not.toBeNull();
    expect(captured.props.language).toBe('markdown');
    expect(captured.props.value).toBe('# {{title}}');
    expect(captured.props.markdownMenu).toBeTruthy();
    expect(captured.props.history).toBeTruthy();
    expect(typeof captured.props.onChange).toBe('function');
  });
  it('编辑内容经 onChange 更新并随保存落库', () => {
    render();
    act(() => { (host.querySelector('[data-testid="template-edit-a"]') as HTMLButtonElement).click(); });
    const content = host.querySelector('[data-testid="template-content-input"]') as HTMLTextAreaElement;
    act(() => { setInputValue(content, '# 新骨架'); });
    act(() => { (host.querySelector('[data-testid="template-save-btn"]') as HTMLButtonElement).click(); });
    const next = onChange.mock.calls[0][0] as DocTemplate[];
    expect(next.find(t => t.id === 'a')?.content).toBe('# 新骨架');
  });
});

describe('TemplateManagerDialog 返回导航', () => {
  it('列表视图返回按钮回调 onBack', () => {
    render();
    act(() => { (host.querySelector('[data-testid="template-back-btn"]') as HTMLButtonElement).click(); });
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe('TemplateManagerDialog 预览切换', () => {
  it('编辑视图切到预览渲染 MarkdownPreview，再切回编辑器', () => {
    render();
    act(() => { (host.querySelector('[data-testid="template-edit-a"]') as HTMLButtonElement).click(); });
    expect(host.querySelector('[data-testid="template-content-input"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="template-preview"]')).toBeNull();
    act(() => { (host.querySelector('[data-testid="template-preview-toggle"]') as HTMLButtonElement).click(); });
    expect(host.querySelector('[data-testid="template-preview"]')?.textContent).toBe('# {{title}}');
    expect(host.querySelector('[data-testid="template-content-input"]')).toBeNull();
    act(() => { (host.querySelector('[data-testid="template-preview-toggle"]') as HTMLButtonElement).click(); });
    expect(host.querySelector('[data-testid="template-content-input"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="template-preview"]')).toBeNull();
  });
});

describe('TemplateManagerDialog 新建', () => {
  it('新建保存后 onChange 追加一条并回到列表', () => {
    render([]);
    act(() => { (host.querySelector('[data-testid="template-new-btn"]') as HTMLButtonElement).click(); });
    const name = host.querySelector('[data-testid="template-name-input"]') as HTMLInputElement;
    const content = host.querySelector('[data-testid="template-content-input"]') as HTMLTextAreaElement;
    act(() => { setInputValue(name, '新模板'); setInputValue(content, '# 骨架'); });
    act(() => { (host.querySelector('[data-testid="template-save-btn"]') as HTMLButtonElement).click(); });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as DocTemplate[];
    expect(next).toHaveLength(1);
    expect(next[0].name).toBe('新模板');
    expect(next[0].content).toBe('# 骨架');
    expect(next[0].id).toBeTruthy();
    expect(host.querySelector('[data-testid="template-name-input"]')).toBeNull();
  });
  it('名称为空保存被拦下并提示', () => {
    render([]);
    act(() => { (host.querySelector('[data-testid="template-new-btn"]') as HTMLButtonElement).click(); });
    act(() => { (host.querySelector('[data-testid="template-save-btn"]') as HTMLButtonElement).click(); });
    expect(onChange).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="template-name-error"]')).not.toBeNull();
  });
  it('取消编辑回到列表且不改动', () => {
    render();
    act(() => { (host.querySelector('[data-testid="template-new-btn"]') as HTMLButtonElement).click(); });
    act(() => { (host.querySelector('[data-testid="template-cancel-btn"]') as HTMLButtonElement).click(); });
    expect(onChange).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="template-name-input"]')).toBeNull();
  });
});

describe('TemplateManagerDialog 编辑', () => {
  it('编辑预填并保存更新对应条', () => {
    render();
    act(() => { (host.querySelector('[data-testid="template-edit-a"]') as HTMLButtonElement).click(); });
    const name = host.querySelector('[data-testid="template-name-input"]') as HTMLInputElement;
    expect(name.value).toBe('角色');
    act(() => { setInputValue(name, '角色改'); });
    act(() => { (host.querySelector('[data-testid="template-save-btn"]') as HTMLButtonElement).click(); });
    const next = onChange.mock.calls[0][0] as DocTemplate[];
    expect(next.find(t => t.id === 'a')?.name).toBe('角色改');
    expect(next).toHaveLength(2);
  });
});

describe('TemplateManagerDialog 删除', () => {
  it('删除需确认，确认后移除', () => {
    render();
    act(() => { (host.querySelector('[data-testid="template-delete-a"]') as HTMLButtonElement).click(); });
    expect(onChange).not.toHaveBeenCalled();
    const confirm = btnByText('common.confirm');
    expect(confirm).toBeTruthy();
    act(() => { confirm.click(); });
    const next = onChange.mock.calls[0][0] as DocTemplate[];
    expect(next.map(t => t.id)).toEqual(['b']);
  });
  it('删除取消则不改动', () => {
    render();
    act(() => { (host.querySelector('[data-testid="template-delete-a"]') as HTMLButtonElement).click(); });
    act(() => { btnByText('common.cancel').click(); });
    expect(onChange).not.toHaveBeenCalled();
  });
});