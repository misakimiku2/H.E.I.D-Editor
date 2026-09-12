import { describe, expect, it } from 'vitest';
import { resolveSystemLang, translate } from './i18n';

describe('resolveSystemLang', () => {
  it('zh 前缀解析为中文', () => {
    expect(resolveSystemLang('zh-CN')).toBe('zh');
    expect(resolveSystemLang('zh-TW')).toBe('zh');
    expect(resolveSystemLang('zh')).toBe('zh');
  });

  it('其余语言解析为英文', () => {
    expect(resolveSystemLang('en-US')).toBe('en');
    expect(resolveSystemLang('fr')).toBe('en');
  });

  it('缺失 / 非法输入回退英文', () => {
    expect(resolveSystemLang(undefined)).toBe('en');
    expect(resolveSystemLang('')).toBe('en');
  });
});

describe('translate', () => {
  it('按语言返回对应文案（menu.openFile）', () => {
    expect(translate('zh', 'menu.openFile')).toBe('打开文件');
    expect(translate('en', 'menu.openFile')).toBe('Open File');
  });

  it('支持 {var} 占位符插值（status.cursor）', () => {
    expect(translate('zh', 'status.cursor', { line: 3, col: 7 })).toBe('行 3, 列 7');
    expect(translate('en', 'status.cursor', { line: 3, col: 7 })).toBe('Ln 3, Col 7');
  });

  it('缺失插值参数时占位符原样保留', () => {
    expect(translate('zh', 'status.cursor')).toBe('行 {line}, 列 {col}');
  });

  it('未知 key 原样返回（不抛错）', () => {
    expect(translate('zh', 'nope.missing' as never)).toBe('nope.missing');
  });
});
