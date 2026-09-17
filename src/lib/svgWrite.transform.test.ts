// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { composeTranslate, applyTranslate } from './svgWrite';

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
