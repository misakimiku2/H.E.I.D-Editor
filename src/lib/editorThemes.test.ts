import { describe, expect, it } from 'vitest';
import { CODE_THEMES, CODE_THEME_IDS, resolveCodeTheme } from './editorThemes';

describe('editorThemes', () => {
  it('主题 id 唯一且深浅两组都有覆盖', () => {
    expect(new Set(CODE_THEME_IDS).size).toBe(CODE_THEMES.length);
    expect(CODE_THEMES.some(x => x.palette.dark)).toBe(true);
    expect(CODE_THEMES.some(x => !x.palette.dark)).toBe(true);
  });

  it('按 id 解析主题', () => {
    expect(resolveCodeTheme('dracula', true).id).toBe('dracula');
    expect(resolveCodeTheme('solarized-light', false).id).toBe('solarized-light');
  });

  it('未知 id 按界面深浅回退默认主题', () => {
    expect(resolveCodeTheme('nope', true).id).toBe('vs-dark');
    expect(resolveCodeTheme('nope', false).id).toBe('vs-light');
    expect(resolveCodeTheme(undefined, true).id).toBe('vs-dark');
  });

  it('每套主题都有完整调色板（非空颜色）', () => {
    for (const theme of CODE_THEMES) {
      expect(theme.palette.background).toBeTruthy();
      expect(theme.palette.foreground).toBeTruthy();
      expect(theme.palette.tokens.keyword).toBeTruthy();
      expect(theme.palette.tokens.comment).toBeTruthy();
    }
  });
});
