// @vitest-environment jsdom
/**
 * 查找浮层冒烟：挂载（Ctrl+F 打开）后查找输入框自动聚焦。
 * 首帧浮层按指针定位前是 visibility:hidden，hidden 下 focus() 静默无效——
 * 聚焦必须等位置就绪，此测试锁住该行为。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/i18nContext', () => ({
  useT: () => (key: string) => key,
}));

import { FindReplaceBar } from './FindReplaceBar';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

function render(el: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root!.render(el); });
}

const baseProps = {
  getView: () => null,
  isDarkMode: false,
  showReplace: false,
  gotoMode: false,
  canReplace: false,
  onClose: () => {},
};

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  root = null;
  container = null;
});

describe('FindReplaceBar 自动聚焦', () => {
  it('挂载后查找输入框获得焦点并全选', () => {
    render(<FindReplaceBar {...baseProps} />);
    const input = document.body.querySelector('input[placeholder="find.placeholderFind"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(document.activeElement).toBe(input);
  });

  it('跳行模式聚焦行号输入框', () => {
    render(<FindReplaceBar {...baseProps} gotoMode />);
    const input = document.body.querySelector('input[placeholder="find.placeholderGoto"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(document.activeElement).toBe(input);
  });
});

/**
 * 三端形态：桌面 = 指针定位浮层；安卓平板 = 贴窗口底缘的整幅停靠条（一行）；
 * 手机 = 同款停靠条但控件按两行重排（411dp 宽装不下七个 48dp 控件）。
 * 停靠与重排是两个独立开关（docked 看平台、stacked 看窄屏），此处锁住别被合回去。
 */
describe('FindReplaceBar 三端形态', () => {
  afterEach(() => {
    act(() => { root?.unmount(); });
    container?.remove();
    root = null;
    container = null;
    delete (window as any).matchMedia;
  });

  async function renderForm(android: boolean, narrow: boolean) {
    vi.resetModules();
    vi.doMock('../lib/platform', async () => ({
      ...(await vi.importActual<typeof import('../lib/platform')>('../lib/platform')),
      IS_ANDROID_APP: android,
      IS_TOUCH_PRIMARY: android,
    }));
    window.matchMedia = ((q: string) => ({
      media: q,
      matches: q === '(max-width: 767.98px)' ? narrow : false,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    const { FindReplaceBar: Bar } = await import('./FindReplaceBar');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => { root!.render(<Bar {...baseProps} canReplace />); });
    return document.querySelector('[role=search]') as HTMLElement;
  }

  it('桌面：指针定位浮层，不挂停靠类，也没有跳行开关（Ctrl+G 已够）', async () => {
    const panel = await renderForm(false, false);
    expect(panel.className).toContain('fixed');
    expect(panel.className).not.toContain('heid-find-dock');
    expect(panel.querySelector('[aria-label="find.gotoLine"]')).toBeNull();
  });

  it('安卓平板：整幅停靠条，控件仍是一行', async () => {
    const panel = await renderForm(true, false);
    expect(panel.className).toContain('heid-find-dock--tablet');
    expect(panel.className).not.toContain('heid-find-dock--phone');
    /* 一行形态：展开替换 + 三个匹配选项 + 跳行开关 + 三个导航钮同属一个行容器 */
    const rows = [...panel.children] as HTMLElement[];
    expect(rows[0].className).toContain('flex items-center');
    expect(rows[0].querySelectorAll('button')).toHaveLength(8);
    expect(rows[0].querySelector('[aria-label="find.gotoLine"]')).toBeTruthy();
  });

  it('手机端：停靠条 + 两行重排', async () => {
    const panel = await renderForm(true, true);
    expect(panel.className).toContain('heid-find-dock--phone');
    expect(panel.className).not.toContain('heid-find-dock--tablet');
    const rows = [...panel.children] as HTMLElement[];
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelectorAll('button')).toHaveLength(3);
    expect(rows[1].querySelectorAll('button')).toHaveLength(5);
  });

  it('触屏：按钮不抢焦点，展开替换后焦点交给替换框', async () => {
    const panel = await renderForm(true, false);
    const findBox = () => [...document.querySelectorAll<HTMLElement>('[role=search] input')];
    expect(document.activeElement).toBe(findBox()[0]);

    const expand = [...panel.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'find.expandReplace'
    ) as HTMLButtonElement;
    // tap 补发的 mousedown 若不改焦点，WebView 就不会把输入法收掉（用户反馈的那条）
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    expand.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);

    // 禁用态的按钮同样拦：按到没反应的钮不该把键盘弄没
    const next = [...panel.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'find.nextMatch'
    ) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    const downNext = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    next.dispatchEvent(downNext);
    expect(downNext.defaultPrevented).toBe(true);

    // 输入框自己不拦：光标定位与选字要靠它
    const downInput = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    findBox()[0].dispatchEvent(downInput);
    expect(downInput.defaultPrevented).toBe(false);

    act(() => { expand.click(); });
    const boxes = findBox();
    expect(boxes).toHaveLength(2);
    expect(document.activeElement).toBe(boxes[1]);

    // 收起时交还查找框，否则焦点停在刚消失的那格上
    const collapse = [...document.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'find.collapseReplace'
    ) as HTMLButtonElement;
    act(() => { collapse.click(); });
    expect(document.activeElement).toBe(findBox()[0]);
  });

  it('桌面：不拦 mousedown、也不接管焦点', async () => {
    const panel = await renderForm(false, false);
    const expand = [...panel.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'find.expandReplace'
    ) as HTMLButtonElement;
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    expand.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(false);
    act(() => { expand.click(); });
    expect(document.querySelectorAll('input')).toHaveLength(2);
    expect(document.activeElement).not.toBe(document.querySelectorAll('input')[1]);
  });
});

describe('FindReplaceBar 桌面拖拽', () => {
  const pev = (type: string, x: number, y: number) => {
    const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
    Object.defineProperty(ev, 'pointerId', { value: 1 });
    return ev;
  };

  it('按住栏面任意非输入区都能拖，且钳制在视口内', () => {
    render(<FindReplaceBar {...baseProps} />);
    const panel = document.body.querySelector('[role=search]') as HTMLElement;
    /* 指针未移动过：落在视口右上（1024 - 0 - 16 = 1008, 12） */
    expect(panel.style.left).toBe('1008px');
    expect(panel.style.top).toBe('12px');

    /* 从「区分大小写」按钮上按下，拖起来也算拖动（不是只有把手能拖） */
    const caseBtn = panel.querySelector('button[aria-label="find.caseSensitive"]') as HTMLElement;
    act(() => { caseBtn.dispatchEvent(pev('pointerdown', 100, 100)); });
    act(() => { caseBtn.dispatchEvent(pev('pointermove', 40, 60)); });
    /* 位移 (-60, -40)：top 到 8px 边距就停住 */
    expect(panel.style.left).toBe('948px');
    expect(panel.style.top).toBe('8px');
    act(() => { caseBtn.dispatchEvent(pev('pointerup', 40, 60)); });

    /* 拖动之后浏览器补的那次 click 被吞掉：拖一下不会误触按钮 */
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => { caseBtn.dispatchEvent(click); });
    expect(click.defaultPrevented).toBe(true);
    expect(caseBtn.className).not.toContain('bg-zinc-300');

    /* 松手后再动鼠标不再跟随 */
    act(() => { caseBtn.dispatchEvent(pev('pointermove', 300, 300)); });
    expect(panel.style.left).toBe('948px');
    expect(panel.style.top).toBe('8px');
  });

  it('位移不到阈值只是点按：按钮照常响应', () => {
    render(<FindReplaceBar {...baseProps} />);
    const panel = document.body.querySelector('[role=search]') as HTMLElement;
    const caseBtn = panel.querySelector('button[aria-label="find.caseSensitive"]') as HTMLButtonElement;
    act(() => { caseBtn.dispatchEvent(pev('pointerdown', 100, 100)); });
    act(() => { caseBtn.dispatchEvent(pev('pointermove', 102, 101)); });
    act(() => { caseBtn.dispatchEvent(pev('pointerup', 102, 101)); });
    /* 没被判定为拖动：位置不动，click 不被吞 */
    expect(panel.style.left).toBe('1008px');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => { caseBtn.dispatchEvent(click); });
    expect(click.defaultPrevented).toBe(false);
    expect(caseBtn.className).toContain('bg-zinc-300');
  });

  it('输入框内按下不触发拖动', () => {
    render(<FindReplaceBar {...baseProps} />);
    const panel = document.body.querySelector('[role=search]') as HTMLElement;
    const input = panel.querySelector('input') as HTMLInputElement;
    act(() => { input.dispatchEvent(pev('pointerdown', 100, 100)); });
    act(() => { input.dispatchEvent(pev('pointermove', 20, 300)); });
    act(() => { input.dispatchEvent(pev('pointerup', 20, 300)); });
    expect(panel.style.left).toBe('1008px');
    expect(panel.style.top).toBe('12px');
  });
});
