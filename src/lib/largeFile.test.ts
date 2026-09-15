import { describe, it, expect } from 'vitest';
import {
  LARGE_FILE_EDIT_MAX_BYTES,
  LARGE_FILE_MAX_BYTES,
  classifyBySize,
  parseFileTooLarge,
  formatBytes,
  firstVisibleIndex,
} from './largeFile';

const MB = 1024 * 1024;

describe('classifyBySize', () => {
  it('≤ 32MB 可编辑', () => {
    expect(classifyBySize(0)).toBe('edit');
    expect(classifyBySize(32 * MB)).toBe('edit');
  });

  it('32MB < size ≤ 512MB 只读分块预览', () => {
    expect(classifyBySize(32 * MB + 1)).toBe('preview');
    expect(classifyBySize(512 * MB)).toBe('preview');
  });

  it('> 512MB 拒绝', () => {
    expect(classifyBySize(512 * MB + 1)).toBe('reject');
  });
});

describe('parseFileTooLarge', () => {
  it('解析 FILE_TOO_LARGE 前缀取尺寸', () => {
    expect(parseFileTooLarge('FILE_TOO_LARGE:891289600')).toBe(891289600);
  });

  it('其他错误串返回 null', () => {
    expect(parseFileTooLarge('UNKNOWN_ENCODING:gbk')).toBeNull();
    expect(parseFileTooLarge('FILE_CHANGED')).toBeNull();
    expect(parseFileTooLarge('')).toBeNull();
  });
});

describe('formatBytes', () => {
  it('B / KB / MB / GB 阶梯', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(64 * MB)).toBe('64.0 MB');
    expect(formatBytes(1.5 * 1024 * MB)).toBe('1.5 GB');
  });
});

describe('常量与 Rust 侧对齐', () => {
  it('32MB / 512MB 阈值', () => {
    expect(LARGE_FILE_EDIT_MAX_BYTES).toBe(32 * 1024 * 1024);
    expect(LARGE_FILE_MAX_BYTES).toBe(512 * 1024 * 1024);
  });
});

describe('firstVisibleIndex：滚动条代理 → 首行映射', () => {
  const ROWS = 40;

  it('顶部为 0、底部为末屏首行', () => {
    expect(firstVisibleIndex(0, 1000, 1000, ROWS)).toBe(0);
    expect(firstVisibleIndex(1000, 1000, 1000, ROWS)).toBe(960);
  });

  it('不可滚动（内容不足一屏）恒为 0', () => {
    expect(firstVisibleIndex(0, 0, 100, ROWS)).toBe(0);
    expect(firstVisibleIndex(50, 0, 100, ROWS)).toBe(0);
  });

  it('不超限文档等价 scrollTop / LINE_H 的连续映射', () => {
    /* 100000 行 × 21px：scrollTop 4200 → 行 200 */
    const total = 100_000, lineH = 21;
    const maxScroll = total * lineH - ROWS * lineH;
    const scrollTop = 200 * lineH;
    expect(firstVisibleIndex(scrollTop, maxScroll, total, ROWS)).toBeCloseTo(200, 0);
  });

  it('超限文档按分数压缩映射且不越界', () => {
    /* 500 万行超出布局上限：滚动中点应落在文档中点附近 */
    const total = 5_000_000, maxScroll = 16_000_000;
    expect(firstVisibleIndex(maxScroll / 2, maxScroll, total, ROWS)).toBeCloseTo(2_500_000, -6);
    expect(firstVisibleIndex(maxScroll, maxScroll, total, ROWS)).toBe(total - ROWS);
  });
});
