// @vitest-environment jsdom
/**
 * ① 纯逻辑：列号 → 表格软件地址记法（网格变换逻辑在 lib/csv.test.ts 覆盖）；
 * ② 粘贴通道：网格粘贴必须走原生 paste 事件（clipboardData），任何路径都不得
 *    调 navigator.clipboard.readText —— 浏览器里那会弹「查看剪贴板」授权框。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/* React 19：声明 act 测试环境，消除 "not configured to support act(...)" 噪音 */
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/* jsdom 缺失：网格视口量测需要 ResizeObserver */
(window as any).ResizeObserver = class {
  observe() {} unobserve() {} disconnect() {}
};
/* rAF 兜底（部分 jsdom 配置不启用 pretendToBeVisual） */
if (typeof window.requestAnimationFrame !== 'function') {
  (window as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 16) as unknown as number;
}

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
const firePaste = (el: Element, text: string, html?: string) => {
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', {
    value: { getData: (type: string) => (type === 'text/html' ? html : text) || '' },
  });
  el.dispatchEvent(ev);
};

/* 60ms：jsdom 的 rAF 是 16ms 定时器，62 个 worker 并行满载时 20ms 可能不够冲刷一帧 */
const frame = () => act(async () => { await new Promise(r => setTimeout(r, 60)); });

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

  it('纯文本多行无制表符粘贴到单格：整段进一格，不覆盖下方行（回归）', async () => {
    act(() => {
      (host.querySelector('[data-testid="csv-cell-0-0"]') as HTMLElement)
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    });
    act(() => { firePaste(gridEl(), '其实我在想最开始的镜头是这样的\n先展示地下竞技场的样貌。\n切镜头。'); });
    await frame();
    /* 旧实现按行拆成 3 行 × 1 列覆盖 (0,0)-(2,0)；现整段写入一格（含换行，序列化加引号） */
    expect(latest).toBe('"其实我在想最开始的镜头是这样的\n先展示地下竞技场的样貌。\n切镜头。",b\n1,2\n');
  });

  it('多行文本粘贴到已选多行区块：仍按表格拆行写入（拆行粘贴的出口保留）', async () => {
    act(() => {
      (host.querySelector('[data-testid="csv-cell-0-0"]') as HTMLElement)
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      (host.querySelector('[data-testid="csv-cell-1-0"]') as HTMLElement)
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, shiftKey: true }));
    });
    act(() => { firePaste(gridEl(), 'x\ny'); });
    await frame();
    expect(latest).toBe('x,b\ny,2\n');
  });

  it('HTML 剪贴板优先按表格解析：多行单元格（br/换行）进一格', async () => {
    act(() => {
      (host.querySelector('[data-testid="csv-cell-0-0"]') as HTMLElement)
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    });
    const html = '<table><tr><td>A<br>B</td><td>z</td></tr><tr><td>c</td><td>d</td></tr></table>';
    act(() => { firePaste(gridEl(), 'A Bz', html); });
    await frame();
    expect(latest).toBe('"A\nB",z\nc,d\n');
  });

  it('复制同时写 text/plain 与 text/html：多行单元格在 html 里保持单格结构', async () => {
    act(() => {
      root.render(
        <CsvGridEditor
          content={'"l1\nl2",b\nc,d'}
          delimiter=","
          isDarkMode={false}
          headerOn={false}
          onChange={(v) => { latest = v; }}
          onHeaderToggle={() => {}}
          onWidthsChange={() => {}}
        />,
      );
    });
    const htmlWriteSpy = vi.fn((_items: Array<{ items: Record<string, string> }>) => Promise.resolve());
    const plainWriteSpy = vi.fn((_text: string) => Promise.resolve());
    setNavigator('clipboard', { writeText: plainWriteSpy, write: htmlWriteSpy });
    (globalThis as any).ClipboardItem = class { items: Record<string, string>; constructor(items: Record<string, string>) { this.items = items; } };
    try {
      act(() => {
        (host.querySelector('[data-testid="csv-cell-0-0"]') as HTMLElement)
          .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      });
      act(() => {
        gridEl().dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true }));
      });
      await frame();
      expect(htmlWriteSpy).toHaveBeenCalledTimes(1);
      expect(plainWriteSpy).not.toHaveBeenCalled();
      const item = htmlWriteSpy.mock.calls[0][0][0];
      expect(item.items['text/plain']).toBe('"l1\nl2"\n');
      expect(item.items['text/html']).toContain('<td>l1\nl2</td>');
    } finally {
      delete (globalThis as any).ClipboardItem;
    }
  });

  it('编辑态右键粘贴：插入编辑框光标处，不提交不拆行（回归）', async () => {
    act(() => {
      (host.querySelector('[data-testid="csv-cell-0-0"]') as HTMLElement)
        .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    const edit = host.querySelector('[data-testid="csv-edit-input"]') as HTMLTextAreaElement;
    expect(edit).not.toBeNull();
    expect(document.activeElement).toBe(edit);
    queryPermission.mockResolvedValue({ state: 'granted' } as PermissionStatus);
    readTextSpy.mockResolvedValue('A\nB');
    act(() => {
      edit.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    const pasteBtn = host.querySelector('button[title="csv.menuPaste"]') as HTMLButtonElement;
    expect(pasteBtn).not.toBeNull();
    act(() => { pasteBtn.click(); });
    await frame();
    /* 未提交（无写回、无拆行覆盖）；双击后光标在末尾，剪贴板内容插在原值之后 */
    expect(latest).toBe('');
    expect(edit.value).toBe('aA\nB');
    expect(document.activeElement).toBe(edit);
  });
});

/* ---------- 只读态排序 / 筛选 ---------- */

/* React 19 受控输入：直接赋 value 不触发 onChange，需经原生 setter 派发 */
const setInputValue = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = el instanceof window.HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
;

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
    const edit = host.querySelector('[data-testid="csv-edit-input"]') as HTMLTextAreaElement;
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

/* ---------- 单元格编辑与顶部编辑栏 ---------- */

describe('CsvGridEditor 单元格编辑与编辑栏', () => {
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

  const clickCell = (sel: string) => {
    const cell = host.querySelector(sel) as HTMLElement;
    act(() => {
      cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      cell.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
  };

  const dblclickCell = (sel: string) => {
    act(() => {
      (host.querySelector(sel) as HTMLElement)
        .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
  };

  const editInput = () => host.querySelector('[data-testid="csv-edit-input"]') as HTMLTextAreaElement | null;
  const formulaInput = () => host.querySelector('[data-testid="csv-formula-input"]') as HTMLTextAreaElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    latest = '';
    renderGrid('源矿*1/3s,a\n1,2');
  });

  it('双击进入编辑：拖选收尾的 rAF 不得抢走编辑框焦点（闪现即关的根因）', async () => {
    dblclickCell('[data-testid="csv-cell-0-0"]');
    expect(editInput()).not.toBeNull();
    expect(document.activeElement).toBe(editInput());
    await frame();
    await frame();
    /* 回归：双击第二下 mouseup 注册的 rAF 晚于 dblclick 执行，
       旧实现 wrapper.focus() 抢焦点 → blur → 编辑框开启当帧即被关闭 */
    expect(editInput()).not.toBeNull();
    expect(document.activeElement).toBe(editInput());
  });

  it('单击选中后键入进入编辑：光标落在代入字符之后（"20" 不得变成 "02"）', async () => {
    clickCell('[data-testid="csv-cell-0-0"]');
    await frame();
    const grid = host.querySelector('[role="grid"]') as HTMLElement;
    grid.focus();
    act(() => {
      grid.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true, cancelable: true }));
    });
    const edit = editInput();
    expect(edit).not.toBeNull();
    expect(edit!.value).toBe('2'); // 键入字符替换原内容（Excel 语义）
    /* 回归：程序化 focus 的光标在文本开头，不挪到末尾则第二个字符插到最前 */
    expect(edit!.selectionStart).toBe(1);
    expect(edit!.selectionEnd).toBe(1);
    /* 按当前光标位置模拟继续键入 '0'（jsdom 不会自动插入） */
    act(() => {
      const s = edit!.selectionStart ?? 0;
      const e = edit!.selectionEnd ?? s;
      setInputValue(edit!, edit!.value.slice(0, s) + '0' + edit!.value.slice(e));
    });
    expect(edit!.value).toBe('20');
    act(() => {
      edit!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await frame();
    expect(latest).toBe('20,a\n1,2\n');
  });

  it('编辑栏修改：焦点不丢、逐键保留、不提前提交，Enter 才落盘', async () => {
    clickCell('[data-testid="csv-cell-0-0"]');
    await frame();
    act(() => { formulaInput().focus(); });
    expect(document.activeElement).toBe(formulaInput());
    /* 模拟两下退格（受控输入经原生 setter 触发 onChange） */
    act(() => { setInputValue(formulaInput(), '源矿*1/3'); });
    expect(document.activeElement).toBe(formulaInput());
    expect(latest).toBe(''); // 第一个键不得触发提交
    act(() => { setInputValue(formulaInput(), '源矿*'); });
    expect(document.activeElement).toBe(formulaInput());
    /* 单元格编辑框镜像同一份编辑值 */
    expect(editInput()?.value).toBe('源矿*');
    act(() => {
      formulaInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await frame();
    expect(latest).toBe('源矿*,a\n1,2\n');
    expect(editInput()).toBeNull();
  });

  it('焦点在编辑栏与单元格编辑框之间移动＝同一编辑，不触发提交', async () => {
    dblclickCell('[data-testid="csv-cell-0-0"]');
    await frame();
    expect(editInput()).not.toBeNull();
    act(() => { formulaInput().focus(); }); // 转到编辑栏继续编辑
    await frame();
    expect(editInput()).not.toBeNull(); // 不因单元格框 blur 而关框
    act(() => { setInputValue(formulaInput(), '源矿*1/3sX'); });
    act(() => { editInput()!.focus(); }); // 回到单元格框
    await frame();
    expect(editInput()).not.toBeNull();
    expect(latest).toBe('');
  });

  it('输入法组词中的 Enter 不提交，松开后的 Enter 正常关闭', async () => {
    dblclickCell('[data-testid="csv-cell-0-0"]');
    expect(editInput()).not.toBeNull();
    act(() => {
      const composing = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      Object.defineProperty(composing, 'isComposing', { value: true });
      editInput()!.dispatchEvent(composing);
    });
    expect(editInput()).not.toBeNull(); // 仍在编辑
    act(() => {
      editInput()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await frame();
    expect(editInput()).toBeNull(); // 编辑关闭
    expect(latest).toBe(''); // 值未变，无写回
  });

  it('Alt+Enter 单元格内换行不提交；Enter 提交含换行内容（CSV 引号转义）', async () => {
    dblclickCell('[data-testid="csv-cell-0-0"]');
    const edit = editInput()!;
    act(() => { setInputValue(edit, 'ab'); edit.setSelectionRange(1, 1); });
    act(() => {
      edit.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true, cancelable: true }));
    });
    expect(editInput()).not.toBeNull(); // 仍在编辑
    expect(latest).toBe('');
    expect(edit.value).toBe('a\nb'); // jsdom 无 execCommand，走手动拼接
    act(() => {
      editInput()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await frame();
    expect(latest).toBe('"a\nb",a\n1,2\n'); // 换行字段按 RFC 4180 加引号
  });

  it('编辑栏 Escape 取消：不写回内容', async () => {
    clickCell('[data-testid="csv-cell-0-0"]');
    await frame();
    act(() => { formulaInput().focus(); });
    act(() => { setInputValue(formulaInput(), 'zzz'); });
    act(() => {
      formulaInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await frame();
    expect(latest).toBe('');
    expect(editInput()).toBeNull();
  });
});

/* ---------- 列/行拖拽互换 ---------- */
/* jsdom 无布局：视口矩形为零，坐标按常量推算——列宽 64px（6 单位×8+16）、
   行高 28px、行号列 48px、列标行 28px。列 c 的命中带 x ∈ [48+64c, 48+64(c+1))，
   行 r 的命中带 y ∈ [28+28r, 28+28(r+1))。 */

describe('CsvGridEditor 列/行拖拽互换', () => {
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
    renderGrid('a,b\nc,d');
  });

  it('列标 A 拖到列标 B 上：两列内容互换，选区跟随到目标列', async () => {
    /* A 列标中心 (80,14)；B 列命中带 clientX ∈ [112,176)，取 140 */
    act(() => {
      (host.querySelector('[data-testid="csv-colhead-0"]') as HTMLElement)
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 80, clientY: 14 }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 140, clientY: 70 }));
    });
    await frame();
    act(() => { window.dispatchEvent(new MouseEvent('mouseup', { clientX: 140, clientY: 70 })); });
    await frame();
    expect(latest).toBe('b,a\nd,c\n');
    /* 选区跟随：整列选中，地址框显示目标列范围（与点击列标一致） */
    const addr = host.querySelector('[title="csv.formulaAria"]') as HTMLElement;
    expect(addr.textContent).toBe('B1:B30');
  });

  it('列标点击不拖动（<4px）：仅选中，不互换', async () => {
    act(() => {
      (host.querySelector('[data-testid="csv-colhead-0"]') as HTMLElement)
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 80, clientY: 14 }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 82, clientY: 15 }));
      window.dispatchEvent(new MouseEvent('mouseup', { clientX: 82, clientY: 15 }));
    });
    await frame();
    expect(latest).toBe('');
  });

  it('列拖入空白列区：原位留空、内容移动（互换空列）', async () => {
    act(() => {
      (host.querySelector('[data-testid="csv-colhead-0"]') as HTMLElement)
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 80, clientY: 14 }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 252, clientY: 70 })); // 列 D（避开网格线热区）
      window.dispatchEvent(new MouseEvent('mouseup', { clientX: 252, clientY: 70 }));
    });
    await frame();
    expect(latest).toBe(',b,,a\n,d,,c\n');
  });

  it('行号 1 拖到行号 2 上：两行内容互换', async () => {
    /* 行号元素：[0]=# 角标，[1]=数据行 0；行 r 命中带 clientY ∈ [28+28r, 28+28(r+1)) */
    act(() => {
      (host.querySelectorAll('.csv-rownum')[1] as HTMLElement)
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 24, clientY: 40 }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 140, clientY: 70 })); // 行 1
      window.dispatchEvent(new MouseEvent('mouseup', { clientX: 140, clientY: 70 }));
    });
    await frame();
    expect(latest).toBe('c,d\na,b\n');
  });

  it('排序/筛选生效期间拖拽互换禁用（结构操作降级）', async () => {
    const input = host.querySelector('[data-testid="csv-filter-input"]') as HTMLInputElement;
    act(() => { setInputValue(input, 'a'); });
    await frame();
    act(() => {
      (host.querySelector('[data-testid="csv-colhead-0"]') as HTMLElement)
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 80, clientY: 14 }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 140, clientY: 70 }));
      window.dispatchEvent(new MouseEvent('mouseup', { clientX: 140, clientY: 70 }));
    });
    await frame();
    expect(latest).toBe('');
  });

  it('列拖到网格线上：指示线出现，松手插入式移动（其余列顺移）', async () => {
    renderGrid('a,b,c\n1,2,3');
    act(() => {
      (host.querySelector('[data-testid="csv-colhead-0"]') as HTMLElement)
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 80, clientY: 14 }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 240, clientY: 70 })); // C 列右缘网格线
    });
    await frame();
    /* 悬停网格线热区：插入指示线可见 */
    expect(host.querySelector('[data-testid="csv-insert-line-col"]')).not.toBeNull();
    act(() => { window.dispatchEvent(new MouseEvent('mouseup', { clientX: 240, clientY: 70 })); });
    await frame();
    expect(host.querySelector('[data-testid="csv-insert-line-col"]')).toBeNull();
    /* a 移到 c 之后：b,c,a（互换空列会得到 ,b,c,a，可区分） */
    expect(latest).toBe('b,c,a\n2,3,1\n');
  });

  it('第 4 行拖到第 2 行：向上拖不丢尾部行（回归）', async () => {
    renderGrid('r1\nr2\nr3\nr4\nr5\nr6\nr7\nr8');
    /* 行 4 的行号 = rownum[4]（[0] 是 # 角标）；y=126 → r=3 */
    act(() => {
      (host.querySelectorAll('.csv-rownum')[4] as HTMLElement)
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 24, clientY: 126 }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 24, clientY: 70 })); // 行 2
      window.dispatchEvent(new MouseEvent('mouseup', { clientX: 24, clientY: 70 }));
    });
    await frame();
    expect(latest).toBe('r1\nr4\nr3\nr2\nr5\nr6\nr7\nr8\n');
  });

  it('行拖到网格线上：指示线出现，松手插入式移动', async () => {
    renderGrid('r1\nr2\nr3\nr4\nr5');
    act(() => {
      (host.querySelectorAll('.csv-rownum')[1] as HTMLElement)
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 24, clientY: 40 }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 24, clientY: 112 })); // 行 3/4 间网格线
    });
    await frame();
    expect(host.querySelector('[data-testid="csv-insert-line-row"]')).not.toBeNull();
    act(() => { window.dispatchEvent(new MouseEvent('mouseup', { clientX: 24, clientY: 112 })); });
    await frame();
    expect(host.querySelector('[data-testid="csv-insert-line-row"]')).toBeNull();
    expect(latest).toBe('r2\nr3\nr1\nr4\nr5\n');
  });
});

/* ---------- Ctrl 多选 / 自适应列宽 / 行高 ---------- */

describe('CsvGridEditor Ctrl 多选与工具', () => {
  let host: HTMLElement;
  let root: Root;
  let latest: string;
  let widths: number[] | null;
  let rowHSet: number | null;
  let rowHs: number[] | null;
  let wrapSet: boolean | null;

  const renderGrid = (content: string, props: Record<string, unknown> = {}) => {
    act(() => {
      root.render(
        <CsvGridEditor
          content={content}
          delimiter=","
          isDarkMode={false}
          headerOn={false}
          onChange={(v) => { latest = v; renderGrid(v, props); }}
          onHeaderToggle={() => {}}
          onWidthsChange={() => {}}
          {...props}
        />,
      );
    });
  };

  const gridEl = () => host.querySelector('[role="grid"]') as HTMLElement;
  const cell = (sel: string) => host.querySelector(`[data-testid="csv-cell-${sel}"]`) as HTMLElement;

  const plainClick = (sel: string) => {
    act(() => {
      cell(sel).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      cell(sel).dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
  };

  const ctrlClick = (sel: string) => {
    act(() => {
      cell(sel).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, ctrlKey: true }));
      cell(sel).dispatchEvent(new MouseEvent('mouseup', { bubbles: true, ctrlKey: true }));
    });
  };

  const pressDelete = () => {
    act(() => {
      gridEl().dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
    });
  };

  beforeEach(() => {
    document.body.innerHTML = '';
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    latest = '';
    widths = null;
    rowHSet = null;
    rowHs = null;
    wrapSet = null;
    renderGrid('a,b\nc,d');
  });

  it('Ctrl+点选追加选区，Delete 清空全部选中格', async () => {
    plainClick('0-0');
    ctrlClick('1-1');
    await frame();
    pressDelete();
    await frame();
    expect(latest).toBe(',b\nc,\n');
  });

  it('Ctrl+点击已选中的格子：收拢为该格，Delete 只清它', async () => {
    plainClick('0-0');
    ctrlClick('1-1');
    await frame();
    ctrlClick('1-1'); // 已在选区内 → 收拢为该格
    await frame();
    pressDelete();
    await frame();
    expect(latest).toBe('a,b\nc,\n');
  });

  it('普通点击重置多选：Delete 只清最后点击的格', async () => {
    plainClick('0-0');
    ctrlClick('1-1');
    await frame();
    plainClick('0-1');
    await frame();
    pressDelete();
    await frame();
    expect(latest).toBe('a,\nc,d\n');
  });

  it('自适应列宽按钮：始终可点，按内容实测宽度写入', async () => {
    renderGrid('a,b\nc,d', { manualWidths: [12, 20], onWidthsChange: (w: number[]) => { widths = w; } });
    const btn = host.querySelector('[data-testid="csv-autofit-widths"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    act(() => { btn.click(); });
    await frame();
    expect(widths).toEqual([6, 6]); // 短内容取下限 6
  });

  it('自适应列宽按钮：长文本列撑开到内容宽，超长封顶 200 单位', async () => {
    const long = '长'.repeat(300); // 300 个 CJK = 600 显示宽单位 → 封顶 200
    renderGrid(`${long},b\nc,d`, { onWidthsChange: (w: number[]) => { widths = w; } });
    const btn = host.querySelector('[data-testid="csv-autofit-widths"]') as HTMLButtonElement;
    act(() => { btn.click(); });
    await frame();
    expect(widths).toEqual([200, 6]);
  });

  it('行高生效于渲染，右键行号可切换并回传', async () => {
    renderGrid('a,b\nc,d', { rowH: 40, onRowHChange: (h: number) => { rowHSet = h; } });
    await frame();
    const row = host.querySelector('.csv-row') as HTMLElement;
    expect(row.style.height).toBe('40px');
    act(() => {
      (host.querySelectorAll('.csv-rownum')[1] as HTMLElement)
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    /* rowH=40 时「宽松」项带勾选标记 */
    const relaxed = host.querySelector('button[title="csv.rowHeightRelaxed ✓"]') as HTMLButtonElement;
    expect(relaxed).not.toBeNull();
    act(() => { relaxed.click(); });
    await frame();
    expect(rowHSet).toBe(40);
  });

  it('逐行行高渲染：默认行高与手动行高并存', async () => {
    renderGrid('a,b\nc,d', { manualRowHeights: [0, 64] });
    await frame();
    const rows = host.querySelectorAll('.csv-row') as NodeListOf<HTMLElement>;
    expect(rows[0].style.height).toBe('28px');
    expect(rows[1].style.height).toBe('64px');
  });

  it('行高拖拽：行号底缘拖动调该行高度并回传', async () => {
    renderGrid('a,b\nc,d', { onRowHeightsChange: (hs: number[]) => { rowHs = hs; } });
    const handle = (host.querySelectorAll('.csv-rownum')[1] as HTMLElement)
      .querySelector('.cursor-row-resize') as HTMLElement;
    act(() => {
      handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientY: 100 }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientY: 130 })); // +30px
      window.dispatchEvent(new MouseEvent('mouseup', { clientY: 130 }));
    });
    await frame();
    expect(rowHs).toEqual([58]); // 默认 28 + 30
  });

  it('自适应表格大小：列宽按内容、行高按折行、自动开启换行', async () => {
    renderGrid('"l1\nl2\nl3",b\nc,d', {
      onWidthsChange: (w: number[]) => { widths = w; },
      onRowHeightsChange: (hs: number[]) => { rowHs = hs; },
      onWrapChange: (on: boolean) => { wrapSet = on; },
    });
    const btn = host.querySelector('[data-testid="csv-autofit-widths"]') as HTMLButtonElement;
    act(() => { btn.click(); });
    await frame();
    expect(widths).toEqual([6, 6]);
    expect(rowHs).toEqual([64, 28]); // 3 硬行 → 3×20+4；单行行维持默认 28
    expect(wrapSet).toBe(true);
  });

  it('换行开关切换并回传', async () => {
    renderGrid('a,b', { onWrapChange: (on: boolean) => { wrapSet = on; } });
    const btn = host.querySelector('[data-testid="csv-wrap-toggle"]') as HTMLButtonElement;
    act(() => { btn.click(); });
    await frame();
    expect(wrapSet).toBe(true);
  });

  it('换行渲染：多行内容原样显示（不转 ⏎）', async () => {
    renderGrid('"l1\nl2",b', { wrap: true });
    await frame();
    const span = (host.querySelector('[data-testid="csv-cell-0-0"]') as HTMLElement).querySelector('span') as HTMLElement;
    expect(span.className).toContain('whitespace-pre-wrap');
    expect(span.textContent).toBe('l1\nl2');
  });

  it('双击行号底缘恢复该行默认行高', async () => {
    renderGrid('a,b\nc,d', { manualRowHeights: [48], onRowHeightsChange: (hs: number[]) => { rowHs = hs; } });
    const handle = (host.querySelectorAll('.csv-rownum')[1] as HTMLElement)
      .querySelector('.cursor-row-resize') as HTMLElement;
    act(() => { handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    await frame();
    expect(rowHs).toEqual([0]);
  });
});
