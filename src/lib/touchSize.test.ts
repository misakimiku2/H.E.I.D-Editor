/**
 * 44dp 档清零守卫（ROADMAP 52②）。
 *
 * v1.4 的弹窗层按 44dp 做，v1.5 统一到与主界面同一档的 48dp。这类尺寸是散落在几十个
 * className 字面量里的，没有共享常量，所以靠一条静态扫描守住「44 档不再回来」——
 * 比每次改版全仓人肉重扫可靠。
 *
 * 只守 44 档这一档：低于 48 的其他尺寸（色相滑条 28dp、侧栏把手 20dp 宽）是另记的欠账，
 * 混在这里会让守卫一加上就红，反而没人管。
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const TOUCH_SIZES_44 = [
  /min-h-\[44px\]/,
  /min-w-\[44px\]/,
  /\bpointer-coarse:[a-z-]*h-11\b/,
  /\bpointer-coarse:[a-z-]*w-11\b/,
  /TOUCH \?\s*'w-11/,
];

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return p.endsWith('.tsx') && !p.includes('.test.') ? [p] : [];
  });
}

describe('触屏触点尺寸档（52②）', () => {
  it('源码里不再残留 44dp 档的触屏尺寸字面量', () => {
    const files = sources(SRC);
    expect(files.length, '扫不到源码，守卫等于没跑').toBeGreaterThan(40);
    const hits: string[] = [];
    for (const file of files) {
      readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
        if (TOUCH_SIZES_44.some(re => re.test(line))) hits.push(`${path.relative(SRC, file)}:${i + 1}  ${line.trim().slice(0, 90)}`);
      });
    }
    expect(hits, `这些触点还停在 44dp：\n${hits.join('\n')}`).toEqual([]);
  });
});
