import { describe, expect, it } from 'vitest';
import {
  approach, classifyGumError, coverSampleRect, fitLongSide, formatZoom,
  lensRank, orderLenses, pinchZoom, zoomStops,
} from './scanCam';

describe('classifyGumError', () => {
  it('权限类才叫「权限被拒」', () => {
    expect(classifyGumError('NotAllowedError')).toBe('perm');
    expect(classifyGumError('PermissionDeniedError')).toBe('perm');
  });

  it('占用类走自动重试，不再误导成权限', () => {
    expect(classifyGumError('NotReadableError')).toBe('busy');
    expect(classifyGumError('AbortError')).toBe('busy');
    expect(classifyGumError('SecurityError')).toBe('busy');
    // 内核自造的/没带 name 的异常一律按占用兜住，至少会重试而不是叫用户去系统设置
    expect(classifyGumError('DeviceInUseException')).toBe('busy');
    expect(classifyGumError(undefined)).toBe('busy');
  });

  it('约束不被支持 → 换镜头；压根没相机 → 不重试', () => {
    expect(classifyGumError('OverconstrainedError')).toBe('constraint');
    expect(classifyGumError('ConstraintNotSatisfiedError')).toBe('constraint');
    expect(classifyGumError('NotFoundError')).toBe('nocam');
    expect(classifyGumError('NotSupportedError')).toBe('nocam');
  });
});

describe('lensRank / orderLenses', () => {
  const main = { deviceId: 'a', label: 'camera2 1, facing back' };
  const tele = { deviceId: 'b', label: 'back tele camera' };
  const front = { deviceId: 'c', label: 'front camera' };

  it('上次扫得出来的那颗排最前，长焦排到普通后置之后', () => {
    const list = orderLenses([tele, front, main], '', []);
    expect(list.map((l) => l.deviceId)).toEqual(['a', 'b']);
    expect(orderLenses([tele, main], 'a', []).map((l) => l.deviceId)).toEqual(['a', 'b']);
  });

  it('实测开不出画面的颗垫底，但仍保留（全坏时还得挨个试）', () => {
    const bad = { deviceId: 'z', label: 'camera2 0, facing back' };
    expect(orderLenses([bad, main], '', ['z']).map((l) => l.deviceId)).toEqual(['a', 'z']);
    expect(orderLenses([bad], '', ['z']).map((l) => l.deviceId)).toEqual(['z']);
  });

  it('label 分不出朝向时用全量，交给开出来实测 facingMode 过滤', () => {
    const blind = [{ deviceId: 'd', label: '' }, { deviceId: 'e', label: '' }];
    expect(orderLenses(blind, '', []).map((l) => l.deviceId)).toEqual(['d', 'e']);
  });

  it('华为/三星的通用 label（camera2 N, facing back）互相之间保持枚举原序', () => {
    const cams = [
      { deviceId: '0', label: 'camera2 0, facing back' },
      { deviceId: '1', label: 'camera2 1, facing back' },
      { deviceId: '2', label: 'camera2 2, facing back' },
    ];
    expect(orderLenses(cams, '', []).map((l) => l.deviceId)).toEqual(['0', '1', '2']);
  });

  it('前置不参与排序', () => {
    expect(lensRank(front, '', [])).toBe(1);
    expect(orderLenses([front, main], '', []).map((l) => l.deviceId)).toEqual(['a']);
  });
});

describe('pinchZoom', () => {
  it('双指没动就停在起始倍率', () => {
    expect(pinchZoom(1, 3, 1, 10)).toBe(3);
  });

  it('一个完整行程（张开 3 倍）走完全部焦段，且不同起点一致', () => {
    expect(pinchZoom(3, 1, 1, 10)).toBeCloseTo(10, 4);
    expect(pinchZoom(3, 2, 1, 10)).toBeCloseTo(10, 4);   // 已钳到 max
    expect(pinchZoom(1 / 3, 10, 1, 10)).toBeCloseTo(1, 4);
  });

  it('对数映射：同样张一倍手指，各处倍率变化倍数相同', () => {
    const lowFrom = pinchZoom(1.2, 1, 1, 10);
    const highFrom = pinchZoom(1.2, 3, 1, 10);
    expect(highFrom / 3).toBeCloseTo(lowFrom, 6);
    expect(lowFrom).toBeGreaterThan(1.2);  // 比线性的 1×1.2=1.2 更「够得着」
  });

  it('钳在 [min,max] 内，非法输入不炸', () => {
    expect(pinchZoom(50, 1, 1, 10)).toBe(10);
    expect(pinchZoom(0.01, 5, 1, 10)).toBe(1);
    expect(pinchZoom(2, 5, 6, 6)).toBe(6);        // 退化区间：钳到 min
    expect(pinchZoom(NaN, 5, 1, 10)).toBe(5);
  });
});

describe('approach', () => {
  it('每帧向目标靠拢，最后一步精确落在目标上', () => {
    let v = 1;
    for (let i = 0; i < 40; i += 1) v = approach(v, 4, 16);
    expect(v).toBe(4);
    expect(approach(1, 1.00005, 16)).toBe(1.00005);
  });

  it('dt=0 不动，负 dt / τ 非法也不动且不产生 NaN', () => {
    expect(approach(2, 8, 0)).toBe(2);
    expect(approach(2, 8, -500)).toBe(2);
    expect(Number.isFinite(approach(2, 8, 16, 0))).toBe(true);
  });
});

describe('zoomStops', () => {
  it('硬件 1–10× 给四片，两端钉住、中间偏小倍率', () => {
    expect(zoomStops(1, 10)).toEqual([1, 2, 4, 10]);
  });

  it('数码 1–4× 给三片', () => {
    expect(zoomStops(1, 4).length).toBeLessThanOrEqual(4);
    expect(zoomStops(1, 4)).toEqual([1, 2, 4]);
    expect(zoomStops(1, 3)).toEqual([1, 2, 3]);
  });

  it('包含端点、单调不减、去重', () => {
    for (const [min, max] of [[1, 1], [1, 2], [0.6, 1], [2, 10], [1, 100], [1, 6]] as const) {
      const s = zoomStops(min, max);
      expect(s[0]).toBeGreaterThanOrEqual(Math.round(min * 10) / 10);
      expect(s[s.length - 1]).toBeLessThanOrEqual(Math.round(max * 10) / 10);
      expect(s.every((v, i) => i === 0 || v > s[i - 1])).toBe(true);
      expect(s.length).toBeLessThanOrEqual(4);
    }
    expect(zoomStops(1, 1)).toEqual([1]);
    expect(zoomStops(0.6, 1)).toEqual([0.6, 1]);
    expect(zoomStops(2, 10)).toEqual([2, 4, 8, 10]);
    expect(zoomStops(1, 6)).toEqual([1, 2, 4, 6]);
  });
});

describe('coverSampleRect', () => {
  it('竖屏手机摆 1280×720 横帧：吃满高度、左右被裁', () => {
    const r = coverSampleRect(1280, 720, 411, 914);
    expect(r.sh).toBeCloseTo(720, 3);
    expect(r.sy).toBeCloseTo(0, 3);
    expect(r.sw).toBeCloseTo(411 / (914 / 720), 2);
    expect(r.sx).toBeCloseTo((1280 - r.sw) / 2, 2);
  });

  it('显示框与画面同比例 → 正好整帧', () => {
    expect(coverSampleRect(1280, 720, 640, 360)).toEqual({ sx: 0, sy: 0, sw: 1280, sh: 720 });
  });

  it('数码放大 2× 把可见区域等比缩小一半并保持居中', () => {
    const one = coverSampleRect(1280, 720, 411, 914);
    const two = coverSampleRect(1280, 720, 411, 914, 2);
    expect(two.sw).toBeCloseTo(one.sw / 2, 3);
    expect(two.sh).toBeCloseTo(one.sh / 2, 3);
    expect(two.sx + two.sw / 2).toBeCloseTo(640, 3);
    expect(two.sy + two.sh / 2).toBeCloseTo(360, 3);
  });

  it('不越界、不放大超出原始帧、异常尺寸不产生 NaN', () => {
    const r = coverSampleRect(640, 480, 1000, 400, 1.5);
    expect(r.sx).toBeGreaterThanOrEqual(0);
    expect(r.sy).toBeGreaterThanOrEqual(0);
    expect(r.sx + r.sw).toBeLessThanOrEqual(640 + 1e-6);
    expect(r.sy + r.sh).toBeLessThanOrEqual(480 + 1e-6);
    const z = coverSampleRect(0, 0, 100, 100, 2);
    expect(Number.isNaN(z.sw)).toBe(false);
  });
});

describe('fitLongSide / formatZoom', () => {
  it('缩到最长边上限且保持比例，小帧不放大', () => {
    expect(fitLongSide(1280, 720, 640)).toEqual({ w: 640, h: 360 });
    expect(fitLongSide(320, 240, 640)).toEqual({ w: 320, h: 240 });
    expect(fitLongSide(0, 0, 640)).toEqual({ w: 1, h: 1 });
  });

  it('倍率文案去掉多余的 .0', () => {
    expect(formatZoom(1)).toBe('1×');
    expect(formatZoom(2.43)).toBe('2.4×');
    expect(formatZoom(10)).toBe('10×');
    expect(formatZoom(0.6)).toBe('0.6×');
  });
});
