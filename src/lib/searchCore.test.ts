import { describe, expect, it } from 'vitest';
import {
  findMatches, matchAtSelection, nextMatchIndex, prevMatchIndex,
  replaceAllInText, replacementFor, type SearchOptions,
} from './searchCore';

const opts = (partial: Partial<SearchOptions>): SearchOptions => ({
  query: '',
  caseSensitive: false,
  regexp: false,
  wholeWord: false,
  ...partial,
});

describe('findMatches 普通文本', () => {
  it('大小写不敏感', () => {
    const r = findMatches('Foo foo FOO', opts({ query: 'foo' }));
    expect(r.matches).toEqual([
      { from: 0, to: 3 }, { from: 4, to: 7 }, { from: 8, to: 11 },
    ]);
  });

  it('大小写敏感', () => {
    const r = findMatches('Foo foo FOO', opts({ query: 'foo', caseSensitive: true }));
    expect(r.matches).toEqual([{ from: 4, to: 7 }]);
  });

  it('空查询无匹配', () => {
    expect(findMatches('abc', opts({ query: '' })).matches).toEqual([]);
  });

  it('start/end 范围限定', () => {
    const r = findMatches('abcabc', opts({ query: 'b' }), 2, 5);
    expect(r.matches).toEqual([{ from: 4, to: 5 }]);
  });

  it('中日文文本', () => {
    const r = findMatches('中文测试，中文', opts({ query: '中文' }));
    expect(r.matches).toEqual([{ from: 0, to: 2 }, { from: 5, to: 7 }]);
  });
});

describe('findMatches 全词匹配', () => {
  it('排除子串', () => {
    const r = findMatches('cat category concat cat', opts({ query: 'cat', wholeWord: true }));
    expect(r.matches).toEqual([{ from: 0, to: 3 }, { from: 20, to: 23 }]);
  });

  it('数字与下划线视为词字符', () => {
    const r = findMatches('count count2 _count count', opts({ query: 'count', wholeWord: true }));
    expect(r.matches).toEqual([{ from: 0, to: 5 }, { from: 20, to: 25 }]);
  });
});

describe('findMatches 正则', () => {
  it('基础正则与捕获组替换', () => {
    const text = 'aa11bb22';
    const o = opts({ query: '(\\d)(\\d)', regexp: true });
    const r = findMatches(text, o);
    expect(r.matches).toEqual([{ from: 2, to: 4 }, { from: 6, to: 8 }]);
    expect(replacementFor(text, r.matches[0], o, '$2$1')).toBe('11');
    expect(replacementFor(text, r.matches[1], o, '<$&>')).toBe('<22>');
  });

  it('非法正则返回 error', () => {
    const r = findMatches('abc', opts({ query: 'a(', regexp: true }));
    expect(r.error).toBeTruthy();
    expect(r.matches).toEqual([]);
  });

  it('大小写旗标作用于正则', () => {
    const r = findMatches('ABC abc', opts({ query: 'abc', regexp: true }));
    expect(r.matches.length).toBe(2);
    const r2 = findMatches('ABC abc', opts({ query: 'abc', regexp: true, caseSensitive: true }));
    expect(r2.matches).toEqual([{ from: 4, to: 7 }]);
  });

  it('零宽匹配被跳过', () => {
    const r = findMatches('ab', opts({ query: 'x*', regexp: true }));
    expect(r.matches).toEqual([]);
  });

  it('自定义旗标正则（如 \\d 简写）', () => {
    const r = findMatches('a1b2', opts({ query: '\\d', regexp: true }));
    expect(r.matches).toEqual([{ from: 1, to: 2 }, { from: 3, to: 4 }]);
  });
});

describe('导航下标', () => {
  const matches = [
    { from: 0, to: 2 }, { from: 5, to: 7 }, { from: 10, to: 12 },
  ];

  it('nextMatchIndex：head 之后的第一个匹配，回绕（head 在匹配内部视为已越过该匹配）', () => {
    expect(nextMatchIndex(matches, 0)).toBe(0);
    expect(nextMatchIndex(matches, 3)).toBe(1);
    expect(nextMatchIndex(matches, 11)).toBe(0);
    expect(nextMatchIndex(matches, 12)).toBe(0);
  });

  it('prevMatchIndex：head 之前的最后一个匹配，回绕', () => {
    expect(prevMatchIndex(matches, 5)).toBe(0);
    expect(prevMatchIndex(matches, 6)).toBe(0);
    expect(prevMatchIndex(matches, 30)).toBe(2);
    expect(prevMatchIndex(matches, 0)).toBe(2);
  });

  it('matchAtSelection 判定选区是否命中', () => {
    expect(matchAtSelection(matches, 5, 7)).toBe(1);
    expect(matchAtSelection(matches, 5, 6)).toBe(-1);
  });
});

describe('普通模式替换不展开 $', () => {
  it('$1 原样输出', () => {
    const o = opts({ query: 'a$1b' });
    const r = findMatches('x a$1b y', o);
    expect(r.matches).toEqual([{ from: 2, to: 6 }]);
    expect(replacementFor('x a$1b y', r.matches[0], o, '[$1]')).toBe('[$1]');
  });
});

describe('全量计数与扫描上限解除', () => {
  it('扫描不再在 200 万字符处截断：边界之外的匹配可命中', () => {
    const filler = 'a'.repeat(2_000_100);
    const text = filler + 'NEEDLE' + 'b';
    const r = findMatches(text, opts({ query: 'NEEDLE', caseSensitive: true }));
    expect(r.matches).toEqual([{ from: 2_000_100, to: 2_000_106 }]);
    expect(r.total).toBe(1);
  });

  it('匹配数超过上限：total 记录全量、matches 数组截断且 capped=true', () => {
    const text = 'ab '.repeat(6000);
    const r = findMatches(text, opts({ query: 'ab' }));
    expect(r.total).toBe(6000);
    expect(r.matches.length).toBe(5000);
    expect(r.matches[0]).toEqual({ from: 0, to: 2 });
    expect(r.capped).toBe(true);
  });

  it('未超限：total 与 matches 一致且 capped=false', () => {
    const r = findMatches('ab ab', opts({ query: 'ab' }));
    expect(r.total).toBe(2);
    expect(r.matches.length).toBe(2);
    expect(r.capped).toBe(false);
  });

  it('正则模式同样全量计数：超过上限不中断', () => {
    const text = 'a1 '.repeat(6000);
    const r = findMatches(text, opts({ query: '\\d', regexp: true }));
    expect(r.total).toBe(6000);
    expect(r.matches.length).toBe(5000);
    expect(r.capped).toBe(true);
  });

  it('全词模式计数不受数组截断影响', () => {
    const text = 'cat dog '.repeat(6000);
    const r = findMatches(text, opts({ query: 'cat', wholeWord: true }));
    expect(r.total).toBe(6000);
    expect(r.capped).toBe(true);
  });
});

describe('replaceAllInText 全文替换', () => {
  it('普通模式全文替换且替换串中的 $ 不展开', () => {
    expect(replaceAllInText('a b a', opts({ query: 'a' }), '$&x')).toBe('$&x b $&x');
  });

  it('大小写不敏感全文替换', () => {
    expect(replaceAllInText('Aa aA b', opts({ query: 'aa' }), 'X')).toBe('X X b');
  });

  it('全词模式只替换词边界命中', () => {
    expect(replaceAllInText('cat category cat', opts({ query: 'cat', wholeWord: true }), 'dog')).toBe('dog category dog');
  });

  it('正则模式支持 $1 引用', () => {
    expect(replaceAllInText('1a2b', opts({ query: '(\\d)([a-z])', regexp: true }), '$2$1')).toBe('a1b2');
  });

  it('正则模式零宽匹配跳过（与导航语义一致）', () => {
    expect(replaceAllInText('ab', opts({ query: 'x*', regexp: true }), 'Y')).toBe('ab');
  });

  it('非法正则原样返回', () => {
    expect(replaceAllInText('abc', opts({ query: 'a(', regexp: true }), 'x')).toBe('abc');
  });

  it('超出 matches 数组上限的命中也被替换（5000+）', () => {
    const text = 'ab '.repeat(6000);
    expect(replaceAllInText(text, opts({ query: 'ab' }), 'xy')).toBe('xy '.repeat(6000));
  });

  it('空查询原样返回', () => {
    expect(replaceAllInText('abc', opts({ query: '' }), 'x')).toBe('abc');
  });
});
