// @vitest-environment jsdom
/**
 * LargeFileViewer 渲染冒烟：mock Tauri invoke 后验证
 * ① probe 信息栏（大小/行数/编码）与首窗行内容渲染；
 * ② 二进制判定切换 HexView（每行 16 字节 hex + ASCII）。
 * 虚拟滚动的滚动条代理映射在 lib/largeFile.test.ts 纯函数覆盖。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));
vi.mock('../lib/i18nContext', () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) =>
    vars ? `${key}${Object.values(vars).join(',')}` : key,
}));

import { invoke } from '@tauri-apps/api/core';
import { LargeFileViewer } from './LargeFileViewer';

const mockInvoke = vi.mocked(invoke);

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/* React 19 手写 createRoot 测试需显式声明 act 环境 */
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

function render(el: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root!.render(el); });
}

beforeEach(() => {
  mockInvoke.mockReset();
  (globalThis as any).ResizeObserver = FakeResizeObserver;
});

/* 换窗请求带 120ms 去抖，且 act 在回调结束时才 flush passive effect：
   第一轮等 probe 落地 + 换窗 effect 设定时器，第二轮等定时器触发 + 窗口数据落地 */
async function settleTimers() {
  await act(async () => { await new Promise(r => setTimeout(r, 250)); });
  await act(async () => { await new Promise(r => setTimeout(r, 250)); });
}

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  root = null;
  container = null;
});

describe('LargeFileViewer', () => {
  it('文本大文件：probe 信息栏 + 首窗行内容渲染', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'probe_large_file') {
        return Promise.resolve({
          sizeBytes: 40 * 1024 * 1024, totalLines: 900_000,
          encoding: 'utf-8', bom: false, binary: false,
        });
      }
      if (cmd === 'read_line_window') {
        return Promise.resolve({
          startLine: 0, lines: ['alpha', 'beta', 'gamma'],
          truncated: [false, false, false], endOffset: 15,
        });
      }
      return Promise.reject(new Error(`unexpected cmd: ${cmd}`));
    });

    render(<LargeFileViewer path="C:/big.log" name="big.log" isDarkMode={false} onExtract={() => {}} />);
    await settleTimers();

    const text = container!.textContent ?? '';
    expect(text).toContain('40.0 MB');
    expect(text).toContain('900,000');
    expect(text).toContain('alpha');
    expect(text).toContain('gamma');
    expect(mockInvoke).toHaveBeenCalledWith('probe_large_file', { path: 'C:/big.log', force: null });
  });

  it('二进制大文件：切十六进制视图（16 字节/行）', async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === 'probe_large_file') {
        return Promise.resolve({
          sizeBytes: 1024, totalLines: 64, encoding: 'utf-8', bom: false, binary: true,
        });
      }
      if (cmd === 'read_byte_window') {
        /* "Hi!" + NUL + 12 个 0x41 */
        const bytes = new Array(16).fill(0x41);
        bytes[0] = 0x48; bytes[1] = 0x69; bytes[2] = 0x21; bytes[3] = 0x00;
        return Promise.resolve(bytes);
      }
      return Promise.reject(new Error(`unexpected cmd: ${cmd}`));
    });

    render(<LargeFileViewer path="C:/blob.bin" name="blob.bin" isDarkMode={false} onExtract={() => {}} />);
    await settleTimers();

    const text = container!.textContent ?? '';
    /* 首行偏移 00000000；hex 48 69 21 00；ASCII 侧 "Hi!" + 不可打印占位 */
    expect(text).toContain('00000000');
    expect(text).toContain('48');
    expect(text).toContain('69');
    expect(text).toContain('21');
    expect(text).toContain('Hi!·');
  });
});
