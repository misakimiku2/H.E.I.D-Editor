// @vitest-environment jsdom
/**
 * ① 纯逻辑：列号 → 表格软件地址记法（网格变换逻辑在 lib/csv.test.ts 覆盖）；
 * ② 粘贴通道：网格粘贴必须走原生 paste 事件（clipboardData），任何路径都不得
 *    调 navigator.clipboard.readText —— 浏览器里那会弹「查看剪贴板」授权框。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/* jsdom 缺失：网格视口量测需要 ResizeObserver */
(window as any).ResizeObserver = class {
  observe() {} unobserve() {} disconnect() {}
};

vi.mock('../lib/i18nContext', () => ({
  useT: () => (key: string) => key,
}));

import { CsvGridEditor, cellAddr, colLabel } from './CsvGridEditor';

describe('colLabel：列号 → 字母记法', () => {
  it('单字母区间', () => {
    expect(colLabel(0)).toBe('A');
    expect(colLabel(1)).toBe('B');
    expect(colLabel(25)).toBe('Z');
  });

  it('进位区间', () => {
    expect(colLabel(26)).toBe('AA');
    expect(colLabel(27)).toBe('AB');
    expect(colLabel(701)).toBe('ZZ');
    expect(colLabel(702)).toBe('AAA');
  });
});

describe('cellAddr：行列 → 单元格地址', () => {
  it('行 1 起计、列字母化', () => {
    expect(cellAddr({ r: 0, c: 0 })).toBe('A1');
    expect(cellAddr({ r: 10, c: 0 })).toBe('A11');
    expect(cellAddr({ r: 0, c: 27 })).toBe('AB1');
    expect(cellAddr({ r: 10, c: 27 })).toBe('AB11');
  });
});

/* ---------- 粘贴通道 ---------- */

const readTextSpy = vi.fn(() => Promise.resolve(''));
const writeTextSpy = vi.fn(() => Promise.resolve());
const queryPermission = vi.fn(() => Promise.resolve({ state: 'prompt' } as PermissionStatus));

const setNavigator = (key: string, value: unknown) => {
  Object.defineProperty(window.navigator, key, { value, configurable: true });
};

/** 在元素上派发携带 clipboardData 的原生 paste 事件（模拟用户 Ctrl+V） */
const firePaste = (el: Element, text: string) => {
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', { value: { getData: () => text } });
  el.dispatchEvent(ev);
};

const frame = () => act(async () => { await new Promise(r => setTimeout(r, 20)); });

describe('CsvGridEditor 粘贴通道', () => {
  let host: HTMLElement;
  let root: Root;
  let latest: string;

  const renderGrid = (content: string) => {
    act(() => {
      root.render(
        <CsvGridEditor
          content={content}
          delimiter=","
          isDarkMode={false}
          headerOn={false}
          onChange={(v) => { latest = v; renderGrid(v); }}
          onHeaderToggle={() => {}}
          onWidthsChange={() => {}}
        />,
      );
    });
  };

  const gridEl = () => host.querySelector('[role="grid"]') as HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    latest = '';
    readTextSpy.mockClear();
    writeTextSpy.mockClear();
    queryPermission.mockClear().mockResolvedValue({ state: 'prompt' } as PermissionStatus);
    setNavigator('clipboard', { readText: readTextSpy, writeText: writeTextSpy });
    setNavigator('permissions', { query: queryPermission });
    renderGrid('a,b\n1,2');
  });

  it('原生 paste 事件：TSV 块从选区左上角写入，不经 readText', async () => {
    gridEl().focus();
    act(() => { firePaste(gridEl(), 'x\ty\n3\t4'); });
    await frame();
    expect(latest).toBe('x,y\n3,4\n');
    expect(readTextSpy).not.toHaveBeenCalled();
  });

  it('Ctrl+V 键盘粘贴不调 readText（浏览器授权弹窗的根因）', async () => {
    gridEl().focus();
    act(() => {
      gridEl().dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true }));
    });
    await frame();
    expect(readTextSpy).not.toHaveBeenCalled();
    /* onChange 未触发 = 网格内容未变 */
    expect(latest).toBe('');
  });

  it('右键菜单粘贴：权限未授予时不调 readText，聚焦代理等原生 Ctrl+V', async () => {
    act(() => {
      (host.querySelector('[data-testid="csv-cell-0-0"]') as HTMLElement)
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    const pasteBtn = host.querySelector('button[title="csv.menuPaste"]') as HTMLButtonElement;
    expect(pasteBtn).not.toBeNull();
    act(() => { pasteBtn.click(); });
    await frame();
    expect(readTextSpy).not.toHaveBeenCalled();
    const proxy = host.querySelector('[data-testid="csv-clipboard-proxy"]') as HTMLElement;
    expect(document.activeElement).toBe(proxy);
    expect(latest).toBe('');
  });

  it('右键菜单粘贴：权限已授予时经 readText 直接应用', async () => {
    queryPermission.mockResolvedValue({ state: 'granted' } as PermissionStatus);
    readTextSpy.mockResolvedValue('p\tq\n7\t8');
    act(() => {
      (host.querySelector('[data-testid="csv-cell-0-0"]') as HTMLElement)
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    const pasteBtn = host.querySelector('button[title="csv.menuPaste"]') as HTMLButtonElement;
    act(() => { pasteBtn.click(); });
    await frame();
    expect(readTextSpy).toHaveBeenCalledTimes(1);
    expect(latest).toBe('p,q\n7,8\n');
  });
});

/* ---------- 只读态排序 / 筛选 ---------- */

/* React 19 受控输入：直接赋 value 不触发 onChange，需经原生 setter 派发 */
const setInputValue = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('CsvGridEditor 排序筛选视图', () => {
  let host: HTMLElement;
  let root: Root;
  let latest: string;

  const renderGrid = (content: string) => {
    act(() => {
      root.render(
        <CsvGridEditor
          content={content}
          delimiter=","
          isDarkMode={false}
          headerOn={false}
          onChange={(v) => { latest = v; renderGrid(v); }}
          onHeaderToggle={() => {}}
          onWidthsChange={() => {}}
        />,
      );
    });
  };

  beforeEach(() => {
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    latest = '';
    renderGrid('name,score\nbeta,10\nalpha,9\ngamma,2\n');
  });

  it('筛选：只保留命中行，行号显示原始行号', async () => {
    const input = host.querySelector('[data-testid="csv-filter-input"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    act(() => { setInputValue(input, 'alpha'); });
    await frame();
    /* 4 行数据（含表头行）只留 表头 + alpha 行 */
    expect(host.querySelector('[data-testid="csv-cell-2-0"]')).toBeNull();
    expect(host.textContent).toContain('alpha');
    /* 原始行号：alpha 是数据第 3 行（1 起计），行号紧邻内容 */
    expect(host.textContent).toContain('3alpha');
  });

  it('排序与筛选叠加时单元格编辑写回原始行', async () => {
    const input = host.querySelector('[data-testid="csv-filter-input"]') as HTMLInputElement;
    act(() => { setInputValue(input, 'lph'); });
    await frame();
    /* 命中 alpha（原始数据行 2，显示行 0）；双击其首格进入编辑并提交 */
    act(() => {
      (host.querySelector('[data-testid="csv-cell-0-0"]') as HTMLElement)
        .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    const edit = host.querySelector('[data-testid="csv-edit-input"]') as HTMLInputElement;
    act(() => {
      setInputValue(edit, 'ALPHA');
      edit.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await frame();
    /* 写回的是原始第 2 数据行，其余行原样 */
    expect(latest).toBe('name,score\nbeta,10\nALPHA,9\ngamma,2\n');
  });

  it('筛选态下原生粘贴不改数据（结构操作降级）', async () => {
    const input = host.querySelector('[data-testid="csv-filter-input"]') as HTMLInputElement;
    act(() => { setInputValue(input, 'alpha'); });
    await frame();
    const grid = host.querySelector('[role="grid"]') as HTMLElement;
    grid.focus();
    act(() => { firePaste(grid, 'x\ty'); });
    await frame();
    expect(latest).toBe('');
  });

  it('清空筛选恢复全部行', async () => {
    const input = host.querySelector('[data-testid="csv-filter-input"]') as HTMLInputElement;
    act(() => { setInputValue(input, 'zzz-no-match'); });
    await frame();
    /* 无命中：仅剩表头行（headerOn=false 时 0 行数据） */
    expect(host.querySelectorAll('.csv-row').length).toBe(0);
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await frame();
    expect(host.querySelectorAll('.csv-row').length).toBeGreaterThan(0);
  });
});
