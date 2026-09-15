import { describe, it, expect } from 'vitest';
import {
  findColorLiterals, parseColorLiteral, serializeColorLiteral,
} from './colorLiteral';

const parseOf = (s: string) => parseColorLiteral(s)?.rgba;
const styleOf = (s: string) => parseColorLiteral(s)?.style;

describe('parseColorLiteral：hex', () => {
  it('3 位短写展开', () => {
    expect(parseOf('#abc')).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc, a: 1 });
  });
  it('4 位含 alpha', () => {
    expect(parseOf('#abcd')!.a).toBeCloseTo(0xdd / 255, 5);
  });
  it('6 位 / 8 位', () => {
    expect(parseOf('#4ec9b0')).toEqual({ r: 0x4e, g: 0xc9, b: 0xb0, a: 1 });
    expect(parseOf('#4ec9b080')!.a).toBeCloseTo(0x80 / 255, 5);
  });
  it('大小写均可解析', () => {
    expect(parseOf('#AABBCC')).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc, a: 1 });
  });
  it('style 记录位数与大写', () => {
    expect(styleOf('#abc')).toMatchObject({ kind: 'hex', digits: 3, upper: false });
    expect(styleOf('#AABBCC')).toMatchObject({ kind: 'hex', digits: 6, upper: true });
    expect(styleOf('#aabbccdd')).toMatchObject({ kind: 'hex', digits: 8 });
  });
  it('非法长度返回 null', () => {
    expect(parseColorLiteral('#ab')).toBeNull();
    expect(parseColorLiteral('#abcde')).toBeNull();
    expect(parseColorLiteral('#abcdeg')).toBeNull();
  });
});

describe('parseColorLiteral：rgb / rgba', () => {
  it('逗号写法', () => {
    expect(parseOf('rgb(12, 34, 56)')).toEqual({ r: 12, g: 34, b: 56, a: 1 });
    expect(parseOf('rgba(1,2,3,0.5)')).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
  });
  it('现代空格写法（含 / alpha）', () => {
    expect(parseOf('rgb(12 34 56)')).toEqual({ r: 12, g: 34, b: 56, a: 1 });
    expect(parseOf('rgb(12 34 56 / 50%)')!.a).toBeCloseTo(0.5, 5);
  });
  it('百分比通道', () => {
    expect(parseOf('rgb(100%, 0%, 0%)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(styleOf('rgb(100%, 0%, 0%)')).toMatchObject({ percent: true });
  });
  it('越界钳制', () => {
    expect(parseOf('rgb(300, -5, 0)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });
  it('style 记录家族 / alpha / 大小写 / 写法', () => {
    expect(styleOf('rgba(1,2,3,0.5)')).toMatchObject({ kind: 'rgb', hasAlpha: true, spaceSyntax: false });
    expect(styleOf('rgb(12 34 56)')).toMatchObject({ kind: 'rgb', hasAlpha: false, spaceSyntax: true });
    expect(styleOf('RGB(1,2,3)')).toMatchObject({ upper: true });
  });
  it('非法返回 null', () => {
    expect(parseColorLiteral('rgb(1,2)')).toBeNull();
    expect(parseColorLiteral('rgb(1,2,3')).toBeNull();
    expect(parseColorLiteral('rgb(a,b,c)')).toBeNull();
  });
});

describe('parseColorLiteral：hsl / hsla', () => {
  it('hsl→rgb 换算', () => {
    const c = parseOf('hsl(120, 50%, 50%)')!;
    expect(c.r).toBe(64); expect(c.g).toBe(191); expect(c.b).toBe(64); expect(c.a).toBe(1);
  });
  it('带 alpha', () => {
    expect(parseOf('hsla(0, 100%, 50%, 0.3)')).toEqual({ r: 255, g: 0, b: 0, a: 0.3 });
    expect(parseOf('hsl(240 100% 50% / 0.5)')!.a).toBeCloseTo(0.5, 5);
  });
  it('色相可为负或超 360', () => {
    expect(parseOf('hsl(-120, 100%, 50%)')).toEqual({ r: 0, g: 0, b: 255, a: 1 });
    expect(parseOf('hsl(480, 100%, 50%)')).toEqual({ r: 0, g: 255, b: 0, a: 1 });
    expect(parseOf('hsl(720, 100%, 50%)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });
});

describe('findColorLiterals', () => {
  it('多格式一次找出，偏移正确', () => {
    const text = 'a: #fff;\nb: rgb(1, 2, 3);\nc: hsl(120 50% 50%);';
    const found = findColorLiterals(text);
    expect(found).toHaveLength(3);
    expect(text.slice(found[0].from, found[0].to)).toBe('#fff');
    expect(text.slice(found[1].from, found[1].to)).toBe('rgb(1, 2, 3)');
    expect(text.slice(found[2].from, found[2].to)).toBe('hsl(120 50% 50%)');
  });
  it('#define 不误报（后跟字母）', () => {
    expect(findColorLiterals('#define X 1')).toHaveLength(0);
  });
  it('5 位 hex 不误报', () => {
    expect(findColorLiterals('color: #abcde;')).toHaveLength(0);
  });
  it('前缀标识符不误报', () => {
    expect(findColorLiterals('xrgb(1, 2, 3)')).toHaveLength(0);
  });
  it('独立 #dec 识别', () => {
    const found = findColorLiterals('id="#dec"');
    expect(found).toHaveLength(1);
    expect(found[0].rgba).toEqual({ r: 0xdd, g: 0xee, b: 0xcc, a: 1 });
  });
  it('无效函数跳过，不影响后续匹配', () => {
    expect(findColorLiterals('rgb(1,2) #f00')).toHaveLength(1);
  });
});

describe('serializeColorLiteral：hex', () => {
  it('可短写则保持 3 位', () => {
    const out = serializeColorLiteral({ r: 255, g: 0, b: 0, a: 1 }, { kind: 'hex', digits: 3, upper: false, hasAlpha: false });
    expect(out).toBe('#f00');
  });
  it('不可短写扩为 6 位', () => {
    const out = serializeColorLiteral({ r: 1, g: 2, b: 3, a: 1 }, { kind: 'hex', digits: 3, upper: false, hasAlpha: false });
    expect(out).toBe('#010203');
  });
  it('大写保持大写', () => {
    const out = serializeColorLiteral({ r: 1, g: 2, b: 3, a: 1 }, { kind: 'hex', digits: 6, upper: true, hasAlpha: false });
    expect(out).toBe('#010203');
    expect(out.startsWith('#')).toBe(true);
    expect(out.slice(1)).toBe('010203'.toUpperCase());
  });
  it('原 6 位加 alpha 升级为 8 位', () => {
    const out = serializeColorLiteral({ r: 0xaa, g: 0xbb, b: 0xcc, a: 0.5 }, { kind: 'hex', digits: 6, upper: false, hasAlpha: false });
    expect(out).toBe('#aabbcc80');
  });
  it('原 8 位 alpha=1 保留 alpha 槽', () => {
    const out = serializeColorLiteral({ r: 0xaa, g: 0xbb, b: 0xcc, a: 1 }, { kind: 'hex', digits: 8, upper: false, hasAlpha: true });
    expect(out).toBe('#aabbccff');
  });
  it('原 3 位调半透明：alpha 不能压成半字节时扩 8 位', () => {
    const out = serializeColorLiteral({ r: 255, g: 0, b: 0, a: 0.5 }, { kind: 'hex', digits: 3, upper: false, hasAlpha: false });
    expect(out).toBe('#ff000080');
  });
  it('原 3 位调半透明：rgb 与 alpha 均可短写时升 4 位', () => {
    const out = serializeColorLiteral({ r: 255, g: 0, b: 0, a: 0 }, { kind: 'hex', digits: 3, upper: false, hasAlpha: false });
    expect(out).toBe('#f000');
  });
});

describe('serializeColorLiteral：rgb / hsl', () => {
  it('原 rgba() 始终保留 alpha 槽', () => {
    const style = { kind: 'rgb' as const, digits: 6, upper: false, hasAlpha: true, spaceSyntax: false, percent: false };
    expect(serializeColorLiteral({ r: 255, g: 0, b: 0, a: 1 }, style)).toBe('rgba(255, 0, 0, 1)');
    expect(serializeColorLiteral({ r: 255, g: 0, b: 0, a: 0.5 }, style)).toBe('rgba(255, 0, 0, 0.5)');
  });
  it('原 rgb() alpha 调到 <1 升级 rgba()', () => {
    const style = { kind: 'rgb' as const, digits: 6, upper: false, hasAlpha: false, spaceSyntax: false, percent: false };
    expect(serializeColorLiteral({ r: 255, g: 0, b: 0, a: 0.5 }, style)).toBe('rgba(255, 0, 0, 0.5)');
    expect(serializeColorLiteral({ r: 255, g: 0, b: 0, a: 1 }, style)).toBe('rgb(255, 0, 0)');
  });
  it('百分比通道按百分比回写', () => {
    const style = { kind: 'rgb' as const, digits: 6, upper: false, hasAlpha: false, spaceSyntax: false, percent: true };
    expect(serializeColorLiteral({ r: 255, g: 0, b: 0, a: 1 }, style)).toBe('rgb(100%, 0%, 0%)');
  });
  it('空格写法回写空格写法', () => {
    const style = { kind: 'rgb' as const, digits: 6, upper: false, hasAlpha: false, spaceSyntax: true, percent: false };
    expect(serializeColorLiteral({ r: 0, g: 255, b: 0, a: 1 }, style)).toBe('rgb(0 255 0)');
    expect(serializeColorLiteral({ r: 0, g: 255, b: 0, a: 0.5 }, style)).toBe('rgb(0 255 0 / 0.5)');
  });
  it('hsl 保格式往返', () => {
    const style = { kind: 'hsl' as const, digits: 6, upper: false, hasAlpha: false, spaceSyntax: false, percent: false };
    expect(serializeColorLiteral({ r: 64, g: 191, b: 64, a: 1 }, style)).toBe('hsl(120, 50%, 50%)');
  });
  it('hsla 保留 alpha', () => {
    const style = { kind: 'hsl' as const, digits: 6, upper: false, hasAlpha: true, spaceSyntax: false, percent: false };
    expect(serializeColorLiteral({ r: 255, g: 0, b: 0, a: 0.3 }, style)).toBe('hsla(0, 100%, 50%, 0.3)');
  });
  it('函数名大写保持大写', () => {
    const style = { kind: 'rgb' as const, digits: 6, upper: true, hasAlpha: false, spaceSyntax: false, percent: false };
    expect(serializeColorLiteral({ r: 255, g: 0, b: 0, a: 1 }, style)).toBe('RGB(255, 0, 0)');
  });
});
