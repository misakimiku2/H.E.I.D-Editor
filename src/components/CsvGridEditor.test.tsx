// @vitest-environment jsdom
/**
 * CSV 网格编辑器中可提取的纯逻辑：列号 → 表格软件地址记法
 * （编辑栏地址框显示）。网格变换逻辑在 lib/csv.test.ts 覆盖。
 */
import { describe, expect, it } from 'vitest';
import { cellAddr, colLabel } from './CsvGridEditor';

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
