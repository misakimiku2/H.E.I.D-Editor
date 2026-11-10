import { describe, expect, it } from 'vitest';
import { codeLangLabel } from './codeLangLabel';

describe('codeLangLabel', () => {
  it('常见别名归一为应用内语言名', () => {
    expect(codeLangLabel('js')).toBe('JavaScript');
    expect(codeLangLabel('TS')).toBe('TypeScript');
    expect(codeLangLabel('py')).toBe('Python');
    expect(codeLangLabel('c++')).toBe('C++');
    expect(codeLangLabel('cs')).toBe('C#');
    expect(codeLangLabel('sh')).toBe('Shell');
  });

  it('纯文本返回空串（交给本地化文案）', () => {
    expect(codeLangLabel('')).toBe('');
    expect(codeLangLabel('text')).toBe('');
    expect(codeLangLabel('plaintext')).toBe('');
  });

  it('未知语言原样显示', () => {
    expect(codeLangLabel('svelte')).toBe('svelte');
  });
});
