/**
 * 浮层总线的自身契约：安卓返回键链靠这里的「有没有开着的」布尔决定要不要退出 App，
 * 所以两件事必须是硬的——
 *  1) open/close 严格配对计数：漏收一次就永远算「开着」，返回键再也退不出去；
 *  2) 格式菜单与选区操作条两层互不串线：预览里菜单开着时条也开着，返回键要能一层层收。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  notifyFmtMenuOpen, notifyFmtMenuClosed, subscribeFmtMenuOpen, registerFmtMenuClose, closeAllFmtMenus,
  notifySelBarOpen, notifySelBarClosed, subscribeSelBarOpen, registerSelBarClose, closeAllSelBars,
} from './fmtMenuBus';

describe('fmtMenuBus 浮层通道', () => {
  it('open/close 配对计数；多出来的 close 不会把计数压成负数', () => {
    const seen: boolean[] = [];
    const off = subscribeFmtMenuOpen(o => seen.push(o));
    notifyFmtMenuOpen();
    notifyFmtMenuOpen();
    expect(seen).toEqual([true, true]);
    notifyFmtMenuClosed();
    notifyFmtMenuClosed();
    expect(seen.at(-1)).toBe(false);
    notifyFmtMenuClosed(); /* 没有配对的开：不该再推 true→false 之外的状态 */
    expect(seen.at(-1)).toBe(false);
    off();
  });

  it('closeAll 逐个执行登记过的关闭；已卸载（清理过）的不再被叫到', () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = registerFmtMenuClose(a);
    registerFmtMenuClose(b);
    offA();
    closeAllFmtMenus();
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('两层独立：只开选区操作条时，格式菜单那一层仍报 false', () => {
    const menu: boolean[] = [];
    const bar: boolean[] = [];
    const offMenu = subscribeFmtMenuOpen(o => menu.push(o));
    const offBar = subscribeSelBarOpen(o => bar.push(o));
    notifySelBarOpen();
    /* 订的是菜单层，条开合不该往它推任何一次（订阅不回放当前值） */
    expect(menu).toEqual([]);
    expect(bar.at(-1)).toBe(true);
    notifySelBarClosed();
    expect(bar.at(-1)).toBe(false);
    offMenu();
    offBar();
  });

  it('两层的关闭回调各走各的通道', () => {
    const closeMenu = vi.fn();
    const closeBar = vi.fn();
    const off1 = registerFmtMenuClose(closeMenu);
    const off2 = registerSelBarClose(closeBar);
    closeAllSelBars();
    expect(closeBar).toHaveBeenCalledTimes(1);
    expect(closeMenu).not.toHaveBeenCalled();
    closeAllFmtMenus();
    expect(closeMenu).toHaveBeenCalledTimes(1);
    off1();
    off2();
  });
});
