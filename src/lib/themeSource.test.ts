/**
 * 主题来源守卫：界面深浅色只能由 useTheme / isDarkMode 决定。
 *
 * Tailwind 的 dark: 变体与 CSS 的 prefers-color-scheme 跟的都是**系统**深浅色，
 * 而应用内可以手切主题（桌面浅色 + 系统深色是常见组合）。一旦面板用它们上底色、
 * 行文字却按 isDarkMode 配色，就会出现「浅色模式下树底仍是深色、字看不清」
 * （2026-11 文件树实测）。静态守住这两类写法，别等下次换主题才撞见。
 *
 * 唯一允许读 prefers-color-scheme 的是 useTheme 自己（「跟随系统」模式的数据源）。
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/* 只认真正的 Tailwind 变体：dark: 后必须紧跟工具类前缀；注释里提到「dark: 变体」不误伤 */
const DARK_VARIANT = /\bdark:(?:bg|text|border|ring|divide|placeholder|from|via|to|fill|stroke|shadow|opacity|outline|decoration|backdrop|accent|caret)-/;
const SYSTEM_THEME = /prefers-color-scheme/;

const SRC = fileURLToPath(new URL('../../src', import.meta.url));
/* 允许名单：跟随系统主题的唯一合法读取点（相对 src 的路径） */
const SYSTEM_THEME_ALLOWED = new Set(['hooks/useTheme.ts']);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    const ok = /\.(tsx?|css)$/.test(p) && !p.includes('.test.');
    return ok ? [p] : [];
  });
}

describe('主题来源（深浅色只跟应用主题）', () => {
  it('源码不再出现 dark: 变体', () => {
    const files = sources(SRC);
    expect(files.length, '扫不到源码，守卫等于没跑').toBeGreaterThan(40);
    const hits: string[] = [];
    for (const file of files) {
      readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
        if (DARK_VARIANT.test(line)) hits.push(`${path.relative(SRC, file)}:${i + 1}  ${line.trim().slice(0, 90)}`);
      });
    }
    expect(hits, `这些地方还在跟系统深色：\n${hits.join('\n')}`).toEqual([]);
  });

  it('prefers-color-scheme 只在 useTheme 里读取', () => {
    const hits: string[] = [];
    for (const file of sources(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      if (SYSTEM_THEME_ALLOWED.has(rel)) continue;
      readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
        if (SYSTEM_THEME.test(line)) hits.push(`${rel}:${i + 1}  ${line.trim().slice(0, 90)}`);
      });
    }
    expect(hits, `这些地方绕开了应用主题：\n${hits.join('\n')}`).toEqual([]);
  });
});
