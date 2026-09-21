// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { composeTranslate, applyTranslate, readTranslate, setTranslate } from './svgWrite';

describe('composeTranslate', () => {
  it('无 transform：产出新 translate', () => {
    expect(composeTranslate(null, 5, 3)).toBe('translate(5 3)');
  });

  it('已有前导 translate：数值相加，其余部分保留', () => {
    expect(composeTranslate('translate(1 2) rotate(45)', 5, 3)).toBe('translate(6 5) rotate(45)');
  });

  it('前导 translate 单参数视为 y=0', () => {
    expect(composeTranslate('translate(2)', 1, 1)).toBe('translate(3 1)');
  });

  it('前导 translate 逗号写法', () => {
    expect(composeTranslate('translate(1, 2) scale(2)', 1, 1)).toBe('translate(2 3) scale(2)');
  });

  it('前导非 translate（如 scale）：translate 前插不合并', () => {
    expect(composeTranslate('scale(2) translate(1 2)', 5, 3)).toBe('translate(5 3) scale(2) translate(1 2)');
  });

  it('浮点尘埃收敛到两位小数，整数不带小数点', () => {
    expect(composeTranslate('translate(1.001 2)', 0.1, 0.05)).toBe('translate(1.1 2.05)');
    expect(composeTranslate(null, 2.0000001, -0)).toBe('translate(2 0)');
  });
});

describe('applyTranslate', () => {
  it('写入 transform 属性；已有属性被合成覆盖', () => {
    const doc = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg"><rect transform="translate(1 1)"/></svg>', 'image/svg+xml');
    const rect = doc.getElementsByTagName('rect')[0];
    applyTranslate(rect, 2, 2);
    expect(rect.getAttribute('transform')).toBe('translate(3 3)');
    const rect2 = doc.createElement('circle');
    applyTranslate(rect2, 4, 0);
    expect(rect2.getAttribute('transform')).toBe('translate(4 0)');
  });
});

describe('readTranslate', () => {
  it('读前导 translate 的两个数', () => {
    expect(readTranslate('translate(5 3)')).toEqual({ x: 5, y: 3 });
    expect(readTranslate('translate(1,2) rotate(45)')).toEqual({ x: 1, y: 2 });
  });

  it('单参数写法视为 y=0', () => {
    expect(readTranslate('translate(2)')).toEqual({ x: 2, y: 0 });
  });

  it('无前导 translate（没有 / 空 / translate 不在最前 / 数值不合法）都是 null', () => {
    expect(readTranslate(null)).toBeNull();
    expect(readTranslate('  ')).toBeNull();
    /* scale(2) translate(1 2) 的位移由前插的那段 translate 承担，后段不是本面板的编辑对象 */
    expect(readTranslate('scale(2) translate(1 2)')).toBeNull();
    expect(readTranslate('translate(abc 1)')).toBeNull();
  });

  it('与 composeTranslate 对得上：步进挪动后读回的就是新值', () => {
    expect(readTranslate(composeTranslate('translate(1 2) scale(3)', 4, -1))).toEqual({ x: 5, y: 1 });
  });
});

describe('setTranslate', () => {
  it('绝对赋值（不是累加），其余变换原样跟在后面', () => {
    expect(setTranslate('translate(1 2) rotate(45)', 5, 3)).toBe('translate(5 3) rotate(45)');
    expect(setTranslate(null, 5, 3)).toBe('translate(5 3)');
  });

  it('前导不是 translate 时前插，原有变换留在后面', () => {
    expect(setTranslate('scale(2)', 5, 0)).toBe('translate(5 0) scale(2)');
  });

  it('归零不留 translate(0 0) 噪声：只剩平移时整条返回 null（交调用方删属性）', () => {
    expect(setTranslate('translate(5 3)', 0, 0)).toBeNull();
    expect(setTranslate(null, 0, 0)).toBeNull();
  });

  it('归零但另有其余变换：只摘掉前导 translate', () => {
    expect(setTranslate('translate(5 3) scale(2)', 0, 0)).toBe('scale(2)');
    /* 本来就没有前导 translate，归零等于不写 */
    expect(setTranslate('scale(2)', 0, 0)).toBe('scale(2)');
  });

  it('浮点尘埃同 composeTranslate 一道收敛', () => {
    expect(setTranslate('translate(1.001 2)', 1.004, 2.0000001)).toBe('translate(1 2)');
  });

  it('读回一致：输入框里敲什么，面板下次播种就是什么', () => {
    expect(readTranslate(setTranslate('translate(1 1)', -3.5, 8))).toEqual({ x: -3.5, y: 8 });
  });
});
