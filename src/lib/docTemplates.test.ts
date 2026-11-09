import { describe, expect, it } from 'vitest';
import {
  NIKKE_SAMPLE, ensureMdExtension, renderTemplate, templateTitle, validateFileName,
} from './docTemplates';

describe('renderTemplate', () => {
  it('替换 title 与 date', () => {
    expect(renderTemplate('# {{title}} / {{date}}', { title: '玛丽安', date: '2026-11-09' }))
      .toBe('# 玛丽安 / 2026-11-09');
  });
  it('容忍花括号内侧空白', () => {
    expect(renderTemplate('{{ title }}|{{ date }}', { title: 'A', date: 'D' })).toBe('A|D');
  });
  it('未知键原样保留', () => {
    expect(renderTemplate('{{foo}} {{title}}', { title: 'A', date: 'D' })).toBe('{{foo}} A');
  });
  it('多次出现全部替换', () => {
    expect(renderTemplate('{{title}}-{{title}}', { title: 'A', date: 'D' })).toBe('A-A');
  });
  it('大小写敏感，仅匹配小写键', () => {
    expect(renderTemplate('{{Title}} {{TITLE}}', { title: 'A', date: 'D' })).toBe('{{Title}} {{TITLE}}');
  });
});

describe('ensureMdExtension', () => {
  it('无扩展名补 .md', () => { expect(ensureMdExtension('角色')).toBe('角色.md'); });
  it('已有 .md 不变', () => { expect(ensureMdExtension('a.md')).toBe('a.md'); });
  it('大小写不敏感判断 .md', () => { expect(ensureMdExtension('A.MD')).toBe('A.MD'); });
  it('其他扩展名仍追加 .md', () => { expect(ensureMdExtension('a.txt')).toBe('a.txt.md'); });
});

describe('templateTitle', () => {
  it('去掉 .md', () => { expect(templateTitle('玛丽安.md')).toBe('玛丽安'); });
  it('大小写不敏感去 .md', () => { expect(templateTitle('A.MD')).toBe('A'); });
  it('无 .md 原样', () => { expect(templateTitle('玛丽安')).toBe('玛丽安'); });
});

describe('validateFileName', () => {
  it('正常名合法', () => { expect(validateFileName('玛丽安：女王')).toBeNull(); });
  it('空名非法', () => { expect(validateFileName('')).toBe('empty'); });
  it('纯空白非法', () => { expect(validateFileName('   ')).toBe('empty'); });
  it.each(['\\', '/', ':', '*', '?', '"', '<', '>', '|'])('非法字符 %s', (ch) => {
    expect(validateFileName(`a${ch}b`)).toBe('invalidChar');
  });
  it('首尾空白视为合法（trim 后判断）', () => { expect(validateFileName('  a  ')).toBeNull(); });
});

describe('NIKKE_SAMPLE', () => {
  it('是合法模板且含占位符', () => {
    expect(NIKKE_SAMPLE.id).toBe('builtin-nikke');
    expect(NIKKE_SAMPLE.name.trim().length).toBeGreaterThan(0);
    expect(NIKKE_SAMPLE.content).toContain('{{title}}');
    expect(validateFileName(NIKKE_SAMPLE.name)).toBeNull();
  });
});