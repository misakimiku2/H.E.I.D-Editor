import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, FONT_OPTIONS, loadSettings, normalizeSettings, saveSettings } from './settings';
import { NIKKE_SAMPLE, TEMPLATE_CONTENT_MAX, TEMPLATE_COUNT_MAX } from './docTemplates';

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => { map.delete(k); },
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
  };
}

describe('settings', () => {
  it('空存储返回默认设置', () => {
    expect(loadSettings(memoryStorage())).toEqual(DEFAULT_SETTINGS);
  });

  it('保存后读取往返一致', () => {
    const s = memoryStorage();
    const next = normalizeSettings({ fontSize: 18, tabSize: 4, autosaveEnabled: true, autosaveIntervalSec: 60 });
    saveSettings(next, s);
    expect(loadSettings(s)).toEqual(next);
  });

  it('损坏 JSON 回退默认', () => {
    const s = memoryStorage();
    s.setItem('heid-settings', '{bad');
    expect(loadSettings(s)).toEqual(DEFAULT_SETTINGS);
  });

  it('越界数值被钳制', () => {
    const s = memoryStorage();
    s.setItem('heid-settings', JSON.stringify({ fontSize: 999, tabSize: -3, autosaveIntervalSec: 1, lineHeight: 99 }));
    const loaded = loadSettings(s);
    expect(loaded.fontSize).toBe(28);
    expect(loaded.tabSize).toBe(1);
    expect(loaded.autosaveIntervalSec).toBe(5);
    expect(loaded.lineHeight).toBe(2.4);
  });

  it('非法枚举与未知字体回退默认', () => {
    const s = memoryStorage();
    s.setItem('heid-settings', JSON.stringify({ lineWrapMode: 'bogus', fontFamily: 'not-a-font-stack' }));
    const loaded = loadSettings(s);
    expect(loaded.lineWrapMode).toBe('markdown');
    expect(loaded.fontFamily).toBe(FONT_OPTIONS[0].stack);
  });

  it('布尔字段非法输入回退默认', () => {
    const s = memoryStorage();
    s.setItem('heid-settings', JSON.stringify({ minimap: 'yes', insertSpaces: 1 }));
    const loaded = loadSettings(s);
    expect(loaded.minimap).toBe(DEFAULT_SETTINGS.minimap);
    expect(loaded.insertSpaces).toBe(DEFAULT_SETTINGS.insertSpaces);
  });

  it('界面语言默认跟随系统，非法值回退', () => {
    expect(DEFAULT_SETTINGS.language).toBe('system');
    const s = memoryStorage();
    s.setItem('heid-settings', JSON.stringify({ language: 'klingon' }));
    expect(loadSettings(s).language).toBe('system');
  });

  it('界面语言合法值往返', () => {
    const next = normalizeSettings({ language: 'en' });
    expect(next.language).toBe('en');
    const s = memoryStorage();
    saveSettings(next, s);
    expect(loadSettings(s).language).toBe('en');
  });

  it('代码主题：合法 id 保留、非法 id 回退、默认深浅各一份', () => {
    expect(DEFAULT_SETTINGS.codeThemeDark).toBe('vs-dark');
    expect(DEFAULT_SETTINGS.codeThemeLight).toBe('vs-light');
    expect(normalizeSettings({ codeThemeDark: 'dracula', codeThemeLight: 'solarized-light' }))
      .toMatchObject({ codeThemeDark: 'dracula', codeThemeLight: 'solarized-light' });
    expect(normalizeSettings({ codeThemeDark: 'removed-theme', codeThemeLight: 42 }))
      .toMatchObject({ codeThemeDark: 'vs-dark', codeThemeLight: 'vs-light' });
  });
});

describe('settings.templates', () => {
  const tpl = (id: string, name = '模板', content = '# x') => ({ id, name, content });

  it('默认带内置示例', () => {
    expect(DEFAULT_SETTINGS.templates).toEqual([NIKKE_SAMPLE]);
  });
  it('空存储读取出内置示例', () => {
    expect(loadSettings(memoryStorage()).templates).toEqual([NIKKE_SAMPLE]);
  });
  it('缺失 templates 字段（老版本升级）注入示例', () => {
    expect(normalizeSettings({ fontSize: 16 }).templates).toEqual([NIKKE_SAMPLE]);
  });
  it('空数组原样保留，不复活示例', () => {
    expect(normalizeSettings({ templates: [] }).templates).toEqual([]);
  });
  it('删光后往返不复活', () => {
    const s = memoryStorage();
    saveSettings(normalizeSettings({ templates: [] }), s);
    expect(loadSettings(s).templates).toEqual([]);
  });
  it('合法模板保留', () => {
    expect(normalizeSettings({ templates: [tpl('a'), tpl('b')] }).templates).toEqual([tpl('a'), tpl('b')]);
  });
  it('坏项丢弃：非对象/缺 id/name 空/content 非字符串', () => {
    const input = [null, 42, tpl('ok'), { id: 'x', name: '  ', content: 'c' }, { id: 'y', name: 'n', content: 5 }, { name: 'n', content: 'c' }];
    expect(normalizeSettings({ templates: input }).templates).toEqual([tpl('ok')]);
  });
  it('超长 content 与超长 name 丢弃', () => {
    const longContent = tpl('a', 'n', 'x'.repeat(TEMPLATE_CONTENT_MAX + 1));
    const longName = tpl('b', 'n'.repeat(61), 'c');
    expect(normalizeSettings({ templates: [longContent, longName, tpl('ok')] }).templates).toEqual([tpl('ok')]);
  });
  it('超过上限截断到 50 条', () => {
    const many = Array.from({ length: TEMPLATE_COUNT_MAX + 5 }, (_, i) => tpl(`id${i}`));
    expect(normalizeSettings({ templates: many }).templates).toHaveLength(TEMPLATE_COUNT_MAX);
  });
  it('templates 非数组回退示例', () => {
    expect(normalizeSettings({ templates: 'bogus' }).templates).toEqual([NIKKE_SAMPLE]);
  });
});
