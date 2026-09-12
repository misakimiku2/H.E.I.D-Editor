import { describe, expect, it } from 'vitest';
import {
  findMatches, matchAtSelection, nextMatchIndex, prevMatchIndex,
  replacementFor, type SearchOptions,
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
