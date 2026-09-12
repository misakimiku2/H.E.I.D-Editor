import { describe, expect, it } from 'vitest';
import {
  applyLineEnding, detectLineEnding, normalizeToLf,
} from './lineEndings';

describe('detectLineEnding', () => {
  it('无换行符时默认 LF 且不视为混用', () => {
    expect(detectLineEnding('hello')).toEqual({ eol: 'lf', mixed: false, crlf: 0, lf: 0, cr: 0 });
    expect(detectLineEnding('')).toEqual({ eol: 'lf', mixed: false, crlf: 0, lf: 0, cr: 0 });
  });

  it('识别 CRLF', () => {
    expect(detectLineEnding('a\r\nb\r\nc')).toMatchObject({ eol: 'crlf', crlf: 2, lf: 0, cr: 0, mixed: false });
  });

  it('识别 LF 与 CR', () => {
    expect(detectLineEnding('a\nb\nc')).toMatchObject({ eol: 'lf', lf: 2, mixed: false });
    expect(detectLineEnding('a\rb\rc')).toMatchObject({ eol: 'cr', cr: 2, mixed: false });
  });

  it('混用时取主导换行符并标记 mixed', () => {
    const d = detectLineEnding('a\r\nb\r\nc\nd');
    expect(d.mixed).toBe(true);
    expect(d.eol).toBe('crlf');
  });

  it('文件末尾换行符也被计入', () => {
    expect(detectLineEnding('a\r\n')).toMatchObject({ eol: 'crlf', crlf: 1 });
  });
});

describe('normalizeToLf / applyLineEnding', () => {
  it('CRLF 与 CR 归一为 LF', () => {
    expect(normalizeToLf('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });

  it('按目标换行符输出，LF 原样返回引用', () => {
    const text = 'a\nb';
    expect(applyLineEnding(text, 'lf')).toBe(text);
    expect(applyLineEnding(text, 'crlf')).toBe('a\r\nb');
    expect(applyLineEnding(text, 'cr')).toBe('a\rb');
  });

  it('LF → CRLF → LF 往返无损', () => {
    const text = '第一行\nsecond\n\n第四';
    expect(normalizeToLf(applyLineEnding(text, 'crlf'))).toBe(text);
  });
});
