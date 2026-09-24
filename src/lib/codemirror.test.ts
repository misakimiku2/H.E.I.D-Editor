/**
 * 语言着色器注册表测试（ROADMAP 51）。
 *
 * 为什么不只测「返回值非 null」：`loadLanguageExtension` 的 catch 分支只 console.warn 后返回
 * null，界面上的表现就是「按纯文本渲染」，与「这个语言本来就没着色器」逐字相同——看截图收不了口。
 * 所以每种语言都要走到「语法树真的产出了带 tag 的 token」这一层；同时把
 * `Unknown highlighting tag`（token 名拼错时 CodeMirror 唯一的信号，且只 warn）也当失败。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EditorState } from '@codemirror/state';
import { syntaxTree, ensureSyntaxTree } from '@codemirror/language';
import { highlightTree } from '@lezer/highlight';
import { loadLanguageExtension, SUPPORTED_LANGUAGES, detectLanguageFromPath } from './codemirror';
import { resolveCodeTheme } from './editorThemes';

/** 用应用真实的代码配色主题取 class：拿到 class 就等于用户在屏幕上会看到颜色 */
const style = resolveCodeTheme(null, true).highlight;

type Span = { cls: string; from: number; to: number };

/** 着色一段样例，返回带 class 的 span（class 为空即该 token 没着色） */
async function spansOf(lang: string, doc: string): Promise<{ spans: Span[]; ext: unknown }> {
  const ext = await loadLanguageExtension(lang);
  expect(ext, `${lang}: 扩展为 null（chunk 缺失 / 导出名不符 / 语法构造抛错）`).toBeTruthy();
  const state = EditorState.create({ doc, extensions: [ext!] });
  ensureSyntaxTree(state, doc.length, 200_000);
  const spans: Span[] = [];
  highlightTree(syntaxTree(state), style, (from, to, cls) => {
    if (cls) spans.push({ cls, from, to });
  });
  return { spans, ext };
}

function clsAt(spans: Span[], doc: string, needle: string): string | undefined {
  const i = doc.indexOf(needle);
  if (i < 0) throw new Error(`样例里没有 ${JSON.stringify(needle)}`);
  return spans.find(s => s.from <= i && i < s.to)?.cls;
}

/** 断言这些（每类一个代表的）token 都拿到 class 且互不同色——同色等于没区分开，与纯文本无异 */
function expectTinted(spans: Span[], doc: string, tokens: string[]) {
  const classes = tokens.map(tk => {
    const cls = clsAt(spans, doc, tk);
    expect(cls, `token ${JSON.stringify(tk)} 未着色`).toBeTruthy();
    return cls!;
  });
  expect(
    new Set(classes).size,
    `这些 token 颜色无区分: ${tokens.map((tk, i) => `${tk}→${classes[i]}`).join(' / ')}`,
  ).toBe(classes.length);
}

/**
 * 每种语言的样例。`tokens` 每个类别取一个代表（关键字 / 字符串 / 数字 / 类型…各一），
 * 断言它们都着色且互不同色——并列两个关键字必然同色，那是语法正确而不是着色缺失。
 */
const SAMPLES: Record<string, { doc: string; tokens: string[] }> = {
  go: {
    doc: 'package main\n\nimport "fmt"\n\nfunc main() {\n  x := 1\n  fmt.Println("hi", x)\n}\n',
    tokens: ['func', '"hi"'],
  },
  bash: {
    doc: '#!/bin/sh\n# 注释\nfor f in *.txt; do\n  echo "$f"\ndone\n',
    tokens: ['# 注释', 'for', '"$f"'],
  },
  dockerfile: {
    /* legacy-modes 的 dockerfile 只给注释与指令两类 token，参数一律原文——
       比纯文本多了「一眼看清哪些行是指令」，但别指望它给 `node:20` 上色 */
    doc: '# 注释\nFROM node:20 AS build\nCOPY a b\nENV PORT=8080\n',
    tokens: ['# 注释', 'FROM'],
  },
  toml: {
    doc: 'title = "x"\n\n[server]\nport = 8080\nenabled = true\n',
    tokens: ['"x"', '8080', 'true'],
  },
  ruby: {
    doc: '# 注释\ndef hi\n  puts "x"\nend\n',
    tokens: ['# 注释', 'def', '"x"'],
  },
  swift: {
    doc: 'import Foundation\n\nfunc hi() -> String {\n  let x = "y"\n  return x\n}\n',
    tokens: ['func', 'String', '"y"'],
  },
  csharp: {
    doc: 'using System;\n\nnamespace N {\n  class C {\n    int X = 1;\n  }\n}\n',
    tokens: ['namespace', '1'],
  },
  kotlin: {
    doc: 'fun main() {\n  val x = "y"\n  println(x)\n}\n',
    tokens: ['fun', '"y"'],
  },
  scala: {
    doc: 'object A {\n  def hi(): Unit = {\n    val x = "y"\n  }\n}\n',
    tokens: ['def', '"y"'],
  },
  scss: {
    doc: '$bg: #fff\n\n.box {\n  color: $bg;\n  &:hover {\n    width: 10px;\n  }\n}\n',
    tokens: ['$bg', 'color', '10px'],
  },
  less: {
    doc: '@bg: #fff;\n\n.box {\n  color: @bg;\n}\n',
    tokens: ['@bg', 'color'],
  },
  ini: {
    /* 本主题的 propertyName 与 string 同色，所以取注释/键/数字三个必有区分的类别 */
    doc: '; 注释\n[section]\nkey = value\nport = 8080\nflag = true\npath = "c:/x"\n',
    tokens: ['; 注释', 'key', '8080'],
  },
  makefile: {
    doc: '# 编译选项\nCC = gcc\n-include defs.mk\n\n.PHONY: all\nall: main\n\t$(CC) -o main "a b.c"\n\ninstall: all\n\tcp main /usr/bin\n',
    tokens: ['# 编译选项', 'CC', 'include', '$(CC)', '.PHONY'],
  },
};

let warns: unknown[] = [];
const realWarn = console.warn;
beforeAll(() => {
  console.warn = (...args: unknown[]) => { warns.push(args.join(' ')); };
});
afterAll(() => {
  console.warn = realWarn;
});

describe('语言着色器注册表（ROADMAP 51）', () => {
  it('每种可识别的语言类型都能拿到非 null 扩展', async () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      const ext = await loadLanguageExtension(lang);
      expect(ext, `${lang} 没有着色器`).toBeTruthy();
    }
  });

  it('新增语言逐个真着色（关键字/字符串等类别可辨）', async () => {
    for (const [lang, { doc, tokens }] of Object.entries(SAMPLES)) {
      const { spans } = await spansOf(lang, doc);
      expect(spans.length, `${lang}: 语法树没有产出任何着色 token`).toBeGreaterThan(2);
      expectTinted(spans, doc, tokens);
    }
  });

  it('stream 语法没有拼错的 tag 名（未知 tag 只 warn 不着色）', async () => {
    warns = [];
    for (const [lang, { doc }] of Object.entries(SAMPLES)) await spansOf(lang, doc);
    const bad = warns.filter(w => String(w).includes('Unknown highlighting tag'));
    expect(bad, `拼错的 token 名: ${bad.join(' | ')}`).toHaveLength(0);
  });

  it('配方行结束后回到正常态（配方判定逐行重算）', async () => {
    const doc = SAMPLES.makefile.doc;
    const { spans } = await spansOf('makefile', doc);
    const all = clsAt(spans, doc, '.PHONY');
    const install = clsAt(spans, doc, 'install');
    expect(all, '目标名 .PHONY 未着色').toBeTruthy();
    expect(install, '配方行之后的 install 没被认成目标（配方态漏到了下一行）').toBe(all);
    expect(clsAt(spans, doc, '"a b.c"'), '配方行里的引号串未着色').toBeTruthy();
  });

  it('扩展实例被缓存，重复加载同一语言不再取 chunk', async () => {
    const a = await loadLanguageExtension('ini');
    const b = await loadLanguageExtension('ini');
    expect(b).toBe(a);
  });

  it('语言数与 README 写的数字一致（README 只允许写实测键数）', async () => {
    const fs = await import('fs');
    const readme = fs.readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
    const claimed = [...readme.matchAll(/(\d+) 种语言/g)].map(m => Number(m[1]));
    expect(claimed.length, 'README 里找不到「N 种语言」').toBeGreaterThan(0);
    for (const n of claimed) {
      expect(n, `README 写了 ${n} 种，实测 ${SUPPORTED_LANGUAGES.length} 种`).toBe(SUPPORTED_LANGUAGES.length);
    }
  });

  it('新语言的后缀仍能识别成对应语言键', () => {
    const map: Record<string, string> = {
      'a.go': 'go', 'a.sh': 'bash', 'Dockerfile': 'dockerfile', 'a.toml': 'toml',
      'a.rb': 'ruby', 'a.swift': 'swift', 'a.cs': 'csharp', 'a.kt': 'kotlin',
      'a.scala': 'scala', 'a.scss': 'scss', 'a.less': 'less', 'a.ini': 'ini',
      'Makefile': 'makefile',
    };
    for (const [path, lang] of Object.entries(map)) {
      expect(detectLanguageFromPath(path), path).toBe(lang);
      expect(SUPPORTED_LANGUAGES).toContain(lang);
    }
  });
});
