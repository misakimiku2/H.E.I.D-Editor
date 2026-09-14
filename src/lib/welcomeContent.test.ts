import { describe, it, expect } from 'vitest';
import { SAMPLE_CODE } from './welcomeContent';

describe('SAMPLE_CODE', () => {
  it('不含 \\r：CRLF 检出的源文件会被归一，避免 welcome 标签启动即被标脏', () => {
    /* 回归背景：源文件经 git autocrlf 检出为 CRLF 时，模板字面量把 \r 带进内容，
       CodeMirror 归一为 \n 触发 onChange，welcome 启动即脏 → 会话恢复每重启复制一个 welcome */
    expect(SAMPLE_CODE.includes('\r')).toBe(false);
    expect(SAMPLE_CODE.includes('\n')).toBe(true);
  });

  it('内容完整（多语言示例保留）', () => {
    expect(SAMPLE_CODE.includes('H.E.I.D')).toBe(true);
    expect(SAMPLE_CODE.includes('def greet')).toBe(true);
  });
});
