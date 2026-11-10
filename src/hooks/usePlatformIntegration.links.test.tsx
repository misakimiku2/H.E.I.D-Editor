// @vitest-environment jsdom
/**
 * 预览链接导航守卫：本地 Markdown 链接按文档目录解析后开新标签；
 * 外链交给系统浏览器；锚点放行；网页相对路径/非 md 文件维持拦截。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../lib/fileIO', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isTauri: false,
}));
const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn(async () => {}) }));
vi.mock('../lib/openExternal', () => ({
  openExternal,
  isHttpUrl: (u: string) => /^https?:\/\//i.test(u),
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { usePlatformIntegration, type OverlayActions, type OverlayState } from './usePlatformIntegration';

const openPathIntoTab = vi.fn(async () => {});

function Probe() {
  const tabsRef = useRef<{ isDirty: boolean }[]>([]);
  const confirmWindowCloseRef = useRef<() => Promise<boolean>>(async () => false);
  usePlatformIntegration({
    openPathIntoTab,
    openPathFromExternal: async () => {},
    openSharedText: () => {},
    hydrated: true,
    tabsRef,
    confirmWindowCloseRef,
    overlayState: {} as OverlayState,
    overlayActions: {} as OverlayActions,
  });
  return (
    <div>
      <div data-md-preview data-md-base-dir="C:\Users\me\剧情">
        <a id="rel" href="第01章_坠落.md">章</a>
        <a id="sub" href="%E5%89%A7%E6%83%85/%E7%AC%AC02%E7%AB%A0.md">子目录</a>
        <a id="enc" href="%E7%AC%AC02%E7%AB%A0.md#标题">章二</a>
        <a id="file" href="file:///C:/docs/x.md">文件</a>
        <a id="img" href="图.png">图</a>
        <a id="anchor" href="#章节">锚点</a>
        <a id="web" href="https://example.com/a">网页</a>
      </div>
      <div data-md-preview data-md-base-dir="">
        <a id="nobase" href="x.md">无基准</a>
      </div>
      <div id="outside-wrap"><a id="outside" href="x.md">外部</a></div>
    </div>
  );
}

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  openPathIntoTab.mockClear();
  openExternal.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root!.render(<Probe />); });
});

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
});

function click(id: string): boolean {
  const e = new MouseEvent('click', { bubbles: true, cancelable: true });
  act(() => { container!.querySelector(`#${id}`)!.dispatchEvent(e); });
  return e.defaultPrevented;
}

describe('预览链接导航守卫', () => {
  it('相对 .md 链接按文档目录解析后开标签', () => {
    expect(click('rel')).toBe(true);
    expect(openPathIntoTab).toHaveBeenCalledWith('C:\\Users\\me\\剧情\\第01章_坠落.md');
  });

  it('子文件夹路径按文档目录拼接', () => {
    click('sub');
    expect(openPathIntoTab).toHaveBeenCalledWith('C:\\Users\\me\\剧情\\剧情\\第02章.md');
  });

  it('%编码与 #锚点先还原/剥掉', () => {
    click('enc');
    expect(openPathIntoTab).toHaveBeenCalledWith('C:\\Users\\me\\剧情\\第02章.md');
  });

  it('file:/// 绝对路径直接打开', () => {
    click('file');
    expect(openPathIntoTab).toHaveBeenCalledWith('C:\\docs\\x.md');
  });

  it('非 Markdown 文件与缺基准目录的相对链接保持拦截但不打开', () => {
    expect(click('img')).toBe(true);
    expect(click('nobase')).toBe(true);
    expect(openPathIntoTab).not.toHaveBeenCalled();
  });

  it('外链交给系统浏览器', () => {
    expect(click('web')).toBe(true);
    expect(openExternal).toHaveBeenCalledWith('https://example.com/a');
  });

  it('文档内锚点放行', () => {
    expect(click('anchor')).toBe(false);
  });

  it('预览之外的链接不打开本地文件', () => {
    expect(click('outside')).toBe(true);
    expect(openPathIntoTab).not.toHaveBeenCalled();
  });
});
