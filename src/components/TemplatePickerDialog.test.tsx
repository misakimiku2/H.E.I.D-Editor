// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/platform', () => ({ IS_ANDROID_APP: false, IS_TOUCH_PRIMARY: false, NARROW_QUERY: '(max-width: 767.98px)' }));
vi.mock('../lib/i18nContext', () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) =>
    vars ? `${key}${Object.values(vars).join(',')}` : key,
}));

/* Dropdown 替身：把选项渲染成带 data-testid 的按钮（沿用既有选择交互），并记录最近 props 供接线断言。
   真实下拉的展开/收起/夹紧由 Dropdown 自身保证，这里只验 picker 的选中与创建逻辑。 */
const { dropdownCaptured } = vi.hoisted(() => ({ dropdownCaptured: { props: null as any } }));
vi.mock('./Dropdown', async () => {
  const R = await import('react');
  return {
    Dropdown: (props: any) => {
      dropdownCaptured.props = props;
      return R.createElement('div', null,
        R.createElement('button', { 'aria-label': props.label },
          props.options?.find((o: any) => o.value === props.value)?.label ?? ''),
        ...(props.options ?? []).map((o: any) => R.createElement('button', {
          key: o.value,
          'data-testid': `template-option-${o.value}`,
          onClick: () => props.onChange(o.value),
        }, o.label)),
      );
    },
  };
});

import { TemplatePickerDialog, type TemplateCreateArgs } from './TemplatePickerDialog';
import type { DocTemplate } from '../lib/docTemplates';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const setInputValue = (el: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const frame = () => act(async () => { await new Promise(r => setTimeout(r, 30)); });

const sample: DocTemplate[] = [
  { id: 'a', name: '角色', content: '# {{title}} / {{date}}' },
  { id: 'b', name: '攻略', content: '## 简介' },
];

let host: HTMLElement;
let root: Root;
let onCreate: Mock<(args: TemplateCreateArgs) => void>;
let onManage: Mock<() => void>;
let onClose: Mock<() => void>;

const render = (templates: DocTemplate[] = sample) => {
  onCreate = vi.fn<(args: TemplateCreateArgs) => void>();
  onManage = vi.fn<() => void>();
  onClose = vi.fn<() => void>();
  act(() => {
    root.render(
      <TemplatePickerDialog isDarkMode={false} templates={templates} onCreate={onCreate} onManage={onManage} onClose={onClose} />,
    );
  });
};

const selectTemplate = (id: string) =>
  act(() => { (host.querySelector(`[data-testid="template-option-${id}"]`) as HTMLButtonElement).click(); });
const typeName = (value: string) =>
  act(() => { setInputValue(host.querySelector('[data-testid="template-filename-input"]') as HTMLInputElement, value); });
const createBtn = () => host.querySelector('[data-testid="template-create-btn"]') as HTMLButtonElement;

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  dropdownCaptured.props = null;
});
afterEach(() => { act(() => { root.unmount(); }); });

describe('TemplatePickerDialog 选择与门禁', () => {
  it('模板选择用下拉菜单，选项与默认选中正确', () => {
    render();
    expect(dropdownCaptured.props).not.toBeNull();
    expect(dropdownCaptured.props.options).toEqual([
      { value: 'a', label: '角色' },
      { value: 'b', label: '攻略' },
    ]);
    expect(dropdownCaptured.props.value).toBe('a');
  });
  it('展示可选模板', () => {
    render();
    expect(host.querySelector('[data-testid="template-option-a"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="template-option-b"]')).not.toBeNull();
  });
  it('未选模板或未输名时创建禁用', () => {
    render();
    expect(createBtn().disabled).toBe(true);
    selectTemplate('a');
    expect(createBtn().disabled).toBe(true);
    typeName('玛丽安');
    expect(createBtn().disabled).toBe(false);
  });
  it('非法文件名禁用创建并提示', () => {
    render();
    selectTemplate('a');
    typeName('a/b');
    expect(createBtn().disabled).toBe(true);
    expect(host.querySelector('[data-testid="template-picker-error"]')?.textContent).toContain('template.errInvalidChar');
  });
});

describe('TemplatePickerDialog 创建', () => {
  it('创建回调带补全扩展名与渲染后的内容', async () => {
    render();
    selectTemplate('a');
    typeName('玛丽安');
    act(() => { createBtn().click(); });
    await frame();
    expect(onCreate).toHaveBeenCalledTimes(1);
    const arg = onCreate.mock.calls[0][0];
    expect(arg.template.id).toBe('a');
    expect(arg.fileName).toBe('玛丽安.md');
    expect(arg.content).toContain('# 玛丽安');
    expect(arg.content).not.toContain('{{');
  });
  it('已有 .md 不重复追加', async () => {
    render();
    selectTemplate('b');
    typeName('笔记.md');
    act(() => { createBtn().click(); });
    await frame();
    expect(onCreate.mock.calls[0][0].fileName).toBe('笔记.md');
  });
});

describe('TemplatePickerDialog 空态与管理', () => {
  it('空列表显示空态与去管理按钮', () => {
    render([]);
    expect(host.querySelector('[data-testid="template-picker-empty"]')).not.toBeNull();
    act(() => { (host.querySelector('[data-testid="template-go-manage"]') as HTMLButtonElement).click(); });
    expect(onManage).toHaveBeenCalledTimes(1);
  });
  it('管理模板入口回调', () => {
    render();
    act(() => { (host.querySelector('[data-testid="template-manage-link"]') as HTMLButtonElement).click(); });
    expect(onManage).toHaveBeenCalledTimes(1);
  });
});